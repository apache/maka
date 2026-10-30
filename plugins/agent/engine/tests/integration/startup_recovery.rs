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

use maka_agent_engine::{Engine, RunError, RunInput};
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::ModelInterruption;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::event::TerminalStatus;
use maka_agent_facts::interaction::ClosureReason;
use maka_agent_facts::interaction::Decision;
use maka_agent_facts::interaction::GrantCapability;
use maka_agent_facts::interaction::GrantScope;
use maka_agent_facts::interaction::GrantTarget;
use maka_agent_facts::interaction::InteractionOutcome;
use maka_agent_facts::interaction::InteractionRecord;
use maka_agent_facts::interaction::InteractionRequest;
use maka_agent_facts::model::ModelPart;
use maka_agent_facts::model::ModelToolCall;
use maka_agent_facts::model::ModelUsage;
use maka_code_runtime::CellLimits;
use maka_event_log::EventLog;
use maka_event_log::recovery::recover_invocations as recover;
use maka_model::{ModelExecutor, ProviderConfig, ProviderKind};
use maka_tools::CodeExecutor;
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
            output: crate::support::model_records::completion(
                invocation(),
                "step",
                vec![ModelPart::ToolCall {
                    call: ModelToolCall {
                        id: "call".into(),
                        name: "write_file".into(),
                        input: json!({"path":"effect.txt"}).into(),
                        provider_options: None,
                        provider_executed: false,
                    },
                }],
                maka_agent_facts::model::ModelFinishReason::ToolCalls,
            ),
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
                        output: crate::support::model_records::completion(invocation(), "step", serde_json::from_value::<Vec<maka_agent_facts::model::ModelPart>>(json!([{"kind":"text","text_kind":"text","text":"completed prefix"}])).unwrap(), maka_agent_facts::model::ModelFinishReason::Stop),
                    },
                )
                .await;
                let source = log
                    .prepare_compaction_view(
                        "session",
                        Some("invocation"),
                        &maka_agent_facts::context::CheckpointMode::MidTurn {
                            anchor_event_id: original.id.clone(),
                        },
                    )
                    .await
                    .unwrap();
                append(
                    &log,
                    Fact::ModelRequested {
                        item_acceptance: false,
                        step_id: "summary".into(),
                        purpose: maka_agent_facts::context::ModelPurpose::Summary,
                        model_id: "test".into(),
                        context: None,
                        context_breakdown: None,
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
        step_id, status: ModelInterruption::Failed, model_failure: None, ..
    } if step_id == if summary { "summary" } else { "step" })
        );
        assert!(
            matches!(&prefix.events[end - 1].event.fact, Fact::InvocationEnded {
        outcome: InvocationOutcome::Failed { class, model_failure: None, .. }
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
            log.append(&maka_agent_facts::event::EventWrite::plain(original.clone()).unwrap())
                .await
                .unwrap(),
            1
        );
        assert!(
            log.append(
                &maka_agent_facts::event::EventWrite::plain(RuntimeEvent::new(
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
                basis: None,
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
        operation_id, call, name, input, reason: maka_agent_facts::tool_call::ToolRejection::Cancelled
    } if operation_id == "step:call" && call == &maka_agent_facts::tool_call::ToolCallIdentity::provider("step".into(), "call".into()) && name == "write_file" && input.as_json() == Some(&json!({"path":"effect.txt"}))));
    assert!(!prefix.events.iter().any(|stored| matches!(
        stored.event.fact,
        Fact::ToolDispatched { .. } | Fact::ToolSettled { .. }
    )));
    let recovery = log.invocation_recovery(&invocation()).await.unwrap();
    assert!(recovery.undispatched_calls.is_empty());
    assert!(recovery.uncertain_operations.is_empty());
    let commits = log.subscribe_commits();
    assert_eq!(
        log.append(
            &maka_agent_facts::event::EventWrite::plain(prefix.events[3].event.clone()).unwrap()
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
    use crate::support::recovery_session::{append, opening, tool_call};
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    {
        let log = crate::support::store::SessionFixture::open(&path)
            .await
            .unwrap();
        opening(&log).await;
        tool_call(&log).await;
        append(
            &log,
            Fact::ToolDispatched {
                presentation: None,
                title: None,
                operation_id: "step:call".into(),
                call: maka_agent_facts::tool_call::ToolCallIdentity::provider(
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
    let log = Arc::new(
        crate::support::store::SessionFixture::open(&path)
            .await
            .unwrap(),
    );
    assert_eq!(log.root().recover_invocations().await.unwrap(), 1);
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
        ModelExecutor::new(Duration::from_secs(1)).unwrap(),
        CodeExecutor::new(CellLimits::default()).unwrap(),
    )
    .unwrap();
    let result = engine
        .run(
            log.store(),
            RunInput {
                native_activation_basis: None,
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
                    kind: ProviderKind::OpenaiChatCompletions,
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
                work: maka_agent_engine::RunWork::Message {
                    allow_prior_unknown: false,
                    source_messages: Vec::new(),
                    message: "continue".into(),
                    tools: Default::default(),
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
    use crate::support::recovery_session::{append, opening, request};
    tokio::time::timeout(Duration::from_secs(15), async {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("events.sqlite");
        {
            let log = crate::support::store::SessionFixture::open(&path).await.unwrap();
            opening(&log).await;
            request(&log).await;
            append(&log, Fact::ModelCompleted {
                step_id: "step".into(),
                output: crate::support::model_records::completion(invocation(), "step", ["call", "never-dispatched"].into_iter().map(|id| ModelPart::ToolCall {
                        call: ModelToolCall {
                            id: id.into(),
                            name: "write_file".into(),
                            input: json!({"path": if id == "call" { "effect.txt" } else { "never.txt" }}).into(),
                            provider_options: None,
                            provider_executed: false,
                        },
                    }).collect(), maka_agent_facts::model::ModelFinishReason::ToolCalls),
            }).await;
            append(&log, Fact::ToolDispatched { presentation: None,
        title: None,
                operation_id: "step:call".into(),
                call: maka_agent_facts::tool_call::ToolCallIdentity::provider("step".into(), "call".into()),
                name: "write_file".into(),
                input: json!({"path":"effect.txt"}),
            }).await;
            assert!(log.check_manual_message_history("session").await.is_err());
            log.close().await.unwrap();
        }
        let log = Arc::new(crate::support::store::SessionFixture::open(&path).await.unwrap());
        assert_eq!(log.root().recover_invocations().await.unwrap(), 1);
        assert!(log.check_manual_message_history("session").await.unwrap());
        assert!(log.read_model_view("session", None).await.is_err());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = crate::support::http::read_request(&mut socket).await;
            let chunk = json!({"id":"reply","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"content":"continued"},"finish_reason":"stop"}]});
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {chunk}\n\ndata: [DONE]\n\n").as_bytes()).await.unwrap();
            request
        });
        let engine = Engine::new(ModelExecutor::new(Duration::from_secs(5)).unwrap(), CodeExecutor::new(CellLimits::default()).unwrap()).unwrap();
        let run = RunInput {
            native_activation_basis: None,
            model_source: None,
            model_revision: None,
            provider_id: "fixture".into(),
            main_output_limit: None,
            context: None,
            invocation: Invocation { session_id: "session".into(), turn_id: "new-turn".into(), run_id: "new-run".into(), invocation_id: "new-invocation".into() },
            request_fingerprint: None,
            provider: ProviderConfig { adapter: None, capabilities: Default::default(), kind: ProviderKind::OpenaiChatCompletions,
                model: "test".into(), base_url, auth: maka_model::ProviderAuth::ApiKey("unused".into()),
                headers: BTreeMap::new(), network: Default::default(), body_overlay: None },
            provider_options: json!({}),
            supports_vision: false,
            configuration: invocation::configuration(ToolMode::Direct),
            work: maka_agent_engine::RunWork::Message { allow_prior_unknown: true, source_messages: Vec::new(),
                message: "What happened to effect.txt?".into(), tools: Default::default() },
        };
        engine.run(log.store(), run, CancellationToken::new()).await.unwrap();
        let request = server.await.unwrap();
        let messages = request["messages"].as_array().unwrap();
        assert!(messages.iter().any(|message| message["role"] == "system" && message["content"].as_str().is_some_and(|text| text.contains("write_file") && text.contains("may or may not have happened"))), "{messages:?}");
        assert!(messages.iter().any(|message| message["role"] == "tool" && message.to_string().contains("outcome_unknown")));
        assert!(messages.iter().any(|message| message["role"] == "tool" && message["tool_call_id"] == "never-dispatched"));
        let prefix = log.prefix(100, 128 * 1024).await.unwrap();
        assert!(!prefix.events.iter().any(|event| event.event.invocation.invocation_id == "invocation" && matches!(event.event.fact, Fact::ToolSettled { .. })));
    }).await.unwrap();
}

#[tokio::test]
async fn item_acceptance_survives_crashes_before_dispatch_before_settlement_and_after_settlement() {
    use maka_agent_facts::event::EventWrite;
    use maka_agent_facts::event::ToolOutcome;
    use maka_agent_facts::model::ModelEvent;
    use maka_agent_facts::tool_call::ToolCallIdentity;
    for cut in 0..3 {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("events.sqlite");
        let log = EventLog::open(&path).await.unwrap();
        opening(&log).await;
        recovery::item_request(&log).await;
        let call = ModelToolCall {
            id: "call".into(),
            name: "write_file".into(),
            input: json!({"path":"effect.txt"}).into(),
            provider_options: Some(json!({"openai":{"itemId":"opaque"}})),
            provider_executed: false,
        };
        let dispatch = |input| Fact::ToolDispatched {
            presentation: None,
            title: None,
            operation_id: "step:call".into(),
            call: ToolCallIdentity::provider("step".into(), "call".into()),
            name: call.name.clone(),
            input,
        };
        let attempt = |fact| EventWrite::plain(RuntimeEvent::new(invocation(), fact)).unwrap();
        assert!(
            log.append(&attempt(dispatch(call.input.as_json().unwrap().clone())))
                .await
                .is_err(),
            "an unaccepted call cannot acquire execution"
        );
        let mut writer = crate::support::model_records::writer(invocation(), "step", true);
        let writes = crate::support::model_records::observations(
            &mut writer,
            [ModelEvent::ToolCall(call.clone())],
        );
        let sequences = log.append_batch(&writes).await.unwrap();
        crate::support::model_records::receipts(&mut writer, &writes, &sequences);
        assert!(
            log.append(&attempt(dispatch(json!({"path":"different.txt"}))))
                .await
                .is_err(),
            "accepted arguments cannot change"
        );
        if cut > 0 {
            append(&log, dispatch(call.input.as_json().unwrap().clone())).await;
        }
        if cut > 1 {
            append(
                &log,
                Fact::ToolSettled {
                    operation_id: "step:call".into(),
                    outcome: ToolOutcome::Failed {
                        message: "known failure after operation".into(),
                    },
                },
            )
            .await;
        }
        log.close().await.unwrap();
        let log = EventLog::open(&path).await.unwrap();
        assert_eq!(recover(&log).await.unwrap(), 1);
        assert_eq!(recover(&log).await.unwrap(), 0);
        let prefix = log.prefix(100, 128 * 1024).await.unwrap();
        assert_eq!(
            prefix
                .events
                .iter()
                .filter(|event| matches!(event.event.fact, Fact::ToolDispatched { .. }))
                .count(),
            usize::from(cut > 0)
        );
        assert_eq!(
            prefix
                .events
                .iter()
                .filter(|event| matches!(event.event.fact, Fact::ToolRejected { .. }))
                .count(),
            usize::from(cut == 0)
        );
        assert!(
            matches!(&prefix.events.last().unwrap().event.fact,Fact::InvocationEnded {outcome:InvocationOutcome::Failed {class,..}}
            if class == if cut == 1 {"outcome_unknown"} else {"host_interrupted"})
        );

        if cut != 1 {
            let source = log
                .capture_model_context("session", None, 10_000, 16 * 1024 * 1024)
                .await
                .unwrap();
            assert!(source.tail.iter().any(
                |event| matches!(event,maka_event_log::context::ContextEvent::ModelItems(items)
                if items.items.iter().any(|item| matches!(item.part,ModelPart::ToolCall {..})))
            ));
        } else {
            assert!(
                log.read_model_view("session", None).await.is_err(),
                "unsettled effects cannot silently resume"
            );
        }
    }
}

#[tokio::test]
async fn accepted_history_budget_counts_complete_items_not_token_envelopes() {
    use maka_agent_facts::model::ModelEvent;
    use maka_agent_facts::model::TextKind;
    for interrupted in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let log = EventLog::open(&directory.path().join("events.sqlite"))
            .await
            .unwrap();
        opening(&log).await;
        recovery::item_request(&log).await;
        let mut writer = crate::support::model_records::writer(invocation(), "step", true);
        let mut observations = vec![ModelEvent::PartStarted {
            id: "text".into(),
            text_kind: TextKind::Text,
            provider_options: None,
        }];
        observations.extend((0..128).map(|_| ModelEvent::PartDelta {
            id: "text".into(),
            text: "x".into(),
            provider_options: None,
        }));
        observations.push(ModelEvent::PartFinished {
            id: "text".into(),
            provider_options: Some(json!({"openai":{"itemId":"kept"}})),
        });
        if !interrupted {
            observations.push(ModelEvent::Finished {
                reason: maka_agent_facts::model::ModelFinishReason::Stop,
                usage: ModelUsage::default(),
                provider_options: None,
            });
        }
        let writes = crate::support::model_records::observations(&mut writer, observations);
        let sequences = log.append_batch(&writes).await.unwrap();
        crate::support::model_records::receipts(&mut writer, &writes, &sequences);
        append(
            &log,
            if interrupted {
                Fact::ModelInterrupted {
                    model_failure: None,
                    diagnostic: None,
                    step_id: "step".into(),
                    status: ModelInterruption::RetryableFailure,
                    partial: writer.partial(),
                }
            } else {
                Fact::ModelCompleted {
                    step_id: "step".into(),
                    output: writer.completed().unwrap().completion(),
                }
            },
        )
        .await;
        append(
            &log,
            Fact::InvocationEnded {
                outcome: InvocationOutcome::Failed {
                    model_failure: None,
                    class: "fixture_end".into(),
                    message: None,
                },
            },
        )
        .await;
        let source = log
            .capture_model_context("session", None, 10_000, 16 * 1024 * 1024)
            .await
            .unwrap();
        let items = source
            .tail
            .iter()
            .find_map(|event| match event {
                maka_event_log::context::ContextEvent::ModelItems(items) => Some(items),
                _ => None,
            })
            .unwrap();
        assert_eq!(items.items.len(), 1);
        assert!(
            matches!(&items.items[0].part,ModelPart::Text {text,provider_options:Some(options),..}
            if text.chunks().collect::<String>() == "x".repeat(128) && options["openai"]["itemId"] == "kept")
        );
        assert!(items.items[0].sequence < items.sequence);
        assert_eq!(items.items[0].index, 0);
    }
}
