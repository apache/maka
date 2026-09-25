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

use crate::support::code_mode_lifetime as fixture;
use crate::support::http;
use fixture::{SlowEffect, respond};

use futures_util::poll;
use maka_agent::{Engine, RunError, RunInput};
use maka_event_log::EventLog;
use maka_js_runtime::{CellLimits, CodeExecutor};
use maka_model::{ModelExecutor, ProviderConfig, ProviderKind};
use maka_runtime::event::{Fact, Invocation, InvocationOutcome, TerminalStatus, ToolOutcome};
use maka_tools::{
    ToolCatalog, ToolDefinition, ToolHandler, ToolMode, ToolNesting, ToolRegistration,
    ToolSemantics,
};
use serde_json::json;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

fn input(base: &str, suffix: &str, effect: Arc<dyn maka_runtime::tools::ToolExecutor>) -> RunInput {
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
            auth: maka_model::ProviderAuth::ApiKey("fixture-key".into()),
            headers: BTreeMap::new(),
            network: Default::default(),
            body_overlay: None,
        },
        provider_options: json!({}),
        supports_vision: false,
        configuration: invocation::configuration(ToolMode::CodeMode),
        work: maka_agent::RunWork::Message {
            allow_prior_unknown: false,
            source_messages: Vec::new(),
            message: format!("question {suffix}").into(),
            tools: ToolCatalog::new([ToolRegistration {
                definition: ToolDefinition {
                    freeform: None,
                    output_schema: None,
                    provider: None,
                    name: "slow".into(),
                    description: "fixture effect draining after cancellation".into(),
                    input_schema: json!({"type":"object"}),
                },
                nesting: ToolNesting::Nestable,
                semantics: ToolSemantics::Parallel,
                handler: ToolHandler::Immediate(effect),
            }])
            .unwrap(),
            max_steps: 1,
        },
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropping_caller_keeps_child_session_and_cell_owned_until_drain() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let requests_seen = Arc::new(AtomicUsize::new(0));
        let server_count = requests_seen.clone();
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for index in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                requests.push(http::read_request(&mut socket).await);
                server_count.fetch_add(1, Ordering::SeqCst);
                respond(&mut socket, index == 0).await;
            }
            requests
        });
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("events.sqlite");
        let effect = Arc::new(SlowEffect::default());
        let committed;
        {
            let log = Arc::new(EventLog::open(&path).await.unwrap());
            let cells = CodeExecutor::new(1, CellLimits::default()).unwrap();
            let engine = Engine::new(
                log.clone(),
                ModelExecutor::new(1, Duration::from_secs(10)).unwrap(),
                cells.clone(),
            );
            let owner = engine.clone();
            let running_input = input(&base, "aborted", effect.clone());
            let caller_token = CancellationToken::new();
            let token = caller_token.clone();
            let caller = tokio::spawn(async move { owner.run(running_input, token).await });
            effect.entered.notified().await;
            caller.abort();
            assert!(caller.await.unwrap_err().is_cancelled());
            effect.cancelled.notified().await;
            assert!(!caller_token.is_cancelled());
            let held = log.prefix(100, 128 * 1024).await.unwrap();
            assert_eq!(held.project_invocation("invocation-aborted").terminal, None);
            assert_eq!(
                held.events
                    .iter()
                    .filter(|event| matches!(event.event.fact, Fact::ToolDispatched { .. }))
                    .count(),
                3
            );
            assert!(!held.events.iter().any(|event| matches!(
                event.event.fact,
                Fact::InvocationEnded { .. }
            )));
            assert!(matches!(
                engine
                    .run(
                        input(&base, "blocked", effect.clone()),
                        CancellationToken::new()
                    )
                    .await,
                Err(RunError::Busy)
            ));
            let next = cells.execute("return 7;".into(), effect.clone(), CancellationToken::new());
            tokio::pin!(next);
            // Explicitly poll the contender while the cancelled effect remains
            // blocked on release. Cancellation must not free the shared permit.
            assert!(poll!(&mut next).is_pending());
            assert_eq!(log.prefix(100, 128 * 1024).await.unwrap().project_invocation("invocation-aborted").terminal, None);
            assert_eq!(requests_seen.load(Ordering::SeqCst), 1);
            effect.release.notify_one();
            assert_eq!(
                serde_json::to_value(next.await.unwrap()).unwrap(),
                json!({"ok":true,"value":7,"toolCalls":[]})
            );
            engine.drain().await;
            let settled = log.prefix(100, 128 * 1024).await.unwrap();
            let state = settled.project_invocation("invocation-aborted");
            assert_eq!(state.terminal, Some(TerminalStatus::Cancelled));
            assert!(state.uncertain_operations.is_empty());
            assert!(state.unfinished_model_steps.is_empty());
            let boundaries: Vec<_> = settled
                .events
                .iter()
                .filter(|event| !matches!(event.event.fact, Fact::ModelObserved { .. }))
                .collect();
            let operation = |expected| boundaries.iter().find_map(|event| match &event.event.fact {
                Fact::ToolDispatched { operation_id, name, .. } if name == expected => Some(operation_id.clone()),
                _ => None,
            }).unwrap();
            let child = operation("slow");
            let cell = operation("code_cell");
            let child_t2 = boundaries.iter().position(|event| matches!(&event.event.fact,
                Fact::ToolSettled { operation_id, outcome: ToolOutcome::Succeeded { .. } } if operation_id == &child)).unwrap();
            let cell_t2 = boundaries.iter().position(|event| matches!(&event.event.fact,
                Fact::ToolSettled { operation_id, outcome: ToolOutcome::Failed { .. } } if operation_id == &cell)).unwrap();
            assert!(child_t2 < cell_t2 && cell_t2 < boundaries.len() - 1);
            assert_eq!(log.resolve_tool_result(&boundaries[child_t2].event.invocation.session_id, &boundaries[child_t2].event.id).await.unwrap().into_json(), json!({"value":42}));
            assert_eq!(
                boundaries.last().unwrap().event.fact,
                Fact::InvocationEnded {
                    outcome: InvocationOutcome::Cancelled {
                        source: "runtime_cancellation".into()
                    },
                }
            );
            assert_eq!(
                requests_seen.load(Ordering::SeqCst),
                1,
                "cancelled invocation must not request another model step"
            );
            committed = serde_json::to_value(&settled.events).unwrap();
            drop(engine);
            Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
        }
        {
            let log = Arc::new(EventLog::open(&path).await.unwrap());
            let recovered = log.prefix(100, 128 * 1024).await.unwrap();
            assert_eq!(serde_json::to_value(&recovered.events).unwrap(), committed);
            assert!(
                recovered
                    .project_invocation("invocation-aborted")
                    .uncertain_operations
                    .is_empty()
            );
            let engine = Engine::new(
                log.clone(),
                ModelExecutor::new(1, Duration::from_secs(10)).unwrap(),
                CodeExecutor::new(1, CellLimits::default()).unwrap(),
            );
            engine
                .run(
                    input(&base, "reopened", effect.clone()),
                    CancellationToken::new(),
                )
                .await
                .unwrap();
            engine.drain().await;
            assert_eq!(
                effect.count.load(Ordering::SeqCst),
                1,
                "reopening must not replay the drained effect"
            );
            assert_eq!(
                log.prefix(200, 256 * 1024)
                    .await
                    .unwrap()
                    .project_invocation("invocation-reopened")
                    .terminal,
                Some(TerminalStatus::Completed)
            );
        }
        let requests = server.await.unwrap();
        let history = requests[1]["messages"].as_array().unwrap();
        assert_eq!(history.len(), 4);
        assert_eq!(history[2]["role"], "tool");
        assert_eq!(history[2]["tool_call_id"], "exec-slow");
        assert_eq!(history[2]["content"], "cell observation cancelled");
        assert_eq!(
            history[3],
            json!({"role":"user","content":"question reopened"})
        );
    })
    .await
    .expect("cancelled unawaited Code Mode work must drain within the test bound");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn yielded_cell_can_receive_an_answer_and_be_observed_by_the_next_model_step() {
    for continuation in [false, true] {
        tokio::time::timeout(Duration::from_secs(15), verify_yielded(continuation))
            .await
            .expect("yielded cells must continue without cancelling the pending answer");
    }
}

async fn verify_yielded(continuation: bool) {
    let directory = tempfile::tempdir().unwrap();
    let log = Arc::new(
        EventLog::open(&directory.path().join("events.sqlite"))
            .await
            .unwrap(),
    );
    let effect = Arc::new(fixture::AnswerEffect::default());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let provider_effect = effect.clone();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        http::read_request(&mut socket).await;
        fixture::tool(
            &mut socket,
            "exec",
            json!({"code":"text(await tools.slow({value:42}));","yield_time_ms":0}),
        )
        .await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = http::read_request(&mut socket).await;
        let running: serde_json::Value = serde_json::from_str(
            request["messages"].as_array().unwrap().last().unwrap()["content"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(running["state"], "running");
        provider_effect.entered.notified().await;
        provider_effect.release.notify_one();
        fixture::tool(
            &mut socket,
            "wait",
            json!({"cell_id":running["cell_id"],"yield_time_ms":1000}),
        )
        .await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = http::read_request(&mut socket).await;
        let mut output = request["messages"].as_array().unwrap().last().unwrap()["content"]
            .as_str()
            .unwrap()
            .lines();
        let completed: serde_json::Value = serde_json::from_str(output.next().unwrap()).unwrap();
        assert_eq!(completed["state"], "completed");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(output.next().unwrap()).unwrap(),
            json!({"value":42})
        );
        respond(&mut socket, false).await;
    });
    let engine = Engine::new(
        log.clone(),
        ModelExecutor::new(1, Duration::from_secs(5)).unwrap(),
        CodeExecutor::new(1, CellLimits::default()).unwrap(),
    );
    let mut request = input(&base, "yielded", effect.clone());
    if let maka_agent::RunWork::Message { max_steps, .. } = &mut request.work {
        *max_steps = 3;
    }
    if continuation {
        use maka_runtime::event::{EventWrite, InvocationInput, RuntimeEvent};
        request.configuration.workspace_identity = Some(
            maka_runtime::execution::WorkspaceIdentity::from_marker_id(
                "ef751105-55b5-4d65-a364-646281586a17",
            )
            .unwrap(),
        );
        request.request_fingerprint =
            Some(maka_runtime::artifact::content_digest(b"resume-yielded"));
        let source = Invocation {
            session_id: "session".into(),
            turn_id: "source".into(),
            run_id: "source".into(),
            invocation_id: "source".into(),
        };
        for fact in [
            Fact::InvocationOpened {
                configuration: Some(Box::new(request.configuration.clone())),
                input: InvocationInput::Message {
                    content: "original question".into(),
                    request_fingerprint: None,
                    source_messages: Vec::new(),
                },
            },
            Fact::InvocationEnded {
                outcome: InvocationOutcome::Cancelled {
                    source: "user".into(),
                },
            },
        ] {
            log.append(&EventWrite::plain(RuntimeEvent::new(source.clone(), fact)).unwrap())
                .await
                .unwrap();
        }
        let prefix = log
            .run_prefix("session", "source", None, 100, 128 * 1024)
            .await
            .unwrap()
            .unwrap();
        let maka_agent::RunWork::Message {
            tools, max_steps, ..
        } = request.work
        else {
            unreachable!()
        };
        request.work = maka_agent::RunWork::Continuation {
            source: maka_runtime::continuation::RunBoundary {
                invocation: source,
                high_water: prefix.high_water,
                digest: prefix.digest,
            },
            tools,
            max_steps,
        };
    }
    engine.run(request, CancellationToken::new()).await.unwrap();
    server.await.unwrap();
    engine.drain().await;
    assert_eq!(effect.count.load(Ordering::SeqCst), 1);
    let projection = log
        .prefix(100, 128 * 1024)
        .await
        .unwrap()
        .project_invocation("invocation-yielded");
    assert_eq!(projection.terminal, Some(TerminalStatus::Completed));
    assert!(projection.uncertain_operations.is_empty());
}
