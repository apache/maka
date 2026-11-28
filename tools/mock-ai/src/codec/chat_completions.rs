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
    EncodedFrame, EventFrames, FrameKind, StringField, TurnCompletion, Utf8ChunkIter, WireEncoder,
    WireFrame, split_utf8_chunks, unix_timestamp,
};
use crate::plan::{FinishReason, ProviderDialectProfile, ToolCallSpec, TurnEvent, Usage};
use crate::protocol::RequestOptions;
use bytes::Bytes;
use serde::Serialize;
use serde_json::{Value, json};

pub struct ChatCompletionsEncoder {
    wire: ChatWire,
    stream: bool,
    profile: ProviderDialectProfile,
    finished: bool,
    errored: bool,
    usage: Option<Usage>,
    text: String,
    reasoning: String,
    refusal: String,
    tool_calls: Vec<Value>,
}

struct ChatWire {
    id: String,
    model: String,
    created: u64,
    include_usage: bool,
    role_sent: bool,
}

#[derive(Serialize)]
struct Chunk<'a, C> {
    id: &'a str,
    object: &'static str,
    created: u64,
    model: &'a str,
    choices: C,
    #[serde(skip_serializing_if = "Option::is_none")]
    usage: Option<Option<&'a Value>>,
}

impl ChatWire {
    fn chunk(
        &mut self,
        delta: impl Serialize,
        finish_reason: Option<&str>,
        kind: FrameKind,
        semantic_bytes: usize,
    ) -> EncodedFrame {
        #[derive(Serialize)]
        struct Delta<'a, D> {
            #[serde(skip_serializing_if = "Option::is_none")]
            role: Option<&'a str>,
            #[serde(flatten)]
            fields: D,
        }
        #[derive(Serialize)]
        struct Choice<'a, D> {
            index: usize,
            delta: Delta<'a, D>,
            finish_reason: Option<&'a str>,
        }

        let role = if !self.role_sent && finish_reason.is_none() {
            self.role_sent = true;
            Some("assistant")
        } else {
            None
        };
        self.frame(
            [Choice {
                index: 0,
                delta: Delta {
                    role,
                    fields: delta,
                },
                finish_reason,
            }],
            None,
            kind,
            semantic_bytes,
        )
    }

    fn frame(
        &self,
        choices: impl Serialize,
        usage: Option<&Value>,
        kind: FrameKind,
        semantic_bytes: usize,
    ) -> EncodedFrame {
        let body = Chunk {
            id: &self.id,
            object: "chat.completion.chunk",
            created: self.created,
            model: &self.model,
            choices,
            usage: self.include_usage.then_some(usage),
        };
        EncodedFrame::new_sse(None, &body, kind, semantic_bytes)
    }
}

struct CallChunks<'a> {
    index: usize,
    call: &'a Value,
    declaration: &'a str,
    input_key: &'a str,
    chunks: Utf8ChunkIter<'a>,
    first: bool,
}

impl<'a> CallChunks<'a> {
    fn new(index: usize, call: &'a Value, chunk_chars: usize) -> Self {
        let (declaration, input_key) = if call["type"] == "custom" {
            ("custom", "input")
        } else {
            ("function", "arguments")
        };
        let input = call[declaration][input_key]
            .as_str()
            .expect("encoded tool input is a string");
        Self {
            index,
            call,
            declaration,
            input_key,
            chunks: split_utf8_chunks(input, chunk_chars),
            first: true,
        }
    }

    fn next(&mut self, wire: &mut ChatWire) -> Option<EncodedFrame> {
        let first = std::mem::take(&mut self.first);
        let chunk = self.chunks.next().or(first.then_some(""))?;
        let mut call_delta = json!({ "index": self.index });
        let mut declaration = json!({ self.input_key: chunk });
        let mut semantic_bytes = chunk.len();
        if first {
            let name = &self.call[self.declaration]["name"];
            declaration["name"] = name.clone();
            semantic_bytes += name.as_str().map_or(0, str::len);
            call_delta["id"] = self.call["id"].clone();
            call_delta["type"] = self.call["type"].clone();
            if let Some(extra) = self.call.get("extra_content") {
                call_delta["extra_content"] = extra.clone();
            }
        }
        call_delta[self.declaration] = declaration;
        Some(wire.chunk(
            json!({ "tool_calls": [call_delta] }),
            None,
            FrameKind::SemanticDelta,
            semantic_bytes,
        ))
    }
}

impl ChatCompletionsEncoder {
    pub fn new(id: String, model: String, stream: bool) -> Self {
        Self::with_options(
            id,
            model,
            stream,
            &RequestOptions::default(),
            ProviderDialectProfile::StandardOpenAi,
        )
    }

    pub fn with_options(
        id: String,
        model: String,
        stream: bool,
        options: &RequestOptions,
        profile: ProviderDialectProfile,
    ) -> Self {
        Self {
            wire: ChatWire {
                id,
                model,
                created: unix_timestamp(),
                include_usage: options.stream_include_usage,
                role_sent: false,
            },
            stream,
            profile,
            finished: false,
            errored: false,
            usage: None,
            text: String::new(),
            reasoning: String::new(),
            refusal: String::new(),
            tool_calls: Vec::new(),
        }
    }

    pub fn with_created_at(mut self, created: u64) -> Self {
        self.wire.created = created;
        self
    }

    fn store_call(&mut self, mut spec: ToolCallSpec) {
        let id = if spec.id.is_empty() {
            format!("call_{}_{}", self.wire.id, self.tool_calls.len())
        } else {
            std::mem::take(&mut spec.id)
        };
        let (declaration, input_key) = if spec.is_freeform() {
            ("custom", "input")
        } else {
            ("function", "arguments")
        };
        let input = spec.take_wire_arguments();
        let mut call = json!({ "id": id, "type": declaration, declaration: { "name": spec.name } });
        call[declaration][input_key] = Value::String(input);
        if let Some(signature) = spec.thought_signature {
            call["extra_content"] = json!({ "google": { "thought_signature": signature } });
        }
        self.tool_calls.push(call);
    }

    fn wire_usage(usage: &Usage) -> Value {
        let completion_tokens = usage.output_tokens.max(usage.reasoning_tokens.unwrap_or(0));
        let mut usage_json = json!({
            "prompt_tokens": usage.input_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": usage.input_tokens.saturating_add(completion_tokens),
        });
        if let Some(cached) = usage.cache_read_tokens {
            usage_json["prompt_tokens_details"]["cached_tokens"] = json!(cached);
        }
        if let Some(write) = usage.cache_creation_tokens {
            usage_json["prompt_tokens_details"]["cache_write_tokens"] = json!(write);
        }
        if let Some(reasoning) = usage.reasoning_tokens {
            usage_json["completion_tokens_details"]["reasoning_tokens"] = json!(reasoning);
        }
        usage_json
    }

    fn delta_text(
        &mut self,
        field: &'static str,
        text: String,
        chunk_chars: usize,
    ) -> EventFrames<'_> {
        let buffer = match field {
            "content" => &mut self.text,
            "reasoning_content" => &mut self.reasoning,
            "refusal" => &mut self.refusal,
            _ => unreachable!(),
        };
        let start = buffer.len();
        if buffer.is_empty() {
            *buffer = text;
        } else {
            buffer.push_str(&text);
        }
        if !self.stream || buffer.len() == start {
            return EventFrames::default();
        }
        let wire = &mut self.wire;
        EventFrames::then(
            Vec::new(),
            split_utf8_chunks(&buffer[start..], chunk_chars).map(move |chunk| {
                wire.chunk(
                    StringField(field, chunk),
                    None,
                    FrameKind::SemanticDelta,
                    chunk.len(),
                )
            }),
        )
    }
}

impl WireEncoder for ChatCompletionsEncoder {
    fn encode_event(&mut self, event: TurnEvent) -> EventFrames<'_> {
        if self.finished {
            return EventFrames::default();
        }
        let frame = match event {
            TurnEvent::Text {
                text, chunk_chars, ..
            } => return self.delta_text("content", text, chunk_chars),
            TurnEvent::Refusal { text } => return self.delta_text("refusal", text, 0),
            TurnEvent::Reasoning {
                text, chunk_chars, ..
            } if self.profile.emits_chat_reasoning() => {
                return self.delta_text("reasoning_content", text, chunk_chars);
            }
            TurnEvent::ToolCall(spec) => {
                let index = self.tool_calls.len();
                let chunk_chars = spec.chunk_chars;
                self.store_call(spec);
                if self.stream {
                    let mut chunks = CallChunks::new(index, &self.tool_calls[index], chunk_chars);
                    let wire = &mut self.wire;
                    return EventFrames::then(
                        Vec::new(),
                        std::iter::from_fn(move || chunks.next(wire)),
                    );
                }
                None
            }
            TurnEvent::Usage(usage) => {
                self.usage = Some(usage);
                None
            }
            TurnEvent::UsageWithIterations(usage) => {
                self.usage = Some(usage.totals);
                None
            }
            TurnEvent::MidStreamError(err) => {
                self.errored = true;
                self.finished = true;
                self.stream.then(|| {
                    let mut detail = json!({ "message": err.message, "type": err.error_type });
                    if let Some(code) = err.code {
                        detail["code"] = json!(code);
                    }
                    EncodedFrame::new_sse(None, &json!({ "error": detail }), FrameKind::Terminal, 0)
                })
            }
            TurnEvent::RawJson { value } if self.stream => {
                Some(EncodedFrame::new_sse(None, &value, FrameKind::Lifecycle, 0))
            }
            TurnEvent::StreamStart if self.stream && !self.wire.role_sent => {
                Some(self.wire.chunk(json!({}), None, FrameKind::Lifecycle, 0))
            }
            TurnEvent::SseComment { comment } if self.stream => {
                Some(EncodedFrame::comment(&comment))
            }
            TurnEvent::Ping if self.stream => Some(EncodedFrame::comment("ping")),
            TurnEvent::RawBytes(bytes) if self.stream => Some(EncodedFrame::new(
                WireFrame::Raw(bytes),
                FrameKind::Lifecycle,
                0,
            )),
            _ => None,
        };
        match frame {
            Some(frame) => EventFrames::prefix(vec![frame]),
            None => EventFrames::default(),
        }
    }

    fn finish_encoded(
        &mut self,
        reason: FinishReason,
        emit: &mut dyn FnMut(EncodedFrame),
    ) -> TurnCompletion {
        let finish = match reason {
            FinishReason::Stop | FinishReason::Compaction => "stop",
            FinishReason::ToolCalls => "tool_calls",
            FinishReason::Length | FinishReason::Incomplete(_) => "length",
            FinishReason::ContentFilter | FinishReason::Refusal => "content_filter",
        };
        let usage = self.usage.as_ref().map(Self::wire_usage);
        if !self.finished && self.stream {
            if !self.wire.role_sent {
                emit(self.wire.chunk(json!({}), None, FrameKind::Lifecycle, 0));
            }
            emit(
                self.wire
                    .chunk(json!({}), Some(finish), FrameKind::Terminal, 0),
            );
            if self.wire.include_usage {
                let fallback;
                let usage = if let Some(usage) = &usage {
                    usage
                } else {
                    fallback = Self::wire_usage(&Usage::default());
                    &fallback
                };
                emit(
                    self.wire
                        .frame(json!([]), Some(usage), FrameKind::Terminal, 0),
                );
            }
            emit(EncodedFrame::new(
                WireFrame::Sse(Bytes::from_static(b"data: [DONE]\n\n")),
                FrameKind::Terminal,
                0,
            ));
        }
        self.finished = true;

        let mut message = json!({ "role": "assistant", "content": null });
        if !self.text.is_empty() || self.tool_calls.is_empty() {
            message["content"] = Value::String(std::mem::take(&mut self.text));
        }
        if !self.reasoning.is_empty() {
            message["reasoning_content"] = Value::String(std::mem::take(&mut self.reasoning));
        }
        if !self.refusal.is_empty() {
            message["refusal"] = Value::String(std::mem::take(&mut self.refusal));
        }
        if !self.tool_calls.is_empty() {
            message["tool_calls"] = Value::Array(std::mem::take(&mut self.tool_calls));
        }

        let mut response_json = json!({
            "id": self.wire.id,
            "object": "chat.completion",
            "created": self.wire.created,
            "model": self.wire.model,
            "choices": [{ "index": 0, "message": null, "finish_reason": finish }],
        });
        response_json["choices"][0]["message"] = message;
        if let Some(usage) = usage {
            response_json["usage"] = usage;
        }
        TurnCompletion {
            response_json,
            response_id: self.wire.id.clone(),
            ws_reusable: false,
            errored: self.errored,
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

    #[test]
    fn stream_usage_and_reasoning_follow_request_and_profile() {
        for (include_usage, profile, reasoning) in [
            (false, ProviderDialectProfile::StandardOpenAi, false),
            (true, ProviderDialectProfile::DeepSeekChat, true),
            (false, ProviderDialectProfile::KimiChat, true),
        ] {
            let options = RequestOptions {
                stream_include_usage: include_usage,
                ..Default::default()
            };
            let mut encoder = ChatCompletionsEncoder::with_options(
                "chat_1".into(),
                "test".into(),
                true,
                &options,
                profile,
            )
            .with_created_at(42);
            let mut frames: Vec<_> = encoder
                .encode_event(TurnEvent::Reasoning {
                    text: "想".into(),
                    chunk_chars: 1,
                    signature: None,
                    encrypted_content: None,
                })
                .collect();
            assert_eq!(frames.len(), usize::from(reasoning));
            if reasoning {
                assert_eq!(frames[0].semantic_bytes, 3);
                assert_eq!(
                    sse_json(&frames[0])["choices"][0]["delta"]["reasoning_content"],
                    "想"
                );
            }
            frames.extend(encoder.encode_event(TurnEvent::Text {
                text: "ok".into(),
                chunk_chars: 1,
                citations: Vec::new(),
            }));
            frames.extend(encoder.encode_event(TurnEvent::Usage(Usage::new(7, 2))));
            let result =
                encoder.finish_encoded(FinishReason::Stop, &mut |frame| frames.push(frame));
            assert_eq!(
                result.response_json["choices"][0]["message"]
                    .get("reasoning_content")
                    .is_some(),
                reasoning
            );
            let WireFrame::Sse(last) = &frames.pop().unwrap().wire else {
                panic!("expected SSE");
            };
            assert_eq!(&last[..], b"data: [DONE]\n\n");
            let events: Vec<_> = frames.iter().map(sse_json).collect();
            assert!(events.iter().all(|event| event["created"] == 42));
            let finish_index = events.len() - 1 - usize::from(include_usage);
            assert_eq!(events[finish_index]["choices"][0]["finish_reason"], "stop");
            for event in &events[..=finish_index] {
                assert_eq!(event.get("usage"), include_usage.then_some(&Value::Null));
            }
            if include_usage {
                let usage = &events[finish_index + 1];
                assert_eq!(usage["choices"], json!([]));
                assert_eq!(
                    usage["usage"],
                    json!({ "prompt_tokens": 7, "completion_tokens": 2, "total_tokens": 9 })
                );
            }
        }
    }

    #[test]
    fn tool_deltas_fold_into_the_same_calls_as_json() {
        use crate::plan::ToolCallPayload;

        let calls = vec![
            ToolCallSpec::new("call_a", "lookup", json!({ "q": "東京" })).with_chunk_chars(3),
            ToolCallSpec::with_payload(
                "call_b",
                "apply_patch",
                ToolCallPayload::FreeformInput("line\n🦀".into()),
            )
            .with_chunk_chars(2),
        ];
        let mut stream =
            ChatCompletionsEncoder::new("chat_1".into(), "test".into(), true).with_created_at(42);
        let mut json_encoder =
            ChatCompletionsEncoder::new("chat_1".into(), "test".into(), false).with_created_at(42);

        let mut folded = [Value::Null, Value::Null];
        for call in calls {
            let event = TurnEvent::ToolCall(call);
            for frame in stream.encode_event(event.clone()) {
                let event = sse_json(&frame);
                let delta = &event["choices"][0]["delta"]["tool_calls"][0];
                let index = delta["index"].as_u64().unwrap() as usize;
                let (member, field) = if index == 0 {
                    ("function", "arguments")
                } else {
                    ("custom", "input")
                };
                if delta.get("id").is_some() {
                    let mut call = delta.clone();
                    call.as_object_mut().unwrap().remove("index");
                    folded[index] = call;
                } else {
                    let mut input = folded[index][member][field].as_str().unwrap().to_owned();
                    input.push_str(delta[member][field].as_str().unwrap());
                    folded[index][member][field] = Value::String(input);
                }
            }
            assert_eq!(json_encoder.encode_event(event).count(), 0);
        }
        let json = json_encoder
            .finish_encoded(FinishReason::ToolCalls, &mut |_| panic!("unexpected frame"))
            .response_json;
        assert_eq!(
            json["choices"][0]["message"]["tool_calls"],
            Value::Array(folded.into())
        );
        assert_eq!(
            json["choices"][0]["message"]["tool_calls"],
            json!([
                {"id": "call_a", "type": "function", "function": {"name": "lookup", "arguments": "{\"q\":\"東京\"}"}},
                {"id": "call_b", "type": "custom", "custom": {"name": "apply_patch", "input": "line\n🦀"}}
            ])
        );
        assert_eq!(
            stream
                .finish_encoded(FinishReason::ToolCalls, &mut |_| {})
                .response_json,
            json
        );
    }
}
