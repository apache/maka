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

use crate::{Error, OperatorId, WorkId};
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::StoredEvent;
use maka_agent_facts::event::ToolOutcome;
use maka_agent_facts::model::ModelPart;
use maka_agent_facts::model::TextKind;
use maka_agent_facts::model::recorded::{CompletionPart, ModelObservation};
use maka_agent_facts::tool_output::DurableToolProjection;
use maka_agent_facts::tool_output::ProjectionPart;
use maka_agent_ports::execution::Observation;
use maka_agent_ports::execution::Progress;
use maka_agent_ports::execution::{Commands, EventPage, SessionOperation};
use serde::Serialize;
use std::collections::VecDeque;

const RECENT_RECORDS: usize = 32;
const OUTPUT_BYTES: usize = 16 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Facet {
    Text,
    ToolResult,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub record_id: String,
    pub sequence: u64,
    pub work_id: WorkId,
    pub operator_id: OperatorId,
    pub invocation: Invocation,
    pub facets: Vec<Facet>,
    pub text: String,
    pub truncated: bool,
    pub terminal: bool,
}

/// A bounded read model, never an execution or scheduling authority.
pub struct Execution {
    pub workspace_result: WorkspaceResult,
    pub work_id: WorkId,
    pub operator_id: OperatorId,
    pub observation: Observation,
    pub after: u64,
    pub recent: VecDeque<Record>,
    pub record_count: u64,
    pub terminal: Option<Record>,
    last_answer: String,
    answer_truncated: bool,
}
impl Execution {
    pub fn new(work_id: WorkId, operator_id: OperatorId, observation: Observation) -> Self {
        Self {
            workspace_result: WorkspaceResult::Pending,
            work_id,
            operator_id,
            observation,
            after: 0,
            recent: VecDeque::new(),
            record_count: 0,
            terminal: None,
            last_answer: String::new(),
            answer_truncated: false,
        }
    }

    pub async fn apply_page(
        &mut self,
        page: EventPage,
        commands: &dyn Commands,
        operation: &SessionOperation,
    ) -> Result<(), Error> {
        let through = self.observation.through_sequence;
        let next = page.next_after.unwrap_or(through);
        if page.through_sequence != through || next <= self.after || next > through {
            return Err(Error::Persistence(
                "execution event cursor or fence changed".into(),
            ));
        }
        let mut previous = self.after;
        for row in &page.events {
            if row.sequence <= previous
                || row.sequence > next
                || row.event.invocation.session_id != self.observation.receipt.invocation.session_id
                || row.event.invocation.turn_id != self.observation.receipt.invocation.turn_id
            {
                return Err(Error::Persistence(
                    "event is outside the accepted execution page".into(),
                ));
            }
            previous = row.sequence;
        }
        for row in page.events {
            let sequence = row.sequence;
            self.observe(row, commands, operation).await?;
            // A later exact read can fail; retries must not duplicate prior records.
            self.after = sequence;
        }
        self.after = next;
        Ok(())
    }

    /// A single event projection is also used by exact historical lookups.
    pub async fn observe(
        &mut self,
        row: StoredEvent,
        commands: &dyn Commands,
        operation: &SessionOperation,
    ) -> Result<Option<Record>, Error> {
        if row.sequence <= self.after
            || row.sequence > self.observation.through_sequence
            || row.event.invocation.session_id != self.observation.receipt.invocation.session_id
            || row.event.invocation.turn_id != self.observation.receipt.invocation.turn_id
        {
            return Err(Error::Invalid(
                "event is outside the accepted execution snapshot".into(),
            ));
        }
        let (facets, text, truncated, terminal) = match &row.event.fact {
            Fact::ExecutorCompleted { text: value } => {
                let mut text = String::new();
                let mut truncated = false;
                append(&mut text, value, &mut truncated);
                self.last_answer = text.clone();
                self.answer_truncated = truncated;
                (vec![Facet::Text], text, truncated, false)
            }
            Fact::ModelCompleted { step_id, output } => {
                let mut text = String::new();
                let mut truncated = false;
                for part in &output.parts {
                    match part {
                        CompletionPart::Own(record) => {
                            append_part(&mut text, record.part.as_ref(), &mut truncated)
                        }
                        CompletionPart::Ref(reference) => {
                            let original = commands
                                .event(
                                    operation.clone(),
                                    reference.event_id.clone(),
                                    self.observation.through_sequence,
                                )
                                .await?
                                .ok_or_else(|| {
                                    Error::Persistence("completed model part is unavailable".into())
                                })?;
                            let Fact::ModelObserved {
                                step_id: original_step,
                                event: ModelObservation::Part(record),
                            } = &original.event.fact
                            else {
                                return Err(Error::Persistence(
                                    "completed model reference is not an original part".into(),
                                ));
                            };
                            if original.event.id != reference.event_id
                                || original.event.invocation != row.event.invocation
                                || original_step != step_id
                                || record.ordinal != reference.ordinal
                                || original.sequence >= row.sequence
                            {
                                return Err(Error::Persistence(
                                    "completed model reference changed identity".into(),
                                ));
                            }
                            append_part(&mut text, record.part.as_ref(), &mut truncated);
                        }
                    }
                    if truncated {
                        break;
                    }
                }
                if text.is_empty() {
                    return Ok(None);
                }
                self.last_answer = text.clone();
                self.answer_truncated = truncated;
                (vec![Facet::Text], text, truncated, false)
            }
            Fact::ToolSettled { outcome, .. } => {
                let mut text = String::new();
                let mut truncated = false;
                match outcome {
                    ToolOutcome::Failed { message } | ToolOutcome::Unknown { message, .. } => {
                        append(&mut text, message, &mut truncated)
                    }
                    ToolOutcome::Succeeded {
                        model_projection, ..
                    } => match model_projection {
                        DurableToolProjection::Text { text: value } => {
                            append(&mut text, value, &mut truncated)
                        }
                        DurableToolProjection::Json { value } => {
                            append(&mut text, &value.to_string(), &mut truncated)
                        }
                        DurableToolProjection::Content { parts } => {
                            for part in parts {
                                if let ProjectionPart::Text { text: value } = part {
                                    append(&mut text, value, &mut truncated);
                                }
                            }
                        }
                        DurableToolProjection::Failure => {
                            append(&mut text, "Tool output unavailable", &mut truncated)
                        }
                    },
                }
                (vec![Facet::ToolResult], text, truncated, false)
            }
            Fact::InvocationEnded { outcome } => {
                let facet = match outcome {
                    InvocationOutcome::HandoffPaused { .. } => return Ok(None),
                    InvocationOutcome::Completed
                    | InvocationOutcome::ContextCompactFinished { .. } => Facet::Completed,
                    InvocationOutcome::Failed { .. } => Facet::Failed,
                    InvocationOutcome::Cancelled { .. } => Facet::Cancelled,
                };
                let mut text = self.last_answer.clone();
                let mut truncated = self.answer_truncated;
                if let InvocationOutcome::Failed { class, message, .. } = outcome {
                    append(
                        &mut text,
                        &format!(
                            "\nExecution failed ({class}): {}",
                            message.as_deref().unwrap_or("no detail")
                        ),
                        &mut truncated,
                    );
                } else if let InvocationOutcome::Cancelled { source } = outcome {
                    append(
                        &mut text,
                        &format!("\nExecution cancelled: {source}"),
                        &mut truncated,
                    );
                }
                (vec![facet], text, truncated, true)
            }
            _ => return Ok(None),
        };
        let record = Record {
            record_id: row.event.id,
            sequence: row.sequence,
            work_id: self.work_id.clone(),
            operator_id: self.operator_id.clone(),
            invocation: row.event.invocation,
            facets,
            text,
            truncated,
            terminal,
        };
        self.record_count += 1;
        if terminal {
            self.terminal = Some(record.clone());
        }
        let mut preview = record.clone();
        if preview.text.len() > 2048 {
            preview
                .text
                .truncate(preview.text.floor_char_boundary(2048));
            preview.truncated = true;
        }
        if self.recent.len() == RECENT_RECORDS {
            self.recent.pop_front();
        }
        self.recent.push_back(preview);
        Ok(Some(record))
    }

    pub fn settled(&self) -> bool {
        matches!(self.observation.progress, Progress::Ended { .. })
            && self.after == self.observation.through_sequence
            && matches!(self.workspace_result, WorkspaceResult::Ready(_))
    }
}

#[derive(Serialize)]
pub enum WorkspaceResult {
    Pending,
    Ready(Option<maka_agent_ports::execution::WorkspacePatch>),
}

fn append_part(target: &mut String, part: &ModelPart, truncated: &mut bool) {
    if let ModelPart::Text {
        text_kind: TextKind::Text,
        text,
        ..
    } = part
    {
        for chunk in text.chunks() {
            append(target, chunk, truncated);
            if *truncated {
                break;
            }
        }
    }
}

fn append(target: &mut String, text: &str, truncated: &mut bool) {
    let remaining = OUTPUT_BYTES.saturating_sub(target.len());
    let end = text.floor_char_boundary(remaining.min(text.len()));
    target.push_str(&text[..end]);
    *truncated |= end != text.len();
}
