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

//! Current canonical fixtures use the real ingress assembler and actual receipts.

use maka_agent_facts::{
    context::ModelPurpose,
    event::{EventWrite, Fact, Invocation, RuntimeEvent},
    model::{
        ModelEvent,
        assembly::{AttemptBinding, AttemptWriter, PartReceipt},
        recorded::{ModelCompletion, ModelObservation, RecordedPartRef},
    },
};

pub fn writer(invocation: Invocation, step_id: &str, item_acceptance: bool) -> AttemptWriter {
    AttemptWriter::new(
        AttemptBinding {
            invocation,
            step_id: step_id.into(),
            purpose: ModelPurpose::Main,
        },
        item_acceptance,
    )
    .unwrap()
}

pub fn observations(
    writer: &mut AttemptWriter,
    events: impl IntoIterator<Item = ModelEvent>,
) -> Vec<EventWrite> {
    let binding = writer.snapshot().binding.clone();
    events
        .into_iter()
        .flat_map(|event| writer.push(event, std::time::SystemTime::now()).unwrap())
        .map(|event| {
            EventWrite::plain(RuntimeEvent::new(
                binding.invocation.clone(),
                Fact::ModelObserved {
                    step_id: binding.step_id.clone(),
                    event,
                },
            ))
            .unwrap()
        })
        .collect()
}

pub fn receipts(writer: &mut AttemptWriter, writes: &[EventWrite], sequences: &[u64]) {
    assert_eq!(writes.len(), sequences.len());
    for (write, &sequence) in writes.iter().zip(sequences) {
        if let Fact::ModelObserved {
            event: ModelObservation::Part(record),
            ..
        } = &write.event().fact
        {
            writer.recorded(PartReceipt {
                part: RecordedPartRef {
                    event_id: write.event().id.clone(),
                    ordinal: record.ordinal,
                },
                sequence,
            });
        } else {
            writer.fenced(sequence);
        }
    }
}

/// Build a completion-only canonical fixture from its actual immutable parts.
pub fn completion(
    invocation: Invocation,
    step_id: &str,
    parts: Vec<maka_agent_facts::model::ModelPart>,
    reason: maka_agent_facts::model::ModelFinishReason,
) -> ModelCompletion {
    use maka_agent_facts::model::ModelPart;
    let mut writer = writer(invocation, step_id, false);
    for (ordinal, part) in parts.into_iter().enumerate() {
        let events = match part {
            ModelPart::Source { source } => vec![ModelEvent::Source(source)],
            ModelPart::ToolCall { call } => vec![ModelEvent::ToolCall(call)],
            ModelPart::ToolResult {
                id,
                name,
                output,
                is_error,
                provider_options,
            } => vec![ModelEvent::ProviderToolResult {
                id,
                name,
                output,
                is_error,
                provider_options,
            }],
            ModelPart::Text {
                text_kind,
                text,
                provider_options,
            } => {
                let id = format!("part-{ordinal}");
                let mut events = vec![ModelEvent::PartStarted {
                    id: id.clone(),
                    text_kind,
                    provider_options: provider_options.map(|options| (*options).clone()),
                }];
                events.extend(text.chunks().map(|text| ModelEvent::PartDelta {
                    id: id.clone(),
                    text: text.into(),
                    provider_options: None,
                }));
                events.push(ModelEvent::PartFinished {
                    id,
                    provider_options: None,
                });
                events
            }
        };
        for event in events {
            writer.push(event, std::time::SystemTime::now()).unwrap();
        }
    }
    writer
        .push(
            ModelEvent::Finished {
                reason,
                usage: Default::default(),
                provider_options: None,
            },
            std::time::SystemTime::now(),
        )
        .unwrap();
    writer.completed().unwrap().completion()
}

/// Resolve only the concrete canonical part references checked by the store.
pub fn parts<'a>(
    completion: &'a ModelCompletion,
    events: &'a [maka_agent_facts::event::StoredEvent],
) -> impl Iterator<Item = &'a maka_agent_facts::model::ModelPart> {
    completion.parts.iter().map(move |part| match part {
        maka_agent_facts::model::recorded::CompletionPart::Own(record) => record.part.as_ref(),
        maka_agent_facts::model::recorded::CompletionPart::Ref(reference) => events
            .iter()
            .find_map(|stored| match &stored.event.fact {
                Fact::ModelObserved {
                    event: ModelObservation::Part(record),
                    ..
                } if stored.event.id == reference.event_id
                    && record.ordinal == reference.ordinal =>
                {
                    Some(record.part.as_ref())
                }
                _ => None,
            })
            .expect("canonical completion reference resolves to its original body"),
    })
}
