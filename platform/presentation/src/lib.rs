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
pub use tools::project_tool_boundary;
mod user;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::InvocationInput;
use maka_agent_facts::event::StoredEvent;
use maka_agent_facts::history::RowPosition;
use maka_agent_facts::tool_output::ToolOutput;
use message::timestamp;
pub use message::tool_message_id;
pub use message::{
    Content, Hidden, Message, Thinking, ToolContent, ToolMetadata, TurnState, Visible,
};

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
    /// Original emitting fact and its full row ordinal, before UI filtering.
    pub position: RowPosition,
    pub message: Message,
}

enum State {
    Vacant,
    Compact {
        invocation: Invocation,
        started_at: u64,
    },
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
    tools: tools::Tools,
    summary_step: Option<String>,
    summary_start: Option<compact::SummaryStart>,
}

impl Default for InvocationView {
    fn default() -> Self {
        Self {
            executor: None,
            state: State::Vacant,
            last_sequence: 0,
            tools: tools::Tools::new(),
            summary_step: None,
            summary_start: None,
        }
    }
}

impl InvocationView {
    pub fn new() -> Self {
        Self::default()
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
                outcome: maka_agent_facts::event::ToolOutcome::Succeeded { .. },
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
        RowPosition {
            source_sequence: stored.sequence,
            item_index: 0,
        }
        .validate()
        .map_err(|_| ProjectionError::OutOfRange)?;
        if let Some(messages) = self.compact(event, ts)? {
            self.last_sequence = stored.sequence;
            return rows(stored.sequence, messages);
        }
        let mut messages = Vec::new();
        match &event.fact {
            Fact::MessageImported { record, .. } => {
                if !matches!(self.state, State::Vacant) {
                    return Err(ProjectionError::Invalid("import inside execution"));
                }
                messages.extend(import::project(event, record, ts)?);
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
                    if source_messages
                        .iter()
                        .any(|source| source.message.origin.is_some())
                    {
                        for source in source_messages {
                            messages.push(user::project(
                                &source.message.message_id,
                                &event.invocation.turn_id,
                                ts,
                                &source.message.content,
                                source.message.origin.as_ref(),
                            )?);
                        }
                    } else {
                        messages.push(user::project(
                            if source_messages.len() == 1 {
                                &source_messages[0].message.message_id
                            } else {
                                &event.id
                            },
                            &event.invocation.turn_id,
                            ts,
                            content,
                            None,
                        )?);
                    }
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
                        self.executor = Some(executor::Execution::new(event, ts, binding));
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
                            message.origin.as_ref(),
                        )?);
                    }
                    Fact::ModelRequested {
                        step_id,
                        model_id,
                        item_acceptance,
                        ..
                    } => {
                        if step.is_some() {
                            return Err(ProjectionError::Invalid("overlapping model steps"));
                        }
                        *step = Some(Box::new(step::Step::new(
                            step_id.clone(),
                            model_id.clone(),
                            *item_acceptance,
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
                        if step.item_acceptance {
                            match observation {
                                maka_agent_facts::model::ModelEvent::PartFinished {
                                    id, ..
                                } => {
                                    messages.extend(step.deliver_text(id));
                                }
                                maka_agent_facts::model::ModelEvent::Source(_)
                                | maka_agent_facts::model::ModelEvent::ToolCall(_)
                                | maka_agent_facts::model::ModelEvent::ProviderToolResult {
                                    ..
                                } => {
                                    if let Some((index, part)) = step.accepted_tool() {
                                        messages.extend(self.tools.accept_item(
                                            event,
                                            ts,
                                            step_id,
                                            index,
                                            part,
                                            step.anchor(),
                                            step.model(),
                                        )?);
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    Fact::ModelCompleted { step_id, output } => {
                        let completed = step
                            .take()
                            .ok_or(ProjectionError::Invalid("completion without request"))?;
                        completed.check_id(step_id)?;
                        let streaming = completed.item_acceptance;
                        let text = completed.complete(output)?;
                        if streaming {
                            messages.extend(text);
                        } else {
                            messages.extend(self.tools.accept(event, ts, step_id, output, text)?);
                        }
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
                    Fact::ModelInterrupted {
                        step_id,
                        status,
                        diagnostic,
                        ..
                    } => {
                        let interrupted = step
                            .take()
                            .ok_or(ProjectionError::Invalid("interruption without request"))?;
                        interrupted.check_id(step_id)?;
                        messages.extend(interrupted.partial(
                            *status != maka_agent_facts::event::ModelInterruption::Cancelled,
                        ));
                        if let Some(message) = diagnostic
                            && *status != maka_agent_facts::event::ModelInterruption::Cancelled
                        {
                            messages.push(Message {
                                id: event.id.clone(),
                                turn_id: invocation.turn_id.clone(),
                                ts,
                                content: Content::ModelInterruption {
                                    message: message.clone(),
                                },
                            });
                        }
                    }
                    Fact::InvocationEnded { outcome } => {
                        if let Some(executor) = self.executor.take() {
                            messages.extend(executor.finish(event, ts));
                        }
                        if let Some(unfinished) = step.take() {
                            if matches!(
                                outcome,
                                maka_agent_facts::event::InvocationOutcome::Completed
                                    | maka_agent_facts::event::InvocationOutcome::HandoffPaused { .. }
                            ) {
                                return Err(ProjectionError::Invalid(
                                    "completion with unfinished model",
                                ));
                            }
                            // Failure seals observation evidence, not accepted
                            // model history. Never invent a completed response.
                            messages.extend(unfinished.partial(matches!(
                                outcome,
                                maka_agent_facts::event::InvocationOutcome::Failed { .. }
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
                    | Fact::ContextCompactionWaiting
                    | Fact::ToolResultArchived { .. }
                    | Fact::ToolOperationObserved { .. }
                    | Fact::ToolNotified { .. } => {}
                }
            }
        }
        self.last_sequence = stored.sequence;
        rows(stored.sequence, messages)
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

fn rows(source_sequence: u64, messages: Vec<Message>) -> Result<Vec<Row>, ProjectionError> {
    messages
        .into_iter()
        .enumerate()
        .map(|(index, message)| {
            let position = RowPosition {
                source_sequence,
                item_index: u64::try_from(index).map_err(|_| ProjectionError::OutOfRange)?,
            };
            position
                .validate()
                .map_err(|_| ProjectionError::OutOfRange)?;
            Ok(Row { position, message })
        })
        .collect()
}
