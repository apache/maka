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

use super::error::ModelError;
use super::merge_provider_options as merge;
fn invalid(message: &str) -> ModelError {
    ModelError::Adapter(message.into())
}
use super::{ModelEvent, ModelFinishReason, ModelPart, ModelStep, ModelUsage};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
mod identity;
#[derive(Default)]
enum StepState {
    #[default]
    Assembling,
    Finished {
        reason: ModelFinishReason,
        usage: ModelUsage,
        provider_options: Option<Value>,
    },
    Poisoned,
}

struct PendingToolInput {
    name: String,
    provider_executed: bool,
    finished: bool,
}

/// Shared validation and assembly for Host ingress, durable acceptance proofs
/// and history projection. Only closed items can authorize streaming execution.
#[derive(Default)]
pub struct StepBuilder {
    parts: Vec<ModelPart>,
    accepted: Option<usize>,
    open: HashMap<String, usize>,
    seen: HashSet<String>,
    tool_inputs: HashMap<String, PendingToolInput>,
    calls: HashMap<String, (String, bool)>,
    results: HashSet<String>,
    state: StepState,
    response_id: Option<String>,
    model: Option<String>,
    timestamp: Option<String>,
}
impl StepBuilder {
    pub fn push(&mut self, event: ModelEvent) -> Result<(), ModelError> {
        self.accepted = None;
        let result = self.apply(event);
        if result.is_err() {
            self.state = StepState::Poisoned;
        }
        result
    }
    /// The complete item admitted by the most recent valid observation. Its
    /// index is allocated when it starts, independent of completion order.
    pub fn accepted_item(&self) -> Option<(usize, &ModelPart)> {
        self.accepted.map(|index| (index, &self.parts[index]))
    }

    pub fn accepted_parts(&self) -> impl Iterator<Item = (usize, &ModelPart)> {
        self.parts
            .iter()
            .enumerate()
            .filter(|(index, _)| !self.open.values().any(|open| open == index))
    }

    fn apply(&mut self, event: ModelEvent) -> Result<(), ModelError> {
        if !matches!(self.state, StepState::Assembling) {
            return Err(invalid("event after failed or finished step"));
        }
        match event {
            ModelEvent::Source(source) => {
                self.accepted = Some(self.parts.len());
                self.parts.push(ModelPart::Source { source });
            }
            ModelEvent::PartStarted {
                id,
                text_kind,
                provider_options,
            } => {
                if !self.seen.insert(id.clone()) {
                    return Err(invalid("duplicate model part"));
                }
                self.open.insert(id, self.parts.len());
                self.parts.push(ModelPart::Text {
                    text_kind,
                    text: String::new(),
                    provider_options,
                });
            }
            ModelEvent::PartDelta {
                id,
                text,
                provider_options,
            } => {
                let index = *self
                    .open
                    .get(&id)
                    .ok_or_else(|| invalid("delta without open part"))?;
                if let ModelPart::Text {
                    text: accumulated,
                    provider_options: metadata,
                    ..
                } = &mut self.parts[index]
                {
                    accumulated.push_str(&text);
                    merge(metadata, provider_options);
                }
            }
            ModelEvent::PartFinished {
                id,
                provider_options,
            } => {
                let index = self
                    .open
                    .remove(&id)
                    .ok_or_else(|| invalid("end without open part"))?;
                if let ModelPart::Text {
                    provider_options: metadata,
                    ..
                } = &mut self.parts[index]
                {
                    merge(metadata, provider_options);
                }
                self.accepted = Some(index);
            }
            ModelEvent::ToolInputStarted {
                id,
                name,
                provider_executed,
            } => {
                self.validate_tool_identity(&id, &name)?;
                if self.calls.contains_key(&id)
                    || self
                        .tool_inputs
                        .insert(
                            id,
                            PendingToolInput {
                                name,
                                provider_executed,
                                finished: false,
                            },
                        )
                        .is_some()
                {
                    return Err(invalid("duplicate tool input"));
                }
            }
            ModelEvent::ToolInputDelta { id, .. } => {
                let input = self
                    .tool_inputs
                    .get(&id)
                    .ok_or_else(|| invalid("delta without open tool input"))?;
                if input.finished {
                    return Err(invalid("delta after tool input end"));
                }
            }
            ModelEvent::ToolInputFinished { id } => {
                let input = self
                    .tool_inputs
                    .get_mut(&id)
                    .ok_or_else(|| invalid("end without open tool input"))?;
                if input.finished {
                    return Err(invalid("duplicate tool input end"));
                }
                input.finished = true;
            }
            ModelEvent::ToolCall(call) => {
                self.validate_call(&call)?;
                if let Some(input) = self.tool_inputs.remove(&call.id)
                    && (input.name != call.name
                        || input.provider_executed != call.provider_executed)
                {
                    return Err(invalid("complete tool call differs from input identity"));
                }
                if self
                    .calls
                    .insert(call.id.clone(), (call.name.clone(), call.provider_executed))
                    .is_some()
                {
                    return Err(invalid("duplicate tool call"));
                }
                self.accepted = Some(self.parts.len());
                self.parts.push(ModelPart::ToolCall { call });
            }
            ModelEvent::ProviderToolResult {
                id,
                name,
                output,
                is_error,
                provider_options,
            } => {
                if self.calls.get(&id) != Some(&(name.clone(), true))
                    || !self.results.insert(id.clone())
                {
                    return Err(invalid(
                        "provider result without matching outstanding provider call",
                    ));
                }
                self.accepted = Some(self.parts.len());
                self.parts.push(ModelPart::ToolResult {
                    id,
                    name,
                    output,
                    is_error,
                    provider_options,
                });
            }
            ModelEvent::ResponseMetadata {
                id,
                model,
                timestamp,
            } => {
                if id.is_some() {
                    self.response_id = id;
                }
                if model.is_some() {
                    self.model = model;
                }
                if timestamp.is_some() {
                    self.timestamp = timestamp;
                }
            }
            ModelEvent::Finished {
                reason,
                usage,
                provider_options,
            } => {
                if !self.open.is_empty() || !self.tool_inputs.is_empty() {
                    return Err(invalid("incomplete model step"));
                }
                if self
                    .calls
                    .iter()
                    .any(|(id, (_, provider))| *provider && !self.results.contains(id))
                {
                    return Err(invalid("provider tool result missing"));
                }
                self.state = StepState::Finished {
                    reason,
                    usage,
                    provider_options,
                };
            }
        }
        Ok(())
    }
    pub fn finish(self) -> Result<ModelStep, ModelError> {
        let (finish_reason, usage, provider_options) = match self.state {
            StepState::Assembling => return Err(invalid("model step missing finish")),
            StepState::Poisoned => return Err(invalid("model step previously failed")),
            StepState::Finished {
                reason,
                usage,
                provider_options,
            } => (reason, usage, provider_options),
        };
        Ok(ModelStep {
            parts: self.parts,
            finish_reason,
            usage,
            provider_options,
            response_id: self.response_id,
            model: self.model,
            timestamp: self.timestamp,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::TextKind;
    use super::*;
    use serde_json::json;

    #[test]
    fn interleaved_parts_preserve_metadata_and_require_complete_streams() {
        let events = [
            ModelEvent::PartStarted {
                id: "r".into(),
                text_kind: TextKind::Thinking,
                provider_options: Some(json!({"anthropic":{"signature":"initial","other":1}})),
            },
            ModelEvent::PartStarted {
                id: "t".into(),
                text_kind: TextKind::Text,
                provider_options: None,
            },
            ModelEvent::PartDelta {
                id: "r".into(),
                text: "think".into(),
                provider_options: None,
            },
            ModelEvent::PartDelta {
                id: "t".into(),
                text: "answer".into(),
                provider_options: None,
            },
            ModelEvent::PartFinished {
                id: "r".into(),
                provider_options: Some(json!({"anthropic":{"signature":"signed"}})),
            },
            ModelEvent::PartFinished {
                id: "t".into(),
                provider_options: Some(json!({"openai":{"itemId":"item"}})),
            },
            ModelEvent::Finished {
                reason: ModelFinishReason::Stop,
                usage: ModelUsage {
                    input_tokens: Some(3),
                    output_tokens: Some(4),
                    reasoning_tokens: Some(2),
                    ..Default::default()
                },
                provider_options: None,
            },
        ];
        for length in [4, 6, 7] {
            let mut builder = StepBuilder::default();
            for event in &events[..length] {
                builder.push(event.clone()).unwrap();
            }
            let result = builder.finish();
            assert_eq!(result.is_ok(), length == 7);
            if let Ok(step) = result {
                assert_eq!(
                    step.parts,
                    vec![
                        ModelPart::Text {
                            text_kind: TextKind::Thinking,
                            text: "think".into(),
                            provider_options: Some(
                                json!({"anthropic":{"signature":"signed","other":1}})
                            )
                        },
                        ModelPart::Text {
                            text_kind: TextKind::Text,
                            text: "answer".into(),
                            provider_options: Some(json!({"openai":{"itemId":"item"}}))
                        },
                    ]
                );
                assert_eq!(step.finish_reason, ModelFinishReason::Stop);
                assert_eq!(step.usage.output_tokens, Some(4));
                assert_eq!(step.usage.reasoning_tokens, Some(2));
            }
        }
    }
}
