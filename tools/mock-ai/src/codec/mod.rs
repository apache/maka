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

pub mod anthropic;
pub mod chat_completions;
pub mod responses;

use crate::plan::{FinishReason, HttpErrorSpec, TurnEvent};
use crate::protocol::Protocol;
use bytes::Bytes;
use serde_json::{Value, json};

/// Wire frame emitted by a protocol encoder.
#[derive(Debug, Clone)]
pub enum WireFrame {
    /// HTTP SSE chunk (already formatted as `data: ...\n\n` or `event: ...\ndata: ...\n\n`).
    Sse(Bytes),
    /// WebSocket JSON text message.
    WsText(String),
    /// Raw bytes written directly onto HTTP body (escape hatch).
    Raw(Bytes),
}

impl WireFrame {
    pub fn byte_len(&self) -> usize {
        match self {
            Self::Sse(b) | Self::Raw(b) => b.len(),
            Self::WsText(s) => s.len(),
        }
    }
}

/// Terminal state produced when an encoder finishes a turn.
#[derive(Debug, Clone, Default)]
pub struct TurnCompletion {
    /// Complete JSON response body (for non-streaming HTTP responses & Responses storage).
    pub response_json: Value,
    /// Response/message ID emitted on the wire.
    pub response_id: String,
    /// True if a Responses WebSocket connection may safely reuse this socket for another turn.
    pub ws_reusable: bool,
    /// True if the turn ended with a mid-stream error.
    pub errored: bool,
}

/// Stateful per-turn encoder translating semantic `TurnEvent`s into wire frames.
pub trait WireEncoder: Send {
    fn push_event(&mut self, event: TurnEvent, out: &mut Vec<WireFrame>);
    fn finish(&mut self, reason: FinishReason, out: &mut Vec<WireFrame>) -> TurnCompletion;
    fn is_finished(&self) -> bool;
}

pub fn create_encoder(
    protocol: Protocol,
    response_id: String,
    model: String,
    stream: bool,
) -> Box<dyn WireEncoder> {
    match protocol {
        Protocol::OpenaiChatCompletions => Box::new(chat_completions::ChatCompletionsEncoder::new(
            response_id,
            model,
            stream,
        )),
        Protocol::OpenaiResponsesHttp => Box::new(responses::ResponsesEncoder::new(
            response_id,
            model,
            false,
            stream,
        )),
        Protocol::OpenaiResponsesWs => Box::new(responses::ResponsesEncoder::new(
            response_id,
            model,
            true,
            true,
        )),
        Protocol::AnthropicMessages => {
            Box::new(anthropic::AnthropicEncoder::new(response_id, model, stream))
        }
    }
}

/// Format a pre-stream HTTP error body in the wire envelope expected by the client protocol.
pub fn format_http_error_body(protocol: Protocol, spec: &HttpErrorSpec) -> Value {
    if let Some(raw) = &spec.raw_body {
        return raw.clone();
    }
    match protocol {
        Protocol::AnthropicMessages => json!({
            "type": "error",
            "error": {
                "type": spec.error_type,
                "message": spec.message,
            }
        }),
        Protocol::OpenaiChatCompletions
        | Protocol::OpenaiResponsesHttp
        | Protocol::OpenaiResponsesWs => {
            let mut err = serde_json::Map::new();
            err.insert("message".into(), json!(spec.message));
            err.insert("type".into(), json!(spec.error_type));
            if let Some(code) = &spec.code {
                err.insert("code".into(), json!(code));
            }
            json!({ "error": Value::Object(err) })
        }
    }
}

/// Split UTF-8 text into chunks of at most `chunk_chars` Unicode scalar values.
/// `chunk_chars == 0` returns the entire string as a single chunk (if non-empty).
pub fn split_utf8_chunks(text: &str, chunk_chars: usize) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    if chunk_chars == 0 {
        return vec![text];
    }
    let mut chunks = Vec::new();
    let mut start = 0;
    let mut count = 0;
    for (idx, _) in text.char_indices() {
        if count == chunk_chars {
            chunks.push(&text[start..idx]);
            start = idx;
            count = 0;
        }
        count += 1;
    }
    if start < text.len() {
        chunks.push(&text[start..]);
    }
    chunks
}

pub(crate) fn sse_data(value: &Value) -> WireFrame {
    WireFrame::Sse(Bytes::from(format!("data: {value}\n\n")))
}

pub(crate) fn sse_named(event: &str, value: &Value) -> WireFrame {
    WireFrame::Sse(Bytes::from(format!("event: {event}\ndata: {value}\n\n")))
}
