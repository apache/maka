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

use crate::support::context as support;
use crate::support::store::SessionFixture;
use maka_agent_facts::context::CompactOutcome;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::model::ModelPart;
use maka_agent_facts::model::recorded::{CompletionPart, ModelObservation};
use std::sync::Arc;
use support::*;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compact_next_main_and_reopen_use_durable_baseline_with_complete_tail() {
    let engine = || {
        let model = maka_model::ModelExecutor::new(std::time::Duration::from_secs(10)).unwrap();
        maka_agent_engine::Engine::new(
            model,
            maka_tools::CodeExecutor::new(Default::default()).unwrap(),
        )
        .unwrap()
    };
    let input = |base: &str, id: &str, compact| {
        let mut input = support::input(base, id, compact);
        input.configuration.system_prompt = Some(maka_agent_facts::execution::SystemPrompt {
            sources: Vec::new(),
            text: "MAIN_SYSTEM_PROMPT_EVIDENCE".into(),
            policy_revision: 3,
        });
        input
    };
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let mut requests = Vec::new();
        for text in [
            "old-answer-private",
            SUMMARY,
            "tail-answer",
            "reopened-answer",
        ] {
            let (mut socket, _) = listener.accept().await.unwrap();
            requests.push(read_request(&mut socket).await);
            respond(&mut socket, text, "stop").await;
        }
        requests
    });
    let log = Arc::new(SessionFixture::open(&path).await.unwrap());
    let worker = engine();
    worker
        .run(
            log.store(),
            input(&base, "old", false),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    worker
        .run(
            log.store(),
            input(&base, "compact", true),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let source = log.read_model_view("session", None).await.unwrap();
    let baseline = source.baseline.unwrap();
    assert_eq!(baseline.checkpoint.summary.text, SUMMARY);
    let checkpoint = baseline.event_id;
    worker
        .run(
            log.store(),
            input(&base, "tail", false),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    worker.drain().await;
    drop(worker);
    Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
    let log = Arc::new(SessionFixture::open(&path).await.unwrap());
    let worker = engine();
    worker
        .run(
            log.store(),
            input(&base, "reopen", false),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    worker.drain().await;
    let requests = server.await.unwrap();
    for index in [0, 2, 3] {
        assert_eq!(requests[index]["messages"][0]["role"], "system");
        assert!(
            requests[index]["messages"][0]["content"]
                .as_str()
                .unwrap()
                .starts_with("MAIN_SYSTEM_PROMPT_EVIDENCE")
        );
        assert_eq!(requests[index]["messages"][0], requests[0]["messages"][0]);
    }
    assert_eq!(requests[1]["messages"][0], requests[0]["messages"][0]);
    assert_eq!(requests[1]["messages"][1], requests[0]["messages"][1]);
    assert!(
        requests[1]["messages"]
            .to_string()
            .contains("old-answer-private")
    );
    assert_eq!(requests[1]["messages"][0]["role"], "system");
    assert!(
        requests[1]["messages"].as_array().unwrap().last().unwrap()["content"]
            .as_str()
            .unwrap()
            .contains(
                maka_agent_facts::context::default_compaction_prompt(
                    maka_agent_facts::language::Language::En
                )
                .lines()
                .next()
                .unwrap()
            )
    );
    assert!(requests[1]["tools"].as_array().is_none_or(Vec::is_empty));
    assert_eq!(requests[1]["max_tokens"], 8000);
    for request in &requests[2..] {
        assert!(
            request["messages"][1]["content"]
                .as_str()
                .unwrap()
                .contains(SUMMARY)
        );
        assert!(
            !request["messages"]
                .to_string()
                .contains("old-answer-private")
        );
        assert!(
            !request["messages"].to_string().contains(
                maka_agent_facts::context::default_compaction_prompt(
                    maka_agent_facts::language::Language::En
                )
                .lines()
                .next()
                .unwrap()
            )
        );
    }
    assert!(requests[3]["messages"].to_string().contains("tail-answer"));
    let prefix = log.prefix(100, 256 * 1024).await.unwrap();
    for event in prefix.events.iter().filter(|event| {
        matches!(
            event.event.invocation.invocation_id.as_str(),
            "invocation-tail" | "invocation-reopen"
        )
    }) {
        if let Fact::ModelRequested {
            checkpoint_event_id,
            ..
        } = &event.event.fact
        {
            assert_eq!(checkpoint_event_id.as_ref(), Some(&checkpoint));
        }
    }
    let legacy = maka_agent_engine::project_model_history(
        &prefix,
        "session",
        maka_agent_facts::language::Language::En,
    )
    .unwrap();
    assert!(
        !serde_json::to_string(&legacy)
            .unwrap()
            .contains("summary-marker"),
        "summary attempts never become ordinary history"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn incomplete_summary_fails_without_repair_and_main_retains_incomplete_text() {
    use crate::support::agent_loop;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::AsyncWriteExt;
    let directory = tempfile::tempdir().unwrap();
    let log = Arc::new(
        SessionFixture::open(&directory.path().join("events.sqlite"))
            .await
            .unwrap(),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let mut requests = Vec::new();
        for (text, reason) in [
            ("old", "stop"),
            ("cut", "length"),
            ("truncated-main", "length"),
            ("after-failure", "stop"),
        ] {
            let (mut socket, _) = listener.accept().await.unwrap();
            requests.push(read_request(&mut socket).await);
            if text == "truncated-main" {
                let partial = json!({"id":"partial","object":"chat.completion.chunk","created":1,"model":"test",
                    "choices":[{"index":0,"delta":{"content":text,"tool_calls":[{"index":0,"id":"unexecuted","type":"function",
                        "function":{"name":"echo","arguments":"{\"value\":42}"}}]},"finish_reason":null}]});
                let end = json!({"id":"partial","object":"chat.completion.chunk","created":1,"model":"test",
                    "choices":[{"index":0,"delta":{},"finish_reason":reason}]});
                let body = format!("data: {partial}\n\ndata: {end}\n\ndata: [DONE]\n\n");
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            } else {
                respond(&mut socket, text, reason).await;
            }
        }
        requests
    });
    let worker = engine();
    worker
        .run(
            log.store(),
            input(&base, "old", false),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    worker
        .run(
            log.store(),
            input(&base, "shorten", true),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let effects = Arc::new(AtomicUsize::new(0));
    let truncated_input = agent_loop::input(
        &base,
        "truncated",
        Arc::new(agent_loop::Effect {
            log: log.clone(),
            count: effects.clone(),
        }),
    );
    assert!(matches!(
        worker
            .run(log.store(), truncated_input, CancellationToken::new())
            .await,
        Err(maka_agent_engine::RunError::ModelIncomplete)
    ));
    assert_eq!(effects.load(Ordering::SeqCst), 0);
    worker
        .run(
            log.store(),
            input(&base, "after-failure", false),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let requests = server.await.unwrap();
    assert!(
        requests[3]["messages"]
            .to_string()
            .contains("truncated-main"),
        "valid incomplete text remains available to a new user message"
    );
    let prefix = log.prefix(100, 256 * 1024).await.unwrap();
    assert!(
        !prefix
            .events
            .iter()
            .any(|event| matches!(event.event.fact, Fact::ContextCheckpointRecorded { .. }))
    );
    assert!(prefix.events.iter().any(|event| matches!(
        &event.event.fact,
        Fact::InvocationEnded {
            outcome: InvocationOutcome::ContextCompactFinished {
                outcome: CompactOutcome::Failed { .. }
            }
        }
    )));
    let truncated: Vec<_> = prefix
        .events
        .iter()
        .filter(|event| event.event.invocation.invocation_id == "invocation-truncated")
        .collect();
    assert!(truncated.iter().any(|event| matches!(
        &event.event.fact,
        Fact::ToolRejected {
            reason: maka_agent_facts::tool_call::ToolRejection::PreparationFailed { .. },
            ..
        }
    )));
    assert!(
        !truncated
            .iter()
            .any(|event| matches!(event.event.fact, Fact::ToolDispatched { .. }))
    );
    assert!(
        truncated
            .iter()
            .any(|event| matches!(&event.event.fact, Fact::InvocationEnded {
                outcome: InvocationOutcome::Failed { class, .. }
            } if class == "model_incomplete"))
    );
    assert!(
        truncated
            .iter()
            .any(|event| matches!(event.event.fact, Fact::ModelCompleted { .. }))
    );
    assert!(truncated.iter().any(|event| match &event.event.fact {
        Fact::ModelCompleted { output, .. } => output.parts.iter().any(|part| match part {
            CompletionPart::Own(record) => matches!(record.part.as_ref(), ModelPart::Text { text, .. } if text.chunks().collect::<String>() == "truncated-main"),
            CompletionPart::Ref(_) => false,
        }),
        _ => false,
    }), "Main incomplete prose is durably owned by its terminal completion");
    assert!(!prefix.events.iter().any(|event| match &event.event.fact {
        Fact::ModelCompleted { output, .. } => output.parts.iter().any(|part| match part {
            CompletionPart::Own(record) => matches!(record.part.as_ref(), ModelPart::Text { text, .. } if text.chunks().collect::<String>() == "cut"),
            CompletionPart::Ref(_) => false,
        }),
        Fact::ModelInterrupted { partial: Some(partial), .. } => partial.parts.iter().any(|part| match part {
            CompletionPart::Own(record) => matches!(record.part.as_ref(), ModelPart::Text { text, .. } if text.chunks().collect::<String>() == "cut"),
            CompletionPart::Ref(_) => false,
        }),
        _ => false,
    }), "a failed Summary does not publish its private prose");

    worker.drain().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn summary_advertised_tools_never_execute() {
    use crate::support::agent_loop;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::AsyncWriteExt;
    let directory = tempfile::tempdir().unwrap();
    let log = Arc::new(
        SessionFixture::open(&directory.path().join("events.sqlite"))
            .await
            .unwrap(),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let main = read_request(&mut socket).await;
        respond(&mut socket, "ordinary answer", "stop").await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let summary = read_request(&mut socket).await;
        assert_eq!(summary["tools"], main["tools"]);
        let call = serde_json::json!({"id":"summary","object":"chat.completion.chunk","created":1,"model":"test",
            "choices":[{"index":0,"delta":{"content":"private forbidden summary prose","tool_calls":[{"index":0,"id":"forbidden","type":"function",
            "function":{"name":"echo","arguments":"{}"}}]},"finish_reason":null}]});
        let end = serde_json::json!({"id":"summary","object":"chat.completion.chunk","created":1,"model":"test",
            "choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],
            "usage":{"prompt_tokens":13,"completion_tokens":7,"total_tokens":20}});
        let body = format!("data: {call}\n\ndata: {end}\n\ndata: [DONE]\n\n");
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let recovered = read_request(&mut socket).await;
        let messages = recovered["messages"].to_string();
        assert!(messages.contains("ordinary answer"));
        assert!(!messages.contains("private forbidden summary prose"));
        assert!(!messages.contains("forbidden"));
        respond(&mut socket, "recovered answer", "stop").await;
    });
    let effects = Arc::new(AtomicUsize::new(0));
    let worker = engine();
    let mut main = input(&base, "main", false);
    main.work = agent_loop::input(
        &base,
        "main",
        Arc::new(agent_loop::Effect {
            log: log.clone(),
            count: effects.clone(),
        }),
    )
    .work;
    worker
        .run(log.store(), main, CancellationToken::new())
        .await
        .unwrap();
    assert!(
        worker
            .run(
                log.store(),
                input(&base, "compact", true),
                CancellationToken::new()
            )
            .await
            .is_err()
    );
    worker.drain().await;
    worker
        .run(
            log.store(),
            input(&base, "recovered", false),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    worker.drain().await;
    server.await.unwrap();
    assert_eq!(effects.load(Ordering::SeqCst), 0);
    assert!(
        log.read_model_view("session", None)
            .await
            .unwrap()
            .baseline
            .is_none()
    );
    let events = log.prefix(100, 256 * 1024).await.unwrap();
    let summary_step = events
        .events
        .iter()
        .find_map(|event| match &event.event.fact {
            Fact::ModelRequested {
                step_id,
                purpose: maka_agent_facts::context::ModelPurpose::Summary,
                ..
            } => Some(step_id),
            _ => None,
        })
        .unwrap();
    assert!(
        !events.events.iter().any(|event| matches!(&event.event.fact,
        Fact::ModelObserved { step_id, event: ModelObservation::Part(_) }
            if step_id == summary_step)),
        "an unexecuted local Summary request stays private"
    );
    assert!(
        !events.events.iter().any(|event| matches!(&event.event.fact,
        Fact::ModelCompleted { step_id, .. } if step_id == summary_step)),
        "invalid tool output has no completed summary to supply usage"
    );
    assert!(events.events.iter().any(|event| matches!(&event.event.fact,
        Fact::ModelInterrupted { step_id, partial: None, .. } if step_id == summary_step)));
    assert!(
        !serde_json::to_string(&events.events)
            .unwrap()
            .contains("private forbidden summary prose")
    );
    let summary_request = events
        .events
        .iter()
        .find(|event| {
            matches!(&event.event.fact,
        Fact::ModelRequested { step_id, .. } if step_id == summary_step)
        })
        .unwrap();
    let usage = log
        .root()
        .usage_activity(
            maka_event_log::root_store::UsageQuery {
                from: 0.0,
                to: f64::MAX,
                session_id: Some("session".into()),
                through: None,
            },
            maka_agent_facts::accounting::Selection::default(),
            None,
        )
        .await
        .unwrap();
    let attempt = usage
        .attempts
        .iter()
        .find_map(|activity| match activity {
            maka_agent_facts::accounting::Activity::Model(attempt)
                if attempt.request_id == summary_request.event.id =>
            {
                Some(attempt)
            }
            _ => None,
        })
        .unwrap();
    assert_eq!(attempt.usage.input_tokens, Some(13));
    assert_eq!(
        attempt.usage.output_tokens,
        Some(7),
        "Finished usage remains accountable without ModelCompleted"
    );
    assert!(
        !events
            .events
            .iter()
            .any(|event| matches!(event.event.fact, Fact::ToolDispatched { .. }))
    );
}
