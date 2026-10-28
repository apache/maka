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

use crate::{Content, InvocationView, Message, ProjectionError, State};
use maka_agent_facts::context::ModelPurpose;
use maka_agent_facts::event::{Fact, InvocationInput, RuntimeEvent};

pub(super) struct SummaryStart {
    source_high_water: u64,
    source_digest: String,
    at: u64,
}

impl InvocationView {
    // Summary attempts stay private. Only the durable adoption emits a marker.
    pub(super) fn compact(
        &mut self,
        event: &RuntimeEvent,
        ts: u64,
    ) -> Result<Option<Vec<Message>>, ProjectionError> {
        if matches!(
            event.fact,
            Fact::InvocationOpened {
                input: InvocationInput::ContextCompact { .. },
                ..
            }
        ) {
            if !matches!(self.state, State::Vacant) {
                return Err(ProjectionError::Invalid("duplicate invocation opening"));
            }
            self.state = State::Compact {
                invocation: event.invocation.clone(),
                started_at: ts,
            };
            return Ok(Some(Vec::new()));
        }
        let invocation = match &self.state {
            State::Active { invocation, .. } | State::Compact { invocation, .. } => invocation,
            _ => return Ok(None),
        };
        if *invocation != event.invocation {
            return Err(ProjectionError::Invalid("invocation identity changed"));
        }
        match &event.fact {
            Fact::ModelRequested {
                step_id,
                purpose: ModelPurpose::Summary,
                source_high_water,
                source_digest,
                ..
            } => {
                if self.summary_step.is_some() {
                    return Err(ProjectionError::Invalid("overlapping model steps"));
                }
                if self.summary_start.as_ref().is_none_or(|start| {
                    start.source_high_water != *source_high_water
                        || start.source_digest != *source_digest
                }) {
                    self.summary_start = Some(SummaryStart {
                        source_high_water: *source_high_water,
                        source_digest: source_digest.clone(),
                        at: match &self.state {
                            State::Compact { started_at, .. } => *started_at,
                            _ => ts,
                        },
                    });
                }
                self.summary_step = Some(step_id.clone());
                return Ok(Some(Vec::new()));
            }
            Fact::ContextCheckpointRecorded { .. } => {
                let started = self.summary_start.take().ok_or(ProjectionError::Invalid(
                    "checkpoint without summary request",
                ))?;
                self.summary_step = None;
                return Ok(Some(vec![Message {
                    id: event.id.clone(),
                    turn_id: event.invocation.turn_id.clone(),
                    ts,
                    content: Content::ContextCompacted {
                        duration_ms: ts.saturating_sub(started.at),
                    },
                }]));
            }
            _ => {}
        }
        if let Some(summary) = &self.summary_step {
            match &event.fact {
                Fact::ModelObserved { step_id, .. } if step_id == summary => {
                    return Ok(Some(Vec::new()));
                }
                Fact::ModelCompleted { step_id, .. } | Fact::ModelInterrupted { step_id, .. }
                    if step_id == summary =>
                {
                    self.summary_step = None;
                    return Ok(Some(Vec::new()));
                }
                Fact::InvocationEnded { outcome }
                    if outcome.status() != maka_agent_facts::event::TerminalStatus::Completed =>
                {
                    self.summary_step = None;
                }
                Fact::InvocationEnded { .. } => {
                    return Err(ProjectionError::Invalid("unfinished summary at completion"));
                }
                _ => {}
            }
        }
        if !matches!(self.state, State::Compact { .. }) {
            return Ok(None);
        }
        match event.fact {
            Fact::ModelRequested {
                purpose: ModelPurpose::Main,
                ..
            } => {
                return Err(ProjectionError::Invalid(
                    "main request in compact invocation",
                ));
            }
            Fact::ModelObserved { .. }
            | Fact::ModelCompleted { .. }
            | Fact::ModelInterrupted { .. }
            | Fact::ContextCompactionWaiting
            | Fact::ToolResultArchived { .. } => {}
            Fact::InvocationEnded { .. } => self.state = State::Ended,
            _ => return Err(ProjectionError::Invalid("unexpected compaction fact")),
        }
        Ok(Some(Vec::new()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::context::{CheckpointMode, ContextCheckpoint, TextSummary};
    use maka_agent_facts::event::{Invocation, InvocationOutcome, StoredEvent};
    use maka_agent_facts::model::ModelStep;
    use serde_json::json;
    use std::time::{Duration, UNIX_EPOCH};

    fn request(id: &str) -> Fact {
        serde_json::from_value(json!({
            "kind":"model_requested", "step_id":id, "purpose":"summary", "model_id":"model",
            "item_acceptance":false, "source_scope":{"kind":"session","id":"session"},
            "source_high_water":1, "source_digest":"source", "input_digest":"input", "route_identity":"route"
        })).unwrap()
    }

    fn push(view: &mut InvocationView, sequence: u64, at: u64, fact: Fact) -> Vec<crate::Row> {
        let mut event = RuntimeEvent::new(
            Invocation {
                session_id: "session".into(),
                turn_id: "turn".into(),
                run_id: "run".into(),
                invocation_id: "invocation".into(),
            },
            fact,
        );
        event.id = format!("event-{sequence}");
        event.recorded_at = UNIX_EPOCH + Duration::from_millis(at);
        view.push(&StoredEvent { sequence, event }).unwrap()
    }

    #[test]
    fn marker_appears_only_on_adoption_and_includes_retry_time() {
        for standalone in [false, true] {
            for adopted in [false, true] {
                let mut view = InvocationView::new();
                push(
                    &mut view,
                    1,
                    0,
                    Fact::InvocationOpened {
                        configuration: None,
                        input: if standalone {
                            InvocationInput::ContextCompact {
                                request_fingerprint: "compact".into(),
                            }
                        } else {
                            InvocationInput::Message {
                                source_messages: Vec::new(),
                                content: "x".into(),
                                request_fingerprint: None,
                            }
                        },
                    },
                );
                let output: ModelStep = serde_json::from_value(json!({
                    "parts":[{"kind":"text","text_kind":"text","text":"private summary beyond presentation budget"}],
                    "finish_reason":"stop","usage":{}
                })).unwrap();
                assert!(push(&mut view, 2, 1000, request("summary")).is_empty());
                assert!(
                    push(
                        &mut view,
                        3,
                        2000,
                        Fact::ModelCompleted {
                            step_id: "summary".into(),
                            output: output.clone()
                        }
                    )
                    .is_empty()
                );
                assert!(push(&mut view, 4, 3000, request("retry")).is_empty());
                assert!(
                    push(
                        &mut view,
                        5,
                        4000,
                        Fact::ModelCompleted {
                            step_id: "retry".into(),
                            output
                        }
                    )
                    .is_empty()
                );
                if adopted {
                    let rows = push(
                        &mut view,
                        6,
                        5500,
                        Fact::ContextCheckpointRecorded {
                            checkpoint: ContextCheckpoint {
                                mode: CheckpointMode::Standalone,
                                covered_through: 1,
                                source_digest: "source".into(),
                                previous_checkpoint_id: None,
                                summary_step_id: "retry".into(),
                                summary: TextSummary {
                                    text: "private summary".into(),
                                },
                            },
                        },
                    );
                    assert_eq!(rows.len(), 1);
                    assert_eq!(
                        rows[0].position,
                        maka_agent_facts::history::RowPosition {
                            source_sequence: 6,
                            item_index: 0
                        }
                    );
                    assert_eq!(
                        serde_json::to_value(&rows[0].message).unwrap(),
                        json!({
                            "id":"event-6", "turnId":"turn", "ts":5500,
                            "type":"context_compacted", "durationMs":if standalone {5500} else {4500}
                        })
                    );
                } else {
                    let rows = push(
                        &mut view,
                        6,
                        5500,
                        Fact::InvocationEnded {
                            outcome: InvocationOutcome::Failed {
                                model_failure: None,
                                class: "summary_failed".into(),
                                message: None,
                            },
                        },
                    );
                    assert!(rows.iter().all(|row| !matches!(
                        row.message.content,
                        Content::ContextCompacted { .. }
                    )));
                }
            }
        }
    }
    #[test]
    fn concurrent_main_preserves_summary_timing_and_new_source_restarts_it() {
        for new_source in [false, true] {
            let mut view = InvocationView::new();
            push(
                &mut view,
                1,
                0,
                Fact::InvocationOpened {
                    configuration: None,
                    input: InvocationInput::Message {
                        source_messages: Vec::new(),
                        content: "question".into(),
                        request_fingerprint: None,
                    },
                },
            );
            push(&mut view, 2, 1000, request("summary"));
            let mut main = request("main");
            if let Fact::ModelRequested { purpose, .. } = &mut main {
                *purpose = ModelPurpose::Main;
            }
            push(&mut view, 3, 1500, main);
            let output: ModelStep =
                serde_json::from_value(json!({"parts":[],"finish_reason":"stop","usage":{}}))
                    .unwrap();
            push(
                &mut view,
                4,
                2000,
                Fact::ModelCompleted {
                    step_id: "summary".into(),
                    output: output.clone(),
                },
            );
            let mut retry = request("retry");
            if new_source
                && let Fact::ModelRequested {
                    source_high_water,
                    source_digest,
                    ..
                } = &mut retry
            {
                *source_high_water = 2;
                *source_digest = "new-source".into();
            }
            push(&mut view, 5, 3000, retry);
            push(
                &mut view,
                6,
                4000,
                Fact::ModelCompleted {
                    step_id: "retry".into(),
                    output,
                },
            );
            let rows = push(
                &mut view,
                7,
                5500,
                Fact::ContextCheckpointRecorded {
                    checkpoint: ContextCheckpoint {
                        mode: CheckpointMode::PreTurn,
                        covered_through: if new_source { 2 } else { 1 },
                        source_digest: if new_source { "new-source" } else { "source" }.into(),
                        previous_checkpoint_id: None,
                        summary_step_id: "retry".into(),
                        summary: TextSummary {
                            text: "summary".into(),
                        },
                    },
                },
            );
            assert_eq!(
                rows[0].message.content,
                Content::ContextCompacted {
                    duration_ms: if new_source { 2500 } else { 4500 }
                }
            );
        }
    }
}
