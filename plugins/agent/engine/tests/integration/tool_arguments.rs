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
    agent_loop::respond,
    canonical::{self, NoEffects, admitted_model, append},
    http::read_request,
    native::{FixtureService, NativeFixture},
};
use futures_util::{SinkExt, StreamExt, future::BoxFuture};
use maka_agent_api::{
    Configuration, ModelSelection,
    contract::{BackendPreference, SendResult},
};
use maka_agent_engine::{DriverExit, Engine};
use maka_agent_facts::{
    cells::{CellId, CellOwner},
    configuration::{
        CatalogMutationResult, ConnectionCatalogEntryUpdate, ConnectionCredentialTarget,
        ConnectionVersionBasis, ModelOverride, Patch, UpdateCatalogConnectionInput,
    },
    durable::*,
    execution::ToolMode,
    model::{ModelPart, ModelToolCall, ToolInput},
    tool_call::ToolRejection,
    tool_output::AcceptedToolResult,
};
use maka_agent_state::{Admission, Change, Store, queue::MessageResolution};
use maka_host_runtime::application::{Context, Handler, HandlerResult, HandlerValue, NativeOwner};
use maka_plugin_core::{
    composition::InstanceId,
    contract::{Contract, Interface, Method, MethodMode, Transport},
    operation::OperationCleanup,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tokio::{
    io::AsyncWriteExt,
    net::{TcpListener, TcpStream},
};
use tokio_tungstenite::{accept_async, tungstenite::Message as Frame};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const RAW: &str = "{\"n\":";

struct Echo {
    run: Arc<OnceLock<(Store, RunId)>>,
    inputs: Arc<Mutex<Vec<Value>>>,
    mode: ToolMode,
}
impl Handler for Echo {
    fn call(
        &self,
        method: String,
        input: Value,
        context: Context,
    ) -> BoxFuture<'static, HandlerResult> {
        assert_eq!(method, "echo");
        assert!(context.operation().is_some());
        let run = self.run.clone();
        let inputs = self.inputs.clone();
        let mode = self.mode;
        Box::pin(async move {
            let (state, run) = run
                .get()
                .expect("bind the actual Run before releasing provider output");
            let view = state.frontier(*run).await.unwrap();
            let tool = view
                .tools
                .values()
                .find(|tool| tool.key.call == "corrected-call")
                .expect("the corrected complete call must precede Echo");
            assert!(
                tool.admitted,
                "Agent T1 must precede the actual service effect"
            );
            assert_ne!(tool.key.call, "malformed-call");
            if mode == ToolMode::CodeMode {
                let link = AgentStepLink {
                    run: *run,
                    step: view.attempts[&tool.key.attempt].step,
                    attempt: tool.key.attempt,
                };
                let cell = state
                    .cells()
                    .read(
                        &view.spec.session_id,
                        CellId::for_agent(link, &tool.key.call),
                    )
                    .await
                    .unwrap()
                    .unwrap();
                assert!(
                    matches!(cell.owner, CellOwner::Agent { link: source, .. } if source == link)
                );
                assert!(
                    cell.children
                        .values()
                        .any(|child| child.name == "echo" && child.admitted),
                    "the real Cell child's T1 must precede nested Echo"
                );
            }
            assert_eq!(input, json!({"n":7}));
            inputs.lock().unwrap().push(input.clone());
            Ok(HandlerValue::Json(input))
        })
    }
}
impl NativeOwner for Echo {
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}
fn service(
    run: Arc<OnceLock<(Store, RunId)>>,
    inputs: Arc<Mutex<Vec<Value>>>,
    mode: ToolMode,
) -> FixtureService {
    FixtureService::new(
        Contract {
            name: "fixture.Echo".into(),
            version: 1,
            transport: Transport::Remote,
            interface: Interface::Service {
                methods: BTreeMap::from([(
                    "echo".into(),
                    Method {
                        mode: MethodMode::Mutation,
                        input: json!({"type":"object"}).into(),
                        output: json!({"type":"object"}).into(),
                        resources: BTreeMap::new(),
                        progress: None,
                    },
                )]),
            },
        },
        Arc::new(Echo { run, inputs, mode }),
    )
}
fn configuration(workspace: &Path) -> Configuration {
    serde_json::from_value(json!({
        "locale":"en", "workspaceRoots":[{"label":"Workspace","path":workspace}],
        "permissions":{"access":"workspace_write","requestPermissions":false},
        "tools":[{
            "name":"echo","description":"echo","method":"echo","nestable":true,
            "target":{"kind":"import","name":"fixture"},"result":"json","confirmation":"preapproved",
        }],
    })).unwrap()
}
fn backend(model: &ModelSelection) -> BackendPreference {
    BackendPreference::Model {
        connection_id: model.connection_id.clone(),
        model_id: model.model_id.clone(),
        thinking_level: None,
    }
}
async fn model(f: &NativeFixture, base: &str, mode: ToolMode, responses: bool) -> ModelSelection {
    let model = if responses {
        let provider = json!({"packageId":maka_providers::api::ID,"entryId":maka_providers::api::ID,
            "scope":"profile","name":"openai-responses-compatible"});
        let catalog = f.config.catalog().await.unwrap();
        let CatalogMutationResult::Committed { connection: Some(basis), .. } =
            f.config.create_connection(serde_json::from_value(json!({
                "expectedCatalogRevision":catalog.revision,
                "connection":{"slug":"responses","name":"Responses","provider":provider,
                    "configuration":{"baseUrl":base},"enabled":true,"enabledModelIds":["gpt-4.1"]},
            })).unwrap()).await.unwrap() else { panic!("commit real Responses connection") };
        let maka_config::oauth::enrollment::LoginPreparation::Ready(ticket) = f
            .config
            .prepare_oauth_login(maka_agent_facts::oauth::LoginStart {
                expected_credential: None,
                attempt_id: Uuid::new_v4().to_string(),
                target: maka_agent_facts::oauth::Target::Existing {
                    expected: ConnectionCredentialTarget {
                        connection_id: basis.connection_id.clone(),
                        revision: basis.revision,
                        slug: "responses".into(),
                        provider: serde_json::from_value(provider).unwrap(),
                        configuration: json!({"baseUrl":base}),
                    },
                    configuration: json!({"baseUrl":base}),
                },
                authentication: maka_agent_facts::provider::AuthenticationInput {
                    method: "api-key".into(),
                    input: json!({"apiKey":"fixture-key"}),
                },
            })
            .await
            .unwrap()
        else {
            panic!("prepare real Responses credential")
        };
        assert!(ticket.claim().await.unwrap());
        assert!(matches!(
            ticket
                .complete(
                    maka_agent_facts::provider::Credential {
                        secret: "fixture-key".into(),
                        refresh_at: None,
                    },
                    1
                )
                .await
                .unwrap(),
            maka_config::oauth::enrollment::LoginCompletion::Committed(_)
        ));
        ModelSelection {
            connection_id: basis.connection_id,
            model_id: "gpt-4.1".into(),
        }
    } else {
        f.configure_model(base, "gpt-4.1", "fixture-key")
            .await
            .unwrap()
    };
    let row = f
        .config
        .catalog()
        .await
        .unwrap()
        .connections
        .into_iter()
        .find(|row| row.connection_id == model.connection_id)
        .unwrap();
    assert!(matches!(
        f.config
            .update_connection(UpdateCatalogConnectionInput {
                expected: ConnectionVersionBasis {
                    connection_id: row.connection_id,
                    revision: row.revision
                },
                changes: ConnectionCatalogEntryUpdate {
                    model_overrides: Patch::Set(BTreeMap::from([(
                        model.model_id.clone(),
                        ModelOverride {
                            code_mode: Some(mode == ToolMode::CodeMode),
                            ..Default::default()
                        }
                    )])),
                    ..Default::default()
                },
            })
            .await
            .unwrap(),
        CatalogMutationResult::Committed { .. }
    ));
    model
}
async fn send(f: &NativeFixture, session: &str, message: &str) -> RunId {
    let SendResult::Queued { message_id, .. } = f.send(session, message, None).await.unwrap()
    else {
        panic!("send must receive its actual queued receipt");
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
            MessageResolution::Delivered { run, shared: false } => return run,
            MessageResolution::Pending => changes.changed().await.unwrap(),
            other => panic!("message was not delivered exactly once: {other:?}"),
        }
    }
}
async fn tool_response(socket: &mut TcpStream, name: &str, id: &str, arguments: String) {
    let call =
        json!({"index":0,"id":id,"type":"function","function":{"name":name,"arguments":arguments}});
    let event = json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"gpt-4.1",
        "choices":[{"index":0,"delta":{"tool_calls":[call]},"finish_reason":null}]});
    let done = json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"gpt-4.1",
        "choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],
        "usage":{"prompt_tokens":10,"completion_tokens":10,"total_tokens":20}});
    let body = format!("data: {event}\n\ndata: {done}\n\ndata: [DONE]\n\n");
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
}
fn assert_diagnostic(error: &str) {
    assert!(
        error.contains("Invalid tool arguments JSON: "),
        "missing parse diagnostic: {error}"
    );
    let escaped = serde_json::to_string(RAW).unwrap();
    assert!(
        error.contains(&format!("Raw arguments: {escaped}")),
        "original malformed text must reach the model: {error}"
    );
}
fn rejected(facts: &[RecordedFact]) -> (&ToolKey, &ToolRejection) {
    let reasons: Vec<_> = facts
        .iter()
        .filter_map(|record| match &record.fact {
            Fact::ToolDecided {
                tool,
                decision: ToolDecision::Rejected { rejection, .. },
            } => Some((tool, rejection)),
            _ => None,
        })
        .collect();
    assert_eq!(reasons.len(), 1);
    assert_eq!(reasons[0].0.call, "malformed-call");
    reasons[0]
}
fn assert_raw(facts: &[RecordedFact], name: &str) {
    assert!(facts.iter().any(|record| matches!(&record.fact,
        Fact::ModelObserved { part: ModelPart::ToolCall { call }, .. }
            if call.id == "malformed-call" && call.name == name
            && call.input == ToolInput::InvalidJson { raw: RAW.into() })));
    assert!(!facts.iter().any(|record| matches!(&record.fact,
        Fact::ToolAdmitted { tool } if tool.call == "malformed-call")));
}
async fn rejection_body(f: &NativeFixture, run: RunId, facts: &[RecordedFact]) -> String {
    let reference = facts
        .iter()
        .find_map(|record| match &record.fact {
            Fact::ToolResultAccepted {
                tool,
                result,
                outcome: AcceptedResult::Rejected,
            } if tool.call == "malformed-call" => Some(result),
            _ => None,
        })
        .unwrap();
    let body: AcceptedToolResult =
        serde_json::from_slice(&f.state.content(run, reference.clone()).await.unwrap()).unwrap();
    let AcceptedToolResult::Rejected { diagnostic } = body else {
        panic!("must remain typed rejection evidence, not a successful JSON result")
    };
    diagnostic
}
fn malformed_pair(request: &Value, name: &str) -> Vec<Value> {
    let messages = request["messages"].as_array().unwrap();
    let call = messages
        .iter()
        .find_map(|message| {
            message["tool_calls"]
                .as_array()
                .and_then(|calls| calls.iter().find(|call| call["id"] == "malformed-call"))
        })
        .unwrap();
    assert_eq!(call["function"]["name"], name);
    assert_eq!(call["function"]["arguments"], "{}");
    let result = messages
        .iter()
        .find(|message| message["role"] == "tool" && message["tool_call_id"] == "malformed-call")
        .unwrap();
    assert_diagnostic(result["content"].as_str().unwrap());
    vec![call.clone(), result.clone()]
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn malformed_direct_arguments_are_rejected_and_corrected() {
    malformed_arguments_are_rejected_and_corrected(ToolMode::Direct).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn malformed_exec_arguments_are_rejected_and_corrected() {
    malformed_arguments_are_rejected_and_corrected(ToolMode::CodeMode).await;
}
async fn malformed_arguments_are_rejected_and_corrected(mode: ToolMode) {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let name = if mode == ToolMode::Direct {
            "echo"
        } else {
            "exec"
        };
        let corrected = if mode == ToolMode::Direct {
            json!({"n":7})
        } else {
            json!({"code":"text(await tools.echo({n:7}));"})
        };
        let directory = tempfile::tempdir().unwrap();
        let inputs = Arc::new(Mutex::new(Vec::new()));
        let current = Arc::new(OnceLock::new());
        let f = NativeFixture::open_with_service(
            directory.path(),
            configuration(directory.path()),
            service(current.clone(), inputs.clone(), mode),
        )
        .await
        .unwrap();
        let selected = model(&f, &base, mode, false).await;
        let session = f
            .create("Arguments", directory.path(), Some(backend(&selected)))
            .await
            .unwrap();
        let run = send(&f, &session, "correct the malformed arguments").await;
        current
            .set((f.state.clone(), run))
            .unwrap_or_else(|_| panic!("bind actual Run once"));
        let observed = inputs.clone();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let first = read_request(&mut socket).await;
            tool_response(&mut socket, name, "malformed-call", RAW.into()).await;
            let (mut socket, _) = listener.accept().await.unwrap();
            let second = read_request(&mut socket).await;
            assert!(
                observed.lock().unwrap().is_empty(),
                "malformed arguments never reach Echo"
            );
            malformed_pair(&second, name);
            tool_response(&mut socket, name, "corrected-call", corrected.to_string()).await;
            let (mut socket, _) = listener.accept().await.unwrap();
            let third = read_request(&mut socket).await;
            assert_eq!(*observed.lock().unwrap(), vec![json!({"n":7})]);
            respond(&mut socket, false).await;
            vec![first, second, third]
        });
        let view = f.wait_terminal(run).await.unwrap();
        assert_eq!(
            view.terminal,
            Some(Terminal::Completed),
            "malformed arguments must be recoverable"
        );
        let requests = server.await.unwrap();
        assert_eq!(requests.len(), 3);
        assert_eq!(*inputs.lock().unwrap(), vec![json!({"n":7})]);
        let facts = f.state.history(run, 0, 256).await.unwrap();
        let (_, reason) = rejected(&facts);
        assert!(matches!(reason, ToolRejection::InvalidInput { .. }));
        assert_raw(&facts, name);
        assert_diagnostic(&rejection_body(&f, run, &facts).await);
        assert_eq!(
            facts
                .iter()
                .filter(|record| matches!(record.fact, Fact::ToolAdmitted { .. }))
                .count(),
            1
        );
        assert_eq!(
            facts
                .iter()
                .filter(|record| matches!(record.fact, Fact::ToolResultAccepted { .. }))
                .count(),
            2
        );
        if mode == ToolMode::CodeMode {
            assert_eq!(view.cells.len(), 1);
            let cell = view.cells.values().next().unwrap();
            assert_eq!(cell.children.len(), 1);
            let child = cell.children.values().next().unwrap();
            assert_eq!(child.name, "echo");
            assert!(child.admitted && child.known());
            assert_eq!(
                serde_json::from_slice::<Value>(
                    &f.state
                        .cells()
                        .content(&session, cell.id, child.input.clone())
                        .await
                        .unwrap()
                )
                .unwrap(),
                json!({"n":7})
            );
        } else {
            assert!(view.cells.is_empty());
        }
        assert_eq!(
            malformed_pair(&requests[2], name),
            malformed_pair(&requests[1], name)
        );
        let visible = f
            .query(
                "history",
                json!({"sessionId":session,"position":{"kind":"start"}}),
            )
            .await
            .unwrap();
        assert!(
            visible["chunks"]
                .as_array()
                .unwrap()
                .iter()
                .any(|chunk| chunk["text"] == "done")
        );
        f.shutdown().await.unwrap();
        let f = NativeFixture::open_with_service(
            directory.path(),
            configuration(directory.path()),
            service(Arc::new(OnceLock::new()), inputs.clone(), mode),
        )
        .await
        .unwrap();
        assert_eq!(f.state.history(run, 0, 256).await.unwrap(), facts);
        assert_eq!(
            f.query(
                "history",
                json!({"sessionId":session,"position":{"kind":"start"}})
            )
            .await
            .unwrap(),
            visible
        );
        rejected(&f.state.history(run, 0, 256).await.unwrap());
        assert_eq!(*inputs.lock().unwrap(), vec![json!({"n":7})]);
        f.shutdown().await.unwrap();
    })
    .await
    .expect("argument correction must make bounded progress");
}

#[tokio::test]
async fn recovered_malformed_arguments_keep_raw_diagnostics_for_every_rejection_reason() {
    tokio::time::timeout(Duration::from_secs(60), async {
        for reason in [
            ToolRejection::Cancelled,
            ToolRejection::PreparationFailed {
                message: "model response was incomplete".into(),
            },
            ToolRejection::ExclusiveConflict,
        ] {
            let directory = tempfile::tempdir().unwrap();
            let inputs = Arc::new(Mutex::new(Vec::new()));
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let f = NativeFixture::open_with_service(
                directory.path(),
                configuration(directory.path()),
                service(Arc::new(OnceLock::new()), inputs.clone(), ToolMode::Direct),
            )
            .await
            .unwrap();
            let selected = model(&f, &base, ToolMode::Direct, false).await;
            let session = f
                .create(
                    "Recovered malformed arguments",
                    directory.path(),
                    Some(backend(&selected)),
                )
                .await
                .unwrap();
            // Join the actual Native producer before seeding old canonical
            // data; no second driver domain or saved runtime grant is created.
            f.app.shutdown().await.unwrap();
            let (mut spec, contents) = canonical::spec(
                &f,
                directory.path(),
                &session,
                "original",
                "original request",
            );
            spec.owner.namespace = InstanceId(vec![Uuid::from_u128(1)]);
            let admission = Admission::new(spec, UnixMillis(1), contents);
            let source = admission.run();
            f.state.admit(admission).await.unwrap();
            let link = admitted_model(&f.state, source, UnixMillis(2)).await;
            let tool = ToolKey {
                attempt: link.attempt,
                call: "malformed-call".into(),
            };
            append(
                &f.state,
                source,
                vec![
                    Change::new(
                        Fact::ModelObserved {
                            attempt: link.attempt,
                            index: 0,
                            continuation: None,
                            part: ModelPart::ToolCall {
                                call: ModelToolCall {
                                    id: tool.call.clone(),
                                    name: "echo".into(),
                                    input: ToolInput::InvalidJson { raw: RAW.into() },
                                    provider_options: None,
                                    provider_executed: false,
                                },
                            },
                        },
                        UnixMillis(3),
                    ),
                    Change::new(
                        Fact::ToolDecided {
                            tool,
                            decision: ToolDecision::Rejected {
                                rejection: reason.clone(),
                                display: Default::default(),
                            },
                        },
                        UnixMillis(3),
                    ),
                    Change::new(
                        Fact::ModelCleanupObserved {
                            attempt: link.attempt,
                            cleanup: OperationCleanup::Confirmed,
                        },
                        UnixMillis(3),
                    ),
                ],
                vec![],
            )
            .await
            .unwrap();
            let view = f.state.frontier(source).await.unwrap();
            f.state
                .control(
                    source,
                    (&view).into(),
                    vec![Change::new(
                        Fact::StopRequested {
                            diagnostic: "drain original immutable recovery fixture".into(),
                        },
                        UnixMillis(4),
                    )],
                    vec![],
                )
                .await
                .unwrap();
            assert!(matches!(
                Engine::new(f.state.clone())
                    .drive(
                        f.state.claim(source).await.unwrap(),
                        Arc::new(NoEffects(UnixMillis(5))),
                        CancellationToken::new(),
                    )
                    .await
                    .unwrap(),
                DriverExit::Terminal {
                    terminal: Terminal::Cancelled,
                    ..
                }
            ));
            let original = f.state.history(source, 0, 256).await.unwrap();
            assert_raw(&original, "echo");
            assert_eq!(rejected(&original).1, &reason);
            let diagnostic = rejection_body(&f, source, &original).await;
            assert!(diagnostic.starts_with(&format!("{reason}\n")));
            assert_diagnostic(&diagnostic);
            assert_eq!(
                original
                    .iter()
                    .filter(|record| matches!(record.fact, Fact::ToolAdmitted { .. }))
                    .count(),
                0
            );
            assert_eq!(
                original
                    .iter()
                    .filter(|record| matches!(record.fact, Fact::ToolResultAccepted { .. }))
                    .count(),
                1
            );
            f.config.shutdown().await.unwrap();
            f.root.shutdown().await.unwrap();
            drop(f);
            let f = NativeFixture::open_with_service(
                directory.path(),
                configuration(directory.path()),
                service(Arc::new(OnceLock::new()), inputs.clone(), ToolMode::Direct),
            )
            .await
            .unwrap();
            let visible = f
                .query(
                    "history",
                    json!({"sessionId":session,"position":{"kind":"start"}}),
                )
                .await
                .unwrap();

            let server = tokio::spawn(async move {
                let mut requests = Vec::new();
                for _ in 0..2 {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    requests.push(read_request(&mut socket).await);
                    respond(&mut socket, false).await;
                }
                requests
            });
            let next = send(&f, &session, "inspect original rejection").await;
            assert_eq!(
                f.wait_terminal(next).await.unwrap().terminal,
                Some(Terminal::Completed)
            );
            f.shutdown().await.unwrap();
            let f = NativeFixture::open_with_service(
                directory.path(),
                configuration(directory.path()),
                service(Arc::new(OnceLock::new()), inputs.clone(), ToolMode::Direct),
            )
            .await
            .unwrap();
            assert_eq!(f.state.history(source, 0, 256).await.unwrap(), original);
            assert_eq!(f.query("history", json!({
                "sessionId":session,"through":visible["through"],"position":{"kind":"start"},
            })).await.unwrap(), visible);
            let after_reopen = send(&f, &session, "inspect original rejection again").await;
            assert_eq!(
                f.wait_terminal(after_reopen).await.unwrap().terminal,
                Some(Terminal::Completed)
            );
            let requests = server.await.unwrap();
            assert_eq!(requests.len(), 2);
            let first = malformed_pair(&requests[0], "echo");
            assert!(
                first[1]["content"]
                    .as_str()
                    .unwrap()
                    .contains(&format!("{reason}\n"))
            );
            assert_eq!(malformed_pair(&requests[1], "echo"), first);
            assert_eq!(f.state.history(source, 0, 256).await.unwrap(), original);
            assert!(inputs.lock().unwrap().is_empty());
            f.shutdown().await.unwrap();
        }
    })
    .await
    .expect("original rejection diagnostics must survive replay and Root reopen");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn accepted_malformed_arguments_survive_transport_interruption_without_reexecution() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let directory = tempfile::tempdir().unwrap();
        let inputs = Arc::new(Mutex::new(Vec::new()));
        let current = Arc::new(OnceLock::new());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let f = NativeFixture::open_with_service(directory.path(), configuration(directory.path()),
            service(current.clone(), inputs.clone(), ToolMode::Direct)).await.unwrap();
        let selected = model(&f, &base, ToolMode::Direct, true).await;
        let session = f.create("Accepted malformed transport cut", directory.path(), Some(backend(&selected))).await.unwrap();
        let run = send(&f, &session, "correct retained malformed arguments").await;
        current.set((f.state.clone(), run)).unwrap_or_else(|_| panic!("bind actual Run once"));
        let observed = f.state.clone();
        let observed_inputs = inputs.clone();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(socket).await.unwrap();
            let first: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(first["store"], false);
            socket.send(Frame::Text(json!({
                "type":"response.output_item.done","output_index":0,
                "item":{"type":"function_call","id":"invalid-item","call_id":"malformed-call",
                    "name":"echo","arguments":RAW},
            }).to_string().into())).await.unwrap();
            let mut changes = observed.subscribe().unwrap();
            loop {
                changes.borrow_and_update();
                let facts = observed.history(run, 0, 256).await.unwrap();
                if facts.iter().any(|record| matches!(&record.fact,
                    Fact::ToolDecided { tool, decision: ToolDecision::Rejected { .. } } if tool.call == "malformed-call")) {
                    assert_raw(&facts, "echo");
                    assert!(!facts.iter().any(|record| matches!(record.fact,
                        Fact::ModelClosed { .. } | Fact::ToolAdmitted { .. })));
                    assert!(observed_inputs.lock().unwrap().is_empty());
                    break;
                }
                changes.changed().await.unwrap();
            }
            socket.close(None).await.unwrap();
            drop(socket);
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(socket).await.unwrap();
            let retry: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
            assert!(retry.get("previous_response_id").is_none());
            let carried: Vec<_> = retry["input"].as_array().unwrap().iter()
                .filter(|item| item["call_id"] == "malformed-call").collect();
            assert_eq!(carried.len(), 2);
            assert_eq!(carried[0]["type"], "function_call");
            assert_eq!(carried[0]["name"], "echo");
            assert_eq!(carried[0]["arguments"], RAW);
            assert_eq!(carried[1]["type"], "function_call_output");
            assert_diagnostic(carried[1]["output"].as_str().unwrap());
            socket.send(Frame::Text(json!({"type":"response.completed","response":{
                "id":"corrected-response","status":"completed","model":"gpt-4.1",
                "output":[{"type":"function_call","id":"corrected-item","call_id":"corrected-call",
                    "name":"echo","arguments":"{\"n\":7}"}],
                "usage":{"input_tokens":4,"output_tokens":2},
            }}).to_string().into())).await.unwrap();
            let next: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
            assert!(next["input"].as_array().unwrap().iter().any(|item|
                item["type"] == "function_call_output" && item["call_id"] == "corrected-call"
                && item["output"].as_str().is_some_and(|output|
                    serde_json::from_str::<Value>(output).unwrap() == json!({"n":7}))));
            socket.send(Frame::Text(json!({"type":"response.completed","response":{
                "id":"final","status":"completed","model":"gpt-4.1",
                "output":[{"type":"message","id":"answer","role":"assistant",
                    "content":[{"type":"output_text","text":"done","annotations":[]}]}],
                "usage":{"input_tokens":4,"output_tokens":2},
            }}).to_string().into())).await.unwrap();
        });
        assert_eq!(f.wait_terminal(run).await.unwrap().terminal, Some(Terminal::Completed));
        server.await.unwrap();
        assert_eq!(*inputs.lock().unwrap(), vec![json!({"n":7})]);
        let facts = f.state.history(run, 0, 256).await.unwrap();
        assert_raw(&facts, "echo");
        assert!(matches!(rejected(&facts).1, ToolRejection::InvalidInput { .. }));
        assert_diagnostic(&rejection_body(&f, run, &facts).await);
        assert_eq!(facts.iter().filter(|record| matches!(record.fact, Fact::ToolAdmitted { .. })).count(), 1);
        assert_eq!(facts.iter().filter(|record| matches!(record.fact, Fact::ToolResultAccepted { .. })).count(), 2);
        assert_eq!(facts.iter().filter(|record| matches!(record.fact, Fact::ModelInterrupted { .. })).count(), 1);
        assert_eq!(facts.iter().filter(|record| matches!(&record.fact,
            Fact::AttemptRecoveryRecorded { recovery: AttemptRecovery::ProjectPrefixSafe { .. }, .. })).count(), 1);
        f.shutdown().await.unwrap();
    }).await.expect("accepted malformed call must survive reconnect and permit correction");
}
