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

mod replay;
pub mod streaming;
pub use streaming::prepared;
mod wire;
use super::{CacheBudget, CacheDirective, CacheSite, Citations};
use crate::{
    Error, Result,
    input::{
        AssistantPart, Extensions, File, FileSource, Message, ToolCall, ToolOutput, ToolResult,
        ToolValue, UserPart,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};
pub use wire::{Block, Caller, Message as WireMessage, Source};
use wire::{ClearAt, Effort, FallbackEndpoint, NamedReference, OutputConfig};

pub struct PromptOptions<'a> {
    pub send_reasoning: bool,
    pub cache_namespace: &'a str,
    pub tool_names: &'a BTreeMap<String, String>,
    pub toolsets: &'a BTreeMap<String, String>,
}

#[derive(Debug, Serialize)]
pub struct PreparedPrompt {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<Vec<Block>>,
    pub messages: Vec<WireMessage>,
    #[serde(skip)]
    pub features: Vec<&'static str>,
    #[serde(skip)]
    pub warnings: Vec<String>,
}

struct Builder<'a> {
    options: PromptOptions<'a>,
    cache: &'a mut CacheBudget,
    prompt: PreparedPrompt,
    last_user: Option<usize>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SystemOptions {
    clear_at: Option<ClearAt>,
    effort: Option<Effort>,
    #[serde(default)]
    tool_changes: Vec<ToolChange>,
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ToolChange {
    ToolAddition {
        #[serde(rename = "toolName")]
        name: String,
    },
    ToolRemoval {
        #[serde(rename = "toolName")]
        name: String,
    },
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileOptions {
    title: Option<String>,
    context: Option<String>,
    citations: Option<Citations>,
    container_upload: Option<bool>,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReasoningOptions {
    signature: Option<String>,
    redacted_data: Option<String>,
}

fn namespace<'a>(extensions: &'a Extensions, name: &str) -> Option<&'a Value> {
    extensions.as_ref()?.get(name)
}
fn canonical(extensions: &Extensions) -> &Value {
    namespace(extensions, "anthropic").unwrap_or(&Value::Null)
}
fn options<T: serde::de::DeserializeOwned + Default>(extensions: &Extensions) -> Result<T> {
    match namespace(extensions, "anthropic").filter(|v| !v.is_null()) {
        None => Ok(T::default()),
        Some(value) => {
            serde_json::from_value(value.clone()).map_err(|error| Error::InvalidArgument {
                field: error.to_string(),
                value: value.clone(),
            })
        }
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Role {
    System,
    User,
    Assistant,
}
fn role(message: &Message) -> Role {
    match message {
        Message::System { .. } => Role::System,
        Message::User { .. } | Message::Tool { .. } => Role::User,
        Message::Assistant { .. } => Role::Assistant,
    }
}

impl PreparedPrompt {
    pub fn encode(
        messages: &[Message],
        options: PromptOptions<'_>,
        cache: &mut CacheBudget,
    ) -> Result<Self> {
        let mut builder = Builder {
            options,
            cache,
            last_user: None,
            prompt: Self {
                system: None,
                messages: Vec::new(),
                features: Vec::new(),
                warnings: Vec::new(),
            },
        };
        let mut groups = messages
            .chunk_by(|left, right| role(left) == role(right))
            .peekable();
        let mut initial = true;
        while let Some(group) = groups.next() {
            match role(&group[0]) {
                Role::System => builder.system(group, initial)?,
                Role::User => builder.user(group)?,
                Role::Assistant => builder.assistant(group, groups.peek().is_none())?,
            }
            initial = false;
        }
        builder.prune_callers();
        Ok(builder.prompt)
    }
}

impl Builder<'_> {
    fn feature(&mut self, feature: &'static str) {
        if !self.prompt.features.contains(&feature) {
            self.prompt.features.push(feature);
        }
    }
    fn warn(&mut self, warning: impl Into<String>) {
        self.prompt.warnings.push(warning.into());
    }
    fn provider_name<'a>(&'a self, name: &'a str) -> &'a str {
        self.options
            .tool_names
            .get(name)
            .map(String::as_str)
            .unwrap_or(name)
    }
    fn toolset(&self, name: &str, extensions: &Extensions) -> Option<String> {
        self.options.toolsets.get(name).cloned().or_else(|| {
            canonical(extensions)["toolsetName"]
                .as_str()
                .map(str::to_owned)
        })
    }
    fn cache(
        &mut self,
        extensions: &Extensions,
        site: CacheSite,
    ) -> Result<Option<CacheDirective>> {
        let custom = namespace(extensions, self.options.cache_namespace).unwrap_or(&Value::Null);
        let canonical = canonical(extensions);
        let selected = [
            &custom["cacheControl"],
            &custom["cache_control"],
            &canonical["cacheControl"],
            &canonical["cache_control"],
        ]
        .into_iter()
        .find(|v| !v.is_null());
        let Some(value) = selected.filter(|v| **v != false && **v != "" && **v != 0) else {
            return Ok(None);
        };
        let directive =
            serde_json::from_value(value.clone()).map_err(|error| Error::InvalidArgument {
                field: error.to_string(),
                value: value.clone(),
            })?;
        Ok(self.cache.reserve(Some(directive), site))
    }
    fn part_cache(
        &mut self,
        part: &Extensions,
        message: &Extensions,
        last: bool,
        site: CacheSite,
    ) -> Result<Option<CacheDirective>> {
        match self.cache(part, site)? {
            Some(cache) => Ok(Some(cache)),
            None if last => self.cache(message, site),
            None => Ok(None),
        }
    }
    fn system(&mut self, group: &[Message], initial: bool) -> Result<()> {
        let mut converted = Vec::new();
        for message in group {
            let Message::System { text, extensions } = message else {
                unreachable!()
            };
            let options: SystemOptions = options(extensions)?;
            let mut content = Vec::new();
            if !text.is_empty()
                || (options.tool_changes.is_empty()
                    && options.clear_at.is_none()
                    && options.effort.is_none())
            {
                content.push(Block::text(
                    text.clone(),
                    self.cache(extensions, CacheSite::System)?,
                ));
            }
            let changes = options.tool_changes.len();
            for change in options.tool_changes {
                let (addition, name) = match change {
                    ToolChange::ToolAddition { name } => (true, name),
                    ToolChange::ToolRemoval { name } => (false, name),
                };
                let tool = NamedReference {
                    name: self.provider_name(&name).into(),
                };
                content.push(if addition {
                    Block::ToolAddition { tool }
                } else {
                    Block::ToolRemoval { tool }
                });
            }
            converted.push((content, options.clear_at, options.effort, changes));
        }
        let top_level = initial
            || (self.prompt.system.is_none()
                && converted.iter().all(|(_, clear, effort, changes)| {
                    clear.is_none() && effort.is_none() && *changes == 0
                }));
        if top_level {
            if converted.iter().any(|(_, _, _, changes)| *changes > 0) {
                self.warn("tool changes on the initial system message are not supported by Anthropic. Configure the initial tool set via the tools option instead. The tool changes have been ignored.");
            }
            let mut system = Vec::new();
            for (content, clear, effort, _) in converted {
                if content.is_empty() && clear.is_none() && effort.is_some() {
                    self.prompt.messages.push(WireMessage::System {
                        content: Vec::new(),
                        clear_at: None,
                        output_config: effort.map(|effort| OutputConfig { effort }),
                    });
                    self.feature("mid-conversation-output-config-2026-07-01");
                } else if clear.is_some() || effort.is_some() {
                    self.warn("clearAt and effort on this initial system message are not supported by Anthropic. Use a separate effort-only system message with empty content to set effort. These options have been ignored.");
                }
                system.extend(
                    content
                        .into_iter()
                        .filter(|part| matches!(part, Block::Text { .. })),
                );
            }
            self.prompt.system = Some(system);
        } else {
            self.feature("mid-conversation-system-2026-04-07");
            for (content, clear, effort, changes) in converted {
                self.prompt.messages.push(WireMessage::System {
                    content,
                    clear_at: clear,
                    output_config: effort.map(|effort| OutputConfig { effort }),
                });
                if changes > 0 {
                    self.feature("mid-conversation-tool-changes-2026-07-01");
                }
                if clear.is_some() {
                    self.feature("mid-conversation-system-clear-at-2026-08-21");
                }
                if effort.is_some() {
                    self.feature("mid-conversation-output-config-2026-07-01");
                }
            }
        }
        Ok(())
    }
    fn user(&mut self, group: &[Message]) -> Result<()> {
        let mut content = Vec::new();
        for message in group {
            match message {
                Message::User { parts, extensions } => {
                    if !parts.is_empty() {
                        self.last_user = Some(self.prompt.messages.len());
                    }
                    for (index, part) in parts.iter().enumerate() {
                        let cache = self.part_cache(
                            part.extensions(),
                            extensions,
                            index + 1 == parts.len(),
                            CacheSite::Text,
                        )?;
                        match part {
                            UserPart::Text { text, .. } => {
                                content.push(Block::text(text.clone(), cache))
                            }
                            UserPart::File(file) => content.push(self.file(file, cache)?),
                            UserPart::Custom { .. } => {
                                return Err(Error::unsupported("custom user content"));
                            }
                        }
                    }
                }
                Message::Tool {
                    results,
                    extensions,
                } => {
                    for (index, result) in results.iter().enumerate() {
                        let output_options = result
                            .output
                            .extensions
                            .as_ref()
                            .map(|_| &result.output.extensions)
                            .or_else(|| match &result.output.value {
                                ToolValue::Content(parts) => parts
                                    .iter()
                                    .find(|p| p.extensions().is_some())
                                    .map(UserPart::extensions),
                                _ => None,
                            });
                        let mut cache = self.cache(&result.extensions, CacheSite::ToolResult)?;
                        if cache.is_none()
                            && let Some(options) = output_options
                        {
                            cache = self.cache(options, CacheSite::ToolResult)?;
                        }
                        if cache.is_none() && index + 1 == results.len() {
                            cache = self.cache(extensions, CacheSite::ToolResult)?;
                        }
                        let value = self.output(&result.output)?;
                        content.push(Block::ToolResult {
                            tool_use_id: result.id.clone(),
                            content: value,
                            toolset_name: self.toolset(&result.name, &result.extensions),
                            is_error: matches!(
                                result.output.value,
                                ToolValue::ErrorText(_) | ToolValue::ErrorJson(_)
                            )
                            .then_some(true),
                            cache_control: cache,
                        });
                    }
                }
                _ => unreachable!(),
            }
        }
        self.prompt.messages.push(WireMessage::User { content });
        Ok(())
    }
    fn file(&mut self, file: &File, cache: Option<CacheDirective>) -> Result<Block> {
        let image = file.media_type.split('/').next() == Some("image");
        let options: FileOptions = options(&file.extensions)?;
        if let FileSource::Reference(_) = &file.source {
            let file_id = file.reference("anthropic")?.clone();
            self.feature("files-api-2025-04-14");
            return Ok(if options.container_upload == Some(true) {
                Block::ContainerUpload { file_id }
            } else if image {
                Block::Image {
                    source: Source::File { file_id },
                    cache_control: cache,
                }
            } else {
                Block::Document {
                    source: Source::File { file_id },
                    title: None,
                    context: None,
                    citations: None,
                    cache_control: cache,
                }
            });
        }
        let source = match &file.source {
            FileSource::Text(text) => Source::Text {
                media_type: "text/plain",
                data: text.clone(),
            },
            FileSource::Url(url) => {
                if !image && !matches!(file.media_type.as_str(), "application/pdf" | "text/plain") {
                    return Err(Error::unsupported(format!(
                        "media type: {}",
                        file.media_type
                    )));
                }
                if file.media_type == "application/pdf" {
                    self.feature("pdfs-2024-09-25");
                }
                Source::Url { url: url.clone() }
            }
            FileSource::Inline(data) => {
                if file.media_type == "text/plain" {
                    Source::Text {
                        media_type: "text/plain",
                        data: String::from_utf8_lossy(&data.bytes()?).into_owned(),
                    }
                } else {
                    let media_type = file.resolved_media_type()?.into_owned();
                    if !image && media_type != "application/pdf" {
                        return Err(Error::unsupported(format!(
                            "media type: {}",
                            file.media_type
                        )));
                    }
                    if media_type == "application/pdf" {
                        self.feature("pdfs-2024-09-25");
                    }
                    Source::Base64 {
                        media_type,
                        data: data.base64().into_owned(),
                    }
                }
            }
            FileSource::Reference(_) => unreachable!(),
        };
        if image && !matches!(file.source, FileSource::Text(_)) {
            Ok(Block::Image {
                source,
                cache_control: cache,
            })
        } else {
            Ok(Block::Document {
                source,
                title: options.title.or_else(|| file.filename.clone()),
                context: options.context.filter(|s| !s.is_empty()),
                citations: options.citations.filter(|c| c.enabled),
                cache_control: cache,
            })
        }
    }
    fn output(&mut self, output: &ToolOutput) -> Result<Value> {
        Ok(match &output.value {
            ToolValue::Text(text) | ToolValue::ErrorText(text) => json!(text),
            ToolValue::Json(value) | ToolValue::ErrorJson(value) => json!(value.to_string()),
            ToolValue::Denied { reason } => {
                json!(reason.as_deref().unwrap_or("Tool call execution denied."))
            }
            ToolValue::Content(parts) => {
                let mut blocks = Vec::new();
                for part in parts {
                    let block = match part {
                        UserPart::Text { text, .. } => Some(Block::text(text.clone(), None)),
                        UserPart::File(file) => self.result_file(file)?,
                        UserPart::Custom { extensions, .. } => {
                            let metadata = canonical(extensions);
                            if metadata["type"] == "tool-reference" {
                                Some(Block::ToolReference {
                                    tool_name: metadata["toolName"]
                                        .as_str()
                                        .unwrap_or_default()
                                        .into(),
                                })
                            } else {
                                self.warn("unsupported custom tool content part");
                                None
                            }
                        }
                    };
                    if let Some(block) = block {
                        blocks.push(block);
                    }
                }
                serde_json::to_value(blocks).expect("wire blocks are JSON")
            }
        })
    }
    fn result_file(&mut self, file: &File) -> Result<Option<Block>> {
        let image = file.media_type.split('/').next() == Some("image");
        let source = match &file.source {
            FileSource::Reference(_) => {
                self.feature("files-api-2025-04-14");
                Source::File {
                    file_id: file.reference("anthropic")?.clone(),
                }
            }
            FileSource::Url(url) => Source::Url { url: url.clone() },
            FileSource::Inline(data) => {
                let media_type = file.resolved_media_type()?.into_owned();
                if !image && media_type != "application/pdf" {
                    self.warn(format!(
                        "unsupported tool content part type: file with media type: {}",
                        file.media_type
                    ));
                    return Ok(None);
                }
                if media_type == "application/pdf" {
                    self.feature("pdfs-2024-09-25");
                }
                Source::Base64 {
                    media_type,
                    data: data.base64().into_owned(),
                }
            }
            FileSource::Text(_) => {
                self.warn("unsupported tool content part type: file with data type: text");
                return Ok(None);
            }
        };
        Ok(Some(if image {
            Block::Image {
                source,
                cache_control: None,
            }
        } else {
            Block::Document {
                source,
                title: None,
                context: None,
                citations: None,
                cache_control: None,
            }
        }))
    }
    fn assistant(&mut self, group: &[Message], final_group: bool) -> Result<()> {
        let mut content = Vec::new();
        let mut mcp_ids = HashSet::new();
        for (message_index, message) in group.iter().enumerate() {
            let Message::Assistant { parts, extensions } = message else {
                unreachable!()
            };
            for (part_index, part) in parts.iter().enumerate() {
                let cache = self.part_cache(
                    part.extensions(),
                    extensions,
                    part_index + 1 == parts.len(),
                    CacheSite::Text,
                )?;
                let metadata = canonical(part.extensions());
                match part {
                    AssistantPart::Text { text, .. } if metadata["type"] == "compaction" => {
                        if !text.is_empty() {
                            let signature = metadata["signature"].as_str().map(str::to_owned);
                            if signature.is_some() {
                                self.feature("compact-2026-09-04");
                            }
                            content.push(Block::Compaction {
                                content: text.clone(),
                                signature,
                                cache_control: cache,
                            });
                        }
                    }
                    AssistantPart::Text { text, .. } => content.push(Block::Text {
                        text: if final_group
                            && message_index + 1 == group.len()
                            && part_index + 1 == parts.len()
                        {
                            text.trim().into()
                        } else {
                            text.clone()
                        },
                        cache_control: cache,
                        citations: metadata.get("citations").filter(|v| !v.is_null()).cloned(),
                    }),
                    AssistantPart::Reasoning { text, extensions } => {
                        if !self.options.send_reasoning {
                            self.warn("sending reasoning content is disabled for this model");
                            continue;
                        }
                        let reasoning: ReasoningOptions = options(extensions)?;
                        if let Some(signature) = reasoning.signature {
                            self.cache(extensions, CacheSite::Reasoning)?;
                            content.push(Block::Thinking {
                                thinking: text.clone(),
                                signature,
                            });
                        } else if let Some(data) = reasoning.redacted_data {
                            self.cache(extensions, CacheSite::RedactedReasoning)?;
                            content.push(Block::RedactedThinking { data });
                        } else {
                            self.warn("unsupported reasoning metadata");
                        }
                    }
                    AssistantPart::Custom { kind, .. } if kind == "anthropic.fallback" => {
                        let endpoints =
                            serde_json::from_value::<FallbackEndpoint>(metadata["from"].clone())
                                .and_then(|from| {
                                    serde_json::from_value::<FallbackEndpoint>(
                                        metadata["to"].clone(),
                                    )
                                    .map(|to| (from, to))
                                });
                        match endpoints {
                            Ok((from, to)) => {
                                self.feature("server-side-fallback-2026-06-01");
                                content.push(Block::Fallback { from, to });
                            }
                            Err(_) => self.warn(
                                "anthropic fallback metadata must include from.model and to.model",
                            ),
                        }
                    }
                    AssistantPart::Custom { .. } => {}
                    AssistantPart::ToolCall(call) => {
                        if let Some(block) = self.call(call, cache, &mut mcp_ids) {
                            content.push(block);
                        }
                    }
                    AssistantPart::ToolResult(result) => {
                        if let Some(block) = self.replay(result, &mcp_ids, cache)? {
                            content.push(block);
                        }
                    }
                }
            }
        }
        if !content.is_empty() {
            // Only local tool calls move, and never across signed reasoning or
            // fallback boundaries. Stable sort preserves order within each class.
            for segment in content.split_mut(|block| {
                matches!(
                    block,
                    Block::Thinking { .. }
                        | Block::RedactedThinking { .. }
                        | Block::Fallback { .. }
                )
            }) {
                segment.sort_by_key(|block| matches!(block, Block::ToolUse { .. }));
            }
            self.prompt
                .messages
                .push(WireMessage::Assistant { content });
        }
        Ok(())
    }
    fn call(
        &mut self,
        call: &ToolCall,
        cache: Option<CacheDirective>,
        mcp_ids: &mut HashSet<String>,
    ) -> Option<Block> {
        let metadata = canonical(&call.extensions);
        let caller = caller(&call.extensions);
        if call.provider_executed {
            if metadata["type"] == "mcp-tool-use" {
                mcp_ids.insert(call.id.clone());
                let Some(server_name) = metadata["serverName"].as_str() else {
                    self.warn("mcp tool use server name is required and must be a string");
                    return None;
                };
                return Some(Block::McpToolUse {
                    id: call.id.clone(),
                    name: call.name.clone(),
                    input: call.input.clone(),
                    server_name: server_name.into(),
                    cache_control: cache,
                });
            }
            let provider_name = self.provider_name(&call.name);
            let mut input = call.input.clone();
            let name = match provider_name {
                "code_execution" => match call.input["type"].as_str() {
                    Some(
                        subtype @ ("bash_code_execution"
                        | "text_editor_code_execution"
                        | "programmatic-tool-call"),
                    ) => {
                        input
                            .as_object_mut()
                            .expect("a discriminator requires an object")
                            .remove("type");
                        if subtype == "programmatic-tool-call" {
                            "code_execution"
                        } else {
                            subtype
                        }
                    }
                    _ => provider_name,
                },
                "web_fetch" | "web_search" | "tool_search_tool_regex" | "tool_search_tool_bm25" => {
                    provider_name
                }
                "advisor" => {
                    input = json!({});
                    provider_name
                }
                _ => {
                    self.warn(format!(
                        "provider executed tool call for tool {} is not supported",
                        call.name
                    ));
                    return None;
                }
            };
            return Some(Block::ServerToolUse {
                id: call.id.clone(),
                name: name.into(),
                input,
                caller,
                cache_control: cache,
            });
        }
        let input = if call.input.is_object() {
            call.input.clone()
        } else {
            json!({"rawInvalidInput":call.input})
        };
        let toolset = self.toolset(&call.name, &call.extensions);
        let name = if let Some(toolset) = &toolset {
            match input["action"].as_str() {
                Some(action) => action.to_owned(),
                None => {
                    self.warn(format!(
                        "toolset tool call for tool {} is missing the action",
                        call.name
                    ));
                    toolset.clone()
                }
            }
        } else {
            call.name.clone()
        };
        Some(Block::ToolUse {
            id: call.id.clone(),
            name,
            input,
            toolset_name: toolset,
            caller,
            cache_control: cache,
        })
    }
    fn prune_callers(&mut self) {
        let Some(last_user) = self.last_user else {
            return;
        };
        let sources: HashSet<_> = self
            .prompt
            .messages
            .iter()
            .filter_map(|m| match m {
                WireMessage::Assistant { content } => Some(content),
                _ => None,
            })
            .flatten()
            .filter_map(|block| match block {
                Block::ServerToolUse { name, id, .. } if name == "code_execution" => {
                    Some(id.clone())
                }
                _ => None,
            })
            .collect();
        let mut warned = HashSet::new();
        for message in &mut self.prompt.messages[..last_user] {
            let WireMessage::Assistant { content } = message else {
                continue;
            };
            for block in content {
                let Some((id, caller)) = block.caller_mut() else {
                    continue;
                };
                if let Some(source) = caller
                    .as_ref()
                    .and_then(Caller::source_id)
                    .filter(|id| !sources.contains(*id))
                {
                    if warned.insert(id.to_owned()) {
                        self.prompt.warnings.push(format!("Omitted caller metadata for tool {id} because source code execution tool {source} is missing from the conversation history."));
                    }
                    *caller = None;
                }
            }
        }
    }
}

fn caller(extensions: &Extensions) -> Option<Caller> {
    let metadata = &canonical(extensions)["caller"];
    match metadata["type"].as_str()? {
        "direct" => Some(Caller::Direct),
        "code_execution_20250825" => Some(Caller::Code20250825 {
            tool_id: metadata["toolId"]
                .as_str()
                .filter(|s| !s.is_empty())?
                .into(),
        }),
        "code_execution_20260120" => Some(Caller::Code20260120 {
            tool_id: metadata["toolId"]
                .as_str()
                .filter(|s| !s.is_empty())?
                .into(),
        }),
        _ => None,
    }
}
