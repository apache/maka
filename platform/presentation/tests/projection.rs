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

use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::InvocationInput;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::LogScope;
use maka_agent_facts::event::MessageInput;
use maka_agent_facts::event::ModelInterruption;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::event::StoredEvent;
use maka_agent_facts::history::RowPosition;
use maka_agent_facts::model::ModelEvent;
use maka_agent_facts::model::ModelPart;
use maka_agent_facts::model::ModelStep;
use maka_agent_facts::model::ModelUsage;
use maka_agent_facts::model::TextKind;
use maka_presentation::{Content, InvocationView, ProjectionError};
use serde_json::json;
use std::time::{Duration, UNIX_EPOCH};

fn events(outcome: InvocationOutcome) -> Vec<StoredEvent> {
    let invocation = Invocation {
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    let options = Some(json!({"vendor":{"signature":"signed"}}));
    let usage = ModelUsage {
        input_tokens: Some(2),
        output_tokens: Some(3),
        ..Default::default()
    };
    let mut facts = vec![
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                source_messages: Vec::new(),
                content: MessageInput {
                    display_text: Some("visible input".into()),
                    .."model input".into()
                },
                request_fingerprint: Some("admission".into()),
            },
        },
        Fact::ModelRequested {
            context_breakdown: None,
            item_acceptance: false,
            effective_source_digest: None,
            purpose: maka_agent_facts::context::ModelPurpose::Main,
            context: None,
            checkpoint_event_id: None,
            step_id: "step".into(),
            model_id: "historical-model".into(),
            source_scope: LogScope::Session {
                id: "session".into(),
            },
            source_high_water: 1,
            source_digest: "source".into(),
            input_digest: "input".into(),
            route_identity: "route".into(),
        },
        Fact::ModelObserved {
            step_id: "step".into(),
            event: ModelEvent::PartStarted {
                id: "provider-part".into(),
                text_kind: TextKind::Text,
                provider_options: None,
            },
        },
        Fact::ModelObserved {
            step_id: "step".into(),
            event: ModelEvent::PartDelta {
                id: "provider-part".into(),
                text: "😀 hello".into(),
                provider_options: options.clone(),
            },
        },
    ];
    if matches!(
        outcome,
        InvocationOutcome::Completed | InvocationOutcome::HandoffPaused { .. }
    ) {
        facts.extend([
            Fact::ModelObserved {
                step_id: "step".into(),
                event: ModelEvent::PartFinished {
                    id: "provider-part".into(),
                    provider_options: None,
                },
            },
            Fact::ModelObserved {
                step_id: "step".into(),
                event: ModelEvent::Finished {
                    reason: maka_agent_facts::model::ModelFinishReason::Stop,
                    usage: usage.clone(),
                    provider_options: None,
                },
            },
            Fact::ModelCompleted {
                step_id: "step".into(),
                output: ModelStep {
                    parts: vec![ModelPart::Text {
                        text_kind: TextKind::Text,
                        text: "😀 hello".into(),
                        provider_options: options,
                    }],
                    finish_reason: maka_agent_facts::model::ModelFinishReason::Stop,
                    usage,
                    provider_options: None,
                    response_id: None,
                    model: None,
                    timestamp: None,
                },
            },
        ]);
    } else {
        facts.push(Fact::ModelInterrupted {
            model_failure: None,
            diagnostic: None,
            step_id: "step".into(),
            status: if matches!(outcome, InvocationOutcome::Cancelled { .. }) {
                ModelInterruption::Cancelled
            } else {
                ModelInterruption::Failed
            },
        });
    }
    facts.push(Fact::InvocationEnded { outcome });
    facts
        .into_iter()
        .enumerate()
        .map(|(index, fact)| {
            let mut event = RuntimeEvent::new(invocation.clone(), fact);
            event.recorded_at = UNIX_EPOCH + Duration::from_millis(1_000 + index as u64);
            StoredEvent {
                sequence: 10 + index as u64 * 2,
                event,
            }
        })
        .collect()
}

#[test]
fn completed_and_interrupted_rows_keep_overlay_identity_time() {
    let mut messages = Vec::new();
    for outcome in [
        InvocationOutcome::Completed,
        InvocationOutcome::Cancelled {
            source: "user".into(),
        },
        InvocationOutcome::Failed {
            model_failure: None,
            class: "provider".into(),
            message: Some("factual failure".into()),
        },
        InvocationOutcome::HandoffPaused {
            pause: maka_agent_facts::handoff::HandoffPause {
                intent: maka_agent_facts::handoff::HandoffIntent {
                    handoff_id: "handoff".into(),
                    host_epoch: "host".into(),
                    root_run_id: "run".into(),
                    successor_run_id: "successor-run".into(),
                    successor_invocation_id: "successor-invocation".into(),
                    claim_id: "claim".into(),
                },
                execution: Box::new(maka_agent_facts::handoff::HandoffExecution {
                    replay: maka_agent_facts::continuation::ReplayEvidence {
                        version: maka_agent_facts::continuation::REPLAY_VERSION,
                        digest: format!("sha256:{}", "a".repeat(64)),
                        route_identity: format!("sha256:{}", "b".repeat(64)),
                    },
                    context: None,
                    provider_options: serde_json::json!({}),
                    main_output_limit: None,
                    supports_vision: false,
                    tools: maka_agent_facts::handoff::HandoffTools {
                        catalog_digest: format!("sha256:{}", "c".repeat(64)),
                        loaded: Default::default(),
                    },
                    compaction: maka_agent_facts::handoff::CompactionBudget::Available,
                    replay_base: None,
                }),
            },
        },
    ] {
        let events = events(outcome.clone());
        let mut view = InvocationView::new();
        let mut replay = InvocationView::new();
        let mut rows = Vec::new();
        let mut frozen = Vec::new();
        for (index, stored) in events.iter().enumerate() {
            let next = view.push(stored).unwrap();
            let roundtrip = StoredEvent {
                sequence: stored.sequence,
                event: serde_json::from_slice(&serde_json::to_vec(&stored.event).unwrap()).unwrap(),
            };
            assert_eq!(next, replay.push(&roundtrip).unwrap());
            if index == 3 {
                assert!(
                    next.is_empty(),
                    "observation does not publish a mutable durable row"
                );
                frozen = view.overlay();
                assert_eq!(frozen.len(), 1);
                assert_eq!(frozen[0].id, events[2].event.id);
                assert_eq!(frozen[0].ts, 1002);
            }
            rows.extend(next);
        }
        assert!(view.overlay().is_empty());
        let assistant = rows
            .iter()
            .find(|row| matches!(row.message.content, Content::Assistant { .. }))
            .unwrap();
        if let Content::Assistant { interrupted, .. } = &mut frozen[0].content {
            assert!(!*interrupted, "live overlay is not a failed fragment");
            *interrupted = matches!(outcome, InvocationOutcome::Failed { .. });
        }
        assert_eq!(
            assistant.message, frozen[0],
            "overlay and settled presentation keep the same content identity"
        );
        assert_eq!(rows[0].message.ts, 1000);
        assert!(
            matches!(&rows[0].message.content, Content::User { text, display_text, .. }
            if text == "model input" && display_text.as_deref() == Some("visible input"))
        );
        assert!(
            matches!(&assistant.message.content, Content::Assistant { model_id, .. } if model_id == "historical-model")
        );
        assert_eq!(
            rows.iter()
                .filter(|row| matches!(row.message.content, Content::TokenUsage { .. }))
                .count(),
            usize::from(matches!(
                outcome,
                InvocationOutcome::Completed | InvocationOutcome::HandoffPaused { .. }
            )),
            "no fabricated usage after interruption"
        );
        assert!(
            rows.windows(2)
                .all(|rows| rows[0].position < rows[1].position)
        );
        assert!(rows.last().unwrap().position.source_sequence <= events.last().unwrap().sequence);
        let terminal = serde_json::to_value(&rows.last().unwrap().message).unwrap();
        let expected = match outcome {
            InvocationOutcome::Completed | InvocationOutcome::ContextCompactFinished { .. } => {
                Some("completed")
            }
            InvocationOutcome::Cancelled { .. } => Some("aborted"),
            InvocationOutcome::Failed { .. } => Some("failed"),
            InvocationOutcome::HandoffPaused { .. } => None,
        };
        if let Some(expected) = expected {
            assert_eq!(terminal["id"], events.last().unwrap().event.id);
            assert_eq!(terminal["status"], expected);
        } else {
            assert!(
                !rows
                    .iter()
                    .any(|row| matches!(row.message.content, Content::TurnState { ref state } if !matches!(state, maka_presentation::TurnState::Running))),
                "physical pause must not publish a logical Turn terminal"
            );
        }
        messages.extend(rows.into_iter().map(|row| row.message));
    }
    // A closed part is not a successful request. Only provider-finalized
    // reasoning keeps its normal presentation after the surrounding request fails.
    for (options, finalized) in [
        (json!({}), false),
        (json!({"anthropic":{"signature":"signed"}}), true),
        (json!({"anthropic":{"redactedData":"opaque"}}), true),
        (
            json!({"openai":{"itemId":"r","reasoningEncryptedContent":"opaque"}}),
            true,
        ),
        (
            json!({"makaResponses":{"version":1,"profile":"relay","itemId":"r","summaryPartLengths":[2]}}),
            true,
        ),
        (
            json!({"makaResponses":{"version":1,"profile":"relay","itemId":"r","summaryPartLengths":[-1]}}),
            false,
        ),
    ] {
        for kind in [TextKind::Text, TextKind::Thinking] {
            let mut facts = events(InvocationOutcome::Failed {
                model_failure: None,
                class: "provider".into(),
                message: None,
            });
            if let Fact::ModelObserved {
                event:
                    ModelEvent::PartStarted {
                        text_kind,
                        provider_options,
                        ..
                    },
                ..
            } = &mut facts[2].event.fact
            {
                *text_kind = kind;
                *provider_options = Some(options.clone());
            }
            let mut closed = StoredEvent {
                sequence: facts[3].sequence + 1,
                event: facts[3].event.clone(),
            };
            closed.event.id = "part-closed".into();
            closed.event.fact = Fact::ModelObserved {
                step_id: "step".into(),
                event: ModelEvent::PartFinished {
                    id: "provider-part".into(),
                    provider_options: None,
                },
            };
            facts.insert(4, closed);
            let mut view = InvocationView::new();
            for fact in facts {
                for row in view.push(&fact).unwrap() {
                    if let Content::Assistant {
                        interrupted, text, ..
                    } = &row.message.content
                    {
                        assert_eq!(*interrupted, kind == TextKind::Text || !finalized);
                        assert_eq!(text.is_empty(), kind == TextKind::Thinking);
                        messages.push(row.message);
                    }
                }
            }
        }
    }
}

#[test]
fn complete_text_is_retained_and_malformed_evidence_poisons_the_view() {
    let mut events = events(InvocationOutcome::Completed);
    let mut view = InvocationView::new();
    for event in &events[..3] {
        view.push(event).unwrap();
    }
    let Fact::ModelObserved {
        event: ModelEvent::PartDelta { text, .. },
        ..
    } = &mut events[3].event.fact
    else {
        unreachable!()
    };
    *text = "x".repeat(1025);
    view.push(&events[3]).unwrap();
    assert!(view.overlay().iter().any(|message| matches!(&message.content, Content::Assistant {text,..} if text == &"x".repeat(1025))),"complete observed delta must survive");

    let mut view = InvocationView::new();
    view.push(&events[0]).unwrap();
    assert!(
        view.push(&events[0]).is_err(),
        "sequence replay is not another message"
    );
    let mut oversized = events.remove(0);
    oversized.sequence = 9_007_199_254_740_992;
    assert!(matches!(
        InvocationView::new().push(&oversized),
        Err(ProjectionError::OutOfRange)
    ));
}

#[test]
fn interrupted_request_without_output_has_a_durable_diagnostic_not_an_assistant_message() {
    let source = events(InvocationOutcome::Completed);
    let mut view = InvocationView::new();
    view.push(&source[0]).unwrap();
    view.push(&source[1]).unwrap();
    let failed = StoredEvent {
        sequence: source[1].sequence + 1,
        event: RuntimeEvent::new(
            source[0].event.invocation.clone(),
            Fact::ModelInterrupted {
                model_failure: None,
                step_id: "step".into(),
                status: ModelInterruption::RetryableFailure,
                diagnostic: Some("Responses WebSocket closed: fixture diagnostic".into()),
            },
        ),
    };
    let failed = StoredEvent {
        sequence: failed.sequence,
        event: serde_json::from_slice(&serde_json::to_vec(&failed.event).unwrap()).unwrap(),
    };
    let rows = view.push(&failed).unwrap();
    assert_eq!(rows.len(), 1);
    assert!(
        matches!(&rows[0].message.content, Content::ModelInterruption { message } if message.contains("fixture diagnostic"))
    );
    assert!(view.overlay().is_empty());
}

#[test]
fn annotated_openings_preserve_source_identity_and_unannotated_batches_stay_aggregated() {
    use maka_agent_facts::input::DeliveredMessage;
    use maka_agent_facts::message::RootSourceMessage;
    use maka_agent_facts::message::{MessageDisposition, MessageOrigin, Placement};
    let source = |id: &str, text: &str, origin| {
        let mut content: MessageInput = text.into();
        content.display_text = Some(format!("visible {text}"));
        content.attachments = Some(
            serde_json::from_value(json!([
                {"kind":"other","name":id,"mimeType":"text/plain","bytes":1,
                 "ref":{"kind":"session_file","sessionId":"session","relativePath":id}}
            ]))
            .unwrap(),
        );
        content.inline_references = Some(
            serde_json::from_value(json!([
                {"kind":"workspace_file","value":text,"label":"reference","start":0}
            ]))
            .unwrap(),
        );
        RootSourceMessage {
            unprepared_content: content.clone(),
            message: DeliveredMessage {
                message_id: id.into(),
                submitted_content_digest: content.content_digest().unwrap(),
                content,
                origin,
            },
            submitted_placement: Placement::CurrentTurn,
            disposition: MessageDisposition::TurnStarted,
            submitted_intent: None,
        }
    };
    for annotated in [false, true] {
        let sources = vec![
            source("human", "human", None),
            source(
                "notice",
                "notice",
                annotated.then(|| MessageOrigin::WorkhubTask {
                    task_id: "wt_actual".into(),
                }),
            ),
        ];
        let content = maka_agent_facts::message::aggregate(
            sources.iter().map(|source| &source.message.content),
        );
        let mut opening = events(InvocationOutcome::Completed).remove(0);
        opening.event.id = "opening".into();
        opening.event.fact = Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                content: content.clone(),
                source_messages: sources.clone(),
                request_fingerprint: None,
            },
        };
        let mut view = InvocationView::new();
        let rows = view.push(&opening).unwrap();
        assert_eq!(rows.len(), if annotated { 3 } else { 2 });
        if annotated {
            for (row, source) in rows.iter().zip(&sources) {
                assert_eq!(row.message.id, source.message.message_id);
                let Content::User {
                    text,
                    display_text,
                    attachments,
                    inline_references,
                    origin,
                    ..
                } = &row.message.content
                else {
                    panic!("user source")
                };
                assert_eq!(text, &source.message.content.text);
                assert_eq!(display_text, &source.message.content.display_text);
                assert_eq!(attachments, &source.message.content.attachments);
                assert_eq!(inline_references, &source.message.content.inline_references);
                assert_eq!(origin, &source.message.origin);
            }
            assert!(rows[0].position < rows[1].position && rows[1].position < rows[2].position);
            let mut delivered = sources[1].message.clone();
            delivered.message_id = "graph-steering".into();
            delivered.origin = Some(MessageOrigin::WorkhubGraph {
                graph_id: "agent_graph_actual".into(),
            });
            let mut steered = opening;
            steered.sequence += 1;
            steered.event.id = "steering".into();
            steered.event.fact = {
                let message = delivered;
                let mut unprepared_content = message.content.clone();
                unprepared_content.preparation.clear();
                Fact::MessageSteered {
                    source: Box::new(maka_agent_facts::message::RootSourceMessage {
                        message: message.clone(),
                        unprepared_content,
                        submitted_placement: maka_agent_facts::message::Placement::CurrentTurn,
                        disposition: maka_agent_facts::message::MessageDisposition::Steering,
                        submitted_intent: None,
                    }),
                    message: Box::new(message),
                }
            };
            let rows = view.push(&steered).unwrap();
            assert_eq!(rows.len(), 1);
            assert_eq!(
                serde_json::to_value(&rows[0].message).unwrap()["origin"],
                json!({"kind":"workhub_graph","graphId":"agent_graph_actual"})
            );
        } else {
            assert_eq!(rows[0].message.id, "opening");
            let json = serde_json::to_value(&rows[0].message).unwrap();
            assert_eq!(
                json,
                json!({
                    "id":"opening","turnId":"turn","ts":1000,"type":"user",
                    "text":"human\n\nnotice","displayText":"visible human\n\nvisible notice",
                    "attachments":[
                        {"kind":"other","name":"human","mimeType":"text/plain","bytes":1,
                         "ref":{"kind":"session_file","sessionId":"session","relativePath":"human"}},
                        {"kind":"other","name":"notice","mimeType":"text/plain","bytes":1,
                         "ref":{"kind":"session_file","sessionId":"session","relativePath":"notice"}}
                    ],
                    "inlineReferences":[
                        {"kind":"workspace_file","value":"human","label":"reference","start":0},
                        {"kind":"workspace_file","value":"notice","label":"reference","start":15}
                    ]
                })
            );
        }
    }
}

fn project_tool_fanout(
    count: usize,
    item_acceptance: bool,
    with_usage: bool,
    _limit: usize,
) -> Vec<maka_presentation::Row> {
    use maka_agent_facts::model::{ModelFinishReason, ModelToolCall, ToolInput};
    use maka_agent_facts::tool_call::ToolCallIdentity;
    let mut original = events(InvocationOutcome::Completed);
    let mut request = original.remove(1);
    let opening = original.remove(0);
    let Fact::ModelRequested {
        item_acceptance: enabled,
        ..
    } = &mut request.event.fact
    else {
        unreachable!()
    };
    *enabled = item_acceptance;
    let invocation = opening.event.invocation.clone();
    let mut view = InvocationView::new();
    view.push(&opening).unwrap();
    view.push(&request).unwrap();
    let mut sequence = request.sequence;
    let mut rows = Vec::new();
    let mut push = |fact| {
        sequence += 1;
        rows.extend(
            view.push(&StoredEvent {
                sequence,
                event: RuntimeEvent::new(invocation.clone(), fact),
            })
            .unwrap(),
        );
    };
    let calls: Vec<_> = (0..count)
        .map(|index| ModelToolCall {
            id: format!("call-{index}"),
            name: "echo".into(),
            input: ToolInput::Json(json!({"note":format!("input-{index}")})),
            provider_options: None,
            provider_executed: false,
        })
        .collect();
    for call in &calls {
        push(Fact::ModelObserved {
            step_id: "step".into(),
            event: ModelEvent::ToolCall(call.clone()),
        });
    }
    let usage = if with_usage {
        ModelUsage {
            input_tokens: Some(7),
            output_tokens: Some(11),
            ..Default::default()
        }
    } else {
        ModelUsage::default()
    };
    push(Fact::ModelObserved {
        step_id: "step".into(),
        event: ModelEvent::Finished {
            reason: ModelFinishReason::ToolCalls,
            usage: usage.clone(),
            provider_options: None,
        },
    });
    push(Fact::ModelCompleted {
        step_id: "step".into(),
        output: ModelStep {
            parts: calls
                .iter()
                .cloned()
                .map(|call| ModelPart::ToolCall { call })
                .collect(),
            finish_reason: ModelFinishReason::ToolCalls,
            usage,
            provider_options: None,
            response_id: None,
            model: None,
            timestamp: None,
        },
    });
    for call in calls {
        let operation_id = format!("step:{}", call.id);
        push(Fact::ToolDispatched {
            presentation: None,
            title: None,
            operation_id: operation_id.clone(),
            call: ToolCallIdentity::provider("step".into(), call.id.clone()),
            name: call.name,
            input: call.input.as_json().unwrap().clone(),
        });
        push(Fact::ToolSettled {
            operation_id,
            outcome: maka_agent_facts::event::ToolOutcome::Failed {
                message: format!("fixture result {}", call.id),
            },
        });
    }
    rows
}

#[test]
fn completion_accepted_fanout_projects_129_original_calls_and_results() {
    let rows = project_tool_fanout(129, false, false, 1024 * 1024);
    let calls: Vec<_> = rows
        .iter()
        .filter_map(|row| match &row.message.content {
            Content::ToolCall { args, .. } => Some(args),
            _ => None,
        })
        .collect();
    assert_eq!(calls.len(), 129);
    assert_eq!(calls[0], &json!({"note":"input-0"}));
    assert_eq!(calls[128], &json!({"note":"input-128"}));
    let results: Vec<_> = rows
        .iter()
        .filter_map(|row| match &row.message.content {
            Content::ToolResult {
                content: maka_presentation::ToolContent::Text { text },
                ..
            } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(results.len(), 129);
    assert_eq!(results[128], "fixture result call-128");
}

#[test]
fn item_accepted_fanout_projects_257_calls_with_distinct_original_positions() {
    let rows = project_tool_fanout(257, true, false, 1024 * 1024);
    let calls: Vec<_> = rows
        .iter()
        .filter(|row| matches!(row.message.content, Content::ToolCall { .. }))
        .collect();
    assert_eq!(calls.len(), 257);
    assert!(
        calls
            .windows(2)
            .all(|pair| pair[0].position < pair[1].position)
    );
    assert_eq!(
        calls[0].position,
        RowPosition {
            source_sequence: 13,
            item_index: 0
        }
    );
    assert_eq!(
        calls[256].position,
        RowPosition {
            source_sequence: 269,
            item_index: 0
        }
    );
    assert!(
        matches!(&calls[256].message.content, Content::ToolCall { args, .. } if args == &json!({"note":"input-256"}))
    );
    let results: Vec<_> = rows
        .iter()
        .filter_map(|row| match &row.message.content {
            Content::ToolResult {
                content: maka_presentation::ToolContent::Text { text },
                ..
            } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(results.len(), 257);
    assert_eq!(results[256], "fixture result call-256");
}

#[test]
fn complete_text_metadata_survives_start_delta_and_finish() {
    for stage in ["identity", "start", "delta", "finish"] {
        let mut source = events(InvocationOutcome::Completed);
        let mut view = InvocationView::new();
        for event in source.iter().take(2) {
            view.push(event).unwrap();
        }
        let options = Some(json!({"signature":"x".repeat(8192)}));
        let index = match stage {
            "identity" | "start" => 2,
            "delta" => 3,
            _ => 4,
        };
        if stage == "identity" {
            let Fact::ModelObserved {
                event: ModelEvent::PartStarted { id, .. },
                ..
            } = &mut source[index].event.fact
            else {
                unreachable!()
            };
            *id = "x".repeat(8192);
        } else {
            match &mut source[index].event.fact {
                Fact::ModelObserved {
                    event:
                        ModelEvent::PartStarted {
                            provider_options, ..
                        }
                        | ModelEvent::PartDelta {
                            provider_options, ..
                        }
                        | ModelEvent::PartFinished {
                            provider_options, ..
                        },
                    ..
                } => *provider_options = options,
                _ => unreachable!(),
            }
        }
        for event in source.iter().take(index).skip(2) {
            view.push(event).unwrap();
        }
        assert!(
            view.push(&source[index]).is_ok(),
            "{stage} complete metadata must remain available"
        );
    }

    // Replacing one option does not retain every former value. Accepted text
    // options still follow the original completion rather than a new equality rule.
    let mut source = events(InvocationOutcome::Completed);
    let invocation = source[0].event.invocation.clone();
    let mut view = InvocationView::new();
    for event in source.iter().take(3) {
        view.push(event).unwrap();
    }
    let mut sequence = source[2].sequence;
    for _ in 0..8 {
        sequence += 1;
        view.push(&StoredEvent {
            sequence,
            event: RuntimeEvent::new(
                invocation.clone(),
                Fact::ModelObserved {
                    step_id: "step".into(),
                    event: ModelEvent::PartDelta {
                        id: "provider-part".into(),
                        text: String::new(),
                        provider_options: Some(json!({"signature":"x".repeat(1024)})),
                    },
                },
            ),
        })
        .unwrap();
    }
    for event in source.iter_mut().skip(4).take(3) {
        sequence += 1;
        event.sequence = sequence;
        if let Fact::ModelCompleted { output, .. } = &mut event.event.fact {
            let ModelPart::Text { text, .. } = &mut output.parts[0] else {
                unreachable!()
            };
            text.clear();
        }
        let rows = view.push(event).unwrap();
        if matches!(event.event.fact, Fact::ModelCompleted { .. }) {
            assert!(
                matches!(&rows[0].message.content, Content::Assistant { text, provider_options, .. } if text.is_empty() && provider_options == &Some(json!({"vendor":{"signature":"signed"}})))
            );
        }
    }
}

#[test]
fn completion_usage_after_256_calls_has_a_distinct_original_position() {
    let rows = project_tool_fanout(256, false, true, 1024 * 1024);
    let calls: Vec<_> = rows
        .iter()
        .filter(|row| matches!(row.message.content, Content::ToolCall { .. }))
        .collect();
    assert_eq!(calls.len(), 256);
    assert_eq!(
        calls[0].position,
        RowPosition {
            source_sequence: 270,
            item_index: 0
        }
    );
    assert_eq!(
        calls[255].position,
        RowPosition {
            source_sequence: 270,
            item_index: 255
        }
    );
    let usage = rows
        .iter()
        .find(|row| matches!(row.message.content, Content::TokenUsage { .. }))
        .unwrap();
    assert_eq!(
        usage.position,
        RowPosition {
            source_sequence: 270,
            item_index: 256
        }
    );
    assert!(matches!(
        usage.message.content,
        Content::TokenUsage {
            input: 7,
            output: 11,
            ..
        }
    ));
    let next = rows
        .iter()
        .find(|row| matches!(row.message.content, Content::ToolActivity { .. }))
        .unwrap();
    assert_eq!(
        next.position,
        RowPosition {
            source_sequence: 271,
            item_index: 0
        }
    );
    assert!(usage.position < next.position);
}

#[test]
fn individually_fitting_calls_do_not_share_a_tool_payload_budget() {
    for item_acceptance in [false, true] {
        let rows = project_tool_fanout(16, item_acceptance, false, 1024);
        let calls: Vec<_> = rows
            .iter()
            .filter(|row| matches!(row.message.content, Content::ToolCall { .. }))
            .collect();
        let results: Vec<_> = rows
            .iter()
            .filter(|row| matches!(row.message.content, Content::ToolResult { .. }))
            .collect();
        assert_eq!(calls.len(), 16);
        assert_eq!(results.len(), 16);
        for (index, (call, result)) in calls.iter().zip(&results).enumerate() {
            assert!(
                matches!(&call.message.content, Content::ToolCall { tool_name, args, .. }
                if tool_name == "echo" && args == &json!({"note":format!("input-{index}")}))
            );
            assert!(
                matches!(&result.message.content, Content::ToolResult { tool_use_id, content: maka_presentation::ToolContent::Text { text }, .. }
                if tool_use_id == &call.message.id && text == &format!("fixture result call-{index}"))
            );
            assert_eq!(
                call.position,
                if item_acceptance {
                    RowPosition {
                        source_sequence: 13 + index as u64,
                        item_index: 0,
                    }
                } else {
                    RowPosition {
                        source_sequence: 30,
                        item_index: index as u64,
                    }
                }
            );
            assert_eq!(
                result.position,
                RowPosition {
                    source_sequence: 32 + 2 * index as u64,
                    item_index: 0
                }
            );
        }
    }
}

#[test]
fn complete_tool_parts_and_pending_records_remain_available() {
    use maka_agent_facts::model::{ModelToolCall, ToolInput};
    use maka_agent_facts::tool_call::{ToolCallIdentity, ToolOrigin};
    for host_sdk in [false, true] {
        let mut source = events(InvocationOutcome::Completed);
        let mut view = InvocationView::new();
        for event in source.iter().take(if host_sdk { 1 } else { 2 }) {
            view.push(event).unwrap();
        }
        let input = json!({"note":"x".repeat(1025)});
        source[2].event.fact = if host_sdk {
            Fact::ToolDispatched {
                presentation: None,
                title: None,
                operation_id: "oversized".into(),
                call: ToolCallIdentity {
                    tool_call_id: "oversized".into(),
                    origin: ToolOrigin::HostSdk {
                        package_id: "fixture".into(),
                        entry_id: "echo".into(),
                        activation: "test".into(),
                        parent: None,
                    },
                },
                name: "echo".into(),
                input,
            }
        } else {
            Fact::ModelObserved {
                step_id: "step".into(),
                event: ModelEvent::ToolCall(ModelToolCall {
                    id: "oversized".into(),
                    name: "echo".into(),
                    input: ToolInput::Json(input),
                    provider_options: None,
                    provider_executed: false,
                }),
            }
        };
        assert!(view.push(&source[2]).is_ok());
        assert!(
            view.push(&source[2]).is_err(),
            "replayed evidence remains invalid"
        );
    }
}
