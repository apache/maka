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
use crate::plan::{FinishReason, NativeToolEvent, TurnEvent, Usage};
use serde_json::{Value, json};

pub struct ResponsesEncoder {
    id: String,
    model: String,
    websocket: bool,
    stream: bool,
    created_emitted: bool,
    finished: bool,
    errored: bool,
    next_item_seq: usize,
    active_message: Option<ActiveMessage>,
    active_reasoning: Option<ActiveReasoning>,
    completed_output: Vec<Value>,
    usage: Option<Usage>,
}

struct ActiveMessage {
    item_id: String,
    text: String,
    refusal: String,
    annotations: Vec<Value>,
}

struct ActiveReasoning {
    item_id: String,
    summary: String,
    encrypted_content: Option<String>,
}

impl ResponsesEncoder {
    pub fn new(id: String, model: String, websocket: bool, stream: bool) -> Self {
        Self {
            id,
            model,
            websocket,
            stream,
            created_emitted: false,
            finished: false,
            errored: false,
            next_item_seq: 0,
            active_message: None,
            active_reasoning: None,
            completed_output: Vec::new(),
            usage: None,
        }
    }

    fn next_id(&mut self, prefix: &str) -> String {
        let idx = self.next_item_seq;
        self.next_item_seq += 1;
        format!("{prefix}_{}_{idx}", self.id)
    }

    fn emit(&mut self, value: Value, out: &mut Vec<WireFrame>) {
        if !self.stream {
            return;
        }
        if self.websocket {
            out.push(WireFrame::WsText(value.to_string()));
        } else {
            out.push(sse_data(&value));
        }
    }

    fn ensure_created(&mut self, out: &mut Vec<WireFrame>) {
        if !self.created_emitted {
            self.created_emitted = true;
            let event = json!({
                "type": "response.created",
                "response": {
                    "id": self.id,
                    "object": "response",
                    "status": "in_progress",
                    "model": self.model,
                    "output": [],
                }
            });
            self.emit(event, out);
        }
    }

    fn close_reasoning(&mut self, out: &mut Vec<WireFrame>) {
        if let Some(r) = self.active_reasoning.take() {
            let mut item = serde_json::Map::new();
            item.insert("type".into(), json!("reasoning"));
            item.insert("id".into(), json!(r.item_id));
            item.insert(
                "summary".into(),
                if r.summary.is_empty() {
                    json!([])
                } else {
                    json!([{ "type": "summary_text", "text": r.summary }])
                },
            );
            if let Some(enc) = r.encrypted_content {
                item.insert("encrypted_content".into(), json!(enc));
            }
            let item_val = Value::Object(item);
            self.completed_output.push(item_val.clone());
            self.emit(
                json!({
                    "type": "response.output_item.done",
                    "item": item_val,
                }),
                out,
            );
        }
    }

    fn close_message(&mut self, out: &mut Vec<WireFrame>) {
        if let Some(msg) = self.active_message.take() {
            let mut content = Vec::new();
            if !msg.text.is_empty() {
                content.push(json!({
                    "type": "output_text",
                    "text": msg.text,
                    "annotations": msg.annotations,
                }));
            }
            if !msg.refusal.is_empty() {
                content.push(json!({
                    "type": "refusal",
                    "refusal": msg.refusal,
                }));
            }
            let item = json!({
                "type": "message",
                "id": msg.item_id,
                "role": "assistant",
                "status": "completed",
                "content": content,
            });
            self.completed_output.push(item.clone());
            self.emit(
                json!({
                    "type": "response.output_item.done",
                    "item": item,
                }),
                out,
            );
        }
    }

    fn ensure_message(&mut self, out: &mut Vec<WireFrame>) -> String {
        self.close_reasoning(out);
        if let Some(msg) = &self.active_message {
            return msg.item_id.clone();
        }
        let item_id = self.next_id("msg");
        self.emit(
            json!({
                "type": "response.output_item.added",
                "item": {
                    "type": "message",
                    "id": item_id,
                    "role": "assistant",
                    "status": "in_progress",
                    "content": [],
                }
            }),
            out,
        );
        self.active_message = Some(ActiveMessage {
            item_id: item_id.clone(),
            text: String::new(),
            refusal: String::new(),
            annotations: Vec::new(),
        });
        item_id
    }

    fn wire_usage(usage: &Usage) -> Value {
        let reasoning = usage.reasoning_tokens.unwrap_or(0);
        let output_tokens = usage.output_tokens.max(reasoning);
        let mut obj = serde_json::Map::new();
        obj.insert("input_tokens".into(), json!(usage.input_tokens));
        obj.insert("output_tokens".into(), json!(output_tokens));
        obj.insert(
            "total_tokens".into(),
            json!(usage.input_tokens.saturating_add(output_tokens)),
        );
        if let Some(cached) = usage.cache_read_tokens {
            obj.insert(
                "input_tokens_details".into(),
                json!({ "cached_tokens": cached }),
            );
        }
        if let Some(r) = usage.reasoning_tokens {
            obj.insert(
                "output_tokens_details".into(),
                json!({ "reasoning_tokens": r }),
            );
        }
        Value::Object(obj)
    }
}

impl WireEncoder for ResponsesEncoder {
    fn push_event(&mut self, event: TurnEvent, out: &mut Vec<WireFrame>) {
        if self.finished {
            return;
        }
        match event {
            TurnEvent::Reasoning {
                text,
                chunk_chars,
                encrypted_content,
                ..
            } => {
                self.ensure_created(out);
                self.close_message(out);
                if self.active_reasoning.is_none() {
                    let item_id = self.next_id("rs");
                    self.emit(
                        json!({
                            "type": "response.output_item.added",
                            "item": {
                                "type": "reasoning",
                                "id": item_id,
                                "summary": [],
                            }
                        }),
                        out,
                    );
                    self.active_reasoning = Some(ActiveReasoning {
                        item_id,
                        summary: String::new(),
                        encrypted_content: None,
                    });
                }
                if let Some(enc) = encrypted_content
                    && let Some(r) = &mut self.active_reasoning
                {
                    r.encrypted_content = Some(enc);
                }
                let item_id = self.active_reasoning.as_ref().unwrap().item_id.clone();
                for chunk in split_utf8_chunks(&text, chunk_chars) {
                    if let Some(r) = &mut self.active_reasoning {
                        r.summary.push_str(chunk);
                    }
                    self.emit(
                        json!({
                            "type": "response.reasoning_summary_text.delta",
                            "item_id": item_id,
                            "summary_index": 0,
                            "delta": chunk,
                        }),
                        out,
                    );
                }
            }
            TurnEvent::Text {
                text,
                chunk_chars,
                citations,
            } => {
                self.ensure_created(out);
                let item_id = self.ensure_message(out);
                for chunk in split_utf8_chunks(&text, chunk_chars) {
                    if let Some(msg) = &mut self.active_message {
                        msg.text.push_str(chunk);
                    }
                    self.emit(
                        json!({
                            "type": "response.output_text.delta",
                            "item_id": item_id,
                            "content_index": 0,
                            "delta": chunk,
                        }),
                        out,
                    );
                }
                for cit in citations {
                    let ann = json!({
                        "type": "url_citation",
                        "url": cit.url,
                        "title": cit.title.unwrap_or_default(),
                    });
                    let annotation_index = if let Some(msg) = &mut self.active_message {
                        let idx = msg.annotations.len();
                        msg.annotations.push(ann.clone());
                        idx
                    } else {
                        0
                    };
                    self.emit(
                        json!({
                            "type": "response.output_text.annotation.added",
                            "item_id": item_id,
                            "content_index": 0,
                            "annotation_index": annotation_index,
                            "annotation": ann,
                        }),
                        out,
                    );
                }
            }
            TurnEvent::Refusal { text } => {
                self.ensure_created(out);
                let item_id = self.ensure_message(out);
                if let Some(msg) = &mut self.active_message {
                    msg.refusal.push_str(&text);
                }
                self.emit(
                    json!({
                        "type": "response.refusal.delta",
                        "item_id": item_id,
                        "content_index": 0,
                        "delta": text,
                    }),
                    out,
                );
            }
            TurnEvent::ToolCall(spec) => {
                self.ensure_created(out);
                self.close_reasoning(out);
                self.close_message(out);
                // Deliberately keep item_id distinct from call_id to catch ID mix-ups.
                let item_id = spec
                    .item_id
                    .clone()
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| self.next_id("fc"));
                let call_id = if spec.id.is_empty() {
                    self.next_id("call")
                } else {
                    spec.id.clone()
                };
                let args = spec.arguments_string();

                if spec.custom_tool {
                    self.emit(
                        json!({
                            "type": "response.output_item.added",
                            "item": {
                                "type": "custom_tool_call",
                                "id": item_id,
                                "call_id": call_id,
                                "name": spec.name,
                                "input": "",
                                "status": "in_progress",
                            }
                        }),
                        out,
                    );
                    for chunk in split_utf8_chunks(&args, spec.chunk_chars) {
                        self.emit(
                            json!({
                                "type": "response.custom_tool_call_input.delta",
                                "item_id": item_id,
                                "delta": chunk,
                            }),
                            out,
                        );
                    }
                    let done_item = json!({
                        "type": "custom_tool_call",
                        "id": item_id,
                        "call_id": call_id,
                        "name": spec.name,
                        "input": args,
                        "status": "completed",
                    });
                    self.completed_output.push(done_item.clone());
                    self.emit(
                        json!({
                            "type": "response.output_item.done",
                            "item": done_item,
                        }),
                        out,
                    );
                } else {
                    self.emit(
                        json!({
                            "type": "response.output_item.added",
                            "item": {
                                "type": "function_call",
                                "id": item_id,
                                "call_id": call_id,
                                "name": spec.name,
                                "arguments": "",
                                "status": "in_progress",
                            }
                        }),
                        out,
                    );
                    for chunk in split_utf8_chunks(&args, spec.chunk_chars) {
                        self.emit(
                            json!({
                                "type": "response.function_call_arguments.delta",
                                "item_id": item_id,
                                "delta": chunk,
                            }),
                            out,
                        );
                    }
                    let done_item = json!({
                        "type": "function_call",
                        "id": item_id,
                        "call_id": call_id,
                        "name": spec.name,
                        "arguments": args,
                        "status": "completed",
                    });
                    self.completed_output.push(done_item.clone());
                    self.emit(
                        json!({
                            "type": "response.output_item.done",
                            "item": done_item,
                        }),
                        out,
                    );
                }
            }
            TurnEvent::NativeTool(NativeToolEvent::WebSearch { id, query, results }) => {
                self.ensure_created(out);
                self.close_reasoning(out);
                self.close_message(out);
                let item_id = if id.is_empty() {
                    self.next_id("ws")
                } else {
                    id
                };
                self.emit(
                    json!({
                        "type": "response.output_item.added",
                        "item": {
                            "type": "web_search_call",
                            "id": item_id,
                            "status": "in_progress",
                            "action": { "type": "search", "query": query },
                        }
                    }),
                    out,
                );
                let sources: Vec<Value> = results
                    .iter()
                    .map(|r| json!({ "type": "url", "url": r.url, "title": r.title }))
                    .collect();
                let done_item = json!({
                    "type": "web_search_call",
                    "id": item_id,
                    "status": "completed",
                    "action": {
                        "type": "search",
                        "query": query,
                        "sources": sources,
                    },
                });
                self.completed_output.push(done_item.clone());
                self.emit(
                    json!({
                        "type": "response.output_item.done",
                        "item": done_item,
                    }),
                    out,
                );
            }
            TurnEvent::NativeCompaction(comp) => {
                self.ensure_created(out);
                self.close_reasoning(out);
                self.close_message(out);
                let item_id = if comp.id.is_empty() {
                    self.next_id("cmp")
                } else {
                    comp.id
                };
                let encrypted = if comp.encrypted_content.is_empty() {
                    if comp.summary.is_empty() {
                        format!("enc_compaction_{}", self.id)
                    } else {
                        comp.summary
                    }
                } else {
                    comp.encrypted_content
                };
                // Exact same JSON item emitted in output_item.done AND response.completed.response.output
                // (required by plugins/agent/model/src/adapters/responses/decode.rs).
                let item = json!({
                    "type": "compaction",
                    "id": item_id,
                    "encrypted_content": encrypted,
                });
                self.completed_output.push(item.clone());
                self.emit(
                    json!({
                        "type": "response.output_item.done",
                        "item": item,
                    }),
                    out,
                );
            }
            TurnEvent::Usage(usage) => {
                self.usage = Some(usage);
            }
            TurnEvent::MidStreamError(err) => {
                self.ensure_created(out);
                self.errored = true;
                self.finished = true;
                let mut err_obj = serde_json::Map::new();
                err_obj.insert(
                    "code".into(),
                    json!(err.code.unwrap_or_else(|| err.error_type.clone())),
                );
                err_obj.insert("message".into(), json!(err.message));
                self.emit(
                    json!({
                        "type": "response.failed",
                        "response": {
                            "id": self.id,
                            "object": "response",
                            "status": "failed",
                            "model": self.model,
                            "output": self.completed_output,
                            "error": Value::Object(err_obj),
                        }
                    }),
                    out,
                );
            }
            TurnEvent::RawJson { value } => {
                self.emit(value, out);
            }
            TurnEvent::RawBytes(bytes) => {
                if self.websocket {
                    if let Ok(s) = std::str::from_utf8(&bytes) {
                        out.push(WireFrame::WsText(s.to_owned()));
                    }
                } else {
                    out.push(WireFrame::Raw(bytes));
                }
            }
            TurnEvent::RedactedThinking { .. }
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
        self.ensure_created(out);
        self.close_reasoning(out);
        self.close_message(out);

        let (event_type, status, incomplete_details, ws_reusable) = match &reason {
            FinishReason::Length => (
                "response.incomplete",
                "incomplete",
                Some(json!({ "reason": "max_output_tokens" })),
                true,
            ),
            FinishReason::ContentFilter => (
                "response.incomplete",
                "incomplete",
                Some(json!({ "reason": "content_filter" })),
                false,
            ),
            FinishReason::Incomplete(detail) => (
                "response.incomplete",
                "incomplete",
                Some(json!({ "reason": detail })),
                detail == "max_output_tokens",
            ),
            FinishReason::Stop
            | FinishReason::ToolCalls
            | FinishReason::Compaction
            | FinishReason::Refusal => ("response.completed", "completed", None, true),
        };

        let mut resp = serde_json::Map::new();
        resp.insert("id".into(), json!(self.id));
        resp.insert("object".into(), json!("response"));
        resp.insert("status".into(), json!(status));
        resp.insert("model".into(), json!(self.model));
        resp.insert("output".into(), Value::Array(self.completed_output.clone()));
        if let Some(details) = incomplete_details {
            resp.insert("incomplete_details".into(), details);
        }
        if let Some(usage) = &self.usage {
            resp.insert("usage".into(), Self::wire_usage(usage));
        }
        let response_val = Value::Object(resp);

        if !self.finished {
            self.finished = true;
            // Never emit trailing frames or [DONE] after terminal JSON event.
            self.emit(
                json!({
                    "type": event_type,
                    "response": response_val,
                }),
                out,
            );
        }

        TurnCompletion {
            response_json: response_val,
            response_id: self.id.clone(),
            ws_reusable: !self.errored && ws_reusable,
            errored: self.errored,
        }
    }

    fn is_finished(&self) -> bool {
        self.finished
    }
}
