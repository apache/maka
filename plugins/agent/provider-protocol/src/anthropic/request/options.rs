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

//! Provider-specific configuration is decoded once. Native request preparation
//! works with these types, keeping arbitrary JSON confined to schema and opaque
//! vendor-extension fields.
use super::super::CacheDirective;
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderOptions {
    pub send_reasoning: Option<bool>,
    pub structured_output_mode: Option<StructuredOutputMode>,
    pub thinking: Option<Thinking>,
    pub disable_parallel_tool_use: Option<bool>,
    pub cache_control: Option<CacheDirective>,
    pub metadata: Option<UserMetadata>,
    pub mcp_servers: Option<Vec<McpServer>>,
    pub container: Option<Container>,
    pub tool_streaming: Option<bool>,
    pub effort: Option<Effort>,
    pub task_budget: Option<TaskBudget>,
    pub speed: Option<Speed>,
    pub service_tier: Option<ServiceTier>,
    pub inference_geo: Option<InferenceGeo>,
    pub fallbacks: Option<Fallbacks>,
    pub anthropic_beta: Option<Vec<String>>,
    pub safeguards: Option<Vec<Safeguard>>,
    pub compaction: Option<Compaction>,
    pub context_management: Option<ContextManagement>,
}
impl ProviderOptions {
    pub fn parse(canonical: Option<&Value>, custom: Option<&Value>) -> Result<Self> {
        let mut merged = Map::new();
        for options in [canonical, custom]
            .into_iter()
            .flatten()
            .filter(|v| !v.is_null())
        {
            let object = options.as_object().ok_or_else(|| Error::InvalidArgument {
                field: "provider options".into(),
                value: options.clone(),
            })?;
            // Validate each namespace before overlaying it, so a malformed
            // canonical option cannot disappear behind a custom override.
            let _: Self =
                serde_json::from_value(options.clone()).map_err(|e| Error::InvalidArgument {
                    field: e.to_string(),
                    value: options.clone(),
                })?;
            merged.extend(object.clone());
        }
        let merged = Value::Object(merged);
        let result: Self =
            serde_json::from_value(merged.clone()).map_err(|e| Error::InvalidArgument {
                field: e.to_string(),
                value: merged.clone(),
            })?;
        if result
            .task_budget
            .as_ref()
            .is_some_and(|b| b.total < 20_000)
        {
            return Err(Error::InvalidArgument {
                field: "taskBudget.total must be at least 20000".into(),
                value: merged,
            });
        }
        Ok(result)
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StructuredOutputMode {
    Auto,
    OutputFormat,
    JsonTool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}
impl Effort {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
        }
    }
    pub fn above_high(self) -> bool {
        matches!(self, Self::Xhigh | Self::Max)
    }
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum Thinking {
    Mode(ThinkingMode),
    Binding(BindingOnly),
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields(deserialize = "camelCase")
)]
pub enum ThinkingMode {
    Adaptive {
        #[serde(skip_serializing_if = "Option::is_none")]
        display: Option<ThinkingDisplay>,
        #[serde(skip_serializing_if = "Option::is_none")]
        block_binding: Option<BlockBinding>,
    },
    Enabled {
        #[serde(skip_serializing_if = "Option::is_none")]
        budget_tokens: Option<u64>,
    },
    Disabled,
    BetweenTools,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all(deserialize = "camelCase"), deny_unknown_fields)]
pub struct BindingOnly {
    pub block_binding: BlockBinding,
}
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ThinkingDisplay {
    Omitted,
    Summarized,
    Updates,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all(deserialize = "camelCase"))]
pub struct BlockBinding {
    pub prefix_mismatch_behavior: PrefixMismatch,
}
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PrefixMismatch {
    Error,
    DropBlock,
}
impl Thinking {
    pub fn active(&self) -> bool {
        matches!(
            self,
            Self::Mode(
                ThinkingMode::Adaptive { .. }
                    | ThinkingMode::Enabled { .. }
                    | ThinkingMode::BetweenTools
            )
        )
    }
    pub fn disabled(&self) -> bool {
        matches!(self, Self::Mode(ThinkingMode::Disabled))
    }
    pub fn budgeted(&self) -> bool {
        matches!(self, Self::Mode(ThinkingMode::Enabled { .. }))
    }
    pub fn bound(&self) -> bool {
        matches!(
            self,
            Self::Binding(_)
                | Self::Mode(ThinkingMode::Adaptive {
                    block_binding: Some(_),
                    ..
                })
        )
    }
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserMetadata {
    pub user_id: Option<String>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all(deserialize = "camelCase"))]
pub struct McpServer {
    #[serde(rename = "type")]
    pub kind: UrlKind,
    pub name: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authorization_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_configuration: Option<McpTools>,
}
#[derive(Debug, Deserialize, Serialize)]
pub enum UrlKind {
    #[serde(rename = "url")]
    Url,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all(deserialize = "camelCase"))]
pub struct McpTools {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allowed_tools: Option<Vec<String>>,
}
#[derive(Debug, Deserialize)]
pub struct Container {
    pub id: Option<String>,
    pub skills: Option<Vec<Skill>>,
}
#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Skill {
    Anthropic {
        skill_id: String,
        version: Option<String>,
    },
    Custom {
        provider_reference: BTreeMap<String, String>,
        version: Option<String>,
    },
}
#[derive(Debug, Deserialize, Serialize)]
pub struct TaskBudget {
    #[serde(rename = "type")]
    pub kind: TokensKind,
    pub total: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining: Option<u64>,
}
#[derive(Debug, Deserialize, Serialize)]
pub enum TokensKind {
    #[serde(rename = "tokens")]
    Tokens,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Speed {
    Fast,
    Standard,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceTier {
    Auto,
    StandardOnly,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InferenceGeo {
    Us,
    Global,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum Fallbacks {
    Default(DefaultFallback),
    Chain(Vec<Fallback>),
}
#[derive(Debug, Deserialize, Serialize)]
pub enum DefaultFallback {
    #[serde(rename = "default")]
    Default,
}
#[derive(Debug, Deserialize, Serialize)]
pub struct Fallback {
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_config: Option<Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed: Option<Speed>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields(deserialize = "camelCase")
)]
pub enum Safeguard {
    DangerousToolUse {
        #[serde(skip_serializing_if = "Option::is_none")]
        classifier_context: Option<Map<String, Value>>,
    },
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Compaction {
    Summarize {
        #[serde(skip_serializing_if = "Option::is_none")]
        instructions: Option<String>,
    },
}
#[derive(Debug, Deserialize, Serialize)]
pub struct ContextManagement {
    pub edits: Vec<ContextEdit>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all_fields(deserialize = "camelCase"))]
pub enum ContextEdit {
    #[serde(rename = "clear_tool_uses_20250919")]
    ClearTools {
        #[serde(skip_serializing_if = "Option::is_none")]
        trigger: Option<Trigger>,
        #[serde(skip_serializing_if = "Option::is_none")]
        keep: Option<ToolUses>,
        #[serde(skip_serializing_if = "Option::is_none")]
        clear_at_least: Option<InputTokens>,
        #[serde(skip_serializing_if = "Option::is_none")]
        clear_tool_inputs: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        exclude_tools: Option<Vec<String>>,
    },
    #[serde(rename = "clear_thinking_20251015")]
    ClearThinking {
        #[serde(skip_serializing_if = "Option::is_none")]
        keep: Option<KeepThinking>,
    },
    #[serde(rename = "compact_20260112")]
    Compact {
        #[serde(skip_serializing_if = "Option::is_none")]
        trigger: Option<InputTokens>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pause_after_compaction: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        instructions: Option<String>,
    },
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Trigger {
    InputTokens { value: f64 },
    ToolUses { value: f64 },
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum InputTokens {
    InputTokens { value: f64 },
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToolUses {
    ToolUses { value: f64 },
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum KeepThinking {
    All(KeepAll),
    Turns(ThinkingTurns),
}
#[derive(Debug, Deserialize, Serialize)]
pub enum KeepAll {
    #[serde(rename = "all")]
    All,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ThinkingTurns {
    ThinkingTurns { value: f64 },
}
