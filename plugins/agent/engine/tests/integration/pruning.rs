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
use crate::support::store::SessionFixture;
use maka_agent_engine::RunWork;
use maka_agent_facts::context::ModelRequestContext;
use maka_agent_facts::event::{Fact, InvocationOutcome, ToolOutcome};
use maka_agent_facts::tools::ToolExecutor;
use maka_agent_facts::tools::ToolFuture;
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
            freeform: None,
            output_schema: None,
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
            SessionFixture::open(&directory.path().join("events.sqlite"))
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
            let mut main = None;
            let mut summaries = 0;
            let expected_summaries = if !spent { 0 } else { 1 };
            while summaries < expected_summaries || main.is_none() {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = fixture::read_request(&mut socket).await;
                if !request["messages"].to_string().contains(
                    maka_agent_facts::context::default_compaction_prompt(
                        maka_agent_facts::language::Language::En,
                    )
                    .lines()
                    .next()
                    .unwrap(),
                ) {
                    assert!(main.is_none());
                    main = Some((socket, request));
                    continue;
                }
                summaries += 1;
                assert!(summaries <= expected_summaries);
                assert_eq!(
                    request["max_tokens"], 8000,
                    "Summary budget is independent of the Main output budget"
                );
                assert!(
                    request["messages"]
                        .to_string()
                        .contains("visible-original-marker")
                );
                if interrupted {
                    let delta = json!({"id":"summary","object":"chat.completion.chunk","created":1,"model":"test",
                        "choices":[{"index":0,"delta":{"content":"partial-summary-must-not-replay"},"finish_reason":null}]});
                    let failure =
                        json!({"error":{"message":"summary stream failed","type":"server_error"}});
                    let body = format!("data: {delta}\n\ndata: {failure}\n\n");
                    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
                } else {
                    fixture::respond(&mut socket, "incomplete summary", "length").await;
                }
            }
            let (mut socket, request) = main.unwrap();
            // Do not cancel the last summary merely because Main has finished:
            // this case verifies a genuinely failed summary, not terminal abort.
            let mut commits = observed.subscribe_commits();
            loop {
                // Include the complete forty-call batch and its archived results.
                let prefix = observed.prefix(512, 16 * 1024 * 1024).await.unwrap();
                let summary_steps: Vec<_> = prefix
                    .events
                    .iter()
                    .filter_map(|stored| match &stored.event.fact {
                        Fact::ModelRequested {
                            step_id,
                            purpose: maka_agent_facts::context::ModelPurpose::Summary,
                            ..
                        } if stored.event.invocation.invocation_id == "invocation-first" => {
                            Some(step_id)
                        }
                        _ => None,
                    })
                    .collect();
                let settled = prefix
                    .events
                    .iter()
                    .filter(|stored| match &stored.event.fact {
                        Fact::ModelCompleted { step_id, .. }
                        | Fact::ModelInterrupted { step_id, .. } => {
                            summary_steps.contains(&step_id)
                        }
                        _ => false,
                    })
                    .count();
                if settled == expected_summaries {
                    break;
                }
                commits.changed().await.unwrap();
            }
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
            let prefix = observed.prefix(512, 16 * 1024 * 1024).await.unwrap();
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
            // The archived pages fit; the original multi-megabyte tool output
            // does not. The separate usage threshold selects summary attempts.
            context_window: Some(256_000),
            model_context_window: None,
            declared_window: spent.then_some(210),
        });
        input.work = RunWork::Message {
            allow_prior_unknown: false,
            source_messages: Vec::new(),
            message: "read".into(),
            tools: catalog(count.clone(), repeats),
        };
        let worker = fixture::engine();
        if interrupted {
            worker
                .run(
                    log.store(),
                    fixture::input(&base, "old", false),
                    CancellationToken::new(),
                )
                .await
                .unwrap();
            worker
                .run(
                    log.store(),
                    fixture::input(&base, "baseline", true),
                    CancellationToken::new(),
                )
                .await
                .unwrap();
        }
        let previous = log
            .read_model_view("session", None)
            .await
            .unwrap()
            .baseline
            .map(|baseline| baseline.event_id);
        worker
            .run(log.store(), input, CancellationToken::new())
            .await
            .unwrap();
        worker.drain().await;
        server.await.unwrap();
        assert_eq!(count.load(Ordering::SeqCst), call_count);
        let prefix = log.prefix(512, 16 * 1024 * 1024).await.unwrap();
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
            .read_model_view("session", None)
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
            usize::from(spent)
        );
        if spent {
            use maka_agent_facts::event::ModelInterruption;
            use maka_agent_facts::model::error::{ModelFailureCause, ProviderFailureReason};
            use maka_agent_facts::model::recorded::ModelObservation;
            let summary_steps: Vec<_> = prefix
                .events
                .iter()
                .filter_map(|stored| match &stored.event.fact {
                    Fact::ModelRequested {
                        step_id,
                        purpose: maka_agent_facts::context::ModelPurpose::Summary,
                        ..
                    } if stored.event.invocation.invocation_id == "invocation-first" => {
                        Some(step_id)
                    }
                    _ => None,
                })
                .collect();
            assert_eq!(summary_steps.len(), 1);
            let summary_step = summary_steps[0];
            let failed = prefix
                .events
                .iter()
                .find_map(|stored| match &stored.event.fact {
                    Fact::ModelInterrupted {
                        step_id,
                        status,
                        diagnostic,
                        model_failure,
                        partial,
                    } if step_id == summary_step => {
                        Some((status, diagnostic, model_failure, partial))
                    }
                    _ => None,
                })
                .expect("the failed Summary seals its original attempt");
            assert!(failed.3.is_none(), "failed Summary prose stays private");
            assert!(
                !prefix
                    .events
                    .iter()
                    .any(|stored| matches!(&stored.event.fact,
                Fact::ModelCompleted { step_id, .. } if step_id == summary_step)),
                "neither a failed stream nor an invalid complete summary is successful output"
            );
            let finished: Vec<_> = prefix
                .events
                .iter()
                .filter_map(|stored| match &stored.event.fact {
                    Fact::ModelObserved {
                        step_id,
                        event: ModelObservation::Finished { reason, usage, .. },
                    } if step_id == summary_step => Some((reason, usage)),
                    _ => None,
                })
                .collect();
            if interrupted {
                let summary_events: Vec<_> = prefix
                    .events
                    .iter()
                    .filter(|stored| match &stored.event.fact {
                        Fact::ModelObserved { step_id, .. }
                        | Fact::ModelCompleted { step_id, .. }
                        | Fact::ModelInterrupted { step_id, .. } => step_id == summary_step,
                        _ => false,
                    })
                    .collect();
                assert!(
                    !serde_json::to_string(&summary_events)
                        .unwrap()
                        .contains("partial-summary-must-not-replay")
                );
                assert!(summary_events.iter().any(|stored| matches!(&stored.event.fact,
                    Fact::ModelObserved { event: ModelObservation::ResponseMetadata { id: Some(id), .. }, .. }
                        if id == "summary")));
                assert!(prefix.events.iter().any(|stored| {
                    stored.event.invocation.invocation_id == "invocation-first"
                        && matches!(
                            stored.event.fact,
                            Fact::InvocationEnded {
                                outcome: InvocationOutcome::Completed
                            }
                        )
                }));
            }
            let private_text = if interrupted {
                assert_eq!(*failed.0, ModelInterruption::RetryableFailure);
                assert_eq!(
                    failed.2.as_ref(),
                    Some(&ModelFailureCause::Provider {
                        reason: ProviderFailureReason::ProviderUnavailable
                    })
                );
                assert!(
                    failed
                        .1
                        .as_deref()
                        .unwrap()
                        .contains("summary stream failed")
                );
                assert!(
                    finished.is_empty(),
                    "the provider failed before reporting a finish"
                );
                "partial-summary-must-not-replay"
            } else {
                assert_eq!(*failed.0, ModelInterruption::Failed);
                assert_eq!(failed.2.as_ref(), Some(&ModelFailureCause::Adapter));
                assert!(
                    failed
                        .1
                        .as_deref()
                        .unwrap()
                        .contains("summary_has_invalid_finish_reason")
                );
                assert_eq!(finished.len(), 1);
                assert_eq!(
                    *finished[0].0,
                    maka_agent_facts::model::ModelFinishReason::Length
                );
                assert_eq!(finished[0].1.input_tokens, Some(20));
                assert_eq!(finished[0].1.output_tokens, Some(50));
                "incomplete summary"
            };
            assert!(!prefix.events.iter().any(|stored| matches!(&stored.event.fact,
                Fact::ModelObserved { step_id, event } if step_id == summary_step && serde_json::to_string(event).unwrap().contains(private_text))),
                "failed Summary prose has no durable body representation");
        }
        for stored in prefix.events {
            if let Fact::ModelRequested {
                effective_source_digest,
                ..
            } = stored.event.fact
            {
                assert!(
                    effective_source_digest.is_some(),
                    "every request must retain its effective source for bundle validation"
                );
            }
        }
    }
}
