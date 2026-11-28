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
    chunk_frames, split_utf8_chunks,
};
use crate::plan::{Citation, FinishReason, NativeToolEvent, ToolCallPayload, TurnEvent, TurnUsage};
use serde::Serialize;
use serde_json::{Value, json};
use std::borrow::Cow;

pub struct AnthropicEncoder {
    id: String,
    model: String,
    stream: bool,
    started: bool,
    finished: bool,
    paused: bool,
    error: Option<Value>,
    active: Option<ActiveBlock>,
    blocks: Vec<Value>,
    usage: TurnUsage,
}

enum ActiveBlock {
    Text {
        text: String,
        citations: Vec<Value>,
    },
    Thinking {
        text: String,
        signature: Option<String>,
    },
}

fn frame(
    event: &str,
    value: &impl Serialize,
    kind: FrameKind,
    semantic_bytes: usize,
) -> EncodedFrame {
    EncodedFrame::new_sse(Some(event), value, kind, semantic_bytes)
}

fn block_start(index: usize, block: &Value, kind: FrameKind, bytes: usize) -> EncodedFrame {
    frame(
        "content_block_start",
        &json!({
            "type": "content_block_start", "index": index, "content_block": block,
        }),
        kind,
        bytes,
    )
}

fn block_stop(index: usize) -> EncodedFrame {
    frame(
        "content_block_stop",
        &json!({ "type": "content_block_stop", "index": index }),
        FrameKind::Lifecycle,
        0,
    )
}

fn block_delta(
    index: usize,
    kind: &str,
    field: &str,
    chunk: &str,
    semantic_bytes: usize,
) -> EncodedFrame {
    #[derive(Serialize)]
    struct Delta<'a> {
        #[serde(rename = "type")]
        kind: &'a str,
        #[serde(flatten)]
        data: StringField<'a>,
    }
    #[derive(Serialize)]
    struct BlockDelta<'a> {
        #[serde(rename = "type")]
        kind: &'a str,
        index: usize,
        delta: Delta<'a>,
    }

    let kind_on_wire = if semantic_bytes == 0 {
        FrameKind::Lifecycle
    } else {
        FrameKind::SemanticDelta
    };
    frame(
        "content_block_delta",
        &BlockDelta {
            kind: "content_block_delta",
            index,
            delta: Delta {
                kind,
                data: StringField(field, chunk),
            },
        },
        kind_on_wire,
        semantic_bytes,
    )
}

impl AnthropicEncoder {
    pub fn new(id: String, model: String, stream: bool) -> Self {
        Self {
            id,
            model,
            stream,
            started: false,
            finished: false,
            paused: false,
            error: None,
            active: None,
            blocks: Vec::new(),
            usage: TurnUsage::default(),
        }
    }

    fn wire_usage(&self, starting: bool) -> Value {
        let totals = &self.usage.totals;
        let cached = totals
            .cache_read_tokens
            .unwrap_or(0)
            .saturating_add(totals.cache_creation_tokens.unwrap_or(0));
        let mut usage = json!({
            "input_tokens": totals.input_tokens.saturating_sub(cached),
            "output_tokens": if starting { 0 } else { totals.output_tokens },
        });
        if let Some(read) = totals.cache_read_tokens {
            usage["cache_read_input_tokens"] = json!(read);
        }
        if let Some(create) = totals.cache_creation_tokens {
            usage["cache_creation_input_tokens"] = json!(create);
        }
        if !starting && !self.usage.iterations.is_empty() {
            usage["iterations"] = json!(self.usage.iterations);
        }
        usage
    }

    fn ensure_started(&mut self, emit: &mut dyn FnMut(EncodedFrame)) {
        if !self.stream || self.started {
            return;
        }
        self.started = true;
        emit(frame(
            "message_start",
            &json!({
                "type": "message_start",
                "message": {
                    "id": self.id, "type": "message", "role": "assistant", "model": self.model,
                    "content": [], "stop_reason": null, "stop_sequence": null,
                    "usage": self.wire_usage(true),
                },
            }),
            FrameKind::Lifecycle,
            0,
        ));
    }

    fn close_active(&mut self, emit: &mut dyn FnMut(EncodedFrame)) {
        let Some(active) = self.active.take() else {
            return;
        };
        let index = self.blocks.len();
        let block = match active {
            ActiveBlock::Text { text, citations } => {
                let mut block = json!({ "type": "text" });
                block["text"] = Value::String(text);
                if !citations.is_empty() {
                    block["citations"] = Value::Array(citations);
                }
                block
            }
            ActiveBlock::Thinking { text, signature } => {
                let signature = signature.unwrap_or_else(|| format!("sig_{}_{index}", self.id));
                if self.stream {
                    emit(block_delta(
                        index,
                        "signature_delta",
                        "signature",
                        &signature,
                        0,
                    ));
                }
                let mut block = json!({ "type": "thinking" });
                block["thinking"] = Value::String(text);
                block["signature"] = Value::String(signature);
                block
            }
        };
        if self.stream {
            emit(block_stop(index));
        }
        self.blocks.push(block);
    }

    fn begin_atomic(&mut self, prefix: &mut Vec<EncodedFrame>) -> usize {
        self.ensure_started(&mut |frame| prefix.push(frame));
        self.close_active(&mut |frame| prefix.push(frame));
        self.blocks.len()
    }

    fn atomic_block(&mut self, block: Value, bytes: usize, prefix: &mut Vec<EncodedFrame>) {
        if self.stream {
            let index = self.blocks.len();
            let kind = if bytes == 0 {
                FrameKind::Lifecycle
            } else {
                FrameKind::SemanticDelta
            };
            prefix.push(block_start(index, &block, kind, bytes));
            prefix.push(block_stop(index));
        }
        self.blocks.push(block);
    }

    fn text(
        &mut self,
        text: String,
        chunk_chars: usize,
        citations: Vec<Citation>,
    ) -> EventFrames<'_> {
        let mut prefix = Vec::new();
        self.ensure_started(&mut |frame| prefix.push(frame));
        if !matches!(self.active, Some(ActiveBlock::Text { .. })) {
            let index = self.begin_atomic(&mut prefix);
            if self.stream {
                prefix.push(block_start(
                    index,
                    &json!({ "type": "text", "text": "" }),
                    FrameKind::Lifecycle,
                    0,
                ));
            }
            self.active = Some(ActiveBlock::Text {
                text: String::new(),
                citations: Vec::new(),
            });
        }
        let index = self.blocks.len();
        let Some(ActiveBlock::Text {
            text: buffer,
            citations: annotations,
        }) = &mut self.active
        else {
            unreachable!()
        };
        let start = buffer.len();
        append(buffer, text);
        let first_citation = annotations.len();
        annotations.extend(citations.into_iter().map(|citation| {
            json!({
                "type": "web_search_result_location",
                "url": citation.url,
                "title": citation.title.unwrap_or_default(),
                "cited_text": citation.cited_text.unwrap_or_default(),
                "encrypted_index": format!("idx_{index}"),
            })
        }));
        if !self.stream {
            return EventFrames::default();
        }
        let deltas = split_utf8_chunks(&buffer[start..], chunk_chars)
            .map(move |chunk| block_delta(index, "text_delta", "text", chunk, chunk.len()));
        let citations = annotations[first_citation..].iter().map(move |citation| {
            frame(
                "content_block_delta",
                &json!({
                    "type": "content_block_delta", "index": index,
                    "delta": { "type": "citations_delta", "citation": citation },
                }),
                FrameKind::Lifecycle,
                0,
            )
        });
        EventFrames::then(prefix, deltas.chain(citations))
    }

    fn thinking(
        &mut self,
        text: String,
        chunk_chars: usize,
        signature: Option<String>,
    ) -> EventFrames<'_> {
        let mut prefix = Vec::new();
        self.ensure_started(&mut |frame| prefix.push(frame));
        if !matches!(self.active, Some(ActiveBlock::Thinking { .. })) {
            let index = self.begin_atomic(&mut prefix);
            if self.stream {
                prefix.push(block_start(
                    index,
                    &json!({ "type": "thinking", "thinking": "", "signature": "" }),
                    FrameKind::Lifecycle,
                    0,
                ));
            }
            self.active = Some(ActiveBlock::Thinking {
                text: String::new(),
                signature: None,
            });
        }
        let index = self.blocks.len();
        let Some(ActiveBlock::Thinking {
            text: buffer,
            signature: stored_signature,
        }) = &mut self.active
        else {
            unreachable!()
        };
        if signature.is_some() {
            *stored_signature = signature;
        }
        let start = buffer.len();
        append(buffer, text);
        if !self.stream {
            return EventFrames::default();
        }
        EventFrames::then(
            prefix,
            split_utf8_chunks(&buffer[start..], chunk_chars).map(move |chunk| {
                block_delta(index, "thinking_delta", "thinking", chunk, chunk.len())
            }),
        )
    }
}

fn append(buffer: &mut String, text: String) {
    if buffer.is_empty() {
        *buffer = text;
    } else {
        buffer.push_str(&text);
    }
}

impl WireEncoder for AnthropicEncoder {
    fn encode_event(&mut self, event: TurnEvent) -> EventFrames<'_> {
        if self.finished {
            return EventFrames::default();
        }
        let event = match event {
            TurnEvent::Usage(totals) => {
                self.usage = totals.into();
                return EventFrames::default();
            }
            TurnEvent::UsageWithIterations(usage) => {
                self.usage = usage;
                return EventFrames::default();
            }
            _ if self.paused => return EventFrames::default(),
            event => event,
        };
        let mut prefix = Vec::new();
        match event {
            TurnEvent::Text {
                text,
                chunk_chars,
                citations,
            } => return self.text(text, chunk_chars, citations),
            TurnEvent::Refusal { text } => return self.text(text, 0, Vec::new()),
            TurnEvent::Reasoning {
                text,
                chunk_chars,
                signature,
                ..
            } => return self.thinking(text, chunk_chars, signature),
            TurnEvent::RedactedThinking { data } => {
                let bytes = data.len();
                self.begin_atomic(&mut prefix);
                self.atomic_block(
                    json!({ "type": "redacted_thinking", "data": data }),
                    bytes,
                    &mut prefix,
                );
            }
            TurnEvent::ToolCall(spec) => {
                let index = self.begin_atomic(&mut prefix);
                let id = if spec.id.is_empty() {
                    format!("toolu_{}_{index}", self.id)
                } else {
                    spec.id
                };
                let (input, raw, literal) = match spec.payload {
                    Some(ToolCallPayload::FunctionArgs(input)) => (input, None, false),
                    Some(
                        ToolCallPayload::MalformedRaw(raw) | ToolCallPayload::FreeformInput(raw),
                    ) => (Value::String(raw), None, true),
                    None => match spec.arguments {
                        Value::String(raw) if spec.custom_tool => (Value::String(raw), None, true),
                        Value::String(raw) => match serde_json::from_str(&raw) {
                            Ok(input) => (input, Some(raw), false),
                            Err(_) => (Value::String(raw), None, true),
                        },
                        input => (input, None, false),
                    },
                };
                let mut block =
                    json!({ "type": "tool_use", "id": id, "name": spec.name, "input": {} });
                if self.stream {
                    prefix.push(block_start(
                        index,
                        &block,
                        FrameKind::SemanticDelta,
                        spec.name.len(),
                    ));
                }
                block["input"] = input;
                self.blocks.push(block);
                if self.stream {
                    let input = &self.blocks[index]["input"];
                    let args = match raw {
                        Some(raw) => Cow::Owned(raw),
                        None if literal => {
                            Cow::Borrowed(input.as_str().expect("literal tool input is a string"))
                        }
                        None => Cow::Owned(input.to_string()),
                    };
                    return EventFrames::then(
                        prefix,
                        chunk_frames(args, spec.chunk_chars, move |chunk| {
                            block_delta(
                                index,
                                "input_json_delta",
                                "partial_json",
                                chunk,
                                chunk.len(),
                            )
                        })
                        .chain(std::iter::once_with(move || block_stop(index))),
                    );
                }
            }
            TurnEvent::NativeTool(tool) => {
                let index = self.begin_atomic(&mut prefix);
                let (id, query, results) = match tool {
                    NativeToolEvent::WebSearch { id, query, results } => (id, query, Some(results)),
                    NativeToolEvent::WebSearchStarted { id, query } => (id, query, None),
                };
                let id = if id.is_empty() {
                    format!("srvtoolu_{}_{index}", self.id)
                } else {
                    id
                };
                self.atomic_block(json!({
                    "type": "server_tool_use", "id": id, "name": "web_search", "input": { "query": query },
                }), query.len(), &mut prefix);
                if let Some(results) = results {
                    let results: Vec<_> = results.into_iter().map(|result| json!({
                        "type": "web_search_result", "url": result.url, "title": result.title,
                        "encrypted_content": result.encrypted_content.as_deref().unwrap_or("opaque"),
                    })).collect();
                    self.atomic_block(
                        json!({
                            "type": "web_search_tool_result", "tool_use_id": id, "content": results,
                        }),
                        0,
                        &mut prefix,
                    );
                }
            }
            TurnEvent::NativeCompaction(compaction) => {
                let index = self.begin_atomic(&mut prefix);
                self.paused = compaction.pause_after_compaction;
                let summary = if !compaction.summary.is_empty() {
                    compaction.summary
                } else if !compaction.encrypted_content.is_empty() {
                    compaction.encrypted_content
                } else {
                    "Compacted conversation summary.".into()
                };
                if self.stream {
                    prefix.push(block_start(
                        index,
                        &json!({ "type": "compaction", "content": null }),
                        FrameKind::Lifecycle,
                        0,
                    ));
                    prefix.push(block_delta(
                        index,
                        "compaction_delta",
                        "content",
                        &summary,
                        summary.len(),
                    ));
                    if let Some(signature) = &compaction.signature {
                        prefix.push(block_delta(
                            index,
                            "signature_delta",
                            "signature",
                            signature,
                            0,
                        ));
                    }
                    prefix.push(block_stop(index));
                }
                let mut block = json!({ "type": "compaction" });
                block["content"] = Value::String(summary);
                if let Some(signature) = compaction.signature {
                    block["signature"] = Value::String(signature);
                }
                self.blocks.push(block);
            }
            TurnEvent::MidStreamError(error) => {
                self.ensure_started(&mut |frame| prefix.push(frame));
                self.finished = true;
                let mut body = json!({ "type": "error", "error": { "type": error.error_type, "message": error.message } });
                if let Some(code) = error.code {
                    body["error"]["code"] = Value::String(code);
                }
                if let Some(retryable) = error.retryable {
                    body["error"]["isRetryable"] = Value::Bool(retryable);
                }
                if self.stream {
                    prefix.push(frame("error", &body, FrameKind::Terminal, 0));
                }
                self.error = Some(body);
            }
            TurnEvent::Ping if self.stream => {
                self.ensure_started(&mut |frame| prefix.push(frame));
                prefix.push(frame(
                    "ping",
                    &json!({ "type": "ping" }),
                    FrameKind::Keepalive,
                    0,
                ));
            }
            TurnEvent::StreamStart => self.ensure_started(&mut |frame| prefix.push(frame)),
            TurnEvent::Flush => self.close_active(&mut |frame| prefix.push(frame)),
            TurnEvent::RawJson { value } if self.stream => prefix.push(frame(
                value["type"].as_str().unwrap_or("message"),
                &value,
                FrameKind::Lifecycle,
                0,
            )),
            TurnEvent::SseComment { comment } if self.stream => {
                prefix.push(EncodedFrame::comment(&comment))
            }
            TurnEvent::RawBytes(bytes) if self.stream => prefix.push(EncodedFrame::new(
                WireFrame::Raw(bytes),
                FrameKind::Lifecycle,
                0,
            )),
            _ => {}
        }
        EventFrames::prefix(prefix)
    }

    fn finish_encoded(
        &mut self,
        reason: FinishReason,
        emit: &mut dyn FnMut(EncodedFrame),
    ) -> TurnCompletion {
        if let Some(response_json) = self.error.take() {
            return TurnCompletion {
                response_json,
                response_id: self.id.clone(),
                ws_reusable: false,
                errored: true,
            };
        }
        let stop_reason = match reason {
            _ if self.paused => "compaction",
            FinishReason::Stop => "end_turn",
            FinishReason::ToolCalls => "tool_use",
            FinishReason::Length | FinishReason::Incomplete(_) => "max_tokens",
            FinishReason::ContentFilter | FinishReason::Refusal => "refusal",
            FinishReason::Compaction => "compaction",
        };
        let usage = self.wire_usage(false);
        if !self.finished {
            self.ensure_started(emit);
            self.close_active(emit);
            self.finished = true;
            if self.stream {
                emit(frame(
                    "message_delta",
                    &json!({
                        "type": "message_delta",
                        "delta": { "stop_reason": stop_reason, "stop_sequence": null },
                        "usage": usage,
                    }),
                    FrameKind::Terminal,
                    0,
                ));
                emit(frame(
                    "message_stop",
                    &json!({ "type": "message_stop" }),
                    FrameKind::Terminal,
                    0,
                ));
            }
        }
        let mut response_json = json!({
            "id": self.id, "type": "message", "role": "assistant", "model": self.model,
            "stop_reason": stop_reason, "stop_sequence": null,
        });
        response_json["content"] = Value::Array(std::mem::take(&mut self.blocks));
        response_json["usage"] = usage;
        TurnCompletion {
            response_json,
            response_id: self.id.clone(),
            ws_reusable: false,
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
    use crate::plan::{CompactionOutput, ToolCallSpec, Usage, UsageIteration, UsageIterationKind};

    #[test]
    fn ping_and_signed_thinking_preserve_the_stream_and_usage() {
        let mut encoder = AnthropicEncoder::new("msg_1".into(), "test".into(), true);
        let mut frames = Vec::new();
        for event in [
            TurnEvent::Usage(Usage::new(52, 9).with_cache_read(20).with_cache_creation(7)),
            TurnEvent::Ping,
            TurnEvent::Reasoning {
                text: "🦀思".into(),
                chunk_chars: 1,
                signature: Some("signed".into()),
                encrypted_content: None,
            },
            TurnEvent::RedactedThinking {
                data: "opaque".into(),
            },
        ] {
            frames.extend(encoder.encode_event(event));
        }
        let result = encoder.finish_encoded(FinishReason::Stop, &mut |frame| frames.push(frame));
        let events: Vec<_> = frames.iter().map(sse_json).collect();
        assert_eq!(
            events[0]["message"]["usage"],
            json!({
                "input_tokens": 25, "output_tokens": 0, "cache_read_input_tokens": 20, "cache_creation_input_tokens": 7,
            })
        );
        assert_eq!(frames[1].kind, FrameKind::Keepalive);
        assert_eq!(frames[1].semantic_bytes, 0);
        let WireFrame::Sse(ping) = &frames[1].wire else {
            panic!("expected ping SSE");
        };
        assert_eq!(&ping[..], b"event: ping\ndata: {\"type\":\"ping\"}\n\n");
        let deltas: Vec<_> = events
            .iter()
            .filter_map(|event| event.get("delta"))
            .filter(|delta| delta.get("type").is_some())
            .cloned()
            .collect();
        assert_eq!(
            deltas,
            vec![
                json!({ "type": "thinking_delta", "thinking": "🦀" }),
                json!({ "type": "thinking_delta", "thinking": "思" }),
                json!({ "type": "signature_delta", "signature": "signed" }),
            ]
        );
        assert_eq!(
            result.response_json["content"],
            json!([
                { "type": "thinking", "thinking": "🦀思", "signature": "signed" },
                { "type": "redacted_thinking", "data": "opaque" },
            ])
        );
    }

    #[test]
    fn compaction_can_pause_or_continue_with_iteration_usage() {
        for pause in [false, true] {
            let mut encoder = AnthropicEncoder::new("msg_1".into(), "test".into(), true);
            let mut frames = Vec::new();
            let usage = Usage::new(100, 6).with_iterations(vec![
                UsageIteration {
                    kind: UsageIterationKind::Compaction,
                    input_tokens: 80,
                    output_tokens: 2,
                    cache_read_input_tokens: None,
                    cache_creation_input_tokens: None,
                },
                UsageIteration {
                    kind: UsageIterationKind::Message,
                    input_tokens: 20,
                    output_tokens: 4,
                    cache_read_input_tokens: None,
                    cache_creation_input_tokens: None,
                },
            ]);
            for event in [
                TurnEvent::UsageWithIterations(usage),
                TurnEvent::NativeCompaction(CompactionOutput::new("summary").with_pause(pause)),
                TurnEvent::Text {
                    text: "continued".into(),
                    chunk_chars: 0,
                    citations: Vec::new(),
                },
            ] {
                frames.extend(encoder.encode_event(event));
            }
            let result =
                encoder.finish_encoded(FinishReason::Stop, &mut |frame| frames.push(frame));
            let delta = sse_json(&frames[frames.len() - 2]);
            assert_eq!(delta["type"], "message_delta");
            assert_eq!(
                delta["delta"]["stop_reason"],
                if pause { "compaction" } else { "end_turn" }
            );
            assert_eq!(
                delta["usage"]["iterations"],
                json!([
                    { "type": "compaction", "input_tokens": 80, "output_tokens": 2 },
                    { "type": "message", "input_tokens": 20, "output_tokens": 4 },
                ])
            );
            let mut expected = vec![json!({ "type": "compaction", "content": "summary" })];
            if !pause {
                expected.push(json!({ "type": "text", "text": "continued" }));
            }
            assert_eq!(result.response_json["content"], Value::Array(expected));
        }
    }

    #[test]
    fn nonstreaming_malformed_tool_input_remains_observable() {
        let mut encoder = AnthropicEncoder::new("msg_1".into(), "test".into(), false);
        let call = ToolCallSpec::with_payload(
            "toolu_1",
            "lookup",
            ToolCallPayload::MalformedRaw("{-".into()),
        )
        .with_chunk_chars(1);
        assert_eq!(encoder.encode_event(call.into()).count(), 0);
        let result =
            encoder.finish_encoded(FinishReason::ToolCalls, &mut |_| panic!("unexpected frame"));
        assert_eq!(
            result.response_json["content"],
            json!([
                { "type": "tool_use", "id": "toolu_1", "name": "lookup", "input": "{-" },
            ])
        );
    }
}
