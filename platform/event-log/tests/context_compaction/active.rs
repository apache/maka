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
use fixtures::event;
use maka_agent_facts::context::CheckpointMode;
use maka_agent_facts::context::ModelPurpose;
use maka_agent_facts::context::ModelRequestContext;
use maka_event_log::context::LatestMainContext;

fn opening(id: &str) -> EventWrite {
    event(id, Fact::InvocationOpened { configuration: Some(serde_json::from_value(json!({
        "cwd":"/tmp", "sandbox_mode":"workspace-write", "collaboration_mode":"agent",
        "workspace_origin":"selected",
        "approval_policy":{"kind":"on-request"},
        "boundary_revision":0,
        "orchestration_mode":"default", "tool_mode":"direct",
        "model":{"connection_id":"connection", "connection_slug":"test", "model":"test"}, "thinking_level":null
    })).unwrap()), input: InvocationInput::Message { source_messages: Vec::new(), content: serde_json::from_value(json!({
        "text":"Original anchor", "display_text":"Display anchor",
        "quotes":[{"text":"A retained quotation", "label":"source"}]
    })).unwrap(), request_fingerprint: None } })
}

fn request(id: &str, step: &str, purpose: ModelPurpose, source: &ModelContextSource) -> EventWrite {
    event(
        id,
        Fact::ModelRequested {
            context_breakdown: None,
            item_acceptance: false,
            effective_source_digest: (purpose == ModelPurpose::Summary)
                .then(|| source.effective_source_digest.clone()),
            step_id: step.into(),
            model_id: "test".into(),
            purpose,
            context: Some(ModelRequestContext {
                provider_id: "openai".into(),
                context_window: Some(10_000),
                model_context_window: None,
                declared_window: Some(9000),
            }),
            source_scope: source.source_evidence.scope.clone(),
            source_high_water: source.source_evidence.high_water,
            source_digest: source.source_evidence.digest.clone(),
            input_digest: "fixture".into(),
            route_identity: format!("sha256:{}", "a".repeat(64)),
            checkpoint_event_id: source.baseline.as_ref().map(|b| b.event_id.clone()),
        },
    )
}

fn completion(id: &str, step: &str, text: &str) -> EventWrite {
    event(id, Fact::ModelCompleted { step_id: step.into(), output: serde_json::from_value(json!({
        "parts":[{"kind":"text", "text_kind":"text", "text":text}], "finish_reason":"stop", "usage":{"input_tokens":10,"output_tokens":2}
    })).unwrap() })
}

async fn checkpoint(log: &EventLog, id: &str, mode: CheckpointMode) -> EventWrite {
    let source = log
        .capture_compaction_context("session", Some(id), &mode, 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    let step = format!("{id}-summary");
    log.append(&request(id, &step, ModelPurpose::Summary, &source))
        .await
        .unwrap();
    let complete = completion(id, &step, SUMMARY);
    log.append(&complete).await.unwrap();
    let Fact::ModelCompleted { output, .. } = &complete.event().fact else {
        panic!()
    };
    event(
        id,
        Fact::ContextCheckpointRecorded {
            checkpoint: ContextCheckpoint {
                mode,
                covered_through: source.source_evidence.high_water,
                source_digest: source.source_evidence.digest,
                previous_checkpoint_id: source.baseline.map(|b| b.event_id),
                summary: TextSummary::from_model_step(output).unwrap(),
                summary_step_id: step,
            },
        },
    )
}

#[tokio::test]
async fn midturn_checkpoint_excludes_covered_history_after_next_turn_and_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("active.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let anchor = opening("active");
    log.append(&anchor).await.unwrap();
    let source = log
        .capture_model_context("session", Some("active"), 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    log.append(&request("active", "main-step", ModelPurpose::Main, &source))
        .await
        .unwrap();
    let mode = CheckpointMode::MidTurn {
        anchor_event_id: anchor.event().id.clone(),
    };
    assert!(
        log.capture_compaction_context("session", Some("active"), &mode, 100_000, 64 * 1024 * 1024)
            .await
            .is_err()
    );
    log.append(&completion("active", "main-step", "Finished main work"))
        .await
        .unwrap();
    assert_eq!(
        log.context_usage("session")
            .await
            .unwrap()
            .1
            .unwrap()
            .tokens,
        12
    );
    let write = checkpoint(&log, "active", mode.clone()).await;
    let bad_terminal = event(
        "active",
        Fact::InvocationEnded {
            outcome: InvocationOutcome::ContextCompactFinished {
                outcome: CompactOutcome::Compacted {
                    checkpoint_id: write.event().id.clone(),
                },
            },
        },
    );
    assert!(
        log.append_batch(&[write.clone(), bad_terminal])
            .await
            .is_err()
    );
    assert!(
        log.capture_model_context("session", Some("active"), 100_000, 64 * 1024 * 1024)
            .await
            .unwrap()
            .baseline
            .is_none()
    );
    log.append(&write).await.unwrap();
    assert_eq!(
        log.context_usage("session").await.unwrap().1,
        None,
        "a checkpoint must not expose the previous prompt as last-known current context"
    );
    let commits = log.subscribe_commits();
    log.append(&write).await.unwrap();
    assert!(!commits.has_changed().unwrap());
    let competing = event("active", write.event().fact.clone());
    assert!(
        log.append(&competing).await.is_err(),
        "a new candidate cannot reuse a predecessor superseded after its source cut"
    );
    assert!(
        log.capture_compaction_context("session", Some("active"), &mode, 100_000, 64 * 1024 * 1024)
            .await
            .is_err(),
        "a summary completion cannot renew its own compaction budget"
    );
    let source = log
        .capture_model_context("session", Some("active"), 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    assert_eq!(source.baseline.as_ref().unwrap().checkpoint.mode, mode);
    assert!(source.tail.is_empty());
    assert!(
        log.unfinished_invocations(0, 10)
            .await
            .unwrap()
            .invocations
            .len()
            == 1
    );
    log.append(&event(
        "active",
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    ))
    .await
    .unwrap();
    let closed = log
        .capture_model_context("session", None, 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    assert!(matches!(
        log.read_frozen_model_context(&closed.source_evidence, 100, 1)
            .await,
        Err(maka_event_log::StoreError::PrefixTooLarge)
    ));
    log.append(&opening("next")).await.unwrap();
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    let source = log
        .capture_model_context("session", Some("next"), 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    let valid_request = request("next", "next-main", ModelPurpose::Main, &source);
    for changed in ["scope", "checkpoint", "digest"] {
        let mut forged = valid_request.event().clone();
        let Fact::ModelRequested {
            source_scope,
            checkpoint_event_id,
            source_digest,
            ..
        } = &mut forged.fact
        else {
            unreachable!()
        };
        match changed {
            "scope" => *source_scope = LogScope::Session { id: "other".into() },
            "checkpoint" => *checkpoint_event_id = Some("missing-checkpoint".into()),
            "digest" => *source_digest = format!("sha256:{}", "0".repeat(64)),
            _ => unreachable!(),
        }
        assert!(
            log.append(&EventWrite::plain(forged).unwrap())
                .await
                .is_err(),
            "manual message request must authenticate its {changed}"
        );
    }
    log.append(&valid_request).await.unwrap();
    assert_eq!(source.baseline.as_ref().unwrap().checkpoint.mode, mode);
    assert!(
        source
            .tail
            .iter()
            .any(|e| matches!(e, maka_event_log::context::ContextEvent::Canonical(e) if e.event.invocation.invocation_id == "next"))
    );
    log.close().await.unwrap();
}

#[path = "active_safety.rs"]
mod active_safety;
#[path = "latest.rs"]
mod latest;
#[path = "lineage.rs"]
mod lineage;
#[path = "provider_history.rs"]
mod provider_history;

#[tokio::test]
async fn active_cut_rejects_pending_child_and_changed_summary_repair_source() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("unsafe.sqlite"))
        .await
        .unwrap();
    let anchor = opening("active");
    log.append(&anchor).await.unwrap();
    let source = log
        .capture_model_context("session", Some("active"), 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    log.append(&request("active", "main", ModelPurpose::Main, &source))
        .await
        .unwrap();
    log.append(&completion("active", "main", "work"))
        .await
        .unwrap();
    log.append(&event(
        "active",
        Fact::ToolDispatched {
            presentation: None,
            title: None,
            operation_id: "parent".into(),
            call: ToolCallIdentity::standalone("parent-call".into()),
            name: "code".into(),
            input: json!({}),
        },
    ))
    .await
    .unwrap();
    let mode = CheckpointMode::MidTurn {
        anchor_event_id: anchor.event().id.clone(),
    };
    assert!(
        log.capture_compaction_context("session", Some("active"), &mode, 100_000, 64 * 1024 * 1024)
            .await
            .is_err()
    );
    log.append(&event(
        "active",
        Fact::ToolSettled {
            operation_id: "parent".into(),
            outcome: maka_agent_facts::event::ToolOutcome::Failed {
                message: "failed".into(),
            },
        },
    ))
    .await
    .unwrap();
    let source = log
        .capture_compaction_context("session", Some("active"), &mode, 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    log.append(&request(
        "active",
        "summary",
        ModelPurpose::Summary,
        &source,
    ))
    .await
    .unwrap();
    log.append(&completion("active", "summary", "malformed"))
        .await
        .unwrap();
    let mut repair = request("active", "repair", ModelPurpose::Summary, &source)
        .event()
        .clone();
    if let Fact::ModelRequested { source_digest, .. } = &mut repair.fact {
        *source_digest = format!("sha256:{}", "b".repeat(64));
    }
    assert!(
        log.append(&EventWrite::plain(repair).unwrap())
            .await
            .is_err()
    );
    log.append(&request("active", "repair", ModelPurpose::Summary, &source))
        .await
        .unwrap();
    let before_private = log.prefix(100, 65536).await.unwrap();
    let rejected = log
        .append(&event(
            "active",
            Fact::ModelObserved {
                step_id: "repair".into(),
                event: ModelEvent::PartDelta {
                    id: "partial".into(),
                    text: "private failed summary".into(),
                    provider_options: None,
                },
            },
        ))
        .await
        .unwrap_err();
    assert!(
        rejected
            .to_string()
            .contains("private summary output cannot be journaled")
    );
    assert_eq!(
        log.prefix(100, 65536).await.unwrap().digest,
        before_private.digest,
        "private failed Summary prose cannot change the canonical repair source"
    );
    log.append(&event(
        "active",
        Fact::ModelInterrupted {
            model_failure: None,
            diagnostic: None,
            step_id: "repair".into(),
            status: maka_agent_facts::event::ModelInterruption::Failed,
        },
    ))
    .await
    .unwrap();
    log.append(&request(
        "active",
        "last-repair",
        ModelPurpose::Summary,
        &source,
    ))
    .await
    .unwrap();
    log.append(&completion("active", "last-repair", "malformed"))
        .await
        .unwrap();
    assert!(
        log.append(&request(
            "active",
            "excess-repair",
            ModelPurpose::Summary,
            &source
        ))
        .await
        .is_err()
    );
    assert!(
        log.capture_compaction_context("session", Some("active"), &mode, 100_000, 64 * 1024 * 1024)
            .await
            .is_err(),
        "summary events cannot renew their own attempt budget"
    );
    let main = log
        .capture_model_context("session", Some("active"), 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    log.append(&request("active", "new-main", ModelPurpose::Main, &main))
        .await
        .unwrap();
    log.append(&completion("active", "new-main", "new work"))
        .await
        .unwrap();
    let next = log
        .capture_compaction_context("session", Some("active"), &mode, 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    assert!(next.source_evidence.high_water > source.source_evidence.high_water);
    // Main may finish after capture but before Summary's request is committed.
    let raced = log
        .capture_model_context("session", Some("active"), 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    log.append(&request("active", "raced-main", ModelPurpose::Main, &raced))
        .await
        .unwrap();
    log.append(&completion(
        "active",
        "raced-main",
        "completed before summary admission",
    ))
    .await
    .unwrap();
    log.append(&request(
        "active",
        "new-round",
        ModelPurpose::Summary,
        &next,
    ))
    .await
    .unwrap();
    log.append(&completion("active", "new-round", "malformed"))
        .await
        .unwrap();
    assert!(
        log.append(&request(
            "active",
            "stale-new-round",
            ModelPurpose::Summary,
            &main
        ))
        .await
        .is_err(),
        "a new source must cover the Main whose progress renews it"
    );
    let after = log
        .capture_compaction_context("session", Some("active"), &mode, 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    log.append(&request(
        "active",
        "after-race",
        ModelPurpose::Summary,
        &after,
    ))
    .await
    .unwrap();
    log.append(&completion("active", "after-race", "malformed"))
        .await
        .unwrap();
    // An allowed repair of an older round cannot roll back the progress fence.
    log.append(&request(
        "active",
        "older-repair",
        ModelPurpose::Summary,
        &next,
    ))
    .await
    .unwrap();
    log.append(&completion("active", "older-repair", "malformed"))
        .await
        .unwrap();
    assert!(
        log.capture_compaction_context("session", Some("active"), &mode, 100_000, 64 * 1024 * 1024)
            .await
            .is_err()
    );
    log.close().await.unwrap();
}

#[tokio::test]
async fn adoption_markers_are_durable_timed_and_hidden_from_recall() {
    use super::fixtures::{request, step};
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
            let timed = |write: EventWrite, at| {
                let mut value = write.event().clone();
                value.recorded_at = UNIX_EPOCH + Duration::from_millis(at);
                EventWrite::plain(value).unwrap()
            };
            log.append(&timed(
                event(
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
                ),
                0,
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
                        maka_event_log::transcript::HistoryLimits {
                            max_bytes: 128 * 1024,
                            max_chunks: None,
                            max_json_bytes: 1024 * 1024,
                        },
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
                    assert_eq!(
                        markers[0].compaction.as_ref().unwrap().duration_ms,
                        if standalone { 5500 } else { 4500 }
                    );
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
                    maka_event_log::transcript::HistoryLimits {
                        max_bytes: 128 * 1024,
                        max_chunks: None,
                        max_json_bytes: 1024 * 1024,
                    },
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
                assert_eq!(
                    markers[0].compaction.as_ref().unwrap().duration_ms,
                    if standalone { 5500 } else { 4500 }
                );
            }
            log.close().await.unwrap();
        }
    }
}
