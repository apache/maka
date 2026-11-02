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
    let directory = tempfile::tempdir().unwrap();
    let log = Arc::new(
        SessionFixture::open(&directory.path().join("events.sqlite"))
            .await
            .unwrap(),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let (started, mut arrivals) = tokio::sync::mpsc::unbounded_channel();
    let mut input = input(&base, "parallel");
    input.provider.kind = ProviderKind::OpenaiResponses;
    input.provider_options = json!({"openai":{"store":false}});
    if let maka_agent_engine::RunWork::Message { tools, .. } = &mut input.work {
        *tools = ToolCatalog::new([ToolRegistration {
            definition: serde_json::from_value(
                json!({"name":"echo","description":"echo","inputSchema":{"type":"object"}}),
            )
            .unwrap(),
            nesting: ToolNesting::Nestable,
            semantics: ToolSemantics::Parallel,
            handler: ToolHandler::Immediate(Arc::new(Overlap {
                started,
                both: Arc::new(tokio::sync::Barrier::new(2)),
            })),
        }])
        .unwrap();
    }
    let worker = engine();
    tokio::time::timeout(Duration::from_secs(10),async {
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
        worker.run(log.store(), input,CancellationToken::new()).await.unwrap();
        worker.drain().await;
        server.await.unwrap();
    }).await.expect("parallel tools must not block each other's model-stream admission");
    log.shutdown().await.unwrap();
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
    check_interrupted_finish(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refused_finish_turn_recovers_after_stream_interruption() {
    check_interrupted_finish(false).await;
}

async fn check_interrupted_finish(success: bool) {
    use maka_tools::{ToolCatalog, ToolHandler, ToolNesting, ToolRegistration, ToolSemantics};
    let directory = tempfile::tempdir().unwrap();
    let log = Arc::new(
        SessionFixture::open(&directory.path().join("events.sqlite"))
            .await
            .unwrap(),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let observed = log.clone();
    let mut commits = log.subscribe_commits();
    let mut input = input(&base, "finish-turn");
    input.provider.kind = ProviderKind::OpenaiResponses;
    input.provider_options = json!({"openai":{"store":false}});
    if let maka_agent_engine::RunWork::Message { tools, .. } = &mut input.work {
        *tools = ToolCatalog::new([ToolRegistration {
            definition:serde_json::from_value(json!({"name":"finish","description":"end this turn","inputSchema":{"type":"object"}})).unwrap(),
            nesting:ToolNesting::DirectOnly,semantics:ToolSemantics::FinishTurn,
            handler:ToolHandler::Immediate(Arc::new(Finisher(success))),
        }]).unwrap();
    }
    let worker = engine();
    tokio::time::timeout(Duration::from_secs(10),async {
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
        worker.run(log.store(), input,CancellationToken::new()).await.unwrap();
        worker.drain().await;
        let listener = server.await.unwrap();
        assert!(listener.accept().now_or_never().is_none());
        let prefix = log.prefix(100,128*1024).await.unwrap();
        assert_eq!(prefix.events.iter().filter(|event|matches!(event.event.fact,Fact::ModelRequested {..})).count(),if success {1} else {2});
        assert_eq!(prefix.events.iter().filter(|event|matches!(event.event.fact,Fact::ModelCompleted {..})).count(),usize::from(!success),"a finishing tool must not fabricate model completion");
        assert!(matches!(prefix.events.last().unwrap().event.fact,Fact::InvocationEnded {outcome:InvocationOutcome::Completed}));
    }).await.expect("original FinishTurn settlement and interrupted stream recovery must complete");
    log.shutdown().await.unwrap();
}
