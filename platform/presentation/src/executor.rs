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
    message: Message,
    pending: BTreeMap<String, String>,
    seen: BTreeSet<String>,
    completed: bool,
}
impl Execution {
    pub fn new(event: &RuntimeEvent, ts: u64, binding: &Binding) -> Self {
        Self {
            message: Message {
                id: event.id.clone(),
                turn_id: event.invocation.turn_id.clone(),
                ts,
                content: Content::Assistant {
                    imported: false,
                    text: String::new(),
                    model_id: binding.executor_id.as_str().into(),
                    interrupted: false,
                    thinking: None,
                    provider_options: None,
                },
            },
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
        let Content::Assistant { text, thinking, .. } = &mut self.message.content else {
            unreachable!()
        };
        let row = match output {
            Output::OutputDelta { text: delta } => {
                text.push_str(delta);
                return Ok(vec![]);
            }
            Output::ThinkingDelta { text: delta } => {
                thinking
                    .get_or_insert_with(|| Thinking {
                        text: String::new(),
                        provider_options: None,
                    })
                    .text
                    .push_str(delta);
                return Ok(vec![]);
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
                let id = crate::tool_message_id(&event.invocation.invocation_id, tool_call_id);
                self.pending.insert(tool_call_id.clone(), id.clone());
                Message {
                    id,
                    turn_id: event.invocation.turn_id.clone(),
                    ts,
                    content: Content::ToolCall {
                        tool_name: name.clone(),
                        args: input.clone(),
                        step_id: Some(self.message.id.clone()),
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
            } => {
                let id = self
                    .pending
                    .remove(tool_call_id)
                    .ok_or(ProjectionError::Invalid("result for unknown executor tool"))?;
                result(event, ts, event.id.clone(), id, text.clone(), *is_error)
            }
        };
        Ok(vec![row])
    }
    pub fn complete(
        &mut self,
        event: &RuntimeEvent,
        ts: u64,
        text: &str,
    ) -> Result<Vec<Message>, ProjectionError> {
        if self.completed {
            return Err(ProjectionError::Invalid("duplicate executor completion"));
        }
        let Content::Assistant { text: current, .. } = &mut self.message.content else {
            unreachable!()
        };
        *current = text.into();
        self.completed = true;
        let mut rows = self.close_tools(event, ts);
        rows.push(self.message.clone());
        Ok(rows)
    }
    pub fn finish(mut self, event: &RuntimeEvent, ts: u64) -> Vec<Message> {
        let mut rows = self.close_tools(event, ts);
        if !self.completed {
            if let Content::Assistant { interrupted, .. } = &mut self.message.content {
                *interrupted = true;
            }
            rows.extend(self.overlay());
        }
        rows
    }
    pub fn overlay(&self) -> Vec<Message> {
        match &self.message.content {
            Content::Assistant { text, thinking, .. }
                if !self.completed && (!text.is_empty() || thinking.is_some()) =>
            {
                vec![self.message.clone()]
            }
            _ => vec![],
        }
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
        turn_id: event.invocation.turn_id.clone(),
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
