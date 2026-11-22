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

use super::super::{citations::Citation, hosted, prompt::Caller};
use crate::field::Field;
use serde::Deserialize;
use serde_json::{Map, Value};

/// The wire boundary distinguishes absent content from empty content; the
/// decoder's state machine handles the resulting typed variants exclusively.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Block {
    Text {
        text: String,
        citations: Option<Vec<Citation>>,
    },
    Thinking {
        thinking: String,
        signature: Option<String>,
    },
    RedactedThinking {
        data: String,
    },
    Compaction {
        content: Option<String>,
        signature: Option<String>,
    },
    ToolUse {
        id: String,
        name: String,
        #[serde(default)]
        input: Value,
        caller: Option<Caller>,
        toolset_name: Option<String>,
    },
    ServerToolUse {
        id: String,
        name: String,
        input: Option<Map<String, Value>>,
        caller: Option<Caller>,
    },
    McpToolUse {
        id: String,
        name: String,
        #[serde(default)]
        input: Value,
        server_name: String,
    },
    McpToolResult {
        tool_use_id: String,
        is_error: bool,
        content: McpContent,
    },
    WebFetchToolResult(Hosted<Fetch>),
    WebSearchToolResult(Hosted<Search>),
    CodeExecutionToolResult(Hosted<Code>),
    BashCodeExecutionToolResult(Hosted<hosted::CodeResult>),
    TextEditorCodeExecutionToolResult(Hosted<hosted::CodeResult>),
    ToolSearchToolResult(Hosted<ToolSearch>),
    AdvisorToolResult(Hosted<hosted::AdvisorResult>),
    ContainerUpload {
        file_id: String,
    },
    Fallback {
        from: Endpoint,
        to: Endpoint,
    },
    #[serde(untagged)]
    ServerResult {
        #[serde(rename = "type")]
        kind: String,
        tool_use_id: String,
        content: Value,
        is_error: Option<bool>,
    },
}
#[derive(Debug, Deserialize, serde::Serialize)]
pub struct Endpoint {
    pub model: String,
}
#[derive(Debug, Deserialize)]
pub struct Hosted<T> {
    pub tool_use_id: String,
    pub content: T,
    pub caller: Option<Caller>,
}
#[derive(Debug, Deserialize, serde::Serialize)]
#[serde(untagged)]
pub enum McpContent {
    Text(String),
    Parts(Vec<McpPart>),
}
#[derive(Debug, Deserialize, serde::Serialize)]
#[serde(untagged)]
pub enum McpPart {
    Text(String),
    Block(McpText),
}
#[derive(Debug, Deserialize, serde::Serialize)]
pub struct McpText {
    #[serde(rename = "type")]
    pub kind: McpTextTag,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub citations: Option<Vec<Value>>,
}
#[derive(Debug, Deserialize, serde::Serialize)]
#[serde(untagged)]
pub enum Fetch {
    Result(hosted::FetchResult),
    Error(FetchError),
}
#[derive(Debug, Deserialize, serde::Serialize)]
pub struct FetchError {
    #[serde(rename = "type")]
    pub kind: FetchErrorTag,
    pub error_code: String,
}
#[derive(Debug, Deserialize, serde::Serialize)]
#[serde(untagged)]
pub enum Search {
    Results(Vec<hosted::SearchResult>),
    Error(SearchError),
}
#[derive(Debug, Deserialize, serde::Serialize)]
pub struct SearchError {
    #[serde(rename = "type")]
    pub kind: SearchErrorTag,
    pub error_code: String,
}
#[derive(Debug, Deserialize, serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToolSearch {
    ToolSearchToolSearchResult {
        tool_references: Vec<hosted::ToolReference>,
    },
    ToolSearchToolResultError {
        error_code: String,
    },
}
#[derive(Debug, Deserialize, serde::Serialize)]
#[serde(untagged)]
pub enum Code {
    Result(hosted::CodeResult),
    Error(CodeError),
}
#[derive(Debug, Deserialize, serde::Serialize)]
pub struct CodeError {
    #[serde(rename = "type")]
    pub kind: CodeErrorTag,
    pub error_code: String,
}
#[derive(Debug, Deserialize)]
pub struct Message {
    pub id: Option<String>,
    pub model: Option<String>,
    pub content: Vec<Block>,
    pub usage: Value,
    #[serde(flatten)]
    pub end: End,
    pub input_transformations: Option<Vec<Transformation>>,
    pub context_management: Option<ContextManagement>,
}
#[derive(Debug, Clone, Default, Deserialize, serde::Serialize)]
pub struct End {
    pub stop_reason: Option<String>,
    pub stop_sequence: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_details: Option<StopDetails>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub safeguard_results: Option<Vec<Safeguard>>,
    pub container: Option<Container>,
}
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct StopDetails {
    #[serde(rename = "type")]
    pub kind: String,
    pub category: Option<String>,
    pub explanation: Option<String>,
    pub recommended_model: Option<String>,
}
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct Safeguard {
    #[serde(rename = "type")]
    pub kind: String,
    pub status: SafeguardStatus,
}
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct SafeguardStatus {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Field::is_missing")]
    pub tool_uses: Field<std::collections::BTreeMap<String, SafeguardOutcome>>,
}
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct SafeguardOutcome {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Field::is_missing")]
    pub outcome: Field<String>,
    #[serde(default, skip_serializing_if = "Field::is_missing")]
    pub explanation: Field<String>,
}
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct Transformation {
    pub r#type: String,
    pub path: String,
    pub reason: String,
}
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct Container {
    pub id: String,
    pub expires_at: String,
    pub skills: Option<Vec<Skill>>,
}
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct Skill {
    pub r#type: SkillKind,
    pub skill_id: String,
    pub version: String,
}
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillKind {
    Anthropic,
    Custom,
}
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct ContextManagement {
    pub applied_edits: Vec<ContextEdit>,
}
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(tag = "type")]
pub enum ContextEdit {
    #[serde(rename = "clear_tool_uses_20250919")]
    ClearTools {
        cleared_tool_uses: u64,
        cleared_input_tokens: u64,
    },
    #[serde(rename = "clear_thinking_20251015")]
    ClearThinking {
        cleared_thinking_turns: u64,
        cleared_input_tokens: u64,
    },
    #[serde(rename = "compact_20260112")]
    Compact,
}
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Chunk {
    MessageStart {
        message: Start,
    },
    ContentBlockStart {
        index: usize,
        content_block: Block,
    },
    ContentBlockDelta {
        index: usize,
        delta: Delta,
    },
    ContentBlockStop {
        index: usize,
    },
    MessageDelta {
        delta: End,
        usage: Value,
        input_transformations: Option<Vec<Transformation>>,
        context_management: Option<ContextManagement>,
    },
    MessageStop,
    Error {
        error: ProviderError,
    },
    Ping,
}
#[derive(Debug, Deserialize)]
pub struct Start {
    pub id: Option<String>,
    pub model: Option<String>,
    #[serde(rename = "role")]
    pub _role: Option<String>,
    pub usage: Value,
    pub content: Option<Vec<Block>>,
    pub stop_reason: Option<String>,
    pub input_transformations: Option<Vec<Transformation>>,
    pub container: Option<Container>,
}
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Delta {
    #[serde(rename = "text_delta")]
    Text { text: String },
    #[serde(rename = "thinking_delta")]
    Thinking { thinking: String },
    #[serde(rename = "signature_delta")]
    Signature { signature: String },
    #[serde(rename = "input_json_delta")]
    InputJson { partial_json: String },
    #[serde(rename = "compaction_delta")]
    Compaction { content: Option<String> },
    #[serde(rename = "citations_delta")]
    Citations { citation: Citation },
}
#[derive(Debug, Deserialize)]
pub struct ProviderError {
    pub r#type: String,
    pub message: String,
    pub code: Option<ErrorCode>,
    #[serde(rename = "statusCode")]
    pub status: Option<u16>,
    #[serde(rename = "isRetryable")]
    pub retryable: Option<bool>,
}
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(untagged)]
pub enum ErrorCode {
    Text(String),
    Number(serde_json::Number),
}

// Explicit single-variant fields validate discriminators during deserialization;
// serde struct tags alone only control serialization.
#[derive(Debug, Deserialize, serde::Serialize)]
pub enum McpTextTag {
    #[serde(rename = "text")]
    Value,
}

#[derive(Debug, Deserialize, serde::Serialize)]
pub enum FetchErrorTag {
    #[serde(rename = "web_fetch_tool_result_error")]
    Value,
}

#[derive(Debug, Deserialize, serde::Serialize)]
pub enum SearchErrorTag {
    #[serde(rename = "web_search_tool_result_error")]
    Value,
}

#[derive(Debug, Deserialize, serde::Serialize)]
pub enum CodeErrorTag {
    #[serde(rename = "code_execution_tool_result_error")]
    Value,
}

#[derive(Clone, Copy)]
pub(crate) enum Phase {
    Complete,
    Start,
}
pub(crate) fn validate_block(block: &Block, phase: Phase) -> bool {
    use hosted::CodeResult as C;
    match block {
        Block::Thinking { signature, .. } => matches!(phase, Phase::Start) || signature.is_some(),
        Block::ToolUse { input, .. } if matches!(phase, Phase::Start) => {
            input.is_null() || input.is_object()
        }
        Block::ContainerUpload { .. } => matches!(phase, Phase::Complete),
        Block::CodeExecutionToolResult(Hosted {
            content: Code::Result(result),
            ..
        }) => matches!(
            result,
            C::CodeExecutionResult { .. } | C::EncryptedCodeExecutionResult { .. }
        ),
        Block::BashCodeExecutionToolResult(Hosted { content, .. }) => matches!(
            content,
            C::BashCodeExecutionResult { .. } | C::BashCodeExecutionToolResultError { .. }
        ),
        Block::TextEditorCodeExecutionToolResult(Hosted { content, .. }) => matches!(
            content,
            C::TextEditorCodeExecutionToolResultError { .. }
                | C::TextEditorCodeExecutionViewResult { .. }
                | C::TextEditorCodeExecutionCreateResult { .. }
                | C::TextEditorCodeExecutionStrReplaceResult { .. }
        ),
        _ => true,
    }
}
