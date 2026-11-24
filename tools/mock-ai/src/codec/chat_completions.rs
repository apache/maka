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

use super::{TurnCompletion, WireEncoder, WireFrame, split_utf8_chunks, sse_data};
use crate::plan::{FinishReason, TurnEvent, Usage};
use bytes::Bytes;
use serde_json::{Value, json};

pub struct ChatCompletionsEncoder {
    id: String,
    model: String,
    stream: bool,
    started_role: bool,
    finished: bool,
    errored: bool,
    next_tool_index: usize,
    usage: Option<Usage>,
    // Accumulated state for non-streaming JSON responses.
    text_buf: String,
    reasoning_buf: String,
    refusal_buf: String,
    tool_calls_acc: Vec<Value>,
}

impl ChatCompletionsEncoder {
    pub fn new(id: String, model: String, stream: bool) -> Self {
        Self {
            id,
            model,
            stream,
            started_role: false,
            finished: false,
            errored: false,
            next_tool_index: 0,
            usage: None,
            text_buf: String::new(),
            reasoning_buf: String::new(),
            refusal_buf: String::new(),
            tool_calls_acc: Vec::new(),
        }
    }

    fn emit_chunk(
        &mut self,
        mut delta: serde_json::Map<String, Value>,
        finish_reason: Value,
        out: &mut Vec<WireFrame>,
    ) {
        if !self.started_role && finish_reason.is_null() {
            delta.insert("role".into(), json!("assistant"));
            self.started_role = true;
        }
        if self.stream {
            out.push(sse_data(&json!({
                "id": self.id,
                "object": "chat.completion.chunk",
                "model": self.model,
                "choices": [{
                    "index": 0,
                    "delta": Value::Object(delta),
                    "finish_reason": finish_reason,
                }]
            })));
        }
    }

    fn wire_usage(usage: &Usage) -> Value {
        let reasoning = usage.reasoning_tokens.unwrap_or(0);
        // OpenAI spec & Maka decoder invariant: completion_tokens includes reasoning_tokens.
        let completion_tokens = usage.output_tokens.max(reasoning);
        let mut obj = serde_json::Map::new();
        obj.insert("prompt_tokens".into(), json!(usage.input_tokens));
        obj.insert("completion_tokens".into(), json!(completion_tokens));
        obj.insert(
            "total_tokens".into(),
            json!(usage.input_tokens.saturating_add(completion_tokens)),
        );
        if usage.cache_read_tokens.is_some() || usage.cache_creation_tokens.is_some() {
            let mut details = serde_json::Map::new();
            if let Some(cached) = usage.cache_read_tokens {
                details.insert("cached_tokens".into(), json!(cached));
            }
            if let Some(write) = usage.cache_creation_tokens {
                details.insert("cache_write_tokens".into(), json!(write));
            }
            obj.insert("prompt_tokens_details".into(), Value::Object(details));
        }
        if let Some(r) = usage.reasoning_tokens {
            obj.insert(
                "completion_tokens_details".into(),
                json!({ "reasoning_tokens": r }),
            );
        }
        Value::Object(obj)
    }

    fn map_finish_reason(reason: &FinishReason) -> &'static str {
        match reason {
            FinishReason::Stop | FinishReason::Compaction => "stop",
            FinishReason::ToolCalls => "tool_calls",
            FinishReason::Length => "length",
            FinishReason::ContentFilter | FinishReason::Refusal => "content_filter",
            FinishReason::Incomplete(_) => "length",
        }
    }
}

impl WireEncoder for ChatCompletionsEncoder {
    fn push_event(&mut self, event: TurnEvent, out: &mut Vec<WireFrame>) {
        if self.finished {
            return;
        }
        match event {
            TurnEvent::Text {
                text, chunk_chars, ..
            } => {
                self.text_buf.push_str(&text);
                for chunk in split_utf8_chunks(&text, chunk_chars) {
                    let mut delta = serde_json::Map::new();
                    delta.insert("content".into(), json!(chunk));
                    self.emit_chunk(delta, Value::Null, out);
                }
            }
            TurnEvent::Reasoning {
                text, chunk_chars, ..
            } => {
                if text.is_empty() {
                    return;
                }
                self.reasoning_buf.push_str(&text);
                for chunk in split_utf8_chunks(&text, chunk_chars) {
                    let mut delta = serde_json::Map::new();
                    // Only include reasoning_content when non-empty; never emit empty string.
                    delta.insert("reasoning_content".into(), json!(chunk));
                    self.emit_chunk(delta, Value::Null, out);
                }
            }
            TurnEvent::Refusal { text } => {
                self.refusal_buf.push_str(&text);
                let mut delta = serde_json::Map::new();
                delta.insert("refusal".into(), json!(text));
                self.emit_chunk(delta, Value::Null, out);
            }
            TurnEvent::ToolCall(spec) => {
                let index = self.next_tool_index;
                self.next_tool_index += 1;
                let call_id = if spec.id.is_empty() {
                    format!("call_{}_{index}", self.id)
                } else {
                    spec.id.clone()
                };
                let args = spec.arguments_string();

                let mut acc_call = json!({
                    "id": call_id,
                    "type": "function",
                    "function": {
                        "name": spec.name,
                        "arguments": args,
                    }
                });
                if let Some(sig) = &spec.thought_signature {
                    acc_call["extra_content"] = json!({ "google": { "thought_signature": sig } });
                }
                self.tool_calls_acc.push(acc_call);

                let arg_chunks = if args.is_empty() {
                    vec![""]
                } else {
                    split_utf8_chunks(&args, spec.chunk_chars)
                };
                for (i, chunk) in arg_chunks.into_iter().enumerate() {
                    let mut call_delta = serde_json::Map::new();
                    call_delta.insert("index".into(), json!(index));
                    if i == 0 {
                        call_delta.insert("id".into(), json!(call_id));
                        call_delta.insert("type".into(), json!("function"));
                        call_delta.insert(
                            "function".into(),
                            json!({ "name": spec.name, "arguments": chunk }),
                        );
                        if let Some(sig) = &spec.thought_signature {
                            call_delta.insert(
                                "extra_content".into(),
                                json!({ "google": { "thought_signature": sig } }),
                            );
                        }
                    } else {
                        call_delta.insert("function".into(), json!({ "arguments": chunk }));
                    }
                    let mut delta = serde_json::Map::new();
                    delta.insert(
                        "tool_calls".into(),
                        Value::Array(vec![Value::Object(call_delta)]),
                    );
                    self.emit_chunk(delta, Value::Null, out);
                }
            }
            TurnEvent::Usage(usage) => {
                self.usage = Some(usage);
            }
            TurnEvent::MidStreamError(err) => {
                self.errored = true;
                self.finished = true;
                let mut detail = serde_json::Map::new();
                detail.insert("message".into(), json!(err.message));
                detail.insert("type".into(), json!(err.error_type));
                if let Some(code) = err.code {
                    detail.insert("code".into(), json!(code));
                }
                if self.stream {
                    out.push(sse_data(&json!({ "error": Value::Object(detail) })));
                }
            }
            TurnEvent::RawJson { value } => {
                if self.stream {
                    out.push(sse_data(&value));
                }
            }
            TurnEvent::StreamStart => {
                if !self.started_role {
                    self.emit_chunk(serde_json::Map::new(), Value::Null, out);
                }
            }
            TurnEvent::SseComment { comment } => {
                if self.stream {
                    out.push(WireFrame::Sse(Bytes::from(format!(": {comment}\n\n"))));
                }
            }
            TurnEvent::RawBytes(bytes) => {
                out.push(WireFrame::Raw(bytes));
            }
            TurnEvent::Flush
            | TurnEvent::NativeTool(_)
            | TurnEvent::NativeCompaction(_)
            | TurnEvent::RedactedThinking { .. }
            | TurnEvent::Delay { .. }
            | TurnEvent::JitterDelay { .. }
            | TurnEvent::Stall
            | TurnEvent::HttpError(_)
            | TurnEvent::DropConnection
            | TurnEvent::TruncateEof
            | TurnEvent::Finish { .. } => {}
        }
    }

    fn finish(&mut self, reason: FinishReason, out: &mut Vec<WireFrame>) -> TurnCompletion {
        let finish_str = Self::map_finish_reason(&reason);
        if !self.finished {
            self.finished = true;
            if self.stream {
                // 1) Choice finish_reason chunk
                self.emit_chunk(serde_json::Map::new(), json!(finish_str), out);
                // 2) Separate choices:[] usage chunk (matches OpenAI stream_options.include_usage)
                if let Some(usage) = &self.usage {
                    out.push(sse_data(&json!({
                        "id": self.id,
                        "object": "chat.completion.chunk",
                        "model": self.model,
                        "choices": [],
                        "usage": Self::wire_usage(usage),
                    })));
                }
                // 3) [DONE] sentinel
                out.push(WireFrame::Sse(Bytes::from_static(b"data: [DONE]\n\n")));
            }
        }

        let mut message = serde_json::Map::new();
        message.insert("role".into(), json!("assistant"));
        if !self.text_buf.is_empty() || self.tool_calls_acc.is_empty() {
            message.insert("content".into(), json!(self.text_buf));
        } else {
            message.insert("content".into(), Value::Null);
        }
        if !self.reasoning_buf.is_empty() {
            message.insert("reasoning_content".into(), json!(self.reasoning_buf));
        }
        if !self.refusal_buf.is_empty() {
            message.insert("refusal".into(), json!(self.refusal_buf));
        }
        if !self.tool_calls_acc.is_empty() {
            message.insert(
                "tool_calls".into(),
                Value::Array(self.tool_calls_acc.clone()),
            );
        }

        let mut resp = json!({
            "id": self.id,
            "object": "chat.completion",
            "model": self.model,
            "choices": [{
                "index": 0,
                "message": Value::Object(message),
                "finish_reason": finish_str,
            }]
        });
        if let Some(usage) = &self.usage {
            resp["usage"] = Self::wire_usage(usage);
        }

        TurnCompletion {
            response_json: resp,
            response_id: self.id.clone(),
            ws_reusable: false,
            errored: self.errored,
        }
    }

    fn is_finished(&self) -> bool {
        self.finished
    }
}
