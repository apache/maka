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

use super::{error::Evidence, http::failure};
use crate::ModelError;
use maka_agent_facts::model::{
    self, ModelEvent, ModelFinishReason, ModelToolCall, ModelUsage, ToolInput,
};
use maka_provider_protocol::{
    input::Extensions,
    output::{Event, Source, Stop, TextKind},
};
use serde_json::Value;
use std::collections::HashMap;

pub(super) struct Events {
    pub evidence: Evidence,
    pub finished: bool,
    pub anthropic: bool,
    sequence: u64,
    open: HashMap<String, (String, TextKind)>,
    tools: HashMap<String, Option<Value>>,
}
impl Events {
    pub fn new(anthropic: bool) -> Self {
        Self {
            evidence: Evidence::default(),
            finished: false,
            anthropic,
            sequence: 0,
            open: HashMap::new(),
            tools: HashMap::new(),
        }
    }
    pub fn push(&mut self, event: Event) -> Result<Option<ModelEvent>, ModelError> {
        if matches!(&event, Event::Custom { kind, .. } if kind == "anthropic.message_start") {
            return Ok(None);
        }
        if self.finished {
            return Err(ModelError::Adapter("event after model finish".into()));
        }
        if matches!(&event, Event::Finish(finish) if finish.reason == Stop::Interrupted) {
            return Err(self.evidence.interrupted(
                crate::ProviderFailureReason::StreamTruncated,
                "model stream ended without finish",
            ));
        }
        let extension = match &event {
            Event::TextStart { extensions, .. }
            | Event::TextDelta { extensions, .. }
            | Event::TextEnd { extensions, .. }
            | Event::ToolStart { extensions, .. }
            | Event::Custom { extensions, .. } => extensions,
            Event::ToolCall(call) => &call.extensions,
            Event::ToolResult(result) => &result.extensions,
            Event::Finish(finish) => &finish.extensions,
            Event::Source(
                Source::Url { extensions, .. }
                | Source::Document { extensions, .. }
                | Source::DeferredDocument { extensions, .. },
            ) => extensions,
            _ => &None,
        };
        let has_metadata = extension.as_ref().is_some_and(|v| !v.is_empty());
        if has_metadata
            || matches!(
                &event,
                Event::Finish(_)
                    | Event::ToolResult(_)
                    | Event::ToolStart {
                        provider_executed: true,
                        ..
                    }
            )
            || matches!(&event, Event::ToolCall(call) if call.provider_executed)
        {
            self.evidence.unsafe_replay = true;
        }
        if !matches!(
            event,
            Event::Raw(_) | Event::Response { .. } | Event::Error(_) | Event::ProviderError(_)
        ) || has_metadata
        {
            self.evidence.observed = true;
        }
        let event = match event {
            Event::Raw(_) => return Ok(None),
            Event::Response {
                id,
                model,
                created_at_unix_seconds,
            } => ModelEvent::ResponseMetadata {
                id,
                model,
                timestamp: created_at_unix_seconds
                    .and_then(|seconds| {
                        jiff::Timestamp::from_millisecond((seconds * 1000.0) as i64).ok()
                    })
                    .map(|time| format!("{time:.3}")),
            },
            Event::TextStart {
                id,
                kind,
                extensions,
            } => {
                let canonical = format!("part-{}", self.sequence);
                self.sequence += 1;
                if self.open.insert(id, (canonical.clone(), kind)).is_some() {
                    return Err(ModelError::Adapter("duplicate open text part".into()));
                }
                ModelEvent::PartStarted {
                    id: canonical,
                    text_kind: match kind {
                        TextKind::Text => model::TextKind::Text,
                        TextKind::Reasoning => model::TextKind::Thinking,
                    },
                    provider_options: options(extensions),
                }
            }
            Event::TextDelta {
                id,
                kind,
                text,
                extensions,
                reasoning_field,
            } => {
                let canonical = self.part(&id, kind)?;
                let mut provider_options = options(extensions);
                if let Some(field) = reasoning_field {
                    model::merge_provider_options(
                        &mut provider_options,
                        Some(
                            serde_json::json!({"maka":{"openAiChatReasoningField":field.as_str()}}),
                        ),
                    );
                    self.evidence.unsafe_replay = true;
                }
                ModelEvent::PartDelta {
                    id: canonical,
                    text,
                    provider_options,
                }
            }
            Event::TextEnd {
                id,
                kind,
                extensions,
                ..
            } => {
                let canonical = self.part(&id, kind)?;
                self.open.remove(&id);
                ModelEvent::PartFinished {
                    id: canonical,
                    provider_options: options(extensions),
                }
            }
            Event::ToolStart {
                id,
                name,
                provider_executed,
                extensions,
                ..
            } => {
                if self.tools.insert(id.clone(), options(extensions)).is_some() {
                    return Err(ModelError::Adapter("duplicate tool input".into()));
                }
                ModelEvent::ToolInputStarted {
                    id,
                    name,
                    provider_executed,
                }
            }
            Event::ToolDelta { id, text } => {
                if !self.tools.contains_key(&id) {
                    return Err(ModelError::Adapter("unknown tool input".into()));
                }
                ModelEvent::ToolInputDelta { id, text }
            }
            Event::ToolEnd { id } => {
                if !self.tools.contains_key(&id) {
                    return Err(ModelError::Adapter("unknown tool input".into()));
                }
                ModelEvent::ToolInputFinished { id }
            }
            Event::ToolCall(call) => {
                let mut provider_options = self.tools.remove(&call.id).flatten();
                model::merge_provider_options(&mut provider_options, options(call.extensions));
                ModelEvent::ToolCall(ModelToolCall {
                    id: call.id,
                    name: call.name,
                    input: ToolInput::from_json(call.input),
                    provider_options,
                    provider_executed: call.provider_executed,
                })
            }
            Event::ToolResult(result) => ModelEvent::ProviderToolResult {
                id: result.id,
                name: result.name,
                output: result.value,
                is_error: result.is_error,
                provider_options: options(result.extensions),
            },
            Event::Source(source) => ModelEvent::Source(match source {
                Source::DeferredDocument { .. } => {
                    return Err(ModelError::Adapter(
                        "deferred citation document reached the owned output boundary".into(),
                    ));
                }
                Source::Url {
                    id,
                    url,
                    title,
                    extensions,
                } => model::ModelSource::Url {
                    id,
                    url,
                    title,
                    provider_options: options(extensions),
                },
                Source::Document {
                    id,
                    media_type,
                    title,
                    filename,
                    extensions,
                } => model::ModelSource::Document {
                    id,
                    media_type,
                    title,
                    filename,
                    provider_options: options(extensions),
                },
            }),
            Event::Finish(finish) => {
                if !self.open.is_empty() || !self.tools.is_empty() {
                    return Err(ModelError::Adapter(
                        "finish with incomplete model parts".into(),
                    ));
                }
                let reason = match finish.reason {
                    Stop::Stop => ModelFinishReason::Stop,
                    Stop::ToolCalls => ModelFinishReason::ToolCalls,
                    Stop::Length => ModelFinishReason::Length,
                    Stop::Interrupted => {
                        return Err(self.evidence.interrupted(
                            crate::ProviderFailureReason::StreamTruncated,
                            "model stream ended without finish",
                        ));
                    }
                    other => {
                        return Err(ModelError::Adapter(format!(
                            "model did not complete: {other:?}"
                        )));
                    }
                };
                let usage = finish.usage.unwrap_or_default();
                self.finished = true;
                ModelEvent::Finished {
                    reason,
                    usage: ModelUsage {
                        input_tokens: usage.input,
                        output_tokens: usage.output,
                        cache_read_tokens: usage.cache_read,
                        cache_write_tokens: usage.cache_write,
                        reasoning_tokens: usage.reasoning,
                    },
                    provider_options: options(finish.extensions),
                }
            }
            Event::Error(maka_provider_protocol::Error::InvalidResponse { message, .. })
                if message == "Response stream ended without a finish reason." =>
            {
                return Err(self.evidence.interrupted(
                    crate::ProviderFailureReason::StreamTruncated,
                    "model stream ended without finish",
                ));
            }
            Event::Error(error) => return Err(failure(error)),
            Event::ProviderError(error) => {
                return Err(self.evidence.provider(error, self.anthropic, None));
            }
            Event::Custom { kind, .. } => {
                return Err(ModelError::Adapter(format!(
                    "unsupported provider event: {kind}"
                )));
            }
        };
        Ok(Some(event))
    }
    fn part(&self, id: &str, kind: TextKind) -> Result<String, ModelError> {
        self.open
            .get(id)
            .filter(|(_, current)| *current == kind)
            .map(|(id, _)| id.clone())
            .ok_or_else(|| ModelError::Adapter("unknown or mismatched text part".into()))
    }
}
fn options(extensions: Extensions) -> Option<Value> {
    extensions.map(|v| Value::Object(v.into_iter().collect()))
}
