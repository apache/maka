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

//! Real WS reconnection through the Agent, after a committed local effect.
use super::*;
use crate::support::store::SessionFixture;
use futures_util::{FutureExt, SinkExt, StreamExt};
use serde_json::Value;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio_tungstenite::{accept_async, tungstenite::Message};

// A paused clock exercises the full production backoff without real waiting.
// Real socket reconstruction is covered below.
#[derive(Clone)]
struct Unavailable {
    attempts: Arc<std::sync::Mutex<(bool, Vec<bool>)>>,
    replay_safe: bool,
    usage_limit: bool,
    retry_at_unix_ms: Option<u64>,
}
impl maka_agent_ports::model::ProviderAdapter for Unavailable {
    fn open(
        &self,
        _: maka_agent_ports::model::Lifetime,
        _: CancellationToken,
    ) -> futures_util::future::BoxFuture<
        '_,
        Result<Arc<dyn maka_agent_ports::model::Session>, ModelError>,
    > {
        let session = self.clone();
        Box::pin(async move { Ok(Arc::new(session) as Arc<dyn maka_agent_ports::model::Session>) })
    }
}
impl maka_agent_ports::model::Session for Unavailable {
    fn try_switch_fallback_transport(&self) -> bool {
        let mut state = self.attempts.lock().unwrap();
        if state.0 {
            return false;
        }
        assert!(self.replay_safe);
        assert_eq!(
            state.1.len(),
            10,
            "fallback must wait for all primary retries"
        );
        state.0 = true;
        true
    }
    fn stream(
        &self,
        _: maka_agent_ports::model::Request,
        _: maka_agent_ports::model::Context,
    ) -> futures_util::future::BoxFuture<'static, Result<(), ModelError>> {
        let mut state = self.attempts.lock().unwrap();
        let fallback = state.0;
        state.1.push(fallback);
        let error = maka_agent_facts::model::error::ProviderFailure::new(
            if self.usage_limit {
                maka_agent_facts::model::error::ProviderFailureReason::QuotaExhausted
            } else {
                maka_agent_facts::model::error::ProviderFailureReason::Network
            },
            if self.usage_limit {
                "Usage limit reached for 5 hour. Your limit will reset at 2026-10-29 15:00:00"
            } else {
                "transport unavailable"
            },
            self.replay_safe,
            self.retry_at_unix_ms,
        );
        Box::pin(async move { Err(ModelError::Provider(error)) })
    }
}

#[tokio::test(start_paused = true)]
async fn fallback_waits_for_retry_budget_and_gets_one_bounded_budget_of_its_own() {
    let quota_at = maka_model::ProviderFailure::now_unix_ms() + 18_000_000;
    for (replay_safe, usage_limit, advice) in [
        (true, false, None),
        (false, false, None),
        (true, true, Some(quota_at)),
        (true, true, None),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let log = Arc::new(
            SessionFixture::open(&directory.path().join("events.sqlite"))
                .await
                .unwrap(),
        );
        let attempts = Arc::new(std::sync::Mutex::new((false, Vec::new())));
        let binding = maka_agent_ports::model::Binding::new(
            Arc::new(Unavailable {
                attempts: attempts.clone(),
                replay_safe,
                usage_limit,
                retry_at_unix_ms: advice,
            }),
            maka_agent_facts::composition::SourceRevision {
                kind: maka_agent_facts::composition::SourceKind::ModelAdapter,
                name: "chat-completions".into(),
                package_id: "fixture.adapter".into(),
                entry_id: "fixture.adapter".into(),
                activation: "fixture.activation".into(),
                revision: "1".into(),
            },
        );
        let worker = Engine::new(
            ModelExecutor::new(Duration::from_secs(5))
                .unwrap()
                .with_adapters(std::collections::BTreeMap::from([(
                    "chat-completions".into(),
                    binding,
                )])),
            CodeExecutor::new(CellLimits::default()).unwrap(),
        )
        .unwrap();
        let result = worker
            .run(
                log.store(),
                input("http://unused.invalid/v1", "budget"),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(
            result,
            Err(RunError::Model(ModelError::Provider(_)))
        ));
        worker.drain().await;
        let attempts = attempts.lock().unwrap().1.clone();
        let expected: Vec<_> = if replay_safe && !usage_limit {
            [false; 10].into_iter().chain([true; 10]).collect()
        } else {
            vec![false]
        };
        assert_eq!(attempts, expected);
        if usage_limit {
            let prefix = log.prefix(100, 128 * 1024).await.unwrap();
            let Fact::InvocationEnded {
                outcome:
                    InvocationOutcome::Failed {
                        model_failure: Some(cause),
                        message: Some(message),
                        ..
                    },
            } = &prefix.events.last().unwrap().event.fact
            else {
                panic!("quota must settle as a terminal provider failure")
            };
            assert_eq!(
                cause,
                &ModelFailureCause::Provider {
                    reason: maka_agent_facts::model::error::ProviderFailureReason::QuotaExhausted,
                    retry_at_unix_ms: advice,
                }
            );
            assert!(message.contains("2026-10-29 15:00:00"));
        }
        let prefix = log.prefix(100, 128 * 1024).await.unwrap();
        let requests: Vec<_> = prefix
            .events
            .iter()
            .filter_map(|event| match &event.event.fact {
                Fact::ModelRequested {
                    input_digest,
                    source_high_water,
                    ..
                } => Some((input_digest, source_high_water)),
                _ => None,
            })
            .collect();
        assert_eq!(requests.len(), expected.len());
        assert!(requests.iter().all(|request| request == &requests[0]));
        let mut frozen = None;
        for event in &prefix.events {
            if matches!(event.event.fact, Fact::ModelRequested { .. }) {
                let composition = log
                    .request_composition("session", &event.event.id)
                    .await
                    .unwrap()
                    .expect("each retry retains canonical composition");
                if let Some(original) = &frozen {
                    assert_eq!(
                        &composition, original,
                        "retry must preserve the entire surface"
                    );
                } else {
                    frozen = Some(composition);
                }
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn websocket_retry_uses_frozen_full_input_and_never_reexecutes_settled_tools() {
    use crate::support::agent_loop::{self, Effect};
    use maka_agent_facts::tools::{ToolExecutor, ToolFuture};
    struct TrackedEffect {
        inner: Effect,
        progress: Arc<std::sync::Mutex<Vec<(bool, &'static str)>>>,
        cancel_case: bool,
    }
    impl ToolExecutor for TrackedEffect {
        fn names(&self) -> Vec<String> {
            self.inner.names()
        }
        fn invoke(
            &self,
            name: String,
            input: Value,
            cancellation: CancellationToken,
        ) -> ToolFuture {
            let future = self.inner.invoke(name, input, cancellation);
            let progress = self.progress.clone();
            let cancel_case = self.cancel_case;
            Box::pin(async move {
                progress
                    .lock()
                    .unwrap()
                    .push((cancel_case, "effect-invoked"));
                let result = future.await;
                progress
                    .lock()
                    .unwrap()
                    .push((cancel_case, "effect-returned"));
                result
            })
        }
    }
    let progress = Arc::new(std::sync::Mutex::new(Vec::new()));
    tokio::time::timeout(Duration::from_secs(20), async {
        for cancel in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let server_progress = progress.clone();
            let server = tokio::spawn(async move {
                let (socket, _) = listener.accept().await.unwrap();
                let mut socket = accept_async(socket).await.unwrap();
                server_progress.lock().unwrap().push((cancel, "primary-connected"));
                let initial: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
                let item = json!({"type":"function_call","id":"function-1","call_id":"call-1","name":"echo","arguments":"{\"value\":42}"});
                for event in [
                    json!({"type":"response.created","response":{"id":"first","model":"test"}}),
                    json!({"type":"response.output_item.done","output_index":0,"item":item}),
                    json!({"type":"response.completed","response":{"id":"first","output":[item]}}),
                ] { socket.send(Message::Text(event.to_string().into())).await.unwrap(); }
                server_progress.lock().unwrap().push((cancel, "primary-completed"));
                let delta: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
                server_progress.lock().unwrap().push((cancel, "tool-result-received"));
                assert_eq!(delta["previous_response_id"], "first");
                assert_eq!(delta["input"][0]["type"], "function_call_output");
                // A partial local tool intent is unaccepted. It must not be
                // executed or included in the recovered model request.
                for event in [
                    json!({"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"partial","content":[]}}),
                    json!({"type":"response.output_text.delta","item_id":"partial","delta":"unaccepted partial text"}),
                    json!({"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"function-2","call_id":"never-execute","name":"echo","arguments":""}}),
                ] { socket.send(Message::Text(event.to_string().into())).await.unwrap(); }
                socket.close(None).await.unwrap();
                drop(socket);
                server_progress.lock().unwrap().push((cancel, "interrupted-socket-closed"));
                if cancel {
                    assert!(tokio::time::timeout(Duration::from_millis(1300), listener.accept()).await.is_err());
                    return;
                }
                let (socket, _) = listener.accept().await.unwrap();
                let mut socket = accept_async(socket).await.unwrap(); // Recovery must stay on WS.
                server_progress.lock().unwrap().push((cancel, "recovery-connected"));
                let retry: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
                assert!(retry.get("previous_response_id").is_none());
                let mut expected = initial["input"].as_array().unwrap().clone();
                // Reconnect replays the complete accepted item, including its
                // canonical provider identity. It does not send a connection-
                // local item_reference or rely on previous_response_id.
                expected.push(item);
                expected.extend(delta["input"].as_array().unwrap().iter().cloned());
                assert_eq!(retry["input"], json!(expected));
                assert!(!retry.to_string().contains("unaccepted partial text"));
                assert!(!retry.to_string().contains("never-execute"));
                let complete = json!({"type":"response.completed","response":{"id":"final","output":[{"type":"message","id":"answer","content":[{"type":"output_text","text":"done"}]}]}});
                socket.send(Message::Text(complete.to_string().into())).await.unwrap();
                server_progress.lock().unwrap().push((cancel, "recovery-completed"));
            });
            let directory = tempfile::tempdir().unwrap();
            let log = Arc::new(SessionFixture::open(&directory.path().join("events.sqlite")).await.unwrap());
            progress.lock().unwrap().push((cancel, "fixture-ready"));
            let count = Arc::new(AtomicUsize::new(0));
            let effect = Arc::new(TrackedEffect { inner: Effect { log:log.clone(), count:count.clone() }, progress: progress.clone(), cancel_case: cancel });
            let mut input = agent_loop::input(&base, "websocket", effect);
            input.provider.kind = ProviderKind::OpenaiResponses;
            input.provider_options = json!({"openai":{"store":false}});
            let worker = engine();
            let cancellation = CancellationToken::new();
            let mut commits = log.subscribe_commits();
            let stop = async {
                if cancel {
                    let mut observed = std::collections::BTreeSet::new();
                    loop {
                        progress.lock().unwrap().push((cancel, "observer-prefix-started"));
                        let prefix = log.prefix(100, 128*1024).await.unwrap();
                        progress.lock().unwrap().push((cancel, "observer-prefix-returned"));
                        for event in &prefix.events {
                            let phase = match &event.event.fact {
                                Fact::ModelRequested { .. } => Some("model-request-committed"),
                                Fact::ModelCompleted { .. } => Some("model-completed-committed"),
                                Fact::ModelObserved { event: maka_agent_facts::model::recorded::ModelObservation::Part(record), .. }
                                    if matches!(record.part.as_ref(), ModelPart::ToolCall { .. }) => Some("tool-item-committed"),
                                Fact::ToolDispatched { .. } => Some("tool-T1-committed"),
                                Fact::ToolSettled { .. } => Some("tool-T2-committed"),
                                _ => None,
                            };
                            if let Some(phase) = phase && observed.insert(phase) {
                                progress.lock().unwrap().push((cancel, phase));
                            }
                        }
                        if prefix.events.iter().any(|event| matches!(event.event.fact, Fact::ModelInterrupted {status:ModelInterruption::RetryableFailure,..})) { break; }
                        commits.changed().await.unwrap();
                    }
                    progress.lock().unwrap().push((cancel, "interruption-committed"));
                    cancellation.cancel();
                }
            };
            progress.lock().unwrap().push((cancel, "run-started"));
            let (result, ()) = tokio::join!(worker.run(log.store(), input, cancellation.clone()), stop);
            progress.lock().unwrap().push((cancel, "run-returned"));
            if cancel { assert!(matches!(result,Err(RunError::Cancelled))); } else {result.unwrap();}
            worker.drain().await;
            progress.lock().unwrap().push((cancel, "worker-drained"));
            server.await.unwrap();
            progress.lock().unwrap().push((cancel, "server-returned"));
            assert_eq!(count.load(Ordering::SeqCst),1,"the previously settled tool must never run again");
            let prefix=log.prefix(100,128*1024).await.unwrap();
            let requests:Vec<_>=prefix.events.iter().filter_map(|event| match &event.event.fact {Fact::ModelRequested {input_digest,source_high_water,..}=>Some((input_digest,source_high_water)),_=>None}).collect();
            assert_eq!(requests.len(),if cancel {2} else {3});
            if !cancel {assert_eq!(requests[1],requests[2],"physical retry retains the canonical cut and frozen request");}
            assert_eq!(prefix.events.iter().filter(|event|matches!(event.event.fact,Fact::ModelInterrupted {status:ModelInterruption::RetryableFailure,..})).count(),1);
            assert_eq!(prefix.events.iter().filter(|event|matches!(event.event.fact,Fact::ToolDispatched {..})).count(),1);
        }
    }).await.unwrap_or_else(|error| panic!("WS recovery and cancellation must settle: {error}; progress: {:?}", progress.lock().unwrap()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn interrupted_progress_renews_compaction_before_and_after_a_checkpoint() {
    use crate::support::{
        agent_loop::{self, Effect},
        context::SUMMARY,
    };
    use maka_agent_facts::context::CheckpointMode;
    tokio::time::timeout(Duration::from_secs(20), async {
        let directory = tempfile::tempdir().unwrap();
        let log = Arc::new(SessionFixture::open(&directory.path().join("events.sqlite")).await.unwrap());

        let count = Arc::new(AtomicUsize::new(0));
        let effect = Arc::new(Effect { log: log.clone(), count: count.clone() });
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server_log = log.clone();
        let mut commits = log.subscribe_commits();
        let server = tokio::spawn(async move {
            // The second round has only accepted ModelItems after the previous
            // checkpoint: no new opening or completed Main response to compact.
            for round in 1..=2 {
                let call = format!("call-{round}");
                let (socket, _) = listener.accept().await.unwrap();
                let mut socket = accept_async(socket).await.unwrap();
                let request: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
                if round == 2 {
                    assert!(request["input"].to_string().contains("summary-marker"));
                }
                let item = json!({"type":"function_call", "id":format!("item-{round}"), "call_id":call, "name":"echo", "arguments":json!({"value":round}).to_string()});
                socket.send(Message::Text(json!({"type":"response.output_item.done", "output_index":0, "item":item}).to_string().into())).await.unwrap();
                loop {
                    let prefix = server_log.prefix(100, 256*1024).await.unwrap();
                    if prefix.events.iter().any(|event| matches!(&event.event.fact,
                        Fact::ToolSettled { operation_id, .. } if operation_id.ends_with(&format!(":{call}")))) {
                        break;
                    }
                    commits.changed().await.unwrap();
                }
                socket.close(None).await.unwrap();
                drop(socket);
                let (socket, _) = listener.accept().await.unwrap();
                let mut socket = accept_async(socket).await.unwrap();
                let retry: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
                assert!(retry["input"].as_array().unwrap().iter().any(|item|
                    item["type"] == "function_call_output" && item["call_id"] == call));
                socket.send(Message::Text(json!({"type":"error", "error":{"code":"context_length_exceeded", "message":"context full"}}).to_string().into())).await.unwrap();
                drop(socket);
                // Summary is a separate request lifetime and uses ordinary SSE.
                let (mut socket, _) = listener.accept().await.unwrap();
                let summary = read_request(&mut socket).await;
                assert!(summary["input"].to_string().contains(maka_agent_facts::context::default_compaction_prompt(maka_agent_facts::language::Language::En).lines().next().unwrap()));
                assert!(summary["input"].as_array().unwrap().iter().any(|item|
                    item["type"] == "function_call_output" && item["call_id"] == call),
                    "compaction must cover the settled effect before continuing");
                if round == 2 {
                    assert!(summary["input"].to_string().contains("summary-marker"));
                }
                let event = json!({"type":"response.completed", "response":{"id":format!("summary-{round}"), "output":[{"type":"message", "id":format!("summary-text-{round}"), "content":[{"type":"output_text", "text":SUMMARY}]}]}});
                let body = format!("data: {event}\n\n");
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            }
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(socket).await.unwrap();
            let request: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
            assert!(request["input"].to_string().contains("summary-marker"));
            assert!(!request["input"].to_string().contains("function_call_output"));
            socket.send(Message::Text(json!({"type":"response.completed", "response":{"id":"final", "output":[{"type":"message", "id":"answer", "content":[{"type":"output_text", "text":"done"}]}]}}).to_string().into())).await.unwrap();
        });
        let mut input = agent_loop::input(&base, "stream-compaction", effect);
        input.provider.kind = ProviderKind::OpenaiResponses;
        input.provider_options = json!({"openai":{"store":false}});
        let worker = engine();
        worker.run(log.store(), input, CancellationToken::new()).await.unwrap();
        worker.drain().await;
        server.await.unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 2, "each committed effect executes exactly once");
        let prefix = log.prefix(100, 256*1024).await.unwrap();
        let checkpoints: Vec<_> = prefix.events.iter().filter_map(|event| match &event.event.fact {
            Fact::ContextCheckpointRecorded { checkpoint } => Some(checkpoint), _ => None,
        }).collect();
        assert_eq!(checkpoints.len(), 2);
        assert!(checkpoints.iter().all(|checkpoint| matches!(checkpoint.mode, CheckpointMode::MidTurn { .. })));
        assert!(checkpoints[1].covered_through > checkpoints[0].covered_through);
        assert!(checkpoints[1].previous_checkpoint_id.is_some());
    }).await.expect("retained progress must compact and continue within the same turn");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn accepted_call_runs_before_stream_completion_and_survives_retry_in_direct_and_code_mode() {
    use crate::support::agent_loop::{self, Effect};
    use maka_agent_facts::tool_call::ToolOrigin;
    for (mode, idle) in [
        (ToolMode::Direct, false),
        (ToolMode::CodeMode, false),
        (ToolMode::Direct, true),
        (ToolMode::CodeMode, true),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let log = Arc::new(
            SessionFixture::open(&directory.path().join("events.sqlite"))
                .await
                .unwrap(),
        );

        let count = Arc::new(AtomicUsize::new(0));
        let effect = Arc::new(Effect {
            log: log.clone(),
            count: count.clone(),
        });
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server_log = log.clone();
        let mut commits = log.subscribe_commits();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(socket).await.unwrap();
            let initial: Value =
                serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                    .unwrap();
            let item = if mode == ToolMode::CodeMode {
                // A local custom-call input delta cannot be mistaken for a
                // provider-side effect that prevents retained-output retry.
                socket.send(Message::Text(json!({"type":"response.custom_tool_call_input.delta","item_id":"item-1","delta":"text("}).to_string().into())).await.unwrap();
                json!({"type":"custom_tool_call","id":"item-1","call_id":"call-1","name":"exec","input":"text(await tools.echo({value:42}));"})
            } else {
                json!({"type":"function_call","id":"item-1","call_id":"call-1","name":"echo","arguments":"{\"value\":42}"})
            };
            socket
                .send(Message::Text(
                    json!({"type":"response.output_item.done","output_index":0,"item":item})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            // The provider deliberately withholds response.completed until
            // the tool result is durable. Waiting for whole-response
            // completion would deadlock this supported streaming workflow.
            loop {
                let prefix = server_log.prefix(100, 128 * 1024).await.unwrap();
                if prefix.events.iter().any(|event| {
                    matches!(&event.event.fact,
                        Fact::ToolSettled { operation_id, .. } if operation_id.ends_with(":call-1"))
                }) {
                    assert!(
                        !prefix
                            .events
                            .iter()
                            .any(|event| matches!(event.event.fact, Fact::ModelCompleted { .. }))
                    );
                    break;
                }
                commits.changed().await.unwrap();
            }
            if idle {
                assert!(
                    socket.next().await.is_none_or(
                        |frame| frame.is_err() || matches!(frame, Ok(Message::Close(_)))
                    )
                );
            } else {
                socket.close(None).await.unwrap();
            }
            drop(socket);
            let (mut retry_socket, _) = listener.accept().await.unwrap();
            let mut websocket = None;
            let mut http = None;
            let retry: Value = if idle {
                let body = read_request(&mut retry_socket).await;
                http = Some(retry_socket);
                body
            } else {
                let mut socket = accept_async(retry_socket).await.unwrap();
                let body =
                    serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                        .unwrap();
                websocket = Some(socket);
                body
            };
            assert!(retry.get("previous_response_id").is_none());
            let input = retry["input"].as_array().unwrap();
            assert_eq!(input[0], initial["input"][0]);
            let calls: Vec<_> = input
                .iter()
                .filter(|item| item["call_id"] == "call-1")
                .collect();
            assert_eq!(
                calls.len(),
                2,
                "one accepted call and one settled result must survive reconnect"
            );
            assert_eq!(calls[0]["type"], item["type"]);
            assert!(calls[1]["output"].to_string().contains("42"));
            let completed = json!({"type":"response.completed","response":{"id":"final","output":[{"type":"message","id":"answer","content":[{"type":"output_text","text":"done"}]}]}});
            if let Some(mut socket) = http {
                let body = format!("data: {completed}\n\n");
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
            } else {
                websocket
                    .unwrap()
                    .send(Message::Text(completed.to_string().into()))
                    .await
                    .unwrap();
            }
        });
        let mut input = agent_loop::input(&base, "early-effect", effect);
        input.configuration.tool_mode = mode;
        input.provider.kind = ProviderKind::OpenaiResponses;
        input.provider_options = json!({"openai":{"store":false}});
        let worker = Engine::new(
            ModelExecutor::new(if idle {
                Duration::from_secs(1)
            } else {
                Duration::from_secs(20)
            })
            .unwrap(),
            CodeExecutor::new(CellLimits::default()).unwrap(),
        )
        .unwrap();
        // Root construction and bundle import each open eight real journals.
        // Bound the streaming protocol itself independently of fixture setup.
        tokio::time::timeout(Duration::from_secs(20), async {
            worker
                .run(log.store(), input, CancellationToken::new())
                .await
                .unwrap();
            worker.drain().await;
            server.await.unwrap();
        })
        .await
        .expect("streaming execution and progress retry must settle");
        assert_eq!(
            count.load(Ordering::SeqCst),
            1,
            "recovery cannot repeat the committed effect"
        );
        let prefix = log.prefix(100, 128 * 1024).await.unwrap();
        let attempts: Vec<_> = prefix
            .events
            .iter()
            .filter_map(|event| match &event.event.fact {
                Fact::ModelRequested {
                    source_high_water,
                    input_digest,
                    ..
                } => Some((*source_high_water, input_digest)),
                _ => None,
            })
            .collect();
        assert_eq!(attempts.len(), 2);
        assert!(matches!(
            &prefix.events.last().unwrap().event.fact,
            Fact::InvocationEnded {
                outcome: InvocationOutcome::Completed
            }
        ));
        if idle {
            assert!(prefix.events.iter().any(|event| matches!(&event.event.fact,
                    Fact::ModelInterrupted { status: ModelInterruption::RetryableFailure, diagnostic: Some(message), .. } if message.contains("idle timeout"))));
        }
        assert!(attempts[1].0 > attempts[0].0);
        assert_ne!(
            attempts[0].1, attempts[1].1,
            "retry must carry accepted progress"
        );
        assert_eq!(prefix.events.iter().filter(|event| matches!(&event.event.fact,
                Fact::ToolDispatched { call, .. } if matches!(call.origin, ToolOrigin::Provider { .. }))).count(),1);

        let settled = prefix
            .events
            .iter()
            .find(|event| {
                matches!(&event.event.fact,
                Fact::ToolSettled { operation_id, .. } if operation_id.ends_with(":call-1"))
            })
            .unwrap();
        assert!(
            log.read_tool_result("session", &settled.event.id)
                .await
                .unwrap()
                .is_some(),
            "archive lookup must use item acceptance before dispatch"
        );
        let inventory = log.root().preview_bundle("session").await.unwrap();
        let (bytes, _) = log
            .root()
            .export_bundle("session", &inventory.subtree_digest, Vec::new())
            .await
            .unwrap();
        let staged = maka_event_log::bundle::StagedBundle::read(bytes.as_slice())
            .await
            .unwrap();
        let destination =
            crate::support::store::RootFixture::open(&directory.path().join("imported.sqlite"))
                .await
                .unwrap();
        destination
            .import_bundle(
                staged,
                &maka_agent_facts::artifact::content_digest(b"fixture destination"),
                BTreeMap::from([("session".into(), json!({}))]),
            )
            .await
            .unwrap();
        let destination = destination.select("session").await.unwrap();
        let imported = destination
            .capture_model_context("session", None, 10_000, 16 * 1024 * 1024)
            .await
            .unwrap();
        assert!(!imported.tail.is_empty());
    }
}

struct Overlap {
    started: tokio::sync::mpsc::UnboundedSender<()>,
    both: Arc<tokio::sync::Barrier>,
}
impl maka_agent_facts::tools::ToolExecutor for Overlap {
    fn names(&self) -> Vec<String> {
        vec!["echo".into()]
    }
    fn invoke(
        &self,
        _: String,
        input: Value,
        _: CancellationToken,
    ) -> maka_agent_facts::tools::ToolFuture {
        let started = self.started.clone();
        let both = self.both.clone();
        Box::pin(async move {
            started.send(()).unwrap();
            both.wait().await;
            Ok(input)
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn parallel_calls_overlap_while_the_model_stream_is_still_open() {
    use maka_tools::{ToolCatalog, ToolHandler, ToolNesting, ToolRegistration, ToolSemantics};
    tokio::time::timeout(Duration::from_secs(10),async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1",listener.local_addr().unwrap());
        let (started,mut arrivals) = tokio::sync::mpsc::unbounded_channel();
        let server = tokio::spawn(async move {
            let (socket,_) = listener.accept().await.unwrap();
            let mut socket = accept_async(socket).await.unwrap();
            socket.next().await.unwrap().unwrap();
            for id in ["first","second"] {
                socket.send(Message::Text(json!({"type":"response.output_item.done","item":{"type":"function_call","id":id,"call_id":id,"name":"echo","arguments":"{}"}}).to_string().into())).await.unwrap();
                // First tool is blocked until the second tool starts. The next
                // completed item must still be consumed and independently run.
                arrivals.recv().await.unwrap();
            }
            socket.send(Message::Text(json!({"type":"response.completed","response":{"id":"tools","output":[]}}).to_string().into())).await.unwrap();
            let next:Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(next["input"].as_array().unwrap().iter().filter(|item|item["type"]=="function_call_output").count(),2);
            socket.send(Message::Text(json!({"type":"response.completed","response":{"id":"answer","output":[{"type":"message","id":"text","content":[{"type":"output_text","text":"done"}]}]}}).to_string().into())).await.unwrap();
        });
        let directory = tempfile::tempdir().unwrap();
        let log = Arc::new(SessionFixture::open(&directory.path().join("events.sqlite")).await.unwrap());
        let mut input = input(&base,"parallel");
        input.provider.kind = ProviderKind::OpenaiResponses;
        input.provider_options = json!({"openai":{"store":false}});
        if let maka_agent_engine::RunWork::Message {tools,..} = &mut input.work {
            *tools = ToolCatalog::new([ToolRegistration {
                definition:serde_json::from_value(json!({"name":"echo","description":"echo","inputSchema":{"type":"object"}})).unwrap(),
                nesting:ToolNesting::Nestable,semantics:ToolSemantics::Parallel,
                handler:ToolHandler::Immediate(Arc::new(Overlap {started,both:Arc::new(tokio::sync::Barrier::new(2))})),
            }]).unwrap();
        }
        let worker = engine();
        worker.run(log.store(), input,CancellationToken::new()).await.unwrap();
        worker.drain().await;
        server.await.unwrap();
    }).await.expect("parallel tools must not block each other's model-stream admission");
}

struct Finisher(bool);
impl maka_agent_facts::tools::ToolExecutor for Finisher {
    fn names(&self) -> Vec<String> {
        vec!["finish".into()]
    }
    fn invoke(
        &self,
        _: String,
        _: Value,
        _: CancellationToken,
    ) -> maka_agent_facts::tools::ToolFuture {
        let success = self.0;
        Box::pin(async move {
            if success {
                Ok(json!({"finished":true}))
            } else {
                Err(maka_agent_facts::tools::ToolError::Failed(
                    "known refusal".into(),
                ))
            }
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn successful_finish_turn_is_authoritative_after_stream_interruption() {
    use maka_tools::{ToolCatalog, ToolHandler, ToolNesting, ToolRegistration, ToolSemantics};
    tokio::time::timeout(Duration::from_secs(10),async {
        for success in [true,false] {
            let directory = tempfile::tempdir().unwrap();
            let log = Arc::new(SessionFixture::open(&directory.path().join("events.sqlite")).await.unwrap());
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1",listener.local_addr().unwrap());
            let observed = log.clone();
            let mut commits = log.subscribe_commits();
            let server = tokio::spawn(async move {
                let (socket,_) = listener.accept().await.unwrap();
                let mut socket = accept_async(socket).await.unwrap();
                socket.next().await.unwrap().unwrap();
                socket.send(Message::Text(json!({"type":"response.output_item.done","item":{"type":"function_call","id":"finish-item","call_id":"finish-call","name":"finish","arguments":"{}"}}).to_string().into())).await.unwrap();
                loop {
                    if observed.prefix(100,128*1024).await.unwrap().events.iter().any(|event| matches!(event.event.fact,Fact::ToolSettled {..})) {break;}
                    commits.changed().await.unwrap();
                }
                socket.close(None).await.unwrap();
                drop(socket);
                if !success {
                    let (socket,_) = listener.accept().await.unwrap();
                    let mut socket = accept_async(socket).await.unwrap();
                    socket.next().await.unwrap().unwrap();
                    socket.send(Message::Text(json!({"type":"response.completed","response":{"id":"done","output":[{"type":"message","id":"answer","content":[{"type":"output_text","text":"finished after refusal"}]}]}}).to_string().into())).await.unwrap();
                }
                listener
            });
            let mut input = input(&base,"finish-turn");
            input.provider.kind = ProviderKind::OpenaiResponses;
            input.provider_options = json!({"openai":{"store":false}});
            if let maka_agent_engine::RunWork::Message {tools,..} = &mut input.work {
                *tools = ToolCatalog::new([ToolRegistration {
                    definition:serde_json::from_value(json!({"name":"finish","description":"end this turn","inputSchema":{"type":"object"}})).unwrap(),
                    nesting:ToolNesting::DirectOnly,semantics:ToolSemantics::FinishTurn,
                    handler:ToolHandler::Immediate(Arc::new(Finisher(success))),
                }]).unwrap();
            }
            let worker = engine();
            worker.run(log.store(), input,CancellationToken::new()).await.unwrap();
            worker.drain().await;
            let listener = server.await.unwrap();
            assert!(listener.accept().now_or_never().is_none());
            let prefix = log.prefix(100,128*1024).await.unwrap();
            assert_eq!(prefix.events.iter().filter(|event|matches!(event.event.fact,Fact::ModelRequested {..})).count(),if success {1} else {2});
            assert_eq!(prefix.events.iter().filter(|event|matches!(event.event.fact,Fact::ModelCompleted {..})).count(),usize::from(!success),"a finishing tool must not fabricate model completion");
            assert!(matches!(prefix.events.last().unwrap().event.fact,Fact::InvocationEnded {outcome:InvocationOutcome::Completed}));
        }
    }).await.expect("successful FinishTurn must stop retry; a failed finish must allow recovery");
}
