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

//! Pure, disposable presentation of committed invocation facts. Model context is
//! a separate projection; retaining interrupted text here never accepts it there.
mod compact;
mod executor;
mod import;
mod message;
pub mod navigation;
pub mod shell;
mod step;
mod tools;
mod user;
use maka_runtime::event::{Fact, Invocation, InvocationInput, StoredEvent};
use maka_runtime::tool_output::ToolOutput;
use message::timestamp;
pub use message::tool_message_id;
pub use message::{
    Content, Hidden, Message, Thinking, ToolContent, ToolMetadata, TurnState, Visible,
};

/// Original Desktop limit for a complete serialized tool-result message.
/// Durable raw payloads have a separate, larger budget.
pub const MAX_TOOL_ROW_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum ProjectionError {
    #[error("invalid presentation fact: {0}")]
    Invalid(&'static str),
    #[error("presentation text exceeds its byte limit")]
    TooLarge,
    #[error("presentation timestamp or sequence exceeds the wire range")]
    OutOfRange,
    #[error("unsupported presentation content: {0}")]
    Unsupported(&'static str),
}

#[derive(Debug, PartialEq)]
pub struct Row {
    /// Separate sparse message space, not subscription sequence or log position.
    pub sequence: u64,
    pub message: Message,
}

enum State {
    Vacant,
    Compact(Invocation),
    Active {
        invocation: Invocation,
        step: Option<Box<step::Step>>,
    },
    Ended,
    Poisoned,
}

pub struct InvocationView {
    executor: Option<executor::Execution>,
    state: State,
    last_sequence: u64,
    max_text_bytes: usize,
    tools: tools::Tools,
    summary_step: Option<String>,
}

impl InvocationView {
    pub fn new(max_text_bytes: usize) -> Result<Self, ProjectionError> {
        if max_text_bytes == 0 {
            return Err(ProjectionError::TooLarge);
        }
        Ok(Self {
            executor: None,
            state: State::Vacant,
            last_sequence: 0,
            max_text_bytes,
            tools: tools::Tools::new(max_text_bytes),
            summary_step: None,
        })
    }

    /// Input is one invocation's strictly ordered, committed facts, with gaps
    /// permitted for other sessions. Never feed the same fact twice.
    pub fn push(&mut self, stored: &StoredEvent) -> Result<Vec<Row>, ProjectionError> {
        self.push_with_tool_output(stored, None)
    }

    /// Successful T2 requires its caller-verified raw payload. Resolution and
    /// identity/digest verification belong to the durable store, not this view.
    pub fn push_with_tool_output(
        &mut self,
        stored: &StoredEvent,
        resolved: Option<&ToolOutput>,
    ) -> Result<Vec<Row>, ProjectionError> {
        let result = self.apply(stored, resolved);
        if result.is_err() {
            self.state = State::Poisoned;
        }
        result
    }

    fn apply(
        &mut self,
        stored: &StoredEvent,
        resolved: Option<&ToolOutput>,
    ) -> Result<Vec<Row>, ProjectionError> {
        let succeeds = matches!(
            stored.event.fact,
            Fact::ToolSettled {
                outcome: maka_runtime::event::ToolOutcome::Succeeded { .. },
                ..
            }
        );
        if succeeds != resolved.is_some() {
            return Err(ProjectionError::Invalid(
                "tool payload does not match fact kind",
            ));
        }
        if stored.sequence <= self.last_sequence {
            return Err(ProjectionError::Invalid("non-increasing log sequence"));
        }
        let event = &stored.event;
        let ts = timestamp(event)?;
        if self.compact(event)? {
            self.last_sequence = stored.sequence;
            return Ok(Vec::new());
        }
        let base = watermark(stored.sequence)? - 255;
        let mut messages = Vec::new();
        match &event.fact {
            Fact::MessageImported { record, .. } => {
                if !matches!(self.state, State::Vacant) {
                    return Err(ProjectionError::Invalid("import inside execution"));
                }
                messages.extend(import::project(event, record, ts, self.max_text_bytes)?);
                self.state = State::Ended;
            }
            Fact::InvocationOpened { input, .. } => {
                if !matches!(self.state, State::Vacant) {
                    return Err(ProjectionError::Invalid("duplicate invocation opening"));
                }
                if let InvocationInput::Message {
                    content,
                    source_messages,
                    ..
                } = input
                {
                    messages.push(user::project(
                        if source_messages.len() == 1 {
                            &source_messages[0].message.message_id
                        } else {
                            &event.id
                        },
                        &event.invocation.turn_id,
                        ts,
                        content,
                        self.max_text_bytes,
                    )?);
                } else if input.inherited_claim().is_none() {
                    return Err(ProjectionError::Unsupported("Code invocation"));
                }
                messages.push(Message {
                    id: format!("{}:state", event.id),
                    turn_id: event.invocation.turn_id.clone(),
                    ts,
                    content: Content::TurnState {
                        state: TurnState::Running,
                    },
                });
                self.state = State::Active {
                    invocation: event.invocation.clone(),
                    step: None,
                };
            }
            fact => {
                let State::Active { invocation, step } = &mut self.state else {
                    return Err(ProjectionError::Invalid("fact outside active invocation"));
                };
                if *invocation != event.invocation {
                    return Err(ProjectionError::Invalid("invocation identity changed"));
                }
                match fact {
                    Fact::ExecutorStarted { binding, .. } => {
                        if step.is_some() || self.executor.is_some() {
                            return Err(ProjectionError::Invalid("overlapping execution backends"));
                        }
                        self.executor = Some(executor::Execution::new(
                            event,
                            ts,
                            binding,
                            self.max_text_bytes,
                        ));
                    }
                    Fact::ExecutorObserved { output } => {
                        messages.extend(
                            self.executor
                                .as_mut()
                                .ok_or(ProjectionError::Invalid("executor output without start"))?
                                .observe(event, ts, output)?,
                        );
                    }
                    Fact::ExecutorCompleted { text } => {
                        messages.extend(
                            self.executor
                                .as_mut()
                                .ok_or(ProjectionError::Invalid(
                                    "executor completion without start",
                                ))?
                                .complete(event, ts, text)?,
                        );
                    }
                    Fact::MessageSteered { message, .. } => {
                        if step.is_some() {
                            return Err(ProjectionError::Invalid(
                                "steering inside a model request",
                            ));
                        }
                        messages.push(user::project(
                            &message.message_id,
                            &event.invocation.turn_id,
                            ts,
                            &message.content,
                            self.max_text_bytes,
                        )?);
                    }
                    Fact::ModelRequested {
                        step_id, model_id, ..
                    } => {
                        if step.is_some() {
                            return Err(ProjectionError::Invalid("overlapping model steps"));
                        }
                        *step = Some(Box::new(step::Step::new(
                            step_id.clone(),
                            model_id.clone(),
                            self.max_text_bytes,
                        )));
                    }
                    Fact::ModelObserved {
                        step_id,
                        event: observation,
                    } => {
                        let step = step
                            .as_mut()
                            .ok_or(ProjectionError::Invalid("observation without request"))?;
                        step.check_id(step_id)?;
                        step.observe(event, ts, observation)?;
                    }
                    Fact::ModelCompleted { step_id, output } => {
                        let completed = step
                            .take()
                            .ok_or(ProjectionError::Invalid("completion without request"))?;
                        completed.check_id(step_id)?;
                        let text = completed.complete(output)?;
                        messages.extend(self.tools.accept(event, ts, step_id, output, text)?);
                        if let (Some(input), Some(output_tokens)) =
                            (output.usage.input_tokens, output.usage.output_tokens)
                        {
                            messages.push(Message {
                                id: event.id.clone(),
                                turn_id: invocation.turn_id.clone(),
                                ts,
                                content: Content::TokenUsage {
                                    input,
                                    output: output_tokens,
                                    cache_read: output.usage.cache_read_tokens,
                                    cache_creation: output.usage.cache_write_tokens,
                                    reasoning: output.usage.reasoning_tokens,
                                },
                            });
                        }
                    }
                    Fact::ModelInterrupted { step_id, status } => {
                        let interrupted = step
                            .take()
                            .ok_or(ProjectionError::Invalid("interruption without request"))?;
                        interrupted.check_id(step_id)?;
                        messages.extend(
                            interrupted.partial(
                                *status != maka_runtime::event::ModelInterruption::Cancelled,
                            ),
                        );
                    }
                    Fact::InvocationEnded { outcome } => {
                        if let Some(executor) = self.executor.take() {
                            messages.extend(executor.finish(event, ts));
                        }
                        if let Some(unfinished) = step.take() {
                            if matches!(
                                outcome,
                                maka_runtime::event::InvocationOutcome::Completed
                                    | maka_runtime::event::InvocationOutcome::HandoffPaused { .. }
                            ) {
                                return Err(ProjectionError::Invalid(
                                    "completion with unfinished model",
                                ));
                            }
                            // Failure seals observation evidence, not accepted
                            // model history. Never invent a completed response.
                            messages.extend(unfinished.partial(matches!(
                                outcome,
                                maka_runtime::event::InvocationOutcome::Failed { .. }
                            )));
                        }
                        if let Some(state) = TurnState::from_outcome(outcome, ts) {
                            messages.push(Message {
                                id: event.id.clone(),
                                turn_id: invocation.turn_id.clone(),
                                ts,
                                content: Content::TurnState { state },
                            });
                        }
                        self.state = State::Ended;
                    }
                    Fact::ToolDispatched { .. }
                    | Fact::ToolSettled { .. }
                    | Fact::ToolRejected { .. } => {
                        messages.extend(self.tools.boundary(event, ts, resolved)?);
                    }
                    Fact::InvocationOpened { .. } | Fact::MessageImported { .. } => unreachable!(),
                    Fact::ContextCheckpointRecorded { .. }
                    | Fact::ToolResultArchived { .. }
                    | Fact::ToolNotified { .. } => {}
                }
            }
        }
        self.last_sequence = stored.sequence;
        if messages.len() > 256 {
            return Err(ProjectionError::OutOfRange);
        }
        Ok(messages
            .into_iter()
            .enumerate()
            .map(|(index, message)| Row {
                sequence: base + index as u64,
                message,
            })
            .collect())
    }

    /// Frozen caller-owned copies of observed text, including closed parts whose
    /// model completion has not committed. These are overlay, not durable rows.
    pub fn overlay(&self) -> Vec<Message> {
        if let Some(executor) = &self.executor {
            return executor.overlay();
        }
        match &self.state {
            State::Active {
                step: Some(step), ..
            } => step.partial(false),
            _ => Vec::new(),
        }
    }
}

pub fn watermark(sequence: u64) -> Result<u64, ProjectionError> {
    sequence
        .checked_mul(256)
        .and_then(|base| base.checked_add(255))
        .filter(|value| *value <= 9_007_199_254_740_991)
        .ok_or(ProjectionError::OutOfRange)
}
