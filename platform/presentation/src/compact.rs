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

use crate::{Content, Message, ProjectionError, RunView, State};
use maka_agent_facts::context::ModelPurpose;
use maka_agent_facts::event::{Fact, RunInput, RuntimeEvent};

pub(super) struct SummaryStart {
    source_high_water: u64,
    source_digest: String,
    at: u64,
}

impl RunView {
    // Summary attempts stay private. Only the durable adoption emits a marker.
    pub(super) fn compact(
        &mut self,
        event: &RuntimeEvent,
        ts: u64,
    ) -> Result<Option<Vec<Message>>, ProjectionError> {
        if matches!(
            event.fact,
            Fact::RunOpened {
                input: RunInput::ContextCompact { .. },
                ..
            }
        ) {
            if !matches!(self.state, State::Vacant) {
                return Err(ProjectionError::Invalid("duplicate execution opening"));
            }
            self.state = State::Compact {
                execution: event.execution.clone(),
                started_at: ts,
            };
            return Ok(Some(Vec::new()));
        }
        let execution = match &self.state {
            State::Active { execution, .. } | State::Compact { execution, .. } => execution,
            _ => return Ok(None),
        };
        if execution.run_id != event.execution.run_id
            || execution.session_id != event.execution.session_id
        {
            return Err(ProjectionError::Invalid("execution identity changed"));
        }
        match &event.fact {
            Fact::ModelRequested {
                step_id,
                attempt_id,
                purpose: ModelPurpose::Summary,
                source_high_water,
                source_digest,
                ..
            } => {
                if self.summary_attempt.is_some() {
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
                self.summary_attempt = Some(crate::ModelIdentity {
                    step_id: *step_id,
                    attempt_id: *attempt_id,
                });
                return Ok(Some(Vec::new()));
            }
            Fact::ContextCheckpointRecorded { .. } => {
                let started = self.summary_start.take().ok_or(ProjectionError::Invalid(
                    "checkpoint without summary request",
                ))?;
                self.summary_attempt = None;
                return Ok(Some(vec![Message {
                    id: event.id.clone(),
                    run_id: event.execution.run_id,
                    model: None,
                    turn_id: event.execution.turn_id.clone(),
                    ts,
                    content: Content::ContextCompacted {
                        duration_ms: ts.saturating_sub(started.at),
                    },
                }]));
            }
            _ => {}
        }
        if let Some(summary) = &self.summary_attempt {
            let is_tool = |part: &maka_agent_facts::model::ModelPart| {
                matches!(
                    part,
                    maka_agent_facts::model::ModelPart::ToolCall { .. }
                        | maka_agent_facts::model::ModelPart::ToolResult { .. }
                )
            };
            let contains_tools = match &event.fact {
                Fact::ModelObserved{attempt_id,event:maka_agent_facts::model::recorded::ModelObservation::Part(record),..} if *attempt_id==summary.attempt_id => is_tool(&record.part),
                Fact::ModelCompleted{attempt_id,output,..} if *attempt_id==summary.attempt_id => output.parts.iter().any(|part|matches!(part,maka_agent_facts::model::recorded::CompletionPart::Own(record) if is_tool(&record.part))),
                Fact::ModelInterrupted{attempt_id,partial:Some(partial),..} if *attempt_id==summary.attempt_id => partial.parts.iter().any(|part|matches!(part,maka_agent_facts::model::recorded::CompletionPart::Own(record) if is_tool(&record.part))),
                _ => false,
            };
            if contains_tools {
                return Err(ProjectionError::Invalid(
                    "summary attempt contains a tool obligation",
                ));
            }
            match &event.fact {
                Fact::ModelObserved {
                    step_id,
                    attempt_id,
                    ..
                } if *step_id == summary.step_id && *attempt_id == summary.attempt_id => {
                    return Ok(Some(Vec::new()));
                }
                Fact::ModelCompleted {
                    step_id,
                    attempt_id,
                    ..
                }
                | Fact::ModelInterrupted {
                    step_id,
                    attempt_id,
                    ..
                } if *step_id == summary.step_id && *attempt_id == summary.attempt_id => {
                    self.summary_attempt = None;
                    return Ok(Some(Vec::new()));
                }
                Fact::RunEnded { outcome }
                    if outcome.status() != maka_agent_facts::event::TerminalStatus::Completed =>
                {
                    self.summary_attempt = None;
                }
                Fact::RunEnded { .. } => {
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
                    "main request in compact execution",
                ));
            }
            Fact::ModelObserved { .. }
            | Fact::ModelCompleted { .. }
            | Fact::ModelInterrupted { .. } => {
                return Err(ProjectionError::Invalid(
                    "summary event without matching attempt",
                ));
            }
            Fact::ContextCompactionWaiting | Fact::ToolResultArchived { .. } => {}
            Fact::RunEnded { .. } => {
                self.state = State::Ended {
                    execution: event.execution.clone(),
                }
            }
            _ => return Err(ProjectionError::Invalid("unexpected compaction fact")),
        }
        Ok(Some(Vec::new()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::context::{CheckpointMode, ContextCheckpoint};
    use maka_agent_facts::durable::{ExecutionIdentity, ModelAttemptId, StepId};
    use maka_agent_facts::event::{LogScope, RunOutcome, SourceCapture, StoredEvent};
    use maka_agent_facts::model::recorded::ModelCompletion;
    use serde_json::json;
    use std::time::{Duration, UNIX_EPOCH};

    fn request(step_id: StepId, attempt_id: ModelAttemptId) -> Fact {
        Fact::ModelRequested {
            item_acceptance: false,
            step_id,
            attempt_id,
            model_id: "model".into(),
            source_scope: LogScope::Session {
                id: "session".into(),
            },
            source_high_water: 1,
            source_capture: SourceCapture {
                publication_watermark: 1,
                prior_unknown: false,
            },
            source_digest: "source".into(),
            input_digest: "input".into(),
            route_identity: "route".into(),
            checkpoint_event_id: None,
            purpose: ModelPurpose::Summary,
            context: None,
            context_breakdown: None,
            effective_source_digest: None,
        }
    }

    fn push(view: &mut RunView, sequence: u64, at: u64, fact: Fact) -> Vec<crate::Row> {
        let mut event = RuntimeEvent::new(
            ExecutionIdentity {
                session_id: "session".into(),
                turn_id: "turn".into(),
                run_id: serde_json::from_value(json!("00000000-0000-4000-8000-000000000001"))
                    .unwrap(),
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
                let mut view = RunView::new();
                let summary = StepId::new();
                let summary_attempt = ModelAttemptId::new();
                let retry = StepId::new();
                let retry_attempt = ModelAttemptId::new();
                push(
                    &mut view,
                    1,
                    0,
                    Fact::RunOpened {
                        configuration: None,
                        input: if standalone {
                            RunInput::ContextCompact {
                                request_fingerprint: "compact".into(),
                            }
                        } else {
                            RunInput::Message {
                                source_messages: Vec::new(),
                                content: "x".into(),
                                request_fingerprint: None,
                            }
                        },
                    },
                );
                let output: ModelCompletion = serde_json::from_value(json!({
                    "parts":[],
                    "finish_reason":"stop","usage":{}
                }))
                .unwrap();
                assert!(push(&mut view, 2, 1000, request(summary, summary_attempt)).is_empty());
                assert!(
                    push(
                        &mut view,
                        3,
                        2000,
                        Fact::ModelCompleted {
                            step_id: summary,
                            attempt_id: summary_attempt,
                            output: output.clone()
                        }
                    )
                    .is_empty()
                );
                assert!(push(&mut view, 4, 3000, request(retry, retry_attempt)).is_empty());
                assert!(
                    push(
                        &mut view,
                        5,
                        4000,
                        Fact::ModelCompleted {
                            step_id: retry,
                            attempt_id: retry_attempt,
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
                                summary_step_id: retry,
                                summary: maka_agent_facts::context::CheckpointContent::Text(
                                    "private summary".into(),
                                ),
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
                            "id":"event-6", "runId":"00000000-0000-4000-8000-000000000001", "turnId":"turn", "ts":5500,
                            "type":"context_compacted", "durationMs":if standalone {5500} else {4500}
                        })
                    );
                } else {
                    let rows = push(
                        &mut view,
                        6,
                        5500,
                        Fact::RunEnded {
                            outcome: RunOutcome::Failed {
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
            let mut view = RunView::new();
            let summary = StepId::new();
            let summary_attempt = ModelAttemptId::new();
            let retry_step = StepId::new();
            let retry_attempt = ModelAttemptId::new();
            push(
                &mut view,
                1,
                0,
                Fact::RunOpened {
                    configuration: None,
                    input: RunInput::Message {
                        source_messages: Vec::new(),
                        content: "question".into(),
                        request_fingerprint: None,
                    },
                },
            );
            push(&mut view, 2, 1000, request(summary, summary_attempt));
            let mut main = request(StepId::new(), ModelAttemptId::new());
            if let Fact::ModelRequested { purpose, .. } = &mut main {
                *purpose = ModelPurpose::Main;
            }
            push(&mut view, 3, 1500, main);
            let output: ModelCompletion =
                serde_json::from_value(json!({"parts":[],"finish_reason":"stop","usage":{}}))
                    .unwrap();
            push(
                &mut view,
                4,
                2000,
                Fact::ModelCompleted {
                    step_id: summary,
                    attempt_id: summary_attempt,
                    output: output.clone(),
                },
            );
            let mut retry = request(retry_step, retry_attempt);
            if new_source
                && let Fact::ModelRequested {
                    source_high_water,
                    source_capture,
                    source_digest,
                    ..
                } = &mut retry
            {
                *source_high_water = 2;
                source_capture.publication_watermark = 2;
                *source_digest = "new-source".into();
            }
            push(&mut view, 5, 3000, retry);
            push(
                &mut view,
                6,
                4000,
                Fact::ModelCompleted {
                    step_id: retry_step,
                    attempt_id: retry_attempt,
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
                        summary_step_id: retry_step,
                        summary: maka_agent_facts::context::CheckpointContent::Text(
                            "summary".into(),
                        ),
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
