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

pub(super) const SUMMARY: &str =
    "Custom summary without required sections. Continue with these details:...";

fn identity(id: &str) -> Invocation {
    Invocation {
        session_id: "session".into(),
        turn_id: id.into(),
        run_id: id.into(),
        invocation_id: id.into(),
    }
}
pub(super) fn event(id: &str, fact: Fact) -> EventWrite {
    EventWrite::plain(RuntimeEvent::new(identity(id), fact)).unwrap()
}
fn step(text: &str) -> ModelStep {
    serde_json::from_value(
        json!({"parts":[{"kind":"text","text_kind":"text","text":text}],
        "finish_reason":"stop","usage":{}}),
    )
    .unwrap()
}
fn request(id: &str, source: &ModelContextSource) -> EventWrite {
    event(
        id,
        Fact::ModelRequested {
            context_breakdown: None,
            item_acceptance: false,
            effective_source_digest: Some(source.effective_source_digest.clone()),
            purpose: maka_agent_facts::context::ModelPurpose::Summary,
            context: None,
            step_id: format!("{id}-summary"),
            model_id: "test".into(),
            source_scope: source.source_evidence.scope.clone(),
            source_high_water: source.source_evidence.high_water,
            source_digest: source.source_evidence.digest.clone(),
            input_digest: "input".into(),
            route_identity: format!("sha256:{}", "a".repeat(64)),
            checkpoint_event_id: source.baseline.as_ref().map(|b| b.event_id.clone()),
        },
    )
}
pub(super) async fn closed(
    log: &EventLog,
    id: &str,
    body_bytes: usize,
    observations: usize,
) -> String {
    log.append(&event(
        id,
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                source_messages: Vec::new(),
                content: "question".into(),
                request_fingerprint: None,
            },
        },
    ))
    .await
    .unwrap();
    log.append(&event(
        id,
        Fact::ModelRequested {
            context_breakdown: None,
            item_acceptance: false,
            effective_source_digest: None,
            purpose: maka_agent_facts::context::ModelPurpose::Main,
            context: None,
            step_id: format!("{id}:step"),
            model_id: "test".into(),
            source_scope: LogScope::Session {
                id: "session".into(),
            },
            source_high_water: 0,
            source_digest: "fixture".into(),
            input_digest: "fixture".into(),
            route_identity: "fixture".into(),
            checkpoint_event_id: None,
        },
    ))
    .await
    .unwrap();
    let observations: Vec<_> = (0..observations)
        .map(|_| {
            event(
                id,
                Fact::ModelObserved {
                    step_id: format!("{id}:step"),
                    event: ModelEvent::PartDelta {
                        id: "text".into(),
                        text: "part".into(),
                        provider_options: None,
                    },
                },
            )
        })
        .collect();
    let first = observations[0].event().id.clone();
    log.append_batch(&observations).await.unwrap();
    log.append_batch(&[
        event(
            id,
            Fact::ModelCompleted {
                step_id: format!("{id}:step"),
                output: step(&"x".repeat(body_bytes)),
            },
        ),
        event(
            id,
            Fact::InvocationEnded {
                outcome: InvocationOutcome::Completed,
            },
        ),
    ])
    .await
    .unwrap();
    first
}
pub(super) async fn prepared(log: &EventLog, id: &str) -> Vec<EventWrite> {
    prepare_trace(log, id, 0, false).await
}

pub(super) async fn prepare_trace(
    log: &EventLog,
    id: &str,
    observations: usize,
    fail: bool,
) -> Vec<EventWrite> {
    log.append(&event(
        id,
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::ContextCompact {
                request_fingerprint: id.into(),
            },
        },
    ))
    .await
    .unwrap();
    let source = log
        .capture_compaction_context(
            "session",
            Some(id),
            &maka_agent_facts::context::CheckpointMode::Standalone,
            100_000,
            64 * 1024 * 1024,
        )
        .await
        .unwrap();
    let output = step(SUMMARY);
    let summary = TextSummary::from_model_step(&output).unwrap();
    log.append(&request(id, &source)).await.unwrap();
    let trace: Vec<_> = (0..observations)
        .map(|_| {
            event(
                id,
                Fact::ModelObserved {
                    step_id: format!("{id}-summary"),
                    event: ModelEvent::PartDelta {
                        id: "summary-text".into(),
                        text: "part".into(),
                        provider_options: None,
                    },
                },
            )
        })
        .collect();
    log.append_batch(&trace).await.unwrap();
    if fail {
        log.append_batch(&[
            event(
                id,
                Fact::ModelInterrupted {
                    model_failure: None,
                    diagnostic: None,
                    step_id: format!("{id}-summary"),
                    status: maka_agent_facts::event::ModelInterruption::Failed,
                },
            ),
            event(
                id,
                Fact::InvocationEnded {
                    outcome: InvocationOutcome::Failed {
                        model_failure: None,
                        class: "summary_failed".into(),
                        message: None,
                    },
                },
            ),
        ])
        .await
        .unwrap();
        return Vec::new();
    }
    log.append_batch(&[event(
        id,
        Fact::ModelCompleted {
            step_id: format!("{id}-summary"),
            output,
        },
    )])
    .await
    .unwrap();
    let checkpoint = event(
        id,
        Fact::ContextCheckpointRecorded {
            checkpoint: ContextCheckpoint {
                mode: maka_agent_facts::context::CheckpointMode::Standalone,
                covered_through: source.source_evidence.high_water,
                source_digest: source.source_evidence.digest,
                previous_checkpoint_id: source.baseline.map(|b| b.event_id),
                summary,
                summary_step_id: format!("{id}-summary"),
            },
        },
    );
    let terminal = event(
        id,
        Fact::InvocationEnded {
            outcome: InvocationOutcome::ContextCompactFinished {
                outcome: CompactOutcome::Compacted {
                    checkpoint_id: checkpoint.event().id.clone(),
                },
            },
        },
    );
    vec![checkpoint, terminal]
}

#[tokio::test]
async fn adoption_markers_are_durable_timed_and_hidden_from_recall() {
    use maka_agent_facts::context::CheckpointMode;
    use maka_agent_ports::session::history::{HistoryView, Page, Position, Role};
    use std::time::{Duration, UNIX_EPOCH};

    for standalone in [false, true] {
        for adopt in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("markers.sqlite");
            let log = EventLog::open(&path).await.unwrap();
            log.create_session("session", "create", &json!({}), 1)
                .await
                .unwrap();
            log.append_batch(&[
                event(
                    "prior",
                    Fact::InvocationOpened {
                        configuration: None,
                        input: InvocationInput::Message {
                            source_messages: Vec::new(),
                            content: "prior question".into(),
                            request_fingerprint: None,
                        },
                    },
                ),
                event(
                    "prior",
                    Fact::InvocationEnded {
                        outcome: InvocationOutcome::Completed,
                    },
                ),
            ])
            .await
            .unwrap();
            let id = "compacting";
            log.append(&event(
                id,
                Fact::InvocationOpened {
                    configuration: None,
                    input: if standalone {
                        InvocationInput::ContextCompact {
                            request_fingerprint: "compact".into(),
                        }
                    } else {
                        InvocationInput::Message {
                            source_messages: Vec::new(),
                            content: "continue".into(),
                            request_fingerprint: None,
                        }
                    },
                },
            ))
            .await
            .unwrap();
            let mode = if standalone {
                CheckpointMode::Standalone
            } else {
                CheckpointMode::PreTurn
            };
            let source = log
                .capture_compaction_context("session", Some(id), &mode, 100_000, 64 * 1024 * 1024)
                .await
                .unwrap();
            let timed = |write: EventWrite, at| {
                let mut value = write.event().clone();
                value.recorded_at = UNIX_EPOCH + Duration::from_millis(at);
                EventWrite::plain(value).unwrap()
            };
            log.append(&timed(request(id, &source), 1000))
                .await
                .unwrap();
            let output = step("custom summary");
            log.append(&timed(
                event(
                    id,
                    Fact::ModelCompleted {
                        step_id: format!("{id}-summary"),
                        output: output.clone(),
                    },
                ),
                2000,
            ))
            .await
            .unwrap();
            let mut retry = request(id, &source).event().clone();
            if let Fact::ModelRequested { step_id, .. } = &mut retry.fact {
                *step_id = "retry".into();
            }
            log.append(&timed(EventWrite::plain(retry).unwrap(), 3000))
                .await
                .unwrap();
            if !standalone {
                let main_source = log
                    .capture_model_context("session", Some(id), 100_000, 64 * 1024 * 1024)
                    .await
                    .unwrap();
                let mut main = request(id, &main_source).event().clone();
                if let Fact::ModelRequested {
                    step_id,
                    purpose,
                    effective_source_digest,
                    ..
                } = &mut main.fact
                {
                    *step_id = "concurrent-main".into();
                    *purpose = maka_agent_facts::context::ModelPurpose::Main;
                    *effective_source_digest = None;
                }
                log.append(&timed(EventWrite::plain(main).unwrap(), 3500))
                    .await
                    .unwrap();
            }

            log.append(&timed(
                event(
                    id,
                    Fact::ModelCompleted {
                        step_id: "retry".into(),
                        output: output.clone(),
                    },
                ),
                4000,
            ))
            .await
            .unwrap();
            if !standalone {
                log.append(&timed(
                    event(
                        id,
                        Fact::ModelCompleted {
                            step_id: "concurrent-main".into(),
                            output: serde_json::from_value(
                                json!({"parts":[], "finish_reason":"stop", "usage":{}}),
                            )
                            .unwrap(),
                        },
                    ),
                    4500,
                ))
                .await
                .unwrap();
            }
            let checkpoint = timed(
                event(
                    id,
                    Fact::ContextCheckpointRecorded {
                        checkpoint: ContextCheckpoint {
                            mode,
                            covered_through: source.source_evidence.high_water,
                            source_digest: source.source_evidence.digest.clone(),
                            previous_checkpoint_id: source
                                .baseline
                                .as_ref()
                                .map(|b| b.event_id.clone()),
                            summary: TextSummary::from_model_step(&output).unwrap(),
                            summary_step_id: "retry".into(),
                        },
                    },
                ),
                5500,
            );
            let terminal = timed(
                event(
                    id,
                    Fact::InvocationEnded {
                        outcome: if !adopt {
                            InvocationOutcome::Failed {
                                model_failure: None,
                                class: "summary_failed".into(),
                                message: None,
                            }
                        } else if standalone {
                            InvocationOutcome::ContextCompactFinished {
                                outcome: CompactOutcome::Compacted {
                                    checkpoint_id: checkpoint.event().id.clone(),
                                },
                            }
                        } else {
                            InvocationOutcome::Completed
                        },
                    },
                ),
                6000,
            );
            let through = if adopt {
                *log.append_batch(&[checkpoint.clone(), terminal])
                    .await
                    .unwrap()
                    .last()
                    .unwrap()
            } else {
                log.append(&terminal).await.unwrap()
            };

            for view in [HistoryView::Conversation, HistoryView::Text] {
                let Page::Ready { chunks, .. } = log
                    .history_view(
                        "session",
                        through,
                        Position::Start,
                        false,
                        view,
                        128 * 1024,
                        None,
                        1024 * 1024,
                    )
                    .await
                    .unwrap();
                let markers: Vec<_> = chunks
                    .iter()
                    .filter(|chunk| chunk.role == Role::Compaction)
                    .collect();
                if adopt && view == HistoryView::Conversation {
                    assert_eq!(markers.len(), 1);
                    assert_eq!(markers[0].message_id, checkpoint.event().id);
                    assert_eq!(markers[0].timestamp, 5500);
                    assert_eq!(markers[0].compaction.as_ref().unwrap().duration_ms, 4500);
                    assert_eq!(markers[0].text, "");
                } else {
                    assert!(markers.is_empty());
                }
            }
            log.close().await.unwrap();
            let log = EventLog::open(&path).await.unwrap();

            let Page::Ready { chunks, .. } = log
                .history_view(
                    "session",
                    through,
                    Position::Start,
                    false,
                    HistoryView::Conversation,
                    128 * 1024,
                    None,
                    1024 * 1024,
                )
                .await
                .unwrap();
            let markers: Vec<_> = chunks
                .iter()
                .filter(|chunk| chunk.compaction.is_some())
                .collect();
            assert_eq!(markers.len(), usize::from(adopt));
            if adopt {
                assert_eq!(markers[0].message_id, checkpoint.event().id);
                assert_eq!(markers[0].compaction.as_ref().unwrap().duration_ms, 4500);
            }
            log.close().await.unwrap();
        }
    }
}
