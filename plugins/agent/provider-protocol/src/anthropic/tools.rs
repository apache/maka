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

use super::{CacheBudget, CacheDirective, CacheSite, Warning};
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize)]
pub struct FunctionTool {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub input_schema: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_control: Option<CacheDirective>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strict: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub defer_loading: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eager_input_streaming: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allowed_callers: Option<Vec<CallerKind>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_examples: Option<Vec<Value>>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
pub enum CallerKind {
    #[serde(rename = "direct")]
    Direct,
    #[serde(rename = "code_execution_20250825")]
    CodeExecution20250825,
    #[serde(rename = "code_execution_20260120")]
    CodeExecution20260120,
}

#[derive(Debug, Clone)]
pub enum Tool {
    Function(FunctionTool),
    Hosted(HostedTool),
    Unsupported(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Feature {
    StructuredOutputs,
    AdvancedTools,
    CodeExecution20250522,
    CodeExecution20250825,
    Computer20241022,
    Computer20250124,
    Computer20251124,
    ContextManagement,
    WebFetch,
    CodeExecutionWebTools,
    Advisor,
}
impl Feature {
    pub fn header(self) -> &'static str {
        match self {
            Self::StructuredOutputs => "structured-outputs-2025-11-13",
            Self::AdvancedTools => "advanced-tool-use-2025-11-20",
            Self::CodeExecution20250522 => "code-execution-2025-05-22",
            Self::CodeExecution20250825 => "code-execution-2025-08-25",
            Self::Computer20241022 => "computer-use-2024-10-22",
            Self::Computer20250124 => "computer-use-2025-01-24",
            Self::Computer20251124 => "computer-use-2025-11-24",
            Self::ContextManagement => "context-management-2025-06-27",
            Self::WebFetch => "web-fetch-2025-09-10",
            Self::CodeExecutionWebTools => "code-execution-web-tools-2026-02-09",
            Self::Advisor => "advisor-tool-2026-03-01",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ToolPolicy {
    pub structured_output: bool,
    pub strict: bool,
    pub eager_streaming: bool,
    pub forced_choice: bool,
}
impl Default for ToolPolicy {
    fn default() -> Self {
        Self {
            structured_output: true,
            strict: true,
            eager_streaming: false,
            forced_choice: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolChoice {
    Auto,
    None,
    Required,
    Named(String),
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WireChoice {
    Auto {
        #[serde(skip_serializing_if = "Option::is_none")]
        disable_parallel_tool_use: Option<bool>,
    },
    Any {
        #[serde(skip_serializing_if = "Option::is_none")]
        disable_parallel_tool_use: Option<bool>,
    },
    Tool {
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        disable_parallel_tool_use: Option<bool>,
    },
    None,
}

/// Prepared once, then serialized directly into the Messages request body.
#[derive(Debug)]
pub struct PreparedTools {
    pub tools: Vec<PreparedTool>,
    pub choice: Option<WireChoice>,
    pub warnings: Vec<Warning>,
    pub features: Vec<Feature>,
}
#[derive(Debug)]
pub enum PreparedTool {
    Function(FunctionTool),
    Hosted(HostedTool),
}
impl PreparedTools {
    pub fn build(
        tools: impl IntoIterator<Item = Tool>,
        choice: Option<ToolChoice>,
        disable_parallel: Option<bool>,
        policy: ToolPolicy,
        cache: &mut CacheBudget,
    ) -> Self {
        let mut result = Self {
            tools: Vec::new(),
            choice: None,
            warnings: Vec::new(),
            features: Vec::new(),
        };
        let tools: Vec<_> = tools.into_iter().collect();
        if tools.is_empty() {
            return result;
        }
        for tool in tools {
            match tool {
                Tool::Function(mut tool) => {
                    tool.cache_control =
                        cache.reserve(tool.cache_control, CacheSite::ToolDefinition);
                    tool.eager_input_streaming = tool
                        .eager_input_streaming
                        .unwrap_or(policy.eager_streaming)
                        .then_some(true);
                    if !policy.strict {
                        if tool.strict == Some(true) {
                            result.warnings.push(Warning::StrictToolIgnored {
                                name: tool.name.clone(),
                            });
                        }
                        tool.strict = None;
                    }
                    if policy.structured_output {
                        result.feature(Feature::StructuredOutputs);
                    }
                    if tool.allowed_callers.is_some() || tool.input_examples.is_some() {
                        result.feature(Feature::AdvancedTools);
                    }
                    result.tools.push(PreparedTool::Function(tool));
                }
                Tool::Hosted(tool) => {
                    if let Some(feature) = tool.feature() {
                        result.feature(feature);
                    }
                    result.tools.push(PreparedTool::Hosted(tool));
                }
                Tool::Unsupported(id) => result.warnings.push(Warning::UnsupportedTool { id }),
            }
        }
        result.choice = match choice {
            None => disable_parallel.filter(|v| *v).map(|v| WireChoice::Auto {
                disable_parallel_tool_use: Some(v),
            }),
            Some(ToolChoice::None) => Some(WireChoice::None),
            Some(ToolChoice::Auto) => Some(WireChoice::Auto {
                disable_parallel_tool_use: disable_parallel,
            }),
            Some(ToolChoice::Required) if policy.forced_choice => Some(WireChoice::Any {
                disable_parallel_tool_use: disable_parallel,
            }),
            Some(ToolChoice::Named(name)) if policy.forced_choice => Some(WireChoice::Tool {
                name,
                disable_parallel_tool_use: disable_parallel,
            }),
            Some(choice) => {
                let name = match choice {
                    ToolChoice::Named(name) => Some(name),
                    _ => None,
                };
                if let Some(name) = &name {
                    result
                        .tools
                        .retain(|tool| tool.name() == Some(name.as_str()));
                }
                result
                    .warnings
                    .push(Warning::ForcedToolChoiceIgnored { name });
                Some(WireChoice::Auto {
                    disable_parallel_tool_use: disable_parallel,
                })
            }
        };
        result
    }
    fn feature(&mut self, feature: Feature) {
        if !self.features.contains(&feature) {
            self.features.push(feature);
        }
    }
    pub fn wire_tools(&self) -> Vec<Value> {
        self.tools.iter().map(PreparedTool::wire).collect()
    }
}
impl PreparedTool {
    fn name(&self) -> Option<&str> {
        match self {
            Self::Function(tool) => Some(&tool.name),
            Self::Hosted(tool) => tool.name(),
        }
    }
    fn wire(&self) -> Value {
        match self {
            Self::Function(tool) => {
                serde_json::to_value(tool).expect("function tool is JSON serializable")
            }
            Self::Hosted(tool) => tool.wire(),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub enum CodeVersion {
    V20250522,
    V20250825,
    V20260120,
}
#[derive(Debug, Clone, Copy)]
pub enum ComputerVersion {
    V20241022,
    V20250124,
    V20251124,
}
#[derive(Debug, Clone, Copy)]
pub enum EditorVersion {
    V20241022,
    V20250124,
    V20250429,
    V20250728,
}
#[derive(Debug, Clone, Copy)]
pub enum BashVersion {
    V20241022,
    V20250124,
}
#[derive(Debug, Clone, Copy)]
pub enum FetchVersion {
    V20250910,
    V20260209,
    V20260318,
}
#[derive(Debug, Clone, Copy)]
pub enum SearchVersion {
    V20250305,
    V20260209,
    V20260318,
}
#[derive(Debug, Clone, Copy)]
pub enum SearchAlgorithm {
    Regex,
    Bm25,
}

#[derive(Debug, Clone)]
pub enum HostedTool {
    CodeExecution(CodeVersion),
    Computer(ComputerVersion, ComputerOptions),
    Editor(EditorVersion, EditorOptions),
    Bash(BashVersion),
    ComputerToolset(BTreeMap<ComputerAction, MemberOptions>),
    Memory,
    WebFetch(FetchVersion, FetchOptions),
    WebSearch(SearchVersion, SearchOptions),
    ToolSearch(SearchAlgorithm),
    Advisor(AdvisorOptions),
}

// Deserialize provider options once at the external configuration boundary.
// The request builder only receives valid, typed definitions.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all(deserialize = "camelCase", serialize = "snake_case"))]
pub struct ComputerOptions {
    pub display_width_px: u64,
    pub display_height_px: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_number: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enable_zoom: Option<bool>,
}
#[derive(Default, Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all(deserialize = "camelCase", serialize = "snake_case"))]
pub struct EditorOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_characters: Option<serde_json::Number>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputerAction {
    Screenshot,
    Zoom,
    LeftClick,
    RightClick,
    MiddleClick,
    DoubleClick,
    TripleClick,
    LeftClickDrag,
    MouseMove,
    LeftMouseDown,
    LeftMouseUp,
    CursorPosition,
    Scroll,
    Type,
    Key,
    HoldKey,
    Wait,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all(deserialize = "camelCase", serialize = "snake_case"))]
pub struct MemberOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub defer_loading: Option<bool>,
}
#[derive(Default, Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all(deserialize = "camelCase", serialize = "snake_case"))]
pub struct WebLimits {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_uses: Option<serde_json::Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allowed_domains: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked_domains: Option<Vec<String>>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Citations {
    pub enabled: bool,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResponseInclusion {
    Full,
    Excluded,
}
#[derive(Default, Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all(deserialize = "camelCase", serialize = "snake_case"))]
pub struct FetchOptions {
    #[serde(flatten)]
    pub limits: WebLimits,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub citations: Option<Citations>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_content_tokens: Option<serde_json::Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_cache: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_inclusion: Option<ResponseInclusion>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum UserLocation {
    Approximate {
        #[serde(skip_serializing_if = "Option::is_none")]
        city: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        region: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        country: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        timezone: Option<String>,
    },
}
#[derive(Default, Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all(deserialize = "camelCase", serialize = "snake_case"))]
pub struct SearchOptions {
    #[serde(flatten)]
    pub limits: WebLimits,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_location: Option<UserLocation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_inclusion: Option<ResponseInclusion>,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(try_from = "u64", into = "u64")]
pub struct AdvisorBudget(u64);
impl TryFrom<u64> for AdvisorBudget {
    type Error = &'static str;
    fn try_from(value: u64) -> std::result::Result<Self, Self::Error> {
        if value >= 1024 {
            Ok(Self(value))
        } else {
            Err("advisor maxTokens must be at least 1024")
        }
    }
}
impl From<AdvisorBudget> for u64 {
    fn from(value: AdvisorBudget) -> Self {
        value.0
    }
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all(deserialize = "camelCase", serialize = "snake_case"))]
pub struct AdvisorOptions {
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_uses: Option<serde_json::Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<AdvisorBudget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caching: Option<CacheDirective>,
}

impl HostedTool {
    pub fn from_definition(id: &str, args: &Value) -> Result<Option<Self>> {
        fn parse<T: serde::de::DeserializeOwned>(args: &Value) -> Result<T> {
            serde_json::from_value(args.clone()).map_err(|error| Error::InvalidArgument {
                field: error.to_string(),
                value: args.clone(),
            })
        }
        let tool = match id.strip_prefix("anthropic.").unwrap_or(id) {
            "code_execution_20250522" => Self::CodeExecution(CodeVersion::V20250522),
            "code_execution_20250825" => Self::CodeExecution(CodeVersion::V20250825),
            "code_execution_20260120" => Self::CodeExecution(CodeVersion::V20260120),
            "computer_20241022" => Self::Computer(ComputerVersion::V20241022, parse(args)?),
            "computer_20250124" => Self::Computer(ComputerVersion::V20250124, parse(args)?),
            "computer_20251124" => Self::Computer(ComputerVersion::V20251124, parse(args)?),
            "text_editor_20241022" => {
                Self::Editor(EditorVersion::V20241022, EditorOptions::default())
            }
            "text_editor_20250124" => {
                Self::Editor(EditorVersion::V20250124, EditorOptions::default())
            }
            "text_editor_20250429" => {
                Self::Editor(EditorVersion::V20250429, EditorOptions::default())
            }
            "text_editor_20250728" => Self::Editor(EditorVersion::V20250728, parse(args)?),
            "bash_20241022" => Self::Bash(BashVersion::V20241022),
            "bash_20250124" => Self::Bash(BashVersion::V20250124),
            "computer_toolset_20260801" => {
                #[derive(Deserialize)]
                struct Options {
                    configs: Option<BTreeMap<ComputerAction, MemberOptions>>,
                }
                Self::ComputerToolset(parse::<Options>(args)?.configs.unwrap_or_default())
            }
            "memory_20250818" => Self::Memory,
            "web_fetch_20250910" => Self::WebFetch(FetchVersion::V20250910, parse(args)?),
            "web_fetch_20260209" => Self::WebFetch(FetchVersion::V20260209, parse(args)?),
            "web_fetch_20260318" => Self::WebFetch(FetchVersion::V20260318, parse(args)?),
            "web_search_20250305" => Self::WebSearch(SearchVersion::V20250305, parse(args)?),
            "web_search_20260209" => Self::WebSearch(SearchVersion::V20260209, parse(args)?),
            "web_search_20260318" => Self::WebSearch(SearchVersion::V20260318, parse(args)?),
            "tool_search_regex_20251119" => Self::ToolSearch(SearchAlgorithm::Regex),
            "tool_search_bm25_20251119" => Self::ToolSearch(SearchAlgorithm::Bm25),
            "advisor_20260301" => Self::Advisor(parse(args)?),
            _ => return Ok(None),
        };
        Ok(Some(tool))
    }
    fn descriptor(&self) -> (&'static str, Option<&'static str>, Option<Feature>) {
        use Feature::*;
        match self {
            Self::CodeExecution(version) => match version {
                CodeVersion::V20250522 => (
                    "code_execution_20250522",
                    Some("code_execution"),
                    Some(CodeExecution20250522),
                ),
                CodeVersion::V20250825 => (
                    "code_execution_20250825",
                    Some("code_execution"),
                    Some(CodeExecution20250825),
                ),
                CodeVersion::V20260120 => ("code_execution_20260120", Some("code_execution"), None),
            },
            Self::Computer(version, _) => match version {
                ComputerVersion::V20241022 => (
                    "computer_20241022",
                    Some("computer"),
                    Some(Computer20241022),
                ),
                ComputerVersion::V20250124 => (
                    "computer_20250124",
                    Some("computer"),
                    Some(Computer20250124),
                ),
                ComputerVersion::V20251124 => (
                    "computer_20251124",
                    Some("computer"),
                    Some(Computer20251124),
                ),
            },
            Self::Editor(version, _) => match version {
                EditorVersion::V20241022 => (
                    "text_editor_20241022",
                    Some("str_replace_editor"),
                    Some(Computer20241022),
                ),
                EditorVersion::V20250124 => (
                    "text_editor_20250124",
                    Some("str_replace_editor"),
                    Some(Computer20250124),
                ),
                EditorVersion::V20250429 => (
                    "text_editor_20250429",
                    Some("str_replace_based_edit_tool"),
                    Some(Computer20250124),
                ),
                EditorVersion::V20250728 => (
                    "text_editor_20250728",
                    Some("str_replace_based_edit_tool"),
                    None,
                ),
            },
            Self::Bash(BashVersion::V20241022) => {
                ("bash_20241022", Some("bash"), Some(Computer20241022))
            }
            Self::Bash(BashVersion::V20250124) => {
                ("bash_20250124", Some("bash"), Some(Computer20250124))
            }
            Self::ComputerToolset(_) => ("computer_toolset_20260801", None, None),
            Self::Memory => ("memory_20250818", Some("memory"), Some(ContextManagement)),
            Self::WebFetch(version, _) => match version {
                FetchVersion::V20250910 => {
                    ("web_fetch_20250910", Some("web_fetch"), Some(WebFetch))
                }
                FetchVersion::V20260209 => (
                    "web_fetch_20260209",
                    Some("web_fetch"),
                    Some(CodeExecutionWebTools),
                ),
                FetchVersion::V20260318 => ("web_fetch_20260318", Some("web_fetch"), None),
            },
            Self::WebSearch(version, _) => match version {
                SearchVersion::V20250305 => ("web_search_20250305", Some("web_search"), None),
                SearchVersion::V20260209 => (
                    "web_search_20260209",
                    Some("web_search"),
                    Some(CodeExecutionWebTools),
                ),
                SearchVersion::V20260318 => ("web_search_20260318", Some("web_search"), None),
            },
            Self::ToolSearch(SearchAlgorithm::Regex) => (
                "tool_search_tool_regex_20251119",
                Some("tool_search_tool_regex"),
                None,
            ),
            Self::ToolSearch(SearchAlgorithm::Bm25) => (
                "tool_search_tool_bm25_20251119",
                Some("tool_search_tool_bm25"),
                None,
            ),
            Self::Advisor(_) => ("advisor_20260301", Some("advisor"), Some(Advisor)),
        }
    }
    pub fn name(&self) -> Option<&'static str> {
        self.descriptor().1
    }
    fn feature(&self) -> Option<Feature> {
        self.descriptor().2
    }
    pub fn wire(&self) -> Value {
        fn serialize(value: &impl Serialize) -> Value {
            serde_json::to_value(value).expect("provider options are JSON serializable")
        }
        let mut wire = match self {
            Self::Computer(version, options) => {
                let mut value = serialize(options);
                if !matches!(version, ComputerVersion::V20251124) {
                    value.as_object_mut().unwrap().remove("enable_zoom");
                }
                value
            }
            Self::Editor(EditorVersion::V20250728, options) => serialize(options),
            Self::ComputerToolset(configs) if !configs.is_empty() => json!({"configs":configs}),
            Self::WebFetch(version, options) => {
                let mut value = serialize(options);
                if !matches!(version, FetchVersion::V20260318) {
                    value.as_object_mut().unwrap().remove("use_cache");
                    value.as_object_mut().unwrap().remove("response_inclusion");
                }
                value
            }
            Self::WebSearch(version, options) => {
                let mut value = serialize(options);
                if !matches!(version, SearchVersion::V20260318) {
                    value.as_object_mut().unwrap().remove("response_inclusion");
                }
                value
            }
            Self::Advisor(options) => serialize(options),
            Self::CodeExecution(_)
            | Self::Editor(_, _)
            | Self::Bash(_)
            | Self::ComputerToolset(_)
            | Self::Memory
            | Self::ToolSearch(_) => json!({}),
        };
        let (kind, name, _) = self.descriptor();
        wire["type"] = json!(kind);
        if let Some(name) = name {
            wire["name"] = json!(name);
        }
        wire
    }
}
