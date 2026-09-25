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

use crate::support::context as fixture;
use maka_agent::RunWork;
use maka_event_log::EventLog;
use maka_runtime::{
    context::ModelRequestContext,
    event::Fact,
    execution::ToolMode,
    tools::{ToolExecutor, ToolFuture},
};
use maka_tools::{
    ToolCatalog, ToolDefinition, ToolHandler, ToolNesting, ToolRegistration, ToolSemantics,
};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::{
    io::AsyncWriteExt,
    net::{TcpListener, TcpStream},
};
use tokio_util::sync::CancellationToken;

struct Echo(Arc<AtomicUsize>);
impl ToolExecutor for Echo {
    fn names(&self) -> Vec<String> {
        vec!["echo".into()]
    }
    fn invoke(&self, _: String, input: Value, _: CancellationToken) -> ToolFuture {
        self.0.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move { Ok(input) })
    }
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
    tokio::time::timeout(std::time::Duration::from_secs(45), async {
        for mode in [ToolMode::Direct, ToolMode::CodeMode] {
            for compact in [false, true] {
                let directory = tempfile::tempdir().unwrap();
                let log = Arc::new(EventLog::open(&directory.path().join("events.sqlite")).await.unwrap());
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                let base = format!("http://{}/v1", listener.local_addr().unwrap());
                let effects = Arc::new(AtomicUsize::new(0));
                let observed = effects.clone();
                let server = tokio::spawn(async move {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let first = fixture::read_request(&mut socket).await;
                    assert_eq!(visible(&first, mode), if mode == ToolMode::Direct { vec!["tool_search".to_string()] } else { vec![] });
                    let calls = if mode == ToolMode::Direct {
                        vec![call("search", "tool_search", json!({"query":"echo"})),
                             call("premature", "echo", json!({"n":1}))]
                    } else {
                        vec![call("search", "exec", json!({"code":"const tool = ALL_TOOLS.find(t => t.name === 'echo'); text(tool.description); text(await tools[tool.name]({n:1}));"}))]
                    };
                    respond_tools(&mut socket, calls, 10).await;
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let second = fixture::read_request(&mut socket).await;
                    let definitions = visible(&second, mode);
                    assert_eq!(definitions.iter().any(|name| name == "echo"), mode == ToolMode::Direct);
                    assert_eq!(observed.load(Ordering::SeqCst), usize::from(mode == ToolMode::CodeMode));
                    if mode == ToolMode::CodeMode {
                        let result = second["messages"].as_array().unwrap().iter().find(|m| m["role"] == "tool").unwrap();
                        assert!(result["content"].as_str().unwrap().contains("echo(input:"));
                    }
                    let call = if mode == ToolMode::Direct {
                        call("use", "echo", json!({"n":2}))
                    } else { call("use", "exec", json!({"code":"text(await tools.echo({n:2}));"})) };
                    respond_tools(&mut socket, vec![call], 200).await;
                    for _ in 0..if compact { 1 } else { 2 } {
                        let (mut socket, _) = listener.accept().await.unwrap();
                        let summary = fixture::read_request(&mut socket).await;
                        assert_eq!(summary["max_tokens"], 8000);
                        assert!(summary.get("tools").is_none());
                        fixture::respond(&mut socket, if compact { fixture::SUMMARY } else { "invalid summary" }, "stop").await;
                    }
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let final_request = fixture::read_request(&mut socket).await;
                    let definitions = visible(&final_request, mode);
                    assert_eq!(definitions.iter().any(|name| name == "echo"), !compact && mode == ToolMode::Direct);
                    assert_eq!(definitions.iter().any(|name| name == "tool_search"), mode == ToolMode::Direct);
                    fixture::respond(&mut socket, "done", "stop").await;
                });
                let catalog = ToolCatalog::new([ToolRegistration {
                    definition: ToolDefinition { freeform: None, output_schema: None, provider: None, name: "echo".into(), description: "Echo an integer".into(),
                        input_schema: json!({"type":"object","properties":{"n":{"type":"integer"}},"required":["n"],"additionalProperties":false}) },
                    nesting: ToolNesting::Nestable, semantics: ToolSemantics::Parallel,
                    handler: ToolHandler::Immediate(Arc::new(Echo(effects.clone()))),
                }]).unwrap().with_discovery();
                let mut input = fixture::input(&base, "discovery", false);
                input.configuration.tool_mode = mode;
                input.context = Some(ModelRequestContext { provider_id:"openai".into(), context_window:Some(220), declared_window:Some(210), model_context_window:None });
                input.work = RunWork::Message { allow_prior_unknown:false, source_messages:Vec::new(), message:"Use echo".into(), tools:catalog, max_steps:3 };
                let engine = fixture::engine(log.clone());
                engine.run(input, CancellationToken::new()).await.unwrap();
                engine.drain().await;
                server.await.unwrap();
                assert_eq!(effects.load(Ordering::SeqCst), if mode == ToolMode::Direct { 1 } else { 2 });
                let prefix = log.prefix(200, 1024 * 1024).await.unwrap();
                assert_eq!(prefix.events.iter().filter(|e| matches!(e.event.fact, Fact::ContextCheckpointRecorded { .. })).count(), usize::from(compact));
                assert_eq!(prefix.events.iter().filter(|e| matches!(&e.event.fact, Fact::ToolDispatched { name, .. } if name == "tool_search")).count(), usize::from(mode == ToolMode::Direct));
                if mode == ToolMode::Direct {
                    assert_eq!(prefix.events.iter().filter(|e| matches!(&e.event.fact, Fact::ToolRejected { name, .. } if name == "echo")).count(), 1);
                }
                drop(engine);
                Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
            }
        }
    }).await.expect("dynamic tool lifecycle must make bounded progress");
}
