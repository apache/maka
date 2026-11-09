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
    contract::{BackendPreference, CompactResult, SendResult},
};
use maka_agent_facts::{
    artifact::ToolReturn,
    configuration::{
        CatalogMutationResult, ConnectionCatalogEntryUpdate, ConnectionVersionBasis, ModelOverride,
        Patch, UpdateCatalogConnectionInput,
    },
    context::{ModelClosureProtocol, ModelPurpose, SummaryResult},
    durable::{Fact, FactId, RecordedFact, RunId, Terminal},
    tool_output::{AcceptedToolResult, ReturnedToolResult},
};
use maka_host_runtime::application::{Context, Handler, HandlerResult, HandlerValue, NativeOwner};
use maka_plugin_core::{
    contract::{Contract, Interface, Method, MethodMode, Transport},
    operation::OperationCleanup,
};
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
    sync::oneshot,
};

struct Large {
    count: Arc<AtomicUsize>,
    repeats: usize,
}
impl Handler for Large {
    fn call(
        &self,
        method: String,
        _input: Value,
        context: Context,
    ) -> BoxFuture<'static, HandlerResult> {
        assert_eq!(method, "read");
        assert!(context.scope().identity.agent().is_some());
        assert!(context.work_custody().is_some());
        assert!(
            context.operation().is_none(),
            "the original query is not an operation grant"
        );
        self.count.fetch_add(1, Ordering::SeqCst);
        let repeats = self.repeats;
        Box::pin(async move {
            Ok(HandlerValue::Json(
                json!({"content":"visible-original-marker".repeat(repeats)}),
            ))
        })
    }
}
impl NativeOwner for Large {
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}
fn service(count: Arc<AtomicUsize>, repeats: usize) -> FixtureService {
    FixtureService::new(
        Contract {
            name: "fixture.LargeRead".into(),
            version: 1,
            transport: Transport::Remote,
            interface: Interface::Service {
                methods: BTreeMap::from([(
                    "read".into(),
                    Method {
                        mode: MethodMode::Query,
                        input: json!({"type":"object","properties":{"path":{"type":"string"}}})
                            .into(),
                        output: json!({"type":"object"}).into(),
                        resources: BTreeMap::new(),
                        progress: None,
                    },
                )]),
            },
        },
        Arc::new(Large { count, repeats }),
    )
}
pub(super) fn configuration(workspace: &Path) -> Configuration {
    serde_json::from_value(json!({"locale":"en","automaticTitles":false,
        "workspaceRoots":[{"label":"Workspace","path":workspace}],
        "permissions":{"access":"workspace_write","requestPermissions":false},
        "tools":[{"name":"Read","description":"Read original large fixture result","method":"read",
            "target":{"kind":"import","name":"fixture"},"result":"json","confirmation":"preapproved"}],
    })).unwrap()
}
pub(super) async fn model(f: &NativeFixture, base: &str, spent: bool) -> ModelSelection {
    let model = f.configure_model(base, "gpt-4.1", "fixture").await.unwrap();
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
                model_overrides: Patch::Set(BTreeMap::from([(
                    model.model_id.clone(),
                    ModelOverride {
                        code_mode: Some(false),
                        context_window: Some(200_000),
                        input_limit: Some(200_000),
                        max_output_tokens: Some(4000),
                        compaction_threshold: spent.then_some(20_000),
                        ..Default::default()
                    },
                )])),
                request_body_overlay: Patch::Keep,
            },
        })
        .await
        .unwrap();
    assert!(matches!(result, CatalogMutationResult::Committed { .. }));
    model
}
pub(super) fn backend(model: &ModelSelection) -> BackendPreference {
    BackendPreference::Model {
        connection_id: model.connection_id.clone(),
        model_id: model.model_id.clone(),
        thinking_level: None,
    }
}
pub(super) async fn send(
    f: &NativeFixture,
    session: &str,
    text: &str,
    model: &ModelSelection,
) -> RunId {
    let SendResult::Queued { message_id, .. } =
        f.send(session, text, Some(backend(model))).await.unwrap()
    else {
        panic!("actual queued message")
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
            other => panic!("queued message was not delivered: {other:?}"),
        }
    }
}
pub(super) async fn compact(f: &NativeFixture, session: &str, model: &ModelSelection) -> RunId {
    let result: CompactResult = serde_json::from_value(
        f.mutation_value(
            "compact",
            json!({
                "sessionId":session,"model":model,"thinkingLevel":null,"prompt":null,
            }),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    let CompactResult::Started { execution } = result else {
        panic!("actual compact admission")
    };
    execution.run_id
}
pub(super) async fn facts(f: &NativeFixture, run: RunId) -> Vec<RecordedFact> {
    let mut result = Vec::new();
    let mut after = 0;
    loop {
        let page = f.state.history(run, after, 256).await.unwrap();
        if page.is_empty() {
            return result;
        }
        after = page.last().unwrap().revision;
        result.extend(page);
    }
}
async fn baselines(f: &NativeFixture, session: &str) -> BTreeSet<FactId> {
    let mut result = BTreeSet::new();
    for run in f.state.runs(session.into(), None, 32).await.unwrap() {
        result.extend(facts(f, run).await.into_iter().filter_map(|record| {
            matches!(record.fact, Fact::ContextCompacted { .. }).then_some(record.id)
        }));
    }
    result
}
async fn tools(socket: &mut TcpStream, count: usize, usage: usize) {
    let calls = (0..count)
        .map(|index| {
            super::dynamic_tools::call(&format!("call-{index}"), "Read", json!({"path":"file"}))
        })
        .collect();
    super::dynamic_tools::respond_tools(socket, calls, usage).await;
}
async fn summary_settled(state: &maka_agent_state::Store, run: RunId, expected: usize) {
    let mut changes = state.subscribe().unwrap();
    loop {
        changes.borrow_and_update();
        let view = state.frontier(run).await.unwrap();
        let mut summaries = Vec::new();
        for attempt in view.attempts.values() {
            if state
                .request(run, attempt.step)
                .await
                .unwrap()
                .accounting
                .purpose
                == ModelPurpose::Summary
            {
                summaries.push(attempt);
            }
        }
        assert!(
            summaries.len() <= expected,
            "a failed background summary is not regenerated"
        );
        if summaries.len() == expected
            && summaries.iter().all(|attempt| {
                attempt.cleanup == OperationCleanup::Confirmed
                    && (attempt.closed.is_some()
                        || attempt.interrupted.is_some()
                        || attempt.source_failure.is_some())
            })
        {
            return;
        }
        changes.changed().await.unwrap();
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn settled_results_are_pruned_before_context_limits_and_survive_failed_summary() {
    tokio::time::timeout(Duration::from_secs(90),async{
        for (spent,interrupted,call_count,repeats) in [(false,false,40,10_000),(true,false,1,600),(true,true,1,600)]{
            let directory=tempfile::tempdir().unwrap();let workspace=directory.path().join("workspace");
            tokio::fs::create_dir(&workspace).await.unwrap();
            let count=Arc::new(AtomicUsize::new(0));
            let f=NativeFixture::open_with_service(directory.path(),configuration(&workspace),service(count.clone(),repeats)).await.unwrap();
            let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base=format!("http://{}/v1",listener.local_addr().unwrap());
            let selected=model(&f,&base,spent).await;
            let session=f.create("Pruned original results",&workspace,Some(backend(&selected))).await.unwrap();
            let state=f.state.clone();let (run_send,run_recv)=oneshot::channel();
            let server=tokio::spawn(async move{
                if interrupted{
                    for text in ["old-answer",fixture::SUMMARY]{
                        let (mut socket,_)=listener.accept().await.unwrap();fixture::read_request(&mut socket).await;
                        fixture::respond(&mut socket,text,"stop").await;
                    }
                }
                let (mut socket,_)=listener.accept().await.unwrap();
                let first=fixture::read_request(&mut socket).await;
                assert_eq!(first["max_tokens"],4000);
                // Native's real system prompt is larger than the retired empty
                // fixture. Real measured input keeps the next cut in 85..100%.
                tools(&mut socket,call_count,if spent{17_000}else{200}).await;
                let mut main=None;let mut summaries=0;let expected=usize::from(spent);
                while summaries<expected||main.is_none(){
                    let (mut socket,_)=listener.accept().await.unwrap();let request=fixture::read_request(&mut socket).await;
                    if !request["messages"].to_string().contains(maka_agent_facts::context::default_compaction_prompt(maka_agent_facts::language::Language::En).lines().next().unwrap()){
                        assert!(main.is_none());main=Some((socket,request));continue;
                    }
                    summaries+=1;assert!(summaries<=expected);
                    assert_eq!(request["max_tokens"],8000,"full-capacity Summary reserve is independent of Main's 4000 requested tokens");
                    assert!(request["messages"].to_string().contains("visible-original-marker"));
                    if interrupted{
                        let delta=json!({"id":"summary","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"content":"partial-summary-must-not-replay"},"finish_reason":null}]});
                        let failure=json!({"error":{"message":"summary stream failed","type":"server_error"}});
                        let body=format!("data: {delta}\n\ndata: {failure}\n\n");
                        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
                    }else{fixture::respond(&mut socket,"incomplete summary","length").await;}
                }
                let run=run_recv.await.unwrap();summary_settled(&state,run,expected).await;
                let (mut socket,request)=main.unwrap();
                assert_eq!(request["max_tokens"],4000);
                let messages=request["messages"].to_string();
                assert!(messages.contains("visible-original-marker"));
                assert!(!messages.contains("partial-summary-must-not-replay"));
                assert_eq!(messages.contains("summary-marker"),interrupted);
                let pages:Vec<_>=request["messages"].as_array().unwrap().iter().filter(|message|message["role"]=="tool").collect();
                assert_eq!(pages.len(),call_count,"one original result per accepted call");
                let mut locators=BTreeSet::new();
                for message in pages{
                    let content=message["content"].as_str().unwrap();assert!(content.encode_utf16().count()<=7500);
                    let page:Value=serde_json::from_str(content).unwrap();
                    assert_eq!(page["kind"],"maka.archived_tool_result");assert_eq!(page["reason"],"tool_result_pruned");
                    locators.insert(page["resourceRef"].as_str().unwrap().to_owned());
                }
                assert_eq!(locators.len(),call_count);
                fixture::respond(&mut socket,"done","stop").await;
                locators
            });
            if interrupted{
                let old=send(&f,&session,"old",&selected).await;assert_eq!(f.wait_terminal(old).await.unwrap().terminal,Some(Terminal::Completed));
                let baseline=compact(&f,&session,&selected).await;assert_eq!(f.wait_terminal(baseline).await.unwrap().terminal,Some(Terminal::Completed));
            }
            let previous=baselines(&f,&session).await;assert_eq!(previous.len(),usize::from(interrupted));
            let run=send(&f,&session,"read",&selected).await;run_send.send(run).unwrap();
            let terminal=f.wait_terminal(run).await.unwrap();assert_eq!(terminal.terminal,Some(Terminal::Completed));
            let locators=server.await.unwrap();assert_eq!(count.load(Ordering::SeqCst),call_count);
            let records=facts(&f,run).await;let mut accepted=0;
            for record in &records{
                let Fact::ToolResultAccepted{result,..}=&record.fact else{continue};
                accepted+=1;assert!(locators.contains(&format!("archive:{}",record.id)));
                let result:AcceptedToolResult=serde_json::from_slice(&f.state.content(run,result.clone()).await.unwrap()).unwrap();
                let original=match result{AcceptedToolResult::Local{result}|AcceptedToolResult::Operation{result:Some(result),..}=>result,other=>panic!("actual original returned result: {other:?}")};
                let original:ToolReturn<ReturnedToolResult>=serde_json::from_slice(&f.state.content(run,original).await.unwrap()).unwrap();
                assert_eq!(original.body.output.into_json()["content"],"visible-original-marker".repeat(repeats),"pruning must not overwrite full original Root output");
            }
            assert_eq!(accepted,call_count);assert_eq!(previous,baselines(&f,&session).await);
            let mut summaries=0;
            for attempt in terminal.attempts.values(){
                if f.state.request(run,attempt.step).await.unwrap().accounting.purpose!=ModelPurpose::Summary{continue;}
                summaries+=1;assert_eq!(attempt.cleanup,OperationCleanup::Confirmed);assert!(attempt.private_partial.is_none());
                if !interrupted{
                    let closed=attempt.closed.as_ref().expect("true upstream Length completion");
                    let protocol:ModelClosureProtocol=serde_json::from_value(closed.protocol.clone()).unwrap();
                    assert!(matches!(protocol.summary,Some(SummaryResult::Incomplete)));
                }else{assert!(attempt.closed.as_ref().is_some_and(|closed|closed.outcome==maka_agent_facts::accounting::Outcome::Error)||attempt.source_failure.is_some());}
            }
            assert_eq!(summaries,usize::from(spent));
            f.shutdown().await.unwrap();
        }
    }).await.unwrap();
}
