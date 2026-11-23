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

use super::{TurnCompletion, WireEncoder, WireFrame, split_utf8_chunks, sse_named};
use crate::plan::{FinishReason, NativeToolEvent, TurnEvent, Usage};
use serde_json::{Value, json};

pub struct AnthropicEncoder {
    id: String,
    model: String,
    stream: bool,
    started: bool,
    finished: bool,
    errored: bool,
    next_index: usize,
    active_block: Option<ActiveBlock>,
    completed_blocks: Vec<Value>,
    usage: Usage,
}

enum ActiveBlock {
    Text {
        index: usize,
        text: String,
        citations: Vec<Value>,
    },
    Thinking {
        index: usize,
        thinking: String,
        signature: Option<String>,
    },
}

impl AnthropicEncoder {
    pub fn new(id: String, model: String, stream: bool) -> Self {
        Self {
            id,
            model,
            stream,
            started: false,
            finished: false,
            errored: false,
            next_index: 0,
            active_block: None,
            completed_blocks: Vec::new(),
            usage: Usage::new(10, 10),
        }
    }

    fn emit(&self, event: &str, value: Value, out: &mut Vec<WireFrame>) {
        if self.stream {
            out.push(sse_named(event, &value));
        }
    }

    fn uncached_input_tokens(&self) -> u64 {
        let cached = self
            .usage
            .cache_read_tokens
            .unwrap_or(0)
            .saturating_add(self.usage.cache_creation_tokens.unwrap_or(0));
        self.usage.input_tokens.saturating_sub(cached)
    }

    fn ensure_started(&mut self, out: &mut Vec<WireFrame>) {
        if self.started {
            return;
        }
        self.started = true;
        let mut usage = serde_json::Map::new();
        // Anthropic wire `input_tokens` is uncached input; total input = input + cache_read + cache_creation.
        usage.insert("input_tokens".into(), json!(self.uncached_input_tokens()));
        usage.insert("output_tokens".into(), json!(0));
        if let Some(cr) = self.usage.cache_read_tokens {
            usage.insert("cache_read_input_tokens".into(), json!(cr));
        }
        if let Some(cw) = self.usage.cache_creation_tokens {
            usage.insert("cache_creation_input_tokens".into(), json!(cw));
        }
        self.emit(
            "message_start",
            json!({
                "type": "message_start",
                "message": {
                    "id": self.id,
                    "type": "message",
                    "role": "assistant",
                    "model": self.model,
                    "content": [],
                    "stop_reason": Value::Null,
                    "stop_sequence": Value::Null,
                    "usage": Value::Object(usage),
                }
            }),
            out,
        );
    }

    fn close_active(&mut self, out: &mut Vec<WireFrame>) {
        if let Some(active) = self.active_block.take() {
            match active {
                ActiveBlock::Text {
                    index,
                    text,
                    citations,
                } => {
                    self.emit(
                        "content_block_stop",
                        json!({ "type": "content_block_stop", "index": index }),
                        out,
                    );
                    let mut block = json!({ "type": "text", "text": text });
                    if !citations.is_empty() {
                        block["citations"] = Value::Array(citations);
                    }
                    self.completed_blocks.push(block);
                }
                ActiveBlock::Thinking {
                    index,
                    thinking,
                    signature,
                } => {
                    let sig = signature.unwrap_or_else(|| format!("sig_{}_{index}", self.id));
                    self.emit(
                        "content_block_delta",
                        json!({
                            "type": "content_block_delta",
                            "index": index,
                            "delta": { "type": "signature_delta", "signature": sig },
                        }),
                        out,
                    );
                    self.emit(
                        "content_block_stop",
                        json!({ "type": "content_block_stop", "index": index }),
                        out,
                    );
                    self.completed_blocks.push(json!({
                        "type": "thinking",
                        "thinking": thinking,
                        "signature": sig,
                    }));
                }
            }
        }
    }

    fn map_stop_reason(reason: &FinishReason) -> &'static str {
        match reason {
            FinishReason::Stop => "end_turn",
            FinishReason::ToolCalls => "tool_use",
            FinishReason::Length | FinishReason::Incomplete(_) => "max_tokens",
            FinishReason::ContentFilter | FinishReason::Refusal => "refusal",
            FinishReason::Compaction => "compaction",
        }
    }
}

impl WireEncoder for AnthropicEncoder {
    fn push_event(&mut self, event: TurnEvent, out: &mut Vec<WireFrame>) {
        if self.finished {
            return;
        }
        // Apply Usage before message_start if caller pushed Usage early!
        if let TurnEvent::Usage(usage) = event {
            self.usage = usage;
            return;
        }
        match event {
            TurnEvent::Reasoning {
                text,
                chunk_chars,
                signature,
                ..
            } => {
                self.ensure_started(out);
                let is_thinking = matches!(self.active_block, Some(ActiveBlock::Thinking { .. }));
                if !is_thinking {
                    self.close_active(out);
                    let index = self.next_index;
                    self.next_index += 1;
                    self.emit(
                        "content_block_start",
                        json!({
                            "type": "content_block_start",
                            "index": index,
                            "content_block": { "type": "thinking", "thinking": "" },
                        }),
                        out,
                    );
                    self.active_block = Some(ActiveBlock::Thinking {
                        index,
                        thinking: String::new(),
                        signature: signature.clone(),
                    });
                }
                let index = match &mut self.active_block {
                    Some(ActiveBlock::Thinking {
                        index,
                        signature: sig_slot,
                        ..
                    }) => {
                        if signature.is_some() {
                            *sig_slot = signature;
                        }
                        *index
                    }
                    _ => unreachable!(),
                };
                for chunk in split_utf8_chunks(&text, chunk_chars) {
                    if let Some(ActiveBlock::Thinking { thinking, .. }) = &mut self.active_block {
                        thinking.push_str(chunk);
                    }
                    self.emit(
                        "content_block_delta",
                        json!({
                            "type": "content_block_delta",
                            "index": index,
                            "delta": { "type": "thinking_delta", "thinking": chunk },
                        }),
                        out,
                    );
                }
            }
            TurnEvent::RedactedThinking { data } => {
                self.ensure_started(out);
                self.close_active(out);
                let index = self.next_index;
                self.next_index += 1;
                let block = json!({ "type": "redacted_thinking", "data": data });
                self.emit(
                    "content_block_start",
                    json!({
                        "type": "content_block_start",
                        "index": index,
                        "content_block": block,
                    }),
                    out,
                );
                self.emit(
                    "content_block_stop",
                    json!({ "type": "content_block_stop", "index": index }),
                    out,
                );
                self.completed_blocks.push(block);
            }
            TurnEvent::Text {
                text,
                chunk_chars,
                citations,
            } => {
                self.ensure_started(out);
                let is_text = matches!(self.active_block, Some(ActiveBlock::Text { .. }));
                if !is_text {
                    self.close_active(out);
                    let index = self.next_index;
                    self.next_index += 1;
                    self.emit(
                        "content_block_start",
                        json!({
                            "type": "content_block_start",
                            "index": index,
                            "content_block": { "type": "text", "text": "" },
                        }),
                        out,
                    );
                    self.active_block = Some(ActiveBlock::Text {
                        index,
                        text: String::new(),
                        citations: Vec::new(),
                    });
                }
                let index = match &self.active_block {
                    Some(ActiveBlock::Text { index, .. }) => *index,
                    _ => unreachable!(),
                };
                for chunk in split_utf8_chunks(&text, chunk_chars) {
                    if let Some(ActiveBlock::Text { text: buf, .. }) = &mut self.active_block {
                        buf.push_str(chunk);
                    }
                    self.emit(
                        "content_block_delta",
                        json!({
                            "type": "content_block_delta",
                            "index": index,
                            "delta": { "type": "text_delta", "text": chunk },
                        }),
                        out,
                    );
                }
                for cit in citations {
                    let wire_cit = json!({
                        "type": "web_search_result_location",
                        "url": cit.url,
                        "title": cit.title.unwrap_or_default(),
                        "cited_text": cit.cited_text.unwrap_or_default(),
                        "encrypted_index": format!("idx_{index}"),
                    });
                    if let Some(ActiveBlock::Text { citations: buf, .. }) = &mut self.active_block {
                        buf.push(wire_cit.clone());
                    }
                    self.emit(
                        "content_block_delta",
                        json!({
                            "type": "content_block_delta",
                            "index": index,
                            "delta": { "type": "citations_delta", "citation": wire_cit },
                        }),
                        out,
                    );
                }
            }
            TurnEvent::Refusal { text } => {
                self.push_event(
                    TurnEvent::Text {
                        text,
                        chunk_chars: 0,
                        citations: Vec::new(),
                    },
                    out,
                );
            }
            TurnEvent::ToolCall(spec) => {
                self.ensure_started(out);
                self.close_active(out);
                let index = self.next_index;
                self.next_index += 1;
                let tool_id = if spec.id.is_empty() {
                    format!("toolu_{}_{index}", self.id)
                } else {
                    spec.id.clone()
                };
                let args = spec.arguments_string();
                self.emit(
                    "content_block_start",
                    json!({
                        "type": "content_block_start",
                        "index": index,
                        "content_block": {
                            "type": "tool_use",
                            "id": tool_id,
                            "name": spec.name,
                            "input": {},
                        },
                    }),
                    out,
                );
                for chunk in split_utf8_chunks(&args, spec.chunk_chars) {
                    self.emit(
                        "content_block_delta",
                        json!({
                            "type": "content_block_delta",
                            "index": index,
                            "delta": { "type": "input_json_delta", "partial_json": chunk },
                        }),
                        out,
                    );
                }
                self.emit(
                    "content_block_stop",
                    json!({ "type": "content_block_stop", "index": index }),
                    out,
                );
                let parsed_input = match &spec.arguments {
                    Value::String(s) => serde_json::from_str(s).unwrap_or_else(|_| json!({})),
                    other => other.clone(),
                };
                self.completed_blocks.push(json!({
                    "type": "tool_use",
                    "id": tool_id,
                    "name": spec.name,
                    "input": parsed_input,
                }));
            }
            TurnEvent::NativeTool(NativeToolEvent::WebSearch { id, query, results }) => {
                self.ensure_started(out);
                self.close_active(out);
                let tool_id = if id.is_empty() {
                    format!("srvtoolu_{}_{}", self.id, self.next_index)
                } else {
                    id
                };
                let call_idx = self.next_index;
                self.next_index += 1;
                let server_call = json!({
                    "type": "server_tool_use",
                    "id": tool_id,
                    "name": "web_search",
                    "input": { "query": query },
                });
                self.emit(
                    "content_block_start",
                    json!({
                        "type": "content_block_start",
                        "index": call_idx,
                        "content_block": server_call,
                    }),
                    out,
                );
                self.emit(
                    "content_block_stop",
                    json!({ "type": "content_block_stop", "index": call_idx }),
                    out,
                );
                self.completed_blocks.push(server_call);

                let res_idx = self.next_index;
                self.next_index += 1;
                let items: Vec<Value> = results
                    .into_iter()
                    .map(|r| {
                        json!({
                            "type": "web_search_result",
                            "url": r.url,
                            "title": r.title,
                            "encrypted_content": r.encrypted_content.unwrap_or_else(|| "opaque".into()),
                        })
                    })
                    .collect();
                let res_block = json!({
                    "type": "web_search_tool_result",
                    "tool_use_id": tool_id,
                    "content": items,
                });
                self.emit(
                    "content_block_start",
                    json!({
                        "type": "content_block_start",
                        "index": res_idx,
                        "content_block": res_block,
                    }),
                    out,
                );
                self.emit(
                    "content_block_stop",
                    json!({ "type": "content_block_stop", "index": res_idx }),
                    out,
                );
                self.completed_blocks.push(res_block);
            }
            TurnEvent::NativeTool(NativeToolEvent::WebSearchStarted { id, query }) => {
                self.ensure_started(out);
                self.close_active(out);
                let tool_id = if id.is_empty() {
                    format!("srvtoolu_{}_{}", self.id, self.next_index)
                } else {
                    id
                };
                let call_idx = self.next_index;
                self.next_index += 1;
                let server_call = json!({
                    "type": "server_tool_use",
                    "id": tool_id,
                    "name": "web_search",
                    "input": { "query": query },
                });
                self.emit(
                    "content_block_start",
                    json!({
                        "type": "content_block_start",
                        "index": call_idx,
                        "content_block": server_call,
                    }),
                    out,
                );
                self.emit(
                    "content_block_stop",
                    json!({ "type": "content_block_stop", "index": call_idx }),
                    out,
                );
                self.completed_blocks.push(server_call);
            }
            TurnEvent::NativeCompaction(comp) => {
                self.ensure_started(out);
                self.close_active(out);
                let index = self.next_index;
                self.next_index += 1;
                let summary = if comp.summary.is_empty() {
                    if comp.encrypted_content.is_empty() {
                        "Compacted conversation summary.".into()
                    } else {
                        comp.encrypted_content
                    }
                } else {
                    comp.summary
                };
                // Per Anthropic stream decoder: start with content: null, deliver summary via compaction_delta!
                let mut start_block = serde_json::Map::new();
                start_block.insert("type".into(), json!("compaction"));
                start_block.insert("content".into(), Value::Null);
                if let Some(sig) = &comp.signature {
                    start_block.insert("signature".into(), json!(sig));
                }
                self.emit(
                    "content_block_start",
                    json!({
                        "type": "content_block_start",
                        "index": index,
                        "content_block": Value::Object(start_block),
                    }),
                    out,
                );
                self.emit(
                    "content_block_delta",
                    json!({
                        "type": "content_block_delta",
                        "index": index,
                        "delta": {
                            "type": "compaction_delta",
                            "content": summary,
                        },
                    }),
                    out,
                );
                if let Some(sig) = &comp.signature {
                    self.emit(
                        "content_block_delta",
                        json!({
                            "type": "content_block_delta",
                            "index": index,
                            "delta": { "type": "signature_delta", "signature": sig },
                        }),
                        out,
                    );
                }
                self.emit(
                    "content_block_stop",
                    json!({ "type": "content_block_stop", "index": index }),
                    out,
                );
                let mut done_block = json!({
                    "type": "compaction",
                    "content": summary,
                });
                if let Some(sig) = comp.signature {
                    done_block["signature"] = json!(sig);
                }
                self.completed_blocks.push(done_block);
            }
            TurnEvent::MidStreamError(err) => {
                self.ensure_started(out);
                self.errored = true;
                self.finished = true;
                let mut err_obj = serde_json::Map::new();
                err_obj.insert("type".into(), json!(err.error_type));
                err_obj.insert("message".into(), json!(err.message));
                if let Some(code) = err.code {
                    err_obj.insert("code".into(), json!(code));
                }
                if let Some(retryable) = err.retryable {
                    err_obj.insert("isRetryable".into(), json!(retryable));
                }
                self.emit(
                    "error",
                    json!({
                        "type": "error",
                        "error": Value::Object(err_obj),
                    }),
                    out,
                );
            }
            TurnEvent::RawJson { value } => {
                if self.stream {
                    let event_name = value["type"].as_str().unwrap_or("message");
                    out.push(sse_named(event_name, &value));
                }
            }
            TurnEvent::StreamStart => {
                self.ensure_started(out);
            }
            TurnEvent::Flush => {
                self.close_active(out);
            }
            TurnEvent::SseComment { comment } => {
                if self.stream {
                    out.push(WireFrame::Sse(bytes::Bytes::from(format!(
                        ": {comment}\n\n"
                    ))));
                }
            }
            TurnEvent::RawBytes(bytes) => {
                out.push(WireFrame::Raw(bytes));
            }
            TurnEvent::Usage(_)
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
        self.ensure_started(out);
        self.close_active(out);

        let stop_reason = Self::map_stop_reason(&reason);
        let mut usage_delta = serde_json::Map::new();
        usage_delta.insert("input_tokens".into(), json!(self.uncached_input_tokens()));
        // Mandatory per Anthropic stream decoder validation.
        usage_delta.insert("output_tokens".into(), json!(self.usage.output_tokens));
        if let Some(cr) = self.usage.cache_read_tokens {
            usage_delta.insert("cache_read_input_tokens".into(), json!(cr));
        }
        if let Some(cw) = self.usage.cache_creation_tokens {
            usage_delta.insert("cache_creation_input_tokens".into(), json!(cw));
        }

        if !self.finished {
            self.finished = true;
            self.emit(
                "message_delta",
                json!({
                    "type": "message_delta",
                    "delta": {
                        "stop_reason": stop_reason,
                        "stop_sequence": Value::Null,
                    },
                    "usage": Value::Object(usage_delta.clone()),
                }),
                out,
            );
            self.emit("message_stop", json!({ "type": "message_stop" }), out);
        }

        let resp = json!({
            "id": self.id,
            "type": "message",
            "role": "assistant",
            "model": self.model,
            "content": self.completed_blocks,
            "stop_reason": stop_reason,
            "stop_sequence": Value::Null,
            "usage": Value::Object(usage_delta),
        });

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
