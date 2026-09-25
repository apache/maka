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

use crate::support::code_mode as fixture;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use maka_agent::{Engine, RunWork};
use maka_event_log::EventLog;
use maka_js_runtime::{CellLimits, CodeExecutor};
use maka_model::{ModelExecutor, ProviderKind};
use maka_runtime::{
    event::Fact,
    tools::{ToolError, ToolExecutor, ToolFuture},
};
use maka_tools::{
    ToolCatalog, ToolDefinition, ToolHandler, ToolNesting, ToolRegistration, ToolSemantics,
};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Notify,
};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct Gates {
    gate: Notify,
    hold: Notify,
}
struct GateHandler {
    gates: Arc<Gates>,
}
impl ToolExecutor for GateHandler {
    fn names(&self) -> Vec<String> {
        vec!["gate".into(), "hold".into()]
    }
    fn invoke(&self, name: String, _: Value, cancel: CancellationToken) -> ToolFuture {
        let gates = self.gates.clone();
        Box::pin(async move {
            let gate = if name == "gate" {
                &gates.gate
            } else {
                &gates.hold
            };
            tokio::select! { _ = gate.notified() => Ok(Value::Null), _ = cancel.cancelled() => Err(ToolError::Failed("cancelled".into())) }
        })
    }
}
async fn notices(log: &EventLog) {
    let mut commits = log.subscribe_commits();
    loop {
        commits.borrow_and_update();
        if log
            .prefix(100, 1024 * 1024)
            .await
            .unwrap()
            .events
            .iter()
            .filter(|e| matches!(e.event.fact, Fact::ToolNotified { .. }))
            .count()
            == 2
        {
            return;
        }
        commits.changed().await.unwrap();
    }
}
struct GatePricing {
    log: Arc<EventLog>,
    gates: Arc<Gates>,
    before_commit: bool,
    calls: std::sync::atomic::AtomicUsize,
}
impl maka_agent::pricing::Pricing for GatePricing {
    fn quote<'a>(
        &'a self,
        provider: &'a str,
        _: &'a str,
    ) -> futures_util::future::BoxFuture<
        'a,
        Result<maka_runtime::pricing::Quote, maka_agent::RunError>,
    > {
        Box::pin(async move {
            let index = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if self.before_commit && index == 1 {
                self.gates.gate.notify_one();
                notices(&self.log).await;
            }
            if index == 2 {
                notices(&self.log).await;
            }
            Ok(maka_runtime::pricing::Quote {
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
        .filter(|item| item["type"] == "custom_tool_call_output")
        .filter_map(|item| item["output"].as_str())
        .filter(|text| matches!(*text, "first notice" | "second notice"))
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn notifications_trigger_followup_without_wait_and_audio_survives_copy_and_restart() {
    tokio::time::timeout(Duration::from_secs(35), async {
      for before_commit in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("events.sqlite");
        let log = Arc::new(EventLog::open(&path).await.unwrap());
        log.create_session("session", "create", &json!({}), 1).await.unwrap();
        let gates = Arc::new(Gates::default());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let audio_url = format!("data:audio/wav;base64,{}", STANDARD.encode(wav()));
        let script = format!("// @exec: {{\"yield_time_ms\":0}}\nawait tools.gate({{}}); notify('first notice'); notify('second notice'); audio({}); await tools.hold({{}});", serde_json::to_string(&audio_url).unwrap());
        let server_gates = gates.clone(); let observed = log.clone(); let expected_audio = audio_url.clone();
        let server = tokio::spawn(async move {
            let (mut socket, first) = next_request(&listener).await;
            assert_eq!(first["tools"][0]["type"], "custom");
            reply(&mut socket, json!({"type":"custom_tool_call","id":"exec-item","call_id":"exec-call","name":"exec","input":script}), 0).await;
            let (mut socket, second) = next_request(&listener).await;
            assert!(notifications(&second).is_empty());
            let result = second["input"].as_array().unwrap().iter().find(|item| item["type"] == "custom_tool_call_output").unwrap();
            let running: Value = serde_json::from_str(result["output"].as_str().unwrap()).unwrap();
            assert_eq!(running["state"], "running");
            // The physical retry keeps the original logical input even when
            // a live cell publishes during preparation or retry backoff.
            socket.write_all(b"HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nRetry-After: 0\r\nContent-Length: 43\r\nConnection: close\r\n\r\n{\"error\":{\"message\":\"busy\",\"type\":\"limit\"}}").await.unwrap();
            if !before_commit { server_gates.gate.notify_one(); notices(&observed).await; }
            let (mut socket, retry) = next_request(&listener).await;
            assert_eq!(retry, second, "physical retries cannot claim a new notification cut");
            reply(&mut socket, text("tentative answer", 1), 1).await;
            let (mut socket, third) = next_request(&listener).await;
            assert_eq!(notifications(&third), ["first notice", "second notice"]);
            let input = third["input"].as_array().unwrap();
            let answer = input.iter().position(|item| item["content"][0]["text"] == "tentative answer").unwrap();
            let notice = input.iter().position(|item| item["output"] == "first notice").unwrap();
            assert!(answer < notice, "notifications do not rewrite the request already in flight");
            server_gates.hold.notify_one();
            reply(&mut socket, json!({"type":"function_call","id":"wait-item","call_id":"wait-call","name":"wait","arguments":json!({"cell_id":running["cell_id"]}).to_string()}), 2).await;
            let (mut socket, fourth) = next_request(&listener).await;
            assert_eq!(notifications(&fourth), ["first notice", "second notice"]);
            let output = fourth["input"].as_array().unwrap().iter().find(|item| item["type"] == "function_call_output").unwrap();
            assert!(output["output"].as_array().unwrap().iter().any(|part| part["type"] == "input_audio" && part["audio_url"] == expected_audio));
            reply(&mut socket, text("done", 3), 3).await;
            fourth
        });
        let mut input = fixture::input(&base, "media", Arc::new(fixture::Effects { log:log.clone(), count:Arc::default(), together:Arc::new(tokio::sync::Barrier::new(2)) }));
        input.provider.kind = ProviderKind::OpenaiResponses; input.provider_options = json!({"openai":{"store":false}});
        let handler = Arc::new(GateHandler { gates: gates.clone() });
        if let RunWork::Message { tools, max_steps, .. } = &mut input.work {
            *tools = ToolCatalog::new(["gate", "hold"].map(|name| ToolRegistration {
                definition:ToolDefinition { name:name.into(), description:"fixture gate".into(), input_schema:json!({"type":"object"}), provider:None, freeform:None, output_schema:None },
                handler:ToolHandler::Immediate(handler.clone()), nesting:ToolNesting::Nestable, semantics:ToolSemantics::Parallel,
            })).unwrap(); *max_steps = 4;
        }
        let engine = Engine::with_pricing(log.clone(), ModelExecutor::new(1, Duration::from_secs(5)).unwrap(), CodeExecutor::new(1, CellLimits::default()).unwrap(), Arc::new(GatePricing { log:log.clone(), gates, before_commit, calls:std::sync::atomic::AtomicUsize::new(0) }));
        engine.run(input.clone(), CancellationToken::new()).await.unwrap();
        server.await.unwrap(); engine.drain().await; drop(engine);
        let revision = log.get_session::<Value>("session").await.unwrap().unwrap().revision;
        log.copy_session(maka_event_log::sessions::SessionCopy { source_session_id:"session".into(), target_session_id:"copy".into(), expected_source_revision:revision,
            purpose:maka_runtime::session::CopyPurpose::Branch { turn_id:None, side_conversation:false } }, &json!({}), 2).await.unwrap();
        Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
        let log = Arc::new(EventLog::open(&path).await.unwrap());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        input.provider.base_url = format!("http://{}/v1", listener.local_addr().unwrap());
        input.invocation.session_id = "copy".into(); input.invocation.turn_id="next-turn".into(); input.invocation.run_id="next-run".into(); input.invocation.invocation_id="next-invocation".into();
        let replay = tokio::spawn(async move {
            let (mut socket, request) = next_request(&listener).await;
            assert_eq!(notifications(&request), ["first notice", "second notice"]);
            assert!(request["input"].as_array().unwrap().iter().any(|item| item["output"].as_array().is_some_and(|parts| parts.iter().any(|part| part["type"] == "input_audio" && part["audio_url"] == audio_url))));
            reply(&mut socket, text("replayed", 4), 4).await;
        });
        let engine = Engine::new(log.clone(), ModelExecutor::new(1, Duration::from_secs(5)).unwrap(), CodeExecutor::new(1, CellLimits::default()).unwrap());
        engine.run(input, CancellationToken::new()).await.unwrap(); replay.await.unwrap(); engine.drain().await; drop(engine);
        Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
      }
    }).await.expect("notification and audio lifecycle must make bounded progress");
}
