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

//! Persistable Anthropic block projections. Only dirty input is decoded here;
//! ordinary requests consume small metadata and already-encoded wire fragments.
use super::*;
use crate::json_stream::JsonChunks;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageRole {
    System,
    User,
    Assistant,
}
impl MessageRole {
    fn role(self) -> Role {
        match self {
            Self::System => Role::System,
            Self::User => Role::User,
            Self::Assistant => Role::Assistant,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SystemMetadata {
    pub text_block: bool,
    pub changes: usize,
    pub clear_at: Option<ClearAt>,
    pub effort: Option<Effort>,
}
impl SystemMetadata {
    fn plain(&self) -> bool {
        self.changes == 0 && self.clear_at.is_none() && self.effort.is_none()
    }
    fn effort_only(&self) -> bool {
        !self.text_block && self.changes == 0 && self.clear_at.is_none() && self.effort.is_some()
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MessageMetadata {
    pub role: MessageRole,
    pub system: Option<SystemMetadata>,
    pub user_content: bool,
    /// Includes an empty metadata item when the logical input has no parts.
    pub part_count: usize,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CacheProgram {
    // At most three fallback candidates. Invalid unused fallbacks must not be
    // parsed eagerly: a prior accepted directive suppresses their evaluation.
    candidates: Vec<Value>,
    site: CacheSite,
    rejected: Option<(Value, CacheSite)>,
}
impl CacheProgram {
    pub fn apply(&self, budget: &mut CacheBudget) -> Result<Option<CacheDirective>> {
        let mut selected = None;
        for value in &self.candidates {
            let directive =
                serde_json::from_value(value.clone()).map_err(|error: serde_json::Error| {
                    Error::InvalidArgument {
                        field: error.to_string(),
                        value: value.clone(),
                    }
                })?;
            selected = budget.reserve(Some(directive), self.site);
            if selected.is_some() {
                break;
            }
        }
        if let Some((value, site)) = &self.rejected {
            let directive =
                serde_json::from_value(value.clone()).map_err(|error: serde_json::Error| {
                    Error::InvalidArgument {
                        field: error.to_string(),
                        value: value.clone(),
                    }
                })?;
            budget.reserve(Some(directive), *site);
        }
        Ok(selected)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FieldSlot {
    pub offset: u64,
    pub comma_before: bool,
    pub comma_after: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TextTrim {
    pub leading: Range<u64>,
    pub trailing: Range<u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CallerMetadata {
    pub id: String,
    pub caller: Caller,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DocumentMetadata {
    pub title: String,
    pub filename: Option<String>,
    pub media_type: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PartMetadata {
    pub message: MessageMetadata,
    pub part_index: usize,
    pub emitted: bool,
    pub local_tool: bool,
    pub boundary: bool,
    pub system_text: bool,
    pub cache: CacheProgram,
    pub cache_slot: Option<FieldSlot>,
    pub caller_slot: Option<FieldSlot>,
    pub caller: Option<CallerMetadata>,
    pub source_id: Option<String>,
    pub mcp_id: Option<String>,
    pub document: Option<DocumentMetadata>,
    pub features: Vec<String>,
    pub warnings: Vec<String>,
    pub trim: Option<TextTrim>,
    pub base_bytes: u64,
}
pub struct PreparedPart {
    pub metadata: PartMetadata,
    pub chunks: PreparedChunks,
}
pub struct PreparedChunks {
    chunks: Option<JsonChunks>,
    empty: bool,
}
impl Iterator for PreparedChunks {
    type Item = Vec<u8>;
    fn next(&mut self) -> Option<Self::Item> {
        if let Some(chunks) = &mut self.chunks {
            chunks.next()
        } else if std::mem::take(&mut self.empty) {
            Some(Vec::new())
        } else {
            None
        }
    }
}
/// Dirty projection codec. It retains only group-local MCP IDs and the current
/// logical-message metadata. Body storage belongs solely to the returned chunks.
pub struct PreparedEncoder {
    options: StreamOptions,
    previous: Option<Role>,
    mcp_ids: HashSet<String>,
    current: Option<MessageMetadata>,
}
impl PreparedEncoder {
    pub fn new(options: StreamOptions) -> Self {
        Self {
            options,
            previous: None,
            mcp_ids: HashSet::new(),
            current: None,
        }
    }
    /// Use when a dirty suffix continues an immutable assistant group. The IDs
    /// are the new dirty group's referenced IDs resolved by the store index,
    /// never the complete prior role-run ID set or reread bodies.
    pub fn seed_assistant_mcp(&mut self, ids: impl IntoIterator<Item = String>) {
        self.previous = Some(Role::Assistant);
        self.mcp_ids.extend(ids);
    }
    pub fn begin(&mut self, message: &Message) -> Result<usize> {
        let role = role(message);
        if self.previous != Some(role) {
            self.mcp_ids.clear();
        }
        self.previous = Some(role);
        let metadata = match message {
            Message::System { text, extensions } => {
                let options: SystemOptions = options(extensions)?;
                let text_block = !text.is_empty()
                    || (options.tool_changes.is_empty()
                        && options.clear_at.is_none()
                        && options.effort.is_none());
                MessageMetadata {
                    role: MessageRole::System,
                    user_content: false,
                    part_count: (usize::from(text_block) + options.tool_changes.len()).max(1),
                    system: Some(SystemMetadata {
                        text_block,
                        changes: options.tool_changes.len(),
                        clear_at: options.clear_at,
                        effort: options.effort,
                    }),
                }
            }
            Message::User { parts, .. } => MessageMetadata {
                role: MessageRole::User,
                system: None,
                user_content: !parts.is_empty(),
                part_count: parts.len().max(1),
            },
            Message::Tool { results, .. } => MessageMetadata {
                role: MessageRole::User,
                system: None,
                user_content: false,
                part_count: results.len().max(1),
            },
            Message::Assistant { parts, .. } => MessageMetadata {
                role: MessageRole::Assistant,
                system: None,
                user_content: false,
                part_count: parts.len().max(1),
            },
        };
        let count = metadata.part_count;
        self.current = Some(metadata);
        Ok(count)
    }
    pub fn part(&mut self, message: &Message, index: usize) -> Result<PreparedPart> {
        let message_metadata = self.current.as_ref().expect("begin before part").clone();
        let mut budget = CacheBudget::default();
        let mut builder = Builder {
            options: self.options.borrowed(),
            cache: &mut budget,
            prompt: empty_prompt(),
            last_user: None,
        };
        // A placeholder causes serde to preserve the original dynamic field's
        // insertion position. It is removed before any wire fragment is stored.
        let placeholder = Some(CacheDirective::Ephemeral { ttl: None });
        let mut local_tool = false;
        let mut boundary = false;
        let mut system_text = false;
        let mut document = None;
        let mut mcp_id = None;
        let cache = cache_program(message, index, &self.options)?;
        let mut block = match message {
            Message::System { text, extensions } => {
                let system: SystemOptions = options(extensions)?;
                if message_metadata.system.as_ref().unwrap().text_block && index == 0 {
                    system_text = true;
                    Some(Block::text(text.clone(), placeholder))
                } else if let Some(change) = system
                    .tool_changes
                    .into_iter()
                    .nth(index - usize::from(message_metadata.system.as_ref().unwrap().text_block))
                {
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
            Message::User { parts, .. } => match parts.get(index) {
                Some(UserPart::Text { text, .. }) => Some(Block::text(text.clone(), placeholder)),
                Some(UserPart::File(file)) => {
                    if matches!(file.media_type.as_str(), "application/pdf" | "text/plain")
                        && canonical(&file.extensions)["citations"]["enabled"] == true
                    {
                        document = Some(DocumentMetadata {
                            title: file
                                .filename
                                .clone()
                                .unwrap_or_else(|| "Untitled Document".into()),
                            filename: file.filename.clone(),
                            media_type: file.media_type.clone(),
                        });
                    }
                    Some(builder.file(file, placeholder)?)
                }
                Some(UserPart::Custom { .. }) => {
                    return Err(Error::unsupported("custom user content"));
                }
                None => None,
            },
            Message::Tool { results, .. } => {
                if let Some(result) = results.get(index) {
                    Some(Block::ToolResult {
                        tool_use_id: result.id.clone(),
                        content: builder.output(&result.output)?,
                        toolset_name: builder.toolset(&result.name, &result.extensions),
                        is_error: matches!(
                            result.output.value,
                            ToolValue::ErrorText(_) | ToolValue::ErrorJson(_)
                        )
                        .then_some(true),
                        cache_control: placeholder,
                    })
                } else {
                    None
                }
            }
            Message::Assistant { parts, .. } => {
                if let Some(part) = parts.get(index) {
                    local_tool =
                        matches!(part,AssistantPart::ToolCall(call) if !call.provider_executed);
                    if let AssistantPart::ToolCall(call) = part
                        && call.provider_executed
                        && canonical(&call.extensions)["type"] == "mcp-tool-use"
                    {
                        mcp_id = Some(call.id.clone());
                    }
                    boundary = inspect_assistant(&mut builder, part, &mut self.mcp_ids)?;
                    // inspect already records diagnostics; actual encode helpers can
                    // repeat a warning, so retain only the metadata pass diagnostics.
                    let warnings = builder.prompt.warnings.len();
                    let block =
                        encode_assistant(&mut builder, part, placeholder, false, &self.mcp_ids)?;
                    builder.prompt.warnings.truncate(warnings);
                    block
                } else {
                    None
                }
            }
        };
        let source_id = match &block {
            Some(Block::ServerToolUse { name, id, .. }) if name == "code_execution" => {
                Some(id.clone())
            }
            _ => None,
        };
        let caller = block
            .as_mut()
            .and_then(Block::caller_mut)
            .and_then(|(id, caller)| {
                caller.take().map(|caller| CallerMetadata {
                    id: id.into(),
                    caller,
                })
            });
        // Restore caller for slot discovery, without keeping payload in metadata.
        if let (Some(block), Some(caller)) = (&mut block, &caller)
            && let Some((_, slot)) = block.caller_mut()
        {
            *slot = Some(caller.caller.clone());
        }
        let (value, cache_slot, caller_slot, trim) = if let Some(block) = block {
            let value = serde_json::to_value(block).expect("wire block JSON");
            let (value, cache_slot, caller_slot) = strip_dynamic(value);
            let trim = if message_metadata.role == MessageRole::Assistant && value["type"] == "text"
            {
                text_trim(&value)
            } else {
                None
            };
            (Some(value), cache_slot, caller_slot, trim)
        } else {
            (None, None, None, None)
        };
        let base_bytes = value.as_ref().map(json_len).unwrap_or(0);
        let metadata = PartMetadata {
            message: message_metadata,
            part_index: index,
            emitted: value.is_some(),
            local_tool,
            boundary,
            system_text,
            cache,
            cache_slot,
            caller_slot,
            caller,
            source_id,
            mcp_id,
            document,
            features: builder
                .prompt
                .features
                .into_iter()
                .map(str::to_owned)
                .collect(),
            warnings: builder.prompt.warnings,
            trim,
            base_bytes,
        };
        Ok(PreparedPart {
            metadata,
            chunks: PreparedChunks {
                chunks: value.map(JsonChunks::new),
                empty: base_bytes == 0,
            },
        })
    }
}

fn directive(extensions: &Extensions, namespace_name: &str) -> Option<Value> {
    let custom = namespace(extensions, namespace_name).unwrap_or(&Value::Null);
    let canonical = canonical(extensions);
    [
        &custom["cacheControl"],
        &custom["cache_control"],
        &canonical["cacheControl"],
        &canonical["cache_control"],
    ]
    .into_iter()
    .find(|value| !value.is_null())
    .filter(|value| **value != false && **value != "" && **value != 0)
    .cloned()
}
fn cache_program(message: &Message, index: usize, options: &StreamOptions) -> Result<CacheProgram> {
    let mut candidates = Vec::new();
    let mut rejected = None;
    let mut add = |ext: &Extensions| {
        if let Some(value) = directive(ext, &options.cache_namespace) {
            candidates.push(value);
        }
    };
    let site = match message {
        Message::System { text, extensions } => {
            let system: SystemOptions = super::options(extensions)?;
            if index == 0
                && (!text.is_empty()
                    || (system.tool_changes.is_empty()
                        && system.clear_at.is_none()
                        && system.effort.is_none()))
            {
                add(extensions);
            }
            CacheSite::System
        }
        Message::User { parts, extensions } => {
            if let Some(part) = parts.get(index) {
                add(part.extensions());
                if index + 1 == parts.len() {
                    add(extensions);
                }
            }
            CacheSite::Text
        }
        Message::Assistant { parts, extensions } => {
            if let Some(part) = parts.get(index) {
                add(part.extensions());
                if index + 1 == parts.len() {
                    add(extensions);
                }
                if let AssistantPart::Reasoning { extensions, .. } = part
                    && options.send_reasoning
                {
                    let reasoning: ReasoningOptions = super::options(extensions)?;
                    let site = if reasoning.signature.is_some() {
                        Some(CacheSite::Reasoning)
                    } else if reasoning.redacted_data.is_some() {
                        Some(CacheSite::RedactedReasoning)
                    } else {
                        None
                    };
                    if let Some(site) = site
                        && let Some(value) = directive(extensions, &options.cache_namespace)
                    {
                        rejected = Some((value, site));
                    }
                }
            }
            CacheSite::Text
        }
        Message::Tool {
            results,
            extensions,
        } => {
            if let Some(result) = results.get(index) {
                add(&result.extensions);
                let output = result
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
                if let Some(output) = output {
                    add(output);
                }
                if index + 1 == results.len() {
                    add(extensions);
                }
            }
            CacheSite::ToolResult
        }
    };
    Ok(CacheProgram {
        candidates,
        site,
        rejected,
    })
}
struct Counter(u64);
impl std::io::Write for Counter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0 += bytes.len() as u64;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn json_len<T: Serialize + ?Sized>(value: &T) -> u64 {
    let mut count = Counter(0);
    serde_json::to_writer(&mut count, value).expect("wire JSON");
    count.0
}
fn strip_dynamic(value: Value) -> (Value, Option<FieldSlot>, Option<FieldSlot>) {
    let Value::Object(object) = value else {
        unreachable!("wire block object")
    };
    let mut base = serde_json::Map::new();
    let mut cache = None;
    let mut caller = None;
    for (key, value) in object {
        match key.as_str() {
            "cache_control" => cache = Some(base.len()),
            "caller" => caller = Some(base.len()),
            _ => {
                base.insert(key, value);
            }
        }
    }
    let slot = |index: usize| {
        let mut offset = 1;
        for (i, (key, value)) in base.iter().enumerate() {
            if i == index {
                return FieldSlot {
                    offset: offset + u64::from(i > 0),
                    comma_before: false,
                    comma_after: true,
                };
            }
            offset += u64::from(i > 0) + json_len(key) + 1 + json_len(value);
        }
        FieldSlot {
            offset,
            comma_before: !base.is_empty(),
            comma_after: false,
        }
    };
    let cache = cache.map(slot);
    let caller = caller.map(slot);
    (Value::Object(base), cache, caller)
}
fn text_trim(value: &Value) -> Option<TextTrim> {
    let object = value.as_object()?;
    let text = object.get("text")?.as_str()?;
    let mut offset = 1;
    for (index, (key, value)) in object.iter().enumerate() {
        offset += u64::from(index > 0) + json_len(key) + 1;
        if key == "text" {
            let start = offset + 1;
            let full = json_len(text) - 2;
            let leading = text.len() - text.trim_start().len();
            let trimmed = text.trim();
            let kept_start = start + json_len(&text[..leading]) - 2;
            let kept_end = kept_start + json_len(trimmed) - 2;
            return Some(TextTrim {
                leading: start..kept_start,
                trailing: kept_end..start + full,
            });
        }
        offset += json_len(value);
    }
    None
}

/// Preflight consumes persisted metadata rows only; it never reconstructs
/// Messages. This pass is O(number of parts), and actual source IDs, caller
/// relationships, citation documents and diagnostics grow with their counts.
/// The wire body is bounded/streamed; this is not a constant-memory claim for
/// arbitrarily reference-rich histories or an O(delta) preparation guarantee.
pub struct MetadataPrepass {
    inner: Prepass,
}
impl MetadataPrepass {
    pub fn new(options: StreamOptions) -> Self {
        Self {
            inner: Prepass::new(options),
        }
    }
    pub fn push(&mut self, message_index: usize, part: &PartMetadata) -> Result<()> {
        let state = &mut self.inner;
        if part.part_index == 0 {
            if message_index != state.count {
                return Err(Error::invalid(
                    "non-contiguous Anthropic prepared metadata",
                    Value::Null,
                ));
            }
            let role = part.message.role.role();
            if state.previous != Some(role) {
                state.end_group();
                state.group = message_index;
                state.system_plain = true;
            }
            state.previous = Some(role);
            if part.message.user_content {
                state.last_user = Some(state.group);
            }
            if let Some(system) = &part.message.system {
                state.system_plain &= system.plain();
                if state.group == 0 {
                    if system.changes > 0
                        && !state
                            .summary
                            .warnings
                            .iter()
                            .any(|warning| warning.starts_with("tool changes on the initial"))
                    {
                        state.summary.warnings.insert(0,"tool changes on the initial system message are not supported by Anthropic. Configure the initial tool set via the tools option instead. The tool changes have been ignored.".into());
                    }
                    if system.effort_only() {
                        add_feature(
                            &mut state.summary,
                            "mid-conversation-output-config-2026-07-01",
                        );
                    } else if system.clear_at.is_some() || system.effort.is_some() {
                        state.summary.warnings.push("clearAt and effort on this initial system message are not supported by Anthropic. Use a separate effort-only system message with empty content to set effort. These options have been ignored.".into());
                    }
                } else if state.top_system.is_some() || !state.system_plain {
                    add_feature(&mut state.summary, "mid-conversation-system-2026-04-07");
                    if system.changes > 0 {
                        add_feature(
                            &mut state.summary,
                            "mid-conversation-tool-changes-2026-07-01",
                        );
                    }
                    if system.clear_at.is_some() {
                        add_feature(
                            &mut state.summary,
                            "mid-conversation-system-clear-at-2026-08-21",
                        );
                    }
                    if system.effort.is_some() {
                        add_feature(
                            &mut state.summary,
                            "mid-conversation-output-config-2026-07-01",
                        );
                    }
                }
            }
            state.count += 1;
        }
        part.cache.apply(&mut state.cache)?;
        for feature in &part.features {
            add_feature(&mut state.summary, known_feature(feature)?);
        }
        state.summary.warnings.extend(part.warnings.iter().cloned());
        if let Some(source) = &part.source_id {
            state.sources.insert(source.clone());
        }
        if let Some(caller) = &part.caller
            && let Some(source) = caller.caller.source_id()
        {
            state
                .callers
                .push((state.group, caller.id.clone(), source.into()));
        }
        if let Some(document) = &part.document {
            state.documents.push(Document {
                title: document.title.clone(),
                filename: document.filename.clone(),
                media_type: document.media_type.clone(),
            });
        }
        Ok(())
    }
    pub fn finish(self) -> Metadata {
        self.inner.finish()
    }
}
fn add_feature(prompt: &mut PreparedPrompt, feature: &'static str) {
    if !prompt.features.contains(&feature) {
        prompt.features.push(feature);
    }
}
fn known_feature(feature: &str) -> Result<&'static str> {
    Ok(match feature {
        "files-api-2025-04-14" => "files-api-2025-04-14",
        "pdfs-2024-09-25" => "pdfs-2024-09-25",
        "compact-2026-09-04" => "compact-2026-09-04",
        "server-side-fallback-2026-06-01" => "server-side-fallback-2026-06-01",
        _ => {
            return Err(Error::invalid(
                "unknown Anthropic prepared feature",
                json!(feature),
            ));
        }
    })
}

pub struct Replay {
    context: Arc<Context>,
    cache: CacheBudget,
    previous: Option<Role>,
    group: usize,
    current: usize,
}
pub struct Decision {
    pub emit: bool,
    pub boundary: bool,
    pub local_tool: bool,
    cache: Option<CacheDirective>,
    caller: Option<Caller>,
    trim: bool,
}
impl Replay {
    pub fn new(context: Arc<Context>) -> Self {
        Self {
            context,
            cache: CacheBudget::default(),
            previous: None,
            group: 0,
            current: 0,
        }
    }
    pub fn begin(&mut self, index: usize, message: &MessageMetadata) -> MessageInfo {
        let role = message.role.role();
        if self.previous != Some(role) {
            self.group = index;
        }
        self.previous = Some(role);
        self.current = index;
        let top = self
            .context
            .top_system
            .as_ref()
            .is_some_and(|range| range.contains(&index));
        let mut header = json!({"role":match message.role {MessageRole::System=>"system",MessageRole::User=>"user",MessageRole::Assistant=>"assistant"}});
        let mut emit = true;
        if let Some(system) = &message.system {
            if top {
                emit = system.effort_only();
                if emit {
                    header["output_config"] = json!({"effort":system.effort});
                }
            } else {
                if let Some(clear) = system.clear_at {
                    header["clear_at"] = serde_json::to_value(clear).unwrap();
                }
                if let Some(effort) = system.effort {
                    header["output_config"] = json!({"effort":effort});
                }
            }
        }
        MessageInfo {
            index,
            group: if role == Role::System {
                index
            } else {
                self.group
            },
            header,
            top_level_system: top,
            emit_message: emit,
            part_count: message.part_count,
        }
    }
    pub fn part(&mut self, metadata: &PartMetadata, selection: Selection) -> Result<Decision> {
        let top = self
            .context
            .top_system
            .as_ref()
            .is_some_and(|range| range.contains(&self.current));
        let selected = match selection {
            Selection::All => true,
            Selection::System => top && metadata.system_text,
            Selection::Normal => !top && !metadata.local_tool,
            Selection::Deferred => !top && metadata.local_tool,
        };
        let cache = metadata.cache.apply(&mut self.cache)?;
        let caller = metadata
            .caller
            .as_ref()
            .map(|value| value.caller.clone())
            .filter(|caller| {
                !(self.context.last_user.is_some_and(|last| self.group < last)
                    && caller
                        .source_id()
                        .is_some_and(|id| !self.context.sources.contains(id)))
            });
        Ok(Decision {
            emit: metadata.emitted && selected && (!top || metadata.system_text),
            boundary: metadata.boundary,
            local_tool: metadata.local_tool,
            cache,
            caller,
            trim: self.current + 1 == self.context.count
                && metadata.part_index + 1 == metadata.message.part_count,
        })
    }
}
/// Per-block bounded transformation. Offsets refer to persisted static bytes;
/// inserts preserve serde field order, including cache_control before citations.
/// Each call retains only its caller-owned input chunk and the small overlay.
pub struct Overlay {
    offset: u64,
    expected: u64,
    insertions: Vec<(u64, Vec<u8>)>,
    inserted: usize,
    deletes: Vec<Range<u64>>,
}
impl Overlay {
    pub fn new(metadata: &PartMetadata, decision: &Decision) -> Self {
        let mut insertions = Vec::new();
        let mut field = |slot: &FieldSlot, name: &str, value: Value| {
            let mut bytes = Vec::new();
            if slot.comma_before {
                bytes.push(b',');
            }
            serde_json::to_writer(&mut bytes, name).unwrap();
            bytes.push(b':');
            serde_json::to_writer(&mut bytes, &value).unwrap();
            if slot.comma_after {
                bytes.push(b',');
            }
            insertions.push((slot.offset, bytes));
        };
        if let (Some(slot), Some(caller)) = (&metadata.caller_slot, &decision.caller) {
            field(slot, "caller", serde_json::to_value(caller).unwrap());
        }
        if let (Some(slot), Some(cache)) = (&metadata.cache_slot, decision.cache) {
            field(slot, "cache_control", serde_json::to_value(cache).unwrap());
        }
        insertions.sort_by_key(|(offset, _)| *offset);
        let deletes = if decision.trim {
            metadata
                .trim
                .as_ref()
                .map(|trim| vec![trim.leading.clone(), trim.trailing.clone()])
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        Self {
            offset: 0,
            expected: metadata.base_bytes,
            insertions,
            inserted: 0,
            deletes,
        }
    }
    pub fn push(&mut self, chunk: &[u8]) -> Vec<u8> {
        let mut output = Vec::with_capacity(chunk.len());
        for byte in chunk {
            while let Some((offset, bytes)) = self.insertions.get(self.inserted) {
                if *offset != self.offset {
                    break;
                }
                output.extend_from_slice(bytes);
                self.inserted += 1;
            }
            if !self
                .deletes
                .iter()
                .any(|range| range.contains(&self.offset))
            {
                output.push(*byte);
            }
            self.offset += 1;
        }
        output
    }
    pub fn finish(&self) -> Result<()> {
        if self.offset != self.expected || self.inserted != self.insertions.len() {
            return Err(Error::invalid(
                "incomplete Anthropic prepared wire block",
                Value::Null,
            ));
        }
        Ok(())
    }
}
