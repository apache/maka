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
    code_mode as fixture,
    native::{FixtureService, NativeFixture},
};
use futures_util::future::BoxFuture;
use maka_agent_api::{
    Configuration, ModelSelection,
    contract::{BackendPreference, SendResult, WorkReadiness},
};
use maka_agent_facts::{
    artifact::ToolReturn,
    cells::{
        CellEvent, CellObservation, CellOwner, CellReplyState, CellReturnedResult, CellStatus,
    },
    configuration::{
        CatalogMutationResult, ConnectionCatalogEntryUpdate, ConnectionVersionBasis, ModelOverride,
        Patch, UpdateCatalogConnectionInput,
    },
    durable::{AcceptedResult, ContentRef, Fact, RecordedFact, RunId, Terminal},
    execution::CodeLanguage,
    tool_output::{AcceptedToolResult, CellFinalEvidence, ReturnedToolResult, ToolOutput},
};
use maka_agent_state::{Store, fold::RunView};
use maka_host_runtime::application::{Context, Handler, HandlerResult, HandlerValue, NativeOwner};
use maka_plugin_core::{
    contract::{Contract, Interface, Method, MethodMode, Transport},
    operation::{OperationCleanup, OperationOutcome, OperationResult, Receipt},
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{net::TcpListener, sync::Barrier};

fn configuration(workspace: &Path) -> Configuration {
    let tools = ["left", "right"].map(|name| {
        json!({
            "name":name,"description":format!("fixture {name}"),"method":name,
            "target":{"kind":"import","name":"fixture"},"result":"json",
            "confirmation":"preapproved","nestable":true,
        })
    });
    serde_json::from_value(json!({
        "locale":"en", "workspaceRoots":[{"label":"Workspace","path":workspace}],
        "permissions":{"access":"workspace_write","requestPermissions":false},
        "tools":tools,
    }))
    .unwrap()
}

struct Effects {
    state: Mutex<Option<Store>>,
    count: Arc<AtomicUsize>,
    together: Arc<Barrier>,
}
impl Effects {
    fn new(count: Arc<AtomicUsize>) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(None),
            count,
            together: Arc::new(Barrier::new(2)),
        })
    }
    fn attach(&self, f: &NativeFixture) {
        assert!(
            self.state
                .lock()
                .unwrap()
                .replace(f.state.clone())
                .is_none()
        );
    }
    fn service(self: &Arc<Self>) -> FixtureService {
        let schema = json!({"type":"object","properties":{"value":{"type":"integer"}},"required":["value"],"additionalProperties":false});
        FixtureService::new(
            Contract {
                name: "fixture.ParallelEcho".into(),
                version: 1,
                transport: Transport::Remote,
                interface: Interface::Service {
                    methods: ["left", "right"]
                        .into_iter()
                        .map(|name| {
                            (
                                name.into(),
                                Method {
                                    mode: MethodMode::Mutation,
                                    input: schema.clone().into(),
                                    output: schema.clone().into(),
                                    resources: BTreeMap::new(),
                                    progress: None,
                                },
                            )
                        })
                        .collect(),
                },
            },
            self.clone(),
        )
    }
}
impl Handler for Effects {
    fn call(
        &self,
        method: String,
        input: Value,
        context: Context,
    ) -> BoxFuture<'static, HandlerResult> {
        assert!(matches!(method.as_str(), "left" | "right"));
        assert!(context.operation().is_some() && context.operation_scope().is_some());
        assert!(
            context.work_custody().is_some(),
            "actual Native Run owns this mutation"
        );
        let execution = context
            .scope()
            .identity
            .agent()
            .expect("actual Agent caller")
            .clone();
        let operation_id = context.scope().identity.operation_id().unwrap().to_owned();
        let state = self
            .state
            .lock()
            .unwrap()
            .as_ref()
            .expect("fixture actual Root attached")
            .clone();
        let count = self.count.clone();
        let together = self.together.clone();
        Box::pin(async move {
            let records = stored_facts(&state, execution.run_id).await;
            let pending: Vec<_> = records.iter().filter_map(|record| match &record.fact {
                Fact::Cell {event:CellEvent::ChildPrepared {cell,operation,name,..}}
                    if name == &method && !records.iter().any(|record| matches!(&record.fact,
                        Fact::Cell {event:CellEvent::ChildObserved {operation:id,..}} if id==operation)) => Some((*cell,*operation)),
                _ => None,
            }).collect();
            assert_eq!(
                pending.len(),
                1,
                "effect has exactly one unsettled committed original child T1"
            );
            let (cell, operation) = pending[0];
            assert_eq!(operation_id, format!("cell:{cell}:{operation}"));
            assert_eq!(records.iter().filter(|record| matches!(&record.fact,
                Fact::Cell {event:CellEvent::ChildAdmitted {cell:id,operation:child}} if *id==cell && *child==operation)).count(),1);
            assert!(records.iter().any(|record| matches!(&record.fact,
                Fact::Cell {event:CellEvent::Started {cell:id,owner:CellOwner::Agent {link,call},..}}
                if *id==cell && link.run==execution.run_id && call=="exec-provider")));
            assert!(records.iter().all(|record| record.run == execution.run_id));
            count.fetch_add(1, Ordering::SeqCst);
            // Serial nested execution cannot pass this barrier.
            together.wait().await;
            Ok(HandlerValue::Json(input))
        })
    }
}
impl NativeOwner for Effects {
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        self.state.lock().unwrap().take();
        Box::pin(async { Ok(()) })
    }
}

fn backend(model: &ModelSelection) -> BackendPreference {
    BackendPreference::Model {
        connection_id: model.connection_id.clone(),
        model_id: model.model_id.clone(),
        thinking_level: None,
    }
}
async fn code_mode(f: &NativeFixture, model: &ModelSelection) {
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
                        code_mode: Some(true),
                        code_mode_language: Some(CodeLanguage::JavaScript),
                        ..Default::default()
                    },
                )])),
                request_body_overlay: Patch::Keep,
            },
        })
        .await
        .unwrap();
    assert!(matches!(result, CatalogMutationResult::Committed { .. }));
}
async fn stored_facts(state: &Store, run: RunId) -> Vec<RecordedFact> {
    let mut records = Vec::new();
    let mut after = 0;
    loop {
        let page = state.history(run, after, 256).await.unwrap();
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
async fn message(f: &NativeFixture, session: &str, text: &str) -> RunView {
    let SendResult::Queued { message_id, .. } = f.send(session, text, None).await.unwrap() else {
        panic!("actual queued receipt")
    };
    let mut changes = f.state.subscribe().unwrap();
    let run = loop {
        changes.borrow_and_update();
        match f
            .state
            .queue()
            .resolve_message(session.into(), message_id.clone())
            .await
            .unwrap()
        {
            maka_agent_state::queue::MessageResolution::Delivered { run, .. } => break run,
            maka_agent_state::queue::MessageResolution::Pending => changes.changed().await.unwrap(),
            observed => panic!("original message did not deliver: {observed:?}"),
        }
    };
    f.wait_terminal(run).await.unwrap();
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
            WorkReadiness::Ready => break,
            WorkReadiness::Pending => tokio::task::yield_now().await,
            WorkReadiness::Unavailable => panic!("actual original Run cleanup became unavailable"),
        }
    }
    let view = f.state.frontier(run).await.unwrap();
    assert_eq!(view.terminal, Some(Terminal::Completed));
    assert_eq!(view.spec.session_id, session);
    assert!(
        view.attempts
            .values()
            .all(|attempt| attempt.cleanup == OperationCleanup::Confirmed)
    );
    view
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn scratch_store_survives_turns_and_native_restart() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1",listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for (index,code) in ["store('saved', 42);","text(load('saved'));","text(load('saved'));"]
                .into_iter().enumerate() {
                let (mut socket,_) = listener.accept().await.unwrap();
                requests.push(fixture::read_request(&mut socket).await);
                crate::dynamic_tools::respond_tools(&mut socket,vec![crate::dynamic_tools::call("cell","exec",json!({"code":code}))],10).await;
                let (mut socket,_) = listener.accept().await.unwrap();
                let request = fixture::read_request(&mut socket).await;
                let text = request["messages"].as_array().unwrap().iter().rev().find(|message| message["role"]=="tool").unwrap()["content"].as_str().unwrap();
                if index>0 {assert_eq!(text.lines().last().unwrap(),"42");}
                requests.push(request);
                fixture::respond(&mut socket,false).await;
            }
            assert!(tokio::time::timeout(Duration::from_millis(30),listener.accept()).await.is_err());
            requests
        });
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let effects = Effects::new(count.clone());
        let f = NativeFixture::open_with_service(directory.path(),configuration(&workspace),effects.service()).await.unwrap();
        effects.attach(&f);
        let model = f.configure_model(&base,"gpt-4.1","fixture-secret").await.unwrap();
        code_mode(&f,&model).await;
        let session = f.create("Scratch store",&workspace,Some(backend(&model))).await.unwrap();
        let mut before = Vec::new();
        for index in 0..2 {
            let view = message(&f,&session,&format!("question store-{index}")).await;
            let records = stored_facts(&f.state,view.run).await;
            let starts: Vec<_> = records.iter().filter_map(|record| match &record.fact {
                Fact::Cell {event:CellEvent::Started {owner,..}} => Some(owner), _=>None,
            }).collect();
            assert_eq!(starts.len(),1);
            assert!(matches!(starts[0],CellOwner::Agent {link,call} if link.run==view.run && call=="cell"));
            let publications: Vec<_> = records.iter().filter_map(|record| match &record.fact {
                Fact::Cell {event:CellEvent::SessionValuePublished {cell,key,..}} if key=="saved" => Some(*cell),
                _=>None,
            }).collect();
            assert_eq!(publications.len(),usize::from(index==0));
            for cell in publications {
                let original = f.state.cells().read(&session,cell).await.unwrap().unwrap();
                assert!(matches!(original.owner,CellOwner::Agent {link,..} if link.run==view.run));
                assert!(matches!(original.status,CellStatus::Completed {accepted:true,..}));
            }
            assert_eq!(f.state.cells().value(&session,"saved").await.unwrap(),Some(b"42".to_vec()));
            before.push((view.run,records));
        }
        f.shutdown().await.unwrap();
        assert!(effects.state.lock().unwrap().is_none());
        let effects = Effects::new(count.clone());
        let f = NativeFixture::open_with_service(directory.path(),configuration(&workspace),effects.service()).await.unwrap();
        effects.attach(&f);
        assert_eq!(f.state.cells().value(&session,"saved").await.unwrap(),Some(b"42".to_vec()));
        for (run,records) in &before {assert_eq!(stored_facts(&f.state,*run).await,*records);}
        let last = message(&f,&session,"question store-2").await;
        let records = stored_facts(&f.state,last.run).await;
        let owners: Vec<_> = records.iter().filter_map(|record| match &record.fact {
            Fact::Cell {event:CellEvent::Started {owner,..}} => Some(owner),_=>None,
        }).collect();
        assert_eq!(owners.len(),1);
        assert!(matches!(owners[0],CellOwner::Agent {link,call} if link.run==last.run && call=="cell"));
        assert!(!records.iter().any(|record| matches!(&record.fact,
            Fact::Cell {event:CellEvent::SessionValuePublished {..}})));
        assert_eq!(f.state.cells().value(&session,"saved").await.unwrap(),Some(b"42".to_vec()));
        for (run,records) in &before {assert_eq!(stored_facts(&f.state,*run).await,*records);}
        assert_eq!(count.load(Ordering::SeqCst),0);
        assert_eq!(server.await.unwrap().len(),6);
        f.shutdown().await.unwrap();
    }).await.expect("session store lifecycle must complete");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn streamed_exec_journals_parallel_children_and_reopens_without_reexecution() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1",listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for index in 0..3 {
                let (mut socket,_) = listener.accept().await.unwrap();
                requests.push(fixture::read_request(&mut socket).await);
                fixture::respond(&mut socket,index==0).await;
            }
            assert!(tokio::time::timeout(Duration::from_millis(30),listener.accept()).await.is_err());
            requests
        });
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let effects = Effects::new(count.clone());
        let f = NativeFixture::open_with_service(directory.path(),configuration(&workspace),effects.service()).await.unwrap();
        effects.attach(&f);
        let model = f.configure_model(&base,"gpt-4.1","fixture-secret").await.unwrap();
        code_mode(&f,&model).await;
        let session = f.create("Parallel Code Mode",&workspace,Some(backend(&model))).await.unwrap();
        let first = message(&f,&session,"question first").await;
        let records = stored_facts(&f.state,first.run).await;
        assert_eq!(count.load(Ordering::SeqCst),2);
        assert!(records.iter().all(|record| record.run==first.run));
        let envelope = json!({"ok":true,"value":null,"toolCalls":[{"index":1,"name":"left"},{"index":2,"name":"right"}]});
        let parents: Vec<_> = records.iter().enumerate().filter_map(|(index,record)| match &record.fact {
            Fact::ToolAdmitted {tool}=>Some((index,tool)),_=>None,
        }).collect();
        assert_eq!(parents.len(),1);
        let (parent_t1,parent) = parents[0];
        assert_eq!(parent.call,"exec-provider");
        let step = first.attempts[&parent.attempt].step;
        let frozen = f.state.request(first.run,step).await.unwrap();
        let provider_calls: Vec<_> = records.iter().filter_map(|record| match &record.fact {
            Fact::ModelObserved {attempt,part:maka_agent_facts::model::ModelPart::ToolCall {call},..}
                if *attempt==parent.attempt => Some(call),
            _ => None,
        }).collect();
        assert_eq!(provider_calls.len(),1);
        assert_eq!(provider_calls[0].id,parent.call);
        assert_eq!(provider_calls[0].name,"exec");
        assert_eq!(provider_calls[0].input.as_json(),Some(&json!({"code":fixture::CODE})));
        let starts: Vec<_> = records.iter().enumerate().filter_map(|(index,record)| match &record.fact {
            Fact::Cell {event:CellEvent::Started {cell,owner,source}}=>Some((index,*cell,owner,source)),_=>None,
        }).collect();
        assert_eq!(starts.len(),1);
        let (cell_t1,cell,owner,source) = starts[0];
        let CellOwner::Agent {link,call} = owner else {panic!("Cell must retain its real Agent parent")};
        assert_eq!(link.run,first.run);
        assert_eq!(link.step,step);
        assert_eq!(link.attempt,parent.attempt);
        assert_eq!(call,&parent.call);
        let source = f.state.content(first.run,source.clone()).await.unwrap();
        assert_eq!(source,fixture::CODE.as_bytes());
        let completions: Vec<_> = records.iter().enumerate().filter_map(|(index,record)| match &record.fact {
            Fact::Cell {event:CellEvent::Completed {cell:id,result,..}} if *id==cell=>Some((index,result)),_=>None,
        }).collect();
        assert_eq!(completions.len(),1);
        let (cell_t2,completed) = completions[0];
        let observation: CellObservation = decode(&f,first.run,completed).await;
        let CellObservation::Completed {cell_id,result,..} = observation else {panic!("normal completed cell")};
        assert_eq!(cell_id,cell);
        assert_eq!(result,envelope);
        let accepted: Vec<_> = records.iter().enumerate().filter_map(|(index,record)| match &record.fact {
            Fact::ToolResultAccepted {tool,result,outcome} if tool==parent=>Some((index,result,outcome)),_=>None,
        }).collect();
        assert_eq!(accepted.len(),1);
        let (parent_t2,result,outcome) = accepted[0];
        let returned: AcceptedToolResult = decode(&f,first.run,result).await;
        match (outcome,returned) {
            (AcceptedResult::Succeeded,AcceptedToolResult::Local {result}) => {
                let returned: ToolReturn<ReturnedToolResult> = decode(&f,first.run,&result).await;
                returned.validate().unwrap();
                assert!(!returned.body.is_error);
                let ToolOutput::Cell(reply) = returned.body.output else {panic!("exec retains original cell evidence")};
                assert_eq!(reply.cell,cell);
                assert_eq!(reply.state,CellReplyState::Completed {result:completed.clone()});
                assert_eq!(reply.observation["result"],envelope);
            }
            (AcceptedResult::CellRecovered {cell:id},AcceptedToolResult::RecoveredCell {
                cell:actual,evidence:CellFinalEvidence::Completed {result},
            }) => {
                assert_eq!(*id,cell);
                assert_eq!(actual,cell);
                assert_eq!(result,*completed);
            }
            _ => panic!("parent T2 must accept this exact original successful completed Cell"),
        }
        let children: Vec<_> = records.iter().enumerate().filter_map(|(index,record)| match &record.fact {
            Fact::Cell {event:CellEvent::ChildPrepared {cell:id,operation,name,input,..}} if *id==cell=>Some((index,*operation,name,input)),_=>None,
        }).collect();
        assert_eq!(children.len(),2);
        let mut ids = HashSet::from([cell.to_string(),parent.call.clone(),format!("{}:{}",parent.attempt,parent.call)]);
        let mut child_admissions = Vec::new();
        let mut child_returns = Vec::new();
        for (prepared,operation,name,input) in children {
            assert!(ids.insert(operation.to_string()),"original child identities are distinct");
            assert!(matches!(name.as_str(),"left"|"right"));
            let input: Value = decode(&f,first.run,input).await;
            assert_eq!(input,if name=="left" {json!({"value":21})} else {json!({"value":42})});
            let admissions: Vec<_> = records.iter().enumerate().filter_map(|(index,record)| matches!(&record.fact,
                Fact::Cell {event:CellEvent::ChildAdmitted {cell:id,operation:child}} if *id==cell && *child==operation).then_some(index)).collect();
            assert_eq!(admissions.len(),1);
            let t1 = admissions[0];
            let returned: Vec<_> = records.iter().enumerate().filter_map(|(index,record)| match &record.fact {
                Fact::Cell {event:CellEvent::ChildResultRecorded {cell:id,operation:child,result,is_error:false}} if *id==cell && *child==operation=>Some((index,result)),_=>None,
            }).collect();
            assert_eq!(returned.len(),1);
            let (t2,result) = returned[0];
            let returned: ToolReturn<CellReturnedResult> = decode(&f,first.run,result).await;
            returned.validate().unwrap();
            assert!(!returned.body.is_error);
            let ToolOutput::Operation(reply) = returned.body.output else {panic!("actual Host mutation receipt")};
            assert!(records.iter().any(|record| matches!(&record.fact,
                Fact::Cell {event:CellEvent::ChildBound {cell:id,operation:child,reference}} if *id==cell && *child==operation && reference==&reply.reference)));
            assert!(records.iter().any(|record| matches!(&record.fact,
                Fact::Cell {event:CellEvent::ChildObserved {cell:id,operation:child,reply:actual}} if *id==cell && *child==operation && actual==reply.as_ref())));
            let Receipt::Recorded {outcome:OperationOutcome::Returned {result:OperationResult::Success {value}},cleanup:OperationCleanup::Confirmed} = &reply.receipt else {panic!("known business success and actual cleanup")};
            assert_eq!(*value,input);
            assert!(parent_t1<cell_t1 && cell_t1<prepared && prepared<t1 && t1<t2 && t2<cell_t2 && cell_t2<parent_t2);
            child_admissions.push(t1);
            child_returns.push(t2);
        }
        assert!(child_admissions.iter().all(|t1| child_returns.iter().all(|t2|t1<t2)),"both real child T1 precede either child T2");
        let next = records.iter().enumerate().filter_map(|(index,record)| matches!(&record.fact,Fact::ModelAttemptPrepared {..}).then_some(index)).nth(1).unwrap();
        assert!(parent_t2<next,"no model observes result before accepted T2");
        let cells = f.state.cells();
        let original_cell = cells.read(&session,cell).await.unwrap().unwrap();
        drop(cells);
        assert_eq!(original_cell.owner,*owner);
        assert!(matches!(original_cell.status,CellStatus::Completed {accepted:true,..}));
        assert!(original_cell.physical_cleanup_confirmed());
        let before_reopen = records;
        assert_eq!(f.state.request(first.run,step).await.unwrap(),frozen);
        f.shutdown().await.unwrap();
        assert!(effects.state.lock().unwrap().is_none());
        let effects = Effects::new(count.clone());
        let f = NativeFixture::open_with_service(directory.path(),configuration(&workspace),effects.service()).await.unwrap();
        effects.attach(&f);
        assert_eq!(stored_facts(&f.state,first.run).await,before_reopen);
        assert_eq!(f.state.request(first.run,step).await.unwrap(),frozen);
        assert_eq!(f.state.cells().read(&session,cell).await.unwrap().unwrap(),original_cell);
        let next = message(&f,&session,"question next").await;
        assert_ne!(next.run,first.run);
        assert_eq!(count.load(Ordering::SeqCst),2,"recovery must not repeat effects");
        assert_eq!(stored_facts(&f.state,first.run).await,before_reopen);
        assert_eq!(f.state.request(first.run,step).await.unwrap(),frozen);
        assert_eq!(f.state.cells().read(&session,cell).await.unwrap().unwrap(),original_cell);
        assert!(!stored_facts(&f.state,next.run).await.iter().any(|record| matches!(&record.fact,
            Fact::ToolAdmitted {..}|Fact::Cell {event:CellEvent::ChildAdmitted {..}})));
        f.shutdown().await.unwrap();
        let requests = server.await.unwrap();
        assert_eq!(requests.len(),3);
        for request in &requests {
            let functions: Vec<_> = request["tools"]
                .as_array()
                .unwrap()
                .iter()
                .map(|tool| &tool["function"])
                .collect();
            let names: HashSet<_> = functions
                .iter()
                .map(|tool| tool["name"].as_str().unwrap())
                .collect();
            assert_eq!(names, HashSet::from(["exec", "wait"]));
            let description = functions[0]["description"].as_str().unwrap();
            assert!(description.contains("left(input:"));
            assert!(description.contains("right(input:"));
            let schema = &functions[0]["parameters"];
            assert_eq!(schema["properties"]["code"]["type"], "string");
            assert!(schema["properties"].get("yield_time_ms").is_some());
            assert_eq!(schema["required"], json!(["code"]));
            assert_eq!(schema["additionalProperties"], false);
        }
        // This test owns conversation replay; system instructions have their own contract.
        let conversation = |request: &serde_json::Value| {
            request["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|message| message["role"] != "system")
                .cloned()
                .collect::<Vec<_>>()
        };
        assert_eq!(
            conversation(&requests[0]),
            vec![json!({"role":"user","content":"question first"})]
        );
        let second = conversation(&requests[1]);
        assert_eq!(
            second
                .iter()
                .filter(|message| message["role"] == "tool")
                .count(),
            1,
            "nested tool messages must remain hidden"
        );
        assert_eq!(second[1]["role"], "assistant");
        let calls = second[1]["tool_calls"].as_array().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["id"], "exec-provider");
        assert_eq!(calls[0]["function"]["name"], "exec");
        assert_eq!(
            serde_json::from_str::<Value>(calls[0]["function"]["arguments"].as_str().unwrap())
                .unwrap(),
            json!({"code":fixture::CODE})
        );
        assert_eq!(second[2]["role"], "tool");
        assert_eq!(second[2]["tool_call_id"], "exec-provider");
        assert_eq!(
            serde_json::from_str::<Value>(
                second[2]["content"]
                    .as_str()
                    .unwrap()
                    .lines()
                    .next()
                    .unwrap()
            )
            .unwrap()["result"],
            envelope
        );
        let reopened = conversation(&requests[2]);
        assert_eq!(reopened.len(), second.len() + 2);
        assert_eq!(
            &reopened[..second.len()],
            second.as_slice(),
            "past conversation input must be identical after reopening"
        );
        assert_eq!(
            reopened[second.len()],
            json!({"role":"assistant","content":"done"})
        );
        assert_eq!(
            reopened.last().unwrap(),
            &json!({"role":"user","content":"question next"})
        );
    })
    .await
    .expect("streamed Code Mode must finish; serial nested execution deadlocks the fixture");
}
