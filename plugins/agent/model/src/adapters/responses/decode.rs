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

use super::Result;
use maka_agent_facts::model::{
    ModelEvent, ModelFinishReason, ModelSource, ModelToolCall, ModelUsage, PlaintextResponses,
    TextKind, ToolInput,
};
use maka_agent_facts::tools::ToolDefinition;
use maka_provider_protocol::{
    output::{Stop, TextKind as WireTextKind},
    responses::{self as wire, Event, ItemMetadata, PartMetadata},
};
use serde_json::{Value, json};

pub struct Decoder {
    inner: wire::decode::Decoder,
    plaintext: Option<PlaintextResponses>,
    pub observed_output: bool,
    pub replay_safe: bool,
}

impl Decoder {
    pub fn new(plaintext: Option<PlaintextResponses>, tools: &[ToolDefinition]) -> Self {
        let search_name = tools
            .iter()
            .find(|tool| {
                tool.provider.as_ref().is_some_and(|provider| {
                    matches!(
                        provider.id.as_str(),
                        "openai.web_search" | "openai.web_search_preview"
                    )
                })
            })
            .map(|tool| tool.name.clone());
        Self {
            inner: wire::decode::Decoder::new(
                super::request::reasoning_mode(plaintext),
                search_name,
            ),
            plaintext,
            observed_output: false,
            replay_safe: true,
        }
    }

    pub fn finished(&self) -> bool {
        self.inner.finished()
    }

    pub fn end(&self) -> Result<()> {
        self.inner.end().map_err(Into::into)
    }

    pub fn retained_output_safe(&self) -> bool {
        self.inner.retained_output_safe()
    }

    pub fn push(&mut self, value: Value) -> Result<Vec<ModelEvent>> {
        let events = self.inner.push(value);
        self.observed_output = self.inner.observed_output;
        self.replay_safe = self.inner.replay_safe;
        events.map_err(Into::into).map(|events| {
            events
                .into_iter()
                .map(|event| self.project(event))
                .collect()
        })
    }

    fn project(&self, event: Event) -> ModelEvent {
        match event {
            Event::ResponseMetadata {
                id,
                model,
                created_at_unix_seconds,
            } => ModelEvent::ResponseMetadata {
                id,
                model,
                timestamp: created_at_unix_seconds
                    .filter(|seconds| {
                        seconds.is_finite() && seconds.abs() <= 8_640_000_000_000.0
                    })
                    .and_then(|seconds| {
                        jiff::Timestamp::from_millisecond((seconds * 1000.0) as i64).ok()
                    })
                    .map(|value| format!("{value:.3}")),
            },
            Event::PartStarted { id, kind } => ModelEvent::PartStarted {
                id,
                text_kind: match kind {
                    WireTextKind::Text => TextKind::Text,
                    WireTextKind::Reasoning => TextKind::Thinking,
                },
                provider_options: None,
            },
            Event::PartDelta { id, text } => ModelEvent::PartDelta {
                id,
                text,
                provider_options: None,
            },
            Event::PartFinished { id, metadata } => ModelEvent::PartFinished {
                id,
                provider_options: metadata.map(|metadata| match metadata {
                    PartMetadata::Item(metadata) => item_options(metadata),
                    PartMetadata::PlaintextSummary {
                        item_id,
                        summary_part_lengths,
                    } => json!({
                        "makaResponses": {
                            "version": 1,
                            "profile": self.plaintext.expect("plaintext summary contract").profile(),
                            "itemId": item_id,
                            "summaryPartLengths": summary_part_lengths,
                        }
                    }),
                }),
            },
            Event::ToolInputStarted { id, name } => ModelEvent::ToolInputStarted {
                id,
                name: super::request::local_name(&name).into(),
                provider_executed: false,
            },
            Event::ToolInputDelta { id, text } => ModelEvent::ToolInputDelta { id, text },
            Event::ToolInputFinished { id } => ModelEvent::ToolInputFinished { id },
            Event::ToolCall {
                id,
                name,
                input,
                provider_executed,
                metadata,
            } => {
                let mut options = item_options(metadata);
                let input = match input {
                    wire::ToolInput::Function(input) => ToolInput::from_json(input),
                    wire::ToolInput::Custom(input) => {
                        options["openai"]["toolKind"] = json!("custom");
                        ToolInput::Json(json!(input))
                    }
                };
                ModelEvent::ToolCall(ModelToolCall {
                    id,
                    name: if provider_executed {
                        name
                    } else {
                        super::request::local_name(&name).into()
                    },
                    input,
                    provider_executed,
                    provider_options: Some(options),
                })
            }
            Event::ToolResult {
                id,
                name,
                action,
                is_error,
                metadata,
            } => ModelEvent::ProviderToolResult {
                id,
                name,
                output: json!({"action": action}),
                is_error,
                provider_options: Some(item_options(metadata)),
            },
            Event::Citation(citation) => ModelEvent::Source(ModelSource::Url {
                id: citation.id,
                url: citation.url,
                title: citation.title,
                provider_options: Some(json!({"openai": {
                    "startIndex": citation.start_index,
                    "endIndex": citation.end_index,
                }})),
            }),
            Event::Finished {
                reason,
                usage,
                response_id,
            } => ModelEvent::Finished {
                reason: match reason {
                    Stop::Stop => ModelFinishReason::Stop,
                    Stop::Length => ModelFinishReason::Length,
                    Stop::ToolCalls => ModelFinishReason::ToolCalls,
                    _ => unreachable!("Responses decoder finish reason"),
                },
                usage: ModelUsage {
                    input_tokens: usage.input,
                    output_tokens: usage.output,
                    cache_read_tokens: usage.cache_read,
                    cache_write_tokens: usage.cache_write,
                    reasoning_tokens: usage.reasoning,
                },
                provider_options: response_id.map(|id| json!({"openai": {"responseId": id}})),
            },
        }
    }
}

fn item_options(metadata: ItemMetadata) -> Value {
    let mut options = json!({"openai": {"itemId": metadata.id}});
    if let Some(replay) = metadata.replay {
        options["openai"]["responsesReplay"] = json!(replay);
    }
    if let Some(encrypted) = metadata.encrypted_content {
        options["openai"]["reasoningEncryptedContent"] = json!(encrypted);
    }
    options
}
