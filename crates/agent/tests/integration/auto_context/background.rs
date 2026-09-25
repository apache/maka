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
use maka_agent::Engine;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

fn engine(log: Arc<EventLog>) -> Engine {
    Engine::new(
        log,
        maka_model::ModelExecutor::new(2, Duration::from_secs(10)).unwrap(),
        maka_js_runtime::CodeExecutor::new(1, Default::default()).unwrap(),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn background_summary_preserves_steering_tool_tail_and_frozen_physical_retry() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let directory = tempfile::tempdir().unwrap();
        let log = Arc::new(EventLog::open(&directory.path().join("events.sqlite")).await.unwrap());
        log.create_session("session", "create", &json!({}), 1).await.unwrap();
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
                if request["messages"].to_string().contains("Now write the structured summary") {
                    assert!(!request["messages"].to_string().contains("question next"));
                    summary = Some(socket);
                } else {
                    assert!(request["messages"].to_string().contains("old-answer"));
                    main = Some(socket);
                }
            }
            let mut summary = summary.unwrap();
            let mut main = main.unwrap();
            agent_loop::enqueue(&observed, invocation).await;
            agent_loop::respond(&mut main, true).await;
            let (mut main, _) = listener.accept().await.unwrap();
            let frozen = fixture::read_request(&mut main).await;
            assert!(frozen["messages"].to_string().contains("A queued correction"));
            assert!(!frozen["messages"].to_string().contains("summary-marker"));
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
            agent_loop::respond(&mut retry, true).await;
            let (mut last, _) = listener.accept().await.unwrap();
            let adopted = fixture::read_request(&mut last).await;
            let messages = adopted["messages"].to_string();
            assert!(messages.contains("summary-marker"));
            assert!(!messages.contains("old-answer"));
            assert_eq!(messages.matches("A queued correction").count(), 1);
            assert_eq!(adopted["messages"].as_array().unwrap().iter().filter(|m| m["role"] == "tool").count(), 2);
            fixture::respond(&mut last, "done", "stop").await;
        });
        let worker = engine(log.clone());
        let mut old = fixture::input(&base, "old", false);
        old.context = context(None);
        worker.run(old, CancellationToken::new()).await.unwrap();
        worker.run(next, CancellationToken::new()).await.unwrap();
        worker.drain().await;
        server.await.unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 2, "each accepted tool effect happens once");
        let source = log.read_model_context("session", None, 200, 512 * 1024).await.unwrap();
        assert!(source.baseline.is_some());
        assert!(log.unfinished_invocations(10).await.unwrap().is_empty());
    }).await.expect("background work and physical retries must settle");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn background_summary_drains_before_terminal_handoff_and_retirement() {
    for ending in ["complete", "cancel", "handoff", "retire", "summary-tool"] {
        tokio::time::timeout(Duration::from_secs(20), async {
            use tokio::io::AsyncReadExt;
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("events.sqlite");
            let log = Arc::new(EventLog::open(&path).await.unwrap());
            log.create_session("session", "create", &json!({}), 1).await.unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let count = Arc::new(AtomicUsize::new(0));
            let mut next = agent_loop::input(&base, "next", Arc::new(agent_loop::Effect {
                log: log.clone(), count: count.clone(),
            }));
            next.configuration.model = fixture::input(&base, "unused", false).configuration.model;
            next.configuration.workspace_identity = Some(maka_runtime::execution::WorkspaceIdentity::from_marker_id(
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
                    if request["messages"].to_string().contains("Now write the structured summary") {
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
            let worker = engine(log.clone());
            let mut old = fixture::input(&base, "old", false);
            old.context = context(None);
            worker.run(old, CancellationToken::new()).await.unwrap();
            let running = worker.start(next, CancellationToken::new()).await.unwrap();
            ready.await.unwrap();
            if ending == "summary-tool" {
                let mut commits = log.subscribe_commits();
                loop {
                    let prefix = log.prefix(200, 512 * 1024).await.unwrap();
                    if prefix.events.iter().any(|e| matches!(&e.event.fact, Fact::ModelObserved {
                        event: maka_runtime::model::ModelEvent::ToolCall(_), ..
                    })) { break; }
                    commits.changed().await.unwrap();
                }
            }
            let reservation = if ending == "handoff" {
                Some(running.handoff().unwrap().reserve(maka_runtime::handoff::HandoffIntent {
                    handoff_id: "background".into(), host_epoch: "host".into(), root_run_id: "run-next".into(),
                    successor_run_id: "successor-run".into(), successor_invocation_id: "successor-invocation".into(),
                    claim_id: "claim".into(),
                }).unwrap())
            } else { None };
            if ending == "retire" {
                let session = log.get_session::<serde_json::Value>("session").await.unwrap().unwrap();
                assert!(matches!(log.begin_session_removal("session", session.revision).await.unwrap(),
                    maka_event_log::sessions::SessionRemovalResult::Accepted(_)));
            }
            if matches!(ending, "cancel" | "retire") { running.cancel(); }
            release.send(()).unwrap();
            if let Some(reservation) = reservation {
                reservation.ready().await.unwrap().commit().unwrap().wait().await.unwrap();
            }
            let result = running.wait().await;
            if matches!(ending, "cancel" | "retire") { assert!(result.is_err()); }
            else if ending == "summary-tool" { assert!(matches!(result, Err(maka_agent::RunError::ReconciliationRequired(_)))); }
            else { result.unwrap(); }
            worker.drain().await;
            server.await.unwrap();
            let prefix = log.prefix(200, 512 * 1024).await.unwrap();
            if ending == "summary-tool" {
                assert!(prefix.events.iter().any(|e| matches!(&e.event.fact,
                    Fact::InvocationEnded { outcome: InvocationOutcome::Failed { class, .. } } if class == "reconciliation_required")));
            }
            let mut view = maka_presentation::InvocationView::new(512 * 1024).unwrap();
            let mut rows = Vec::new();
            for event in prefix.events.iter().filter(|e| e.event.invocation.invocation_id == "invocation-next") {
                let payload = if matches!(event.event.fact, Fact::ToolSettled { outcome: maka_runtime::event::ToolOutcome::Succeeded { .. }, .. }) {
                    Some(log.resolve_tool_result("session", &event.event.id).await.unwrap())
                } else { None };
                rows.extend(view.push_with_tool_output(event, payload.as_ref()).unwrap());
            }
            assert!(rows.iter().all(|row| !serde_json::to_string(&row.message).unwrap().contains("private unfinished summary")));
            assert!(log.unfinished_invocations(10).await.unwrap().is_empty());
            assert!(log.read_model_context("session", None, 200, 512 * 1024).await.unwrap().baseline.is_none());
            assert_eq!(count.load(Ordering::SeqCst), usize::from(ending == "handoff"));
            if ending == "retire" { assert!(log.session_retirement_ready("session").await.unwrap()); }
            drop(worker);
            Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
            let log = EventLog::open(&path).await.unwrap();
            assert_eq!(maka_agent::recovery::recover(&log).await.unwrap(), 0);
            log.close().await.unwrap();
        }).await.expect("summary must drain before the invocation seals");
    }
}
