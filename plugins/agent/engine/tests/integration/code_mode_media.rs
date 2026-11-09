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

use crate::code_mode_lifetime::{backend, configuration, configure_model, message};
use crate::support::{
    code_mode as fixture,
    native::{FixtureService, NativeFixture},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures_util::future::BoxFuture;
use maka_agent_api::contract::ForkResult;
use maka_agent_facts::{
    cells::CellEvent,
    durable::{Fact, RunId, Terminal},
};
use maka_agent_state::Store;
use maka_host_runtime::application::{
    Context, Handler, HandlerError, HandlerResult, HandlerValue, NativeOwner, NativeRetirement,
};
use maka_plugin_core::contract::{Contract, Interface, Method, MethodMode, Transport};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Notify,
};

#[derive(Default)]
struct Gates {
    gate: Notify,
    hold: Notify,
}
struct GateHandler {
    gates: Arc<Gates>,
}
impl Handler for GateHandler {
    fn call(&self, name: String, _: Value, context: Context) -> BoxFuture<'static, HandlerResult> {
        assert!(context.operation().is_some() && context.operation_scope().is_some());
        assert!(
            context.work_custody().is_some(),
            "the real Native Run must own this call"
        );
        let gates = self.gates.clone();
        Box::pin(async move {
            let gate = match name.as_str() {
                "gate" => &gates.gate,
                "hold" => &gates.hold,
                _ => return Err(HandlerError::from("unknown fixture gate")),
            };
            tokio::select! {
                _ = gate.notified() => Ok(HandlerValue::Json(Value::Null)),
                _ = context.scope().cancellation.cancelled() => Err(HandlerError::from("cancelled")),
            }
        })
    }
}
impl NativeOwner for GateHandler {
    fn prepare_retirement(&self) -> Option<Box<dyn NativeRetirement>> {
        Some(Box::new(()))
    }
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}
fn service(gates: Arc<Gates>, names: &[&str]) -> FixtureService {
    FixtureService::new(
        Contract {
            name: "fixture.Gates".into(),
            version: 1,
            transport: Transport::Remote,
            interface: Interface::Service {
                methods: names
                    .iter()
                    .map(|name| {
                        (
                            (*name).into(),
                            Method {
                                mode: MethodMode::Mutation,
                                input: json!({"type":"object"}).into(),
                                output: json!({}).into(),
                                resources: BTreeMap::new(),
                                progress: None,
                            },
                        )
                    })
                    .collect(),
            },
        },
        Arc::new(GateHandler { gates }),
    )
}
async fn notices(state: &Store, run: RunId) {
    let mut commits = state.subscribe().unwrap();
    loop {
        commits.borrow_and_update();
        if state
            .history(run, 0, 256)
            .await
            .unwrap()
            .iter()
            .filter(|e| {
                matches!(
                    e.fact,
                    Fact::Cell {
                        event: CellEvent::NotificationQueued { .. }
                    }
                )
            })
            .count()
            == 2
        {
            return;
        }
        commits.changed().await.unwrap();
    }
}
struct GatePricing {
    source: OnceLock<(Store, String)>,
    gates: Arc<Gates>,
    before_commit: bool,
    calls: std::sync::atomic::AtomicUsize,
}
impl maka_agent_engine::pricing::Pricing for GatePricing {
    fn quote<'a>(
        &'a self,
        provider: &'a str,
        _: &'a str,
    ) -> futures_util::future::BoxFuture<
        'a,
        Result<maka_agent_facts::pricing::Quote, maka_agent_engine::RunError>,
    > {
        Box::pin(async move {
            let index = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if self.before_commit && index == 1 {
                self.gates.gate.notify_one();
                let (state, session) = self
                    .source
                    .get()
                    .expect("actual Native Session attached before sending");
                notices(
                    state,
                    state.latest_run(session.clone()).await.unwrap().unwrap(),
                )
                .await;
            }
            if index == 2 {
                let (state, session) = self
                    .source
                    .get()
                    .expect("actual Native Session attached before sending");
                notices(
                    state,
                    state.latest_run(session.clone()).await.unwrap().unwrap(),
                )
                .await;
            }
            Ok(maka_agent_facts::pricing::Quote {
                provider_id: provider.into(),
                revision: 0,
                pricing: None,
            })
        })
    }
}

fn wav() -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&836u32.to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&8000u32.to_le_bytes());
    bytes.extend_from_slice(&16000u32.to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&800u32.to_le_bytes());
    bytes.extend(vec![0; 800]);
    bytes
}
async fn next_request(listener: &TcpListener) -> (TcpStream, Value) {
    loop {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut method = [0; 4];
        socket.read_exact(&mut method).await.unwrap();
        if &method == b"GET " {
            let mut header = Vec::from(method);
            while !header.ends_with(b"\r\n\r\n") {
                header.push(socket.read_u8().await.unwrap());
                assert!(header.len() < 8192);
            }
            socket.write_all(b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
            continue;
        }
        assert_eq!(&method, b"POST");
        let body = fixture::read_request(&mut socket).await;
        return (socket, body);
    }
}
async fn reply(socket: &mut TcpStream, item: Value, index: usize) {
    let events = [
        json!({"type":"response.output_item.done","item":item}),
        json!({"type":"response.completed","response":{"id":format!("r{index}"),"status":"completed","output":[],"usage":{"input_tokens":10,"output_tokens":10}}}),
    ];
    let body = events
        .iter()
        .map(|event| format!("data: {event}\n\n"))
        .collect::<String>();
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
}
fn text(value: &str, index: usize) -> Value {
    json!({"type":"message","id":format!("msg{index}"),"role":"assistant","content":[{"type":"output_text","text":value}]})
}
fn notifications(request: &Value) -> Vec<&str> {
    request["input"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["role"] == "user")
        .flat_map(|item| item["content"].as_array().into_iter().flatten())
        .filter_map(|part| part["text"].as_str())
        .filter(|text| matches!(*text, "first notice" | "second notice"))
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn notifications_trigger_followup_without_wait_and_audio_survives_copy_and_restart() {
    tokio::time::timeout(Duration::from_secs(35), async {
      for before_commit in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let gates = Arc::new(Gates::default());
        let pricing = Arc::new(GatePricing {
            source:OnceLock::new(), gates:gates.clone(), before_commit,
            calls:std::sync::atomic::AtomicUsize::new(0),
        });
        let listener = Arc::new(TcpListener::bind("127.0.0.1:0").await.unwrap());
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let f = NativeFixture::open_with_pricing(
            directory.path(), configuration(directory.path(), &["gate", "hold"]),
            service(gates.clone(), &["gate", "hold"]), pricing.clone(),
        ).await.unwrap();
        let model = configure_model(&f, &base, true).await;
        let session = f.create("media", directory.path(), Some(backend(&model))).await.unwrap();
        assert!(pricing.source.set((f.state.clone(), session.clone())).is_ok());
        let audio_url = format!("data:audio/wav;base64,{}", STANDARD.encode(wav()));
        let script = format!("// @exec: {{\"yield_time_ms\":0}}\nawait tools.gate({{}}); notify('first notice'); notify('second notice'); audio({}); await tools.hold({{}});", serde_json::to_string(&audio_url).unwrap());
        let server_gates = gates.clone(); let observed = f.state.clone(); let expected_audio = audio_url.clone();
        let observed_session = session.clone();
        let server_listener = listener.clone();
        let server = tokio::spawn(async move {
            let (mut socket, first) = next_request(&server_listener).await;
            assert_eq!(first["tools"][0]["type"], "custom");
            reply(&mut socket, json!({"type":"custom_tool_call","id":"exec-item","call_id":"exec-call","name":"exec","input":script}), 0).await;
            let (mut socket, second) = next_request(&server_listener).await;
            assert!(notifications(&second).is_empty());
            let result = second["input"].as_array().unwrap().iter().find(|item| item["type"] == "custom_tool_call_output").unwrap();
            let running: Value = serde_json::from_str(result["output"].as_str().unwrap()).unwrap();
            assert_eq!(running["state"], "running");
            // The physical retry keeps the original logical input even when
            // a live cell publishes during preparation or retry backoff.
            socket.write_all(b"HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nRetry-After: 0\r\nContent-Length: 43\r\nConnection: close\r\n\r\n{\"error\":{\"message\":\"busy\",\"type\":\"limit\"}}").await.unwrap();
            if !before_commit {
                server_gates.gate.notify_one();
                notices(&observed, observed.latest_run(observed_session).await.unwrap().unwrap()).await;
            }
            let (mut socket, retry) = next_request(&server_listener).await;
            assert_eq!(retry, second, "physical retries cannot claim a new notification cut");
            reply(&mut socket, text("tentative answer", 1), 1).await;
            let (mut socket, third) = next_request(&server_listener).await;
            assert_eq!(notifications(&third), ["first notice", "second notice"]);
            let input = third["input"].as_array().unwrap();
            let answer = input.iter().position(|item| item["content"][0]["text"] == "tentative answer").unwrap();
            let notice = input.iter().position(|item| item["role"] == "user" && item["content"].as_array().is_some_and(|parts| parts.iter().any(|part| part["text"] == "first notice"))).unwrap();
            assert!(answer < notice, "notifications do not rewrite the request already in flight");
            server_gates.hold.notify_one();
            reply(&mut socket, json!({"type":"function_call","id":"wait-item","call_id":"wait-call","name":"wait","arguments":json!({"cell_id":running["cell_id"]}).to_string()}), 2).await;
            let (mut socket, fourth) = next_request(&server_listener).await;
            assert_eq!(notifications(&fourth), ["first notice", "second notice"]);
            let output = fourth["input"].as_array().unwrap().iter().find(|item| item["type"] == "function_call_output").unwrap();
            assert!(output["output"].as_array().unwrap().iter().any(|part| part["type"] == "input_audio" && part["audio_url"] == expected_audio));
            reply(&mut socket, text("done", 3), 3).await;
            fourth
        });
        assert_eq!(message(&f, &session, "question media").await.terminal, Some(Terminal::Completed));
        server.await.unwrap();
        let observed = f.query("observe", json!({"sessionId":session})).await.unwrap();
        let copy = f.mutation_value("fork", json!({
            "sessionId":session,"expectedRevision":observed["session"]["revision"],
            "position":{"kind":"end"},"title":"copy","labels":[],
        })).await.unwrap();
        let ForkResult::Forked {session:copy} = serde_json::from_value(copy).unwrap() else {
            panic!("actual completed Session must fork at its exact End revision")
        };
        f.shutdown().await.unwrap();
        drop(pricing);
        let reopened = NativeFixture::open_with_service(
            directory.path(), configuration(directory.path(), &["gate", "hold"]),
            service(Arc::new(Gates::default()), &["gate", "hold"]),
        ).await.unwrap();
        let replay = tokio::spawn(async move {
            let (mut socket, request) = next_request(&listener).await;
            assert_eq!(notifications(&request), ["first notice", "second notice"]);
            assert!(request["input"].as_array().unwrap().iter().any(|item| item["output"].as_array().is_some_and(|parts| parts.iter().any(|part| part["type"] == "input_audio" && part["audio_url"] == audio_url))));
            reply(&mut socket, text("replayed", 4), 4).await;
        });
        assert_eq!(message(&reopened, &copy.id, "question after restart").await.terminal, Some(Terminal::Completed));
        replay.await.unwrap();
        reopened.shutdown().await.unwrap();
      }
    }).await.expect("notification and audio lifecycle must make bounded progress");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_background_cell_delivers_final_text_and_audio_without_wait_and_after_restart() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let directory = tempfile::tempdir().unwrap();
        let gates = Arc::new(Gates::default());
        let listener = Arc::new(TcpListener::bind("127.0.0.1:0").await.unwrap());
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let f = NativeFixture::open_with_service(
            directory.path(), configuration(directory.path(), &["gate"]), service(gates.clone(), &["gate"]),
        ).await.unwrap();
        let model = configure_model(&f, &base, true).await;
        let session = f.create("final-cell", directory.path(), Some(backend(&model))).await.unwrap();
        let audio = format!("data:audio/wav;base64,{}", STANDARD.encode(wav()));
        let script = format!("// @exec: {{\"yield_time_ms\":0}}\nawait tools.gate({{}}); text('final background output'); audio({});", serde_json::to_string(&audio).unwrap());
        let observed = f.state.clone();
        let observed_session = session.clone();
        let released = gates.clone();
        let expected_audio = audio.clone();
        let server_listener = listener.clone();
        let server = tokio::spawn(async move {
            let (mut socket, _) = next_request(&server_listener).await;
            reply(&mut socket, json!({"type":"custom_tool_call","id":"exec-item","call_id":"exec-call","name":"exec","input":script}), 0).await;
            let (mut socket, _) = next_request(&server_listener).await;
            let mut changes = observed.subscribe().unwrap();
            released.gate.notify_one();
            loop {
                changes.borrow_and_update();
                let run = observed.latest_run(observed_session.clone()).await.unwrap().unwrap();
                let records = observed.history(run, 0, 256).await.unwrap();
                if records.iter().any(|entry| matches!(&entry.fact,
                    Fact::Cell {event:CellEvent::Completed {..}})) { break; }
                changes.changed().await.unwrap();
            }
            reply(&mut socket, text("interim", 1), 1).await;
            let (mut socket, final_request) = next_request(&server_listener).await;
            assert_final_cell_media(&final_request, &expected_audio);
            reply(&mut socket, text("complete", 2), 2).await;
        });
        assert_eq!(message(&f, &session, "question final-cell").await.terminal, Some(Terminal::Completed));
        server.await.unwrap();
        f.shutdown().await.unwrap();
        let reopened = NativeFixture::open_with_service(
            directory.path(), configuration(directory.path(), &[]), service(Arc::new(Gates::default()), &["gate"]),
        ).await.unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, request) = next_request(&listener).await;
            assert_final_cell_media(&request, &audio);
            reply(&mut socket, text("reopened", 3), 3).await;
        });
        assert_eq!(message(&reopened, &session, "question after restart").await.terminal, Some(Terminal::Completed));
        server.await.unwrap();
        reopened.shutdown().await.unwrap();
    }).await.unwrap();
}

fn assert_final_cell_media(request: &Value, audio: &str) {
    let input = request["input"].as_array().unwrap();
    assert_eq!(
        input
            .iter()
            .filter(
                |item| item["type"] == "custom_tool_call_output" && item["call_id"] == "exec-call"
            )
            .count(),
        1
    );
    let content: Vec<_> = input
        .iter()
        .filter(|item| item["role"] == "user")
        .flat_map(|item| item["content"].as_array().into_iter().flatten())
        .collect();
    assert!(
        content
            .iter()
            .any(|part| part["text"] == "final background output"),
        "final output must be delivered without wait: {request}"
    );
    assert!(
        content
            .iter()
            .any(|part| part["type"] == "input_audio" && part["audio_url"] == audio),
        "unobserved audio must survive final settlement and restart: {request}"
    );
}
