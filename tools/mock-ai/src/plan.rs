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

use bytes::Bytes;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// Sticky, multi-waiter notification fired when a turn's HTTP stream or WebSocket turn terminates
/// (finish, error, cancel, or client disconnect).
#[derive(Clone, Debug, Default)]
pub struct CloseSignal(pub CancellationToken);

impl PartialEq for CloseSignal {
    fn eq(&self, _other: &Self) -> bool {
        false
    }
}

impl From<CancellationToken> for CloseSignal {
    fn from(token: CancellationToken) -> Self {
        Self(token)
    }
}

impl CloseSignal {
    pub fn new() -> Self {
        Self(CancellationToken::new())
    }

    pub fn notify(&self) {
        self.0.cancel();
    }

    pub fn is_closed(&self) -> bool {
        self.0.is_cancelled()
    }

    pub async fn wait(&self) {
        self.0.cancelled().await;
    }
}

/// Protocol-agnostic finish reason translated to each provider wire dialect.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum FinishReason {
    #[default]
    Stop,
    ToolCalls,
    Length,
    ContentFilter,
    Compaction,
    Refusal,
    Incomplete(String),
}

/// Token accounting attached to a turn completion.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_creation_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u64>,
}

impl Usage {
    pub fn new(input_tokens: u64, output_tokens: u64) -> Self {
        Self {
            input_tokens,
            output_tokens,
            ..Default::default()
        }
    }

    pub fn with_cache_read(mut self, tokens: u64) -> Self {
        self.cache_read_tokens = Some(tokens);
        self
    }

    pub fn with_cache_creation(mut self, tokens: u64) -> Self {
        self.cache_creation_tokens = Some(tokens);
        self
    }

    pub fn with_reasoning(mut self, tokens: u64) -> Self {
        self.reasoning_tokens = Some(tokens);
        self
    }
}

/// Citation attached to visible assistant text or search outputs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Citation {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cited_text: Option<String>,
}

/// Tool/function invocation emitted by the simulated model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallSpec {
    #[serde(default)]
    pub id: String,
    /// Optional distinct Responses `item.id` (auto-generated distinct from `call_id` when empty).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    pub name: String,
    /// JSON object/value or raw JSON string (useful for partial/custom arguments).
    pub arguments: Value,
    /// Split serialized arguments into streaming chunks of this many chars (0 = single chunk).
    #[serde(default)]
    pub chunk_chars: usize,
    /// Optional Responses custom_tool_call mode (sends raw string input instead of JSON object).
    #[serde(default)]
    pub custom_tool: bool,
    /// Optional per-call thought signature (e.g. Google/Gemini OpenAI-compatible extension).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thought_signature: Option<String>,
}

impl From<ToolCallSpec> for TurnEvent {
    fn from(spec: ToolCallSpec) -> Self {
        Self::ToolCall(spec)
    }
}

impl ToolCallSpec {
    pub fn new(id: impl Into<String>, name: impl Into<String>, arguments: Value) -> Self {
        Self {
            id: id.into(),
            item_id: None,
            name: name.into(),
            arguments,
            chunk_chars: 0,
            custom_tool: false,
            thought_signature: None,
        }
    }

    pub fn with_chunk_chars(mut self, chars: usize) -> Self {
        self.chunk_chars = chars;
        self
    }

    pub fn as_custom_tool(mut self) -> Self {
        self.custom_tool = true;
        self
    }

    pub fn arguments_string(&self) -> String {
        match &self.arguments {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        }
    }
}

/// Provider-executed / native hosted tool output (web search, etc.).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NativeToolEvent {
    /// Complete web search lifecycle (started + completed in one step).
    WebSearch {
        #[serde(default)]
        id: String,
        query: String,
        #[serde(default)]
        results: Vec<WebSearchResult>,
    },
    /// Start a web search call in `in_progress` state without completing it yet
    /// (useful with `TurnEvent::Stall` to test mid-search interruption/recovery).
    WebSearchStarted {
        #[serde(default)]
        id: String,
        #[serde(default)]
        query: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchResult {
    pub url: String,
    #[serde(default)]
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encrypted_content: Option<String>,
}

/// Native server-side context compaction output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionOutput {
    #[serde(default)]
    pub id: String,
    /// Opaque encrypted payload for OpenAI Responses/Codex `compaction` output items.
    #[serde(default)]
    pub encrypted_content: String,
    /// Summary content for Anthropic `compaction` content blocks.
    #[serde(default)]
    pub summary: String,
    /// Optional signature for Anthropic compaction blocks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    /// Whether Anthropic should pause with `stop_reason = "compaction"` after the block.
    #[serde(default = "default_true")]
    pub pause_after_compaction: bool,
}

fn default_true() -> bool {
    true
}

impl CompactionOutput {
    pub fn new(encrypted_or_summary: impl Into<String>) -> Self {
        let s = encrypted_or_summary.into();
        Self {
            id: String::new(),
            encrypted_content: s.clone(),
            summary: s,
            signature: None,
            pause_after_compaction: true,
        }
    }

    pub fn with_id(mut self, id: impl Into<String>) -> Self {
        self.id = id.into();
        self
    }

    pub fn with_pause(mut self, pause: bool) -> Self {
        self.pause_after_compaction = pause;
        self
    }
}

/// Pre-stream HTTP error response (status != 200).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpErrorSpec {
    pub status: u16,
    #[serde(default = "default_error_type")]
    pub error_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default)]
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after_secs: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    /// Optional raw JSON body overriding the auto-formatted provider error envelope.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_body: Option<Value>,
    /// Optional raw text body (sent as `content_type` or `text/plain`, bypassing JSON wrapping).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_text: Option<String>,
    /// Optional explicit Content-Type header override for HTTP error responses.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
}

fn default_error_type() -> String {
    "api_error".into()
}

impl HttpErrorSpec {
    pub fn rate_limit(retry_after_secs: Option<u64>, message: impl Into<String>) -> Self {
        Self {
            status: 429,
            error_type: "rate_limit_error".into(),
            code: Some("rate_limit_exceeded".into()),
            message: message.into(),
            retry_after_secs,
            retry_after_ms: None,
            headers: BTreeMap::new(),
            raw_body: None,
            raw_text: None,
            content_type: None,
        }
    }

    pub fn with_retry_after_ms(mut self, ms: u64) -> Self {
        self.retry_after_ms = Some(ms);
        self
    }

    pub fn with_header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.insert(name.into(), value.into());
        self
    }

    pub fn new(status: u16, error_type: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status,
            error_type: error_type.into(),
            code: None,
            message: message.into(),
            retry_after_secs: None,
            retry_after_ms: None,
            headers: BTreeMap::new(),
            raw_body: None,
            raw_text: None,
            content_type: None,
        }
    }

    pub fn raw(status: u16, body: Value) -> Self {
        Self {
            status,
            error_type: "api_error".into(),
            code: None,
            message: String::new(),
            retry_after_secs: None,
            retry_after_ms: None,
            headers: BTreeMap::new(),
            raw_body: Some(body),
            raw_text: None,
            content_type: None,
        }
    }

    pub fn plain(status: u16, body: impl Into<String>) -> Self {
        Self {
            status,
            error_type: "api_error".into(),
            code: None,
            message: String::new(),
            retry_after_secs: None,
            retry_after_ms: None,
            headers: BTreeMap::new(),
            raw_body: None,
            raw_text: Some(body.into()),
            content_type: Some("text/plain".into()),
        }
    }
}

/// In-band wire error emitted after a stream has already started.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MidStreamErrorSpec {
    #[serde(default = "default_error_type")]
    pub error_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
}

/// One semantic step emitted during a single model turn.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TurnEvent {
    /// Emit visible text delta (optionally split into chunks by `chunk_chars`).
    Text {
        text: String,
        #[serde(default)]
        chunk_chars: usize,
        #[serde(default)]
        citations: Vec<Citation>,
    },
    /// Emit reasoning/thinking delta.
    Reasoning {
        text: String,
        #[serde(default)]
        chunk_chars: usize,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        encrypted_content: Option<String>,
    },
    /// Emit Anthropic `redacted_thinking` block.
    RedactedThinking { data: String },
    /// Emit a refusal message.
    Refusal { text: String },
    /// Emit a tool/function call (multiple calls in one turn produce parallel tool calls).
    ToolCall(ToolCallSpec),
    /// Emit a provider-hosted native tool event (e.g. web search).
    NativeTool(NativeToolEvent),
    /// Emit a native server-side context compaction item/block.
    NativeCompaction(CompactionOutput),
    /// Attach usage accounting (consumed when completing the turn).
    Usage(Usage),
    /// Sleep before emitting subsequent events.
    Delay { ms: u64 },
    /// Sleep for a random duration within [min_ms, max_ms] (seeded if configured).
    JitterDelay { min_ms: u64, max_ms: u64 },
    /// Hold the connection open indefinitely until cancelled or dropped.
    Stall,
    /// Abort the HTTP/WS request before streaming starts with a non-200 status.
    HttpError(HttpErrorSpec),
    /// Emit a protocol-level error event mid-stream (e.g. `response.failed`, Anthropic `error`).
    MidStreamError(MidStreamErrorSpec),
    /// Abruptly abort the HTTP chunked body / WS connection (causes client read error).
    DropConnection,
    /// Cleanly end the HTTP body / WS stream prematurely without sending terminal events (EOF).
    TruncateEof,
    /// Emit a raw JSON payload as an SSE `data: <json>\n\n` or WS text frame.
    RawJson { value: Value },
    /// Emit the protocol's initial stream-open frame immediately (`response.created`,
    /// `message_start`, or initial assistant role chunk) without emitting any content yet.
    StreamStart,
    /// Immediately close any currently open reasoning/message item (`response.output_item.done`
    /// or `content_block_stop`) before continuing or stalling.
    Flush,
    /// Emit an HTTP SSE comment frame (`: <comment>\n\n`); no-op on WebSocket / non-streaming.
    SseComment { comment: String },
    /// Emit raw bytes directly onto the HTTP response stream (escape hatch).
    #[serde(skip)]
    RawBytes(Bytes),
    /// Complete the turn normally with an explicit finish reason.
    Finish {
        #[serde(default)]
        reason: FinishReason,
    },
}

/// Complete declarative plan for one model turn.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnPlan {
    #[serde(default)]
    pub events: Vec<TurnEvent>,
    /// Optional explicit response/message ID; auto-generated when None.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_id: Option<String>,
    /// Optional override for the model name echoed in wire responses.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_override: Option<String>,
    /// Optional explicit TTFT delay in milliseconds (overrides dynamic `LatencyProfile` when set).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttft_ms: Option<u64>,
    /// Optional per-chunk delay in milliseconds applied when chunking text/reasoning/tool args.
    #[serde(default)]
    pub chunk_delay_ms: u64,
    /// Optional wire-level SSE framing poison (UTF-8 boundary split, CRLF, comments).
    #[serde(default)]
    pub wire_poison: crate::schema_synth::WirePoisonConfig,
    /// Extra HTTP headers attached to the response (e.g. `x-request-id`, `x-codex-turn-state`).
    #[serde(default)]
    pub response_headers: BTreeMap<String, String>,
    /// Force `Connection: close` on HTTP/1.1 even if the client requested keep-alive.
    #[serde(default)]
    pub close_connection: bool,
    /// Optional signal notified as soon as this turn's HTTP/WS stream ends or is closed by the client.
    #[serde(skip)]
    pub on_close: Option<CloseSignal>,
}

impl TurnPlan {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn text(text: impl Into<String>) -> Self {
        Self::new().push_text(text).finish(FinishReason::Stop)
    }

    pub fn http_error(spec: HttpErrorSpec) -> Self {
        Self::new().push(TurnEvent::HttpError(spec))
    }

    pub fn stall() -> Self {
        Self::new().push(TurnEvent::Stall)
    }

    pub fn push(mut self, event: impl Into<TurnEvent>) -> Self {
        self.events.push(event.into());
        self
    }

    pub fn push_text(self, text: impl Into<String>) -> Self {
        self.push(TurnEvent::Text {
            text: text.into(),
            chunk_chars: 0,
            citations: Vec::new(),
        })
    }

    pub fn push_text_chunked(self, text: impl Into<String>, chunk_chars: usize) -> Self {
        self.push(TurnEvent::Text {
            text: text.into(),
            chunk_chars,
            citations: Vec::new(),
        })
    }

    pub fn push_stream_start(self) -> Self {
        self.push(TurnEvent::StreamStart)
    }

    pub fn push_flush(self) -> Self {
        self.push(TurnEvent::Flush)
    }

    pub fn push_sse_comment(self, comment: impl Into<String>) -> Self {
        self.push(TurnEvent::SseComment {
            comment: comment.into(),
        })
    }

    pub fn push_reasoning(self, text: impl Into<String>) -> Self {
        self.push(TurnEvent::Reasoning {
            text: text.into(),
            chunk_chars: 0,
            signature: Some("mock-thinking-sig".into()),
            encrypted_content: None,
        })
    }

    pub fn push_reasoning_encrypted(
        self,
        text: impl Into<String>,
        encrypted_content: impl Into<String>,
    ) -> Self {
        self.push(TurnEvent::Reasoning {
            text: text.into(),
            chunk_chars: 0,
            signature: None,
            encrypted_content: Some(encrypted_content.into()),
        })
    }

    pub fn push_tool_call(
        self,
        id: impl Into<String>,
        name: impl Into<String>,
        arguments: Value,
    ) -> Self {
        self.push(TurnEvent::ToolCall(ToolCallSpec::new(id, name, arguments)))
    }

    pub fn push_custom_tool_call(
        self,
        id: impl Into<String>,
        name: impl Into<String>,
        input: impl Into<String>,
    ) -> Self {
        self.push(TurnEvent::ToolCall(
            ToolCallSpec::new(id, name, Value::String(input.into())).as_custom_tool(),
        ))
    }

    pub fn push_compaction(self, output: CompactionOutput) -> Self {
        self.push(TurnEvent::NativeCompaction(output))
    }

    pub fn with_usage(self, usage: Usage) -> Self {
        self.push(TurnEvent::Usage(usage))
    }

    pub fn with_delay(self, duration: Duration) -> Self {
        self.push(TurnEvent::Delay {
            ms: duration.as_millis() as u64,
        })
    }

    pub fn with_ttft_ms(mut self, ms: u64) -> Self {
        self.ttft_ms = Some(ms);
        self
    }

    pub fn with_chunk_delay_ms(mut self, ms: u64) -> Self {
        self.chunk_delay_ms = ms;
        self
    }

    pub fn with_wire_poison(mut self, poison: crate::schema_synth::WirePoisonConfig) -> Self {
        self.wire_poison = poison;
        self
    }

    pub fn with_response_id(mut self, id: impl Into<String>) -> Self {
        self.response_id = Some(id.into());
        self
    }

    pub fn with_header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.response_headers.insert(name.into(), value.into());
        self
    }

    pub fn with_close_connection(mut self, close: bool) -> Self {
        self.close_connection = close;
        self
    }

    pub fn with_on_close(mut self, signal: impl Into<CloseSignal>) -> Self {
        self.on_close = Some(signal.into());
        self
    }

    pub fn finish(self, reason: FinishReason) -> Self {
        self.push(TurnEvent::Finish { reason })
    }

    /// Infer the default finish reason if no explicit `Finish` event was appended.
    pub fn inferred_finish_reason(&self) -> FinishReason {
        let mut has_tools = false;
        let mut has_compaction_pause = false;
        let mut has_refusal = false;
        for event in &self.events {
            match event {
                TurnEvent::Finish { reason } => return reason.clone(),
                TurnEvent::ToolCall(_) => has_tools = true,
                TurnEvent::NativeCompaction(c) if c.pause_after_compaction => {
                    has_compaction_pause = true;
                }
                TurnEvent::Refusal { .. } => has_refusal = true,
                _ => {}
            }
        }
        if has_tools {
            FinishReason::ToolCalls
        } else if has_compaction_pause {
            FinishReason::Compaction
        } else if has_refusal {
            FinishReason::Refusal
        } else {
            FinishReason::Stop
        }
    }
}
