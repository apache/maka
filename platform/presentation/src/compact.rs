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
