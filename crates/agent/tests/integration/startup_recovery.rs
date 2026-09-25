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

use std::{collections::BTreeMap, sync::Arc, time::Duration};

use maka_agent::{Engine, RunError, RunInput, recovery::recover};
use maka_event_log::EventLog;
use maka_js_runtime::{CellLimits, CodeExecutor};
use maka_model::{ModelExecutor, ProviderConfig, ProviderKind};
use maka_runtime::event::{
    Fact, Invocation, InvocationOutcome, ModelInterruption, RuntimeEvent, TerminalStatus,
};
use maka_runtime::interaction::{
    ClosureReason, Decision, GrantCapability, GrantScope, GrantTarget, InteractionOutcome,
    InteractionRecord, InteractionRequest,
};
use maka_runtime::model::{ModelPart, ModelStep, ModelToolCall, ModelUsage};
use maka_tools::ToolMode;
use serde_json::json;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use crate::support::recovery;
use recovery::{append, invocation, opening, request};

async fn tool_call(log: &EventLog) {
    request(log).await;
    append(
        log,
        Fact::ModelCompleted {
            step_id: "step".into(),
            output: ModelStep {
                parts: vec![ModelPart::ToolCall {
                    call: ModelToolCall {
                        id: "call".into(),
                        name: "write_file".into(),
                        input: json!({"path":"effect.txt"}),
                        provider_options: None,
                        provider_executed: false,
                    },
                }],
                finish_reason: maka_runtime::model::ModelFinishReason::ToolCalls,
                usage: ModelUsage::default(),
                provider_options: None,
                response_id: None,
                model: None,
                timestamp: None,
            },
        },
    )
    .await;
}

#[tokio::test]
async fn reopened_pending_main_and_summary_are_failed_without_replaying_admission() {
    for summary in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("events.sqlite");
        let original = {
            let log = EventLog::open(&path).await.unwrap();
            let original = opening(&log).await;
            request(&log).await;
            if summary {
                append(
                    &log,
                    Fact::ModelCompleted {
                        step_id: "step".into(),
                        output: serde_json::from_value(json!({
                            "parts":[{"kind":"text","text_kind":"text","text":"completed prefix"}],
                            "finish_reason":"stop", "usage":{}
                        }))
                        .unwrap(),
                    },
                )
                .await;
                let source = log
                    .prepare_context_compaction(
                        "session",
                        Some("invocation"),
                        100,
                        128 * 1024,
                        &maka_runtime::context::CheckpointMode::MidTurn {
                            anchor_event_id: original.id.clone(),
                        },
                    )
                    .await
                    .unwrap();
                append(
                    &log,
                    Fact::ModelRequested {
                        step_id: "summary".into(),
                        purpose: maka_runtime::context::ModelPurpose::Summary,
                        model_id: "test".into(),
                        context: None,
                        source_scope: source.source_evidence.scope,
                        source_high_water: source.source_evidence.high_water,
                        source_digest: source.source_evidence.digest,
                        effective_source_digest: Some(source.effective_source_digest),
                        input_digest: "fixture".into(),
                        route_identity: format!("sha256:{}", "a".repeat(64)),
                        checkpoint_event_id: None,
                    },
                )
                .await;
            }
            log.close().await.unwrap();
            original
        };
        let log = EventLog::open(&path).await.unwrap();
        assert_eq!(recover(&log).await.unwrap(), 1);
        let prefix = log.prefix(100, 128 * 1024).await.unwrap();
        assert_eq!(prefix.events.len(), if summary { 6 } else { 4 });
        let end = prefix.events.len();
        assert!(
            matches!(&prefix.events[end - 2].event.fact, Fact::ModelInterrupted {
        step_id, status: ModelInterruption::Failed
    } if step_id == if summary { "summary" } else { "step" })
        );
        assert!(
            matches!(&prefix.events[end - 1].event.fact, Fact::InvocationEnded {
        outcome: InvocationOutcome::Failed { class, .. }
    } if class == "host_interrupted")
        );
        assert!(
            prefix
                .events
                .iter()
                .all(|event| event.event.invocation == invocation())
        );
        assert!(
            prefix
                .project_invocation("invocation")
                .unfinished_model_steps
                .is_empty()
        );
        assert_eq!(
            log.append(&maka_runtime::event::EventWrite::plain(original.clone()).unwrap())
                .await
                .unwrap(),
            1
        );
        assert!(
            log.append(
                &maka_runtime::event::EventWrite::plain(RuntimeEvent::new(
                    invocation(),
                    original.fact
                ))
                .unwrap()
            )
            .await
            .is_err()
        );
        assert_eq!(recover(&log).await.unwrap(), 0);
        assert_eq!(
            log.prefix(100, 128 * 1024).await.unwrap().high_water,
            prefix.high_water
        );
    }
}

#[tokio::test]
async fn reopened_committed_call_without_dispatch_is_durably_known_not_executed() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let target = GrantTarget {
        provider_id: "provider".into(),
        contract_id: "contract".into(),
        server_id: "desktop_browser".into(),
        tool_name: "browser_navigate".into(),
        capability: GrantCapability::Browser,
        scope: GrantScope::BrowserOrigin {
            origin: "https://example.com".into(),
        },
    };
    {
        let log = EventLog::open(&path).await.unwrap();
        opening(&log).await;
        tool_call(&log).await;
        log.establish_interaction(&InteractionRecord {
            session_id: "session".into(),
            turn_id: "turn".into(),
            run_id: "run".into(),
            request_id: "approval".into(),
            created_at: 1,
            request: InteractionRequest::ClientCapability {
                tool_use_id: "step:call".into(),
                target: target.clone(),
            },
            outcome: None,
        })
        .await
        .unwrap();
        log.close().await.unwrap();
    }
    let log = EventLog::open(&path).await.unwrap();
    recover(&log).await.unwrap();
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    let prefix = log.prefix(100, 128 * 1024).await.unwrap();
    let canonical = log.interaction("approval").await.unwrap().unwrap();
    assert!(matches!(
        canonical.outcome,
        Some(InteractionOutcome::Closure {
            reason: ClosureReason::HostRestarted,
            ..
        })
    ));
    assert!(
        log.client_capability_grant("session", &target)
            .await
            .unwrap()
            .is_none()
    );
    let late = log
        .commit_interaction_outcome(
            "approval",
            InteractionOutcome::ClientCapabilityDecision {
                decision: Decision::Allow,
                committed_at: 100,
            },
        )
        .await
        .unwrap();
    assert!(!late.matches);
    assert_eq!(late.record, canonical);
    assert_eq!(prefix.events.len(), 5);
    assert!(matches!(&prefix.events[3].event.fact, Fact::ToolRejected {
        operation_id, call, name, input, reason: maka_runtime::tool_call::ToolRejection::Cancelled
    } if operation_id == "step:call" && call == &maka_runtime::tool_call::ToolCallIdentity::provider("step".into(), "call".into()) && name == "write_file" && input == &json!({"path":"effect.txt"})));
    assert!(!prefix.events.iter().any(|stored| matches!(
        stored.event.fact,
        Fact::ToolDispatched { .. } | Fact::ToolSettled { .. }
    )));
    let recovery = log
        .invocation_recovery(&invocation(), 10, 16_384)
        .await
        .unwrap();
    assert!(recovery.undispatched_calls.is_empty());
    assert!(recovery.uncertain_operations.is_empty());
    let commits = log.subscribe_commits();
    assert_eq!(
        log.append(
            &maka_runtime::event::EventWrite::plain(prefix.events[3].event.clone()).unwrap()
        )
        .await
        .unwrap(),
        prefix.events[3].sequence
    );
    assert!(!commits.has_changed().unwrap());
    assert!(
        matches!(&prefix.events[4].event.fact, Fact::InvocationEnded {
        outcome: InvocationOutcome::Failed { class, .. }
    } if class == "host_interrupted")
    );
    assert!(
        prefix
            .project_invocation("invocation")
            .uncertain_operations
            .is_empty()
    );
    assert_eq!(recover(&log).await.unwrap(), 0);
    assert_eq!(log.interaction("approval").await.unwrap(), Some(canonical));
    assert!(
        log.client_capability_grant("session", &target)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn unknown_dispatch_stays_unknown_and_blocks_next_admission_after_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    {
        let log = EventLog::open(&path).await.unwrap();
        opening(&log).await;
        tool_call(&log).await;
        append(
            &log,
            Fact::ToolDispatched {
                operation_id: "step:call".into(),
                call: maka_runtime::tool_call::ToolCallIdentity::provider(
                    "step".into(),
                    "call".into(),
                ),
                name: "write_file".into(),
                input: json!({"path":"effect.txt"}),
            },
        )
        .await;
        log.close().await.unwrap();
    }
    let log = Arc::new(EventLog::open(&path).await.unwrap());
    assert_eq!(recover(&log).await.unwrap(), 1);
    let prefix = log.prefix(100, 128 * 1024).await.unwrap();
    assert_eq!(prefix.events.len(), 5);
    assert!(
        !prefix
            .events
            .iter()
            .any(|event| matches!(event.event.fact, Fact::ToolSettled { .. }))
    );
    assert!(
        matches!(&prefix.events[4].event.fact, Fact::InvocationEnded {
        outcome: InvocationOutcome::Failed { class, .. }
    } if class == "outcome_unknown")
    );
    let state = prefix.project_invocation("invocation");
    assert_eq!(state.terminal, Some(TerminalStatus::Failed));
    assert_eq!(state.uncertain_operations, vec!["step:call"]);
    let engine = Engine::new(
        log.clone(),
        ModelExecutor::new(1, Duration::from_secs(1)).unwrap(),
        CodeExecutor::new(2, CellLimits::default()).unwrap(),
    );
    let result = engine
        .run(
            RunInput {
                model_source: None,
                model_revision: None,
                provider_id: "fixture".into(),
                main_output_limit: None,
                context: None,
                invocation: Invocation {
                    turn_id: "next-turn".into(),
                    run_id: "next-run".into(),
                    invocation_id: "next-invocation".into(),
                    ..invocation()
                },
                request_fingerprint: None,
                provider: ProviderConfig {
                    adapter: None,
                    capabilities: Default::default(),
                    kind: ProviderKind::OpenaiChat,
                    model: "unused".into(),
                    base_url: "http://127.0.0.1:1".into(),
                    auth: maka_model::ProviderAuth::ApiKey("unused".into()),
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
                    message: "continue".into(),
                    tools: Default::default(),
                    max_steps: 1,
                },
            },
            CancellationToken::new(),
        )
        .await;
    assert!(matches!(result, Err(RunError::ReconciliationRequired(_))));
    assert_eq!(
        log.prefix(100, 128 * 1024).await.unwrap().high_water,
        prefix.high_water
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn explicit_new_message_after_unknown_dispatch_informs_model_without_replaying_tool() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("events.sqlite");
        {
            let log = EventLog::open(&path).await.unwrap();
            opening(&log).await;
            request(&log).await;
            append(&log, Fact::ModelCompleted {
                step_id: "step".into(),
                output: ModelStep {
                    parts: ["call", "never-dispatched"].into_iter().map(|id| ModelPart::ToolCall {
                        call: ModelToolCall {
                            id: id.into(),
                            name: "write_file".into(),
                            input: json!({"path": if id == "call" { "effect.txt" } else { "never.txt" }}),
                            provider_options: None,
                            provider_executed: false,
                        },
                    }).collect(),
                    finish_reason: maka_runtime::model::ModelFinishReason::ToolCalls,
                    usage: ModelUsage::default(),
                    provider_options: None,
                    response_id: None,
                    model: None,
                    timestamp: None,
                },
            }).await;
            append(&log, Fact::ToolDispatched {
                operation_id: "step:call".into(),
                call: maka_runtime::tool_call::ToolCallIdentity::provider("step".into(), "call".into()),
                name: "write_file".into(),
                input: json!({"path":"effect.txt"}),
            }).await;
            assert!(log.check_manual_message_history("session").await.is_err());
            log.close().await.unwrap();
        }
        let log = Arc::new(EventLog::open(&path).await.unwrap());
        assert_eq!(recover(&log).await.unwrap(), 1);
        assert!(log.check_manual_message_history("session").await.unwrap());
        assert!(log.read_model_context("session", None, 100, 128 * 1024).await.is_err());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = crate::support::http::read_request(&mut socket).await;
            let chunk = json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"content":"continued"},"finish_reason":"stop"}]});
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {chunk}\n\ndata: [DONE]\n\n").as_bytes()).await.unwrap();
            request
        });
        let engine = Engine::new(log.clone(), ModelExecutor::new(1, Duration::from_secs(5)).unwrap(), CodeExecutor::new(2, CellLimits::default()).unwrap());
        let run = RunInput {
            model_source: None,
            model_revision: None,
            provider_id: "fixture".into(),
            main_output_limit: None,
            context: None,
            invocation: Invocation { session_id: "session".into(), turn_id: "new-turn".into(), run_id: "new-run".into(), invocation_id: "new-invocation".into() },
            request_fingerprint: None,
            provider: ProviderConfig { adapter: None, capabilities: Default::default(), kind: ProviderKind::OpenaiChat,
                model: "test".into(), base_url, auth: maka_model::ProviderAuth::ApiKey("unused".into()),
                headers: BTreeMap::new(), network: Default::default(), body_overlay: None },
            provider_options: json!({}),
            supports_vision: false,
            configuration: invocation::configuration(ToolMode::Direct),
            work: maka_agent::RunWork::Message { allow_prior_unknown: true, source_messages: Vec::new(),
                message: "What happened to effect.txt?".into(), tools: Default::default(), max_steps: 1 },
        };
        engine.run(run, CancellationToken::new()).await.unwrap();
        let request = server.await.unwrap();
        let messages = request["messages"].as_array().unwrap();
        assert!(messages.iter().any(|message| message["role"] == "system" && message["content"].as_str().is_some_and(|text| text.contains("write_file") && text.contains("may or may not have happened"))), "{messages:?}");
        assert!(messages.iter().any(|message| message["role"] == "tool" && message.to_string().contains("outcome_unknown")));
        assert!(messages.iter().any(|message| message["role"] == "tool" && message["tool_call_id"] == "never-dispatched"));
        let prefix = log.prefix(100, 128 * 1024).await.unwrap();
        assert!(!prefix.events.iter().any(|event| event.event.invocation.invocation_id == "invocation" && matches!(event.event.fact, Fact::ToolSettled { .. })));
    }).await.unwrap();
}
