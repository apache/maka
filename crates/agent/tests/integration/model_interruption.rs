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

use crate::support::invocation;

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use maka_agent::{Engine, RunError, RunInput};
use maka_event_log::EventLog;
use maka_js_runtime::{CellLimits, CodeExecutor};
use maka_model::{ModelError, ModelExecutor, ProviderConfig, ProviderKind};
use maka_runtime::event::{Fact, Invocation, InvocationOutcome, ModelInterruption, TerminalStatus};
use maka_runtime::model::ModelEvent;
use maka_tools::ToolMode;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

fn input(base: &str, suffix: &str) -> RunInput {
    RunInput {
        model_source: None,
        model_revision: None,
        provider_id: "fixture".into(),
        main_output_limit: None,
        context: None,
        invocation: Invocation {
            session_id: "session".into(),
            turn_id: format!("turn-{suffix}"),
            run_id: format!("run-{suffix}"),
            invocation_id: format!("invocation-{suffix}"),
        },
        request_fingerprint: None,
        provider: ProviderConfig {
            adapter: None,
            capabilities: Default::default(),
            kind: ProviderKind::OpenaiChat,
            model: "test".into(),
            base_url: base.into(),
            auth: maka_model::ProviderAuth::ApiKey("test-key".into()),
            headers: BTreeMap::new(),
            network: Default::default(),
            body_overlay: None,
        },
        provider_options: json!({}),
        supports_vision: false,
        configuration: invocation::configuration(ToolMode::Direct),
        work: maka_agent::RunWork::Message {
            allow_prior_unknown: false,
            source_messages: Vec::new(),
            message: format!("question {suffix}").into(),
            tools: Default::default(),
            max_steps: 1,
        },
    }
}

use crate::support::http;
use http::read_request;
async fn respond(socket: &mut TcpStream, partial: bool) {
    let text = if partial {
        "unfinished-secret-fragment"
    } else {
        "done"
    };
    let chunk = json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"content":text},"finish_reason":null}]});
    socket
        .write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
        )
        .await
        .unwrap();
    socket
        .write_all(format!("data: {chunk}\n\n").as_bytes())
        .await
        .unwrap();
    if !partial {
        let end = json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]});
        socket
            .write_all(format!("data: {end}\n\ndata: [DONE]\n\n").as_bytes())
            .await
            .unwrap();
    }
}

fn engine(log: Arc<EventLog>) -> Engine {
    Engine::new(
        log,
        ModelExecutor::new(1, Duration::from_secs(20)).unwrap(),
        CodeExecutor::new(2, CellLimits::default()).unwrap(),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn safe_retry_preserves_failed_evidence_and_cancellation_stops_backoff() {
    tokio::time::timeout(Duration::from_secs(15), async {
        for (cancel, reset) in [(false, false), (true, false), (false, true)] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let observed = Arc::new(Notify::new());
            let reset_ready = observed.clone();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut requests = vec![read_request(&mut socket).await];
                respond(&mut socket, true).await;
                let intent = json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test",
                    "choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"unexecuted","type":"function",
                        "function":{"name":"Read","arguments":"{\"path\":\"never-read\"}"}}]},"finish_reason":null}]});
                socket.write_all(format!("data: {intent}\n\n").as_bytes()).await.unwrap();
                if reset {
                    reset_ready.notified().await;
                    socket.set_zero_linger().unwrap();
                }
                drop(socket); // Real EOF or RST, never a fabricated model error.
                if !cancel {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    requests.push(read_request(&mut socket).await);
                    respond(&mut socket, false).await;
                }
                (requests, listener)
            });
            let directory = tempfile::tempdir().unwrap();
            let log = Arc::new(EventLog::open(&directory.path().join("events.sqlite")).await.unwrap());
            let worker = engine(log.clone());
            let cancellation = CancellationToken::new();
            let mut commits = log.subscribe_commits();
            let stop = async {
                if reset {
                    loop {
                        let prefix = log.prefix(100, 128 * 1024).await.unwrap();
                        if prefix.events.iter().any(|event| matches!(&event.event.fact,
                            Fact::ModelObserved { event: ModelEvent::PartDelta { text, .. }, .. }
                                if text == "unfinished-secret-fragment")) { break; }
                        commits.changed().await.unwrap();
                    }
                    observed.notify_one();
                }
                if cancel {
                    loop {
                        let prefix = log.prefix(100, 128 * 1024).await.unwrap();
                        if prefix.events.iter().any(|event| matches!(event.event.fact,
                            Fact::ModelInterrupted { status: ModelInterruption::RetryableFailure, .. })) { break; }
                        commits.changed().await.unwrap();
                    }
                    cancellation.cancel();
                }
            };
            let (result, ()) = tokio::join!(worker.run(input(&base, "retry"), cancellation.clone()), stop);
            if cancel { assert!(matches!(result, Err(RunError::Cancelled))); }
            else { result.unwrap(); }
            worker.drain().await;
            let (requests, listener) = server.await.unwrap();
            assert_eq!(requests.len(), if cancel { 1 } else { 2 });
            if !cancel { assert_eq!(requests[0], requests[1], "retry must use the identical frozen prompt, not failed text or tool intent"); }
            assert!(tokio::time::timeout(Duration::from_millis(20), listener.accept()).await.is_err());
            let prefix = log.prefix(100, 128 * 1024).await.unwrap();
            let requested: Vec<_> = prefix.events.iter().filter_map(|event| match &event.event.fact {
                Fact::ModelRequested { step_id, input_digest, .. } => Some((step_id, input_digest)), _ => None,
            }).collect();
            assert_eq!(requested.len(), requests.len());
            if !cancel { assert_ne!(requested[0].0, requested[1].0); assert_eq!(requested[0].1, requested[1].1); }
            assert_eq!(prefix.events.iter().filter(|event| matches!(event.event.fact,
                Fact::ModelInterrupted { status: ModelInterruption::RetryableFailure, .. })).count(), 1);
            assert!(prefix.events.iter().any(|event| matches!(&event.event.fact,
                Fact::ModelObserved { event: ModelEvent::PartDelta { text, .. }, .. } if text == "unfinished-secret-fragment")));
            assert!(!prefix.events.iter().any(|event| matches!(event.event.fact,
                Fact::ToolDispatched { .. } | Fact::ToolRejected { .. })));
        }
    }).await.expect("retry and cancellation must settle within their bounds");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn continuation_claim_replays_only_its_lineage_and_retries_with_frozen_input() {
    use maka_runtime::{
        continuation::RunBoundary,
        event::{EventWrite, LogScope, RuntimeEvent},
        input::InvocationInput,
    };
    tokio::time::timeout(Duration::from_secs(20), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let directory = tempfile::tempdir().unwrap();
        let log = Arc::new(EventLog::open(&directory.path().join("events.sqlite")).await.unwrap());
        let mut source = input(&base, "source");
        source.configuration.workspace_identity = Some(
            maka_runtime::execution::WorkspaceIdentity::from_marker_id("c193cd58-f929-4ba2-bfb5-6887beaf8132").unwrap());
        let opening = |text: &str| Fact::InvocationOpened {
            configuration: Some(Box::new(source.configuration.clone())),
            input: InvocationInput::Message { content: text.into(), request_fingerprint: None,
                source_messages: Vec::new(), },
        };
        let route = format!("sha256:{:x}", Sha256::digest(serde_json::to_vec(&source.provider).unwrap()));
        for fact in [
            opening("question source"),
            Fact::ModelRequested { step_id: "old".into(), model_id: "test".into(), purpose: maka_runtime::context::ModelPurpose::Main, context: None,
                source_scope: LogScope::Session { id: "session".into() }, source_high_water: 1,
                source_digest: "fixture".into(), input_digest: "fixture".into(), route_identity: route,
                checkpoint_event_id: None, effective_source_digest: None },
            Fact::ModelCompleted { step_id: "old".into(), output: serde_json::from_value(json!({
                "parts":[{"kind":"text","text_kind":"text","text":"trimmed old tail","provider_options":null}],
                "finish_reason":"stop","usage":{}
            })).unwrap() },
            Fact::InvocationEnded { outcome: InvocationOutcome::Cancelled { source: "user".into() } },
        ] {
            log.append(&EventWrite::plain(RuntimeEvent::new(source.invocation.clone(), fact)).unwrap()).await.unwrap();
        }
        let prefix = log.run_prefix("session", &source.invocation.run_id, None, 100, 128 * 1024).await.unwrap().unwrap();
        let boundary = RunBoundary { invocation: prefix.invocation, high_water: prefix.high_water, digest: prefix.digest };
        for fact in [opening("unrelated later branch"), Fact::InvocationEnded { outcome: InvocationOutcome::Completed }] {
            log.append(&EventWrite::plain(RuntimeEvent::new(input(&base, "branch").invocation, fact)).unwrap()).await.unwrap();
        }
        let continuation = |id: &str| {
            let mut child = input(&base, id);
            child.configuration = source.configuration.clone();
            child.request_fingerprint = Some(maka_runtime::artifact::content_digest(id.as_bytes()));
            child.work = maka_agent::RunWork::Continuation { source: boundary.clone(),tools: Default::default(), max_steps: 2 };
            child
        };
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for partial in [true, false] {
                let (mut socket, _) = listener.accept().await.unwrap();
                requests.push(read_request(&mut socket).await);
                respond(&mut socket, partial).await;
            }
            (requests, listener)
        });
        let worker = engine(log.clone());
        let before = log.prefix(100, 128 * 1024).await.unwrap();
        worker.check_continuation(&continuation("preview"), &CancellationToken::new()).await.unwrap();
        assert_eq!(log.prefix(100, 128 * 1024).await.unwrap().digest, before.digest, "query cannot claim or mutate the source");
        worker.run(continuation("child"), CancellationToken::new()).await.unwrap();
        let (requests, listener) = server.await.unwrap();
        assert_eq!(requests[0], requests[1]);
        let prompt = serde_json::to_string(&requests[0]["messages"]).unwrap();
        assert!(prompt.contains("question source"));
        for excluded in ["trimmed old tail", "unrelated later branch", "question child", "unfinished-secret-fragment"] {
            assert!(!prompt.contains(excluded), "{excluded}: {prompt}");
        }
        let mut moved = continuation("moved");
        moved.configuration.workspace_identity = None;
        assert!(worker.run(moved, CancellationToken::new()).await.is_err());
        assert!(worker.run(continuation("duplicate"), CancellationToken::new()).await.is_err());
        worker.drain().await;
        assert!(tokio::time::timeout(Duration::from_millis(20), listener.accept()).await.is_err());
        let facts = log.prefix(100, 128 * 1024).await.unwrap();
        let claims: Vec<_> = facts.events.iter().filter_map(|s| match &s.event.fact {
            Fact::InvocationOpened { input: InvocationInput::Continuation { claim, .. }, .. } => Some(claim),
            _ => None,
        }).collect();
        assert_eq!(claims.len(), 1, "only one canonical claim may acquire the sealed source");
        let attempts: Vec<_> = facts.events.iter().filter_map(|s| match &s.event.fact {
            Fact::ModelRequested { step_id, source_high_water, source_digest, input_digest, .. } if s.event.invocation.run_id == "run-child" =>
                Some(((*source_high_water, source_digest), input_digest, step_id)),
            _ => None,
        }).collect();
        assert_eq!(attempts.len(), 2);
        assert_eq!(attempts[0].0, attempts[1].0, "retry preserves the original canonical cut");
        assert_eq!(attempts[0].1, &claims[0].replay.digest);
        assert_eq!(attempts[0].1, attempts[1].1);
        assert_ne!(attempts[0].2, attempts[1].2, "each physical attempt has its own identity");
        assert_eq!(facts.events.iter().filter(|s| matches!(s.event.fact,
            Fact::ModelInterrupted { status: ModelInterruption::RetryableFailure, .. })).count(), 1);
        for fact in [
            opening("later unknown effect"),
            Fact::ToolDispatched { operation_id: "unknown".into(),
                call: maka_runtime::tool_call::ToolCallIdentity::standalone("unknown-call".into()),
                name: "write".into(), input: json!({}) },
            Fact::InvocationEnded { outcome: InvocationOutcome::Failed { class: "outcome_unknown".into(), message: None } },
        ] {
            log.append(&EventWrite::plain(RuntimeEvent::new(input(&base, "unknown").invocation, fact)).unwrap()).await.unwrap();
        }
        let unsafe_preview = worker.check_continuation(&continuation("unsafe-preview"), &CancellationToken::new()).await;
        assert!(matches!(&unsafe_preview,
            Err(RunError::Store(maka_event_log::StoreError::InvalidTransition(reason)))
                if reason.ends_with("Session contains unsealed or unresolved prior execution")),
            "a safe historical cut cannot hide a later unresolved Session effect: {unsafe_preview:?}");
    }).await.expect("continuation must settle");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn model_timeout_cause_survives_reopening_the_log() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_request(&mut socket).await;
            std::future::pending::<()>().await;
        });
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("events.sqlite");
        {
            let log = Arc::new(EventLog::open(&path).await.unwrap());
            let engine = Engine::new(
                log.clone(),
                ModelExecutor::new(1, Duration::from_millis(250)).unwrap(),
                CodeExecutor::new(2, CellLimits::default()).unwrap(),
            );
            assert!(matches!(
                engine
                    .run(input(&base, "timeout"), CancellationToken::new())
                    .await,
                Err(RunError::Model(ModelError::TimedOut))
            ));
            drop(engine);
            Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
        }
        server.abort();
        let reopened = EventLog::open(&path).await.unwrap();
        let prefix = reopened.prefix(100, 128 * 1024).await.unwrap();
        assert!(matches!(
            &prefix.events.last().unwrap().event.fact,
            Fact::InvocationEnded {
                outcome: InvocationOutcome::Failed { class, message: Some(message) }
            } if class == "model_timeout" && message == &ModelError::TimedOut.to_string()
        ));
        assert_eq!(
            prefix.project_invocation("invocation-timeout").terminal,
            Some(TerminalStatus::Failed)
        );
    })
    .await
    .expect("model timeout must durably settle");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn partial_text_survives_cancellation_without_becoming_replayed_model_history() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let release = Arc::new(Notify::new());
        let server_release = release.clone();
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for index in 0..3 {
                let (mut socket, _) = listener.accept().await.unwrap();
                requests.push(read_request(&mut socket).await);
                respond(&mut socket, index == 0).await;
                if index == 0 {
                    // Keep the first response incomplete until cancellation has
                    // settled; observing bytes sent is not a durability barrier.
                    server_release.notified().await;
                }
            }
            requests
        });
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("events.sqlite");
        {
            let log = Arc::new(EventLog::open(&path).await.unwrap());
            let engine = engine(log.clone());
            let cancellation = CancellationToken::new();
            let running_engine = engine.clone();
            let running_token = cancellation.clone();
            let first = input(&base, "cancelled");
            let running = tokio::spawn(async move {
                running_engine.run(first, running_token).await
            });
            let observed = loop {
                let prefix = log.prefix(100, 128 * 1024).await.unwrap();
                if prefix.events.iter().any(|stored| matches!(
                    &stored.event.fact,
                    Fact::ModelObserved { event: ModelEvent::PartDelta { text, .. }, .. }
                        if text == "unfinished-secret-fragment"
                )) {
                    break prefix;
                }
                assert!(!running.is_finished(), "model ended before durable partial text");
                tokio::task::yield_now().await;
            };
            let active = observed.project_invocation("invocation-cancelled");
            assert_eq!(active.terminal, None);
            assert_eq!(active.unfinished_model_steps.len(), 1);
            cancellation.cancel();
            assert!(matches!(running.await.unwrap(), Err(RunError::Model(ModelError::Cancelled))));
            let settled = log.prefix(100, 128 * 1024).await.unwrap();
            let tail = &settled.events[observed.events.len()..];
            let interrupted = tail.iter().position(|stored| matches!(
                &stored.event.fact,
                Fact::ModelInterrupted { step_id, status: ModelInterruption::Cancelled }
                    if step_id == &active.unfinished_model_steps[0]
            )).unwrap();
            assert!(matches!(&tail.last().unwrap().event.fact,
                Fact::InvocationEnded { outcome: InvocationOutcome::Cancelled { source } }
                    if source == "runtime_cancellation"));
            assert!(interrupted < tail.len() - 1);
            assert!(!settled.events.iter().any(|stored| matches!(
                stored.event.fact, Fact::ModelCompleted { .. }
            )));
            let state = settled.project_invocation("invocation-cancelled");
            assert_eq!(state.terminal, Some(TerminalStatus::Cancelled));
            assert!(state.unfinished_model_steps.is_empty());
            release.notify_one();
            engine.run(input(&base, "next"), CancellationToken::new()).await.unwrap();
            drop(engine);
            Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
        }
        let log = Arc::new(EventLog::open(&path).await.unwrap());
        engine(log.clone()).run(input(&base, "reopened"), CancellationToken::new()).await.unwrap();
        let prefix = log.prefix(100, 128 * 1024).await.unwrap();
        assert!(prefix.events.iter().any(|stored| matches!(
            &stored.event.fact,
            Fact::InvocationEnded { outcome: InvocationOutcome::Cancelled { source } }
                if stored.event.invocation.invocation_id == "invocation-cancelled"
                    && source == "runtime_cancellation"
        )));
        assert!(prefix.events.iter().any(|stored| matches!(
            &stored.event.fact,
            Fact::ModelObserved { event: ModelEvent::PartDelta { text, .. }, .. }
                if text == "unfinished-secret-fragment"
        )));
        for suffix in ["cancelled", "next", "reopened"] {
            let state = prefix.project_invocation(&format!("invocation-{suffix}"));
            assert!(state.unfinished_model_steps.is_empty());
            assert_eq!(state.terminal, Some(if suffix == "cancelled" {
                TerminalStatus::Cancelled
            } else {
                TerminalStatus::Completed
            }));
        }
        // Rebuild each exact pre-request prefix in an independent log. Its
        // digest includes original event identities and sequence, not history.
        let replica = EventLog::open(&directory.path().join("replica.sqlite")).await.unwrap();
        for stored in &prefix.events {
            if let Fact::ModelRequested { source_scope, source_high_water, source_digest, input_digest, .. } = &stored.event.fact {
                let source = replica.scoped_prefix(source_scope.clone(), 100, 128 * 1024).await.unwrap();
                assert_eq!(*source_scope, maka_runtime::event::LogScope::Session {
                    id: stored.event.invocation.session_id.clone(),
                });
                assert_eq!(*source_high_water, source.high_water);
                assert_eq!(*source_digest, source.digest);
                if stored.event.invocation.invocation_id == "invocation-cancelled" {
                    let expected = serde_json::to_vec(&json!({
                        "projection":"maka.model-history.v1",
                        "prompt":[{"role":"user","content":[{"type":"text","text":"question cancelled"}]}],
                        "tools":[], "providerOptions":{}, "maxOutputTokens":8000
                    })).unwrap();
                    assert_eq!(*input_digest, format!("sha256:{:x}", Sha256::digest(expected)));
                }
            }
            assert_eq!(replica.append(&maka_runtime::event::EventWrite::plain(stored.event.clone()).unwrap()).await.unwrap(), stored.sequence);
        }
        let requests = server.await.unwrap();
        assert_eq!(requests[1]["messages"], json!([
            {"role":"user","content":"question cancelled"},
            {"role":"user","content":"question next"}
        ]));
        assert_eq!(requests[2]["messages"], json!([
            {"role":"user","content":"question cancelled"},
            {"role":"user","content":"question next"},
            {"role":"assistant","content":"done"},
            {"role":"user","content":"question reopened"}
        ]));
    }).await.expect("partial model cancellation and recovery must make bounded progress");
}
