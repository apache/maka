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
    Configuration,
    contract::{BackendPreference, SendResult, WorkReadiness},
};
use maka_agent_facts::{
    artifact::ToolReturn,
    configuration::{
        CatalogMutationResult, ConnectionCatalogEntryUpdate, ConnectionVersionBasis, ModelOverride,
        Patch, UpdateCatalogConnectionInput,
    },
    durable::{
        AcceptedResult, ExecutionIdentity, Fact, RecordedFact, RunId, Terminal, ToolDecision,
    },
    interaction::{InteractionRecord, InteractionRequest},
    model::ModelPart,
    tool_call::{ToolRejection, ToolSettlement},
    tool_output::{DurableToolProjection, ReturnedToolResult},
};
use maka_agent_state::fold::RunView;
use maka_host_runtime::application::{Context, Handler, HandlerResult, HandlerValue, NativeOwner};
use maka_plugin_core::{
    contract::{Contract, Interface, Method, MethodMode, Transport},
    work::resources::Resources,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{net::TcpListener, sync::Semaphore};
use tokio_util::task::TaskTracker;

struct HeldTools {
    entered: Arc<Semaphore>,
    release: Arc<Semaphore>,
    cancelled: Arc<Semaphore>,
    active: TaskTracker,
    observed: Mutex<Vec<ExecutionIdentity>>,
    failed_scope: Arc<Mutex<Option<Arc<Resources>>>>,
    fail: bool,
}
impl HeldTools {
    fn new(fail: bool) -> Arc<Self> {
        Arc::new(Self {
            entered: Arc::new(Semaphore::new(0)),
            release: Arc::new(Semaphore::new(0)),
            cancelled: Arc::new(Semaphore::new(0)),
            active: TaskTracker::new(),
            observed: Mutex::new(Vec::new()),
            failed_scope: Arc::new(Mutex::new(None)),
            fail,
        })
    }
    fn service(self: &Arc<Self>) -> FixtureService {
        FixtureService::new(
            Contract {
                name: "fixture.HeldTools".into(),
                version: 1,
                transport: Transport::Remote,
                interface: Interface::Service {
                    methods: [
                        ("echo", MethodMode::Query),
                        ("exclusive", MethodMode::Mutation),
                    ]
                    .into_iter()
                    .map(|(name, mode)| {
                        (
                            name.into(),
                            Method {
                                mode,
                                input: json!({"type":"object"}).into(),
                                output: json!({"type":"object"}).into(),
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
impl Handler for HeldTools {
    fn call(
        &self,
        method: String,
        input: Value,
        context: Context,
    ) -> BoxFuture<'static, HandlerResult> {
        assert!(matches!(method.as_str(), "echo" | "exclusive"));
        assert_eq!(context.operation().is_some(), method == "exclusive");
        assert!(context.work_custody().is_some());
        self.observed.lock().unwrap().push(
            context
                .scope()
                .identity
                .agent()
                .expect("actual Native Agent scope")
                .clone(),
        );
        let active = self.active.token();
        let entered = self.entered.clone();
        let release = self.release.clone();
        let cancelled = self.cancelled.clone();
        let failed_scope = self.failed_scope.clone();
        let fail = self.fail;
        Box::pin(async move {
            let _active = active;
            let mut resource = context.scope().resources.reserve().unwrap();
            resource.start();
            entered.add_permits(1);
            if fail && input["n"] == 0 {
                release.acquire().await.unwrap().forget();
                *failed_scope.lock().unwrap() = Some(context.scope().resources.clone());
                resource.complete(Err("original tool cleanup failed".into()));
                return Ok(HandlerValue::Json(input));
            }
            if fail {
                context.scope().cancellation.cancelled().await;
                cancelled.add_permits(1);
            }
            release.acquire().await.unwrap().forget();
            resource.complete(Ok(()));
            Ok(HandlerValue::Json(input))
        })
    }
}
impl NativeOwner for HeldTools {
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        let active = self.active.clone();
        Box::pin(async move {
            active.close();
            active.wait().await;
            Ok(())
        })
    }
}
fn configuration(workspace: &Path, hold_first: bool) -> Configuration {
    let mut tools: Vec<_> = ["echo","exclusive"].into_iter().map(|name| json!({
        "name":name,"description":name,"method":name,
        "target":{"kind":"import","name":"fixture"},"result":"json","confirmation":"preapproved",
    })).collect();
    if hold_first {
        tools.push(
            json!({"name":"echo_pending","description":"echo awaiting consent","method":"echo",
            "target":{"kind":"import","name":"fixture"},"result":"json","confirmation":"required"}),
        );
    }
    serde_json::from_value(json!({
        "locale":"en","workspaceRoots":[{"label":"Workspace","path":workspace}],
        "permissions":{"access":"workspace_write","requestPermissions":false},"tools":tools,
    }))
    .unwrap()
}
async fn session(f: &NativeFixture, base: &str, workspace: &Path, title: &str) -> String {
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
                        ..Default::default()
                    },
                )])),
                request_body_overlay: Patch::Keep,
            },
        })
        .await
        .unwrap();
    assert!(matches!(result, CatalogMutationResult::Committed { .. }));
    f.create(
        title,
        workspace,
        Some(BackendPreference::Model {
            connection_id: model.connection_id,
            model_id: model.model_id,
            thinking_level: None,
        }),
    )
    .await
    .unwrap()
}
async fn send(f: &NativeFixture, session: &str) -> RunId {
    let SendResult::Queued { message_id, .. } = f.send(session, "run queries", None).await.unwrap()
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
            other => panic!("queued source was not delivered: {other:?}"),
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
            WorkReadiness::Unavailable => panic!("actual Run cleanup unavailable"),
        }
    }
}
async fn pending(f: &NativeFixture, session: &str, run: RunId) -> InteractionRecord {
    let mut changes = f.state.subscribe().unwrap();
    loop {
        changes.borrow_and_update();
        let page = f.state.interactions().pending(session).await.unwrap();
        assert!(page.next.is_none());
        assert!(
            page.records.len() <= 1,
            "only the selected call requires consent"
        );
        if let Some(record) = page.records.into_iter().next() {
            assert_eq!(record.execution.run_id, run);
            assert!(
                matches!(&record.request,InteractionRequest::ServiceApproval {tool_name,method,..}
                if tool_name=="echo_pending" && method=="echo")
            );
            return record;
        }
        changes.changed().await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn accepted_parallel_calls_overlap_and_preserve_every_result() {
    tokio::time::timeout(Duration::from_secs(30), async {
        const CALLS: usize = 128;
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let gates = HeldTools::new(false);
        let f = NativeFixture::open_with_service(
            directory.path(),
            configuration(&workspace, true),
            gates.service(),
        )
        .await
        .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let session = session(&f, &base, &workspace, "Parallel calls").await;
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let first = fixture::read_request(&mut socket).await;
            let names: Vec<_> = first["tools"]
                .as_array()
                .unwrap()
                .iter()
                .map(|tool| tool["function"]["name"].as_str().unwrap())
                .collect();
            assert!(names.contains(&"echo") && names.contains(&"echo_pending"));
            super::dynamic_tools::respond_tools(
                &mut socket,
                (0..CALLS)
                    .map(|n| {
                        super::dynamic_tools::call(
                            &format!("call-{n}"),
                            if n == 0 { "echo_pending" } else { "echo" },
                            json!({"n":n}),
                        )
                    })
                    .collect(),
                10,
            )
            .await;
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = fixture::read_request(&mut socket).await;
            fixture::respond(&mut socket, "done", "stop").await;
            assert!(
                tokio::time::timeout(Duration::from_millis(30), listener.accept())
                    .await
                    .is_err(),
                "exactly two model requests"
            );
            vec![first, request]
        });
        let run = send(&f, &session).await;
        let approval = pending(&f, &session, run).await;
        gates
            .entered
            .acquire_many((CALLS - 1) as u32)
            .await
            .unwrap()
            .forget();
        let records = facts(&f, run).await;
        let step = records
            .iter()
            .find_map(|record| match &record.fact {
                Fact::ModelAttemptPrepared { step, .. } => Some(*step),
                _ => None,
            })
            .unwrap();
        let request = f.state.request(run, step).await.unwrap();
        let frozen: Value =
            serde_json::from_slice(&f.state.content(run, request.request).await.unwrap()).unwrap();
        assert_eq!(frozen["itemAcceptance"], false);
        assert_eq!(
            records
                .iter()
                .filter(|record| matches!(&record.fact, Fact::ModelClosed { .. }))
                .count(),
            1,
            "a faster sibling commits the complete model acceptance"
        );
        let calls: Vec<_> = records
            .iter()
            .filter_map(|record| match &record.fact {
                Fact::ModelObserved {
                    part: ModelPart::ToolCall { call },
                    ..
                } => Some(call),
                _ => None,
            })
            .collect();
        assert_eq!(calls.len(), CALLS);
        for (n, call) in calls.into_iter().enumerate() {
            assert_eq!(call.id, format!("call-{n}"));
            assert_eq!(call.name, if n == 0 { "echo_pending" } else { "echo" });
            assert_eq!(call.input.as_json(), Some(&json!({"n":n})));
        }
        assert!(
            !records.iter().any(|record| matches!(&record.fact,
            Fact::ToolAdmitted {tool} if tool.call=="call-0")),
            "the first sibling still has no T1 while others execute"
        );
        assert_eq!(
            records
                .iter()
                .filter(|record| matches!(&record.fact, Fact::ToolAdmitted { .. }))
                .count(),
            CALLS - 1
        );
        let answer = f
            .mutation_value(
                "respond",
                json!({"sessionId":session,"requestId":approval.request_id,
            "answer":{"kind":"service_approval","decision":"allow"}}),
            )
            .await
            .unwrap();
        assert_eq!(answer["kind"], "recorded");
        assert_eq!(answer["record"]["outcome"]["decision"], "allow");
        gates.entered.acquire().await.unwrap().forget();
        let records = facts(&f, run).await;
        assert_eq!(
            records
                .iter()
                .filter(|record| matches!(&record.fact, Fact::ToolAdmitted { .. }))
                .count(),
            CALLS,
            "every entered handler already has a durable dispatch"
        );
        assert!(
            !records.iter().any(|record| matches!(
                &record.fact,
                Fact::LocalToolReturned { .. }
                    | Fact::HostToolResultRecorded { .. }
                    | Fact::ToolResultAccepted { .. }
            )),
            "all effects remain held"
        );
        assert_eq!(gates.observed.lock().unwrap().len(), CALLS);
        assert!(
            gates
                .observed
                .lock()
                .unwrap()
                .iter()
                .all(|execution| execution.run_id == run && execution.session_id == session)
        );
        gates.release.add_permits(CALLS);
        completed(&f, &session, run).await;
        let requests = server.await.unwrap();
        assert_eq!(requests.len(), 2);
        let results: Vec<_> = requests[1]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|message| message["role"] == "tool")
            .collect();
        assert_eq!(results.len(), CALLS);
        let by_id: BTreeMap<_, _> = results
            .iter()
            .map(|result| (result["tool_call_id"].as_str().unwrap(), *result))
            .collect();
        assert_eq!(by_id.len(), CALLS, "every call has one result");
        for n in 0..CALLS {
            let result = by_id[format!("call-{n}").as_str()];
            assert_eq!(
                serde_json::from_str::<Value>(result["content"].as_str().unwrap()).unwrap(),
                json!({"n":n})
            );
        }
        let records = facts(&f, run).await;
        assert_eq!(
            records
                .iter()
                .filter(|record| matches!(
                    &record.fact,
                    Fact::LocalToolReturned {
                        is_error: false,
                        settlement: ToolSettlement::Returned,
                        ..
                    }
                ))
                .count(),
            CALLS
        );
        assert_eq!(
            records
                .iter()
                .filter(|record| matches!(
                    &record.fact,
                    Fact::ToolResultAccepted {
                        outcome: AcceptedResult::Succeeded,
                        ..
                    }
                ))
                .count(),
            CALLS
        );
        f.shutdown().await.unwrap();
    })
    .await
    .expect("all accepted queries must enter before their release");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cleanup_failure_cancels_and_drains_already_running_siblings() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let directory=tempfile::tempdir().unwrap();
        let workspace=directory.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let gates=HeldTools::new(true);
        let f=NativeFixture::open_with_service(directory.path(),configuration(&workspace,false),gates.service()).await.unwrap();
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base=format!("http://{}/v1",listener.local_addr().unwrap());
        let session=session(&f,&base,&workspace,"Failed cleanup").await;
        let server=tokio::spawn(async move {
            let (mut socket,_)=listener.accept().await.unwrap();
            fixture::read_request(&mut socket).await;
            super::dynamic_tools::respond_tools(&mut socket,(0..2).map(|n|
                super::dynamic_tools::call(&format!("call-{n}"),"echo",json!({"n":n}))).collect(),10).await;
            listener
        });
        let run=send(&f,&session).await;
        gates.entered.acquire_many(2).await.unwrap().forget();
        assert_eq!(facts(&f,run).await.iter().filter(|record|matches!(&record.fact,
            Fact::ToolAdmitted {..})).count(),2,"both actual handlers own their committed T1");
        gates.release.add_permits(1);
        gates.cancelled.acquire().await.unwrap().forget();
        assert!(!gates.active.is_empty(),"cleanup failure cannot drop the actual live sibling");
        assert!(!f.app.client().snapshot().closed,"tool failure must not close its parent Application");
        assert_eq!(gates.observed.lock().unwrap().len(),2);
        assert!(gates.observed.lock().unwrap().iter().all(|execution|execution.run_id==run));
        gates.release.add_permits(1);
        gates.active.close();
        gates.active.wait().await;
        let mut changes=f.state.subscribe().unwrap();
        let records=loop {
            changes.borrow_and_update();
            let records=facts(&f,run).await;
            if records.iter().any(|record|matches!(&record.fact,
                Fact::LocalToolReturned {tool,is_error:false,settlement:ToolSettlement::Returned,..} if tool.call=="call-1")) {break records;}
            changes.changed().await.unwrap();
        };
        let settled:Vec<_>=records.iter().filter_map(|record|match &record.fact {
            Fact::LocalToolReturned {tool,result,is_error:false,settlement:ToolSettlement::Returned}=>Some((tool,result)),_=>None,
        }).collect();
        assert_eq!(settled.len(),1,"only the drained sibling has a confirmed outcome");
        let (tool,result)=settled[0];
        assert_eq!(tool.call,"call-1");
        let returned:ToolReturn<ReturnedToolResult>=serde_json::from_slice(&f.state.content(run,result.clone()).await.unwrap()).unwrap();
        returned.validate().unwrap();
        assert!(!returned.body.is_error);
        assert_eq!(returned.body.projection,DurableToolProjection::Json {value:json!({"n":1})});
        assert!(!records.iter().any(|record|matches!(&record.fact,
            Fact::LocalToolReturned {tool,..}|Fact::HostToolResultRecorded {tool,..}|Fact::ToolResultAccepted {tool,..} if tool.call=="call-0")));
        assert!(!records.iter().any(|record|matches!(&record.fact,
            Fact::StopRequested {..}|Fact::RunTerminated {terminal:Terminal::Completed,..})),"cleanup cannot invent Run Stop or completion");
        let resources=gates.failed_scope.lock().unwrap().clone().expect("actual failed original scope");
        let diagnostic=resources.finish().await.unwrap_err().to_string();
        assert!(diagnostic.contains("original tool cleanup failed"));
        let independent=f.create("Parent remains available after child cleanup failure",&workspace,None).await.unwrap();
        assert_ne!(independent,session);
        let listener=server.await.unwrap();
        assert!(tokio::time::timeout(Duration::from_millis(30),listener.accept()).await.is_err(),"failed cleanup must not dispatch another model request");
        assert!(f.app.shutdown().await.is_err(),"failed physical cleanup cannot confirm Application shutdown");
        f.config.shutdown().await.unwrap();
        assert!(f.root.shutdown().await.is_err(),"physical cleanup failure cannot confirm Root shutdown");
        eprintln!("Retained failed-cleanup Root: {}",directory.keep().display());
    }).await.expect("failed tool cleanup must cancel and drain its siblings");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn accepted_exclusive_call_rejects_siblings_in_arrival_order() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let directory=tempfile::tempdir().unwrap();
        let workspace=directory.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let gates=HeldTools::new(false);
        let f=NativeFixture::open_with_service(directory.path(),configuration(&workspace,false),gates.service()).await.unwrap();
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base=format!("http://{}/v1",listener.local_addr().unwrap());
        let session=session(&f,&base,&workspace,"Exclusive admission").await;
        let server=tokio::spawn(async move {
            let (mut socket,_)=listener.accept().await.unwrap();
            let first=fixture::read_request(&mut socket).await;
            super::dynamic_tools::respond_tools(&mut socket,vec![
                super::dynamic_tools::call("first","exclusive",json!({"n":0})),
                super::dynamic_tools::call("sibling","echo",json!({"n":1})),
            ],10).await;
            let (mut socket,_)=listener.accept().await.unwrap();
            let request=fixture::read_request(&mut socket).await;
            fixture::respond(&mut socket,"done","stop").await;
            assert!(tokio::time::timeout(Duration::from_millis(30),listener.accept()).await.is_err(),"exactly two model requests");
            vec![first,request]
        });
        let run=send(&f,&session).await;
        gates.entered.acquire().await.unwrap().forget();
        gates.release.add_permits(2);
        completed(&f,&session,run).await;
        let requests=server.await.unwrap();
        assert_eq!(requests.len(),2);
        let results:Vec<_>=requests[1]["messages"].as_array().unwrap().iter().filter(|message|message["role"]=="tool").collect();
        assert_eq!(results.len(),2);
        let first=results.iter().find(|result|result["tool_call_id"]=="first").unwrap();
        let sibling=results.iter().find(|result|result["tool_call_id"]=="sibling").unwrap();
        assert_eq!(serde_json::from_str::<Value>(first["content"].as_str().unwrap()).unwrap(),json!({"n":0}));
        assert!(sibling["content"].as_str().unwrap().contains(&ToolRejection::ExclusiveConflict.to_string()));
        assert_eq!(gates.entered.available_permits(),0,"only the first call entered its handler");
        assert_eq!(gates.observed.lock().unwrap().len(),1);
        assert_eq!(gates.observed.lock().unwrap()[0].run_id,run);
        let records=facts(&f,run).await;
        assert_eq!(records.iter().filter(|record|matches!(&record.fact,Fact::ToolAdmitted {..})).count(),1);
        assert!(!records.iter().any(|record|matches!(&record.fact,Fact::ToolAdmitted {tool} if tool.call=="sibling")));
        assert!(records.iter().any(|record|matches!(&record.fact,
            Fact::ToolDecided {tool,decision:ToolDecision::Rejected {rejection:ToolRejection::ExclusiveConflict,..}}
                if tool.call=="sibling")));
        f.shutdown().await.unwrap();
    }).await.expect("exclusive admission must retain call order");
}
