/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

use crate::support::{
    context as fixture,
    native::{FixtureService, NativeFixture},
};
use futures_util::future::BoxFuture;
use maka_agent_api::{
    Configuration, ModelSelection,
    contract::{BackendPreference, SendResult, WorkReadiness},
};
use maka_agent_facts::{
    artifact::ToolReturn,
    cells::{CellEvent, CellOwner, CellStatus},
    configuration::{
        CatalogMutationResult, ConnectionCatalogEntryUpdate, ConnectionVersionBasis, ModelOverride,
        Patch, UpdateCatalogConnectionInput,
    },
    context::{
        CompactedContext, ModelClosureProtocol, ModelPurpose, RequestContextEvidence, SummaryResult,
    },
    durable::{
        AttemptRecovery, ContentRef, Fact, ModelAttemptId, RecordedFact, RequestSpec, RunId,
        Terminal, ToolDecision,
    },
    execution::{CodeLanguage, ToolMode},
    model::ModelFinishReason,
    tool_output::{ReturnedToolResult, ToolOutput},
};
use maka_agent_state::fold::RunView;
use maka_host_runtime::application::{Context, Handler, HandlerResult, HandlerValue, NativeOwner};
use maka_plugin_core::contract::{Contract, Interface, Method, MethodMode, Transport};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::AsyncWriteExt,
    net::{TcpListener, TcpStream},
};

struct Echo(Arc<AtomicUsize>);
impl Handler for Echo {
    fn call(
        &self,
        method: String,
        input: Value,
        context: Context,
    ) -> BoxFuture<'static, HandlerResult> {
        assert_eq!(method, "echo");
        assert!(
            context.operation().is_none(),
            "echo is an actual parallel Query"
        );
        assert!(context.scope().identity.agent().is_some() && context.work_custody().is_some());
        self.0.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move { Ok(HandlerValue::Json(input)) })
    }
}
impl NativeOwner for Echo {
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}
fn service(effects: Arc<AtomicUsize>) -> FixtureService {
    let schema = json!({"type":"object","properties":{"n":{"type":"integer"}},"required":["n"],"additionalProperties":false});
    FixtureService::new(
        Contract {
            name: "fixture.DynamicEcho".into(),
            version: 1,
            transport: Transport::Remote,
            interface: Interface::Service {
                methods: BTreeMap::from([(
                    "echo".into(),
                    Method {
                        mode: MethodMode::Query,
                        input: schema.clone().into(),
                        output: schema.into(),
                        resources: BTreeMap::new(),
                        progress: None,
                    },
                )]),
            },
        },
        Arc::new(Echo(effects)),
    )
}
fn configuration(workspace: &Path) -> Configuration {
    serde_json::from_value(json!({"locale":"en","toolDiscovery":true,
        "workspaceRoots":[{"label":"Workspace","path":workspace}],
        "permissions":{"access":"workspace_write","requestPermissions":false},
        "tools":[{"name":"echo","description":"Echo an integer","method":"echo","nestable":true,
            "target":{"kind":"import","name":"fixture"},"result":"json","confirmation":"preapproved"}],
    })).unwrap()
}
fn backend(model: &ModelSelection) -> BackendPreference {
    BackendPreference::Model {
        connection_id: model.connection_id.clone(),
        model_id: model.model_id.clone(),
        thinking_level: None,
    }
}
async fn profile(f: &NativeFixture, model: &ModelSelection, value: ModelOverride) {
    let row = f
        .config
        .catalog()
        .await
        .unwrap()
        .connections
        .into_iter()
        .find(|row| row.connection_id == model.connection_id)
        .unwrap();
    let result = f
        .config
        .update_connection(UpdateCatalogConnectionInput {
            expected: ConnectionVersionBasis {
                connection_id: row.connection_id,
                revision: row.revision,
            },
            changes: ConnectionCatalogEntryUpdate {
                name: None,
                configuration: None,
                enabled: None,
                enabled_model_ids: None,
                model_overrides: Patch::Set(BTreeMap::from([(model.model_id.clone(), value)])),
                request_body_overlay: Patch::Keep,
            },
        })
        .await
        .unwrap();
    assert!(matches!(result, CatalogMutationResult::Committed { .. }));
}
async fn send(f: &NativeFixture, session: &str, message: &str) -> RunId {
    let SendResult::Queued { message_id, .. } = f.send(session, message, None).await.unwrap()
    else {
        panic!("actual queued receipt")
    };
    let mut changes = f.state.subscribe().unwrap();
    loop {
        changes.borrow_and_update();
        match f
            .state
            .queue()
            .resolve_message(session.into(), message_id.clone())
            .await
            .unwrap()
        {
            maka_agent_state::queue::MessageResolution::Delivered { run, .. } => return run,
            maka_agent_state::queue::MessageResolution::Pending => changes.changed().await.unwrap(),
            other => panic!("queued message did not deliver: {other:?}"),
        }
    }
}
async fn completed(f: &NativeFixture, session: &str, run: RunId) -> RunView {
    let view = f.wait_terminal(run).await.unwrap();
    assert_eq!(view.terminal, Some(Terminal::Completed));
    loop {
        let readiness: WorkReadiness = serde_json::from_value(
            f.query(
                "workReadiness",
                json!({
                    "sessionId":session,"target":{"kind":"run","runId":run},
                }),
            )
            .await
            .unwrap(),
        )
        .unwrap();
        match readiness {
            WorkReadiness::Ready => return f.state.frontier(run).await.unwrap(),
            WorkReadiness::Pending => tokio::task::yield_now().await,
            WorkReadiness::Unavailable => panic!("original Run cleanup unavailable"),
        }
    }
}
async fn facts(f: &NativeFixture, run: RunId) -> Vec<RecordedFact> {
    let mut records = Vec::new();
    let mut after = 0;
    loop {
        let page = f.state.history(run, after, 256).await.unwrap();
        let full = page.len() == 256;
        if let Some(last) = page.last() {
            after = last.revision;
        }
        records.extend(page);
        if !full {
            return records;
        }
    }
}
async fn decode<T: DeserializeOwned>(f: &NativeFixture, run: RunId, reference: &ContentRef) -> T {
    serde_json::from_slice(&f.state.content(run, reference.clone()).await.unwrap()).unwrap()
}
async fn attempts(f: &NativeFixture, run: RunId) -> Vec<(ModelAttemptId, RequestSpec)> {
    let mut attempts = Vec::new();
    for record in facts(f, run).await {
        if let Fact::ModelAttemptPrepared { attempt, step } = record.fact {
            attempts.push((attempt, f.state.request(run, step).await.unwrap()));
        }
    }
    attempts
}
fn visible(request: &Value, mode: ToolMode) -> Vec<String> {
    let wire = request["tools"].as_array().unwrap();
    if mode == ToolMode::CodeMode {
        assert_eq!(wire.len(), 2);
        assert_eq!(wire[0]["function"]["name"], "exec");
        let description = wire[0]["function"]["description"].as_str().unwrap();
        let (_, definitions) = description.split_once("declare const tools: {\n").unwrap();
        definitions
            .lines()
            .filter_map(|line| {
                line.split_once("(input:")
                    .map(|(name, _)| name.trim().to_string())
            })
            .collect()
    } else {
        wire.iter()
            .map(|t| t["function"]["name"].as_str().unwrap().into())
            .collect()
    }
}
pub(super) fn call(id: &str, name: &str, input: Value) -> Value {
    json!({"index":0,"id":id,"type":"function","function":{"name":name,"arguments":input.to_string()}})
}
pub(super) async fn respond_tools(socket: &mut TcpStream, mut calls: Vec<Value>, usage: usize) {
    for (index, call) in calls.iter_mut().enumerate() {
        call["index"] = json!(index);
    }
    let event = json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test",
        "choices":[{"index":0,"delta":{"tool_calls":calls},"finish_reason":null}]});
    let done = json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test",
        "choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],
        "usage":{"prompt_tokens":usage,"completion_tokens":10,"total_tokens":usage+10}});
    let body = format!("data: {event}\n\ndata: {done}\n\ndata: [DONE]\n\n");
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn discovery_defers_direct_admission_but_only_defers_descriptions_in_code_mode() {
    tokio::time::timeout(Duration::from_secs(45), async {
        const PRIVATE_SUMMARY:&str="incomplete summary";
        for mode in [ToolMode::Direct,ToolMode::CodeMode] {
            for compact in [false,true] {
                let directory=tempfile::tempdir().unwrap();
                let workspace=directory.path().join("workspace");
                std::fs::create_dir(&workspace).unwrap();
                let effects=Arc::new(AtomicUsize::new(0));
                let f=NativeFixture::open_with_service(directory.path(),configuration(&workspace),service(effects.clone())).await.unwrap();
                let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
                let base=format!("http://{}/v1",listener.local_addr().unwrap());
                let model=f.configure_model(&base,"gpt-4.1","fixture").await.unwrap();
                profile(&f,&model,ModelOverride {
                    code_mode:Some(mode==ToolMode::CodeMode),code_mode_language:Some(CodeLanguage::JavaScript),
                    context_window:Some(200_000),input_limit:Some(170_000),
                    compaction_threshold:Some(110_000),..Default::default()
                }).await;
                let session=f.create("Dynamic discovery",&workspace,Some(backend(&model))).await.unwrap();
                let observed=effects.clone();
                let state=f.state.clone();
                let original_session=session.clone();
                let server=tokio::spawn(async move {
                    let mut requests=Vec::new();
                    let (mut socket,_)=listener.accept().await.unwrap();
                    let first=fixture::read_request(&mut socket).await;
                    assert_eq!(visible(&first,mode),if mode==ToolMode::Direct {vec!["tool_search".to_string()]} else {vec![]});
                    assert!(state.cells().loaded(&original_session).await.unwrap().is_empty());
                    requests.push(first);
                    let calls=if mode==ToolMode::Direct {
                        vec![call("search","tool_search",json!({"query":"echo"})),call("premature","echo",json!({"n":1}))]
                    } else {
                        vec![call("search","exec",json!({"code":"store('discovery-scratch', 42); const tool = ALL_TOOLS.find(t => t.name === 'echo'); text(tool.description); text(await tools[tool.name]({n:1}));"}))]
                    };
                    respond_tools(&mut socket,calls,1_000).await;
                    let (mut socket,_)=listener.accept().await.unwrap();
                    let second=fixture::read_request(&mut socket).await;
                    assert!(visible(&second,mode).iter().any(|name|name=="echo"),"accepted discovery or a normal accepted Cell publishes its loaded description");
                    assert_eq!(state.cells().loaded(&original_session).await.unwrap(),BTreeSet::from(["echo".to_string()]));
                    assert_eq!(observed.load(Ordering::SeqCst),usize::from(mode==ToolMode::CodeMode));
                    if mode==ToolMode::CodeMode {
                        let saved=state.cells().value(&original_session,"discovery-scratch").await.unwrap().unwrap();
                        assert_eq!(serde_json::from_slice::<Value>(&saved).unwrap(),json!(42));
                        let result=second["messages"].as_array().unwrap().iter().find(|message|message["role"]=="tool").unwrap();
                        assert!(result["content"].as_str().unwrap().contains("echo(input:"));
                    }
                    requests.push(second.clone());
                    let use_tool=if mode==ToolMode::Direct {call("use","echo",json!({"n":2}))}
                        else {call("use","exec",json!({"code":"text(await tools.echo({n:2}));"}))};
                    respond_tools(&mut socket,vec![use_tool],100_000).await;
                    let (mut summary,_)=listener.accept().await.unwrap();
                    let request=fixture::read_request(&mut summary).await;
                    let instruction=maka_agent_facts::context::default_compaction_prompt(maka_agent_facts::language::Language::En);
                    assert!(request["messages"].to_string().contains(instruction.lines().next().unwrap()));
                    assert_eq!(request["max_tokens"],8000);
                    assert_eq!(request["tools"],second["tools"]);
                    assert_eq!(state.cells().loaded(&original_session).await.unwrap(),BTreeSet::from(["echo".to_string()]));
                    requests.push(request);
                    fixture::respond(&mut summary,if compact {fixture::SUMMARY} else {PRIVATE_SUMMARY},if compact {"stop"} else {"length"}).await;
                    let (mut final_socket,_)=listener.accept().await.unwrap();
                    let mut final_request=fixture::read_request(&mut final_socket).await;
                    let original_run=state.latest_run(original_session.clone()).await.unwrap().unwrap();
                    let deferred=state.frontier(original_run).await.unwrap();
                    assert!(deferred.baseline.is_none(),"85% prepares a candidate; neither success nor failure adopts it yet");
                    assert_eq!(state.cells().loaded(&original_session).await.unwrap(),BTreeSet::from(["echo".to_string()]));
                    assert_eq!(final_request["tools"],second["tools"],"deferred or failed Summary restores the exact prior Main catalog");
                    if compact {
                        requests.push(final_request);
                        super::context_overflow::overflow(&mut final_socket,false).await;
                        (final_socket,_)=listener.accept().await.unwrap();
                        final_request=fixture::read_request(&mut final_socket).await;
                    }
                    assert_eq!(visible(&final_request,mode).iter().any(|name|name=="echo"),!compact);
                    assert_eq!(visible(&final_request,mode).iter().any(|name|name=="tool_search"),mode==ToolMode::Direct);
                    assert_eq!(state.cells().loaded(&original_session).await.unwrap(),if compact {BTreeSet::new()} else {BTreeSet::from(["echo".to_string()])});
                    if mode==ToolMode::CodeMode {
                        let saved=state.cells().value(&original_session,"discovery-scratch").await.unwrap().unwrap();
                        assert_eq!(serde_json::from_slice::<Value>(&saved).unwrap(),json!(42),"clearing discovery never clears the accepted Session KV");
                    }
                    assert!(!final_request["messages"].to_string().contains(PRIVATE_SUMMARY));
                    requests.push(final_request);
                    fixture::respond(&mut final_socket,"done","stop").await;
                    assert!(tokio::time::timeout(Duration::from_millis(30),listener.accept()).await.is_err(),"no second Summary or extra Main");
                    requests
                });
                let run=send(&f,&session,"Use echo").await;
                let view=completed(&f,&session,run).await;
                let requests=server.await.unwrap();
                assert_eq!(requests.len(),if compact {5} else {4});
                assert_eq!(effects.load(Ordering::SeqCst),if mode==ToolMode::Direct {1} else {2});
                let records=facts(&f,run).await;
                assert_eq!(records.iter().filter(|record|matches!(&record.fact,Fact::ContextCompacted {..})).count(),usize::from(compact));
                assert_eq!(view.baseline.is_some(),compact);
                let physical=attempts(&f,run).await;
                assert_eq!(physical.len(),requests.len());
                let summaries:Vec<_>=physical.iter().filter(|(_,request)|request.accounting.purpose==ModelPurpose::Summary).collect();
                assert_eq!(summaries.len(),1);
                let (summary_attempt,summary)=summaries[0];
                let (_,last)=physical.last().unwrap();
                assert_eq!(last.accounting.purpose,ModelPurpose::Main);
                let closed=records.iter().find_map(|record|match &record.fact {
                    Fact::ModelClosed {attempt,protocol,..} if attempt==summary_attempt=>Some(protocol),_=>None,
                }).unwrap();
                let closure:ModelClosureProtocol=serde_json::from_value(closed.clone()).unwrap();
                assert_eq!(physical[2].0,*summary_attempt,"the third physical request is the one prepared Summary");
                assert!(summary.compaction_recovery.is_none());
                let (_,deferred)=&physical[3];
                assert_eq!(deferred.accounting.purpose,ModelPurpose::Main);
                assert_eq!(deferred.compaction_recovery,Some(*summary_attempt));
                assert_eq!(last.compaction_recovery,Some(*summary_attempt),"the original Summary candidate owns the single budget");
                let provenance:RequestContextEvidence=decode(&f,run,&deferred.provenance).await;
                assert!((93_500..110_000).contains(&provenance.estimated_input_tokens),"real measured input crosses Prepare85 but not Adopt100");
                let mut frozen_main=None;
                for record in &records {
                    if let Fact::StepPrepared {step,..}=&record.fact {
                        let request=f.state.request(run,*step).await.unwrap();
                        if request.accounting.purpose==ModelPurpose::Main && request.compaction_recovery.is_none()
                            && !physical.iter().any(|(_,actual)|actual.step==*step) {frozen_main=Some(request);}
                    }
                }
                let original=frozen_main.expect("actual original unattempted Main retained across Summary preparation");
                assert_eq!(deferred.source_capture,original.source_capture);
                assert_eq!(deferred.source_digest,original.source_digest);
                assert_eq!(deferred.request,original.request);
                if compact {
                    let (overflow,_)=&physical[3];
                    assert!(records.iter().any(|record|matches!(&record.fact,
                        Fact::AttemptRecoveryRecorded {attempt,recovery:AttemptRecovery::ContextOverflow {observed_output:false}} if attempt==overflow)));
                    assert_eq!(closure.finish_reason,ModelFinishReason::Stop);
                    let Some(SummaryResult::Text {summary:body})=closure.summary else {panic!("actual complete Summary")};
                    assert_eq!(body.text,fixture::SUMMARY);
                    let baseline:CompactedContext=decode(&f,run,view.baseline.as_ref().unwrap()).await;
                    baseline.validate().unwrap();
                    assert_eq!(baseline.checkpoint.summary_step_id,summary.step,"overflow adopts this existing candidate without another Summary");
                    assert_eq!(baseline.source_capture,summary.source_capture);
                } else {
                    assert_eq!(closure.finish_reason,ModelFinishReason::Length);
                    assert_eq!(closure.summary,Some(SummaryResult::Incomplete));
                }
                assert!(!records.iter().any(|record|matches!(&record.fact,Fact::ModelObserved {attempt,..} if attempt==summary_attempt)));
                assert!(!serde_json::to_string(&records).unwrap().contains(PRIVATE_SUMMARY));
                if mode==ToolMode::Direct {
                    assert_eq!(records.iter().filter(|record|matches!(&record.fact,Fact::ToolAdmitted {tool} if tool.call=="search")).count(),1);
                    assert!(!records.iter().any(|record|matches!(&record.fact,Fact::ToolAdmitted {tool} if tool.call=="premature")));
                    assert_eq!(records.iter().filter(|record|matches!(&record.fact,
                        Fact::ToolDecided {tool,decision:ToolDecision::Rejected {..}} if tool.call=="premature")).count(),1);
                    let loaded:Vec<_>=records.iter().filter_map(|record|match &record.fact {
                        Fact::ToolsLoaded {tool,names}=>Some((tool,names)),_=>None,
                    }).collect();
                    assert_eq!(loaded.len(),1);
                    let (tool,names)=loaded[0];
                    assert_eq!(tool.call,"search");
                    assert_eq!(*names,BTreeSet::from(["echo".to_string()]));
                    let result=records.iter().find_map(|record|match &record.fact {
                        Fact::LocalToolReturned {tool:key,result,is_error:false,..} if key==tool=>Some(result),_=>None,
                    }).unwrap();
                    let returned:ToolReturn<ReturnedToolResult>=decode(&f,run,result).await;
                    returned.validate().unwrap();
                    assert!(!returned.body.is_error);
                    assert_eq!(returned.body.loaded_tools,*names);
                    assert_eq!(returned.body.output,ToolOutput::Json(json!({"activated":["echo"]})));
                } else {
                    assert!(!records.iter().any(|record|matches!(&record.fact,Fact::ToolsLoaded {..})),"Code Mode does not synthesize tool_search");
                    let publications:Vec<_>=records.iter().filter_map(|record|match &record.fact {
                        Fact::Cell {event:CellEvent::LoadedToolsPublished {cell,names}}=>Some((*cell,names)),_=>None,
                    }).collect();
                    assert_eq!(publications.len(),2);
                    for (cell,names) in publications {
                        assert_eq!(*names,BTreeSet::from(["echo".to_string()]));
                        let original=f.state.cells().read(&session,cell).await.unwrap().unwrap();
                        assert!(matches!(original.owner,CellOwner::Agent {link,..} if link.run==run));
                        assert!(matches!(original.status,CellStatus::Completed {accepted:true,..}));
                        assert!(records.iter().any(|record|matches!(&record.fact,
                            Fact::Cell {event:CellEvent::Completed {cell:id,publication,..}} if *id==cell && publication.loaded_tools.as_ref()==Some(names))));
                        assert!(records.iter().any(|record|matches!(&record.fact,Fact::Cell {event:CellEvent::ResultAccepted {cell:id}} if *id==cell)));
                    }
                }
                f.shutdown().await.unwrap();
            }
        }
    }).await.expect("dynamic tool lifecycle must make bounded progress");
}
