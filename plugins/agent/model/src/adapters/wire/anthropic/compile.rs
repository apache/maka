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

//! Source-backed Anthropic block construction. No body is materialized here.
use super::super::source::{FragmentCursor, SourceFragment, SourceItem};
use super::hosted::{hosted_result, normalize_object_without};
use super::inspect_text;
use crate::ModelError;
use bytes::Bytes;
use maka_agent_facts::{
    language::Language,
    model::prompt_source::{
        WireItemMetadata,
        source::{
            AssistantRecipe, ByteCursor, ByteSource, ChargedBuffer, ContentRecipe, IdentifiedText,
            JsonSource, MediaSource, MessageRecipe, ReadSource, RecipeCursor, RecipeSource,
            SourceBudget, SourceBytes, SourceRead, TextEncoding, TextSource, ToolInputRecipe,
            ToolOutputRecipe, ToolResultKind, ToolResultRecipe, ToolResultReplay,
            json::{self, JsonKind, JsonValue},
            text,
        },
    },
};
use maka_provider_protocol::anthropic::{
    CacheDirective, CacheSite, CacheTtl,
    prompt::{
        Caller,
        prepared::{
            CacheProgram, CallerMetadata, DocumentMetadata, FieldSlot, FrozenCacheCandidate,
            MessageMetadata, MessageRole, PartMetadata, SystemMetadata, TextTrim,
        },
        streaming::StreamOptions,
    },
};
use sha2::{Digest, Sha256};
use std::{collections::VecDeque, io, sync::Arc};

// Directory futures can be immediately ready; yield between bounded record batches.
const DIRECTORY_WORK_QUANTUM: usize = 64;

type Metadata = PartMetadata<IdentifiedText, FrozenCacheCandidate>;
fn failure(error: io::Error) -> ModelError {
    ModelError::Adapter(error.to_string())
}
fn invalid(message: &'static str) -> ModelError {
    ModelError::Adapter(message.into())
}
fn static_text(value: &'static str) -> TextSource {
    TextSource::new(
        SourceBytes::Inline(Bytes::from_static(value.as_bytes())),
        TextEncoding::Utf8,
    )
}
fn literal(value: &'static [u8]) -> SourceFragment {
    SourceFragment::literal(value)
}
fn quoted(value: TextSource) -> Vec<SourceFragment> {
    vec![literal(b"\""), SourceFragment::Text(value), literal(b"\"")]
}
fn generated(value: impl serde::Serialize) -> SourceFragment {
    SourceFragment::owned(serde_json::to_vec(&value).expect("generated protocol field"))
}

#[derive(Clone)]
pub(in crate::adapters::wire) struct Compiler {
    options: Arc<StreamOptions>,
    language: Language,
    inspection: MediaInspection,
}
impl Compiler {
    pub(in crate::adapters::wire) fn new(options: Arc<StreamOptions>, language: Language) -> Self {
        Self {
            options,
            language,
            inspection: MediaInspection::Wire,
        }
    }
    pub(in crate::adapters::wire) fn directory(mut self) -> Self {
        self.inspection = MediaInspection::Directory;
        self
    }
    pub(in crate::adapters::wire) async fn open(
        &self,
        message: MessageRecipe,
        budget: Arc<dyn SourceBudget>,
    ) -> Result<MessageCursor, ModelError> {
        let (options, role, user_content, count) = match &message {
            MessageRecipe::System {
                provider_options, ..
            } => (provider_options.clone(), MessageRole::System, false, 1),
            MessageRecipe::User {
                content,
                provider_options,
            } => (
                provider_options.clone(),
                MessageRole::User,
                !content.is_empty(),
                content.len(),
            ),
            MessageRecipe::Assistant {
                content,
                provider_options,
            } => (
                provider_options.clone(),
                MessageRole::Assistant,
                false,
                content.len(),
            ),
            MessageRecipe::Tool {
                content,
                provider_options,
            } => (
                provider_options.clone(),
                MessageRole::User,
                false,
                content.len(),
            ),
        };
        if !matches!(&message, MessageRecipe::Tool { .. }) {
            validate_options(&options, budget.clone()).await?;
        }
        let mut info = MessageMetadata {
            role,
            user_content,
            part_count: count.max(1),
            system: None,
        };
        let mut empty = count == 0;
        let state = match message {
            MessageRecipe::System { content, .. } => {
                let opts = Options::new(options.clone(), budget.clone()).await?;
                opts.require_object()?;
                let bounds = inspect_text(content.clone(), budget.clone())
                    .await
                    .map_err(failure)?;
                let changes = match opts.get("toolChanges") {
                    Some(value) if value.kind == JsonKind::Array => Some(value.source),
                    Some(_) => return Err(invalid("Anthropic toolChanges must be an array")),
                    None => None,
                };
                let mut changes_count = 0usize;
                if let Some(changes) = &changes {
                    let mut cursor = json::ArrayCursor::open(changes.clone(), budget.clone())
                        .await
                        .map_err(failure)?;
                    while cursor.next().await.map_err(failure)?.is_some() {
                        changes_count += 1;
                        if changes_count.is_multiple_of(DIRECTORY_WORK_QUANTUM) {
                            tokio::task::yield_now().await;
                        }
                    }
                }
                let clear = match opts.get("clearAt") {
                    Some(value) if value.kind != JsonKind::Null => {
                        if !equal(&value, "next_user_message", budget.clone()).await? {
                            return Err(invalid("invalid Anthropic clearAt"));
                        }
                        Some(maka_provider_protocol::anthropic::prompt::prepared::ClearAt::NextUserMessage)
                    }
                    _ => None,
                };
                let effort = match opts.get("effort") {
                    Some(value) if value.kind != JsonKind::Null => {
                        Some(parse_effort(value, budget.clone()).await?)
                    }
                    _ => None,
                };
                let text_block = bounds.encoded_len > 0
                    || (changes_count == 0 && clear.is_none() && effort.is_none());
                info.part_count = (usize::from(text_block) + changes_count).max(1);
                info.system = Some(SystemMetadata {
                    text_block,
                    changes: changes_count,
                    clear_at: clear,
                    effort,
                });
                empty = !text_block && changes_count == 0;
                let changes = match changes {
                    Some(source) => Some(Box::new(
                        json::ArrayCursor::open(source, budget.clone())
                            .await
                            .map_err(failure)?,
                    )),
                    None => None,
                };
                MessageState::System {
                    content: text_block.then_some(content),
                    changes,
                }
            }
            MessageRecipe::User { content, .. } => MessageState::User(content.open(0)),
            MessageRecipe::Assistant { content, .. } => MessageState::Assistant(content.open(0)),
            MessageRecipe::Tool { content, .. } => {
                let mut probe = content.open(0);
                let mut split = false;
                let mut normal = false;
                let mut probed = 0usize;
                while let Some(result) = probe.next().await.map_err(failure)? {
                    split |= result.kind == ToolResultKind::Notification;
                    normal |= result.kind != ToolResultKind::Notification;
                    probed += 1;
                    if probed.is_multiple_of(DIRECTORY_WORK_QUANTUM) {
                        tokio::task::yield_now().await;
                    }
                }
                if !split || normal {
                    validate_options(&options, budget.clone()).await?;
                }
                MessageState::Tool {
                    cursor: content.open(0),
                    split,
                }
            }
        };
        Ok(MessageCursor {
            compiler: self.clone(),
            state,
            budget,
            options,
            info,
            index: 0,
            empty,
            finished: false,
        })
    }
    async fn provider_name(
        &self,
        name: TextSource,
        budget: Arc<dyn SourceBudget>,
    ) -> Result<(TextSource, usize), ModelError> {
        for (from, to) in &self.options.tool_names {
            if json::text_eq(&name, from, budget.clone())
                .await
                .map_err(failure)?
            {
                let bytes = to.as_bytes().to_vec();
                let capacity = bytes.capacity();
                return Ok((
                    TextSource::new(SourceBytes::Inline(Bytes::from(bytes)), TextEncoding::Utf8),
                    capacity,
                ));
            }
        }
        Ok((name, 0))
    }
}
enum MessageState {
    System {
        content: Option<TextSource>,
        changes: Option<Box<json::ArrayCursor>>,
    },
    User(Box<dyn RecipeCursor<ContentRecipe>>),
    Assistant(Box<dyn RecipeCursor<AssistantRecipe>>),
    Tool {
        cursor: Box<dyn RecipeCursor<ToolResultRecipe>>,
        split: bool,
    },
}
pub(in crate::adapters::wire) struct MessageCursor {
    compiler: Compiler,
    state: MessageState,
    budget: Arc<dyn SourceBudget>,
    options: Option<JsonSource>,
    info: MessageMetadata,
    index: usize,
    empty: bool,
    finished: bool,
}
impl MessageCursor {
    pub(in crate::adapters::wire) async fn next(
        &mut self,
    ) -> Result<Option<SourceItem>, ModelError> {
        if self.finished {
            return Ok(None);
        }
        if std::mem::take(&mut self.empty) {
            self.finished = true;
            return Ok(Some(
                Plan::empty()
                    .finish(self.info.clone(), 0, self.budget.clone())
                    .await?,
            ));
        }
        loop {
            let index = self.index;
            let mut info = self.info.clone();
            let plan = match &mut self.state {
                MessageState::System { content, changes } => {
                    if let Some(content) = content.take() {
                        let mut plan = Plan::new("text");
                        plan.text("text", content, true);
                        plan.system_text = true;
                        plan.cache = cache_program(
                            std::slice::from_ref(&self.options),
                            CacheSite::System,
                            None,
                            &self.compiler.options,
                            self.budget.clone(),
                        )
                        .await?;
                        plan
                    } else if let Some(changes) = changes {
                        match changes.next().await.map_err(failure)? {
                            Some(change) => {
                                self.compiler
                                    .system_change(change, self.budget.clone())
                                    .await?
                            }
                            None => {
                                self.finished = true;
                                return Ok(None);
                            }
                        }
                    } else {
                        self.finished = true;
                        return Ok(None);
                    }
                }
                MessageState::User(cursor) => {
                    let Some(part) = cursor.next().await.map_err(failure)? else {
                        self.finished = true;
                        return Ok(None);
                    };
                    let mut options = content_options(&part);
                    let mut plan = self
                        .compiler
                        .content(part, false, self.budget.clone())
                        .await?;
                    if plan.audio_fallback {
                        options = None;
                    }
                    plan.cache = cache_program(
                        &[
                            options,
                            if index + 1 == info.part_count {
                                self.options.clone()
                            } else {
                                None
                            },
                        ],
                        CacheSite::Text,
                        None,
                        &self.compiler.options,
                        self.budget.clone(),
                    )
                    .await?;
                    plan
                }
                MessageState::Assistant(cursor) => {
                    let Some(part) = cursor.next().await.map_err(failure)? else {
                        self.finished = true;
                        return Ok(None);
                    };
                    let options = assistant_options(&part);
                    let mut plan = self
                        .compiler
                        .assistant_part(part, self.budget.clone())
                        .await?;
                    plan.cache = cache_program(
                        &[
                            options.clone(),
                            if index + 1 == info.part_count {
                                self.options.clone()
                            } else {
                                None
                            },
                        ],
                        CacheSite::Text,
                        plan.reasoning_site.map(|site| (options, site)),
                        &self.compiler.options,
                        self.budget.clone(),
                    )
                    .await?;
                    plan
                }
                MessageState::Tool { cursor, split } => {
                    let Some(result) = cursor.next().await.map_err(failure)? else {
                        self.finished = true;
                        return Ok(None);
                    };
                    let options = result.provider_options.clone();
                    let notification = result.kind == ToolResultKind::Notification;
                    let output_options = if notification {
                        None
                    } else {
                        output_cache_options(&result.output, self.budget.clone()).await?
                    };
                    let mut plan = if notification {
                        self.compiler
                            .notification(result, self.budget.clone())
                            .await?
                    } else {
                        self.compiler
                            .result(result, false, self.budget.clone())
                            .await?
                    };
                    if notification && !plan.emitted {
                        self.index += 1;
                        if self.index.is_multiple_of(DIRECTORY_WORK_QUANTUM) {
                            tokio::task::yield_now().await;
                        }
                        continue;
                    }
                    if !notification {
                        plan.cache = cache_program(
                            &[
                                options,
                                output_options,
                                if *split || index + 1 == info.part_count {
                                    self.options.clone()
                                } else {
                                    None
                                },
                            ],
                            CacheSite::ToolResult,
                            None,
                            &self.compiler.options,
                            self.budget.clone(),
                        )
                        .await?;
                        plan.cache_slot_at = Some(plan.fragments.len());
                    }
                    if *split {
                        info = MessageMetadata {
                            role: MessageRole::User,
                            system: None,
                            user_content: notification,
                            part_count: 1,
                        };
                    }
                    plan
                }
            };
            self.index += 1;
            if self.index.is_multiple_of(DIRECTORY_WORK_QUANTUM) {
                tokio::task::yield_now().await;
            }
            let part_index = if matches!(&self.state, MessageState::Tool { split: true, .. }) {
                0
            } else {
                index
            };
            return Ok(Some(
                plan.finish(info, part_index, self.budget.clone()).await?,
            ));
        }
    }
}
impl Compiler {
    async fn system_change(
        &self,
        change: JsonValue,
        budget: Arc<dyn SourceBudget>,
    ) -> Result<Plan, ModelError> {
        let values = json::fields(&change.source, &["type", "toolName"], budget.clone())
            .await
            .map_err(failure)?;
        let kind = values[0]
            .as_ref()
            .ok_or_else(|| invalid("Anthropic tool change is missing type"))?;
        let name = values[1]
            .as_ref()
            .ok_or_else(|| invalid("Anthropic tool change is missing toolName"))?
            .text()
            .map_err(failure)?;
        let add = equal(kind, "tool_addition", budget.clone()).await?;
        if !add && !equal(kind, "tool_removal", budget.clone()).await? {
            return Err(invalid("invalid Anthropic tool change"));
        }
        let mut plan = Plan::new(if add { "tool_addition" } else { "tool_removal" });
        let mut value = vec![literal(b"{\"type\":\"tool_reference\",\"name\":")];
        let (name, capacity) = self.provider_name(name, budget).await?;
        plan.owned_bytes += capacity;
        value.extend(quoted(name));
        value.push(literal(b"}"));
        plan.field("tool", value);
        Ok(plan)
    }
}
fn content_options(part: &ContentRecipe) -> Option<JsonSource> {
    match part {
        ContentRecipe::Text {
            provider_options, ..
        }
        | ContentRecipe::Media {
            provider_options, ..
        } => provider_options.clone(),
    }
}
fn assistant_options(part: &AssistantRecipe) -> Option<JsonSource> {
    match part {
        AssistantRecipe::Text {
            provider_options, ..
        }
        | AssistantRecipe::Reasoning {
            provider_options, ..
        }
        | AssistantRecipe::ToolCall {
            provider_options, ..
        } => provider_options.clone(),
        AssistantRecipe::ToolResult(result) => result.provider_options.clone(),
    }
}

const OPTION_FIELDS: &[&str] = &[
    "toolChanges",
    "clearAt",
    "effort",
    "type",
    "signature",
    "redactedData",
    "citations",
    "caller",
    "serverName",
    "toolsetName",
    "title",
    "context",
    "containerUpload",
];
struct Options {
    kind: Option<JsonKind>,
    fields: Vec<Option<JsonValue>>,
    budget: Arc<dyn SourceBudget>,
}
impl Options {
    async fn new(
        options: Option<JsonSource>,
        budget: Arc<dyn SourceBudget>,
    ) -> Result<Self, ModelError> {
        validate_options(&options, budget.clone()).await?;
        let namespace = match options {
            Some(options) => json::field(&options, &["anthropic"], budget.clone())
                .await
                .map_err(failure)?
                .filter(|value| value.kind != JsonKind::Null),
            None => None,
        };
        let kind = namespace.as_ref().map(|value| value.kind);
        let fields = match namespace {
            Some(value) if value.kind == JsonKind::Object => {
                json::fields(&value.source, OPTION_FIELDS, budget.clone())
                    .await
                    .map_err(failure)?
            }
            _ => Vec::new(),
        };
        Ok(Self {
            kind,
            fields,
            budget,
        })
    }
    fn require_object(&self) -> Result<(), ModelError> {
        if self.kind.is_some_and(|kind| kind != JsonKind::Object) {
            return Err(invalid("Anthropic options must be an object"));
        }
        Ok(())
    }
    fn get(&self, name: &str) -> Option<JsonValue> {
        OPTION_FIELDS
            .iter()
            .position(|field| *field == name)
            .and_then(|index| self.fields.get(index))
            .cloned()
            .flatten()
    }
    fn maybe_string(&self, name: &str) -> Option<TextSource> {
        self.get(name)
            .filter(|value| value.kind == JsonKind::String)
            .map(|value| value.text().expect("checked JSON string kind"))
    }
    fn string(&self, name: &str) -> Result<Option<TextSource>, ModelError> {
        match self.get(name) {
            Some(value) if value.kind == JsonKind::Null => Ok(None),
            Some(value) => Ok(Some(value.text().map_err(failure)?)),
            None => Ok(None),
        }
    }
    async fn is(&self, name: &str, value: &str) -> Result<bool, ModelError> {
        match self.get(name) {
            Some(field) => equal(&field, value, self.budget.clone()).await,
            None => Ok(false),
        }
    }
}

async fn equal(
    value: &JsonValue,
    expected: &str,
    budget: Arc<dyn SourceBudget>,
) -> Result<bool, ModelError> {
    if value.kind != JsonKind::String {
        return Ok(false);
    }
    json::text_eq(&value.text().map_err(failure)?, expected, budget)
        .await
        .map_err(failure)
}
async fn parse_effort(
    value: JsonValue,
    budget: Arc<dyn SourceBudget>,
) -> Result<maka_provider_protocol::anthropic::prompt::prepared::Effort, ModelError> {
    use maka_provider_protocol::anthropic::prompt::prepared::Effort;
    for (name, effort) in [
        ("low", Effort::Low),
        ("medium", Effort::Medium),
        ("high", Effort::High),
        ("xhigh", Effort::Xhigh),
        ("max", Effort::Max),
    ] {
        if equal(&value, name, budget.clone()).await? {
            return Ok(effort);
        }
    }
    Err(invalid("invalid Anthropic effort"))
}
async fn directive(
    options: Option<JsonSource>,
    namespace: &str,
    budget: Arc<dyn SourceBudget>,
) -> Result<Option<FrozenCacheCandidate>, ModelError> {
    validate_options(&options, budget.clone()).await?;
    let Some(options) = options else {
        return Ok(None);
    };
    let mut found = None;
    for (index, name) in [namespace, "anthropic"].into_iter().enumerate() {
        if index == 1 && name == namespace {
            break;
        }
        if let Some(space) = json::field(&options, &[name], budget.clone())
            .await
            .map_err(failure)?
        {
            found = json::fields(
                &space.source,
                &["cacheControl", "cache_control"],
                budget.clone(),
            )
            .await
            .map_err(failure)?
            .into_iter()
            .flatten()
            .find(|value| value.kind != JsonKind::Null);
        }
        if found.is_some() {
            break;
        }
    }
    let Some(value) = found else { return Ok(None) };
    if value.kind == JsonKind::Bool
        && !json::bool_value(&value.source, budget.clone())
            .await
            .map_err(failure)?
    {
        return Ok(None);
    }
    if value.kind == JsonKind::String && equal(&value, "", budget.clone()).await? {
        return Ok(None);
    }
    if value.kind == JsonKind::Number && number_zero(value.source.clone(), budget.clone()).await? {
        return Ok(None);
    }
    if value.kind != JsonKind::Object {
        return Ok(Some(FrozenCacheCandidate::Invalid));
    }
    let fields = json::fields(&value.source, &["type", "ttl"], budget.clone())
        .await
        .map_err(failure)?;
    let valid = match &fields[0] {
        Some(kind) => equal(kind, "ephemeral", budget.clone()).await?,
        None => false,
    };
    if !valid {
        return Ok(Some(FrozenCacheCandidate::Invalid));
    }
    let ttl = match &fields[1] {
        None => None,
        Some(value) if value.kind == JsonKind::Null => None,
        Some(value) if equal(value, "5m", budget.clone()).await? => Some(CacheTtl::FiveMinutes),
        Some(value) if equal(value, "1h", budget.clone()).await? => Some(CacheTtl::OneHour),
        _ => return Ok(Some(FrozenCacheCandidate::Invalid)),
    };
    Ok(Some(FrozenCacheCandidate::Valid(
        CacheDirective::Ephemeral { ttl },
    )))
}
async fn cache_program(
    options: &[Option<JsonSource>],
    site: CacheSite,
    reject: Option<(Option<JsonSource>, CacheSite)>,
    stream: &StreamOptions,
    budget: Arc<dyn SourceBudget>,
) -> Result<CacheProgram<FrozenCacheCandidate>, ModelError> {
    let mut candidates = Vec::new();
    for options in options {
        if let Some(value) =
            directive(options.clone(), &stream.cache_namespace, budget.clone()).await?
        {
            candidates.push(value)
        }
    }
    let rejected = match reject {
        Some((options, site)) => directive(options, &stream.cache_namespace, budget)
            .await?
            .map(|value| (value, site)),
        None => None,
    };
    Ok(CacheProgram::new(candidates, site, rejected))
}
async fn identify(
    value: TextSource,
    budget: Arc<dyn SourceBudget>,
) -> Result<IdentifiedText, ModelError> {
    let mut hash = Sha256::new();
    let mut cursor = text::cursor(value.clone(), budget.clone());
    let mut buffer = budget.allocate(4096).await.map_err(failure)?;
    loop {
        let read = cursor.read_chunk(buffer).await.map_err(failure)?;
        hash.update(&read.buffer.as_ref()[..read.bytes_read]);
        buffer = read.buffer;
        if read.eof {
            break;
        }
        if read.bytes_read == 0 {
            return Err(invalid("text identity source made no progress"));
        }
    }
    Ok(IdentifiedText {
        text: value,
        identity: hash.finalize().into(),
    })
}

async fn caller(
    options: &Options,
    budget: Arc<dyn SourceBudget>,
) -> Result<Option<Caller<IdentifiedText>>, ModelError> {
    let Some(value) = options.get("caller") else {
        return Ok(None);
    };
    let fields = json::fields(&value.source, &["type", "toolId"], budget.clone())
        .await
        .map_err(failure)?;
    let Some(kind) = &fields[0] else {
        return Ok(None);
    };
    if equal(kind, "direct", budget.clone()).await? {
        return Ok(Some(Caller::Direct));
    }
    let version = if equal(kind, "code_execution_20250825", budget.clone()).await? {
        0
    } else if equal(kind, "code_execution_20260120", budget.clone()).await? {
        1
    } else {
        return Ok(None);
    };
    let Some(id) = &fields[1] else {
        return Ok(None);
    };
    if id.kind != JsonKind::String {
        return Ok(None);
    }
    let id = id.text().map_err(failure)?;
    if inspect_text(id.clone(), budget.clone())
        .await
        .map_err(failure)?
        .encoded_len
        == 0
    {
        return Ok(None);
    }
    let tool_id = identify(id, budget).await?;
    Ok(Some(if version == 0 {
        Caller::Code20250825 { tool_id }
    } else {
        Caller::Code20260120 { tool_id }
    }))
}

struct Plan {
    fragments: Vec<SourceFragment>,
    emitted: bool,
    local_tool: bool,
    boundary: bool,
    system_text: bool,
    cache: CacheProgram<FrozenCacheCandidate>,
    cache_slot_at: Option<usize>,
    caller_slot_at: Option<usize>,
    caller: Option<CallerMetadata<IdentifiedText>>,
    source_id: Option<IdentifiedText>,
    mcp_id: Option<IdentifiedText>,
    document: Option<DocumentMetadata<IdentifiedText>>,
    features: Vec<String>,
    warnings: Vec<String>,
    text_at: Option<usize>,
    reasoning_site: Option<CacheSite>,
    audio_fallback: bool,
    owned_bytes: usize,
}
impl Plan {
    fn empty() -> Self {
        Self {
            fragments: Vec::new(),
            emitted: false,
            local_tool: false,
            boundary: false,
            system_text: false,
            cache: CacheProgram::new(Vec::new(), CacheSite::Text, None),
            cache_slot_at: None,
            caller_slot_at: None,
            caller: None,
            source_id: None,
            mcp_id: None,
            document: None,
            features: Vec::new(),
            warnings: Vec::new(),
            text_at: None,
            reasoning_site: None,
            audio_fallback: false,
            owned_bytes: 0,
        }
    }
    fn new(kind: &'static str) -> Self {
        let mut plan = Self::empty();
        plan.emitted = true;
        plan.fragments.push(literal(b"{\"type\":"));
        plan.fragments.push(generated(kind));
        plan
    }
    fn field(&mut self, name: &'static str, fragments: Vec<SourceFragment>) {
        self.fragments.push(literal(b","));
        self.fragments.push(generated(name));
        self.fragments.push(literal(b":"));
        self.fragments.extend(fragments)
    }
    fn string(&mut self, name: &'static str, value: TextSource) {
        self.field(name, quoted(value))
    }
    fn text(&mut self, name: &'static str, value: TextSource, cache: bool) {
        self.fragments.push(literal(b","));
        self.fragments.push(generated(name));
        self.fragments.push(literal(b":\""));
        self.text_at = Some(self.fragments.len());
        self.fragments.push(SourceFragment::Text(value));
        self.fragments.push(literal(b"\""));
        if cache {
            self.cache_slot_at = Some(self.fragments.len())
        }
    }
    fn raw(&mut self, name: &'static str, value: JsonSource) {
        self.field(name, vec![SourceFragment::Raw(value)])
    }
    async fn finish(
        mut self,
        message: MessageMetadata,
        index: usize,
        budget: Arc<dyn SourceBudget>,
    ) -> Result<SourceItem, ModelError> {
        if self.emitted {
            self.fragments.push(literal(b"}"));
        }
        let mut len = 0;
        let mut cache_slot = None;
        let mut caller_slot = None;
        let mut trim = None;
        for (i, fragment) in self.fragments.iter().enumerate() {
            let slot = FieldSlot {
                offset: len,
                comma_before: true,
                comma_after: false,
            };
            if self.cache_slot_at == Some(i) {
                cache_slot = Some(slot.clone());
            }
            if self.caller_slot_at == Some(i) {
                caller_slot = Some(slot);
            }
            if self.text_at == Some(i)
                && message.role == MessageRole::Assistant
                && let SourceFragment::Text(text) = fragment
            {
                let bounds = inspect_text(text.clone(), budget.clone())
                    .await
                    .map_err(failure)?;
                trim = Some(TextTrim {
                    leading: len + bounds.leading.start..len + bounds.leading.end,
                    trailing: len + bounds.trailing.start..len + bounds.trailing.end,
                });
                len += bounds.encoded_len;
                continue;
            }
            let mut cursor = FragmentCursor::new(fragment.clone());
            while let Some(bytes) = cursor.next(budget.clone()).await.map_err(failure)? {
                len += bytes.len() as u64;
            }
        }
        let metadata = Metadata {
            message,
            part_index: index,
            emitted: self.emitted,
            local_tool: self.local_tool,
            boundary: self.boundary,
            system_text: self.system_text,
            cache: self.cache,
            cache_slot,
            caller_slot,
            caller: self.caller,
            source_id: self.source_id,
            mcp_id: self.mcp_id,
            document: self.document,
            features: self.features,
            warnings: self.warnings,
            trim,
            base_bytes: len,
        };
        Ok(SourceItem {
            fragments: self.fragments.into(),
            metadata: Some(WireItemMetadata::Anthropic(Arc::new(metadata))),
            owned_bytes: self.owned_bytes,
        })
    }
}
impl Compiler {
    async fn content(
        &self,
        part: ContentRecipe,
        result: bool,
        budget: Arc<dyn SourceBudget>,
    ) -> Result<Plan, ModelError> {
        match part {
            ContentRecipe::Text { text, .. } => {
                let mut plan = Plan::new("text");
                plan.text("text", text, !result);
                Ok(plan)
            }
            ContentRecipe::Media {
                media,
                provider_options,
            } => {
                self.media(media, provider_options, result, self.inspection, budget)
                    .await
            }
        }
    }
    async fn media(
        &self,
        mut media: MediaSource,
        options: Option<JsonSource>,
        result: bool,
        inspection: MediaInspection,
        budget: Arc<dyn SourceBudget>,
    ) -> Result<Plan, ModelError> {
        let image = prefix(media.media_type.clone(), b"image/", budget.clone()).await?
            || json::text_eq(&media.media_type, "image", budget.clone())
                .await
                .map_err(failure)?;
        if prefix(media.media_type.clone(), b"audio/", budget.clone()).await? {
            let length = match &media.bytes {
                SourceBytes::Inline(bytes) => bytes.len() as u64,
                SourceBytes::Source(source) => match source.len() {
                    Some(len) => len,
                    None => {
                        let mut len = 0;
                        let mut cursor = FragmentCursor::new(SourceFragment::Raw(JsonSource::new(
                            media.bytes.clone(),
                        )));
                        while let Some(bytes) =
                            cursor.next(budget.clone()).await.map_err(failure)?
                        {
                            len += bytes.len() as u64;
                        }
                        len
                    }
                },
            };
            let encoded = (length / 3)
                .checked_mul(4)
                .and_then(|len| len.checked_add(u64::from(length % 3 != 0) * 4))
                .ok_or_else(|| invalid("audio length overflow"))?;
            let (head, middle, tail) = match self.language {
                Language::En => (
                    "Audio input (",
                    ", ",
                    " base64 characters) is not supported by this model adapter. The audio remains in the tool evidence.",
                ),
                Language::ZhCn => (
                    "此模型适配器不支持音频输入（",
                    "，",
                    " 个 base64 字符）。音频仍保留在工具证据中。",
                ),
                Language::ZhTw => (
                    "此模型介接器不支援音訊輸入（",
                    "，",
                    " 個 base64 字元）。音訊仍保留在工具證據中。",
                ),
            };
            let mut plan = Plan::new("text");
            plan.field(
                "text",
                vec![
                    literal(b"\""),
                    SourceFragment::Text(static_text(head)),
                    SourceFragment::Text(media.media_type),
                    SourceFragment::Text(static_text(middle)),
                    SourceFragment::owned(encoded.to_string().into_bytes()),
                    SourceFragment::Text(static_text(tail)),
                    literal(b"\""),
                ],
            );
            plan.audio_fallback = true;
            if !result {
                plan.cache_slot_at = Some(plan.fragments.len());
            }
            return Ok(plan);
        }
        let resolved =
            resolve_media_type(media.media_type.clone(), &media.bytes, budget.clone()).await?;
        // Directory admission counts retained metadata, not encoded image bytes.
        // Real wire emission constructs a fresh plan from the unchanged source.
        if image && inspection == MediaInspection::Directory {
            media.bytes = SourceBytes::Inline(Bytes::new());
        }
        let plain = json::text_eq(&media.media_type, "text/plain", budget.clone())
            .await
            .map_err(failure)?;
        let declared_pdf = json::text_eq(&media.media_type, "application/pdf", budget.clone())
            .await
            .map_err(failure)?;
        let pdf = json::text_eq(&resolved, "application/pdf", budget.clone())
            .await
            .map_err(failure)?;
        if !image && !plain && !pdf {
            if result {
                let mut plan = Plan::empty();
                plan.warnings
                    .push("unsupported tool content part media type".into());
                return Ok(plan);
            }
            return Err(invalid("unsupported Anthropic media type"));
        }
        let opts = Options::new(options, budget.clone()).await?;
        let (title, context, citations) = if !result {
            opts.require_object()?;
            let title = opts.string("title")?;
            let context = opts.string("context")?;
            let citations = match opts.get("citations") {
                Some(value) if value.kind != JsonKind::Null => {
                    if value.kind != JsonKind::Object {
                        return Err(invalid("Anthropic citations must be an object"));
                    }
                    let enabled = json::field(&value.source, &["enabled"], budget.clone())
                        .await
                        .map_err(failure)?
                        .ok_or_else(|| invalid("Anthropic citations is missing enabled"))?;
                    Some(
                        json::bool_value(&enabled.source, budget.clone())
                            .await
                            .map_err(failure)?,
                    )
                }
                _ => None,
            };
            if let Some(upload) = opts.get("containerUpload")
                && upload.kind != JsonKind::Null
            {
                json::bool_value(&upload.source, budget.clone())
                    .await
                    .map_err(failure)?;
            }
            (title, context, citations)
        } else {
            (None, None, None)
        };
        if result && plain {
            let mut plan = Plan::empty();
            plan.warnings
                .push("unsupported tool content part media type".into());
            return Ok(plan);
        }
        let mut plan = Plan::new(if image { "image" } else { "document" });
        let mut source = vec![literal(if plain {
            b"{\"type\":\"text\",\"media_type\":"
        } else {
            b"{\"type\":\"base64\",\"media_type\":"
        })];
        source.extend(quoted(resolved));
        source.push(literal(b",\"data\":\""));
        source.push(if plain {
            SourceFragment::LossyText(media.bytes)
        } else {
            SourceFragment::Base64(media.bytes)
        });
        source.push(literal(b"\"}"));
        plan.field("source", source);
        if !image && !result {
            if let Some(title) = title {
                plan.string("title", title)
            }
            if let Some(context) = context
                && (inspection == MediaInspection::Allocation
                    || inspect_text(context.clone(), budget.clone())
                        .await
                        .map_err(failure)?
                        .encoded_len
                        > 0)
            {
                plan.string("context", context)
            }
            if citations == Some(true) {
                plan.field("citations", vec![literal(b"{\"enabled\":true}")]);
                if inspection != MediaInspection::Allocation && (declared_pdf || plain) {
                    plan.document = Some(DocumentMetadata {
                        title: identify(static_text("Untitled Document"), budget.clone()).await?,
                        filename: None,
                        media_type: identify(media.media_type, budget.clone()).await?,
                    });
                }
            }
        }
        if !result {
            plan.cache_slot_at = Some(plan.fragments.len());
        }
        if pdf {
            plan.features.push("pdfs-2024-09-25".into())
        }
        Ok(plan)
    }
    async fn assistant_part(
        &self,
        part: AssistantRecipe,
        budget: Arc<dyn SourceBudget>,
    ) -> Result<Plan, ModelError> {
        match part {
            AssistantRecipe::Text {
                text,
                provider_options,
            } => {
                let opts = Options::new(provider_options, budget.clone()).await?;
                if opts.is("type", "compaction").await? {
                    if inspect_text(text.clone(), budget.clone())
                        .await
                        .map_err(failure)?
                        .encoded_len
                        == 0
                    {
                        return Ok(Plan::empty());
                    }
                    let mut plan = Plan::new("compaction");
                    plan.string("content", text);
                    if let Some(signature) = opts.maybe_string("signature") {
                        plan.string("signature", signature);
                        plan.features.push("compact-2026-09-04".into())
                    }
                    plan.cache_slot_at = Some(plan.fragments.len());
                    Ok(plan)
                } else {
                    let mut plan = Plan::new("text");
                    plan.text("text", text, true);
                    if let Some(citations) = opts.get("citations")
                        && citations.kind != JsonKind::Null
                    {
                        plan.raw("citations", citations.source)
                    }
                    Ok(plan)
                }
            }
            AssistantRecipe::Reasoning {
                text,
                provider_options,
            } => {
                let mut plan = Plan::empty();
                if !self.options.send_reasoning {
                    plan.warnings
                        .push("sending reasoning content is disabled for this model".into());
                    return Ok(plan);
                }
                let opts = Options::new(provider_options, budget.clone()).await?;
                opts.require_object()?;
                let signature = opts.string("signature")?;
                let redacted = opts.string("redactedData")?;
                if let Some(signature) = signature {
                    plan = Plan::new("thinking");
                    plan.string("thinking", text);
                    plan.string("signature", signature);
                    plan.boundary = true;
                    plan.reasoning_site = Some(CacheSite::Reasoning)
                } else if let Some(data) = redacted {
                    plan = Plan::new("redacted_thinking");
                    plan.string("data", data);
                    plan.boundary = true;
                    plan.reasoning_site = Some(CacheSite::RedactedReasoning)
                } else {
                    plan.warnings.push("unsupported reasoning metadata".into())
                }
                Ok(plan)
            }
            AssistantRecipe::ToolCall {
                tool_call_id,
                tool_name,
                input,
                kind: _,
                provider_executed,
                provider_options,
            } => {
                self.call(
                    tool_call_id,
                    tool_name,
                    input,
                    provider_executed.unwrap_or(false),
                    provider_options,
                    budget,
                )
                .await
            }
            AssistantRecipe::ToolResult(result) => self.result(result, true, budget).await,
        }
    }
    async fn call(
        &self,
        id: TextSource,
        name: TextSource,
        input: ToolInputRecipe,
        executed: bool,
        options: Option<JsonSource>,
        budget: Arc<dyn SourceBudget>,
    ) -> Result<Plan, ModelError> {
        let opts = Options::new(options, budget.clone()).await?;
        let id = identify(id, budget.clone()).await?;
        let mcp = executed && opts.is("type", "mcp-tool-use").await?;
        let (provider_name, mut name_bytes) = if executed && !mcp {
            self.provider_name(name.clone(), budget.clone()).await?
        } else {
            (name.clone(), 0)
        };
        let code = executed
            && !mcp
            && json::text_eq(&provider_name, "code_execution", budget.clone())
                .await
                .map_err(failure)?;
        let advisor = executed
            && !mcp
            && json::text_eq(&provider_name, "advisor", budget.clone())
                .await
                .map_err(failure)?;
        let mut plan = Plan::new(if mcp {
            "mcp_tool_use"
        } else if executed {
            "server_tool_use"
        } else {
            "tool_use"
        });
        let server = if mcp {
            match opts.maybe_string("serverName") {
                Some(server) => Some(server),
                None => {
                    plan = Plan::empty();
                    plan.mcp_id = Some(id);
                    plan.warnings
                        .push("mcp tool use server name is required and must be a string".into());
                    return Ok(plan);
                }
            }
        } else {
            None
        };
        if executed && !mcp && !code && !advisor {
            let mut accepted = false;
            for known in [
                "web_fetch",
                "web_search",
                "tool_search_tool_regex",
                "tool_search_tool_bm25",
            ] {
                accepted |= json::text_eq(&provider_name, known, budget.clone())
                    .await
                    .map_err(failure)?;
            }
            if !accepted {
                let mut plan = Plan::empty();
                plan.warnings
                    .push("unsupported provider executed Anthropic tool".into());
                return Ok(plan);
            }
        }
        plan.string("id", id.text.clone());
        let input = match input {
            ToolInputRecipe::Json(value) => value,
            ToolInputRecipe::Text(_) => {
                JsonSource::new(SourceBytes::Inline(Bytes::from_static(b"{}")))
            }
        };
        let mut input_fragments = vec![SourceFragment::Raw(input.clone())];
        let mut output_name = if executed && !mcp {
            provider_name
        } else {
            name.clone()
        };
        if code {
            if let Some(kind) = json::field(&input, &["type"], budget.clone())
                .await
                .map_err(failure)?
            {
                for subtype in [
                    "bash_code_execution",
                    "text_editor_code_execution",
                    "programmatic-tool-call",
                ] {
                    if equal(&kind, subtype, budget.clone()).await? {
                        output_name = if subtype == "programmatic-tool-call" {
                            static_text("code_execution")
                        } else if subtype == "bash_code_execution" {
                            static_text("bash_code_execution")
                        } else {
                            static_text("text_editor_code_execution")
                        };
                        name_bytes = 0;
                        input_fragments = vec![normalize_object_without(input.clone(), "type")];
                        break;
                    }
                }
            }
        } else if advisor {
            input_fragments = vec![literal(b"{}")];
        }
        let toolset = if !executed {
            let mut selected = None;
            for (from, to) in &self.options.toolsets {
                if json::text_eq(&name, from, budget.clone())
                    .await
                    .map_err(failure)?
                {
                    let bytes = to.as_bytes().to_vec();
                    plan.owned_bytes += bytes.capacity();
                    selected = Some(TextSource::new(
                        SourceBytes::Inline(Bytes::from(bytes)),
                        TextEncoding::Utf8,
                    ));
                    break;
                }
            }
            selected.or(opts.maybe_string("toolsetName"))
        } else {
            None
        };
        if !executed {
            if json::kind(&input, budget.clone()).await.map_err(failure)? != JsonKind::Object {
                input_fragments = vec![
                    literal(b"{\"rawInvalidInput\":"),
                    SourceFragment::Raw(input.clone()),
                    literal(b"}"),
                ]
            }
            if let Some(toolset) = &toolset {
                output_name = match json::field(&input, &["action"], budget.clone())
                    .await
                    .map_err(failure)?
                {
                    Some(action) if action.kind == JsonKind::String => {
                        action.text().map_err(failure)?
                    }
                    _ => toolset.clone(),
                };
            }
        }
        let source_id = executed
            && !mcp
            && json::text_eq(&output_name, "code_execution", budget.clone())
                .await
                .map_err(failure)?;
        plan.owned_bytes += name_bytes;
        plan.string("name", output_name);
        plan.field("input", input_fragments);
        if let Some(server) = server {
            plan.string("server_name", server);
            plan.mcp_id = Some(id.clone());
        }
        if let Some(toolset) = toolset {
            plan.string("toolset_name", toolset)
        }
        if !mcp {
            plan.caller_slot_at = Some(plan.fragments.len());
            if let Some(caller) = caller(&opts, budget.clone()).await? {
                plan.caller = Some(CallerMetadata {
                    id: id.clone(),
                    caller,
                })
            }
        }
        plan.cache_slot_at = Some(plan.fragments.len());
        plan.local_tool = !executed;
        if source_id {
            plan.source_id = Some(id);
        }
        Ok(plan)
    }
}
impl Compiler {
    fn output(&self, output: ToolOutputRecipe) -> Vec<SourceFragment> {
        match output {
            ToolOutputRecipe::Text(value) | ToolOutputRecipe::ErrorText(value) => quoted(value),
            ToolOutputRecipe::Json(value) | ToolOutputRecipe::ErrorJson(value) => vec![
                literal(b"\""),
                SourceFragment::JsonString(value),
                literal(b"\""),
            ],
            ToolOutputRecipe::Content(source) => {
                let bytes = std::alloc::Layout::new::<(usize, usize)>()
                    .extend(std::alloc::Layout::new::<ContentSource>())
                    .expect("content source Arc layout fits")
                    .0
                    .pad_to_align()
                    .size();
                vec![SourceFragment::owned_raw(
                    JsonSource::new(SourceBytes::Source(Arc::new(ContentSource {
                        source,
                        options: self.options.clone(),
                        language: self.language,
                        inspection: self.inspection,
                    }))),
                    bytes,
                )]
            }
        }
    }
    async fn notification(
        &self,
        result: ToolResultRecipe,
        _budget: Arc<dyn SourceBudget>,
    ) -> Result<Plan, ModelError> {
        let ToolOutputRecipe::Text(body) = result.output else {
            return Ok(Plan::empty());
        };
        let (head, tail) = match self.language {
            Language::En => ("[Notification from exec ", "]\n"),
            Language::ZhCn => ("[来自 exec ", " 的通知]\n"),
            Language::ZhTw => ("[來自 exec ", " 的通知]\n"),
        };
        let mut plan = Plan::new("text");
        plan.field(
            "text",
            vec![
                literal(b"\""),
                SourceFragment::Text(static_text(head)),
                SourceFragment::Text(result.tool_call_id),
                SourceFragment::Text(static_text(tail)),
                SourceFragment::Text(body),
                literal(b"\""),
            ],
        );
        Ok(plan)
    }
    async fn result(
        &self,
        result: ToolResultRecipe,
        assistant: bool,
        budget: Arc<dyn SourceBudget>,
    ) -> Result<Plan, ModelError> {
        validate_output_options(&result.output, !assistant, budget.clone()).await?;
        let id = identify(result.tool_call_id.clone(), budget.clone()).await?;
        let is_error = matches!(
            &result.output,
            ToolOutputRecipe::ErrorText(_) | ToolOutputRecipe::ErrorJson(_)
        );
        let opts = Options::new(result.provider_options, budget.clone()).await?;
        if !assistant {
            let mut plan = Plan::new("tool_result");
            plan.string("tool_use_id", result.tool_call_id);
            plan.features = self.inspect_output(&result.output, budget.clone()).await?;
            plan.field("content", self.output(result.output));
            let mut toolset = None;
            for (from, to) in &self.options.toolsets {
                if json::text_eq(&result.tool_name, from, budget.clone())
                    .await
                    .map_err(failure)?
                {
                    let bytes = to.as_bytes().to_vec();
                    plan.owned_bytes += bytes.capacity();
                    toolset = Some(TextSource::new(
                        SourceBytes::Inline(Bytes::from(bytes)),
                        TextEncoding::Utf8,
                    ));
                    break;
                }
            }
            if let Some(toolset) = toolset.or(opts.maybe_string("toolsetName")) {
                plan.string("toolset_name", toolset)
            }
            if is_error {
                plan.field("is_error", vec![literal(b"true")])
            }
            plan.cache_slot_at = Some(plan.fragments.len());
            return Ok(plan);
        }
        if result.replay == ToolResultReplay::AnthropicMcp {
            let value = match result.output {
                ToolOutputRecipe::Json(value) | ToolOutputRecipe::ErrorJson(value) => value,
                _ => {
                    let mut plan = Plan::empty();
                    plan.warnings
                        .push("unsupported MCP tool result output type".into());
                    return Ok(plan);
                }
            };
            let mut plan = Plan::new("mcp_tool_result");
            plan.string("tool_use_id", result.tool_call_id);
            plan.raw("content", value);
            plan.field(
                "is_error",
                vec![literal(if is_error { b"true" } else { b"false" })],
            );
            plan.cache_slot_at = Some(plan.fragments.len());
            return Ok(plan);
        }
        let (name, _) = self.provider_name(result.tool_name, budget.clone()).await?;
        let mut tool = None;
        for known in [
            "code_execution",
            "web_fetch",
            "web_search",
            "tool_search_tool_regex",
            "tool_search_tool_bm25",
            "advisor",
        ] {
            if json::text_eq(&name, known, budget.clone())
                .await
                .map_err(failure)?
            {
                tool = Some(known);
                break;
            }
        }
        let Some(tool) = tool else {
            let mut plan = Plan::empty();
            plan.warnings
                .push("unsupported provider executed tool result".into());
            return Ok(plan);
        };
        let Some((kind, content)) =
            hosted_result(tool, result.output, result.parsed_error, budget.clone()).await?
        else {
            return Ok(Plan::empty());
        };
        let mut plan = Plan::new(kind);
        plan.string("tool_use_id", result.tool_call_id);
        plan.field("content", content);
        if matches!(tool, "web_fetch" | "web_search") {
            plan.caller_slot_at = Some(plan.fragments.len());
            if let Some(caller) = caller(&opts, budget.clone()).await? {
                plan.caller = Some(CallerMetadata { id, caller })
            }
        }
        plan.cache_slot_at = Some(plan.fragments.len());
        Ok(plan)
    }
}
async fn prefix(
    value: TextSource,
    prefix: &[u8],
    budget: Arc<dyn SourceBudget>,
) -> Result<bool, ModelError> {
    let mut cursor = FragmentCursor::new(SourceFragment::Text(value));
    let mut matched = 0;
    while let Some(bytes) = cursor.next(budget.clone()).await.map_err(failure)? {
        for byte in bytes {
            if Some(&byte) != prefix.get(matched) {
                return Ok(false);
            }
            matched += 1;
            if matched == prefix.len() {
                return Ok(true);
            }
        }
    }
    Ok(false)
}
async fn number_zero(value: JsonSource, budget: Arc<dyn SourceBudget>) -> Result<bool, ModelError> {
    // Value's comparison with integer zero accepts only its integer variant.
    let mut cursor = FragmentCursor::new(SourceFragment::Raw(value));
    let mut length = 0;
    while let Some(bytes) = cursor.next(budget.clone()).await.map_err(failure)? {
        for byte in bytes {
            if byte != b'0' || length != 0 {
                return Ok(false);
            }
            length += 1;
        }
    }
    Ok(length == 1)
}

async fn output_cache_options(
    output: &ToolOutputRecipe,
    budget: Arc<dyn SourceBudget>,
) -> Result<Option<JsonSource>, ModelError> {
    let ToolOutputRecipe::Content(content) = output else {
        return Ok(None);
    };
    let mut cursor = content.open(0);
    let mut processed = 0usize;
    while let Some(part) = cursor.next().await.map_err(failure)? {
        processed += 1;
        if processed.is_multiple_of(DIRECTORY_WORK_QUANTUM) {
            tokio::task::yield_now().await;
        }
        if let ContentRecipe::Media { media, .. } = &part
            && prefix(media.media_type.clone(), b"audio/", budget.clone()).await?
        {
            continue;
        }
        if let Some(options) = content_options(&part)
            && json::kind(&options, budget.clone())
                .await
                .map_err(failure)?
                != JsonKind::Null
        {
            return Ok(Some(options));
        }
    }
    Ok(None)
}
impl Compiler {
    async fn inspect_output(
        &self,
        output: &ToolOutputRecipe,
        budget: Arc<dyn SourceBudget>,
    ) -> Result<Vec<String>, ModelError> {
        let ToolOutputRecipe::Content(content) = output else {
            return Ok(Vec::new());
        };
        let mut cursor = content.open(0);
        let mut features = Vec::new();
        let mut processed = 0usize;
        while let Some(part) = cursor.next().await.map_err(failure)? {
            processed += 1;
            if processed.is_multiple_of(DIRECTORY_WORK_QUANTUM) {
                tokio::task::yield_now().await;
            }
            let plan = self.content(part, true, budget.clone()).await?;
            for feature in plan.features {
                if !features.contains(&feature) {
                    features.push(feature)
                }
            }
        }
        Ok(features)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MediaInspection {
    Wire,
    Directory,
    Allocation,
}
pub(in crate::adapters::wire) struct UserPartBound {
    pub retained: usize,
    pub documents: usize,
}
impl Compiler {
    /// Allocation-only fit parts; their synthesized User has no message-level options.
    /// Media bodies are never opened, encoded, or hashed.
    pub(in crate::adapters::wire) async fn count_user_part_bound(
        &self,
        part: ContentRecipe,
        budget: Arc<dyn SourceBudget>,
    ) -> Result<UserPartBound, ModelError> {
        let (mut plan, options, documents) = match part {
            ContentRecipe::Text {
                text,
                provider_options,
            } => {
                let mut plan = Plan::new("text");
                plan.text("text", text, true);
                (plan, provider_options, 0)
            }
            ContentRecipe::Media {
                mut media,
                provider_options,
            } => {
                let audio = prefix(media.media_type.clone(), b"audio/", budget.clone()).await?;
                media.bytes = SourceBytes::Inline(Bytes::new());
                if !audio {
                    media.media_type = static_text("application/pdf");
                }
                let mut plan = self
                    .media(
                        media,
                        provider_options.clone(),
                        false,
                        MediaInspection::Allocation,
                        budget.clone(),
                    )
                    .await?;
                if audio {
                    for fragment in &mut plan.fragments {
                        if let SourceFragment::OwnedLiteral { bytes, .. } = fragment
                            && !bytes.is_empty()
                            && bytes.iter().all(u8::is_ascii_digit)
                        {
                            *fragment = SourceFragment::owned(u64::MAX.to_string().into_bytes());
                        }
                    }
                }
                (
                    plan,
                    if audio { None } else { provider_options },
                    usize::from(!audio),
                )
            }
        };
        plan.cache =
            cache_program(&[options], CacheSite::Text, None, &self.options, budget).await?;
        if plan.emitted {
            plan.fragments.push(literal(b"}"));
        }
        Ok(UserPartBound {
            retained: plan.allocation_bytes()?,
            documents,
        })
    }
}
impl Plan {
    fn allocation_bytes(&self) -> Result<usize, ModelError> {
        fn arc(size: usize, align: usize) -> Result<usize, ModelError> {
            let payload = std::alloc::Layout::from_size_align(size, align)
                .map_err(|error| ModelError::Adapter(error.to_string()))?;
            Ok(std::alloc::Layout::new::<[usize; 2]>()
                .extend(payload)
                .map_err(|error| ModelError::Adapter(error.to_string()))?
                .0
                .pad_to_align()
                .size())
        }
        let fragments = self
            .fragments
            .len()
            .checked_mul(std::mem::size_of::<SourceFragment>())
            .ok_or_else(|| invalid("summary wire allocation overflow"))?;
        let mut bytes = arc(fragments, std::mem::align_of::<SourceFragment>())?;
        for amount in [
            arc(
                std::mem::size_of::<Metadata>(),
                std::mem::align_of::<Metadata>(),
            )?,
            self.owned_bytes,
            self.cache.candidate_capacity_bytes(),
            self.features.capacity() * std::mem::size_of::<String>(),
            self.warnings.capacity() * std::mem::size_of::<String>(),
        ] {
            bytes = bytes
                .checked_add(amount)
                .ok_or_else(|| invalid("summary wire allocation overflow"))?;
        }
        for string in self.features.iter().chain(&self.warnings) {
            bytes = bytes
                .checked_add(string.capacity())
                .ok_or_else(|| invalid("summary wire allocation overflow"))?;
        }
        for fragment in &self.fragments {
            let amount = match fragment {
                SourceFragment::OwnedLiteral { capacity, .. } => *capacity,
                SourceFragment::OwnedRaw { metadata_bytes, .. } => *metadata_bytes,
                _ => 0,
            };
            bytes = bytes
                .checked_add(amount)
                .ok_or_else(|| invalid("summary wire allocation overflow"))?;
        }
        Ok(bytes)
    }
}

struct ContentSource {
    source: Arc<dyn RecipeSource<ContentRecipe>>,
    options: Arc<StreamOptions>,
    language: Language,
    inspection: MediaInspection,
}
impl ByteSource for ContentSource {
    fn len(&self) -> Option<u64> {
        None
    }
    fn open(&self, budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
        Box::new(ContentCursor {
            source: self.source.open(0),
            compiler: Compiler {
                options: self.options.clone(),
                language: self.language,
                inspection: self.inspection,
            },
            budget,
            fragments: VecDeque::from([literal(b"[")]),
            active: None,
            pending: None,
            first: true,
            finished: false,
        })
    }
}
struct ContentCursor {
    source: Box<dyn RecipeCursor<ContentRecipe>>,
    compiler: Compiler,
    budget: Arc<dyn SourceBudget>,
    fragments: VecDeque<SourceFragment>,
    active: Option<FragmentCursor>,
    pending: Option<Bytes>,
    first: bool,
    finished: bool,
}
impl ContentCursor {
    async fn next_bytes(&mut self) -> io::Result<Option<Bytes>> {
        loop {
            if let Some(active) = &mut self.active {
                if let Some(bytes) = active.next(self.budget.clone()).await? {
                    if !bytes.is_empty() {
                        return Ok(Some(bytes));
                    }
                    continue;
                }
                self.active = None;
            }
            if let Some(fragment) = self.fragments.pop_front() {
                self.active = Some(FragmentCursor::new(fragment));
                continue;
            }
            if self.finished {
                return Ok(None);
            }
            match self.source.next().await? {
                Some(part) => {
                    let mut plan = self
                        .compiler
                        .content(part, true, self.budget.clone())
                        .await
                        .map_err(|error| io::Error::other(error.to_string()))?;
                    if !plan.emitted {
                        continue;
                    }
                    if !self.first {
                        self.fragments.push_back(literal(b","))
                    }
                    self.first = false;
                    self.fragments.extend(plan.fragments.drain(..));
                    self.fragments.push_back(literal(b"}"));
                }
                None => {
                    self.fragments.push_back(literal(b"]"));
                    self.finished = true;
                }
            }
        }
    }
}
impl ByteCursor for ContentCursor {
    fn read_chunk(&mut self, mut buffer: ChargedBuffer) -> ReadSource<'_> {
        Box::pin(async move {
            let mut written = 0;
            while written < buffer.as_mut().len() {
                let bytes = match self.pending.take() {
                    Some(bytes) => Some(bytes),
                    None => self.next_bytes().await?,
                };
                let Some(mut bytes) = bytes else {
                    return Ok(SourceRead {
                        buffer,
                        bytes_read: written,
                        eof: true,
                    });
                };
                let count = bytes.len().min(buffer.as_mut().len() - written);
                buffer.as_mut()[written..written + count].copy_from_slice(&bytes.split_to(count));
                written += count;
                if !bytes.is_empty() {
                    self.pending = Some(bytes)
                }
            }
            let eof = if self.pending.is_none() {
                self.pending = self.next_bytes().await?;
                self.pending.is_none()
            } else {
                false
            };
            Ok(SourceRead {
                buffer,
                bytes_read: written,
                eof,
            })
        })
    }
}

async fn resolve_media_type(
    declared: TextSource,
    bytes: &SourceBytes,
    budget: Arc<dyn SourceBudget>,
) -> Result<TextSource, ModelError> {
    let mut generic_image = false;
    for name in ["image", "image/*"] {
        generic_image |= json::text_eq(&declared, name, budget.clone())
            .await
            .map_err(failure)?;
    }
    let mut generic_application = false;
    for name in ["application", "application/*"] {
        generic_application |= json::text_eq(&declared, name, budget.clone())
            .await
            .map_err(failure)?;
    }
    if !generic_image && !generic_application {
        return Ok(declared);
    }
    let mut header = [0; 12];
    let mut used = 0;
    let mut cursor = bytes.open(budget.clone());
    let mut buffer = budget.allocate(header.len()).await.map_err(failure)?;
    buffer.limit(header.len());
    loop {
        let read = cursor.read_chunk(buffer).await.map_err(failure)?;
        let count = read.bytes_read.min(header.len() - used);
        header[used..used + count].copy_from_slice(&read.buffer.as_ref()[..count]);
        used += count;
        buffer = read.buffer;
        if used == header.len() || read.eof {
            break;
        }
        if count == 0 {
            return Err(invalid("media header source made no progress"));
        }
        buffer.limit(header.len() - used);
    }
    let header = &header[..used];
    let detected = if generic_image {
        if header.starts_with(b"\x89PNG") {
            Some("image/png")
        } else if header.starts_with(&[0xff, 0xd8, 0xff]) {
            Some("image/jpeg")
        } else if header.starts_with(b"GIF8") {
            Some("image/gif")
        } else if header.starts_with(b"RIFF") && header.get(8..12) == Some(b"WEBP") {
            Some("image/webp")
        } else {
            None
        }
    } else if header.starts_with(b"%PDF-") {
        Some("application/pdf")
    } else {
        None
    };
    detected
        .map(static_text)
        .ok_or_else(|| invalid("Anthropic media subtype could not be detected"))
}

async fn validate_options(
    options: &Option<JsonSource>,
    budget: Arc<dyn SourceBudget>,
) -> Result<(), ModelError> {
    if let Some(options) = options
        && !matches!(
            json::kind(options, budget).await.map_err(failure)?,
            JsonKind::Object | JsonKind::Null
        )
    {
        return Err(invalid("provider options must be an object"));
    }
    Ok(())
}
async fn validate_output_options(
    output: &ToolOutputRecipe,
    audio_fallback: bool,
    budget: Arc<dyn SourceBudget>,
) -> Result<(), ModelError> {
    let ToolOutputRecipe::Content(content) = output else {
        return Ok(());
    };
    let mut cursor = content.open(0);
    let mut processed = 0usize;
    while let Some(part) = cursor.next().await.map_err(failure)? {
        if audio_fallback
            && let ContentRecipe::Media { media, .. } = &part
            && prefix(media.media_type.clone(), b"audio/", budget.clone()).await?
        {
            continue;
        }
        validate_options(&content_options(&part), budget.clone()).await?;
        processed += 1;
        if processed.is_multiple_of(DIRECTORY_WORK_QUANTUM) {
            tokio::task::yield_now().await;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
