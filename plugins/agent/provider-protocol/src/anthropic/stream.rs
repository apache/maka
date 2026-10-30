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

//! Incremental Messages decoding. Message lifecycle, indexed content state and
//! EOF accounting are independent: one HTTP body may contain several messages.
use super::{
    OutputTokensDetails, Usage, UsageIteration,
    citations::{Citation, metadata},
    response::{
        self,
        wire::{self, Block, Chunk, Delta},
    },
};
use crate::{
    Error, Result,
    output::{self, Event, Part, TextKind},
    sse,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Debug, Default)]
enum Lifecycle {
    #[default]
    Idle,
    Open(Option<String>),
    Invalid,
}
enum Active {
    Text(Vec<Citation>),
    Reasoning { signed: bool },
    Tool(PendingTool),
}
struct PendingTool {
    call: output::ToolCall,
    input: String,
    first_delta: bool,
    prefix: Option<&'static str>,
    member: Option<String>,
}
#[derive(Deserialize)]
struct UsagePatch {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
    output_tokens_details: Option<OutputTokensDetails>,
    iterations: Option<Vec<UsageIteration>>,
}
/// Validated wire record, separate from applying it to a live message stream.
/// This permits validation without manufacturing missing tool-call history.
pub struct Frame {
    chunk: Chunk,
    raw: Value,
}
impl Frame {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let raw: Value = serde_json::from_slice(bytes)
            .map_err(|e| Error::json(&String::from_utf8_lossy(bytes), e))?;
        Self::from_value(raw)
    }
    fn from_value(raw: Value) -> Result<Self> {
        let chunk: Chunk = parse(&raw)?;
        let valid = match &chunk {
            Chunk::ContentBlockStart { content_block, .. } => {
                wire::validate_block(content_block, wire::Phase::Start)
            }
            Chunk::MessageStart { message } => {
                let usage: UsagePatch = parse(&message.usage)?;
                usage.input_tokens.is_some()
                    && message.content.as_ref().is_none_or(|blocks| {
                        blocks
                            .iter()
                            .all(|block| matches!(block, Block::ToolUse { .. }))
                    })
            }
            Chunk::MessageDelta { usage, .. } => {
                parse::<UsagePatch>(usage)?.output_tokens.is_some()
            }
            _ => true,
        };
        if !valid {
            return Err(Error::invalid("Invalid Anthropic stream record.", raw));
        }
        Ok(Self { chunk, raw })
    }
}
pub struct Stream {
    frames: sse::Decoder,
    decoder: response::Decoder,
    lifecycle: Lifecycle,
    blocks: BTreeMap<usize, Active>,
    usage: Usage,
    raw_usage: Value,
    end: wire::End,
    transformations: Option<Vec<wire::Transformation>>,
    context: Option<wire::ContextManagement>,
    pending_web_citations: Vec<Citation>,
    has_output: bool,
    has_error: bool,
    last_finish: Option<output::Finish>,
    eof: bool,
    transport_done: bool,
    include_raw: bool,
}
impl Stream {
    pub fn new(options: response::Options) -> Self {
        Self {
            frames: sse::Decoder::default(),
            decoder: response::Decoder::new(options),
            lifecycle: Lifecycle::Idle,
            blocks: BTreeMap::new(),
            usage: Usage::default(),
            raw_usage: json!({}),
            end: wire::End::default(),
            transformations: None,
            context: None,
            pending_web_citations: Vec::new(),
            has_output: false,
            has_error: false,
            last_finish: None,
            eof: false,
            transport_done: false,
            include_raw: false,
        }
    }
    pub fn with_raw_records(mut self, enabled: bool) -> Self {
        self.include_raw = enabled;
        self
    }
    /// Framing failures reject the transport; malformed records become events.
    /// The host can observe each raw record before its corresponding events.
    pub fn push(
        &mut self,
        bytes: &[u8],
        next_id: &mut dyn FnMut() -> String,
        mut record: impl FnMut(&Value),
    ) -> Result<Vec<Event>> {
        let mut events = Vec::new();
        if self.eof {
            return Err(Error::invalid(
                "Bytes received after stream EOF.",
                Value::Null,
            ));
        }
        if self.transport_done {
            return Ok(events);
        }
        for frame in self.frames.push(bytes)? {
            if frame == "[DONE]" {
                self.transport_done = true;
                break;
            }
            if matches!(self.lifecycle, Lifecycle::Invalid) {
                break;
            }
            match serde_json::from_str::<Value>(&frame) {
                Ok(raw) => {
                    record(&raw);
                    events.extend(self.value(raw, next_id));
                }
                Err(error) => {
                    self.has_error = true;
                    events.push(Event::Error(Error::json(&frame, error)));
                }
            }
        }
        Ok(events)
    }
    pub fn value(&mut self, raw: Value, next_id: &mut dyn FnMut() -> String) -> Vec<Event> {
        if self.eof || matches!(self.lifecycle, Lifecycle::Invalid) {
            return Vec::new();
        }
        let raw_event = self.include_raw.then(|| Event::Raw(raw.clone()));
        let result =
            Frame::from_value(raw).and_then(|frame| self.apply(frame.chunk, &frame.raw, next_id));
        let mut events = match result {
            Ok(events) => events,
            Err(error) => vec![Event::Error(error)],
        };
        if let Some(raw) = raw_event {
            events.insert(0, raw);
        }
        for event in &events {
            match event {
                Event::Response { .. } | Event::Finish(_) => self.has_output = false,
                Event::TextDelta { text, .. } | Event::ToolDelta { text, .. }
                    if !text.is_empty() =>
                {
                    self.has_output = true
                }
                Event::ToolCall(_) => self.has_output = true,
                Event::Error(_) | Event::ProviderError(_) => self.has_error = true,
                _ => {}
            }
        }
        events
    }
    pub fn finish(&mut self) -> Vec<Event> {
        if std::mem::replace(&mut self.eof, true)
            || !self.has_output
            || self.has_error
            || matches!(self.lifecycle, Lifecycle::Invalid)
        {
            return Vec::new();
        }
        let mut finish = self.last_finish.clone().unwrap_or(output::Finish {
            reason: output::Stop::Interrupted,
            raw_reason: None,
            usage: None,
            extensions: None,
        });
        finish.reason = output::Stop::Interrupted;
        finish.raw_reason = None;
        vec![Event::Finish(finish)]
    }
    fn apply(
        &mut self,
        chunk: Chunk,
        raw: &Value,
        next_id: &mut dyn FnMut() -> String,
    ) -> Result<Vec<Event>> {
        let mut events = Vec::new();
        match chunk {
            Chunk::Ping => {}
            Chunk::MessageStart { message } => {
                if let Lifecycle::Open(id) = &self.lifecycle {
                    if *id == message.id {
                        return Ok(events);
                    }
                    let error = Error::invalid(
                        format!(
                            "Received message_start for message {} while message {} is still open.",
                            json!(message.id),
                            json!(id)
                        ),
                        raw.clone(),
                    );
                    self.lifecycle = Lifecycle::Invalid;
                    return Err(error);
                }
                let patch: UsagePatch = parse(&message.usage)?;
                self.usage.input_tokens = patch.input_tokens.ok_or_else(|| {
                    Error::invalid("message_start requires input_tokens.", raw.clone())
                })?;
                self.usage.cache_creation_input_tokens =
                    Some(patch.cache_creation_input_tokens.unwrap_or(0));
                self.usage.cache_read_input_tokens =
                    Some(patch.cache_read_input_tokens.unwrap_or(0));
                self.raw_usage = message.usage;
                self.lifecycle = Lifecycle::Open(message.id.clone());
                if let Some(reason) = message.stop_reason {
                    self.end.stop_reason = Some(reason);
                }
                if message.input_transformations.is_some() {
                    self.transformations = message.input_transformations;
                }
                if message.container.is_some() {
                    self.end.container = message.container;
                }
                events.push(Event::Response {
                    created_at_unix_seconds: None,
                    id: message.id.clone(),
                    model: message.model.clone(),
                });
                events.push(Event::Custom {
                    kind: "anthropic.message_start".into(),
                    extensions: metadata(
                        json!({"id":message.id,"model":message.model,"usage":self.raw_usage}),
                    ),
                });
                for block in message.content.unwrap_or_default() {
                    if let Block::ToolUse {
                        id,
                        name,
                        input,
                        caller,
                        ..
                    } = block
                    {
                        let input = if input.is_null() { json!({}) } else { input };
                        if let Some(call) =
                            self.decoder.tool_call(id, name, input, caller, None, false)
                        {
                            events.push(tool_start(&call));
                            events.push(Event::ToolDelta {
                                id: call.id.clone(),
                                text: call.input.clone(),
                            });
                            events.push(Event::ToolEnd {
                                id: call.id.clone(),
                            });
                            events.push(Event::ToolCall(call));
                        }
                    }
                }
            }
            Chunk::MessageDelta {
                delta,
                usage,
                input_transformations,
                context_management,
            } => {
                let patch: UsagePatch = parse(&usage)?;
                self.usage.output_tokens = patch.output_tokens.ok_or_else(|| {
                    Error::invalid("message_delta requires output_tokens.", raw.clone())
                })?;
                if let Some(value) = patch.input_tokens {
                    self.usage.input_tokens = value;
                }
                if patch.cache_creation_input_tokens.is_some() {
                    self.usage.cache_creation_input_tokens = patch.cache_creation_input_tokens;
                }
                if patch.cache_read_input_tokens.is_some() {
                    self.usage.cache_read_input_tokens = patch.cache_read_input_tokens;
                }
                if patch.output_tokens_details.is_some() {
                    self.usage.output_tokens_details = patch.output_tokens_details;
                }
                if patch.iterations.is_some() {
                    self.usage.iterations = patch.iterations;
                }
                self.raw_usage
                    .as_object_mut()
                    .expect("validated usage is an object")
                    .extend(
                        usage
                            .as_object()
                            .expect("validated usage is an object")
                            .clone(),
                    );
                let safeguards = delta
                    .safeguard_results
                    .clone()
                    .or_else(|| self.end.safeguard_results.take());
                self.end = delta;
                self.end.safeguard_results = safeguards;
                if input_transformations.is_some() {
                    self.transformations = input_transformations;
                }
                if context_management.is_some() {
                    self.context = context_management;
                }
            }
            Chunk::MessageStop => {
                self.lifecycle = Lifecycle::Idle;
                if !self.decoder.has_search_results {
                    for citation in self.pending_web_citations.drain(..) {
                        if let Some(source) =
                            citation.source(&self.decoder.options.documents, next_id)
                        {
                            events.push(Event::Source(source));
                        }
                    }
                }
                self.pending_web_citations.clear();
                let finish = response::finish::from_usage(
                    &self.usage,
                    self.raw_usage.clone(),
                    self.end.clone(),
                    self.transformations.clone(),
                    self.context.clone(),
                    self.decoder.json_answer,
                    self.decoder.options.metadata_namespace.as_deref(),
                )?;
                self.last_finish = Some(finish.clone());
                events.push(Event::Finish(finish));
            }
            Chunk::ContentBlockStart {
                index,
                content_block,
            } => events.extend(self.start(index, content_block, next_id)?),
            Chunk::ContentBlockDelta { index, delta } => {
                events.extend(self.delta(index, delta, next_id)?)
            }
            Chunk::ContentBlockStop { index } => events.extend(self.stop(index)),
            Chunk::Error { error } => {
                events.push(Event::ProviderError(output::ProviderError {
                    message: Some(error.message),
                    kind: Some(error.r#type),
                    code: error.code.map(|v| json!(v)),
                    status: error.status,
                    retryable: error.retryable,
                    data: raw["error"].get("data").cloned().unwrap_or_else(|| {
                        let mut data = raw["error"].clone();
                        data.as_object_mut().unwrap().retain(|key, _| {
                            ["type", "message", "code", "statusCode", "isRetryable"]
                                .contains(&key.as_str())
                        });
                        data
                    }),
                }));
            }
        }
        Ok(events)
    }
    fn start(
        &mut self,
        index: usize,
        block: Block,
        next_id: &mut dyn FnMut() -> String,
    ) -> Result<Vec<Event>> {
        let id = index.to_string();
        let mut events = Vec::new();
        match block {
            Block::Text { .. } if !self.decoder.options.json_tool => {
                self.blocks.insert(index, Active::Text(Vec::new()));
                events.push(Event::TextStart {
                    id,
                    kind: TextKind::Text,
                    extensions: None,
                });
            }
            Block::Text { .. } => {}
            Block::Thinking { .. } => {
                self.blocks
                    .insert(index, Active::Reasoning { signed: true });
                events.push(Event::TextStart {
                    id,
                    kind: TextKind::Reasoning,
                    extensions: None,
                });
            }
            Block::RedactedThinking { data } => {
                self.blocks
                    .insert(index, Active::Reasoning { signed: false });
                events.push(Event::TextStart {
                    id,
                    kind: TextKind::Reasoning,
                    extensions: metadata(json!({"redactedData":data})),
                });
            }
            Block::Compaction { content, signature } => {
                let emit_content = signature.is_some();
                self.blocks.insert(index, Active::Text(Vec::new()));
                events.push(Event::TextStart {
                    id: id.clone(),
                    kind: TextKind::Text,
                    extensions: response::compaction_metadata(signature),
                });
                if let Some(text) = content.filter(|s| emit_content && !s.is_empty()) {
                    events.push(Event::TextDelta {
                        reasoning_field: None,
                        id,
                        kind: TextKind::Text,
                        text,
                        extensions: None,
                    });
                }
            }
            Block::ToolUse { name, .. } if self.decoder.options.json_tool && name == "json" => {
                self.decoder.json_answer = true;
                self.blocks.insert(index, Active::Text(Vec::new()));
                events.push(Event::TextStart {
                    id,
                    kind: TextKind::Text,
                    extensions: None,
                });
            }
            Block::ToolUse {
                id,
                name,
                input,
                caller,
                toolset_name,
            } => {
                let member = toolset_name.as_ref().map(|_| name.clone());
                let buffered = input_string(&input);
                if let Some(mut call) =
                    self.decoder
                        .tool_call(id, name, json!({}), caller, toolset_name, false)
                {
                    call.input.clear();
                    events.push(tool_start(&call));
                    self.blocks.insert(
                        index,
                        Active::Tool(PendingTool {
                            call,
                            input: buffered,
                            first_delta: false,
                            prefix: None,
                            member,
                        }),
                    );
                }
            }
            Block::ServerToolUse {
                id,
                name,
                input,
                caller,
            } => {
                let mut input = input_string(&Value::Object(input.unwrap_or_default()));
                let prefix = match name.as_str() {
                    "code_execution" => Some("programmatic-tool-call"),
                    "bash_code_execution" => Some("bash_code_execution"),
                    "text_editor_code_execution" => Some("text_editor_code_execution"),
                    _ => None,
                };
                if name.starts_with("tool_search_tool_") {
                    input.clear();
                }
                if name == "advisor" {
                    input = "{}".into();
                }
                if let Some(mut call) =
                    self.decoder
                        .tool_call(id, name, json!({}), caller, None, true)
                {
                    call.input.clear();
                    events.push(tool_start(&call));
                    let first_delta = input.is_empty();
                    self.blocks.insert(
                        index,
                        Active::Tool(PendingTool {
                            call,
                            input,
                            first_delta,
                            prefix,
                            member: None,
                        }),
                    );
                }
            }
            block => {
                for part in self.decoder.block(block, next_id)? {
                    match part {
                        Part::ToolCall(call) => events.push(Event::ToolCall(call)),
                        Part::ToolResult(result) => events.push(Event::ToolResult(result)),
                        Part::Source(source) => events.push(Event::Source(source)),
                        Part::Custom { kind, extensions } => {
                            events.push(Event::Custom { kind, extensions })
                        }
                        Part::Text { .. } => {
                            unreachable!("text blocks are handled by indexed state")
                        }
                    }
                }
            }
        }
        Ok(events)
    }
    fn delta(
        &mut self,
        index: usize,
        delta: Delta,
        next_id: &mut dyn FnMut() -> String,
    ) -> Result<Vec<Event>> {
        let id = index.to_string();
        let mut events = Vec::new();
        match delta {
            Delta::Text { text } if !self.decoder.options.json_tool => {
                events.push(Event::TextDelta {
                    reasoning_field: None,
                    id,
                    kind: TextKind::Text,
                    text,
                    extensions: None,
                })
            }
            Delta::Text { .. } => {}
            Delta::Thinking { thinking } => events.push(Event::TextDelta {
                reasoning_field: None,
                id,
                kind: TextKind::Reasoning,
                text: thinking,
                extensions: None,
            }),
            Delta::Signature { signature } => {
                if matches!(
                    self.blocks.get(&index),
                    Some(Active::Reasoning { signed: true })
                ) {
                    events.push(Event::TextDelta {
                        reasoning_field: None,
                        id,
                        kind: TextKind::Reasoning,
                        text: String::new(),
                        extensions: metadata(json!({"signature":signature})),
                    });
                }
            }
            Delta::Compaction { content } => {
                if let Some(text) = content {
                    events.push(Event::TextDelta {
                        reasoning_field: None,
                        id,
                        kind: TextKind::Text,
                        text,
                        extensions: None,
                    });
                }
            }
            Delta::InputJson { mut partial_json } => {
                if partial_json.is_empty() {
                    return Ok(events);
                }
                if self.decoder.json_answer {
                    if matches!(self.blocks.get(&index), Some(Active::Text(_))) {
                        events.push(Event::TextDelta {
                            reasoning_field: None,
                            id,
                            kind: TextKind::Text,
                            text: partial_json,
                            extensions: None,
                        });
                    }
                } else if let Some(Active::Tool(tool)) = self.blocks.get_mut(&index) {
                    if tool.member.is_none() {
                        if tool.first_delta
                            && let Some(prefix) = tool.prefix
                        {
                            // Prefix insertion preserves the provider's incremental bytes.
                            partial_json = format!(
                                "{{\"type\": \"{prefix}\",{}",
                                partial_json.get(1..).unwrap_or_default()
                            );
                        }
                        events.push(Event::ToolDelta {
                            id: tool.call.id.clone(),
                            text: partial_json.clone(),
                        });
                    }
                    tool.input.push_str(&partial_json);
                    tool.first_delta = false;
                }
            }
            Delta::Citations { citation } => {
                if let Some(Active::Text(citations)) = self.blocks.get_mut(&index) {
                    citations.push(citation.clone());
                }
                if citation.is_web_search() {
                    self.pending_web_citations.push(citation);
                } else if let Some(source) =
                    citation.source(&self.decoder.options.documents, next_id)
                {
                    events.push(Event::Source(source));
                }
            }
        }
        Ok(events)
    }
    fn stop(&mut self, index: usize) -> Vec<Event> {
        let Some(block) = self.blocks.remove(&index) else {
            return Vec::new();
        };
        let mut events = Vec::new();
        match block {
            Active::Text(citations) => {
                let extensions = (!citations.is_empty())
                    .then(|| metadata(json!({"citations":citations})))
                    .flatten();
                events.push(Event::TextEnd {
                    id: index.to_string(),
                    kind: TextKind::Text,
                    citations: citations
                        .iter()
                        .map(|c| c.attachment(&self.decoder.options.documents))
                        .collect(),
                    extensions,
                });
            }
            Active::Reasoning { .. } => events.push(Event::TextEnd {
                id: index.to_string(),
                kind: TextKind::Reasoning,
                citations: Vec::new(),
                extensions: None,
            }),
            Active::Tool(mut tool) => {
                if let Some(member) = tool.member {
                    let input = if tool.input.is_empty() {
                        "{}"
                    } else {
                        &tool.input
                    };
                    if let Ok(input) = serde_json::from_str(input) {
                        tool.input = response::member_input(&member, input).to_string();
                    }
                    events.push(Event::ToolDelta {
                        id: tool.call.id.clone(),
                        text: tool.input.clone(),
                    });
                } else if tool.prefix == Some("programmatic-tool-call")
                    && let Ok(input) = serde_json::from_str::<Value>(&tool.input)
                    && input.get("code").is_some()
                    && input.get("type").is_none()
                {
                    tool.input =
                        response::discriminated_input("programmatic-tool-call", input).to_string();
                }
                tool.call.input = if tool.input.is_empty() {
                    "{}".into()
                } else {
                    tool.input
                };
                events.push(Event::ToolEnd {
                    id: tool.call.id.clone(),
                });
                events.push(Event::ToolCall(tool.call));
            }
        }
        events
    }
}
fn parse<T: serde::de::DeserializeOwned>(value: &Value) -> Result<T> {
    serde_json::from_value(value.clone()).map_err(|e| Error::invalid(e.to_string(), value.clone()))
}
fn input_string(value: &Value) -> String {
    if value.as_object().is_some_and(|v| !v.is_empty()) {
        value.to_string()
    } else {
        String::new()
    }
}
fn tool_start(call: &output::ToolCall) -> Event {
    Event::ToolStart {
        id: call.id.clone(),
        name: call.name.clone(),
        provider_executed: call.provider_executed,
        dynamic: call.dynamic,
        extensions: None,
    }
}
