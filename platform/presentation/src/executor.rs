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

use crate::{Content, Message, ProjectionError, Thinking, ToolContent, ToolMetadata, Visible};
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::executor::Binding;
use maka_agent_facts::executor::Output;
use std::collections::{BTreeMap, BTreeSet};

pub(super) struct Execution {
    model_id: String,
    messages: Vec<(String, Message)>,
    started: BTreeSet<String>,
    pending: BTreeMap<String, String>,
    seen: BTreeSet<String>,
    completed: bool,
}
impl Execution {
    pub fn new(_event: &RuntimeEvent, _ts: u64, binding: &Binding) -> Self {
        Self {
            model_id: binding.executor_id.as_str().into(),
            messages: Vec::new(),
            started: BTreeSet::new(),
            pending: BTreeMap::new(),
            seen: BTreeSet::new(),
            completed: false,
        }
    }
    pub fn observe(
        &mut self,
        event: &RuntimeEvent,
        ts: u64,
        output: &Output,
    ) -> Result<Vec<Message>, ProjectionError> {
        if self.completed {
            return Err(ProjectionError::Invalid("output after executor completion"));
        }
        let row = match output {
            Output::MessageStart { message_id } => {
                if !self.started.insert(message_id.clone()) {
                    return Err(ProjectionError::Invalid("duplicate executor message start"));
                }
                self.messages.push((
                    message_id.clone(),
                    Message {
                        id: crate::executor_message_id(event.execution.run_id, message_id),
                        run_id: event.execution.run_id,
                        model: None,
                        turn_id: event.execution.turn_id.clone(),
                        ts,
                        content: Content::Assistant {
                            imported: false,
                            text: String::new(),
                            model_id: self.model_id.clone(),
                            interrupted: false,
                            thinking: None,
                            provider_options: None,
                        },
                    },
                ));
                return Ok(vec![]);
            }
            Output::OutputDelta {
                message_id,
                text: delta,
            }
            | Output::ThinkingDelta {
                message_id,
                text: delta,
            } => {
                let (_, message) = self
                    .messages
                    .iter_mut()
                    .find(|(id, _)| id == message_id)
                    .ok_or(ProjectionError::Invalid("delta outside executor message"))?;
                let Content::Assistant { text, thinking, .. } = &mut message.content else {
                    unreachable!()
                };
                if matches!(output, Output::OutputDelta { .. }) {
                    text.push_str(delta);
                } else if !delta.is_empty() {
                    thinking
                        .get_or_insert_with(|| Thinking {
                            text: String::new(),
                            provider_options: None,
                        })
                        .text
                        .push_str(delta);
                }
                return Ok(vec![]);
            }
            Output::MessageEnd { message_id } => {
                let index = self
                    .messages
                    .iter()
                    .position(|(id, _)| id == message_id)
                    .ok_or(ProjectionError::Invalid("end outside executor message"))?;
                let (_, message) = self.messages.remove(index);
                return Ok(if has_content(&message) {
                    vec![message]
                } else {
                    vec![]
                });
            }
            Output::ToolStart {
                tool_call_id,
                name,
                input,
            } => {
                if !self.seen.insert(tool_call_id.clone()) {
                    return Err(ProjectionError::Invalid(
                        "executor reused a tool activity ID",
                    ));
                }
                let id = crate::tool_message_id(event.execution.run_id, tool_call_id);
                self.pending.insert(tool_call_id.clone(), id.clone());
                Message {
                    id,
                    run_id: event.execution.run_id,
                    model: None,
                    turn_id: event.execution.turn_id.clone(),
                    ts,
                    content: Content::ToolCall {
                        tool_name: name.clone(),
                        args: input.clone(),
                        anchor_message_id: None,
                        provider_options: None,
                        provider_executed: Some(true),
                        metadata: metadata(),
                    },
                }
            }
            Output::ToolProgress { tool_call_id, .. } => {
                if !self.pending.contains_key(tool_call_id) {
                    return Err(ProjectionError::Invalid(
                        "progress for unknown executor tool",
                    ));
                }
                return Ok(vec![]);
            }
            Output::ToolResult {
                tool_call_id,
                text,
                is_error,
                ..
            } => {
                let id = self
                    .pending
                    .remove(tool_call_id)
                    .ok_or(ProjectionError::Invalid("result for unknown executor tool"))?;
                result(event, ts, event.id.clone(), id, text.clone(), *is_error)
            }
            Output::TurnUsage { .. } => return Ok(vec![]),
        };
        Ok(vec![row])
    }
    pub fn complete(
        &mut self,
        event: &RuntimeEvent,
        ts: u64,
        _message_id: Option<&str>,
    ) -> Result<Vec<Message>, ProjectionError> {
        if self.completed || !self.messages.is_empty() {
            return Err(ProjectionError::Invalid("invalid executor completion"));
        }
        self.completed = true;
        Ok(self.close_tools(event, ts))
    }
    pub fn finish(mut self, event: &RuntimeEvent, ts: u64) -> Vec<Message> {
        let mut rows = self.close_tools(event, ts);
        for (_, mut message) in self.messages {
            if !has_content(&message) {
                continue;
            }
            if let Content::Assistant { interrupted, .. } = &mut message.content {
                *interrupted = true;
            }
            rows.push(message);
        }
        rows
    }
    pub fn overlay(&self) -> Vec<Message> {
        self.messages
            .iter()
            .map(|(_, message)| message)
            .filter(|message| has_content(message))
            .cloned()
            .collect()
    }
    fn close_tools(&mut self, event: &RuntimeEvent, ts: u64) -> Vec<Message> {
        std::mem::take(&mut self.pending)
            .into_values()
            .enumerate()
            .map(|(index, id)| {
                result(
                    event,
                    ts,
                    maka_agent_facts::tool_call::provider_result_id(&event.id, index),
                    id,
                    "External executor ended without a tool result".into(),
                    true,
                )
            })
            .collect()
    }
}
fn has_content(message: &Message) -> bool {
    matches!(
        &message.content,
        Content::Assistant { text, thinking, .. }
            if !text.is_empty() || thinking.as_ref().is_some_and(|thought| !thought.text.is_empty())
    )
}
fn metadata() -> ToolMetadata {
    ToolMetadata::Provider {
        model_visibility: Visible::Visible,
    }
}
fn result(
    event: &RuntimeEvent,
    ts: u64,
    id: String,
    tool_use_id: String,
    text: String,
    is_error: bool,
) -> Message {
    Message {
        id,
        run_id: event.execution.run_id,
        model: None,
        turn_id: event.execution.turn_id.clone(),
        ts,
        content: Content::ToolResult {
            settlement: None,
            tool_use_id,
            is_error,
            content: ToolContent::Text { text },
            images: Vec::new(),
            metadata: metadata(),
        },
    }
}
