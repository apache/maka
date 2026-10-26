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
    let checkpoint = source.baseline.unwrap().event_id;
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
    let summary = prefix
        .events
        .iter()
        .find(|stored| {
            matches!(
                stored.event.fact,
                Fact::ModelRequested {
                    purpose: maka_agent_facts::context::ModelPurpose::Summary,
                    ..
                }
            )
        })
        .unwrap();
    let composition = log
        .request_composition("session", &summary.event.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(composition.max_output_tokens, Some(8000));
    assert_eq!(
        composition.system_prompt.as_deref(),
        Some("MAIN_SYSTEM_PROMPT_EVIDENCE")
    );
    let first_request = prefix
        .events
        .iter()
        .find(|stored| matches!(stored.event.fact, Fact::ModelRequested { .. }))
        .unwrap();
    let original = log
        .request_composition("session", &first_request.event.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(composition.dynamic_context, original.dynamic_context);
    let adapter = original
        .sources
        .iter()
        .find(|source| source.kind == maka_agent_facts::composition::SourceKind::ModelAdapter)
        .unwrap();
    assert_eq!(adapter.name, "chat-completions");
    assert!(composition.sources.contains(adapter));
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
async fn arbitrary_completed_summary_is_accepted_without_format_repair() {
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
        for text in ["old-answer", "invalid-summary", "next-answer"] {
            let (mut socket, _) = listener.accept().await.unwrap();
            requests.push(read_request(&mut socket).await);
            respond(&mut socket, text, "stop").await;
        }
        requests
    });
    let worker = engine();
    for (id, compact) in [("old", false), ("bad", true), ("next", false)] {
        worker
            .run(
                log.store(),
                input(&base, id, compact),
                CancellationToken::new(),
            )
            .await
            .unwrap();
    }
    let prefix = log.prefix(100, 256 * 1024).await.unwrap();
    assert!(prefix.events.iter().any(|event| matches!(&event.event.fact,
        Fact::ContextCheckpointRecorded { checkpoint } if checkpoint.summary.text == "invalid-summary")));
    let requests = server.await.unwrap();
    assert_eq!(requests.len(), 3);
    assert!(
        requests[2]["messages"]
            .to_string()
            .contains("invalid-summary")
    );
    assert!(!requests[2]["messages"].to_string().contains("old-answer"));
    worker.drain().await;
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
    worker.drain().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn summary_preserves_main_prefix_tools_and_custom_instruction_with_independent_budget() {
    use crate::support::agent_loop;
    use std::sync::atomic::{AtomicUsize, Ordering};
    for (window, main_budget, expected_budget) in [
        (None, Some(128), 8000),
        (Some(1_000_000), Some(128), 40_000),
        (Some(1_000_000), Some(64_000), 64_000),
        (Some(128_000), None, 8000),
        (Some(128_000), Some(128), 5120),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let log = Arc::new(
            SessionFixture::open(&directory.path().join("events.sqlite"))
                .await
                .unwrap(),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let mut requests = vec![];
            for text in ["original answer", "自由格式摘要", "next answer", ""] {
                let (mut socket, _) = listener.accept().await.unwrap();
                requests.push(read_request(&mut socket).await);
                respond(&mut socket, text, "stop").await;
            }
            requests
        });
        let effects = Arc::new(AtomicUsize::new(0));
        let worker = engine();
        for (id, compact) in [
            ("first", false),
            ("compact", true),
            ("next", false),
            ("again", true),
        ] {
            let mut run = input(&base, id, compact);
            run.main_output_limit = main_budget;
            run.context = Some(maka_agent_facts::context::ModelRequestContext {
                provider_id: "fixture".into(),
                context_window: window,
                model_context_window: window,
                declared_window: None,
            });
            run.configuration.system_prompt = Some(maka_agent_facts::execution::SystemPrompt {
                text: if compact {
                    "different compact invocation system"
                } else {
                    "frozen ordinary main system"
                }
                .into(),
                sources: vec![],
                policy_revision: 1,
            });
            if compact {
                run.configuration.compaction_prompt = Some("只保留下一步；可使用任意格式。".into());
            } else {
                run.work = agent_loop::input(
                    &base,
                    id,
                    Arc::new(agent_loop::Effect {
                        log: log.clone(),
                        count: effects.clone(),
                    }),
                )
                .work;
            }
            worker
                .run(log.store(), run, CancellationToken::new())
                .await
                .unwrap();
        }
        worker.drain().await;
        let requests = server.await.unwrap();
        for (main, summary) in [(0, 1), (2, 3)] {
            let prefix = requests[main]["messages"].as_array().unwrap();
            let compact = requests[summary]["messages"].as_array().unwrap();
            assert_eq!(&compact[..prefix.len()], prefix);
            assert_eq!(
                compact.len(),
                prefix.len() + 2,
                "one completed assistant message and one compaction instruction"
            );
            assert_eq!(compact.last().unwrap()["role"], "user");
            assert_eq!(
                compact.last().unwrap()["content"],
                "只保留下一步；可使用任意格式。"
            );
            assert_eq!(requests[summary]["tools"], requests[main]["tools"]);
            assert!(!requests[main]["tools"].as_array().unwrap().is_empty());
            assert_eq!(requests[summary]["max_tokens"], expected_budget);
            assert_eq!(requests[main]["max_tokens"], main_budget.unwrap_or(8000));
        }
        assert_eq!(effects.load(Ordering::SeqCst), 0);
        let context = log.read_model_view("session", None).await.unwrap();
        assert_eq!(context.baseline.unwrap().checkpoint.summary.text, "");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn summary_only_excerpts_after_provider_overflow_with_frozen_composition() {
    use tokio::io::AsyncWriteExt;
    let directory = tempfile::tempdir().unwrap();
    let log = Arc::new(
        SessionFixture::open(&directory.path().join("events.sqlite"))
            .await
            .unwrap(),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let original = "history-marker ".repeat(3000);
    let expected = original.clone();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        read_request(&mut socket).await;
        respond(&mut socket, &original, "stop").await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let full = read_request(&mut socket).await;
        let body = r#"{"error":{"message":"request exceeds context","type":"invalid_request_error","code":"context_length_exceeded"}}"#;
        socket.write_all(format!("HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let fitted = read_request(&mut socket).await;
        respond(&mut socket, "brief arbitrary summary", "stop").await;
        (full, fitted)
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
    let mut compact = input(&base, "compact", true);
    compact.main_output_limit = Some(128);
    compact.context = Some(maka_agent_facts::context::ModelRequestContext {
        provider_id: "fixture".into(),
        context_window: Some(10_000),
        model_context_window: Some(10_000),
        declared_window: None,
    });
    worker
        .run(log.store(), compact, CancellationToken::new())
        .await
        .unwrap();
    worker.drain().await;
    let (full, fitted) = server.await.unwrap();
    assert!(full["messages"].to_string().contains(&expected));
    assert!(
        !full["messages"]
            .to_string()
            .contains("Conversation excerpts")
    );
    assert!(
        fitted["messages"]
            .to_string()
            .contains("Conversation excerpts")
    );
    assert!(fitted.to_string().len() < full.to_string().len());
    assert_eq!(full["max_tokens"], 400);
    assert_eq!(fitted["max_tokens"], 400);
    let events = log.prefix(100, 1024 * 1024).await.unwrap();
    let mut compositions = vec![];
    for event in events.events.iter().filter(|event| {
        matches!(
            event.event.fact,
            Fact::ModelRequested {
                purpose: maka_agent_facts::context::ModelPurpose::Summary,
                ..
            }
        )
    }) {
        compositions.push(
            log.request_composition("session", &event.event.id)
                .await
                .unwrap()
                .unwrap(),
        );
    }
    assert_eq!(compositions.len(), 2);
    assert_eq!(compositions[0], compositions[1]);
    assert!(events.events.iter().any(|event| matches!(&event.event.fact,
        Fact::ContextCheckpointRecorded { checkpoint } if checkpoint.summary.text == "brief arbitrary summary")));
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
            "choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"forbidden","type":"function",
            "function":{"name":"echo","arguments":"{}"}}]},"finish_reason":null}]});
        let end = serde_json::json!({"id":"summary","object":"chat.completion.chunk","created":1,"model":"test",
            "choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]});
        let body = format!("data: {call}\n\ndata: {end}\n\ndata: [DONE]\n\n");
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
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
    assert!(
        !events
            .events
            .iter()
            .any(|event| matches!(event.event.fact, Fact::ToolDispatched { .. }))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn overflow_preserves_system_and_first_goal_or_continuation_summary() {
    use tokio::io::AsyncWriteExt;
    const GOAL: &str = "UNIQUE_ORIGINAL_GOAL: recover the launch checklist";
    const SYSTEM: &str = "Preserve trusted system instructions exactly.";
    for baseline in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let log = Arc::new(
            SessionFixture::open(&directory.path().join("events.sqlite"))
                .await
                .unwrap(),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let mut responses = vec!["initial answer".to_string()];
            if baseline {
                responses.push(GOAL.into());
            }
            responses.extend(
                (0..3)
                    .map(|index| format!("large turn {index}: {}", "recent detail ".repeat(3000))),
            );
            for response in responses {
                let (mut socket, _) = listener.accept().await.unwrap();
                read_request(&mut socket).await;
                respond(&mut socket, &response, "stop").await;
            }
            let (mut socket, _) = listener.accept().await.unwrap();
            let full = read_request(&mut socket).await;
            let body = r#"{"error":{"message":"context exceeded","type":"invalid_request_error","code":"context_length_exceeded"}}"#;
            socket.write_all(format!("HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            let (mut socket, _) = listener.accept().await.unwrap();
            let fitted = read_request(&mut socket).await;
            respond(&mut socket, "final summary", "stop").await;
            (full, fitted)
        });
        let worker = engine();
        let mut stages = vec![("first", false)];
        if baseline {
            stages.push(("baseline", true));
        }
        stages.extend([
            ("one", false),
            ("two", false),
            ("three", false),
            ("final", true),
        ]);
        for (id, compact) in stages {
            let mut run = input(&base, id, compact);
            run.configuration.system_prompt = Some(maka_agent_facts::execution::SystemPrompt {
                text: SYSTEM.into(),
                sources: vec![],
                policy_revision: 1,
            });
            if id == "first"
                && let maka_agent_engine::RunWork::Message { message, .. } = &mut run.work
            {
                *message = GOAL.into();
            }
            if id == "final" {
                run.context = Some(maka_agent_facts::context::ModelRequestContext {
                    provider_id: "fixture".into(),
                    context_window: Some(10_000),
                    model_context_window: Some(10_000),
                    declared_window: None,
                });
            }
            worker
                .run(log.store(), run, CancellationToken::new())
                .await
                .unwrap();
        }
        worker.drain().await;
        let (full, fitted) = server.await.unwrap();
        assert_eq!(full["messages"][0], fitted["messages"][0]);
        assert_eq!(fitted["messages"][0]["role"], "system");
        let system = fitted["messages"][0]["content"].as_str().unwrap();
        assert!(system.starts_with(SYSTEM));
        let events = log.prefix(100, 1024 * 1024).await.unwrap();
        let breakdowns: Vec<_> = events
            .events
            .iter()
            .filter(|event| event.event.invocation.invocation_id == "invocation-final")
            .filter_map(|event| match &event.event.fact {
                Fact::ModelRequested {
                    context_breakdown: Some(breakdown),
                    ..
                } => Some(breakdown),
                _ => None,
            })
            .collect();
        assert_eq!(breakdowns.len(), 2);
        for breakdown in breakdowns {
            assert_eq!(breakdown.system.content_bytes, system.len() as u64);
        }
        assert!(full["messages"].to_string().contains(GOAL));
        assert!(
            !full["messages"]
                .to_string()
                .contains("Conversation excerpts")
        );
        let content = &fitted["messages"][1]["content"];
        let excerpt = if let Some(text) = content.as_str() {
            text.to_owned()
        } else {
            content
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|part| part["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        };
        assert!(excerpt.contains("Earlier task or summary:"));
        assert!(
            excerpt.contains(GOAL),
            "first conversational anchor must survive: {excerpt}"
        );
        assert!(excerpt.contains("large turn 2"));
        assert!(fitted.to_string().len() < full.to_string().len());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn small_window_caps_summary_output_and_compacts_only_for_input_pressure() {
    for (manual, large_history, output_limit) in [
        (true, false, None),
        (false, false, Some(200_000)),
        (false, true, Some(200_000)),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let log = Arc::new(
            SessionFixture::open(&directory.path().join("events.sqlite"))
                .await
                .unwrap(),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let summarized = manual || large_history;
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_request(&mut socket).await;
            let history = if large_history {
                "retained history ".repeat(1000)
            } else {
                "short history".into()
            };
            respond(&mut socket, &history, "stop").await;
            let mut requests = Vec::new();
            for _ in 0..if summarized && !manual { 2 } else { 1 } {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = read_request(&mut socket).await;
                let is_summary = request["messages"].to_string().contains(
                    maka_agent_facts::context::default_compaction_prompt(
                        maka_agent_facts::language::Language::En,
                    )
                    .lines()
                    .next()
                    .unwrap(),
                );
                respond(
                    &mut socket,
                    if is_summary {
                        "brief checkpoint"
                    } else {
                        "done"
                    },
                    "stop",
                )
                .await;
                requests.push(request);
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
        let mut next = input(&base, "next", manual);
        next.main_output_limit = output_limit;
        next.context = Some(maka_agent_facts::context::ModelRequestContext {
            provider_id: "fixture".into(),
            context_window: Some(4096),
            model_context_window: Some(4096),
            declared_window: None,
        });
        worker
            .run(log.store(), next, CancellationToken::new())
            .await
            .unwrap();
        worker.drain().await;
        let requests = server.await.unwrap();
        let summaries: Vec<_> = requests
            .iter()
            .filter(|request| {
                request["messages"].to_string().contains(
                    maka_agent_facts::context::default_compaction_prompt(
                        maka_agent_facts::language::Language::En,
                    )
                    .lines()
                    .next()
                    .unwrap(),
                )
            })
            .collect();
        assert_eq!(summaries.len(), usize::from(summarized));
        for request in &requests {
            let output = request["max_tokens"].as_u64().unwrap();
            assert!((1..4096).contains(&output));
        }
        if large_history {
            assert_eq!(summaries[0]["max_tokens"], 164);
            assert!(
                summaries[0]["messages"]
                    .to_string()
                    .contains("retained history")
            );
            assert!(
                requests[1]["messages"]
                    .to_string()
                    .contains("brief checkpoint")
            );
        } else if manual {
            assert!(summaries[0]["max_tokens"].as_u64().unwrap() > 164);
        }
    }
}

#[tokio::test]
async fn new_summary_uses_captured_language_without_retranslating_the_prior_main_prefix() {
    use maka_agent_facts::language::Language;
    for (language, summary_instruction, context_label) in [
        (
            Language::ZhCn,
            maka_agent_facts::context::default_compaction_prompt(Language::ZhCn),
            "会话上下文",
        ),
        (
            Language::ZhTw,
            maka_agent_facts::context::default_compaction_prompt(Language::ZhTw),
            "工作階段上下文",
        ),
    ] {
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
            respond(&mut socket, "opaque prior answer 原文", "stop").await;
            let (mut socket, _) = listener.accept().await.unwrap();
            let summary = read_request(&mut socket).await;
            respond(&mut socket, SUMMARY, "stop").await;
            (main, summary)
        });
        let worker = engine();
        let mut original = input(&base, "original", false);
        original.configuration.system_prompt = Some(maka_agent_facts::execution::SystemPrompt {
            text: "Original custom prefix 原文".into(),
            policy_revision: 0,
            sources: vec![],
        });
        worker
            .run(log.store(), original, CancellationToken::new())
            .await
            .unwrap();
        let mut compact = input(&base, "translated-summary", true);
        compact.configuration.language = language;
        compact.configuration.system_prompt = Some(maka_agent_facts::execution::SystemPrompt {
            text: "This current prefix must not replace the prior Main surface".into(),
            policy_revision: 0,
            sources: vec![],
        });
        worker
            .run(log.store(), compact, CancellationToken::new())
            .await
            .unwrap();
        worker.drain().await;
        let (main, summary) = server.await.unwrap();
        assert!(
            main["messages"][0]["content"]
                .as_str()
                .unwrap()
                .contains("Original custom prefix 原文")
        );
        let system = summary["messages"][0]["content"].as_str().unwrap();
        assert!(system.starts_with("Original custom prefix 原文"));
        assert!(system.contains(context_label));
        assert!(!system.contains("This current prefix"));
        let messages = summary["messages"].as_array().unwrap();
        assert!(
            messages.last().unwrap()["content"]
                .as_str()
                .unwrap()
                .contains(summary_instruction)
        );
        assert!(
            messages
                .iter()
                .any(|message| message["content"] == "opaque prior answer 原文")
        );
        let prefix = log.prefix(100, 128 * 1024).await.unwrap();
        let summary_request = prefix
            .events
            .iter()
            .find(|event| {
                matches!(
                    event.event.fact,
                    Fact::ModelRequested {
                        purpose: maka_agent_facts::context::ModelPurpose::Summary,
                        ..
                    }
                )
            })
            .unwrap();
        let frozen = log
            .request_composition("session", &summary_request.event.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            frozen.system_prompt.as_deref(),
            Some("Original custom prefix 原文")
        );
        log.shutdown().await.unwrap();
    }
}
