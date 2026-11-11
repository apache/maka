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

use super::{OptionsPatch, PartSlot, StepBuilder, StepState, invalid, merged_options};
use crate::{
    context::ModelPurpose,
    durable::ExecutionIdentity,
    model::{
        ModelEvent, ModelFinishReason, ModelPart, ModelUsage, TextKind, body::TextBody, recorded::*,
    },
    tool_call::tool_use_id,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, sync::Arc, time::SystemTime};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AttemptBinding {
    pub execution: ExecutionIdentity,
    pub step_id: crate::durable::StepId,
    pub attempt_id: crate::durable::ModelAttemptId,
    pub purpose: ModelPurpose,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PartReceipt {
    pub part: RecordedPartRef,
    pub sequence: u64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum PreviewPart {
    Text {
        ordinal: u64,
        message_id: String,
        started_at: SystemTime,
        provider_part_id: String,
        text_kind: TextKind,
        text: TextBody,
        provider_options: Option<Arc<Value>>,
        recorded: Option<PartReceipt>,
    },
    ToolInput(ToolInputView),
}

#[derive(Clone)]
struct PartIdentity {
    message_id: String,
    started_at: SystemTime,
    provider_part_id: Option<String>,
}
impl PartIdentity {
    fn record(&self, ordinal: usize, part: Arc<ModelPart>) -> ModelPartRecord {
        ModelPartRecord {
            ordinal: ordinal as u64,
            message_id: self.message_id.clone(),
            started_at: self.started_at,
            provider_part_id: self.provider_part_id.clone(),
            part,
        }
    }
}
#[derive(Clone)]
enum PartialText {
    Frozen(CompletionPart),
    Open {
        identity: PartIdentity,
        ordinal: usize,
        text_kind: TextKind,
        text: TextBody,
        options: Option<Arc<OptionsPatch>>,
    },
}
#[derive(Clone)]
struct PartialSnapshot {
    parts: Vec<PartialText>,
    tool_inputs: Vec<ToolInputView>,
    response_id: Option<String>,
    model: Option<String>,
    timestamp: Option<String>,
}
impl PartialSnapshot {
    fn materialize(&self) -> ModelPartial {
        ModelPartial {
            parts: self
                .parts
                .iter()
                .map(|part| match part {
                    PartialText::Frozen(part) => part.clone(),
                    PartialText::Open {
                        identity,
                        ordinal,
                        text_kind,
                        text,
                        options,
                    } => CompletionPart::Own(identity.record(
                        *ordinal,
                        Arc::new(ModelPart::Text {
                            text_kind: *text_kind,
                            text: text.clone(),
                            provider_options: merged_options(options),
                        }),
                    )),
                })
                .collect(),
            tool_inputs: self.tool_inputs.clone(),
            response_id: self.response_id.clone(),
            model: self.model.clone(),
            timestamp: self.timestamp.clone(),
        }
    }
}

/// One stable valid cut. Construct outside the publication lock, then share its root.
#[derive(Clone)]
pub struct AttemptCut {
    pub binding: AttemptBinding,
    pub revision: u64,
    pub depends_on: u64,
    pub parts: Box<[PreviewPart]>,
    partial: Option<PartialSnapshot>,
}
impl std::fmt::Debug for AttemptCut {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AttemptCut")
            .field("binding", &self.binding)
            .field("revision", &self.revision)
            .field("depends_on", &self.depends_on)
            .field("parts", &self.parts)
            .finish_non_exhaustive()
    }
}
impl AttemptCut {
    /// Apply actual canonical receipts without copying immutable part bodies.
    pub fn with_prefix_receipts(
        &self,
        writes: &[crate::event::EventWrite],
        sequences: &[u64],
    ) -> Self {
        let mut cut = self.clone();
        let mut receipts = HashMap::new();
        let mut tool_ids = std::collections::HashSet::new();
        for (write, &sequence) in writes.iter().zip(sequences) {
            cut.depends_on = cut.depends_on.max(sequence);
            let crate::event::Fact::ModelObserved {
                event: ModelObservation::Part(part),
                ..
            } = &write.event().fact
            else {
                continue;
            };
            receipts.insert(
                part.ordinal,
                PartReceipt {
                    part: RecordedPartRef {
                        event_id: write.event().id.clone(),
                        ordinal: part.ordinal,
                    },
                    sequence,
                },
            );
            if let ModelPart::ToolCall { call } = part.part.as_ref() {
                tool_ids.insert(call.id.as_str());
            }
        }
        let mut parts = cut.parts.into_vec();
        parts.retain_mut(|preview| match preview {
            PreviewPart::Text {
                ordinal, recorded, ..
            } => {
                if let Some(receipt) = receipts.get(ordinal) {
                    *recorded = Some(receipt.clone());
                }
                true
            }
            PreviewPart::ToolInput(input) => !tool_ids.contains(input.id.as_str()),
        });
        cut.parts = parts.into_boxed_slice();
        if let Some(partial) = &mut cut.partial {
            for partial_part in &mut partial.parts {
                if let PartialText::Frozen(CompletionPart::Own(record)) = partial_part
                    && let Some(receipt) = receipts.get(&record.ordinal)
                {
                    *partial_part = PartialText::Frozen(CompletionPart::Ref(receipt.part.clone()));
                }
            }
            partial
                .tool_inputs
                .retain(|input| !tool_ids.contains(input.id.as_str()));
        }
        cut.revision = cut
            .revision
            .checked_add(1)
            .expect("model attempt revision overflow");
        cut
    }

    /// Only failure sealing materializes private options; ordinary preview does not.
    pub fn partial(&self) -> Option<ModelPartial> {
        self.partial.as_ref().map(PartialSnapshot::materialize)
    }
}

#[derive(Clone, Debug)]
pub struct CompletedAttempt {
    pub compaction: Option<super::super::NativeCompaction>,
    pub binding: AttemptBinding,
    pub finish_reason: ModelFinishReason,
    pub usage: ModelUsage,
    pub provider_options: Option<Arc<Value>>,
    pub response_id: Option<String>,
    pub model: Option<String>,
    pub timestamp: Option<String>,
    parts: Vec<ModelPartRecord>,
    recorded: HashMap<u64, PartReceipt>,
}
impl CompletedAttempt {
    pub fn parts(&self) -> &[ModelPartRecord] {
        &self.parts
    }
    pub fn completion(&self) -> ModelCompletion {
        ModelCompletion {
            compaction: self.compaction.clone(),
            parts: self
                .parts
                .iter()
                .map(|part| {
                    self.recorded.get(&part.ordinal).map_or_else(
                        || CompletionPart::Own(part.clone()),
                        |receipt| CompletionPart::Ref(receipt.part.clone()),
                    )
                })
                .collect(),
            finish_reason: self.finish_reason,
            usage: self.usage.clone(),
            provider_options: self.provider_options.clone(),
            response_id: self.response_id.clone(),
            model: self.model.clone(),
            timestamp: self.timestamp.clone(),
        }
    }
    pub fn local_call_ids(&self) -> Vec<String> {
        self.parts
            .iter()
            .filter_map(|record| match record.part.as_ref() {
                ModelPart::ToolCall { call } if !call.provider_executed => Some(call.id.clone()),
                _ => None,
            })
            .collect()
    }
}

/// The only mutable assembly for one physical model attempt.
pub struct AttemptWriter {
    binding: AttemptBinding,
    item_acceptance: bool,
    builder: StepBuilder,
    identities: Vec<PartIdentity>,
    input_starts: Vec<(String, SystemTime)>,
    recorded: HashMap<u64, PartReceipt>,
    revision: u64,
    depends_on: u64,
}
impl std::fmt::Debug for AttemptWriter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AttemptWriter")
            .field("binding", &self.binding)
            .field("revision", &self.revision)
            .field("depends_on", &self.depends_on)
            .finish_non_exhaustive()
    }
}
impl AttemptWriter {
    pub fn new(
        binding: AttemptBinding,
        item_acceptance: bool,
        depends_on: u64,
    ) -> Result<Self, super::ModelError> {
        if binding.purpose == ModelPurpose::Summary && item_acceptance {
            return Err(invalid("item acceptance is only valid for main requests"));
        }
        let builder = StepBuilder::for_step(binding.step_id)?;
        Ok(Self {
            binding,
            item_acceptance,
            builder,
            identities: Vec::new(),
            input_starts: Vec::new(),
            recorded: HashMap::new(),
            revision: 0,
            depends_on,
        })
    }
    pub fn push(
        &mut self,
        mut event: ModelEvent,
        observed_at: SystemTime,
    ) -> Result<Vec<ModelObservation>, super::ModelError> {
        let mut options_target = None;
        let options = match &mut event {
            ModelEvent::PartStarted {
                id,
                provider_options,
                ..
            }
            | ModelEvent::PartDelta {
                id,
                provider_options,
                ..
            }
            | ModelEvent::PartFinished {
                id,
                provider_options,
            } => {
                options_target = Some(id.clone());
                provider_options.take().map(Arc::new)
            }
            ModelEvent::Finished {
                provider_options, ..
            } => provider_options.take().map(Arc::new),
            _ => None,
        };
        let started = match &event {
            ModelEvent::PartStarted { id, .. } => Some(id.clone()),
            _ => None,
        };
        let input_started = match &event {
            ModelEvent::ToolInputStarted { id, .. } => Some(id.clone()),
            _ => None,
        };
        let call = match &event {
            ModelEvent::ToolCall(call) => Some(call.id.clone()),
            _ => None,
        };
        let independent_id = match &event {
            ModelEvent::ToolCall(call) => Some(call.id.clone()),
            ModelEvent::ProviderToolResult { id, .. } => Some(id.clone()),
            _ => None,
        };
        let metadata = match &event {
            ModelEvent::ResponseMetadata {
                id,
                model,
                timestamp,
            } => Some(ModelObservation::ResponseMetadata {
                id: id.clone(),
                model: model.clone(),
                timestamp: timestamp.clone(),
            }),
            ModelEvent::Finished { reason, usage, .. } => Some(ModelObservation::Finished {
                reason: *reason,
                usage: usage.clone(),
                provider_options: options.clone(),
            }),
            _ => None,
        };
        self.builder.push_shared(event, options.clone())?;
        if let Some(id) = started {
            self.identities.push(PartIdentity {
                message_id: crate::event::RuntimeEvent::new_id(),
                started_at: observed_at,
                provider_part_id: Some(id),
            });
        }
        if let Some(id) = input_started {
            self.input_starts.push((id, observed_at));
        }
        let mut observations = Vec::new();
        let mut emitted_part = false;
        if let Some(index) = self.builder.accepted {
            let PartSlot::Closed(part) = &self.builder.parts[index] else {
                unreachable!("accepted part is closed");
            };
            if self.identities.len() == index {
                let message_id = if let Some(id) = call {
                    tool_use_id(
                        self.binding.execution.run_id,
                        &format!("{}:{id}", self.binding.attempt_id),
                    )
                } else {
                    crate::event::RuntimeEvent::new_id()
                };
                self.identities.push(PartIdentity {
                    message_id,
                    started_at: observed_at,
                    provider_part_id: independent_id,
                });
            }
            let retain = (self.binding.purpose == ModelPurpose::Main && self.item_acceptance)
                || matches!(part.as_ref(), ModelPart::ToolCall { call } if call.provider_executed)
                || matches!(part.as_ref(), ModelPart::ToolResult { .. });
            if retain {
                observations.push(ModelObservation::Part(
                    self.identities[index].record(index, part.clone()),
                ));
                emitted_part = true;
            }
        }
        if self.binding.purpose == ModelPurpose::Main
            && !emitted_part
            && options_target.is_some()
            && let Some(options) = options
        {
            observations.push(ModelObservation::ProviderOptions {
                provider_part_id: options_target,
                options,
            });
        }
        if self.binding.purpose == ModelPurpose::Main
            && !emitted_part
            && let Some((_, ModelPart::ToolCall { call })) = self.builder.accepted_item()
            && let Some(options) = &call.provider_options
        {
            observations.push(ModelObservation::ProviderOptions {
                provider_part_id: Some(call.id.clone()),
                options: Arc::new(options.clone()),
            });
        }
        if let Some(metadata) = metadata
            && (self.binding.purpose == ModelPurpose::Main
                || matches!(
                    metadata,
                    ModelObservation::ResponseMetadata { .. } | ModelObservation::Finished { .. }
                ))
        {
            observations.push(metadata);
        }
        self.advance();
        Ok(observations)
    }
    pub fn fenced(&mut self, sequence: u64) {
        if sequence > self.depends_on {
            self.depends_on = sequence;
            self.advance();
        }
    }
    pub fn recorded(&mut self, receipt: PartReceipt) {
        if let Some(PartSlot::Closed(part)) = self.builder.parts.get(receipt.part.ordinal as usize)
            && let ModelPart::ToolCall { call } = part.as_ref()
        {
            let id = call.id.clone();
            self.input_starts.retain(|(pending, _)| pending != &id);
            self.builder.tool_inputs.remove(&id);
        }
        self.fenced(receipt.sequence);
        self.recorded.insert(receipt.part.ordinal, receipt);
        self.advance();
    }
    fn advance(&mut self) {
        self.revision = self
            .revision
            .checked_add(1)
            .expect("model attempt revision overflow");
    }
    fn tool_inputs(&self) -> Vec<ToolInputView> {
        self.input_starts
            .iter()
            .filter_map(|(id, started_at)| {
                let input = self.builder.tool_inputs.get(id)?;
                Some(ToolInputView {
                    id: id.clone(),
                    message_id: tool_use_id(
                        self.binding.execution.run_id,
                        &format!("{}:{id}", self.binding.attempt_id),
                    ),
                    started_at: *started_at,
                    name: input.name.clone(),
                    provider_executed: input.provider_executed,
                    text: input.text.snapshot(),
                    phase: if input.finished {
                        ToolInputPhase::Finished
                    } else {
                        ToolInputPhase::Open
                    },
                })
            })
            .collect()
    }
    pub fn snapshot(&self) -> Arc<AttemptCut> {
        let mut parts = Vec::new();
        let mut partial = Vec::new();
        if self.binding.purpose == ModelPurpose::Main {
            for (index, slot) in self.builder.parts.iter().enumerate() {
                let identity = &self.identities[index];
                let receipt = self.recorded.get(&(index as u64));
                let (text_kind, text, provider_options) = match slot {
                    PartSlot::Text {
                        text_kind,
                        text,
                        options,
                    } => {
                        let text = text.snapshot();
                        partial.push(PartialText::Open {
                            identity: identity.clone(),
                            ordinal: index,
                            text_kind: *text_kind,
                            text: text.clone(),
                            options: options.clone(),
                        });
                        (
                            *text_kind,
                            text,
                            if *text_kind == TextKind::Thinking {
                                super::merged_options(options)
                            } else {
                                None
                            },
                        )
                    }
                    PartSlot::Closed(part) => {
                        if !(self.item_acceptance && receipt.is_some()) {
                            partial.push(PartialText::Frozen(receipt.map_or_else(
                                || CompletionPart::Own(identity.record(index, part.clone())),
                                |receipt| CompletionPart::Ref(receipt.part.clone()),
                            )));
                        }
                        let ModelPart::Text {
                            text_kind,
                            text,
                            provider_options,
                        } = part.as_ref()
                        else {
                            continue;
                        };
                        (
                            *text_kind,
                            text.clone(),
                            if *text_kind == TextKind::Thinking {
                                provider_options.clone()
                            } else {
                                None
                            },
                        )
                    }
                };
                parts.push(PreviewPart::Text {
                    ordinal: index as u64,
                    message_id: identity.message_id.clone(),
                    started_at: identity.started_at,
                    provider_part_id: identity
                        .provider_part_id
                        .clone()
                        .expect("text identity has provider part"),
                    text_kind,
                    text,
                    provider_options,
                    recorded: receipt.cloned(),
                });
            }
        }
        let tool_inputs = if self.binding.purpose == ModelPurpose::Main {
            self.tool_inputs()
        } else {
            Vec::new()
        };
        parts.extend(tool_inputs.iter().cloned().map(PreviewPart::ToolInput));
        let partial = (self.binding.purpose == ModelPurpose::Main).then(|| PartialSnapshot {
            parts: partial,
            tool_inputs: tool_inputs
                .into_iter()
                .filter(|input| !self.builder.calls.contains_key(&input.id))
                .collect(),
            response_id: self.builder.response_id.clone(),
            model: self.builder.model.clone(),
            timestamp: self.builder.timestamp.clone(),
        });
        Arc::new(AttemptCut {
            binding: self.binding.clone(),
            revision: self.revision,
            depends_on: self.depends_on,
            parts: parts.into_boxed_slice(),
            partial,
        })
    }
    pub fn partial(&self) -> Option<ModelPartial> {
        self.snapshot().partial()
    }
    pub fn has_output(&self) -> bool {
        !self.builder.parts.is_empty()
            || !self.builder.tool_inputs.is_empty()
            || matches!(self.builder.state, StepState::Finished { .. })
    }
    pub fn completed(&self) -> Result<CompletedAttempt, super::ModelError> {
        let (finish_reason, usage, provider_options, compaction) = match &self.builder.state {
            StepState::Finished {
                compaction,
                reason,
                usage,
                provider_options,
            } => (
                *reason,
                usage.clone(),
                provider_options.clone(),
                compaction.clone(),
            ),
            StepState::Assembling => return Err(invalid("model step missing finish")),
            StepState::Poisoned => return Err(invalid("model step previously failed")),
        };
        let parts = self
            .builder
            .parts
            .iter()
            .enumerate()
            .map(|(index, slot)| {
                let PartSlot::Closed(part) = slot else {
                    unreachable!("finished attempt has no open text");
                };
                self.identities[index].record(index, part.clone())
            })
            .collect();
        Ok(CompletedAttempt {
            compaction,
            binding: self.binding.clone(),
            finish_reason,
            usage,
            provider_options,
            response_id: self.builder.response_id.clone(),
            model: self.builder.model.clone(),
            timestamp: self.builder.timestamp.clone(),
            parts,
            recorded: self.recorded.clone(),
        })
    }
}
