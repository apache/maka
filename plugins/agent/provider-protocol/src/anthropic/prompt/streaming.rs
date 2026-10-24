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
    options: StreamOptions,
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

pub struct Prepass {
    options: StreamOptions,
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
    mcp_ids: HashSet<String>,
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
impl Prepass {
    pub fn new(options: StreamOptions) -> Self {
        Self {
            options,
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
            mcp_ids: HashSet::new(),
            documents: Vec::new(),
        }
    }
    fn end_group(&mut self) {
        if self.previous == Some(Role::System)
            && self.top_system.is_none()
            && (self.group == 0 || self.system_plain)
        {
            self.top_system = Some(self.group..self.count);
        }
    }
    pub fn push(&mut self, message: &Message) -> Result<()> {
        let role = role(message);
        if self.previous != Some(role) {
            self.end_group();
            self.group = self.count;
            self.system_plain = true;
            self.mcp_ids.clear();
        }
        self.previous = Some(role);
        let mut builder = Builder {
            options: self.options.borrowed(),
            cache: &mut self.cache,
            prompt: empty_prompt(),
            last_user: None,
        };
        match message {
            Message::System { text, extensions } => {
                let system: SystemOptions = options(extensions)?;
                let plain = system.clear_at.is_none()
                    && system.effort.is_none()
                    && system.tool_changes.is_empty();
                self.system_plain &= plain;
                if !text.is_empty() || plain {
                    builder.cache(extensions, CacheSite::System)?;
                }
                if self.group == 0 {
                    // This warning is once per initial role group, matching batch encoding.
                    if !system.tool_changes.is_empty()
                        && !self
                            .summary
                            .warnings
                            .iter()
                            .any(|s| s.starts_with("tool changes on the initial"))
                    {
                        self.summary.warnings.insert(0, "tool changes on the initial system message are not supported by Anthropic. Configure the initial tool set via the tools option instead. The tool changes have been ignored.".into());
                    }
                    let content_empty = text.is_empty() && !plain && system.tool_changes.is_empty();
                    if content_empty && system.clear_at.is_none() && system.effort.is_some() {
                        builder.feature("mid-conversation-output-config-2026-07-01");
                    } else if system.clear_at.is_some() || system.effort.is_some() {
                        builder.warn("clearAt and effort on this initial system message are not supported by Anthropic. Use a separate effort-only system message with empty content to set effort. These options have been ignored.");
                    }
                } else if self.top_system.is_some() || !self.system_plain {
                    builder.feature("mid-conversation-system-2026-04-07");
                    if !system.tool_changes.is_empty() {
                        builder.feature("mid-conversation-tool-changes-2026-07-01");
                    }
                    if system.clear_at.is_some() {
                        builder.feature("mid-conversation-system-clear-at-2026-08-21");
                    }
                    if system.effort.is_some() {
                        builder.feature("mid-conversation-output-config-2026-07-01");
                    }
                }
            }
            Message::User { parts, extensions } => {
                if !parts.is_empty() {
                    self.last_user = Some(self.group);
                }
                for (index, part) in parts.iter().enumerate() {
                    builder.part_cache(
                        part.extensions(),
                        extensions,
                        index + 1 == parts.len(),
                        CacheSite::Text,
                    )?;
                    match part {
                        UserPart::Text { .. } => {}
                        UserPart::Custom { .. } => {
                            return Err(Error::unsupported("custom user content"));
                        }
                        UserPart::File(file) => {
                            inspect_file(&mut builder, file, false)?;
                            if matches!(file.media_type.as_str(), "application/pdf" | "text/plain")
                                && canonical(&file.extensions)["citations"]["enabled"] == true
                            {
                                self.documents.push(Document {
                                    title: file
                                        .filename
                                        .clone()
                                        .unwrap_or_else(|| "Untitled Document".into()),
                                    filename: file.filename.clone(),
                                    media_type: file.media_type.clone(),
                                });
                            }
                        }
                    }
                }
            }
            Message::Tool {
                results,
                extensions,
            } => {
                for (index, result) in results.iter().enumerate() {
                    result_cache(&mut builder, result, extensions, index + 1 == results.len())?;
                    inspect_output(&mut builder, &result.output)?;
                }
            }
            Message::Assistant { parts, extensions } => {
                for (index, part) in parts.iter().enumerate() {
                    builder.part_cache(
                        part.extensions(),
                        extensions,
                        index + 1 == parts.len(),
                        CacheSite::Text,
                    )?;
                    inspect_assistant(&mut builder, part, &mut self.mcp_ids)?;
                    if let AssistantPart::ToolCall(call) = part {
                        let name = builder.provider_name(&call.name);
                        let metadata = canonical(&call.extensions);
                        if call.provider_executed
                            && metadata["type"] != "mcp-tool-use"
                            && name == "code_execution"
                            && !matches!(
                                call.input["type"].as_str(),
                                Some("bash_code_execution" | "text_editor_code_execution")
                            )
                        {
                            self.sources.insert(call.id.clone());
                        }
                        let emitted = !call.provider_executed
                            || (metadata["type"] != "mcp-tool-use"
                                && matches!(
                                    name,
                                    "code_execution"
                                        | "web_fetch"
                                        | "web_search"
                                        | "tool_search_tool_regex"
                                        | "tool_search_tool_bm25"
                                        | "advisor"
                                ));
                        if emitted
                            && let Some(source) = caller(&call.extensions)
                                .as_ref()
                                .and_then(Caller::source_id)
                        {
                            self.callers
                                .push((self.group, call.id.clone(), source.into()));
                        }
                    } else if let AssistantPart::ToolResult(result) = part
                        && !self.mcp_ids.contains(&result.id)
                        && matches!(
                            builder.provider_name(&result.name),
                            "web_fetch" | "web_search"
                        )
                        && matches!(
                            result.output.value,
                            ToolValue::Json(_) | ToolValue::ErrorJson(_)
                        )
                        && let Some(source) = caller(&result.extensions)
                            .as_ref()
                            .and_then(Caller::source_id)
                    {
                        self.callers
                            .push((self.group, result.id.clone(), source.into()));
                    }
                }
            }
        }
        for feature in builder.prompt.features {
            if !self.summary.features.contains(&feature) {
                self.summary.features.push(feature);
            }
        }
        self.summary.warnings.extend(builder.prompt.warnings);
        self.count += 1;
        Ok(())
    }
    pub fn finish(mut self) -> Metadata {
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
                options: self.options,
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
pub struct EncodedPart {
    pub block: Option<Block>,
    pub boundary: bool,
    pub local_tool: bool,
}
/// One deterministic metadata/caching state per monotonic replay cursor. The
/// caller owns at most its current logical Message and releases each output
/// Block after its JSON chunks drain. Never feed a role-group Vec here.
pub struct Encoder {
    context: Arc<Context>,
    cache: CacheBudget,
    index: usize,
    current: Option<usize>,
    previous: Option<Role>,
    group: usize,
    mcp_ids: HashSet<String>,
}
impl Encoder {
    pub fn new(context: Arc<Context>) -> Self {
        Self {
            context,
            cache: CacheBudget::default(),
            index: 0,
            current: None,
            previous: None,
            group: 0,
            mcp_ids: HashSet::new(),
        }
    }
    pub fn begin(&mut self, message: &Message) -> Result<MessageInfo> {
        let index = self.index;
        self.index += 1;
        self.current = Some(index);
        let role = role(message);
        if self.previous != Some(role) {
            self.group = index;
            self.mcp_ids.clear();
        }
        self.previous = Some(role);
        let top = self
            .context
            .top_system
            .as_ref()
            .is_some_and(|range| range.contains(&index));
        let (header, count, emit) = match message {
            Message::System { text, extensions } => {
                let system: SystemOptions = options(extensions)?;
                let text_block = !text.is_empty()
                    || (system.tool_changes.is_empty()
                        && system.clear_at.is_none()
                        && system.effort.is_none());
                let effort_only = !text_block
                    && system.tool_changes.is_empty()
                    && system.clear_at.is_none()
                    && system.effort.is_some();
                let header = if top {
                    if effort_only {
                        json!({"role":"system","output_config":{"effort":system.effort}})
                    } else {
                        json!({"role":"system"})
                    }
                } else {
                    let mut header = json!({"role":"system"});
                    if let Some(clear) = system.clear_at {
                        header["clear_at"] = serde_json::to_value(clear).unwrap();
                    }
                    if let Some(effort) = system.effort {
                        header["output_config"] = json!({"effort":effort});
                    }
                    header
                };
                (
                    header,
                    usize::from(text_block) + if top { 0 } else { system.tool_changes.len() },
                    !top || effort_only,
                )
            }
            Message::User { parts, .. } => (json!({"role":"user"}), parts.len(), true),
            Message::Tool { results, .. } => (json!({"role":"user"}), results.len(), true),
            Message::Assistant { parts, .. } => (json!({"role":"assistant"}), parts.len(), true),
        };
        Ok(MessageInfo {
            index,
            group: if role == Role::System {
                index
            } else {
                self.group
            },
            header,
            top_level_system: top,
            emit_message: emit,
            part_count: count,
        })
    }
    pub fn part(
        &mut self,
        message: &Message,
        part_index: usize,
        selection: Selection,
    ) -> Result<EncodedPart> {
        let index = self.current.expect("begin must precede part");
        let top = self
            .context
            .top_system
            .as_ref()
            .is_some_and(|range| range.contains(&index));
        let local = matches!(message, Message::Assistant { parts, .. }
            if matches!(&parts[part_index], AssistantPart::ToolCall(call) if !call.provider_executed));
        let selected = match selection {
            Selection::All => true,
            Selection::System => top,
            Selection::Normal => !top && !local,
            Selection::Deferred => !top && local,
        };
        let mut builder = Builder {
            options: self.context.options.borrowed(),
            cache: &mut self.cache,
            prompt: empty_prompt(),
            last_user: None,
        };
        let mut boundary = false;
        let mut block = match message {
            Message::System { text, extensions } => {
                let system: SystemOptions = options(extensions)?;
                let has_text = !text.is_empty()
                    || (system.tool_changes.is_empty()
                        && system.clear_at.is_none()
                        && system.effort.is_none());
                if has_text && part_index == 0 {
                    let cache = builder.cache(extensions, CacheSite::System)?;
                    selected.then(|| Block::text(text.clone(), cache))
                } else if selected {
                    let change = system
                        .tool_changes
                        .into_iter()
                        .nth(part_index - usize::from(has_text))
                        .expect("system part index");
                    let (add, name) = match change {
                        ToolChange::ToolAddition { name } => (true, name),
                        ToolChange::ToolRemoval { name } => (false, name),
                    };
                    let tool = NamedReference {
                        name: builder.provider_name(&name).into(),
                    };
                    Some(if add {
                        Block::ToolAddition { tool }
                    } else {
                        Block::ToolRemoval { tool }
                    })
                } else {
                    None
                }
            }
            Message::User { parts, extensions } => {
                let part = &parts[part_index];
                let cache = builder.part_cache(
                    part.extensions(),
                    extensions,
                    part_index + 1 == parts.len(),
                    CacheSite::Text,
                )?;
                if selected {
                    Some(match part {
                        UserPart::Text { text, .. } => Block::text(text.clone(), cache),
                        UserPart::File(file) => builder.file(file, cache)?,
                        UserPart::Custom { .. } => {
                            return Err(Error::unsupported("custom user content"));
                        }
                    })
                } else {
                    None
                }
            }
            Message::Tool {
                results,
                extensions,
            } => {
                let result = &results[part_index];
                let cache = result_cache(
                    &mut builder,
                    result,
                    extensions,
                    part_index + 1 == results.len(),
                )?;
                if selected {
                    Some(Block::ToolResult {
                        tool_use_id: result.id.clone(),
                        content: builder.output(&result.output)?,
                        toolset_name: builder.toolset(&result.name, &result.extensions),
                        is_error: matches!(
                            result.output.value,
                            ToolValue::ErrorText(_) | ToolValue::ErrorJson(_)
                        )
                        .then_some(true),
                        cache_control: cache,
                    })
                } else {
                    None
                }
            }
            Message::Assistant { parts, extensions } => {
                let part = &parts[part_index];
                let cache = builder.part_cache(
                    part.extensions(),
                    extensions,
                    part_index + 1 == parts.len(),
                    CacheSite::Text,
                )?;
                boundary = inspect_assistant(&mut builder, part, &mut self.mcp_ids)?;
                if selected {
                    encode_assistant(
                        &mut builder,
                        part,
                        cache,
                        index + 1 == self.context.count && part_index + 1 == parts.len(),
                        &self.mcp_ids,
                    )?
                } else {
                    None
                }
            }
        };
        if self.context.last_user.is_some_and(|last| self.group < last)
            && let Some((_, caller)) = block.as_mut().and_then(Block::caller_mut)
            && caller
                .as_ref()
                .and_then(Caller::source_id)
                .is_some_and(|id| !self.context.sources.contains(id))
        {
            *caller = None;
        }
        Ok(EncodedPart {
            block,
            boundary,
            local_tool: local,
        })
    }
}

fn result_cache(
    builder: &mut Builder<'_>,
    result: &ToolResult,
    extensions: &Extensions,
    last: bool,
) -> Result<Option<CacheDirective>> {
    let output_options = result
        .output
        .extensions
        .as_ref()
        .map(|_| &result.output.extensions)
        .or_else(|| match &result.output.value {
            ToolValue::Content(parts) => parts
                .iter()
                .find(|part| part.extensions().is_some())
                .map(UserPart::extensions),
            _ => None,
        });
    let mut cache = builder.cache(&result.extensions, CacheSite::ToolResult)?;
    if cache.is_none()
        && let Some(options) = output_options
    {
        cache = builder.cache(options, CacheSite::ToolResult)?;
    }
    if cache.is_none() && last {
        cache = builder.cache(extensions, CacheSite::ToolResult)?;
    }
    Ok(cache)
}
fn inspect_file(builder: &mut Builder<'_>, file: &File, tool_result: bool) -> Result<()> {
    let image = file.media_type.split('/').next() == Some("image");
    match &file.source {
        FileSource::Reference(_) => {
            file.reference("anthropic")?;
            builder.feature("files-api-2025-04-14");
        }
        FileSource::Inline(_) => {
            // Media sniffing may read the single logical file payload; it never
            // encodes or retains a second copy of its body in the prepass.
            let media = if file.media_type == "text/plain" && !tool_result {
                "text/plain".into()
            } else {
                file.resolved_media_type()?
            };
            if !image && media != "application/pdf" && (tool_result || media != "text/plain") {
                if tool_result {
                    builder.warn(format!(
                        "unsupported tool content part type: file with media type: {}",
                        file.media_type
                    ));
                } else {
                    return Err(Error::unsupported(format!(
                        "media type: {}",
                        file.media_type
                    )));
                }
            }
            if media == "application/pdf" {
                builder.feature("pdfs-2024-09-25");
            }
        }
        FileSource::Url(_) => {
            if !tool_result
                && !image
                && !matches!(file.media_type.as_str(), "application/pdf" | "text/plain")
            {
                return Err(Error::unsupported(format!(
                    "media type: {}",
                    file.media_type
                )));
            }
            if !tool_result && file.media_type == "application/pdf" {
                builder.feature("pdfs-2024-09-25");
            }
        }
        FileSource::Text(_) if tool_result => {
            builder.warn("unsupported tool content part type: file with data type: text")
        }
        _ => {}
    }
    if !tool_result {
        let _: FileOptions = options(&file.extensions)?;
    }
    Ok(())
}
fn inspect_output(builder: &mut Builder<'_>, output: &ToolOutput) -> Result<()> {
    if let ToolValue::Content(parts) = &output.value {
        for part in parts {
            match part {
                UserPart::File(file) => inspect_file(builder, file, true)?,
                UserPart::Custom { extensions, .. }
                    if canonical(extensions)["type"] != "tool-reference" =>
                {
                    builder.warn("unsupported custom tool content part")
                }
                _ => {}
            }
        }
    }
    Ok(())
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
    final_part: bool,
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
            text: if final_part {
                text.trim().into()
            } else {
                text.clone()
            },
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
