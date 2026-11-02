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

use super::super::CacheDirective;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Serialize)]
#[serde(tag = "role", rename_all = "lowercase")]
pub enum Message {
    System {
        content: Vec<Block>,
        #[serde(skip_serializing_if = "Option::is_none")]
        clear_at: Option<ClearAt>,
        #[serde(skip_serializing_if = "Option::is_none")]
        output_config: Option<OutputConfig>,
    },
    User {
        content: Vec<Block>,
    },
    Assistant {
        content: Vec<Block>,
    },
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ClearAt {
    NextUserMessage,
}
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}
#[derive(Debug, Serialize)]
pub struct OutputConfig {
    pub effort: Effort,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Source {
    Base64 {
        media_type: String,
        data: String,
    },
    Url {
        url: String,
    },
    Text {
        media_type: &'static str,
        data: String,
    },
    File {
        file_id: Value,
    },
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Caller<T = String> {
    Direct,
    #[serde(rename = "code_execution_20250825")]
    Code20250825 {
        tool_id: T,
    },
    #[serde(rename = "code_execution_20260120")]
    Code20260120 {
        tool_id: T,
    },
}
impl<T> Caller<T> {
    pub fn source_id(&self) -> Option<&T> {
        match self {
            Self::Direct => None,
            Self::Code20250825 { tool_id } | Self::Code20260120 { tool_id } => Some(tool_id),
        }
    }
}
#[derive(Debug, Clone, Serialize)]
pub struct HostResult {
    pub tool_use_id: String,
    pub content: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caller: Option<Caller>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_control: Option<CacheDirective>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Block {
    Text {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        cache_control: Option<CacheDirective>,
        #[serde(skip_serializing_if = "Option::is_none")]
        citations: Option<Value>,
    },
    Image {
        source: Source,
        #[serde(skip_serializing_if = "Option::is_none")]
        cache_control: Option<CacheDirective>,
    },
    Document {
        source: Source,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        context: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        citations: Option<super::super::Citations>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cache_control: Option<CacheDirective>,
    },
    ContainerUpload {
        file_id: Value,
    },
    Thinking {
        thinking: String,
        signature: String,
    },
    RedactedThinking {
        data: String,
    },
    Compaction {
        content: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cache_control: Option<CacheDirective>,
    },
    Fallback {
        from: FallbackEndpoint,
        to: FallbackEndpoint,
    },
    ToolUse {
        id: String,
        name: String,
        input: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        toolset_name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        caller: Option<Caller>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cache_control: Option<CacheDirective>,
    },
    ServerToolUse {
        id: String,
        name: String,
        input: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        caller: Option<Caller>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cache_control: Option<CacheDirective>,
    },
    McpToolUse {
        id: String,
        name: String,
        input: Value,
        server_name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        cache_control: Option<CacheDirective>,
    },
    McpToolResult {
        tool_use_id: String,
        content: Value,
        is_error: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        cache_control: Option<CacheDirective>,
    },
    ToolResult {
        tool_use_id: String,
        content: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        toolset_name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        is_error: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cache_control: Option<CacheDirective>,
    },
    ToolReference {
        tool_name: String,
    },
    ToolAddition {
        tool: NamedReference,
    },
    ToolRemoval {
        tool: NamedReference,
    },
    CodeExecutionToolResult(HostResult),
    BashCodeExecutionToolResult(HostResult),
    TextEditorCodeExecutionToolResult(HostResult),
    WebFetchToolResult(HostResult),
    WebSearchToolResult(HostResult),
    ToolSearchToolResult(HostResult),
    AdvisorToolResult(HostResult),
}
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename = "tool_reference")]
pub struct NamedReference {
    pub name: String,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FallbackEndpoint {
    pub model: String,
    #[serde(flatten)]
    pub details: serde_json::Map<String, Value>,
}
impl Block {
    pub fn text(text: String, cache_control: Option<CacheDirective>) -> Self {
        Self::Text {
            text,
            cache_control,
            citations: None,
        }
    }
    pub fn caller_mut(&mut self) -> Option<(&str, &mut Option<Caller>)> {
        match self {
            Self::ToolUse { id, caller, .. } | Self::ServerToolUse { id, caller, .. } => {
                Some((id, caller))
            }
            Self::CodeExecutionToolResult(result)
            | Self::BashCodeExecutionToolResult(result)
            | Self::TextEditorCodeExecutionToolResult(result)
            | Self::WebFetchToolResult(result)
            | Self::WebSearchToolResult(result)
            | Self::ToolSearchToolResult(result)
            | Self::AdvisorToolResult(result) => Some((&result.tool_use_id, &mut result.caller)),
            _ => None,
        }
    }
}
