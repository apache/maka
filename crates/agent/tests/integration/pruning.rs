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
    event::{Fact, ToolOutcome},
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

struct Large(Arc<AtomicUsize>, usize);
impl ToolExecutor for Large {
    fn names(&self) -> Vec<String> {
        vec!["Read".into()]
    }
    fn invoke(&self, _: String, _: Value, _: CancellationToken) -> ToolFuture {
        self.0.fetch_add(1, Ordering::SeqCst);
        let repeats = self.1;
        Box::pin(async move { Ok(json!({"content": "visible-original-marker".repeat(repeats)})) })
    }
}
fn catalog(count: Arc<AtomicUsize>, repeats: usize) -> ToolCatalog {
    ToolCatalog::new([ToolRegistration {
        definition: ToolDefinition {
            provider: None,
            name: "Read".into(),
            description: "fixture".into(),
            input_schema: json!({"type":"object","properties":{"path":{"type":"string"}}}),
        },
        nesting: ToolNesting::Nestable,
        semantics: ToolSemantics::Parallel,
        handler: ToolHandler::Immediate(Arc::new(Large(count, repeats))),
    }])
    .unwrap()
}
async fn tool(socket: &mut TcpStream, count: usize) {
    let calls: Vec<_> = (0..count).map(|index| json!({"index":index,"id":format!("call-{index}"),"type":"function","function":{"name":"Read","arguments":"{\"path\":\"file\"}"}})).collect();
    let call = json!({"id":"response","object":"chat.completion.chunk","created":1,"model":"test",
        "choices":[{"index":0,"delta":{"tool_calls":calls},"finish_reason":null}]});
    let done = json!({"id":"response","object":"chat.completion.chunk","created":1,"model":"test",
        "choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":200,"completion_tokens":10,"total_tokens":210}});
    let body = format!("data: {call}\n\ndata: {done}\n\ndata: [DONE]\n\n");
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn settled_results_are_pruned_before_context_limits_and_survive_failed_summary() {
    for (spent, interrupted, call_count, repeats) in [
        (false, false, 40, 10_000),
        (true, false, 1, 600),
        (true, true, 1, 600),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let log = Arc::new(
            EventLog::open(&directory.path().join("events.sqlite"))
                .await
                .unwrap(),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let observed = log.clone();
        let server = tokio::spawn(async move {
            if interrupted {
                for text in ["old-answer", fixture::SUMMARY] {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    fixture::read_request(&mut socket).await;
                    fixture::respond(&mut socket, text, "stop").await;
                }
            }
            let (mut socket, _) = listener.accept().await.unwrap();
            let first = fixture::read_request(&mut socket).await;
            assert_eq!(first["max_tokens"], 4000);
            tool(&mut socket, call_count).await;
            if spent {
                for _ in 0..if interrupted { 1 } else { 2 } {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let request = fixture::read_request(&mut socket).await;
                    assert_eq!(
                        request["max_tokens"], 4000,
                        "Summary also respects the selected output budget"
                    );
                    assert!(
                        request["messages"]
                            .to_string()
                            .contains("visible-original-marker")
                    );
                    if interrupted {
                        let delta = json!({"id":"summary","object":"chat.completion.chunk","created":1,"model":"test",
                            "choices":[{"index":0,"delta":{"content":"partial-summary-must-not-replay"},"finish_reason":null}]});
                        let failure = json!({"error":{"message":"summary stream failed","type":"server_error"}});
                        let body = format!("data: {delta}\n\ndata: {failure}\n\n");
                        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
                    } else {
                        fixture::respond(&mut socket, "malformed summary", "stop").await;
                    }
                }
            }
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = fixture::read_request(&mut socket).await;
            let messages = request["messages"].to_string();
            assert_eq!(
                request["max_tokens"], 4000,
                "All Main steps use the admitted limit"
            );
            assert!(messages.contains("maka.archived_tool_result"));
            assert!(
                messages.contains("visible-original-marker"),
                "bounded first page is visible"
            );
            for message in request["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|m| m["role"] == "tool")
            {
                assert!(message["content"].as_str().unwrap().encode_utf16().count() <= 7500);
            }
            assert!(!messages.contains("partial-summary-must-not-replay"));
            assert_eq!(messages.contains("summary-marker"), interrupted);
            let prefix = observed.prefix(200, 16 * 1024 * 1024).await.unwrap();
            let archives: Vec<_> = prefix
                .events
                .iter()
                .filter(|e| matches!(e.event.fact, Fact::ToolResultArchived { .. }))
                .collect();
            assert_eq!(archives.len(), call_count);
            assert!(prefix.events.iter().any(|e| matches!(&e.event.fact,
                Fact::ToolSettled { outcome: ToolOutcome::Succeeded { model_projection, .. }, .. }
                if serde_json::to_string(model_projection).unwrap().contains("visible-original-marker")
            )));
            fixture::respond(&mut socket, "done", "stop").await;
        });
        let count = Arc::new(AtomicUsize::new(0));
        let mut input = fixture::input(&base, "first", false);
        input.main_output_limit = Some(4000);
        input.context = Some(ModelRequestContext {
            provider_id: "openai".into(),
            context_window: Some(220),
            model_context_window: None,
            declared_window: spent.then_some(210),
        });
        input.work = RunWork::Message {
            allow_prior_unknown: false,
            source_messages: Vec::new(),
            message: "read".into(),
            tools: catalog(count.clone(), repeats),
            max_steps: 2,
        };
        let worker = fixture::engine(log.clone());
        if interrupted {
            worker
                .run(
                    fixture::input(&base, "old", false),
                    CancellationToken::new(),
                )
                .await
                .unwrap();
            worker
                .run(
                    fixture::input(&base, "baseline", true),
                    CancellationToken::new(),
                )
                .await
                .unwrap();
        }
        let previous = log
            .read_model_context("session", None, 200, 16 * 1024 * 1024)
            .await
            .unwrap()
            .baseline
            .map(|baseline| baseline.event_id);
        worker.run(input, CancellationToken::new()).await.unwrap();
        worker.drain().await;
        server.await.unwrap();
        assert_eq!(count.load(Ordering::SeqCst), call_count);
        let prefix = log.prefix(200, 16 * 1024 * 1024).await.unwrap();
        assert_eq!(
            prefix
                .events
                .iter()
                .filter(|stored| matches!(
                    stored.event.fact,
                    Fact::ContextCheckpointRecorded { .. }
                ))
                .count(),
            usize::from(interrupted)
        );
        let next = log
            .read_model_context("session", None, 200, 16 * 1024 * 1024)
            .await
            .unwrap()
            .baseline
            .map(|baseline| baseline.event_id);
        assert_eq!(previous, next);
        assert_eq!(
            prefix
                .events
                .iter()
                .filter(|stored| matches!(stored.event.fact, Fact::ModelInterrupted { .. }))
                .count(),
            usize::from(interrupted)
        );
        if interrupted {
            assert!(prefix.events.iter().any(|stored| matches!(&stored.event.fact,
                Fact::ModelObserved { event, .. } if serde_json::to_string(event).unwrap().contains("partial-summary-must-not-replay"))));
            assert_eq!(
                prefix
                    .events
                    .iter()
                    .filter(|stored| stored.event.invocation.invocation_id == "invocation-first")
                    .filter(|stored| matches!(
                        stored.event.fact,
                        Fact::ModelRequested {
                            purpose: maka_runtime::context::ModelPurpose::Summary,
                            ..
                        }
                    ))
                    .count(),
                1
            );
        }
        for stored in prefix.events {
            if let Fact::ModelRequested {
                purpose,
                effective_source_digest,
                ..
            } = stored.event.fact
            {
                assert_eq!(
                    effective_source_digest.is_some(),
                    purpose == maka_runtime::context::ModelPurpose::Summary
                );
            }
        }
    }
}
