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
    EncodedFrame, EventFrames, FrameKind, StringField, TurnCompletion, WireEncoder, WireFrame,
    split_utf8_chunks, unix_timestamp,
};
use crate::plan::{Citation, FinishReason, NativeToolEvent, ToolCallSpec, TurnEvent, Usage};
use crate::protocol::RequestOptions;
use serde::Serialize;
use serde_json::{Value, json};

pub struct ResponsesEncoder {
    wire: ResponsesWire,
    created: bool,
    finished: bool,
    include_encrypted_reasoning: bool,
    active: Option<ActiveItem>,
    output: Vec<Value>,
    usage: Option<Usage>,
    failure: Option<Value>,
}

struct ResponsesWire {
    id: String,
    model: String,
    created_at: u64,
    transport: Option<StreamTransport>,
    sequence: usize,
}

#[derive(Clone, Copy)]
enum StreamTransport {
    Sse,
    WebSocket,
}

#[derive(Serialize)]
struct Sequenced<T> {
    sequence_number: usize,
    #[serde(flatten)]
    event: T,
}

#[derive(Serialize)]
struct ItemEvent<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    output_index: usize,
    item: &'a Value,
}

#[derive(Serialize)]
struct ResponseEvent<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    response: &'a Value,
}

impl ResponsesWire {
    fn frame(&mut self, event: impl Serialize, kind: FrameKind, bytes: usize) -> EncodedFrame {
        let payload = Sequenced {
            sequence_number: self.sequence,
            event,
        };
        self.sequence += 1;
        match self
            .transport
            .expect("only streaming encoders emit wire frames")
        {
            StreamTransport::Sse => EncodedFrame::new_sse(None, &payload, kind, bytes),
            StreamTransport::WebSocket => EncodedFrame::new_ws(&payload, kind, bytes),
        }
    }

    fn raw_json(&self, value: &Value) -> EncodedFrame {
        match self
            .transport
            .expect("only streaming encoders emit wire frames")
        {
            StreamTransport::Sse => EncodedFrame::new_sse(None, value, FrameKind::Lifecycle, 0),
            StreamTransport::WebSocket => EncodedFrame::new_ws(value, FrameKind::Lifecycle, 0),
        }
    }

    fn response(&self, status: &str) -> Value {
        json!({
            "id": self.id, "object": "response", "status": status,
            "model": self.model, "created_at": self.created_at, "output": [],
        })
    }

    fn item(&mut self, kind: &str, output_index: usize, item: &Value) -> EncodedFrame {
        self.frame(
            ItemEvent {
                kind,
                output_index,
                item,
            },
            FrameKind::Lifecycle,
            0,
        )
    }
}

enum ActiveItem {
    Message {
        id: String,
        content: Vec<Value>,
        part: Option<MessagePart>,
    },
    Reasoning {
        id: String,
        summary: String,
        encrypted_content: Option<String>,
    },
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PartKind {
    Text,
    Refusal,
}

impl PartKind {
    fn fragment(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Refusal => "refusal",
        }
    }

    fn part_type(self) -> &'static str {
        match self {
            Self::Text => "output_text",
            Self::Refusal => "refusal",
        }
    }

    fn delta_event(self) -> &'static str {
        match self {
            Self::Text => "response.output_text.delta",
            Self::Refusal => "response.refusal.delta",
        }
    }

    fn done_event(self) -> &'static str {
        match self {
            Self::Text => "response.output_text.done",
            Self::Refusal => "response.refusal.done",
        }
    }
}

struct MessagePart {
    kind: PartKind,
    text: String,
    annotations: Vec<Value>,
}

#[derive(Clone, Copy, Serialize)]
struct PartLocation<'a> {
    item_id: &'a str,
    output_index: usize,
    content_index: usize,
}

#[derive(Serialize)]
struct PartEvent<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    #[serde(flatten)]
    location: PartLocation<'a>,
    part: &'a Value,
}

#[derive(Serialize)]
struct PartTextEvent<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    #[serde(flatten)]
    location: PartLocation<'a>,
    #[serde(flatten)]
    text: StringField<'a>,
}

#[derive(Serialize)]
struct ToolInputEvent<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    item_id: &'a str,
    output_index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<&'a str>,
    #[serde(flatten)]
    input: StringField<'a>,
}

fn close_part(
    wire: &mut ResponsesWire,
    output_index: usize,
    item_id: &str,
    content: &mut Vec<Value>,
    part: &mut Option<MessagePart>,
    emit: &mut dyn FnMut(EncodedFrame),
) {
    let Some(part) = part.take() else {
        return;
    };
    let location = PartLocation {
        item_id,
        output_index,
        content_index: content.len(),
    };
    let mut value = json!({ "type": part.kind.part_type() });
    value[part.kind.fragment()] = Value::String(part.text);
    if part.kind == PartKind::Text {
        value["annotations"] = Value::Array(part.annotations);
    }
    if wire.transport.is_some() {
        let field = part.kind.fragment();
        let text = value[field].as_str().expect("a content part has text");
        emit(wire.frame(
            PartTextEvent {
                kind: part.kind.done_event(),
                location,
                text: StringField(field, text),
            },
            FrameKind::Lifecycle,
            0,
        ));
        emit(wire.frame(
            PartEvent {
                kind: "response.content_part.done",
                location,
                part: &value,
            },
            FrameKind::Lifecycle,
            0,
        ));
    }
    content.push(value);
}

impl ResponsesEncoder {
    pub fn new(id: String, model: String, websocket: bool, stream: bool) -> Self {
        Self::with_options(id, model, websocket, stream, &RequestOptions::default())
    }

    pub fn with_options(
        id: String,
        model: String,
        websocket: bool,
        stream: bool,
        options: &RequestOptions,
    ) -> Self {
        Self {
            wire: ResponsesWire {
                id,
                model,
                created_at: unix_timestamp(),
                transport: stream.then_some(if websocket {
                    StreamTransport::WebSocket
                } else {
                    StreamTransport::Sse
                }),
                sequence: 0,
            },
            created: false,
            finished: false,
            include_encrypted_reasoning: options
                .include
                .iter()
                .any(|item| item == "reasoning.encrypted_content"),
            active: None,
            output: Vec::new(),
            usage: None,
            failure: None,
        }
    }

    pub fn with_created_at(mut self, created_at: u64) -> Self {
        self.wire.created_at = created_at;
        self
    }

    fn ensure_created(&mut self, emit: &mut dyn FnMut(EncodedFrame)) {
        if !self.created && self.wire.transport.is_some() {
            self.created = true;
            let response = self.wire.response("in_progress");
            emit(self.wire.frame(
                ResponseEvent {
                    kind: "response.created",
                    response: &response,
                },
                FrameKind::Lifecycle,
                0,
            ));
        }
    }

    fn item_id(&self, prefix: &str) -> String {
        format!("{prefix}_{}_{}", self.wire.id, self.output.len())
    }

    fn close_active(&mut self, emit: &mut dyn FnMut(EncodedFrame)) {
        let Some(active) = self.active.take() else {
            return;
        };
        let index = self.output.len();
        let item = match active {
            ActiveItem::Message {
                id,
                mut content,
                mut part,
            } => {
                close_part(&mut self.wire, index, &id, &mut content, &mut part, emit);
                let mut item = json!({ "type": "message", "id": id, "role": "assistant", "status": "completed" });
                item["content"] = Value::Array(content);
                item
            }
            ActiveItem::Reasoning {
                id,
                summary,
                encrypted_content,
            } => {
                let mut item = json!({ "type": "reasoning", "id": id, "summary": [] });
                if !summary.is_empty() {
                    if self.wire.transport.is_some() {
                        emit(self.wire.frame(
                            json!({
                                "type": "response.reasoning_summary_text.done", "item_id": id,
                                "output_index": index, "summary_index": 0, "text": summary,
                            }),
                            FrameKind::Lifecycle,
                            0,
                        ));
                    }
                    let mut summary_part = json!({ "type": "summary_text" });
                    summary_part["text"] = Value::String(summary);
                    if self.wire.transport.is_some() {
                        emit(self.wire.frame(
                            json!({
                                "type": "response.reasoning_summary_part.done", "item_id": id,
                                "output_index": index, "summary_index": 0, "part": summary_part,
                            }),
                            FrameKind::Lifecycle,
                            0,
                        ));
                    }
                    item["summary"] = Value::Array(vec![summary_part]);
                }
                if let Some(encrypted_content) = encrypted_content {
                    item["encrypted_content"] = Value::String(encrypted_content);
                }
                item
            }
        };
        if self.wire.transport.is_some() {
            emit(self.wire.item("response.output_item.done", index, &item));
        }
        self.output.push(item);
    }

    fn begin_atomic(&mut self, prefix: &mut Vec<EncodedFrame>) -> usize {
        self.ensure_created(&mut |frame| prefix.push(frame));
        self.close_active(&mut |frame| prefix.push(frame));
        self.output.len()
    }

    fn message(
        &mut self,
        kind: PartKind,
        text: String,
        chunk_chars: usize,
        citations: Vec<Citation>,
    ) -> EventFrames<'_> {
        let mut prefix = Vec::new();
        self.ensure_created(&mut |frame| prefix.push(frame));
        if !matches!(self.active, Some(ActiveItem::Message { .. })) {
            self.close_active(&mut |frame| prefix.push(frame));
            let id = self.item_id("msg");
            if self.wire.transport.is_some() {
                prefix.push(self.wire.item("response.output_item.added", self.output.len(), &json!({
                    "type": "message", "id": id, "role": "assistant", "status": "in_progress", "content": [],
                })));
            }
            self.active = Some(ActiveItem::Message {
                id,
                content: Vec::new(),
                part: None,
            });
        }
        let Some(ActiveItem::Message { id, content, part }) = &mut self.active else {
            unreachable!()
        };
        let output_index = self.output.len();
        let wire = &mut self.wire;
        let stream = wire.transport.is_some();
        if part.as_ref().is_none_or(|part| part.kind != kind) {
            close_part(wire, output_index, id, content, part, &mut |frame| {
                prefix.push(frame)
            });
            if stream {
                let mut initial = json!({ "type": kind.part_type(), kind.fragment(): "" });
                if kind == PartKind::Text {
                    initial["annotations"] = json!([]);
                }
                prefix.push(wire.frame(
                    PartEvent {
                        kind: "response.content_part.added",
                        location: PartLocation {
                            item_id: id,
                            output_index,
                            content_index: content.len(),
                        },
                        part: &initial,
                    },
                    FrameKind::Lifecycle,
                    0,
                ));
            }
            *part = Some(MessagePart {
                kind,
                text: String::new(),
                annotations: Vec::new(),
            });
        }
        let part = part.as_mut().expect("a message part is active");
        let start = part.text.len();
        append(&mut part.text, text);
        let first_annotation = part.annotations.len();
        part.annotations
            .extend(citations.into_iter().map(|citation| {
                json!({
                    "type": "url_citation",
                    "url": citation.url, "title": citation.title.unwrap_or_default(),
                    "start_index": 0, "end_index": 0,
                })
            }));
        if !stream {
            return EventFrames::default();
        }
        let location = PartLocation {
            item_id: id,
            output_index,
            content_index: content.len(),
        };
        let mut deltas = split_utf8_chunks(&part.text[start..], chunk_chars);
        let mut annotations = part.annotations.iter().enumerate().skip(first_annotation);
        EventFrames::then(
            prefix,
            std::iter::from_fn(move || {
                if let Some(delta) = deltas.next() {
                    return Some(wire.frame(
                        PartTextEvent {
                            kind: kind.delta_event(),
                            location,
                            text: StringField("delta", delta),
                        },
                        FrameKind::SemanticDelta,
                        delta.len(),
                    ));
                }
                let (annotation_index, annotation) = annotations.next()?;
                Some(wire.frame(json!({
                "type": "response.output_text.annotation.added", "item_id": location.item_id,
                "output_index": location.output_index, "content_index": location.content_index,
                "annotation_index": annotation_index, "annotation": annotation,
            }), FrameKind::Lifecycle, 0))
            }),
        )
    }

    fn reasoning(
        &mut self,
        text: String,
        chunk_chars: usize,
        encrypted_content: Option<String>,
    ) -> EventFrames<'_> {
        let mut prefix = Vec::new();
        self.ensure_created(&mut |frame| prefix.push(frame));
        if !matches!(self.active, Some(ActiveItem::Reasoning { .. })) {
            self.close_active(&mut |frame| prefix.push(frame));
            let id = self.item_id("rs");
            if self.wire.transport.is_some() {
                prefix.push(self.wire.item(
                    "response.output_item.added",
                    self.output.len(),
                    &json!({
                        "type": "reasoning", "id": id, "summary": [],
                    }),
                ));
            }
            self.active = Some(ActiveItem::Reasoning {
                id,
                summary: String::new(),
                encrypted_content: None,
            });
        }
        let output_index = self.output.len();
        let Some(ActiveItem::Reasoning {
            id,
            summary,
            encrypted_content: stored,
        }) = &mut self.active
        else {
            unreachable!()
        };
        if self.include_encrypted_reasoning && encrypted_content.is_some() {
            *stored = encrypted_content;
        }
        let start = summary.len();
        append(summary, text);
        let wire = &mut self.wire;
        if wire.transport.is_none() {
            return EventFrames::default();
        }
        if start == 0 && !summary.is_empty() {
            prefix.push(wire.frame(
                json!({
                    "type": "response.reasoning_summary_part.added", "item_id": id,
                    "output_index": output_index, "summary_index": 0,
                    "part": { "type": "summary_text", "text": "" },
                }),
                FrameKind::Lifecycle,
                0,
            ));
        }
        EventFrames::then(
            prefix,
            split_utf8_chunks(&summary[start..], chunk_chars).map(move |delta| {
                wire.frame(
                    json!({
                        "type": "response.reasoning_summary_text.delta", "item_id": id,
                        "output_index": output_index, "summary_index": 0, "delta": delta,
                    }),
                    FrameKind::SemanticDelta,
                    delta.len(),
                )
            }),
        )
    }

    fn tool_call(&mut self, mut spec: ToolCallSpec) -> EventFrames<'_> {
        let mut prefix = Vec::new();
        let output_index = self.begin_atomic(&mut prefix);
        let id = spec
            .item_id
            .take()
            .filter(|id| !id.is_empty())
            .unwrap_or_else(|| self.item_id("fc"));
        let call_id = if spec.id.is_empty() {
            self.item_id("call")
        } else {
            std::mem::take(&mut spec.id)
        };
        let (kind, field, delta_event, done_event) = if spec.is_freeform() {
            (
                "custom_tool_call",
                "input",
                "response.custom_tool_call_input.delta",
                "response.custom_tool_call_input.done",
            )
        } else {
            (
                "function_call",
                "arguments",
                "response.function_call_arguments.delta",
                "response.function_call_arguments.done",
            )
        };
        let input = spec.take_wire_arguments();
        let wire = &mut self.wire;
        let mut item = json!({ "type": kind, "id": id, "call_id": call_id, "name": spec.name, "status": "completed" });
        if let Some(namespace) = spec.namespace {
            item["namespace"] = Value::String(namespace);
        }
        if wire.transport.is_some() {
            let mut added = item.clone();
            added["status"] = json!("in_progress");
            added[field] = json!("");
            prefix.push(wire.item("response.output_item.added", output_index, &added));
        }
        item[field] = Value::String(input);
        self.output.push(item);
        if wire.transport.is_none() {
            return EventFrames::default();
        }
        let item = &self.output[output_index];
        let input = item[field]
            .as_str()
            .expect("encoded tool input is a string");
        let mut chunks = split_utf8_chunks(input, spec.chunk_chars);
        let mut done = false;
        let mut item_done = false;
        EventFrames::then(
            prefix,
            std::iter::from_fn(move || {
                if let Some(delta) = chunks.next() {
                    return Some(wire.frame(
                        ToolInputEvent {
                            kind: delta_event,
                            item_id: &id,
                            output_index,
                            name: None,
                            input: StringField("delta", delta),
                        },
                        FrameKind::SemanticDelta,
                        delta.len(),
                    ));
                }
                if !std::mem::replace(&mut done, true) {
                    return Some(wire.frame(
                        ToolInputEvent {
                            kind: done_event,
                            item_id: &id,
                            output_index,
                            name: Some(&spec.name),
                            input: StringField(field, input),
                        },
                        FrameKind::Lifecycle,
                        0,
                    ));
                }
                if !std::mem::replace(&mut item_done, true) {
                    return Some(wire.item("response.output_item.done", output_index, item));
                }
                None
            }),
        )
    }

    fn wire_usage(usage: &Usage) -> Value {
        let reasoning = usage.reasoning_tokens.unwrap_or(0);
        let output_tokens = usage.output_tokens.max(reasoning);
        json!({
            "input_tokens": usage.input_tokens, "output_tokens": output_tokens,
            "total_tokens": usage.input_tokens.saturating_add(output_tokens),
            "input_tokens_details": { "cached_tokens": usage.cache_read_tokens.unwrap_or(0) },
            "output_tokens_details": { "reasoning_tokens": reasoning },
        })
    }
}

fn append(buffer: &mut String, text: String) {
    if buffer.is_empty() {
        *buffer = text;
    } else {
        buffer.push_str(&text);
    }
}

impl WireEncoder for ResponsesEncoder {
    fn encode_event(&mut self, event: TurnEvent) -> EventFrames<'_> {
        if self.finished {
            return EventFrames::default();
        }
        let mut prefix = Vec::new();
        match event {
            TurnEvent::Text {
                text,
                chunk_chars,
                citations,
            } => return self.message(PartKind::Text, text, chunk_chars, citations),
            TurnEvent::Refusal { text } => {
                return self.message(PartKind::Refusal, text, 0, Vec::new());
            }
            TurnEvent::Reasoning {
                text,
                chunk_chars,
                encrypted_content,
                ..
            } => return self.reasoning(text, chunk_chars, encrypted_content),
            TurnEvent::ToolCall(spec) => return self.tool_call(spec),
            TurnEvent::NativeTool(tool) => {
                let index = self.begin_atomic(&mut prefix);
                let (id, query, results) = match tool {
                    NativeToolEvent::WebSearch { id, query, results } => (id, query, Some(results)),
                    NativeToolEvent::WebSearchStarted { id, query } => (id, query, None),
                };
                let id = if id.is_empty() {
                    self.item_id("ws")
                } else {
                    id
                };
                let mut item =
                    json!({ "type": "web_search_call", "id": id, "status": "in_progress" });
                if !query.is_empty() || results.is_some() {
                    item["action"] = json!({ "type": "search", "query": query });
                }
                if self.wire.transport.is_some() {
                    prefix.push(self.wire.item("response.output_item.added", index, &item));
                }
                if let Some(results) = results {
                    let sources: Vec<_> = results
                        .into_iter()
                        .map(|result| {
                            json!({
                                "type": "url", "url": result.url, "title": result.title,
                            })
                        })
                        .collect();
                    item["status"] = json!("completed");
                    item["action"]["sources"] = Value::Array(sources);
                    if self.wire.transport.is_some() {
                        prefix.push(self.wire.item("response.output_item.done", index, &item));
                    }
                }
                self.output.push(item);
            }
            TurnEvent::NativeCompaction(compaction) => {
                let index = self.begin_atomic(&mut prefix);
                let id = if compaction.id.is_empty() {
                    self.item_id("cmp")
                } else {
                    compaction.id
                };
                let encrypted = if !compaction.encrypted_content.is_empty() {
                    compaction.encrypted_content
                } else if !compaction.summary.is_empty() {
                    compaction.summary
                } else {
                    format!("enc_compaction_{}", self.wire.id)
                };
                let mut item = json!({ "type": "compaction", "id": id });
                if self.wire.transport.is_some() {
                    prefix.push(self.wire.item("response.output_item.added", index, &item));
                }
                let bytes = encrypted.len();
                item["encrypted_content"] = Value::String(encrypted);
                if self.wire.transport.is_some() {
                    prefix.push(self.wire.frame(
                        ItemEvent {
                            kind: "response.output_item.done",
                            output_index: index,
                            item: &item,
                        },
                        FrameKind::SemanticDelta,
                        bytes,
                    ));
                }
                self.output.push(item);
            }
            TurnEvent::Usage(usage) => self.usage = Some(usage),
            TurnEvent::UsageWithIterations(usage) => self.usage = Some(usage.totals),
            TurnEvent::MidStreamError(error) => {
                self.ensure_created(&mut |frame| prefix.push(frame));
                self.finished = true;
                let mut response = self.wire.response("failed");
                response["output"] = Value::Array(std::mem::take(&mut self.output));
                response["error"] = json!({ "code": error.code.unwrap_or(error.error_type), "message": error.message });
                if self.wire.transport.is_some() {
                    prefix.push(self.wire.frame(
                        ResponseEvent {
                            kind: "response.failed",
                            response: &response,
                        },
                        FrameKind::Terminal,
                        0,
                    ));
                }
                self.failure = Some(response);
            }
            TurnEvent::StreamStart => self.ensure_created(&mut |frame| prefix.push(frame)),
            TurnEvent::Flush => self.close_active(&mut |frame| prefix.push(frame)),
            TurnEvent::RawJson { value } if self.wire.transport.is_some() => {
                prefix.push(self.wire.raw_json(&value))
            }
            TurnEvent::SseComment { comment }
                if matches!(self.wire.transport, Some(StreamTransport::Sse)) =>
            {
                prefix.push(EncodedFrame::comment(&comment))
            }
            TurnEvent::Ping if matches!(self.wire.transport, Some(StreamTransport::Sse)) => {
                prefix.push(EncodedFrame::comment("ping"))
            }
            TurnEvent::RawBytes(bytes) => match self.wire.transport {
                Some(StreamTransport::Sse) => prefix.push(EncodedFrame::new(
                    WireFrame::Raw(bytes),
                    FrameKind::Lifecycle,
                    0,
                )),
                Some(StreamTransport::WebSocket) => {
                    if let Ok(text) = std::str::from_utf8(&bytes) {
                        prefix.push(EncodedFrame::new(
                            WireFrame::WsText(text.into()),
                            FrameKind::Lifecycle,
                            0,
                        ));
                    }
                }
                None => {}
            },
            _ => {}
        }
        EventFrames::prefix(prefix)
    }

    fn finish_encoded(
        &mut self,
        reason: FinishReason,
        emit: &mut dyn FnMut(EncodedFrame),
    ) -> TurnCompletion {
        if let Some(response_json) = self.failure.take() {
            return TurnCompletion {
                response_json,
                response_id: self.wire.id.clone(),
                ws_reusable: false,
                errored: true,
            };
        }
        let incomplete = match &reason {
            FinishReason::Length => Some("max_output_tokens"),
            FinishReason::ContentFilter => Some("content_filter"),
            FinishReason::Incomplete(detail) => Some(detail.as_str()),
            _ => None,
        };
        let mut response = self.wire.response(if incomplete.is_some() {
            "incomplete"
        } else {
            "completed"
        });
        if let Some(reason) = incomplete {
            response["incomplete_details"] = json!({ "reason": reason });
        }
        if let Some(usage) = &self.usage {
            response["usage"] = Self::wire_usage(usage);
        }
        if !self.finished {
            self.ensure_created(emit);
            self.close_active(emit);
            response["output"] = Value::Array(std::mem::take(&mut self.output));
            self.finished = true;
            if self.wire.transport.is_some() {
                let kind = if incomplete.is_some() {
                    "response.incomplete"
                } else {
                    "response.completed"
                };
                emit(self.wire.frame(
                    ResponseEvent {
                        kind,
                        response: &response,
                    },
                    FrameKind::Terminal,
                    0,
                ));
            }
        }
        TurnCompletion {
            response_json: response,
            response_id: self.wire.id.clone(),
            ws_reusable: incomplete.is_none_or(|reason| reason == "max_output_tokens"),
            errored: false,
        }
    }

    fn is_finished(&self) -> bool {
        self.finished
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::sse_json;
    use crate::control::StoredResponses;
    use crate::plan::{ToolCallPayload, TurnPlan};

    #[test]
    fn indexed_sse_folds_to_the_same_output_as_json_and_storage() {
        let options = RequestOptions {
            include: vec!["reasoning.encrypted_content".into()],
            ..Default::default()
        };
        let plan = TurnPlan::new()
            .push_reasoning_encrypted("", "opaque")
            .push(TurnEvent::Refusal {
                text: "partial refusal".into(),
            })
            .push_text_chunked("答🦀", 1)
            .push(TurnEvent::Refusal {
                text: "last refusal".into(),
            })
            .push(
                ToolCallSpec::with_payload(
                    "call_patch",
                    "apply_patch",
                    ToolCallPayload::FreeformInput("one\n二".into()),
                )
                .with_chunk_chars(1),
            )
            .push(ToolCallSpec::new("call_lookup", "lookup", json!({ "x": 1 })).with_chunk_chars(2))
            .with_usage(Usage::new(22, 8).with_cache_read(6).with_reasoning(3));
        let make = |stream| {
            ResponsesEncoder::with_options("resp_1".into(), "test".into(), false, stream, &options)
                .with_created_at(123)
        };
        let mut sse = make(true);
        let mut json_encoder = make(false);
        let mut frames = Vec::new();
        for event in plan.events {
            frames.extend(sse.encode_event(event.clone()));
            assert_eq!(json_encoder.encode_event(event).count(), 0);
        }
        let streamed = sse.finish_encoded(FinishReason::ToolCalls, &mut |frame| frames.push(frame));
        let standalone = json_encoder
            .finish_encoded(FinishReason::ToolCalls, &mut |_| panic!("unexpected frame"));

        let mut added = Vec::new();
        let mut parts = Vec::new();
        let mut custom = String::new();
        let mut function = String::new();
        let mut semantic_bytes = 0;
        for (sequence, frame) in frames.iter().enumerate() {
            let event = sse_json(frame);
            assert_eq!(event["sequence_number"], sequence);
            if frame.kind == FrameKind::SemanticDelta {
                semantic_bytes += frame.semantic_bytes;
            }
            match event["type"].as_str().unwrap() {
                "response.created" => assert_eq!(event["response"]["created_at"], 123),
                "response.output_item.added" => {
                    assert_eq!(event["output_index"], added.len());
                    added.push(event["item"].clone());
                }
                "response.content_part.added" => {
                    assert_eq!(event["output_index"], 1);
                    assert_eq!(event["content_index"], parts.len());
                    parts.push(event["part"].clone());
                }
                "response.output_text.delta" | "response.refusal.delta" => {
                    assert_eq!(event["output_index"], 1);
                    let part = &mut parts[event["content_index"].as_u64().unwrap() as usize];
                    let key = if part["type"] == "output_text" {
                        "text"
                    } else {
                        "refusal"
                    };
                    let text = format!(
                        "{}{}",
                        part[key].as_str().unwrap(),
                        event["delta"].as_str().unwrap()
                    );
                    part[key] = Value::String(text);
                }
                "response.content_part.done" => {
                    assert_eq!(event["output_index"], 1);
                    assert_eq!(
                        event["part"],
                        parts[event["content_index"].as_u64().unwrap() as usize]
                    );
                }
                "response.output_text.done" => {
                    assert_eq!(event["content_index"], 1);
                    assert_eq!(event["text"], "答🦀");
                }
                "response.custom_tool_call_input.delta" => {
                    assert_eq!(event["output_index"], 2);
                    custom.push_str(event["delta"].as_str().unwrap());
                }
                "response.function_call_arguments.delta" => {
                    assert_eq!(event["output_index"], 3);
                    function.push_str(event["delta"].as_str().unwrap());
                }
                "response.custom_tool_call_input.done" => {
                    assert_eq!(event["input"], custom);
                    added[2]["input"] = Value::String(custom.clone());
                    added[2]["status"] = json!("completed");
                }
                "response.function_call_arguments.done" => {
                    assert_eq!(event["arguments"], function);
                    added[3]["arguments"] = Value::String(function.clone());
                    added[3]["status"] = json!("completed");
                }
                "response.output_item.done" => {
                    let index = event["output_index"].as_u64().unwrap() as usize;
                    match index {
                        0 => added[0]["encrypted_content"] = json!("opaque"),
                        1 => {
                            added[1]["content"] = json!(parts);
                            added[1]["status"] = json!("completed");
                        }
                        _ => {}
                    }
                    assert_eq!(event["item"], added[index]);
                }
                _ => {}
            }
        }
        assert_eq!(custom, "one\n二");
        assert_eq!(function, "{\"x\":1}");
        assert_eq!(
            parts
                .iter()
                .map(|part| part["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["refusal", "output_text", "refusal"]
        );
        assert_eq!(
            semantic_bytes,
            "partial refusal答🦀last refusalone\n二{\"x\":1}".len()
        );
        let response = sse_json(frames.last().unwrap());
        assert_eq!(response["type"], "response.completed");
        assert_eq!(response["response"]["output"], Value::Array(added));
        assert_eq!(
            response["response"]["usage"],
            json!({
                "input_tokens": 22, "output_tokens": 8, "total_tokens": 30,
                "input_tokens_details": { "cached_tokens": 6 },
                "output_tokens_details": { "reasoning_tokens": 3 },
            })
        );
        let store = StoredResponses::new(1, 0);
        store.put(streamed.response_id.clone(), streamed.response_json);
        assert_eq!(response["response"], standalone.response_json);
        assert_eq!(store.get("resp_1"), Some(standalone.response_json));
    }

    #[test]
    fn encrypted_reasoning_is_omitted_without_include() {
        let mut encoder = ResponsesEncoder::new("resp_1".into(), "test".into(), true, true);
        let event = TurnPlan::new()
            .push_reasoning_encrypted("plan", "secret")
            .events
            .pop()
            .unwrap();
        let mut frames: Vec<_> = encoder.encode_event(event).collect();
        let result = encoder.finish_encoded(FinishReason::Stop, &mut |frame| frames.push(frame));
        assert_eq!(
            result.response_json["output"][0]["summary"],
            json!([{ "type": "summary_text", "text": "plan" }])
        );
        assert!(
            result.response_json["output"][0]
                .get("encrypted_content")
                .is_none()
        );
        for (sequence, frame) in frames.iter().enumerate() {
            let WireFrame::WsText(text) = &frame.wire else {
                panic!("expected websocket JSON");
            };
            assert!(!text.contains("secret"), "{text}");
            assert_eq!(
                serde_json::from_str::<Value>(text).unwrap()["sequence_number"],
                sequence
            );
        }
    }
}
