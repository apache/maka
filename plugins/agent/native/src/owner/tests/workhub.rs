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

use super::*;
use maka_agent_api::workhub as hub;
use maka_agent_facts::event::Fact;

pub(super) async fn activate(fixture: &mut Fixture, install: bool) {
    activate_workers(fixture, install, false, false).await
}
pub(super) async fn activate_workers(
    fixture: &mut Fixture,
    install: bool,
    workers: bool,
    granted: bool,
) {
    activate_worker_mode(fixture, install, workers, granted).await;
}
pub(super) enum Setup {
    Coordinator,
    Worker { granted: bool },
}
impl Setup {
    pub(super) fn workers() -> Self {
        Self::Worker { granted: true }
    }
    fn state(&self) -> (bool, bool) {
        match self {
            Self::Coordinator => (false, false),
            Self::Worker { granted } => (true, *granted),
        }
    }
    pub(super) fn composition(&self, settings: &Configuration) -> (Input, Vec<Package>) {
        let (workers, _) = self.state();
        let mut provider = entry(true);
        provider.configuration = hub::configuration_schema().into();
        provider.implementation = Implementation::Native {
            implementation: hub::IMPLEMENTATION.into(),
        };
        provider.exports.insert(
            hub::EXPORT.into(),
            Export {
                contract: hub::contract(),
                availability: Availability::Required,
            },
        );
        let mut consumer = entry(false);
        consumer.imports.insert(
            hub::EXPORT.into(),
            Import {
                contract: hub::contract(),
                cardinality: Cardinality::One,
            },
        );
        if workers {
            for entry in [&mut provider, &mut consumer] {
                entry.imports.insert(
                    "worker".into(),
                    Import {
                        contract: contract(),
                        cardinality: Cardinality::One,
                    },
                );
            }
        }
        let (mut composition, mut packages) = application_input(
            settings,
            application_package("agent", provider),
            application_package("consumer", consumer),
        );
        if settings
            .tools
            .iter()
            .any(|tool| matches!(&tool.target, maka_host_runtime::application::ServiceTarget::Import { name } if name == "service") && tool.method == "execute")
        {
            assert!(
                !workers,
                "fixture process and worker providers use distinct scenarios"
            );
            service_tools::Setup::processes().install(&mut composition, &mut packages);
            composition
                .instances
                .get_mut("service")
                .unwrap()
                .configuration
                .values
                .insert("sessionKind".into(), json!("workhub"));
        }

        if workers {
            let worker = application_package("worker", entry(true));
            let mut node = composition.instances["provider"].clone();
            node.key = Uuid::from_u128(21);
            node.package = worker.application_ref().into();
            composition.instances.insert("worker".into(), node);
            packages.push(worker);
            for name in ["provider", "a", "b"] {
                composition
                    .instances
                    .get_mut(name)
                    .unwrap()
                    .bindings
                    .insert(
                        "worker".into(),
                        vec![Target::Instance {
                            path: vec!["worker".into()],
                            export: EXPORT.into(),
                        }],
                    );
            }
        }
        composition
            .instances
            .get_mut("provider")
            .unwrap()
            .configuration = NodeConfiguration {
            values: BTreeMap::from([
                ("agent".into(), serde_json::to_value(settings).unwrap()),
                (
                    "workers".into(),
                    if workers {
                        json!(["worker"])
                    } else {
                        json!([])
                    },
                ),
            ]),
            parameters: BTreeMap::new(),
        };
        for name in ["a", "b"] {
            composition
                .instances
                .get_mut(name)
                .unwrap()
                .bindings
                .insert(
                    hub::EXPORT.into(),
                    vec![Target::Instance {
                        path: vec!["provider".into()],
                        export: hub::EXPORT.into(),
                    }],
                );
        }
        (composition, packages)
    }
    pub(super) fn provide(&self, native: &mut NativeRegistry, capture: FixtureCapture) {
        crate::owner::tests::provide_without_workhub(native).unwrap();
        crate::workhub::provide_captured(
            native,
            bundled_catalog(),
            Arc::new(move |owner| {
                *capture.lock().unwrap() = Some((owner.clone(), owner.recall.services.clone()));
            }),
        )
        .unwrap();
    }
    pub(super) fn policy(&self) -> Arc<maka_transport::transport::PeerPolicy> {
        let (_, granted) = self.state();
        Arc::new(
            maka_transport::transport::PeerPolicy::with_native_grants(if granted {
                vec![maka_transport::transport::NativeGrant {
                    origin: id(1),
                    consumer: id(1),
                    provider: id(21),
                    export: EXPORT.into(),
                    methods: [
                        "list",
                        "directories",
                        "create",
                        "uploadAttachment",
                        "send",
                        "execution",
                        "execute",
                        "executors",
                        "tools",
                        "snapshotPatch",
                        "readPatch",
                        "work",
                        "observe",
                        "watch",
                        "stop",
                        "resume",
                        "queue",
                        "editQueue",
                    ]
                    .into_iter()
                    .map(str::to_owned)
                    .collect(),
                    recovery: true,
                }]
            } else {
                vec![]
            })
            .unwrap(),
        )
    }
}

async fn activate_worker_mode(
    fixture: &mut Fixture,
    install: bool,
    workers: bool,
    granted: bool,
) -> Arc<Owner> {
    let setup = if workers {
        Setup::Worker { granted }
    } else {
        Setup::Coordinator
    };
    let source = fixture.app.source().unwrap().clone();
    fixture.app.shutdown().await.unwrap();
    if install {
        let (composition, packages) = setup.composition(&fixture.owner.settings);
        fixture
            .store
            .commit_application(
                source.deployment,
                source.revision,
                composition,
                vec![],
                packages,
            )
            .await
            .unwrap();
    }
    let mut native = NativeRegistry::default();
    let captured = Arc::new(StdMutex::new(None));
    setup.provide(&mut native, captured.clone());
    maka_settings_native::provide(&mut native, bundled_catalog()).unwrap();
    fixture.app = Application::start_from_store(
        fixture.store.clone(),
        source.deployment,
        native,
        fixture.issuer.clone(),
        Arc::new(Grant(fixture.issuer.clone(), Some(setup.policy()))),
        Some(maka_host_js::factory(Default::default())),
    )
    .await
    .unwrap();
    fixture.app.ready().await.unwrap();
    let (owner, services) = captured
        .lock()
        .unwrap()
        .take()
        .expect("actual coordinator Owner");
    fixture.owner = owner.clone();
    fixture.services = services;
    owner
}
async fn binding(fixture: &Fixture) -> Binding {
    let client = fixture.app.client();
    client
        .bind(client.activation(&id(2)).unwrap(), hub::EXPORT.into())
        .await
        .unwrap()
        .remove(0)
}
async fn coordinator(fixture: &Fixture) -> Value {
    fixture
        .app
        .client()
        .start(
            binding(fixture).await,
            "coordinator".into(),
            json!({}),
            scope(&fixture.issuer, true),
            Attachments::default().into(),
        )
        .await
        .unwrap()
        .result()
        .await
        .unwrap()
}
async fn prepare(
    fixture: &Fixture,
    selection: Value,
    operation: Uuid,
) -> maka_host_runtime::application::PreparedMutation {
    fixture
        .app
        .client()
        .prepare_mutation(
            binding(fixture).await,
            "resolve".into(),
            json!({"workspace":selection}),
            scope(&fixture.issuer, true),
            operation,
            Attachments::default().into(),
        )
        .await
        .unwrap()
}
pub(super) async fn resolve(fixture: &Fixture, selection: Value, operation: Uuid) -> Value {
    let prepared = prepare(fixture, selection, operation).await;
    let recorded = fixture
        .store
        .record_application_intent(
            prepared.reference().source.clone(),
            prepared.consumer().instance().clone(),
            prepared.reference().clone(),
            Value::Null,
        )
        .await
        .unwrap();
    let reply = fixture
        .app
        .client()
        .mutate(prepared, recorded)
        .await
        .unwrap()
        .result()
        .await;
    match reply.receipt {
        Receipt::Recorded {
            outcome: OperationOutcome::Returned { value },
            cleanup: maka_plugin_core::operation::OperationCleanup::Confirmed,
        } => value,
        other => panic!("unexpected coordinator receipt {other:?}"),
    }
}
pub(super) async fn selection(fixture: &Fixture) -> Value {
    fixture
        .query("directories", json!({"kind":"roots"}))
        .await
        .unwrap()["roots"][0]["selection"]
        .clone()
}

#[tokio::test]
async fn workhub_concurrent_resolution_reactivation_and_old_agent_namespace() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let mut fixture = Fixture::new("http://127.0.0.1:1/v1", None).await;
        let old = fixture.create("ordinary Agent").await;
        activate(&mut fixture, true).await;
        assert_eq!(coordinator(&fixture).await, json!({"kind":"missing"}));
        assert!(
            fixture
                .query("observe", json!({"sessionId":old}))
                .await
                .is_err()
        );
        let selected = selection(&fixture).await;
        let op = Uuid::new_v4();
        let (a, b) = tokio::join!(
            resolve(&fixture, selected.clone(), op),
            resolve(&fixture, selected.clone(), Uuid::new_v4())
        );
        assert_eq!(a, b);
        assert_eq!(a["kind"], "ready");
        assert_ne!(a["session"]["id"], old);
        assert_eq!(resolve(&fixture, selected.clone(), op).await, a);
        assert_eq!(coordinator(&fixture).await, a);
        activate(&mut fixture, false).await;
        // Resolving an accepted original coordinator never revalidates a later path.
        std::fs::rename(&fixture.workspace, fixture.workspace.with_extension("gone")).unwrap();
        assert_eq!(resolve(&fixture, selected, Uuid::new_v4()).await, a);
        assert_eq!(coordinator(&fixture).await, a);
        let page = fixture
            .query("list", json!({"filter":"all","position":{"kind":"start"}}))
            .await
            .unwrap();
        assert_eq!(page["sessions"].as_array().unwrap().len(), 1);
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

async fn imported(fixture: &Fixture, import: &str) -> Binding {
    let client = fixture.app.client();
    client
        .bind(client.activation(&id(2)).unwrap(), import.into())
        .await
        .unwrap()
        .remove(0)
}
async fn query_import(fixture: &Fixture, import: &str, method: &str, input: Value) -> Value {
    fixture
        .app
        .client()
        .start(
            imported(fixture, import).await,
            method.into(),
            input.clone(),
            scope(&fixture.issuer, true),
            Attachments::default().into(),
        )
        .await
        .unwrap_or_else(|error| panic!("start {import}.{method}({input}) failed: {error:?}"))
        .result()
        .await
        .unwrap_or_else(|error| panic!("query {import}.{method}({input}) failed: {error:?}"))
}
async fn worker_mutation(fixture: &Fixture, method: &str, input: Value) -> Value {
    let client = fixture.app.client();
    let prepared = client
        .prepare_mutation(
            imported(fixture, "worker").await,
            method.into(),
            input,
            scope(&fixture.issuer, true),
            Uuid::new_v4(),
            Attachments::default().into(),
        )
        .await
        .unwrap();
    let recorded = fixture
        .store
        .record_application_intent(
            prepared.reference().source.clone(),
            prepared.consumer().instance().clone(),
            prepared.reference().clone(),
            Value::Null,
        )
        .await
        .unwrap();
    let reply = client
        .mutate(prepared, recorded)
        .await
        .unwrap()
        .result()
        .await;
    let Receipt::Recorded {
        outcome: OperationOutcome::Returned { value },
        ..
    } = reply.receipt
    else {
        panic!("{reply:?}")
    };
    value
}
async fn worker_session(fixture: &Fixture) -> String {
    let roots = query_import(fixture, "worker", "directories", json!({"kind":"roots"})).await;
    worker_mutation(fixture,"create",json!({"title":"Worker","labels":[],"workspace":{"kind":"directory","selection":roots["roots"][0]["selection"]}})).await["session"]["id"].as_str().unwrap().into()
}
async fn task_response(socket: &mut TcpStream, input: Value) {
    let input = json!({"request": input});
    let delta = json!({"id":"task-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":Uuid::new_v4().to_string(),"type":"function","function":{"name":"workhub_tasks","arguments":input.to_string()}}]},"finish_reason":null}]});
    let body = format!(
        "data: {delta}\n\ndata: {{\"id\":\"task-model\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"tool_calls\"}}]}}\n\ndata: [DONE]\n\n"
    );
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
}
async fn first_task(fixture: &Fixture) -> String {
    loop {
        let tasks = query_import(fixture, hub::EXPORT, "tasks", json!({})).await;
        if let Some(id) = tasks["entries"][0]["taskId"].as_str() {
            return id.into();
        }
        tokio::task::yield_now().await;
    }
}
async fn idle(fixture: &Fixture, import: &str, session: &str) {
    loop {
        let observation =
            query_import(fixture, import, "observe", json!({"sessionId":session})).await;
        if observation["run"].is_null() {
            return;
        }
        tokio::task::yield_now().await;
    }
}

#[tokio::test]
async fn workhub_routes_selected_worker_and_delivers_actual_result() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Fixture::workhub(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            Setup::workers(),
        )
        .await;
        let worker = worker_session(&fixture).await;
        let ready = resolve(&fixture, selection(&fixture).await, Uuid::new_v4()).await;
        let coordinator = ready["session"]["id"].as_str().unwrap();
        fixture.send(coordinator).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        task_response(
            &mut socket,
            json!({
                "operation":"route", "worker":"worker",
                "target":{"kind":"existing","sessionId":worker},
                "note":"Process this assigned work", "model":fixture.selection().await
            }),
        )
        .await;
        let mut worker_calls = 0;
        for _ in 0..3 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let input = request(&mut socket).await;
            if !is_coordinator(&input) {
                worker_calls += 1;
                assert!(
                    input["messages"]
                        .to_string()
                        .contains("Process this assigned work")
                );
                assert!(input["messages"].to_string().contains("Hello"));
            }
            response(&mut socket).await;
        }
        idle(&fixture, EXPORT, coordinator).await;
        idle(&fixture, "worker", &worker).await;
        assert_eq!(worker_calls, 1);
        let task_id = first_task(&fixture).await;
        let task = query_import(&fixture, hub::EXPORT, "task", json!({"taskId":task_id})).await;
        assert_eq!(task["title"], "Hello");
        assert_eq!(
            task["status"]["progress"]["execution"]["state"],
            "completed"
        );
        assert_eq!(
            task["status"]["progress"]["answer"]["text"],
            "Elegant response"
        );
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn workhub_selected_worker_requires_independent_native_dispatch_grant() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut fixture = Fixture::workhub(&format!("http://{}/v1",listener.local_addr().unwrap()), Setup::Worker { granted: false }).await;
        let worker=worker_session(&fixture).await;
        let ready=resolve(&fixture,selection(&fixture).await,Uuid::new_v4()).await;
        let coordinator=ready["session"]["id"].as_str().unwrap().to_owned();
        fixture.send(&coordinator).await.unwrap();
        let (mut socket,_)=listener.accept().await.unwrap();request(&mut socket).await;
        task_response(&mut socket,json!({"operation":"route","worker":"worker","target":{"kind":"existing","sessionId":worker},"note":"Denied assignment","model":fixture.selection().await})).await;
        let (mut socket,_)=listener.accept().await.unwrap();
        let next=request(&mut socket).await;assert!(!next["messages"].to_string().contains("Original user request:"));response(&mut socket).await;
        idle(&fixture,EXPORT,&coordinator).await;
        let task_id=first_task(&fixture).await;
        let task=query_import(&fixture,hub::EXPORT,"task",json!({"taskId":task_id})).await;
        assert_eq!(task["status"]["kind"],"pending");
        let worker_view=query_import(&fixture,"worker","observe",json!({"sessionId":worker})).await;
        assert!(worker_view["run"].is_null());
        assert!(fixture.store.application_intents(fixture.app.source().unwrap().deployment,id(1),0,128).await.unwrap().is_empty());
        assert!(tokio::time::timeout(Duration::from_millis(30),listener.accept()).await.is_err());
        // The durable assignment precedes dispatch. New grants and activation cannot
        // convert that old intent into a fresh call on a replacement binding.
        activate_workers(&mut fixture,false,true,true).await;
        fixture.send(&coordinator).await.unwrap();
        let (mut socket,_)=listener.accept().await.unwrap();request(&mut socket).await;
        task_response(&mut socket,json!({"operation":"advance","taskId":task_id})).await;
        let (mut socket,_)=listener.accept().await.unwrap();let input=request(&mut socket).await;
        assert!(input["messages"].to_string().contains("unavailable"));
        assert!(!input["messages"].to_string().contains("Original user request:"));response(&mut socket).await;
        idle(&fixture,EXPORT,&coordinator).await;
        assert!(fixture.store.application_intents(fixture.app.source().unwrap().deployment,id(1),0,128).await.unwrap().is_empty());
        fixture.app.shutdown().await.unwrap();fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

fn is_coordinator(input: &Value) -> bool {
    input["messages"].as_array().unwrap().iter().any(|message| {
        message["role"] == "system"
            && message["content"]
                .as_str()
                .unwrap_or_default()
                .contains("WorkHub coordinator")
    })
}
fn tool_value(input: &Value) -> Value {
    let message = input["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|message| message["role"] == "tool")
        .unwrap();
    serde_json::from_str(message["content"].as_str().unwrap())
        .unwrap_or_else(|error| panic!("{error}: {}", message["content"]))
}
fn is_worker_notice(input: &Value) -> bool {
    input["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|message| message["role"] == "user")
        .is_some_and(|message| {
            message["content"]
                .to_string()
                .contains("Original worker observation:")
        })
}
// A completion can arrive between explicit coordinator turns. Consume that
// independent real model request before scripting the next user-triggered tool.
async fn coordinator_request(listener: &TcpListener) -> (TcpStream, Value) {
    loop {
        let (mut socket, _) = listener.accept().await.unwrap();
        // Host retirement can close a connected transport before it writes an
        // HTTP request. Once any byte exists, the original parser stays strict.
        if socket.peek(&mut [0; 1]).await.unwrap() == 0 {
            continue;
        }
        let input = request(&mut socket).await;
        assert!(is_coordinator(&input), "unexpected model request: {input}");
        if is_worker_notice(&input) {
            response(&mut socket).await;
        } else {
            return (socket, input);
        }
    }
}
async fn control_turn(
    fixture: &Fixture,
    listener: &TcpListener,
    coordinator: &str,
    input: Value,
) -> Value {
    fixture.send(coordinator).await.unwrap();
    let (mut socket, _) = coordinator_request(listener).await;
    task_response(&mut socket, input).await;
    let (mut socket, next) = coordinator_request(listener).await;
    let result = tool_value(&next);
    response(&mut socket).await;
    idle(fixture, EXPORT, coordinator).await;
    result
}
async fn active_task(
    fixture: &Fixture,
    listener: &TcpListener,
    worker: &str,
) -> (String, String, TcpStream) {
    let ready = resolve(fixture, selection(fixture).await, Uuid::new_v4()).await;
    let coordinator = ready["session"]["id"].as_str().unwrap().to_owned();
    fixture.send(&coordinator).await.unwrap();
    let (mut socket, _) = listener.accept().await.unwrap();
    request(&mut socket).await;
    task_response(&mut socket,json!({"operation":"route","worker":"worker","target":{"kind":"existing","sessionId":worker},"note":"Original assigned work","model":fixture.selection().await})).await;
    let mut running = None;
    for _ in 0..2 {
        let (mut socket, _) = listener.accept().await.unwrap();
        let input = request(&mut socket).await;
        if is_coordinator(&input) {
            response(&mut socket).await;
        } else {
            running = Some(socket);
        }
    }
    idle(fixture, EXPORT, &coordinator).await;
    (coordinator, first_task(fixture).await, running.unwrap())
}
#[tokio::test]
async fn workhub_control_stops_and_resumes_the_selected_worker_without_retargeting() {
    tokio::time::timeout(Duration::from_secs(60), async {
            let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
            let mut fixture = Fixture::workhub(&format!("http://{}/v1",listener.local_addr().unwrap()), Setup::workers()).await;
            let worker=worker_session(&fixture).await;
            let (coordinator,task_id,running)=active_task(&fixture,&listener,&worker).await;
            let original=query_import(&fixture,hub::EXPORT,"task",json!({"taskId":task_id})).await;
            let stopped=control_turn(&fixture,&listener,&coordinator,json!({"operation":"control","taskId":task_id,"action":{"kind":"stop"}})).await;
            assert_eq!(stopped["status"]["kind"],"returned");
            assert_eq!(stopped["status"]["outcome"]["kind"],"stop");
            assert_eq!(stopped["status"]["outcome"]["result"]["requested"],true);
            drop(running);idle(&fixture,"worker",&worker).await;
            assert_eq!(query_import(&fixture,hub::EXPORT,"task",json!({"taskId":task_id})).await["status"]["progress"]["execution"]["state"],"cancelled");
            fixture.send(&coordinator).await.unwrap();
            let (mut socket,_)=coordinator_request(&listener).await;
            task_response(&mut socket,json!({"operation":"control","taskId":task_id,"action":{"kind":"resume","model":fixture.selection().await}})).await;
            let mut resumed=None;let mut worker_calls=0;
            for _ in 0..2 {
                let (mut socket,_)=listener.accept().await.unwrap();let input=request(&mut socket).await;
                if is_coordinator(&input) {resumed=Some(tool_value(&input));response(&mut socket).await;}
                else {assert!(input["messages"].to_string().contains("Original assigned work"));worker_calls+=1;response_with_text(&mut socket,"Resumed worker result").await;}
            }
            assert_eq!(worker_calls,1);idle(&fixture,EXPORT,&coordinator).await;idle(&fixture,"worker",&worker).await;
            let resumed=resumed.unwrap();assert_eq!(resumed["status"]["kind"],"returned");
            let completed=control_turn(&fixture,&listener,&coordinator,json!({"operation":"inspect","taskId":task_id})).await;
            assert_eq!(completed["status"]["invocationId"],original["status"]["invocationId"]);
            assert_ne!(completed["status"]["progress"]["execution"]["invocationId"],original["status"]["invocationId"]);
            assert_eq!(completed["status"]["progress"]["answer"]["text"],"Resumed worker result");
            let controls=query_import(&fixture,hub::EXPORT,"controls",json!({})).await;
            assert_eq!(controls["entries"].as_array().unwrap().len(),2);
            // New work must not become the target of an old stop's recovery.
            let later=worker_mutation(&fixture,"send",json!({"sessionId":worker,"message":"Later unrelated work","model":fixture.selection().await})).await;
            // The completed resumed task can notify its coordinator before this
            // unrelated worker request reaches the shared model listener.
            let mut later_socket=loop {
                let (mut socket,_)=listener.accept().await.unwrap();
                let input=request(&mut socket).await;
                if is_coordinator(&input) {
                    assert!(input["messages"].as_array().unwrap().iter().rev().find(|message| message["role"] == "user").unwrap()["content"].to_string().contains("Original worker observation:"));
                    response(&mut socket).await;
                } else {
                    assert_eq!(input["messages"].as_array().unwrap().last().unwrap()["content"],"Later unrelated work");
                    break socket;
                }
            };
            assert_eq!(control_turn(&fixture,&listener,&coordinator,json!({"operation":"advance_control","controlId":stopped["controlId"]})).await,stopped);
            let view=query_import(&fixture,"worker","observe",json!({"sessionId":worker})).await;
            assert_eq!(view["run"]["invocationId"],later["invocationId"]);
            response(&mut later_socket).await;idle(&fixture,"worker",&worker).await;
            activate_workers(&mut fixture,true,true,true).await;
            assert_eq!(query_import(&fixture,hub::EXPORT,"control",json!({"controlId":resumed["controlId"]})).await,resumed);
            assert_eq!(control_turn(&fixture,&listener,&coordinator,json!({"operation":"advance_control","controlId":resumed["controlId"]})).await,resumed);
            assert!(tokio::time::timeout(Duration::from_millis(30),listener.accept()).await.is_err());
            fixture.app.shutdown().await.unwrap();fixture.config.shutdown().await.unwrap();
        }).await.unwrap();
}
#[tokio::test]
async fn workhub_creates_selected_worker_and_transfers_original_attachment_bytes_before_send() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut fixture = Fixture::workhub(&format!("http://{}/v1",listener.local_addr().unwrap()), Setup::workers()).await;
        let ready=resolve(&fixture,selection(&fixture).await,Uuid::new_v4()).await;
        let coordinator=ready["session"]["id"].as_str().unwrap().to_owned();
        let directories=control_turn(&fixture,&listener,&coordinator,json!({"operation":"directories","worker":"worker","location":{"kind":"roots"}})).await;
        let directory=directories["roots"][0]["selection"].clone();
        assert!(directory.is_object());
        let files: Vec<_> = (0..9).map(|index| (format!("transfer-{index}.txt"), if index == 0 { "original user attachment\n中\0".repeat(6000).into_bytes() } else { format!("original user attachment {index}\n中\0tail-{index}").into_bytes() })).collect();
        let mut sources=Vec::new();
        for (name,bytes) in &files {
            let uploaded=attachments::upload(&fixture,&coordinator,name,bytes,Uuid::new_v4()).await.unwrap();
            sources.push(uploaded["attachment"]["id"].as_str().unwrap().to_owned());
        }
        fixture.mutation(2,"send",json!({"sessionId":coordinator,"message":"Use my attached file","attachments":sources,"model":fixture.selection().await}),Uuid::new_v4()).await.unwrap();
        let (mut socket,_)=listener.accept().await.unwrap();request(&mut socket).await;
        task_response(&mut socket,json!({"operation":"route","worker":"worker","target":{"kind":"new","title":"New assigned worker","workspace":directory},"note":"Check the original file","model":fixture.selection().await})).await;
        let mut dispatched=None;
        let mut worker_calls=0;
        for _ in 0..2 {
            let (mut socket,_)=listener.accept().await.unwrap();let input=request(&mut socket).await;
            if is_coordinator(&input) {dispatched=Some(tool_value(&input));} else {
                worker_calls+=1;
                assert!(input["messages"].to_string().contains("Use my attached file"));
                for source in &sources { assert!(!input["messages"].to_string().contains(source),"foreign artifact IDs must never be forwarded as worker authority"); }
            }
            response(&mut socket).await;
        }
        assert_eq!(worker_calls,1);
        let task=dispatched.unwrap();assert_eq!(task["status"]["kind"],"started");
        assert_eq!(query_import(&fixture,hub::EXPORT,"tasks",json!({})).await["entries"][0]["title"],"New assigned worker");
        let worker=task["status"]["sessionId"].as_str().unwrap();
        idle(&fixture,EXPORT,&coordinator).await;idle(&fixture,"worker",worker).await;
        let artifacts=fixture.session(worker).await.list_artifacts(worker,0,10).await.unwrap();assert_eq!(artifacts.records.len(),9);
        for ((name,bytes),source) in files.iter().zip(&sources) {
            let copied=artifacts.records.iter().find(|record|record.name==*name).unwrap();
            assert_ne!(&copied.id,source);
            assert_eq!(copied.session_id,worker);
            assert_eq!(copied.size_bytes,bytes.len() as u64);
            assert_eq!(copied.summary.as_deref(),Some(maka_agent_facts::artifact::content_digest(bytes).as_str()));
            assert!(fixture.session(worker).await.read_artifact_chunk(worker,&copied.id,0,bytes.len()).await.unwrap().unwrap().bytes==*bytes,"original transfer bytes differ: {name}");
        }
        let through=fixture.through(worker).await;
        let events=fixture.session(worker).await.session_events(worker,0,through,512,usize::MAX).await.unwrap();
        let received=events.events.iter().find_map(|stored|match &stored.event.fact {
            Fact::InvocationOpened {input:maka_agent_facts::event::InvocationInput::Message {content,..},..}=>content.attachments.as_ref(),
            _=>None,
        }).unwrap();
        assert_eq!(received.len(),9);
        for (attachment,(name,bytes)) in received.iter().zip(&files) {
            assert_eq!(&attachment.name,name);
            assert_eq!(attachment.bytes,bytes.len() as u64);
            let copied=artifacts.records.iter().find(|record|record.name==*name).unwrap();
            assert_eq!(attachment.storage_ref,maka_agent_facts::attachment::StorageRef::SessionFile {session_id:worker.into(),relative_path:copied.id.clone()});
        }
        let records=fixture.store.application_intents(fixture.app.source().unwrap().deployment,id(1),0,128).await.unwrap();
        let methods:Vec<_>=std::iter::once("create").chain(std::iter::repeat_n("uploadAttachment",9)).chain(std::iter::once("send")).collect();
        assert_eq!(records.iter().map(|row|row.reference.method.as_str()).collect::<Vec<_>>(),methods);
        assert_eq!(query_import(&fixture,"worker","list",json!({"filter":"all","position":{"kind":"start"}})).await["sessions"].as_array().unwrap().len(),1);
        let replay=control_turn(&fixture,&listener,&coordinator,json!({"operation":"advance","taskId":task["taskId"]})).await;
        assert_eq!(replay["status"]["invocationId"],task["status"]["invocationId"]);
        assert_eq!(fixture.session(worker).await.list_artifacts(worker,0,10).await.unwrap().records.len(),9);
        while let Ok(accepted)=tokio::time::timeout(Duration::from_millis(30),listener.accept()).await {
            let (mut socket,_)=accepted.unwrap();let input=request(&mut socket).await;
            assert!(is_coordinator(&input)&&is_worker_notice(&input),"advance redispatched work instead of receiving the original completion notice: {input}");
            response(&mut socket).await;
            idle(&fixture,EXPORT,&coordinator).await;
        }
        activate_workers(&mut fixture,false,true,true).await;
        let restored=query_import(&fixture,hub::EXPORT,"task",json!({"taskId":task["taskId"]})).await;
        assert_eq!(restored["status"]["sessionId"],worker);assert_eq!(restored["status"]["invocationId"],task["status"]["invocationId"]);
        assert_eq!(restored["status"]["progress"]["answer"]["text"],"Elegant response");
        assert_eq!(fixture.store.application_intents(fixture.app.source().unwrap().deployment,id(1),0,128).await.unwrap().len(),11);
        fixture.app.shutdown().await.unwrap();fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn workhub_dependencies_wait_cancel_and_dispatch_once_with_complete_original_answers() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut fixture = Fixture::workhub(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            Setup::workers(),
        )
        .await;
        let worker = worker_session(&fixture).await;
        let (coordinator, parent, mut running) = active_task(&fixture, &listener, &worker).await;
        let directory = query_import(&fixture, "worker", "directories", json!({"kind":"roots"}))
            .await["roots"][0]["selection"]
            .clone();
        let route = |title: &str, model: ModelSelection| {
            json!({"operation":"route","worker":"worker",
            "target":{"kind":"new","title":title,"workspace":directory,"tools":[]},
            "dependencies":[parent],"note":"Use the completed dependency", "model":model})
        };
        let cancelled = control_turn(
            &fixture,
            &listener,
            &coordinator,
            route("Never start", fixture.selection().await),
        )
        .await;
        let downstream = control_turn(
            &fixture,
            &listener,
            &coordinator,
            route("After evidence", fixture.selection().await),
        )
        .await;
        assert_eq!(cancelled["status"]["kind"], "blocked");
        assert_eq!(downstream["status"]["kind"], "blocked");
        assert_eq!(downstream["dependencies"], json!([parent]));
        assert_eq!(
            query_import(
                &fixture,
                "worker",
                "list",
                json!({"filter":"all","position":{"kind":"start"}})
            )
            .await["sessions"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let result = control_turn(
            &fixture,
            &listener,
            &coordinator,
            json!({"operation":"cancel_pending","taskId":cancelled["taskId"]}),
        )
        .await;
        assert_eq!(result["kind"], "cancelled");
        let evidence = "Complete original evidence. 中文 ".repeat(90);
        response_with_text(&mut running, &evidence).await;
        let child = loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let input = request(&mut socket).await;
            if is_coordinator(&input) {
                response(&mut socket).await;
                continue;
            }
            let messages = input["messages"].as_array().unwrap();
            assert!(
                messages.iter().any(|message| message["content"]
                    .as_str()
                    .is_some_and(|text| text.contains(&evidence))),
                "dependency pagination must deliver the complete final answer"
            );
            assert!(input["tools"].is_null() || input["tools"].as_array().unwrap().is_empty());
            let observed = query_import(
                &fixture,
                hub::EXPORT,
                "task",
                json!({"taskId":downstream["taskId"]}),
            )
            .await;
            response_with_text(&mut socket, "Dependent work completed").await;
            break observed;
        };
        let child_session = child["status"]["sessionId"].as_str().unwrap();
        idle(&fixture, "worker", child_session).await;
        assert_eq!(
            query_import(
                &fixture,
                hub::EXPORT,
                "task",
                json!({"taskId":cancelled["taskId"]})
            )
            .await["status"]["kind"],
            "cancelled"
        );
        activate_workers(&mut fixture, false, true, true).await;
        let restored = query_import(
            &fixture,
            hub::EXPORT,
            "task",
            json!({"taskId":downstream["taskId"]}),
        )
        .await;
        assert_eq!(
            restored["status"]["invocationId"],
            child["status"]["invocationId"]
        );
        assert_eq!(
            restored["status"]["progress"]["execution"]["state"],
            "completed"
        );
        assert_eq!(
            query_import(
                &fixture,
                hub::EXPORT,
                "task",
                json!({"taskId":cancelled["taskId"]})
            )
            .await["status"]["kind"],
            "cancelled"
        );
        let intents = fixture
            .store
            .application_intents(fixture.app.source().unwrap().deployment, id(1), 0, 128)
            .await
            .unwrap();
        assert_eq!(
            intents
                .iter()
                .filter(|intent| intent.reference.method == "send")
                .count(),
            2
        );
        assert_eq!(
            intents
                .iter()
                .filter(|intent| intent.reference.method == "create")
                .count(),
            1
        );
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

mod graph_tests;
