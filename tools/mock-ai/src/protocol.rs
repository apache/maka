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
use std::hash::{Hash, Hasher};

/// Supported wire dialects served on the same mock server port.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Protocol {
    OpenaiChatCompletions,
    OpenaiResponsesHttp,
    OpenaiResponsesWs,
    AnthropicMessages,
}

impl Protocol {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OpenaiChatCompletions => "openai-chat-completions",
            Self::OpenaiResponsesHttp => "openai-responses-http",
            Self::OpenaiResponsesWs => "openai-responses-ws",
            Self::AnthropicMessages => "anthropic-messages",
        }
    }

    pub fn is_responses(self) -> bool {
        matches!(self, Self::OpenaiResponsesHttp | Self::OpenaiResponsesWs)
    }
}

/// Transport metadata for an incoming turn request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Transport {
    Http,
    WebSocket {
        connection_id: u64,
        turn_on_connection: usize,
    },
}

/// Optional authentication enforcement for incoming requests.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AuthPolicy {
    /// Accept any request (default for zero-config tests).
    #[default]
    AllowAll,
    /// Require `Authorization: Bearer <token>` (or `x-api-key: <token>` for Anthropic).
    ApiKey { token: String },
    /// Require an exact header key/value match (case-insensitive header name).
    Header { name: String, value: String },
}

impl AuthPolicy {
    pub fn verify(&self, headers: &BTreeMap<String, String>) -> bool {
        match self {
            Self::AllowAll => true,
            Self::ApiKey { token } => {
                let bearer = format!("Bearer {token}");
                headers.get("authorization").is_some_and(|v| v == &bearer)
                    || headers.get("x-api-key").is_some_and(|v| v == token)
            }
            Self::Header { name, value } => headers
                .get(&name.to_ascii_lowercase())
                .is_some_and(|v| v == value),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NormalizedRole {
    System,
    Developer,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedMessage {
    pub role: NormalizedRole,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub has_image: bool,
    #[serde(default)]
    pub is_compaction_item: bool,
    #[serde(default)]
    pub kind: NormalizedMessageKind,
    #[serde(default)]
    pub message_index: usize,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<NormalizedToolCall>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub thinking: Vec<NormalizedThinking>,
    #[serde(default)]
    pub is_error: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NormalizedMessageKind {
    #[default]
    Message,
    FunctionCall,
    CustomToolCall,
    FunctionCallOutput,
    CustomToolCallOutput,
    ToolUse,
    ToolResult,
    Thinking,
    Compaction,
    Reasoning {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        encrypted_content: Option<String>,
        #[serde(default)]
        summary: Vec<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NormalizedThinking {
    Thinking {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
    },
    RedactedThinking {
        data: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedToolCall {
    pub id: Option<String>,
    pub item_id: Option<String>,
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    pub payload: NormalizedToolCallPayload,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum NormalizedToolCallPayload {
    FunctionArguments(String),
    FreeformInput(String),
    AnthropicInput(Value),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedTool {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parameters: Option<Value>,
    #[serde(default)]
    pub tool_kind: ToolDeclKind,
    #[serde(default)]
    pub deferred: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToolDeclKind {
    #[default]
    Function,
    Freeform {
        format: Option<Value>,
    },
    ProviderBuiltin,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RequestSizeBreakdown {
    pub wire_bytes: usize,
    pub body_bytes: usize,
    pub tools_bytes: usize,
    pub system_bytes: usize,
    pub history_bytes: usize,
    pub estimated_history_tokens: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RequestOptions {
    pub stream_include_usage: bool,
    pub tool_choice: Option<Value>,
    pub parallel_tool_calls: Option<bool>,
    pub reasoning_effort: Option<String>,
    pub include: Vec<String>,
    pub store: Option<bool>,
    pub generate: Option<bool>,
    pub max_output_tokens: Option<u64>,
    pub thinking_enabled: bool,
    pub anthropic_pause_after_compaction: bool,
    pub anthropic_compaction_trigger_tokens: Option<u64>,
}

/// Protocol-independent view of a single incoming model turn request.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedRequest {
    pub sequence: u64,
    pub protocol: Protocol,
    pub transport: Transport,
    pub path: String,
    pub headers: BTreeMap<String, String>,
    pub model: String,
    pub stream: bool,
    /// Stable key grouping turns belonging to the same logical conversation/session.
    pub session_key: String,
    /// Byte length of the serialized request body (O(1) context-size signal).
    pub prompt_bytes: usize,
    #[serde(default)]
    pub size_breakdown: RequestSizeBreakdown,
    #[serde(default)]
    pub options: RequestOptions,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_text: Option<String>,
    pub messages: Vec<NormalizedMessage>,
    pub tools: Vec<NormalizedTool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_response_id: Option<String>,
    /// True when a Responses/Codex request includes a `compaction_trigger` input item.
    pub has_compaction_trigger: bool,
    /// True when an Anthropic request enables server-side compaction (`context_management` / beta header).
    pub anthropic_compaction_enabled: bool,
    /// Estimated token count of the incoming prompt (rough 4 bytes/token fallback).
    pub estimated_input_tokens: u64,
    /// Full raw JSON request payload for protocol-level assertions.
    pub raw_body: Value,
    /// Exact raw wire payload bytes as received over HTTP or WebSocket.
    #[serde(skip)]
    pub raw_wire_bytes: Bytes,
}

impl NormalizedRequest {
    /// Extract a stable caller API key / bearer token identifier for per-key rate limiting.
    pub fn api_key(&self) -> &str {
        if let Some(k) = self.headers.get("x-api-key")
            && !k.is_empty()
        {
            return k.as_str();
        }
        if let Some(auth) = self.headers.get("authorization") {
            let trimmed = auth.trim();
            if let Some(rest) = trimmed
                .strip_prefix("Bearer ")
                .or_else(|| trimmed.strip_prefix("bearer "))
                && !rest.is_empty()
            {
                return rest;
            }
            if !trimmed.is_empty() {
                return trimmed;
            }
        }
        "anonymous"
    }

    /// Concatenate all text across system + messages (handy for matcher checks).
    pub fn all_text(&self) -> String {
        let mut out = String::new();
        if let Some(sys) = &self.system_text {
            out.push_str(sys);
            out.push('\n');
        }
        for msg in &self.messages {
            if !msg.text.is_empty() {
                out.push_str(&msg.text);
                out.push('\n');
            }
        }
        out
    }

    pub fn last_user_text(&self) -> Option<&str> {
        self.messages
            .iter()
            .rev()
            .find(|m| m.role == NormalizedRole::User && !m.text.is_empty())
            .map(|m| m.text.as_str())
    }

    pub fn last_tool_result(&self) -> Option<&NormalizedMessage> {
        self.messages
            .iter()
            .rev()
            .find(|m| m.role == NormalizedRole::Tool)
    }

    pub fn has_tool(&self, name: &str) -> bool {
        self.tools.iter().any(|t| t.name == name)
    }

    pub fn tool_result_count(&self) -> usize {
        self.messages
            .iter()
            .filter(|m| m.role == NormalizedRole::Tool)
            .count()
    }

    /// Approximate number of assistant turns already present in the history.
    pub fn history_assistant_turns(&self) -> usize {
        self.messages
            .iter()
            .filter(|m| m.role == NormalizedRole::Assistant)
            .count()
    }
}

/// Normalize a parsed JSON request body for any supported wire protocol.
pub fn normalize_request(
    sequence: u64,
    protocol: Protocol,
    transport: Transport,
    path: String,
    headers: BTreeMap<String, String>,
    raw_wire_bytes: Bytes,
    raw_body: Value,
) -> NormalizedRequest {
    let prompt_bytes = raw_wire_bytes.len();
    let model = raw_body["model"]
        .as_str()
        .unwrap_or("mock-model")
        .to_owned();
    let stream =
        protocol == Protocol::OpenaiResponsesWs || raw_body["stream"].as_bool().unwrap_or(false);
    let (system_key, history_key) = match protocol {
        Protocol::AnthropicMessages => (Some("system"), "messages"),
        Protocol::OpenaiChatCompletions => (None, "messages"),
        Protocol::OpenaiResponsesHttp | Protocol::OpenaiResponsesWs => {
            (Some("instructions"), "input")
        }
    };

    let mut size_breakdown = RequestSizeBreakdown {
        wire_bytes: prompt_bytes,
        // The current WS create event is flat, so the payload is also the request body.
        body_bytes: if raw_wire_bytes.is_empty() {
            json_size(&raw_body)
        } else {
            prompt_bytes
        },
        tools_bytes: raw_body.get("tools").map_or(0, json_size),
        ..Default::default()
    };
    let mut system_text = None;
    if let Some(system) = system_key.and_then(|key| raw_body.get(key)) {
        size_breakdown.system_bytes = json_size(system);
        append_text(&mut system_text, extract_content(system).0);
    }

    let mut messages = Vec::new();
    let mut has_compaction_trigger = false;
    let mut history_text_bytes = 0;
    match &raw_body[history_key] {
        Value::String(text) if protocol.is_responses() => {
            size_breakdown.history_bytes = json_size(&raw_body[history_key]);
            history_text_bytes = text.len();
            messages.push(NormalizedMessage::new(
                0,
                NormalizedRole::User,
                text.clone(),
                false,
            ));
        }
        Value::Array(items) => {
            size_breakdown.history_bytes = 2; // JSON array brackets.
            let mut history_items = 0;
            for (index, item) in items.iter().enumerate() {
                let role = normalized_role(item["role"].as_str());
                let serialized_bytes = json_size(item);
                if matches!(role, NormalizedRole::System | NormalizedRole::Developer) {
                    size_breakdown.system_bytes += serialized_bytes;
                    append_text(&mut system_text, extract_content(&item["content"]).0);
                } else {
                    size_breakdown.history_bytes +=
                        serialized_bytes + usize::from(history_items != 0);
                    history_items += 1;
                }

                let start = messages.len();
                match protocol {
                    Protocol::AnthropicMessages => {
                        normalize_anthropic_message(index, role, item, &mut messages)
                    }
                    Protocol::OpenaiChatCompletions => {
                        messages.push(normalize_chat_message(index, role, item))
                    }
                    _ if item["type"] == "compaction_trigger" => has_compaction_trigger = true,
                    _ => messages.push(normalize_response_item(index, role, item)),
                }
                for message in &messages[start..] {
                    if !matches!(
                        message.role,
                        NormalizedRole::System | NormalizedRole::Developer
                    ) {
                        history_text_bytes += message.estimated_text_bytes();
                    }
                }
            }
        }
        _ => {}
    }
    size_breakdown.estimated_history_tokens = (history_text_bytes as u64).div_ceil(4);

    let tools = tool_declarations(protocol, &raw_body["tools"])
        .filter_map(|(tool, namespace)| normalize_tool(protocol, tool, namespace))
        .collect();
    let compaction_edit = (protocol == Protocol::AnthropicMessages)
        .then(|| anthropic_compaction_edit(&raw_body, &headers))
        .flatten();
    let options = request_options(protocol, &raw_body, compaction_edit);
    let anthropic_compaction_enabled = compaction_edit.is_some();
    let previous_response_id = owned_str(&raw_body["previous_response_id"]);
    let session_key = derive_session_key(&headers, &raw_body, &messages, &transport);

    NormalizedRequest {
        sequence,
        protocol,
        transport,
        path,
        headers,
        model,
        stream,
        session_key,
        prompt_bytes,
        size_breakdown,
        options,
        system_text,
        messages,
        tools,
        previous_response_id,
        has_compaction_trigger,
        anthropic_compaction_enabled,
        estimated_input_tokens: (prompt_bytes as u64).max(4) / 4,
        raw_body,
        raw_wire_bytes,
    }
}

fn json_size(value: &Value) -> usize {
    struct Counter(usize);

    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 += bytes.len();
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    let mut counter = Counter(0);
    serde_json::to_writer(&mut counter, value).expect("serializing JSON to a byte counter");
    counter.0
}

fn owned_str(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

fn append_text(target: &mut Option<String>, text: String) {
    if text.is_empty() {
        return;
    }
    match target {
        Some(target) => {
            target.push('\n');
            target.push_str(&text);
        }
        None => *target = Some(text),
    }
}

fn normalized_role(role: Option<&str>) -> NormalizedRole {
    match role {
        Some("system") => NormalizedRole::System,
        Some("developer") => NormalizedRole::Developer,
        Some("assistant") => NormalizedRole::Assistant,
        Some("tool") => NormalizedRole::Tool,
        _ => NormalizedRole::User,
    }
}

impl NormalizedMessage {
    fn new(message_index: usize, role: NormalizedRole, text: String, has_image: bool) -> Self {
        Self {
            role,
            text,
            has_image,
            message_index,
            tool_call_id: None,
            tool_name: None,
            is_compaction_item: false,
            kind: NormalizedMessageKind::Message,
            tool_calls: Vec::new(),
            reasoning_content: None,
            thinking: Vec::new(),
            is_error: false,
        }
    }

    fn for_content(index: usize, role: NormalizedRole, content: &Value) -> Self {
        let (text, has_image) = extract_content(content);
        Self::new(index, role, text, has_image)
    }

    fn estimated_text_bytes(&self) -> usize {
        let mut bytes = self.text.len() + self.reasoning_content.as_ref().map_or(0, String::len);
        match self.kind {
            NormalizedMessageKind::Message => {
                bytes += self
                    .tool_calls
                    .iter()
                    .map(|call| match &call.payload {
                        NormalizedToolCallPayload::FunctionArguments(raw)
                        | NormalizedToolCallPayload::FreeformInput(raw) => raw.len(),
                        NormalizedToolCallPayload::AnthropicInput(value) => json_size(value),
                    })
                    .sum::<usize>();
            }
            NormalizedMessageKind::Thinking => {
                bytes += self
                    .thinking
                    .iter()
                    .map(|block| match block {
                        NormalizedThinking::Thinking { text, .. } => text.len(),
                        NormalizedThinking::RedactedThinking { .. } => 0,
                    })
                    .sum::<usize>();
            }
            _ => {}
        }
        bytes
    }
}

fn normalize_chat_message(index: usize, role: NormalizedRole, item: &Value) -> NormalizedMessage {
    let mut message = NormalizedMessage::for_content(index, role, &item["content"]);
    message.tool_call_id = owned_str(&item["tool_call_id"]);
    message.tool_name = owned_str(&item["name"]);
    message.reasoning_content = owned_str(&item["reasoning_content"]);
    message.tool_calls = item["tool_calls"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|call| {
            let (decl, payload) = if call["type"] == "custom" {
                let custom = &call["custom"];
                (
                    custom,
                    NormalizedToolCallPayload::FreeformInput(
                        custom["input"].as_str().unwrap_or_default().into(),
                    ),
                )
            } else {
                let function = &call["function"];
                (
                    function,
                    NormalizedToolCallPayload::FunctionArguments(
                        function["arguments"].as_str().unwrap_or_default().into(),
                    ),
                )
            };
            NormalizedToolCall {
                id: owned_str(&call["id"]),
                item_id: None,
                name: owned_str(&decl["name"]),
                namespace: None,
                payload,
            }
        })
        .collect();
    message
}

fn normalize_response_item(index: usize, role: NormalizedRole, item: &Value) -> NormalizedMessage {
    use NormalizedMessageKind as Kind;
    match item["type"].as_str() {
        Some(kind @ ("function_call" | "custom_tool_call")) => {
            let freeform = kind == "custom_tool_call";
            let input = item[if freeform { "input" } else { "arguments" }]
                .as_str()
                .unwrap_or_default();
            let mut message =
                NormalizedMessage::new(index, NormalizedRole::Assistant, input.into(), false);
            message.kind = if freeform {
                Kind::CustomToolCall
            } else {
                Kind::FunctionCall
            };
            message.tool_call_id = owned_str(&item["call_id"]);
            message.tool_name = owned_str(&item["name"]);
            message.tool_calls.push(NormalizedToolCall {
                id: message.tool_call_id.clone(),
                item_id: owned_str(&item["id"]),
                name: message.tool_name.clone(),
                namespace: owned_str(&item["namespace"]),
                payload: if freeform {
                    NormalizedToolCallPayload::FreeformInput(input.into())
                } else {
                    NormalizedToolCallPayload::FunctionArguments(input.into())
                },
            });
            message
        }
        Some(kind @ ("function_call_output" | "custom_tool_call_output")) => {
            let mut message =
                NormalizedMessage::for_content(index, NormalizedRole::Tool, &item["output"]);
            message.kind = if kind == "custom_tool_call_output" {
                Kind::CustomToolCallOutput
            } else {
                Kind::FunctionCallOutput
            };
            message.tool_call_id = owned_str(&item["call_id"]);
            message
        }
        Some("reasoning") => {
            let summary: Vec<_> = item["summary"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|part| owned_str(&part["text"]))
                .collect();
            let mut message =
                NormalizedMessage::new(index, NormalizedRole::Assistant, summary.join("\n"), false);
            message.kind = Kind::Reasoning {
                encrypted_content: owned_str(&item["encrypted_content"]),
                summary,
            };
            message
        }
        Some("compaction") => {
            let mut message = NormalizedMessage::new(
                index,
                NormalizedRole::Assistant,
                item["encrypted_content"]
                    .as_str()
                    .unwrap_or_default()
                    .into(),
                false,
            );
            message.kind = Kind::Compaction;
            message.is_compaction_item = true;
            message
        }
        _ => NormalizedMessage::for_content(index, role, &item["content"]),
    }
}

fn normalize_anthropic_message(
    index: usize,
    role: NormalizedRole,
    item: &Value,
    messages: &mut Vec<NormalizedMessage>,
) {
    use NormalizedMessageKind as Kind;
    let Some(blocks) = item["content"].as_array() else {
        messages.push(NormalizedMessage::for_content(
            index,
            role,
            &item["content"],
        ));
        return;
    };
    let mut text = None;
    let mut has_image = false;
    for block in blocks {
        let kind = match block["type"].as_str() {
            Some("text") => {
                if let Some(part) = block["text"].as_str() {
                    append_text(&mut text, part.into());
                }
                continue;
            }
            Some("image") => {
                has_image = true;
                continue;
            }
            Some("tool_result") => Kind::ToolResult,
            Some("tool_use") => Kind::ToolUse,
            Some("thinking" | "redacted_thinking") => Kind::Thinking,
            Some("compaction") => Kind::Compaction,
            _ => continue,
        };
        if text.is_some() || has_image {
            messages.push(NormalizedMessage::new(
                index,
                role.clone(),
                text.take().unwrap_or_default(),
                std::mem::take(&mut has_image),
            ));
        }

        let mut message = match kind {
            Kind::ToolResult => {
                let mut message =
                    NormalizedMessage::for_content(index, NormalizedRole::Tool, &block["content"]);
                message.tool_call_id = owned_str(&block["tool_use_id"]);
                message.is_error = block["is_error"].as_bool().unwrap_or(false);
                message
            }
            Kind::ToolUse => {
                let mut message = NormalizedMessage::new(
                    index,
                    NormalizedRole::Assistant,
                    block["input"].to_string(),
                    false,
                );
                message.tool_call_id = owned_str(&block["id"]);
                message.tool_name = owned_str(&block["name"]);
                message.tool_calls.push(NormalizedToolCall {
                    id: message.tool_call_id.clone(),
                    item_id: None,
                    name: message.tool_name.clone(),
                    namespace: None,
                    payload: NormalizedToolCallPayload::AnthropicInput(block["input"].clone()),
                });
                message
            }
            Kind::Thinking => {
                let mut message = NormalizedMessage::new(index, role.clone(), String::new(), false);
                message.thinking.push(if block["type"] == "thinking" {
                    NormalizedThinking::Thinking {
                        text: block["thinking"].as_str().unwrap_or_default().into(),
                        signature: owned_str(&block["signature"]),
                    }
                } else {
                    NormalizedThinking::RedactedThinking {
                        data: block["data"].as_str().unwrap_or_default().into(),
                    }
                });
                message
            }
            Kind::Compaction => {
                let mut message = NormalizedMessage::for_content(
                    index,
                    NormalizedRole::Assistant,
                    &block["content"],
                );
                message.is_compaction_item = true;
                message
            }
            _ => unreachable!(),
        };
        message.kind = kind;
        messages.push(message);
    }
    if text.is_some() || has_image || blocks.is_empty() {
        messages.push(NormalizedMessage::new(
            index,
            role,
            text.unwrap_or_default(),
            has_image,
        ));
    }
}

pub(crate) fn tool_declarations(
    protocol: Protocol,
    tools: &Value,
) -> impl Iterator<Item = (&Value, Option<&str>)> {
    tools
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(move |tool| {
            let (entries, namespace) = if protocol.is_responses() && tool["type"] == "namespace" {
                match (tool["name"].as_str(), tool["tools"].as_array()) {
                    (Some(name), Some(entries)) => (entries.as_slice(), Some(name)),
                    _ => (&[][..], None),
                }
            } else {
                (std::slice::from_ref(tool), None)
            };
            entries.iter().map(move |entry| (entry, namespace))
        })
}

fn normalize_tool(
    protocol: Protocol,
    tool: &Value,
    namespace: Option<&str>,
) -> Option<NormalizedTool> {
    let kind = tool["type"].as_str();
    let declaration = match protocol {
        Protocol::OpenaiChatCompletions => match kind {
            Some("function") => tool.get("function").unwrap_or(tool),
            Some("custom") => tool.get("custom").unwrap_or(tool),
            _ => tool,
        },
        _ => tool,
    };
    let name = declaration["name"].as_str().or(kind)?;
    let (tool_kind, parameter_key) = match (protocol, kind) {
        (Protocol::AnthropicMessages, None | Some("custom")) => {
            (ToolDeclKind::Function, "input_schema")
        }
        (Protocol::AnthropicMessages, _) => (ToolDeclKind::ProviderBuiltin, "input_schema"),
        (_, Some("custom")) => (
            ToolDeclKind::Freeform {
                format: declaration.get("format").cloned(),
            },
            "parameters",
        ),
        (_, None | Some("function")) => (ToolDeclKind::Function, "parameters"),
        _ => (ToolDeclKind::ProviderBuiltin, "parameters"),
    };
    Some(NormalizedTool {
        name: name.into(),
        namespace: namespace.map(str::to_owned),
        kind: kind.map(str::to_owned),
        parameters: declaration.get(parameter_key).cloned(),
        tool_kind,
        deferred: declaration["defer_loading"]
            .as_bool()
            .or_else(|| tool["defer_loading"].as_bool())
            .unwrap_or(false),
    })
}

fn anthropic_compaction_edit<'a>(
    body: &'a Value,
    headers: &BTreeMap<String, String>,
) -> Option<&'a Value> {
    let beta_enabled = headers.get("anthropic-beta").is_some_and(|header| {
        header
            .split(',')
            .map(str::trim)
            .any(|beta| beta.starts_with("compact-") || beta.starts_with("compaction-"))
    });
    body.pointer("/context_management/edits")?
        .as_array()?
        .iter()
        .find(|edit| {
            edit["type"].as_str().is_some_and(|kind| {
                kind.starts_with("compact_") || (beta_enabled && kind == "compact")
            })
        })
}

fn request_options(
    protocol: Protocol,
    body: &Value,
    compaction_edit: Option<&Value>,
) -> RequestOptions {
    let reasoning_effort = match protocol {
        Protocol::AnthropicMessages => body.pointer("/output_config/effort"),
        Protocol::OpenaiChatCompletions => body.get("reasoning_effort"),
        _ => body.pointer("/reasoning/effort"),
    };
    let max_output_tokens = match protocol {
        Protocol::OpenaiChatCompletions => body["max_completion_tokens"]
            .as_u64()
            .or_else(|| body["max_tokens"].as_u64()),
        Protocol::AnthropicMessages => body["max_tokens"].as_u64(),
        _ => body["max_output_tokens"].as_u64(),
    };
    RequestOptions {
        stream_include_usage: body
            .pointer("/stream_options/include_usage")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        tool_choice: body.get("tool_choice").cloned(),
        parallel_tool_calls: match protocol {
            Protocol::AnthropicMessages
                if body.pointer("/tool_choice/disable_parallel_tool_use")
                    == Some(&Value::Bool(true)) =>
            {
                Some(false)
            }
            _ => body["parallel_tool_calls"].as_bool(),
        },
        reasoning_effort: reasoning_effort.and_then(owned_str),
        include: body["include"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(owned_str)
            .collect(),
        store: body["store"].as_bool(),
        generate: body["generate"].as_bool(),
        max_output_tokens,
        thinking_enabled: matches!(
            body.pointer("/thinking/type").and_then(Value::as_str),
            Some("enabled" | "adaptive")
        ),
        anthropic_pause_after_compaction: compaction_edit
            .and_then(|edit| edit["pause_after_compaction"].as_bool())
            .unwrap_or(false),
        anthropic_compaction_trigger_tokens: compaction_edit.and_then(|edit| {
            let trigger = &edit["trigger"];
            if trigger["type"] != "input_tokens" {
                return None;
            }
            let value = &trigger["value"];
            value.as_u64().or_else(|| {
                // Some clients serialize the integer threshold as a JSON float.
                let value = value.as_f64()?;
                (value >= 0.0 && value < u64::MAX as f64 && value.fract() == 0.0)
                    .then_some(value as u64)
            })
        }),
    }
}

fn extract_content(value: &Value) -> (String, bool) {
    match value {
        Value::String(s) => (s.clone(), false),
        Value::Array(parts) => {
            let mut texts = Vec::new();
            let mut has_image = false;
            for part in parts {
                match part["type"].as_str().unwrap_or("") {
                    "text" | "input_text" | "output_text" => {
                        if let Some(t) = part["text"].as_str() {
                            texts.push(t.to_owned());
                        }
                    }
                    "image" | "image_url" | "input_image" => {
                        has_image = true;
                    }
                    _ => {
                        if let Some(t) = part["text"].as_str() {
                            texts.push(t.to_owned());
                        }
                    }
                }
            }
            (texts.join("\n"), has_image)
        }
        _ => (String::new(), false),
    }
}

fn derive_session_key(
    headers: &BTreeMap<String, String>,
    raw_body: &Value,
    messages: &[NormalizedMessage],
    transport: &Transport,
) -> String {
    for hdr in [
        "x-maka-session-id",
        "x-session-id",
        "session_id",
        "x-codex-turn-state",
    ] {
        if let Some(v) = headers.get(hdr)
            && !v.is_empty()
        {
            return v.clone();
        }
    }
    if let Some(key) = raw_body["prompt_cache_key"].as_str()
        && !key.is_empty()
    {
        return key.to_owned();
    }
    if let Transport::WebSocket { connection_id, .. } = transport {
        return format!("ws:{connection_id}");
    }
    if let Some(prev) = raw_body["previous_response_id"].as_str()
        && !prev.is_empty()
    {
        return format!("chain:{prev}");
    }
    // Stable hash of the first user message so multi-turn HTTP requests group together.
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    if let Some(first_user) = messages.iter().find(|m| m.role == NormalizedRole::User) {
        first_user.text.hash(&mut hasher);
    } else if let Some(first) = messages.first() {
        first.text.hash(&mut hasher);
    }
    format!("conv:{:016x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn normalize(
        protocol: Protocol,
        body: Value,
        headers: BTreeMap<String, String>,
    ) -> NormalizedRequest {
        let bytes = Bytes::from(body.to_string());
        normalize_request(
            1,
            protocol,
            Transport::Http,
            "/test".into(),
            headers,
            bytes,
            body,
        )
    }

    #[test]
    fn chat_history_preserves_tool_calls_reasoning_and_accounts_for_images() {
        let body = json!({
            "stream_options": { "include_usage": true },
            "max_completion_tokens": 24,
            "parallel_tool_calls": false,
            "reasoning_effort": "high",
            "tools": [{ "type": "function", "function": { "name": "look", "parameters": { "type": "object" } } }],
            "messages": [
                { "role": "system", "content": "system prompt" },
                { "role": "user", "content": [
                    { "type": "text", "text": "look" },
                    { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAAAAAA" } },
                ] },
                { "role": "assistant", "content": null, "reasoning_content": "work", "tool_calls": [
                    { "id": "call_1", "type": "function", "function": { "name": "look", "arguments": "{\"x\":1}" } },
                ] },
            ],
        });
        let request = normalize(
            Protocol::OpenaiChatCompletions,
            body.clone(),
            BTreeMap::new(),
        );
        assert_eq!(
            request.size_breakdown,
            RequestSizeBreakdown {
                wire_bytes: body.to_string().len(),
                body_bytes: body.to_string().len(),
                tools_bytes: body["tools"].to_string().len(),
                system_bytes: body["messages"][0].to_string().len(),
                history_bytes: json!([body["messages"][1], body["messages"][2]])
                    .to_string()
                    .len(),
                estimated_history_tokens: 4,
            }
        );
        assert!(request.messages[1].has_image);
        assert_eq!(
            request.messages[2].reasoning_content.as_deref(),
            Some("work")
        );
        assert_eq!(
            request.messages[2].tool_calls,
            vec![NormalizedToolCall {
                id: Some("call_1".into()),
                item_id: None,
                name: Some("look".into()),
                namespace: None,
                payload: NormalizedToolCallPayload::FunctionArguments("{\"x\":1}".into()),
            }]
        );
        assert!(request.options.stream_include_usage);
        assert_eq!(request.options.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(request.options.parallel_tool_calls, Some(false));
        assert_eq!(request.options.max_output_tokens, Some(24));
    }

    #[test]
    fn anthropic_preserves_signed_and_redacted_thinking_and_tool_failure() {
        let mut body = json!({
            "thinking": { "type": "adaptive" },
            "context_management": { "edits": [{ "type": "clear_tool_uses_20250919" }] },
            "tools": [{ "name": "lookup", "input_schema": {"type": "object"}, "defer_loading": true }],
            "messages": [
                { "role": "assistant", "content": [
                    { "type": "thinking", "thinking": "thought", "signature": "signed" },
                    { "type": "redacted_thinking", "data": "opaque" },
                ] },
                { "role": "user", "content": [
                    { "type": "tool_result", "tool_use_id": "toolu_1", "content": "failed", "is_error": true },
                    { "type": "text", "text": "try again" },
                ] },
            ],
        });
        let headers = BTreeMap::from([("anthropic-beta".into(), "compact-2026-01-12".into())]);
        let request = normalize(Protocol::AnthropicMessages, body.clone(), headers.clone());
        assert!(!request.anthropic_compaction_enabled);
        assert!(request.options.thinking_enabled);
        assert_eq!(
            request.messages[0].thinking,
            vec![NormalizedThinking::Thinking {
                text: "thought".into(),
                signature: Some("signed".into())
            }]
        );
        assert_eq!(
            request.messages[1].thinking,
            vec![NormalizedThinking::RedactedThinking {
                data: "opaque".into()
            }]
        );
        assert_eq!(request.messages[2].kind, NormalizedMessageKind::ToolResult);
        assert!(request.messages[2].is_error);
        assert_eq!(
            request.messages[2].message_index,
            request.messages[3].message_index
        );
        assert_eq!(request.messages[3].text, "try again");
        assert!(request.tools[0].deferred);
        body["context_management"]["edits"][0] = json!({
            "type": "compact_20260112", "trigger": { "type": "input_tokens", "value": 80_000.0 },
            "pause_after_compaction": true,
        });
        let request = normalize(Protocol::AnthropicMessages, body, headers);
        assert!(request.anthropic_compaction_enabled);
        assert!(request.options.anthropic_pause_after_compaction);
        assert_eq!(
            request.options.anthropic_compaction_trigger_tokens,
            Some(80_000)
        );
    }

    #[test]
    fn responses_preserves_item_order_and_freeform_grammar() {
        let format = json!({ "type": "grammar", "syntax": "lark", "definition": "start: /.+/" });
        let request = normalize(
            Protocol::OpenaiResponsesHttp,
            json!({
                "include": ["reasoning.encrypted_content"],
                "store": false, "generate": false,
                "tools": [
                    { "type": "custom", "name": "apply_patch", "format": format },
                    { "type": "namespace", "name": "mcp__bench", "tools": [
                        { "type": "function", "name": "lookup", "defer_loading": true,
                          "parameters": { "type": "object" } },
                        { "type": "function", "name": "read_file", "defer_loading": false }
                    ] }
                ],
                "input": [
                    { "type": "reasoning", "encrypted_content": "enc", "summary": [{ "type": "summary_text", "text": "plan" }] },
                    { "type": "function_call", "id": "item_1", "call_id": "call_1", "name": "lookup", "namespace": "mcp__bench", "arguments": "{}" },
                    { "type": "custom_tool_call", "id": "item_2", "call_id": "call_2", "name": "apply_patch", "input": "raw\npatch" },
                    { "type": "custom_tool_call_output", "call_id": "call_2", "output": [{ "type": "input_text", "text": "done" }] },
                ],
            }),
            BTreeMap::new(),
        );
        assert_eq!(
            request.tools[0].tool_kind,
            ToolDeclKind::Freeform {
                format: Some(format)
            }
        );
        assert_eq!(
            request
                .tools
                .iter()
                .map(|tool| (tool.name.as_str(), tool.namespace.as_deref(), tool.deferred))
                .collect::<Vec<_>>(),
            [
                ("apply_patch", None, false),
                ("lookup", Some("mcp__bench"), true),
                ("read_file", Some("mcp__bench"), false),
            ]
        );
        assert_eq!(request.tools[1].tool_kind, ToolDeclKind::Function);
        assert_eq!(request.tools[1].parameters, Some(json!({"type": "object"})));
        assert_eq!(
            request
                .messages
                .iter()
                .map(|message| (message.message_index, message.kind.clone()))
                .collect::<Vec<_>>(),
            vec![
                (
                    0,
                    NormalizedMessageKind::Reasoning {
                        encrypted_content: Some("enc".into()),
                        summary: vec!["plan".into()]
                    }
                ),
                (1, NormalizedMessageKind::FunctionCall),
                (2, NormalizedMessageKind::CustomToolCall),
                (3, NormalizedMessageKind::CustomToolCallOutput),
            ]
        );
        assert_eq!(
            request.messages[1].tool_calls,
            [NormalizedToolCall {
                id: Some("call_1".into()),
                item_id: Some("item_1".into()),
                name: Some("lookup".into()),
                namespace: Some("mcp__bench".into()),
                payload: NormalizedToolCallPayload::FunctionArguments("{}".into()),
            }]
        );
        assert_eq!(
            request.messages[2].tool_calls[0].payload,
            NormalizedToolCallPayload::FreeformInput("raw\npatch".into())
        );
        assert_eq!(
            request.messages[2].tool_calls[0].item_id.as_deref(),
            Some("item_2")
        );
        assert_eq!(request.messages[3].tool_call_id.as_deref(), Some("call_2"));
        assert_eq!(request.messages[3].text, "done");
        assert_eq!(request.options.include, ["reasoning.encrypted_content"]);
        assert_eq!(request.options.store, Some(false));
        assert_eq!(request.options.generate, Some(false));
    }
}
