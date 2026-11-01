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
use crate::support::agent_loop;
use crate::support::store::SessionFixture;
use maka_agent_engine::Engine;
use serde_json::json;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

fn engine() -> Engine {
    Engine::new(
        maka_model::ModelExecutor::new(Duration::from_secs(10)).unwrap(),
        maka_tools::CodeExecutor::new(Default::default()).unwrap(),
    )
    .unwrap()
}

async fn respond_tail_call(
    socket: &mut tokio::net::TcpStream,
    id: &str,
    value: impl serde::Serialize,
) {
    let delta = json!({"id":"tail","object":"chat.completion.chunk","created":1,"model":"test",
        "choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":id,"type":"function","function":{"name":"echo","arguments":json!({"value":value}).to_string()}}]},"finish_reason":null}]});
    let end = json!({"id":"tail","object":"chat.completion.chunk","created":1,"model":"test",
        "choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}});
    let body = format!("data: {delta}\n\ndata: {end}\n\ndata: [DONE]\n\n");
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn background_summary_preserves_steering_tool_tail_and_frozen_physical_retry() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let directory = tempfile::tempdir().unwrap();
        let log = Arc::new(SessionFixture::open(&directory.path().join("events.sqlite")).await.unwrap());

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let count = Arc::new(AtomicUsize::new(0));
        let mut next = agent_loop::input(&base, "next", Arc::new(agent_loop::Effect {
            log: log.clone(), count: count.clone(),
        }));
        next.configuration.model = fixture::input(&base, "unused", false).configuration.model;
        next.context = context(Some(70));
        next.provider.auth = maka_model::ProviderAuth::ApiKey("fixture".into());
        let invocation = next.invocation.clone();
        let observed = log.clone();
        let server = tokio::spawn(async move {
            let (mut old, _) = listener.accept().await.unwrap();
            fixture::read_request(&mut old).await;
            fixture::respond(&mut old, "old-answer", "stop").await;
            let mut summary = None;
            let mut main = None;
            // Both requests must arrive while neither has a response. With a
            // serialized compactor this gate cannot progress.
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = fixture::read_request(&mut socket).await;
                if request["messages"].to_string().contains(maka_agent_facts::context::default_compaction_prompt(maka_agent_facts::language::Language::En).lines().next().unwrap()) {
                    assert!(!request["messages"].to_string().contains("question next"));
                    assert!(!request["messages"].to_string().contains("A queued correction"));
                    assert!(!request["messages"].to_string().contains("during-summary-call"));
                    summary = Some(socket);
                } else {
                    assert!(request["messages"].to_string().contains("old-answer"));
                    main = Some(socket);
                }
            }
            let mut summary = summary.unwrap();
            let mut main = main.unwrap();
            agent_loop::enqueue(&observed, invocation).await;
            respond_tail_call(&mut main, "during-summary-call", 41).await;
            let (mut main, _) = listener.accept().await.unwrap();
            let frozen = fixture::read_request(&mut main).await;
            assert!(frozen["messages"].to_string().contains("A queued correction"));
            assert!(!frozen["messages"].to_string().contains("summary-marker"));
            // The first operation has settled and steering has been projected
            // while the summarizer still holds its original captured request.
            let during = observed.prefix(200, 512 * 1024).await.unwrap();
            let captured_cut = during.events.iter().find_map(|event| match event.event.fact {
                Fact::ModelRequested { purpose: ModelPurpose::Summary, source_high_water, .. } => Some(source_high_water),
                _ => None,
            }).unwrap();
            for event in during.events.iter().filter(|event| matches!(&event.event.fact,
                Fact::MessageSteered { .. } | Fact::ToolDispatched { .. } | Fact::ToolSettled { .. })) {
                assert!(event.sequence > captured_cut, "steering and operation transitions belong after the summary cutoff");
            }
            let frozen_messages = frozen["messages"].as_array().unwrap();
            let tail_start = frozen_messages.iter().position(|message| message["content"].as_str().is_some_and(|text| text.contains("question next"))).unwrap();
            let frozen_tail = &frozen_messages[tail_start..];
            assert_eq!(frozen_tail.iter().filter(|message| message["role"] == "tool").count(), 1);
            assert!(frozen_tail.iter().any(|message| message["role"] == "tool" && message["content"].as_str().is_some_and(|text| text.contains("41"))));
            let mut commits = observed.subscribe_commits();
            fixture::respond(&mut summary, fixture::SUMMARY, "stop").await;
            loop {
                let prefix = observed.prefix(200, 512 * 1024).await.unwrap();
                if prefix.events.iter().any(|e| matches!(&e.event.fact,
                    Fact::ModelCompleted { output, .. } if serde_json::to_string(output).unwrap().contains("summary-marker"))) { break; }
                commits.changed().await.unwrap();
            }
            let failure = r#"{"error":{"message":"retry","type":"rate_limit_error"}}"#;
            main.write_all(format!("HTTP/1.1 429 Too Many Requests\r\nRetry-After: 0.01\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{failure}", failure.len()).as_bytes()).await.unwrap();
            let (mut retry, _) = listener.accept().await.unwrap();
            assert_eq!(fixture::read_request(&mut retry).await, frozen);
            respond_tail_call(&mut retry, "after-summary-call", 42).await;
            let (mut last, _) = listener.accept().await.unwrap();
            let adopted = fixture::read_request(&mut last).await;
            let messages = adopted["messages"].to_string();
            assert!(messages.contains("summary-marker"));
            assert!(!messages.contains("old-answer"));
            assert_eq!(messages.matches("A queued correction").count(), 1);
            let adopted_messages = adopted["messages"].as_array().unwrap();
            let adopted_tail_start = adopted_messages.iter().position(|message| message["content"].as_str().is_some_and(|text| text.contains("question next"))).unwrap();
            assert!(adopted_messages[..adopted_tail_start].iter().any(|message| message["content"].as_str().is_some_and(|text| text.contains("summary-marker"))));
            assert_eq!(&adopted_messages[adopted_tail_start..adopted_tail_start + frozen_tail.len()], frozen_tail, "all history captured during compaction follows the checkpoint once and in its original order");
            let new_tail = &adopted_messages[adopted_tail_start + frozen_tail.len()..];
            assert_eq!(new_tail.len(), 2, "the later accepted operation adds exactly its call and result");
            assert_eq!(new_tail[0]["tool_calls"][0]["id"], "after-summary-call");
            assert_eq!(new_tail[1]["role"], "tool");
            assert_eq!(new_tail[1]["tool_call_id"], "after-summary-call");
            assert!(new_tail[1]["content"].as_str().unwrap().contains("42"));
            assert_eq!(adopted_messages.iter().filter(|message| message["tool_call_id"] == "during-summary-call").count(), 1);
            assert_eq!(adopted_messages.iter().filter(|message| message["tool_call_id"] == "after-summary-call").count(), 1);
            let completed = observed.prefix(200, 512 * 1024).await.unwrap();
            let checkpoint = completed.events.iter().find_map(|event| match &event.event.fact {
                Fact::ContextCheckpointRecorded { checkpoint } => Some(checkpoint), _ => None,
            }).unwrap();
            assert_eq!(checkpoint.covered_through, captured_cut, "checkpoint coverage stays at capture time rather than swallowing newer history");
            fixture::respond(&mut last, "done", "stop").await;
        });
        let worker = engine();
        let mut old = fixture::input(&base, "old", false);
        old.context = context(None);
        worker.run(log.store(), old, CancellationToken::new()).await.unwrap();
        worker.run(log.store(), next, CancellationToken::new()).await.unwrap();
        worker.drain().await;
        server.await.unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 2, "each accepted tool effect happens once");
        let source = log.read_model_view("session", None).await.unwrap();
        assert!(source.baseline.is_some());
        assert!(log.unfinished_invocations(0, 10).await.unwrap().invocations.is_empty());
    }).await.expect("background work and physical retries must settle");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn background_summary_drains_before_terminal_handoff_and_retirement() {
    for ending in ["complete", "cancel", "handoff", "retire", "summary-tool"] {
        tokio::time::timeout(Duration::from_secs(20), async {
            use tokio::io::AsyncReadExt;
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("events.sqlite");
            let log = Arc::new(SessionFixture::open(&path).await.unwrap());

            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let count = Arc::new(AtomicUsize::new(0));
            let mut next = agent_loop::input(&base, "next", Arc::new(agent_loop::Effect {
                log: log.clone(), count: count.clone(),
            }));
            next.configuration.model = fixture::input(&base, "unused", false).configuration.model;
            next.configuration.workspace_identity = Some(maka_agent_facts::execution::WorkspaceIdentity::from_marker_id(
                "ef751105-55b5-4d65-a364-646281586a17").unwrap());
            next.context = context(Some(70));
            next.provider.auth = maka_model::ProviderAuth::ApiKey("fixture".into());
            let (seen, ready) = tokio::sync::oneshot::channel();
            let (release, released) = tokio::sync::oneshot::channel();
            let server = tokio::spawn(async move {
                let (mut old, _) = listener.accept().await.unwrap();
                fixture::read_request(&mut old).await;
                fixture::respond(&mut old, "old", "stop").await;
                let mut summary = None;
                let mut main = None;
                for _ in 0..2 {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let request = fixture::read_request(&mut socket).await;
                    if request["messages"].to_string().contains(maka_agent_facts::context::default_compaction_prompt(maka_agent_facts::language::Language::En).lines().next().unwrap()) {
                        if ending != "summary-tool" {
                        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
                        let delta = json!({"id":"summary","object":"chat.completion.chunk","created":1,"model":"test",
                            "choices":[{"index":0,"delta":{"content":"private unfinished summary"},"finish_reason":null}]});
                        socket.write_all(format!("data: {delta}\n\n").as_bytes()).await.unwrap();
                        }
                        summary = Some(socket);
                    } else { main = Some(socket); }
                }
                if ending == "summary-tool" {
                    agent_loop::respond(summary.as_mut().unwrap(), true).await;
                }
                seen.send(()).unwrap();
                released.await.unwrap();
                let mut main = main.unwrap();
                if !matches!(ending, "cancel" | "retire") { agent_loop::respond(&mut main, ending == "handoff").await; }
                let _ = summary.unwrap().read_to_end(&mut Vec::new()).await;
            });
            let worker = engine();
            let mut old = fixture::input(&base, "old", false);
            old.context = context(None);
            worker.run(log.store(), old, CancellationToken::new()).await.unwrap();
            let running = worker.start(log.store(), next, CancellationToken::new()).await.unwrap();
            ready.await.unwrap();
            if ending == "summary-tool" {
                let mut commits = log.subscribe_commits();
                loop {
                    let prefix = log.prefix(200, 512 * 1024).await.unwrap();
                    if prefix.events.iter().any(|e| matches!(&e.event.fact,
                        Fact::ModelInterrupted { partial: None, .. })) { break; }
                    commits.changed().await.unwrap();
                }
            }
            let reservation = if ending == "handoff" {
                Some(running.handoff().unwrap().reserve(maka_agent_facts::handoff::HandoffIntent {
                    handoff_id: "background".into(), host_epoch: "host".into(), root_run_id: "run-next".into(),
                    successor_run_id: "successor-run".into(), successor_invocation_id: "successor-invocation".into(),
                    claim_id: "claim".into(),
                }).unwrap())
            } else { None };
            if ending == "retire" {
                let session = log.get_session::<serde_json::Value>("session").await.unwrap().unwrap();
                assert!(matches!(log.root().begin_session_removal("session", session.revision).await.unwrap(),
                    maka_event_log::sessions::SessionRemovalResult::Accepted(_)));
            }
            if matches!(ending, "cancel" | "retire") { running.cancel(); }
            release.send(()).unwrap();
            if let Some(reservation) = reservation {
                reservation.ready().await.unwrap().commit().unwrap().wait().await.unwrap();
            }
            let result = running.wait().await;
            if matches!(ending, "cancel" | "retire") { assert!(result.is_err()); }
            else { result.unwrap(); }
            worker.drain().await;
            server.await.unwrap();
            let prefix = log.prefix(200, 512 * 1024).await.unwrap();
            let summary_step = prefix.events.iter().find_map(|event| match &event.event.fact {
                Fact::ModelRequested { step_id, purpose: ModelPurpose::Summary, .. } => Some(step_id),
                _ => None,
            }).unwrap();
            assert!(prefix.events.iter().any(|event| matches!(&event.event.fact,
                Fact::ModelInterrupted { step_id, partial: None, .. } if step_id == summary_step)),
                "cancel/drain seals Summary without publishing its private prose");
            if ending == "summary-tool" {
                assert!(!prefix.events.iter().any(|event| matches!(&event.event.fact,
                    Fact::ModelObserved { step_id, event: maka_agent_facts::model::recorded::ModelObservation::Part(_) }
                        if step_id == summary_step)), "an unexecuted local Summary request stays private");
                assert!(!prefix.events.iter().any(|event| matches!(&event.event.fact,
                    Fact::ToolDispatched { .. } if event.event.invocation.invocation_id == "invocation-next")));
            }
            let mut view = maka_presentation::InvocationView::new();
            let mut rows = Vec::new();
            for event in prefix.events.iter().filter(|e| e.event.invocation.invocation_id == "invocation-next") {
                let payload = if matches!(event.event.fact, Fact::ToolSettled { outcome: maka_agent_facts::event::ToolOutcome::Succeeded { .. }, .. }) {
                    Some(log.resolve_tool_result("session", &event.event.id).await.unwrap())
                } else { None };
                rows.extend(view.push_with_tool_output(event, payload.as_ref()).unwrap());
            }
            assert!(rows.iter().all(|row| !serde_json::to_string(&row.message).unwrap().contains("private unfinished summary")));
            assert!(log.unfinished_invocations(0, 10).await.unwrap().invocations.is_empty());
            assert!(log.read_model_view("session", None).await.unwrap().baseline.is_none());
            assert_eq!(count.load(Ordering::SeqCst), usize::from(ending == "handoff"));
            if ending == "retire" { assert!(log.root().session_retirement_ready("session").await.unwrap()); }
            drop(worker);
            Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
            let log = SessionFixture::open(&path).await.unwrap();
            assert_eq!(log.root().recover_invocations().await.unwrap(), 0);
            log.close().await.unwrap();
        }).await.expect("summary must drain before the invocation seals");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rejected_local_summary_preserves_main_tool_context_and_next_turn() {
    tokio::time::timeout(Duration::from_secs(20), async {
        use maka_agent_facts::model::recorded::ModelObservation;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("events.sqlite");
        let log = Arc::new(SessionFixture::open(&path).await.unwrap());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let old_body = "original-tool-body-".repeat(1024);
        let observed = log.clone();
        let server = tokio::spawn(async move {
            let (mut old, _) = listener.accept().await.unwrap();
            fixture::read_request(&mut old).await;
            respond_tail_call(&mut old, "original-call", old_body.as_str()).await;
            let (mut old, _) = listener.accept().await.unwrap();
            let request = fixture::read_request(&mut old).await;
            assert!(request["messages"].to_string().contains(&old_body));
            fixture::respond(&mut old, "old-answer", "stop").await;

            let mut summary = None;
            let mut main = None;
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = fixture::read_request(&mut socket).await;
                assert!(request["messages"].to_string().contains(&old_body));
                if request["messages"].to_string().contains(
                    maka_agent_facts::context::default_compaction_prompt(
                        maka_agent_facts::language::Language::En,
                    ).lines().next().unwrap(),
                ) {
                    summary = Some(socket);
                } else {
                    main = Some(socket);
                }
            }
            let mut commits = observed.subscribe_commits();
            let mut summary = summary.unwrap();
            let delta = json!({"id":"summary","object":"chat.completion.chunk","created":1,"model":"test",
                "choices":[{"index":0,"delta":{"content":"private rejected summary prose","tool_calls":[{"index":0,"id":"forbidden-summary-call","type":"function",
                    "function":{"name":"echo","arguments":"{\"value\":99}"}}]},"finish_reason":null}]});
            let end = json!({"id":"summary","object":"chat.completion.chunk","created":1,"model":"test",
                "choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],
                "usage":{"prompt_tokens":13,"completion_tokens":7,"total_tokens":20}});
            let response = format!("data: {delta}\n\ndata: {end}\n\ndata: [DONE]\n\n");
            summary.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).as_bytes()).await.unwrap();
            loop {
                let prefix = observed.prefix(200, 512 * 1024).await.unwrap();
                let summary_step = prefix.events.iter().find_map(|event| match &event.event.fact {
                    Fact::ModelRequested { purpose: ModelPurpose::Summary, step_id, .. } => Some(step_id),
                    _ => None,
                });
                if prefix.events.iter().any(|event| matches!(&event.event.fact,
                    Fact::ModelInterrupted { step_id, partial: None, .. }
                        if Some(step_id) == summary_step)) {
                    break;
                }
                commits.changed().await.unwrap();
            }
            drop(commits);
            drop(observed);
            respond_tail_call(main.as_mut().unwrap(), "next-call", 41).await;
            let (mut last, _) = listener.accept().await.unwrap();
            let request = fixture::read_request(&mut last).await;
            let messages = request["messages"].to_string();
            assert!(messages.contains(&old_body));
            assert!(messages.contains("old-answer"));
            assert!(messages.contains("next-call"));
            assert!(!messages.contains("private rejected summary prose"));
            assert!(!messages.contains("forbidden-summary-call"));
            fixture::respond(&mut last, "completed after rejected summary", "stop").await;

            let (mut later, _) = listener.accept().await.unwrap();
            let request = fixture::read_request(&mut later).await;
            let messages = request["messages"].to_string();
            assert!(messages.contains(&old_body));
            assert!(messages.contains("completed after rejected summary"));
            assert!(!messages.contains("private rejected summary prose"));
            assert!(!messages.contains("forbidden-summary-call"));
            fixture::respond(&mut later, "next turn completed", "stop").await;
        });
        let count = Arc::new(AtomicUsize::new(0));
        let worker = engine();
        let effect = Arc::new(agent_loop::Effect { log: log.clone(), count: count.clone() });
        let mut old = agent_loop::input(&base, "old", effect.clone());
        old.configuration.model = fixture::input(&base, "unused", false).configuration.model;
        old.provider.auth = maka_model::ProviderAuth::ApiKey("fixture".into());
        old.context = context(None);
        worker.run(log.store(), old, CancellationToken::new()).await.unwrap();
        let mut next = agent_loop::input(&base, "next", effect.clone());
        next.configuration.model = fixture::input(&base, "unused", false).configuration.model;
        next.provider.auth = maka_model::ProviderAuth::ApiKey("fixture".into());
        next.context = context(Some(70));
        worker.run(log.store(), next, CancellationToken::new()).await.unwrap();
        worker.drain().await;
        assert_eq!(count.load(Ordering::SeqCst), 2, "only original and Main calls execute once; Summary has no local authority");
        assert!(log.read_model_view("session", None).await.unwrap().baseline.is_none());
        drop(effect);
        drop(worker);
        Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
        let log = Arc::new(SessionFixture::open(&path).await.unwrap());
        assert_eq!(log.root().recover_invocations().await.unwrap(), 0);
        let worker = engine();
        let mut later = fixture::input(&base, "later", false);
        later.context = context(None);
        worker.run(log.store(), later, CancellationToken::new()).await.unwrap();
        worker.drain().await;
        server.await.unwrap();
        let prefix = log.prefix(200, 512 * 1024).await.unwrap();
        let summary_request = prefix.events.iter().find(|event| matches!(&event.event.fact,
            Fact::ModelRequested { purpose: ModelPurpose::Summary, .. })).unwrap();
        let Fact::ModelRequested { step_id: summary_step, .. } = &summary_request.event.fact else { unreachable!() };
        assert!(!prefix.events.iter().any(|event| matches!(&event.event.fact,
            Fact::ModelCompleted { step_id, .. } if step_id == summary_step)));
        assert!(!prefix.events.iter().any(|event| matches!(&event.event.fact,
            Fact::ContextCheckpointRecorded { .. })));
        assert!(!prefix.events.iter().any(|event| matches!(&event.event.fact,
            Fact::ModelObserved { step_id, event: ModelObservation::Part(_) } if step_id == summary_step)));
        assert!(prefix.events.iter().any(|event| matches!(&event.event.fact,
            Fact::ModelObserved { step_id, event: ModelObservation::Finished { usage, .. } }
                if step_id == summary_step && usage.input_tokens == Some(13) && usage.output_tokens == Some(7))),
            "failed Summary usage stays accountable without publishing private content");
        assert!(!serde_json::to_string(&prefix.events).unwrap().contains("private rejected summary prose"));
        assert!(log.read_model_view("session", None).await.unwrap().baseline.is_none());
        assert!(log.unfinished_invocations(0, 10).await.unwrap().invocations.is_empty());
        assert_eq!(count.load(Ordering::SeqCst), 2, "reopening and a new turn never replay prior tool calls");
    }).await.expect("a rejected local Summary must permit Main progress and a later turn");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn historical_unknown_tool_does_not_disable_automatic_compaction_or_pin_old_context() {
    use maka_agent_facts::{
        event::{EventWrite, InvocationInput, RuntimeEvent},
        tool_call::ToolCallIdentity,
    };
    tokio::time::timeout(Duration::from_secs(20), async {
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
            let (mut old, _) = listener.accept().await.unwrap();
            fixture::read_request(&mut old).await;
            fixture::respond(&mut old, "old-answer", "stop").await;
            let mut summary = None;
            let mut main = None;
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = fixture::read_request(&mut socket).await;
                assert!(request["messages"].as_array().unwrap().iter().any(|message|
                    message["role"] == "tool" && message["tool_call_id"] == "legacy-browser-call"
                        && message["content"].as_str().is_some_and(|text| text.to_lowercase().contains("unknown"))));
                if request["messages"].to_string().contains(
                    maka_agent_facts::context::default_compaction_prompt(
                        maka_agent_facts::language::Language::En,
                    ).lines().next().unwrap(),
                ) {
                    summary = Some(socket);
                } else {
                    main = Some(socket);
                }
            }
            let mut commits = observed.subscribe_commits();
            fixture::respond(summary.as_mut().unwrap(), fixture::SUMMARY, "stop").await;
            loop {
                let prefix = observed.prefix(200, 512 * 1024).await.unwrap();
                let step = prefix
                    .events
                    .iter()
                    .find_map(|event| match &event.event.fact {
                        Fact::ModelRequested {
                            purpose: ModelPurpose::Summary,
                            step_id,
                            ..
                        } => Some(step_id),
                        _ => None,
                    });
                if prefix.events.iter().any(|event| {
                    matches!(&event.event.fact,
                    Fact::ModelCompleted { step_id, .. } if Some(step_id) == step)
                }) {
                    break;
                }
                commits.changed().await.unwrap();
            }
            let mut calls = 1;
            respond_tail_call(main.as_mut().unwrap(), "new-call-1", 41).await;
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = fixture::read_request(&mut socket).await;
                let messages = request["messages"].to_string();
                if messages.contains("summary-marker") {
                    assert!(!messages.contains("legacy-browser-call"));
                    assert!(!messages.contains("legacy-browser-operation"));
                    fixture::respond(&mut socket, "done after compaction", "stop").await;
                    return calls;
                }
                calls += 1;
                respond_tail_call(&mut socket, &format!("new-call-{calls}"), 41).await;
            }
        });
        let worker = engine();
        let legacy = fixture::input(&base, "legacy", false).invocation;
        for fact in [
            Fact::InvocationOpened {
                configuration: None,
                input: InvocationInput::Message {
                    content: "old browser work".into(),
                    source_messages: Vec::new(),
                    request_fingerprint: None,
                },
            },
            Fact::ModelRequested {
                source_capture: maka_agent_facts::event::SourceCapture { publication_watermark: 0, prior_unknown: false },
                item_acceptance: false, step_id: "legacy-step".into(), model_id: "test".into(),
                purpose: ModelPurpose::Main, context: None, context_breakdown: None,
                source_scope: maka_agent_facts::event::LogScope::Session { id: "session".into() }, source_high_water: 1,
                source_digest: "fixture".into(), input_digest: "fixture".into(), route_identity: "fixture".into(),
                checkpoint_event_id: None, effective_source_digest: None,
            },
            Fact::ModelCompleted {
                step_id: "legacy-step".into(),
                output: crate::support::model_records::completion(legacy.clone(), "legacy-step", vec![
                    maka_agent_facts::model::ModelPart::ToolCall { call: maka_agent_facts::model::ModelToolCall {
                        id: "legacy-browser-call".into(), name: "legacy-browser".into(), input: json!({}).into(),
                        provider_options: None, provider_executed: false,
                    } },
                ], maka_agent_facts::model::ModelFinishReason::ToolCalls),
            },
            Fact::ToolDispatched {
                presentation: None,
                title: None,
                operation_id: "legacy-step:legacy-browser-call".into(),
                call: ToolCallIdentity::provider("legacy-step".into(), "legacy-browser-call".into()),
                name: "legacy-browser".into(),
                input: json!({}),
            },
            Fact::InvocationEnded {
                outcome: InvocationOutcome::Failed {
                    class: "outcome_unknown".into(),
                    message: None,
                    model_failure: None,
                },
            },
        ] {
            log.append(&EventWrite::plain(RuntimeEvent::new(legacy.clone(), fact)).unwrap())
                .await
                .unwrap();
        }
        let mut old = fixture::input(&base, "old", false);
        old.context = context(None);
        worker
            .run(log.store(), old, CancellationToken::new())
            .await
            .unwrap();
        let effects = Arc::new(AtomicUsize::new(0));
        let mut next = agent_loop::input(
            &base,
            "next",
            Arc::new(agent_loop::Effect {
                log: log.clone(),
                count: effects.clone(),
            }),
        );
        next.configuration.model = fixture::input(&base, "unused", false).configuration.model;
        next.provider.auth = maka_model::ProviderAuth::ApiKey("fixture".into());
        next.context = context(Some(70));
        let outcome = worker
            .run(log.store(), next, CancellationToken::new())
            .await
            .unwrap();
        assert!(matches!(outcome, maka_agent_engine::ActivationExit::Terminal(_)));
        worker.drain().await;
        assert_eq!(effects.load(Ordering::SeqCst), server.await.unwrap());
        let view = log.read_model_view("session", None).await.unwrap();
        assert!(
            view.baseline
                .unwrap()
                .checkpoint
                .summary
                .text
                .contains("summary-marker")
        );
        let history = log.prefix(200, 512 * 1024).await.unwrap();
        assert!(history.events.iter().any(|stored|
            stored.event.invocation.invocation_id == "invocation-next" && matches!(&stored.event.fact,
                Fact::InvocationEnded { outcome: InvocationOutcome::Completed })));
        assert!(history.events.iter().any(|stored| matches!(&stored.event.fact,
            Fact::ToolDispatched { operation_id, .. } if operation_id == "legacy-step:legacy-browser-call")));
        Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
    })
    .await
    .expect("historical unknown effects must not disable compaction");
}
