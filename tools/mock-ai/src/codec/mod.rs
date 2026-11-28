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

use crate::plan::{FinishReason, HttpErrorSpec, ProviderDialectProfile, TurnEvent};
use crate::protocol::{Protocol, RequestOptions};
use bytes::Bytes;
use serde::Serialize;
use serde::ser::SerializeMap as _;
use serde_json::{Value, json};
use std::borrow::Cow;
use std::time::{SystemTime, UNIX_EPOCH};

pub use crate::plan::FrameKind;

/// Transport payload used by the existing server adapters.
#[derive(Debug, Clone)]
pub enum WireFrame {
    Sse(Bytes),
    WsText(String),
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

/// A wire payload with the metadata needed for pacing and TTFT accounting.
#[derive(Debug, Clone)]
pub struct EncodedFrame {
    pub wire: WireFrame,
    pub kind: FrameKind,
    pub semantic_bytes: usize,
}

impl EncodedFrame {
    pub fn new(wire: WireFrame, kind: FrameKind, semantic_bytes: usize) -> Self {
        Self {
            wire,
            kind,
            semantic_bytes,
        }
    }

    pub fn new_sse<T: Serialize + ?Sized>(
        event: Option<&str>,
        payload: &T,
        kind: FrameKind,
        semantic_bytes: usize,
    ) -> Self {
        let mut wire = Vec::new();
        if let Some(event) = event {
            wire.extend_from_slice(b"event: ");
            wire.extend_from_slice(event.as_bytes());
            wire.push(b'\n');
        }
        wire.extend_from_slice(b"data: ");
        serde_json::to_writer(&mut wire, payload).expect("serializing an SSE event");
        wire.extend_from_slice(b"\n\n");
        Self::new(WireFrame::Sse(wire.into()), kind, semantic_bytes)
    }

    pub fn new_ws<T: Serialize + ?Sized>(
        payload: &T,
        kind: FrameKind,
        semantic_bytes: usize,
    ) -> Self {
        Self::new(
            WireFrame::WsText(
                serde_json::to_string(payload).expect("serializing a websocket event"),
            ),
            kind,
            semantic_bytes,
        )
    }

    pub fn byte_len(&self) -> usize {
        self.wire.byte_len()
    }

    fn comment(comment: &str) -> Self {
        Self::new(
            WireFrame::Sse(format!(": {comment}\n\n").into()),
            FrameKind::Keepalive,
            0,
        )
    }
}

struct StringField<'a>(&'a str, &'a str);

impl Serialize for StringField<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(1))?;
        map.serialize_entry(self.0, self.1)?;
        map.end()
    }
}

/// Frames for one plan event. The prefix contains only lifecycle or atomic frames.
/// Chunked payloads are encoded when the iterator advances.
#[derive(Default)]
pub struct EventFrames<'a> {
    prefix: std::vec::IntoIter<EncodedFrame>,
    rest: Option<Box<dyn Iterator<Item = EncodedFrame> + Send + 'a>>,
}

impl<'a> EventFrames<'a> {
    fn prefix(prefix: Vec<EncodedFrame>) -> Self {
        Self {
            prefix: prefix.into_iter(),
            rest: None,
        }
    }

    fn then(
        prefix: Vec<EncodedFrame>,
        rest: impl Iterator<Item = EncodedFrame> + Send + 'a,
    ) -> Self {
        Self {
            prefix: prefix.into_iter(),
            rest: Some(Box::new(rest)),
        }
    }
}

impl Iterator for EventFrames<'_> {
    type Item = EncodedFrame;

    fn next(&mut self) -> Option<Self::Item> {
        self.prefix.next().or_else(|| self.rest.as_mut()?.next())
    }
}

/// Terminal state produced when an encoder finishes a turn.
#[derive(Debug, Clone, Default)]
pub struct TurnCompletion {
    /// Complete JSON body for non-streaming HTTP and Responses storage.
    pub response_json: Value,
    pub response_id: String,
    pub ws_reusable: bool,
    pub errored: bool,
}

pub trait WireEncoder: Send {
    fn encode_event(&mut self, event: TurnEvent) -> EventFrames<'_>;
    fn finish_encoded(
        &mut self,
        reason: FinishReason,
        emit: &mut dyn FnMut(EncodedFrame),
    ) -> TurnCompletion;
    fn is_finished(&self) -> bool;

    fn push_event(&mut self, event: TurnEvent, out: &mut Vec<WireFrame>) {
        out.extend(self.encode_event(event).map(|frame| frame.wire));
    }

    fn finish(&mut self, reason: FinishReason, out: &mut Vec<WireFrame>) -> TurnCompletion {
        self.finish_encoded(reason, &mut |frame| out.push(frame.wire))
    }
}

pub fn create_encoder(
    protocol: Protocol,
    response_id: String,
    model: String,
    stream: bool,
) -> Box<dyn WireEncoder> {
    // The original server entry point has no request options.
    let mut options = RequestOptions::default();
    let profile = match protocol {
        Protocol::OpenaiChatCompletions => {
            options.stream_include_usage = true;
            ProviderDialectProfile::DeepSeekChat
        }
        Protocol::OpenaiResponsesHttp | Protocol::OpenaiResponsesWs => {
            options.include.push("reasoning.encrypted_content".into());
            ProviderDialectProfile::OpenAiResponses
        }
        Protocol::AnthropicMessages => ProviderDialectProfile::AnthropicMessages,
    };
    create_encoder_with_options(protocol, response_id, model, stream, &options, profile)
}

pub fn create_encoder_with_options(
    protocol: Protocol,
    response_id: String,
    model: String,
    stream: bool,
    options: &RequestOptions,
    profile: ProviderDialectProfile,
) -> Box<dyn WireEncoder> {
    match protocol {
        Protocol::OpenaiChatCompletions => {
            Box::new(chat_completions::ChatCompletionsEncoder::with_options(
                response_id,
                model,
                stream,
                options,
                profile,
            ))
        }
        Protocol::OpenaiResponsesHttp | Protocol::OpenaiResponsesWs => {
            let websocket = protocol == Protocol::OpenaiResponsesWs;
            Box::new(responses::ResponsesEncoder::with_options(
                response_id,
                model,
                websocket,
                stream || websocket,
                options,
            ))
        }
        Protocol::AnthropicMessages => {
            Box::new(anthropic::AnthropicEncoder::new(response_id, model, stream))
        }
    }
}

/// Format a pre-stream HTTP error body in the wire envelope expected by the client protocol.
pub fn format_http_error_body(protocol: Protocol, spec: &HttpErrorSpec) -> Value {
    let profile = match protocol {
        Protocol::AnthropicMessages => ProviderDialectProfile::AnthropicMessages,
        Protocol::OpenaiChatCompletions => ProviderDialectProfile::StandardOpenAi,
        _ => ProviderDialectProfile::OpenAiResponses,
    };
    format_http_error_body_for_profile(profile, spec)
}

pub fn format_http_error_body_for_profile(
    profile: ProviderDialectProfile,
    spec: &HttpErrorSpec,
) -> Value {
    if let Some(raw) = &spec.raw_body {
        return raw.clone();
    }
    let mut detail = json!({ "message": spec.message, "type": spec.error_type });
    if profile == ProviderDialectProfile::AnthropicMessages {
        return json!({ "type": "error", "error": detail });
    }
    if let Some(code) = &spec.code {
        detail["code"] = json!(code);
    }
    json!({ "error": detail })
}

#[derive(Clone, Debug)]
pub struct Utf8ChunkIter<'a> {
    remaining: &'a str,
    chunk_chars: usize,
}

impl<'a> Iterator for Utf8ChunkIter<'a> {
    type Item = &'a str;

    fn next(&mut self) -> Option<Self::Item> {
        if self.remaining.is_empty() {
            return None;
        }
        let end = if self.chunk_chars == 0 {
            self.remaining.len()
        } else {
            self.remaining
                .char_indices()
                .nth(self.chunk_chars)
                .map_or(self.remaining.len(), |(index, _)| index)
        };
        let (chunk, remaining) = self.remaining.split_at(end);
        self.remaining = remaining;
        Some(chunk)
    }
}

/// Split UTF-8 text into borrowed chunks of at most the given number of Unicode scalars.
/// A size of zero yields the whole string in one chunk.
pub fn split_utf8_chunks(text: &str, chunk_chars: usize) -> Utf8ChunkIter<'_> {
    Utf8ChunkIter {
        remaining: text,
        chunk_chars,
    }
}

fn chunk_frames<'a>(
    text: Cow<'a, str>,
    chunk_chars: usize,
    mut frame: impl FnMut(&str) -> EncodedFrame + 'a,
) -> impl Iterator<Item = EncodedFrame> + 'a {
    let mut offset = 0;
    std::iter::from_fn(move || {
        let chunk = split_utf8_chunks(&text[offset..], chunk_chars).next()?;
        offset += chunk.len();
        Some(frame(chunk))
    })
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
fn sse_json(frame: &EncodedFrame) -> Value {
    let WireFrame::Sse(bytes) = &frame.wire else {
        panic!("expected SSE, got {frame:?}");
    };
    let payload = std::str::from_utf8(bytes)
        .unwrap()
        .lines()
        .find_map(|line| line.strip_prefix("data: "))
        .expect("SSE data line");
    serde_json::from_str(payload).unwrap()
}
