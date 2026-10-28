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

use super::{
    response::{self, Envelope, ToolDelta, Usage},
    tools::Tracker,
};
use crate::{
    Error, Result,
    output::{Event, Finish, ProviderError, ReasoningField, Stop, TextKind},
    sse,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashSet;

#[derive(Default, PartialEq)]
enum Phase {
    #[default]
    Receiving,
    TransportEnded,
    Finished,
}
/// One lane owns prose lifecycle; reasoning and visible text cannot be active
/// simultaneously. Tool calls have their own identities and may overlap prose.
#[derive(Default)]
struct Prose(Option<TextKind>);
impl Prose {
    fn id(kind: TextKind) -> &'static str {
        match kind {
            TextKind::Text => "txt-0",
            TextKind::Reasoning => "reasoning-0",
        }
    }
    fn close(&mut self, events: &mut Vec<Event>) {
        if let Some(kind) = self.0.take() {
            events.push(Event::TextEnd {
                id: Self::id(kind).into(),
                kind,
                citations: vec![],
                extensions: None,
            });
        }
    }
    fn append(
        &mut self,
        kind: TextKind,
        text: String,
        reasoning_field: Option<ReasoningField>,
        events: &mut Vec<Event>,
    ) {
        if text.is_empty() && reasoning_field.is_none() {
            return;
        }
        if self.0 != Some(kind) {
            self.close(events);
            self.0 = Some(kind);
            events.push(Event::TextStart {
                id: Self::id(kind).into(),
                kind,
                extensions: None,
            });
        }
        events.push(Event::TextDelta {
            reasoning_field,
            id: Self::id(kind).into(),
            kind,
            text,
            extensions: None,
        });
    }
}
#[derive(Deserialize)]
struct ErrorBody {
    error: ErrorDetail,
}
#[derive(Deserialize, serde::Serialize)]
struct ErrorDetail {
    message: String,
    #[serde(
        rename = "type",
        default,
        skip_serializing_if = "crate::Field::is_missing"
    )]
    kind: crate::Field<Value>,
    #[serde(default, skip_serializing_if = "crate::Field::is_missing")]
    param: crate::Field<Value>,
    #[serde(default, skip_serializing_if = "crate::Field::is_missing")]
    code: crate::Field<Value>,
}
/// Transport-independent Chat Completions decoding. Every incoming record is
/// parsed here, including error frames; hosts receive only native events.
pub struct Stream {
    decoder: sse::Decoder,
    namespace: String,
    raw: bool,
    observe_reasoning: bool,
    phase: Phase,
    metadata_emitted: bool,
    prose: Prose,
    finish: Option<(Stop, Option<String>)>,
    usage: Option<(Usage, Value)>,
    pending: Vec<(f64, ToolDelta)>,
    forwarded: HashSet<String>,
    tools: Tracker,
}
impl Stream {
    pub fn new(namespace: String) -> Self {
        Self {
            decoder: Default::default(),
            namespace,
            raw: false,
            observe_reasoning: false,
            phase: Phase::Receiving,
            metadata_emitted: false,
            prose: Prose::default(),
            finish: None,
            usage: None,
            pending: vec![],
            forwarded: HashSet::new(),
            tools: Tracker::default(),
        }
    }
    /// Preserve the carrier and explicit empty reasoning fields for replay.
    pub fn with_reasoning_observations(mut self, enabled: bool) -> Self {
        self.observe_reasoning = enabled;
        self
    }
    pub fn with_raw_records(mut self, enabled: bool) -> Self {
        self.raw = enabled;
        self
    }
    pub fn terminal(&self) -> bool {
        self.phase != Phase::Receiving
    }
    pub fn push(
        &mut self,
        bytes: &[u8],
        generate_id: &mut dyn FnMut() -> String,
    ) -> Result<Vec<Event>> {
        let mut events = vec![];
        if self.terminal() {
            return Ok(events);
        }
        for record in self.decoder.push(bytes)? {
            if record == "[DONE]" {
                self.phase = Phase::TransportEnded;
                break;
            }
            let raw: Value = match serde_json::from_str(&record) {
                Ok(value) => value,
                Err(error) => {
                    if self.raw {
                        events.push(Event::Raw(json!(record)));
                    }
                    self.finish = Some((Stop::Error, None));
                    events.push(Event::Error(Error::json(&record, error)));
                    continue;
                }
            };
            if self.raw {
                events.push(Event::Raw(raw.clone()));
            }
            // A normal chunk wins if a provider includes an unrelated error
            // extension. Otherwise a complete error envelope is a protocol event.
            let envelope = match Envelope::parse(&raw, true) {
                Ok(value) => value,
                Err(error) => {
                    self.finish = Some((Stop::Error, None));
                    if let Ok(error) = serde_json::from_value::<ErrorBody>(raw.clone()) {
                        let data =
                            serde_json::to_value(&error.error).expect("error fields are JSON");
                        events.push(Event::ProviderError(ProviderError {
                            message: Some(error.error.message),
                            kind: data["type"].as_str().map(str::to_owned),
                            code: data.get("code").cloned(),
                            status: None,
                            retryable: None,
                            data,
                        }));
                    } else {
                        events.push(Event::Error(error));
                    }
                    continue;
                }
            };
            let timestamp = envelope.timestamp();
            if !self.metadata_emitted
                && (timestamp.is_some()
                    || envelope.id.as_ref().is_some_and(|v| !v.is_empty())
                    || envelope.model.as_ref().is_some_and(|v| !v.is_empty()))
            {
                events.push(Event::Response {
                    id: envelope.id,
                    model: envelope.model,
                    created_at_unix_seconds: timestamp,
                });
                self.metadata_emitted = true;
            }
            if let Some(usage) = envelope.usage {
                self.usage = Some((usage, raw["usage"].clone()));
            }

            let Some(choice) = envelope.choices.into_iter().next() else {
                continue;
            };
            if let Some(reason) = choice.finish_reason {
                self.finish = Some((response::stop(Some(&reason)), Some(reason)));
            }
            let Some(delta) = choice.delta else {
                continue;
            };
            let reasoning = delta
                .reasoning_content
                .map(|text| (ReasoningField::Content, text))
                .or_else(|| {
                    delta
                        .reasoning
                        .map(|text| (ReasoningField::Reasoning, text))
                });
            if let Some((field, text)) = reasoning {
                self.prose.append(
                    TextKind::Reasoning,
                    text,
                    self.observe_reasoning.then_some(field),
                    &mut events,
                );
            }
            for (kind, text) in delta.content.into_iter().flat_map(|v| v.text()) {
                self.prose.append(kind, text, None, &mut events);
            }
            if delta.tool_calls.as_ref().is_some_and(|v| !v.is_empty())
                && self.prose.0 == Some(TextKind::Reasoning)
            {
                self.prose.close(&mut events);
            }
            for delta in delta.tool_calls.into_iter().flatten() {
                self.tool(delta, generate_id, &mut events)?;
            }
        }
        Ok(events)
    }
    fn tool(
        &mut self,
        delta: ToolDelta,
        generate_id: &mut dyn FnMut() -> String,
        events: &mut Vec<Event>,
    ) -> Result<()> {
        let Some(index) = delta
            .index
            .filter(|i| !self.forwarded.contains(&i.to_string()))
        else {
            events.extend(self.tools.push(&delta, &self.namespace, generate_id)?);
            return Ok(());
        };
        let position = if let Some(p) = self.pending.iter().position(|(i, _)| *i == index) {
            p
        } else {
            self.pending.push((
                index,
                ToolDelta {
                    index: Some(index),
                    ..Default::default()
                },
            ));
            self.pending.len() - 1
        };
        let pending = &mut self.pending[position].1;
        if pending.id.is_none() {
            pending.id = delta.id;
        }
        if pending.extra_content.is_none() {
            pending.extra_content = delta.extra_content;
        }
        pending
            .function
            .arguments
            .get_or_insert_with(String::new)
            .push_str(delta.function.arguments.as_deref().unwrap_or(""));
        if delta.function.name.is_some() {
            pending.function.name = delta.function.name;
            let (_, pending) = self.pending.remove(position);
            events.extend(self.tools.push(&pending, &self.namespace, generate_id)?);
            self.forwarded.insert(index.to_string());
        }
        Ok(())
    }
    pub fn finish(&mut self, generate_id: &mut dyn FnMut() -> String) -> Result<Vec<Event>> {
        if self.phase == Phase::Finished {
            return Ok(vec![]);
        }
        self.phase = Phase::Finished;
        let mut events = vec![];
        self.prose.close(&mut events);
        for (_, pending) in self.pending.drain(..) {
            events.extend(self.tools.push(&pending, &self.namespace, generate_id)?);
        }
        events.extend(self.tools.finish());
        let (reason, raw_reason) = self.finish.take().unwrap_or_else(|| {
            events.push(Event::Error(Error::invalid(
                "Response stream ended without a finish reason.",
                Value::Null,
            )));
            (Stop::Error, None)
        });
        events.push(Event::Finish(Finish {
            reason,
            raw_reason,
            extensions: response::extensions(
                self.usage.as_ref().map(|(usage, _)| usage),
                &self.namespace,
            ),
            usage: self.usage.take().map(|(usage, raw)| usage.normalized(raw)),
        }));
        Ok(events)
    }
}
