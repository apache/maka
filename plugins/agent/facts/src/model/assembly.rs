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

use super::body::TextBuilder;
use super::error::ModelError;
use super::merge_provider_options as merge;
use super::{ModelEvent, ModelFinishReason, ModelPart, ModelStep, ModelUsage};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

mod attempt;
mod identity;
pub use attempt::{
    AttemptBinding, AttemptCut, AttemptWriter, CompletedAttempt, PartReceipt, PreviewPart,
};

fn invalid(message: &str) -> ModelError {
    ModelError::Adapter(message.into())
}

#[derive(Default)]
enum StepState {
    #[default]
    Assembling,
    Finished {
        reason: ModelFinishReason,
        usage: ModelUsage,
        provider_options: Option<Arc<Value>>,
    },
    Poisoned,
}

struct OptionsPatch {
    previous: Option<Arc<OptionsPatch>>,
    value: Arc<Value>,
}
impl Drop for OptionsPatch {
    fn drop(&mut self) {
        let mut previous = self.previous.take();
        while let Some(node) = previous {
            match Arc::try_unwrap(node) {
                Ok(mut node) => previous = node.previous.take(),
                Err(_) => break,
            }
        }
    }
}
fn append_options(target: &mut Option<Arc<OptionsPatch>>, value: Arc<Value>) {
    *target = Some(Arc::new(OptionsPatch {
        previous: target.take(),
        value,
    }));
}
fn merged_options(patches: &Option<Arc<OptionsPatch>>) -> Option<Arc<Value>> {
    let mut reversed = Vec::new();
    let mut next = patches.as_deref();
    while let Some(patch) = next {
        reversed.push(&patch.value);
        next = patch.previous.as_deref();
    }
    let mut result = None;
    for value in reversed.into_iter().rev() {
        merge(&mut result, Some(value.as_ref().clone()));
    }
    result.map(Arc::new)
}

enum PartSlot {
    Text {
        text_kind: super::TextKind,
        text: TextBuilder,
        options: Option<Arc<OptionsPatch>>,
    },
    Closed(Arc<ModelPart>),
}
impl PartSlot {
    fn snapshot(&self) -> Arc<ModelPart> {
        match self {
            Self::Text {
                text_kind,
                text,
                options,
            } => Arc::new(ModelPart::Text {
                text_kind: *text_kind,
                text: text.snapshot(),
                provider_options: merged_options(options),
            }),
            Self::Closed(part) => part.clone(),
        }
    }
}

struct PendingToolInput {
    name: String,
    provider_executed: bool,
    finished: bool,
    text: TextBuilder,
}

/// Raw ingress assembly used by provider adapters and the attempt writer.
/// Only closed items can authorize streaming execution.
#[derive(Default)]
pub struct StepBuilder {
    parts: Vec<PartSlot>,
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
        self.push_shared(event, None)
    }
    fn push_shared(
        &mut self,
        event: ModelEvent,
        options: Option<Arc<Value>>,
    ) -> Result<(), ModelError> {
        self.accepted = None;
        let result = self.apply(event, options);
        if result.is_err() {
            self.state = StepState::Poisoned;
        }
        result
    }
    pub fn accepted_item(&self) -> Option<(usize, &ModelPart)> {
        let index = self.accepted?;
        let PartSlot::Closed(part) = &self.parts[index] else {
            return None;
        };
        Some((index, part))
    }
    pub fn accepted_parts(&self) -> impl Iterator<Item = (usize, &ModelPart)> {
        self.parts
            .iter()
            .enumerate()
            .filter_map(|(index, slot)| match slot {
                PartSlot::Closed(part) => Some((index, part.as_ref())),
                _ => None,
            })
    }
    fn apply(
        &mut self,
        event: ModelEvent,
        shared_options: Option<Arc<Value>>,
    ) -> Result<(), ModelError> {
        if !matches!(self.state, StepState::Assembling) {
            return Err(invalid("event after failed or finished step"));
        }
        match event {
            ModelEvent::Source(source) => {
                self.accepted = Some(self.parts.len());
                self.parts
                    .push(PartSlot::Closed(Arc::new(ModelPart::Source { source })));
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
                let mut options = None;
                if let Some(value) = shared_options.or_else(|| provider_options.map(Arc::new)) {
                    append_options(&mut options, value);
                }
                self.parts.push(PartSlot::Text {
                    text_kind,
                    text: TextBuilder::new(),
                    options,
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
                if let PartSlot::Text {
                    text: accumulated,
                    options,
                    ..
                } = &mut self.parts[index]
                {
                    accumulated.push(&text);
                    if let Some(value) = shared_options.or_else(|| provider_options.map(Arc::new)) {
                        append_options(options, value);
                    }
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
                if let PartSlot::Text { options, .. } = &mut self.parts[index]
                    && let Some(value) = shared_options.or_else(|| provider_options.map(Arc::new))
                {
                    append_options(options, value);
                }
                self.parts[index] = PartSlot::Closed(self.parts[index].snapshot());
                self.accepted = Some(index);
            }
            ModelEvent::ToolInputStarted {
                id,
                name,
                provider_executed,
            } => {
                self.validate_tool_identity(&id, &name)?;
                if self.calls.contains_key(&id) || self.tool_inputs.contains_key(&id) {
                    return Err(invalid("duplicate tool input"));
                }
                self.tool_inputs.insert(
                    id,
                    PendingToolInput {
                        name,
                        provider_executed,
                        finished: false,
                        text: TextBuilder::new(),
                    },
                );
            }
            ModelEvent::ToolInputDelta { id, text } => {
                let input = self
                    .tool_inputs
                    .get_mut(&id)
                    .ok_or_else(|| invalid("delta without open tool input"))?;
                if input.finished {
                    return Err(invalid("delta after tool input end"));
                }
                input.text.push(&text);
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
                if self.calls.contains_key(&call.id) {
                    return Err(invalid("duplicate tool call"));
                }
                if let Some(input) = self.tool_inputs.get(&call.id)
                    && (input.name != call.name
                        || input.provider_executed != call.provider_executed)
                {
                    return Err(invalid("complete tool call differs from input identity"));
                }
                if let Some(input) = self.tool_inputs.get_mut(&call.id) {
                    input.finished = true;
                }
                self.calls
                    .insert(call.id.clone(), (call.name.clone(), call.provider_executed));
                self.accepted = Some(self.parts.len());
                self.parts
                    .push(PartSlot::Closed(Arc::new(ModelPart::ToolCall { call })));
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
                self.parts
                    .push(PartSlot::Closed(Arc::new(ModelPart::ToolResult {
                        id,
                        name,
                        output,
                        is_error,
                        provider_options,
                    })));
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
                if !self.open.is_empty()
                    || self
                        .tool_inputs
                        .keys()
                        .any(|id| !self.calls.contains_key(id))
                {
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
                    provider_options: shared_options.or_else(|| provider_options.map(Arc::new)),
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
            parts: self
                .parts
                .into_iter()
                .map(|slot| match slot {
                    PartSlot::Closed(part) => Arc::unwrap_or_clone(part),
                    PartSlot::Text { .. } => unreachable!("finished step has no open text"),
                })
                .collect(),
            finish_reason,
            usage,
            provider_options: provider_options.map(Arc::unwrap_or_clone),
            response_id: self.response_id,
            model: self.model,
            timestamp: self.timestamp,
        })
    }
}
