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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedTool {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parameters: Option<Value>,
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
    let stream = match protocol {
        Protocol::OpenaiResponsesWs => true,
        _ => raw_body["stream"].as_bool().unwrap_or(false),
    };

    let mut system_parts = Vec::new();
    let mut messages = Vec::new();
    let mut tools = Vec::new();
    let mut has_compaction_trigger = false;

    match protocol {
        Protocol::OpenaiChatCompletions => {
            if let Some(arr) = raw_body["messages"].as_array() {
                for item in arr {
                    let role_str = item["role"].as_str().unwrap_or("user");
                    let role = match role_str {
                        "system" => NormalizedRole::System,
                        "developer" => NormalizedRole::Developer,
                        "assistant" => NormalizedRole::Assistant,
                        "tool" => NormalizedRole::Tool,
                        _ => NormalizedRole::User,
                    };
                    let (text, has_image) = extract_content(&item["content"]);
                    if matches!(role, NormalizedRole::System | NormalizedRole::Developer)
                        && !text.is_empty()
                    {
                        system_parts.push(text.clone());
                    }
                    messages.push(NormalizedMessage {
                        role,
                        text,
                        tool_call_id: item["tool_call_id"].as_str().map(str::to_owned),
                        tool_name: item["name"].as_str().map(str::to_owned),
                        has_image,
                        is_compaction_item: false,
                    });
                }
            }
            if let Some(arr) = raw_body["tools"].as_array() {
                for t in arr {
                    let name = t
                        .pointer("/function/name")
                        .or_else(|| t.get("name"))
                        .and_then(Value::as_str);
                    if let Some(name) = name {
                        let parameters = t
                            .pointer("/function/parameters")
                            .or_else(|| t.get("parameters"))
                            .cloned();
                        tools.push(NormalizedTool {
                            name: name.to_owned(),
                            kind: t["type"].as_str().map(str::to_owned),
                            parameters,
                        });
                    }
                }
            }
        }
        Protocol::OpenaiResponsesHttp | Protocol::OpenaiResponsesWs => {
            if let Some(inst) = raw_body["instructions"].as_str()
                && !inst.is_empty()
            {
                system_parts.push(inst.to_owned());
            }
            match &raw_body["input"] {
                Value::String(s) => {
                    messages.push(NormalizedMessage {
                        role: NormalizedRole::User,
                        text: s.clone(),
                        tool_call_id: None,
                        tool_name: None,
                        has_image: false,
                        is_compaction_item: false,
                    });
                }
                Value::Array(items) => {
                    for item in items {
                        let kind = item["type"].as_str().unwrap_or("");
                        match kind {
                            "compaction_trigger" => {
                                has_compaction_trigger = true;
                            }
                            "compaction" => {
                                messages.push(NormalizedMessage {
                                    role: NormalizedRole::Assistant,
                                    text: item["encrypted_content"]
                                        .as_str()
                                        .unwrap_or("")
                                        .to_owned(),
                                    tool_call_id: None,
                                    tool_name: None,
                                    has_image: false,
                                    is_compaction_item: true,
                                });
                            }
                            "function_call_output" | "custom_tool_call_output" => {
                                let (text, has_image) = extract_content(&item["output"]);
                                messages.push(NormalizedMessage {
                                    role: NormalizedRole::Tool,
                                    text,
                                    tool_call_id: item["call_id"].as_str().map(str::to_owned),
                                    tool_name: None,
                                    has_image,
                                    is_compaction_item: false,
                                });
                            }
                            "function_call" | "custom_tool_call" => {
                                messages.push(NormalizedMessage {
                                    role: NormalizedRole::Assistant,
                                    text: item["arguments"]
                                        .as_str()
                                        .or_else(|| item["input"].as_str())
                                        .unwrap_or("")
                                        .to_owned(),
                                    tool_call_id: item["call_id"].as_str().map(str::to_owned),
                                    tool_name: item["name"].as_str().map(str::to_owned),
                                    has_image: false,
                                    is_compaction_item: false,
                                });
                            }
                            _ => {
                                let role = match item["role"].as_str().unwrap_or("user") {
                                    "system" => NormalizedRole::System,
                                    "developer" => NormalizedRole::Developer,
                                    "assistant" => NormalizedRole::Assistant,
                                    _ => NormalizedRole::User,
                                };
                                let (text, has_image) = extract_content(&item["content"]);
                                if matches!(
                                    role,
                                    NormalizedRole::System | NormalizedRole::Developer
                                ) && !text.is_empty()
                                {
                                    system_parts.push(text.clone());
                                }
                                messages.push(NormalizedMessage {
                                    role,
                                    text,
                                    tool_call_id: None,
                                    tool_name: None,
                                    has_image,
                                    is_compaction_item: false,
                                });
                            }
                        }
                    }
                }
                _ => {}
            }
            if let Some(arr) = raw_body["tools"].as_array() {
                for t in arr {
                    let kind = t["type"].as_str().map(str::to_owned);
                    let name = t["name"]
                        .as_str()
                        .or_else(|| t["type"].as_str())
                        .unwrap_or("");
                    if !name.is_empty() {
                        tools.push(NormalizedTool {
                            name: name.to_owned(),
                            kind,
                            parameters: t.get("parameters").cloned(),
                        });
                    }
                }
            }
        }
        Protocol::AnthropicMessages => {
            let (sys_text, _) = extract_content(&raw_body["system"]);
            if !sys_text.is_empty() {
                system_parts.push(sys_text);
            }
            if let Some(arr) = raw_body["messages"].as_array() {
                for item in arr {
                    let role = match item["role"].as_str().unwrap_or("user") {
                        "assistant" => NormalizedRole::Assistant,
                        _ => NormalizedRole::User,
                    };
                    if let Some(blocks) = item["content"].as_array() {
                        let mut text_buf = Vec::new();
                        let mut has_image = false;
                        for block in blocks {
                            match block["type"].as_str().unwrap_or("") {
                                "text" => {
                                    if let Some(t) = block["text"].as_str() {
                                        text_buf.push(t.to_owned());
                                    }
                                }
                                "image" => {
                                    has_image = true;
                                }
                                "tool_result" => {
                                    let (tr_text, tr_img) = extract_content(&block["content"]);
                                    messages.push(NormalizedMessage {
                                        role: NormalizedRole::Tool,
                                        text: tr_text,
                                        tool_call_id: block["tool_use_id"]
                                            .as_str()
                                            .map(str::to_owned),
                                        tool_name: None,
                                        has_image: tr_img,
                                        is_compaction_item: false,
                                    });
                                }
                                "tool_use" => {
                                    messages.push(NormalizedMessage {
                                        role: NormalizedRole::Assistant,
                                        text: block["input"].to_string(),
                                        tool_call_id: block["id"].as_str().map(str::to_owned),
                                        tool_name: block["name"].as_str().map(str::to_owned),
                                        has_image: false,
                                        is_compaction_item: false,
                                    });
                                }
                                "compaction" => {
                                    messages.push(NormalizedMessage {
                                        role: NormalizedRole::Assistant,
                                        text: block["content"].as_str().unwrap_or("").to_owned(),
                                        tool_call_id: None,
                                        tool_name: None,
                                        has_image: false,
                                        is_compaction_item: true,
                                    });
                                }
                                _ => {}
                            }
                        }
                        if !text_buf.is_empty() || has_image {
                            messages.push(NormalizedMessage {
                                role,
                                text: text_buf.join("\n"),
                                tool_call_id: None,
                                tool_name: None,
                                has_image,
                                is_compaction_item: false,
                            });
                        }
                    } else {
                        let (text, has_image) = extract_content(&item["content"]);
                        messages.push(NormalizedMessage {
                            role,
                            text,
                            tool_call_id: None,
                            tool_name: None,
                            has_image,
                            is_compaction_item: false,
                        });
                    }
                }
            }
            if let Some(arr) = raw_body["tools"].as_array() {
                for t in arr {
                    let name = t["name"].as_str().or_else(|| t["type"].as_str());
                    if let Some(name) = name {
                        tools.push(NormalizedTool {
                            name: name.to_owned(),
                            kind: t["type"].as_str().map(str::to_owned),
                            parameters: t.get("input_schema").cloned(),
                        });
                    }
                }
            }
        }
    }

    let previous_response_id = raw_body["previous_response_id"].as_str().map(str::to_owned);

    let anthropic_compaction_enabled = protocol == Protocol::AnthropicMessages
        && (raw_body
            .get("context_management")
            .is_some_and(|v| !v.is_null())
            || headers
                .get("anthropic-beta")
                .is_some_and(|h| h.contains("compact")));

    let system_text = if system_parts.is_empty() {
        None
    } else {
        Some(system_parts.join("\n"))
    };

    let session_key = derive_session_key(&headers, &raw_body, &messages, &transport);
    let estimated_input_tokens = ((prompt_bytes as u64).max(4)) / 4;

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
        system_text,
        messages,
        tools,
        previous_response_id,
        has_compaction_trigger,
        anthropic_compaction_enabled,
        estimated_input_tokens,
        raw_body,
        raw_wire_bytes,
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
