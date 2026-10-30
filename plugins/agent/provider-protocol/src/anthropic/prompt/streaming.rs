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

//! Anthropic's global decisions contain metadata only. Payloads are replayed
//! through independent monotonic cursors: ordinary blocks, deferred local tool
//! calls, and top-level system blocks. No role group or block schedule is retained.
pub mod prepared;
use super::*;
use crate::anthropic::{HostedTool, Tool, citations::Document, request};
use std::{ops::Range, sync::Arc};

#[derive(Clone)]
pub struct StreamOptions {
    pub send_reasoning: bool,
    pub cache_namespace: String,
    pub tool_names: BTreeMap<String, String>,
    pub toolsets: BTreeMap<String, String>,
}
impl StreamOptions {
    pub fn from_request(request: &request::Request<'_>, config: &request::Config) -> Self {
        let mut tool_names = BTreeMap::new();
        let mut toolsets = BTreeMap::new();
        for binding in &request.tools {
            if let Tool::Hosted(tool) = &binding.definition {
                tool_names.insert(
                    binding.name.clone(),
                    tool.name().unwrap_or("computer").into(),
                );
                if matches!(tool, HostedTool::ComputerToolset(_)) {
                    toolsets.insert(binding.name.clone(), "computer".into());
                }
            }
        }
        Self {
            send_reasoning: request.options.send_reasoning.unwrap_or(true),
            cache_namespace: config.cache_namespace.clone(),
            tool_names,
            toolsets,
        }
    }
    fn borrowed(&self) -> PromptOptions<'_> {
        PromptOptions {
            send_reasoning: self.send_reasoning,
            cache_namespace: &self.cache_namespace,
            tool_names: &self.tool_names,
            toolsets: &self.toolsets,
        }
    }
}

/// Scalar/global metadata, never bodies or a per-block replay schedule.
pub struct Context {
    count: usize,
    last_user: Option<usize>,
    top_system: Option<Range<usize>>,
    sources: HashSet<String>,
}
impl Context {
    pub fn has_system(&self) -> bool {
        self.top_system.is_some()
    }
    pub fn top_system(&self) -> Option<Range<usize>> {
        self.top_system.clone()
    }
    pub fn message_count(&self) -> usize {
        self.count
    }
}
pub struct Metadata {
    pub context: Arc<Context>,
    pub(crate) features: Vec<&'static str>,
    pub(crate) warnings: Vec<String>,
    pub(crate) cache: CacheBudget,
    pub(crate) documents: Vec<Document>,
}

struct Prepass {
    cache: CacheBudget,
    summary: PreparedPrompt,
    count: usize,
    previous: Option<Role>,
    group: usize,
    system_plain: bool,
    top_system: Option<Range<usize>>,
    last_user: Option<usize>,
    sources: HashSet<String>,
    callers: Vec<(usize, String, String)>,
    documents: Vec<Document>,
}
fn empty_prompt() -> PreparedPrompt {
    PreparedPrompt {
        system: None,
        messages: Vec::new(),
        features: Vec::new(),
        warnings: Vec::new(),
    }
}
impl Default for Prepass {
    fn default() -> Self {
        Self {
            cache: CacheBudget::default(),
            summary: empty_prompt(),
            count: 0,
            previous: None,
            group: 0,
            system_plain: true,
            top_system: None,
            last_user: None,
            sources: HashSet::new(),
            callers: Vec::new(),
            documents: Vec::new(),
        }
    }
}
impl Prepass {
    fn end_group(&mut self) {
        if self.previous == Some(Role::System)
            && self.top_system.is_none()
            && (self.group == 0 || self.system_plain)
        {
            self.top_system = Some(self.group..self.count);
        }
    }
    fn finish(mut self) -> Metadata {
        self.end_group();
        let mut warned = HashSet::new();
        for (group, id, source) in self.callers {
            if self.last_user.is_some_and(|last| group < last)
                && !self.sources.contains(&source)
                && warned.insert(id.clone())
            {
                self.summary.warnings.push(format!("Omitted caller metadata for tool {id} because source code execution tool {source} is missing from the conversation history."));
            }
        }
        Metadata {
            context: Arc::new(Context {
                count: self.count,
                last_user: self.last_user,
                top_system: self.top_system,
                sources: self.sources,
            }),
            features: self.summary.features,
            warnings: self.summary.warnings,
            cache: self.cache,
            documents: self.documents,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Selection {
    Normal,
    Deferred,
    System,
    All,
}
pub struct MessageInfo {
    pub index: usize,
    /// Start index of the merged user/assistant role group. System messages have
    /// independent headers even when adjacent, so their group is their own index.
    pub group: usize,
    pub header: Value,
    pub top_level_system: bool,
    pub emit_message: bool,
    pub part_count: usize,
}
fn inspect_assistant(
    builder: &mut Builder<'_>,
    part: &AssistantPart,
    mcp_ids: &mut HashSet<String>,
) -> Result<bool> {
    let metadata = canonical(part.extensions());
    match part {
        AssistantPart::Text { text, .. } if metadata["type"] == "compaction" => {
            if !text.is_empty() && metadata["signature"].is_string() {
                builder.feature("compact-2026-09-04");
            }
        }
        AssistantPart::Reasoning { extensions, .. } => {
            if !builder.options.send_reasoning {
                builder.warn("sending reasoning content is disabled for this model");
            } else {
                let reasoning: ReasoningOptions = options(extensions)?;
                if reasoning.signature.is_some() {
                    builder.cache(extensions, CacheSite::Reasoning)?;
                    return Ok(true);
                }
                if reasoning.redacted_data.is_some() {
                    builder.cache(extensions, CacheSite::RedactedReasoning)?;
                    return Ok(true);
                }
                builder.warn("unsupported reasoning metadata");
            }
        }
        AssistantPart::Custom { kind, .. } if kind == "anthropic.fallback" => {
            if fallback(metadata).is_some() {
                builder.feature("server-side-fallback-2026-06-01");
                return Ok(true);
            }
            builder.warn("anthropic fallback metadata must include from.model and to.model");
        }
        AssistantPart::ToolCall(call) => {
            if call.provider_executed {
                if metadata["type"] == "mcp-tool-use" {
                    mcp_ids.insert(call.id.clone());
                    if !metadata["serverName"].is_string() {
                        builder.warn("mcp tool use server name is required and must be a string");
                    }
                } else if !matches!(
                    builder.provider_name(&call.name),
                    "code_execution"
                        | "web_fetch"
                        | "web_search"
                        | "tool_search_tool_regex"
                        | "tool_search_tool_bm25"
                        | "advisor"
                ) {
                    builder.warn(format!(
                        "provider executed tool call for tool {} is not supported",
                        call.name
                    ));
                }
            } else if builder.toolset(&call.name, &call.extensions).is_some()
                && !call.input["action"].is_string()
            {
                builder.warn(format!(
                    "toolset tool call for tool {} is missing the action",
                    call.name
                ));
            }
        }
        AssistantPart::ToolResult(result) => inspect_replay(builder, result, mcp_ids),
        _ => {}
    }
    Ok(false)
}
fn inspect_replay(builder: &mut Builder<'_>, result: &ToolResult, mcp_ids: &HashSet<String>) {
    let output = &result.output.value;
    let name = builder.provider_name(&result.name);
    let unsupported = if mcp_ids.contains(&result.id) {
        !matches!(output, ToolValue::Json(_) | ToolValue::ErrorJson(_))
    } else if name == "code_execution" {
        match output {
            ToolValue::Json(value) if !value["type"].is_string() => {
                builder.warn(format!("provider executed tool result output value is not a valid code execution result for tool {}", result.name));
                return;
            }
            ToolValue::Json(_) | ToolValue::ErrorText(_) | ToolValue::ErrorJson(_) => false,
            _ => true,
        }
    } else if matches!(
        name,
        "web_fetch" | "web_search" | "tool_search_tool_regex" | "tool_search_tool_bm25" | "advisor"
    ) {
        !matches!(output, ToolValue::Json(_) | ToolValue::ErrorJson(_))
    } else {
        builder.warn(format!(
            "provider executed tool result for tool {} is not supported",
            result.name
        ));
        return;
    };
    if unsupported {
        builder.unsupported_output(result);
    }
}
fn fallback(metadata: &Value) -> Option<(FallbackEndpoint, FallbackEndpoint)> {
    Some((
        serde_json::from_value(metadata["from"].clone()).ok()?,
        serde_json::from_value(metadata["to"].clone()).ok()?,
    ))
}
fn encode_assistant(
    builder: &mut Builder<'_>,
    part: &AssistantPart,
    cache: Option<CacheDirective>,
    mcp_ids: &HashSet<String>,
) -> Result<Option<Block>> {
    let metadata = canonical(part.extensions());
    Ok(match part {
        AssistantPart::Text { text, .. } if metadata["type"] == "compaction" => (!text.is_empty())
            .then(|| Block::Compaction {
                content: text.clone(),
                signature: metadata["signature"].as_str().map(str::to_owned),
                cache_control: cache,
            }),
        AssistantPart::Text { text, .. } => Some(Block::Text {
            text: text.clone(),
            cache_control: cache,
            citations: metadata
                .get("citations")
                .filter(|value| !value.is_null())
                .cloned(),
        }),
        AssistantPart::Reasoning { text, extensions } if builder.options.send_reasoning => {
            let reasoning: ReasoningOptions = options(extensions)?;
            if let Some(signature) = reasoning.signature {
                Some(Block::Thinking {
                    thinking: text.clone(),
                    signature,
                })
            } else {
                reasoning
                    .redacted_data
                    .map(|data| Block::RedactedThinking { data })
            }
        }
        AssistantPart::ToolCall(call) => builder.call(call, cache, &mut HashSet::new()),
        AssistantPart::ToolResult(result) => builder.replay(result, mcp_ids, cache)?,
        AssistantPart::Custom { kind, .. } if kind == "anthropic.fallback" => {
            fallback(metadata).map(|(from, to)| Block::Fallback { from, to })
        }
        _ => None,
    })
}

#[cfg(test)]
mod tests;
