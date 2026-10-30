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

//! Project semantic payloads without owning their text or arbitrary JSON bodies.

use maka_agent_facts::history::semantic::directory::{
    ChildDirectory, InputDirectory, ListKind, PartDirectory, PayloadDirectory, RowDirectory,
    TextSpan, ToolDirectory, ToolPartDirectory,
};
use maka_agent_facts::model::TextKind;
use maka_agent_facts::model::prompt_source::source::ChargedBuffer;
use maka_agent_facts::{
    language::Language,
    model::prompt_source::source::{
        AssistantRecipe, ContentRecipe, JsonSource, ParsedToolError, RecipeSource, SourceBudget,
        SourceBytes, TextEncoding, TextSource, ToolCallKind, ToolInputRecipe, ToolOutputRecipe,
        ToolResultKind, ToolResultRecipe, ToolResultReplay,
        json::{self, JsonKind, JsonValue},
        text as source_text,
    },
};
use maka_event_log::context::semantic::{CapturedSource, ChildPage, PayloadSource};
use maka_model::ProviderKind;
use std::{io, sync::Arc};
pub(super) mod arena;
mod located;
mod media;
#[cfg(test)]
mod navigation_tests;
mod summary;

pub(super) struct ProjectContext<'a> {
    pub language: Language,
    pub vision: bool,
    pub provider: &'a ProviderKind,
    pub replay: Option<&'a maka_event_log::context::semantic::SemanticReplay>,
    pub captured: Option<&'a maka_event_log::context::semantic::CapturedSource>,
    pub row_root: Option<&'a PayloadSource>,
    pub payload_root: Option<&'a maka_event_log::context::semantic::PayloadSource>,
    pub arena: Option<&'a super::capture_arena::CaptureArena>,
    pub internal_arena: bool,
    pub cancellation: &'a tokio_util::sync::CancellationToken,
    pub budget: Arc<dyn SourceBudget>,
    pub directory_owner: Arc<dyn Send + Sync>,
}

impl ProjectContext<'_> {
    pub fn for_payload<'row>(
        &'row self,
        payload_root: Option<&'row maka_event_log::context::semantic::PayloadSource>,
    ) -> ProjectContext<'row> {
        ProjectContext {
            language: self.language,
            vision: self.vision,
            provider: self.provider,
            replay: self.replay,
            captured: self.captured,
            row_root: self.row_root,
            payload_root,
            arena: self.arena,
            internal_arena: self.internal_arena,
            cancellation: self.cancellation,
            budget: self.budget.clone(),
            directory_owner: self.directory_owner.clone(),
        }
    }
    pub fn for_row<'row>(
        &'row self,
        row_root: &'row PayloadSource,
        payload_root: Option<&'row PayloadSource>,
    ) -> ProjectContext<'row> {
        let mut context = self.for_payload(payload_root);
        context.row_root = Some(row_root);
        context
    }
    pub fn for_arena(&self) -> ProjectContext<'_> {
        let mut context = self.for_payload(self.payload_root);
        context.internal_arena = true;
        context
    }
}

pub(super) enum ProjectedRow {
    User(Arc<dyn RecipeSource<ContentRecipe>>),
    Assistant(AssistantRecipe),
    AssistantMetadata { options: JsonSource },
    Tool(ToolResultRecipe),
    Skip,
}

fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "semantic group payload does not match its row",
    )
}
fn literal(value: &'static str) -> TextSource {
    maka_agent_facts::model::prompt_source::source::generated::text(value)
}
fn required(value: Option<JsonValue>) -> io::Result<JsonValue> {
    value.ok_or_else(invalid)
}
async fn lookup(
    source: &JsonSource,
    name: &str,
    context: &ProjectContext<'_>,
) -> io::Result<JsonValue> {
    required(json::field(source, &[name], context.budget.clone()).await?)
}
fn list<T: Clone + Send + Sync + 'static>(
    values: Vec<T>,
    context: &ProjectContext<'_>,
) -> Arc<dyn RecipeSource<T>> {
    Arc::new(super::frozen::Items::new(
        values,
        context.directory_owner.clone(),
    ))
}

/// The caller groups adjacent assistant items by the checked row order.
pub(super) async fn project_row(
    row: &RowDirectory,
    payload: Option<&PayloadDirectory>,
    context: &ProjectContext<'_>,
) -> io::Result<ProjectedRow> {
    if let RowDirectory::UnknownTool { .. } = row {
        return Ok(ProjectedRow::Tool(
            result(
                row,
                ToolOutputRecipe::ErrorText(literal(unknown(context.language))),
                ToolResultKind::Settled,
                context,
            )
            .await?,
        ));
    }
    let payload = payload.ok_or_else(invalid)?;
    match (row, payload) {
        (RowDirectory::User { steering, .. }, PayloadDirectory::User { .. }) => {
            user(payload, *steering, context).await
        }
        (RowDirectory::ImportedUser { .. }, PayloadDirectory::Text(text)) => {
            Ok(ProjectedRow::User(list(
                vec![ContentRecipe::Text {
                    text: located::text(*text, context)?,
                    provider_options: None,
                }],
                context,
            )))
        }
        (
            RowDirectory::ImportedAssistant { .. } | RowDirectory::ExecutorText { .. },
            PayloadDirectory::Text(text),
        ) => Ok(ProjectedRow::Assistant(AssistantRecipe::Text {
            text: located::text(*text, context)?,
            provider_options: None,
        })),
        (RowDirectory::Notification { .. }, PayloadDirectory::Text(text)) => {
            Ok(ProjectedRow::Tool(
                result(
                    row,
                    ToolOutputRecipe::Text(located::text(*text, context)?),
                    ToolResultKind::Notification,
                    context,
                )
                .await?,
            ))
        }
        (RowDirectory::AssistantPart { .. }, PayloadDirectory::Part(part)) => {
            if matches!(
                part,
                PartDirectory::Text {
                    text_kind: TextKind::Thinking,
                    ..
                }
            ) && !reasoning_matches_route(row, context).await?
            {
                return Ok(ProjectedRow::Skip);
            }
            assistant(part, context).await
        }
        (
            RowDirectory::ToolResult {
                archived, is_error, ..
            },
            payload,
        ) => {
            let output = match payload {
                PayloadDirectory::Text(text) => {
                    ToolOutputRecipe::ErrorText(located::text(*text, context)?)
                }
                PayloadDirectory::Tool(tool) => {
                    tool_output(tool, *archived, *is_error, context).await?
                }
                _ => return Err(invalid()),
            };
            Ok(ProjectedRow::Tool(
                result(row, output, ToolResultKind::Settled, context).await?,
            ))
        }
        _ => Err(invalid()),
    }
}
fn row_text(span: TextSpan, context: &ProjectContext<'_>) -> io::Result<TextSource> {
    context
        .captured
        .ok_or_else(invalid)?
        .text(context.row_root.ok_or_else(invalid)?, span)
        .map_err(io::Error::other)
}
async fn result(
    row: &RowDirectory,
    output: ToolOutputRecipe,
    kind: ToolResultKind,
    context: &ProjectContext<'_>,
) -> io::Result<ToolResultRecipe> {
    let (call_id, name, custom) = match row {
        RowDirectory::ToolResult {
            call_id,
            name,
            custom,
            ..
        }
        | RowDirectory::UnknownTool {
            call_id,
            name,
            custom,
        } => (*call_id, Some(*name), *custom),
        RowDirectory::Notification {
            call_id, custom, ..
        } => (*call_id, None, *custom),
        _ => return Err(invalid()),
    };
    let mut result = ToolResultRecipe {
        tool_call_id: row_text(call_id, context)?,
        tool_name: name
            .map(|span| row_text(span, context))
            .transpose()?
            .unwrap_or_else(|| literal("exec")),
        kind,
        call_kind: if custom {
            ToolCallKind::Custom
        } else {
            ToolCallKind::Function
        },
        output,
        parsed_error: None,
        replay: ToolResultReplay::Ordinary,
        provider_options: None,
    };
    freeze_error(&mut result, context).await?;
    Ok(result)
}
async fn assistant(part: &PartDirectory, context: &ProjectContext<'_>) -> io::Result<ProjectedRow> {
    match part {
        PartDirectory::Source => Ok(ProjectedRow::Skip),
        PartDirectory::Text {
            text_kind,
            text,
            provider_options,
        } => {
            project_text(
                located::text(*text, context)?,
                provider_options
                    .map(|v| located::json(v, context))
                    .transpose()?,
                matches!(text_kind, TextKind::Thinking),
                context,
            )
            .await
        }
        PartDirectory::ToolCall {
            id,
            name,
            input,
            provider_executed,
            provider_options,
        } => {
            let provider_options = provider_options
                .map(|v| located::json(v, context))
                .transpose()?;
            let input = match input {
                InputDirectory::Json(value) => {
                    ToolInputRecipe::Json(located::json(*value, context)?)
                }
                InputDirectory::Text(value) => {
                    ToolInputRecipe::Text(located::text(*value, context)?)
                }
            };
            let mut kind = call_kind(provider_options.as_ref(), context).await?;
            if kind == ToolCallKind::Function
                && let Some(options) = &provider_options
                && let Some(value) = json::field(
                    options,
                    &["openResponses", "toolKind"],
                    context.budget.clone(),
                )
                .await?
                && value.kind == JsonKind::String
                && json::text_eq(&value.text()?, "custom", context.budget.clone()).await?
            {
                kind = ToolCallKind::Custom;
            }
            Ok(ProjectedRow::Assistant(AssistantRecipe::ToolCall {
                tool_call_id: located::text(*id, context)?,
                tool_name: located::text(*name, context)?,
                input,
                kind,
                provider_executed: Some(*provider_executed),
                provider_options,
            }))
        }
        PartDirectory::ToolResult {
            id,
            name,
            output,
            is_error,
            provider_options,
        } => {
            let provider_options = provider_options
                .map(|v| located::json(v, context))
                .transpose()?;
            let output = located::json(*output, context)?;
            let mut result = ToolResultRecipe {
                tool_call_id: located::text(*id, context)?,
                tool_name: located::text(*name, context)?,
                kind: ToolResultKind::Settled,
                call_kind: call_kind(provider_options.as_ref(), context).await?,
                output: if *is_error {
                    ToolOutputRecipe::ErrorJson(output)
                } else {
                    ToolOutputRecipe::Json(output)
                },
                parsed_error: None,
                replay: ToolResultReplay::Ordinary,
                provider_options,
            };
            freeze_error(&mut result, context).await?;
            Ok(ProjectedRow::Assistant(AssistantRecipe::ToolResult(result)))
        }
    }
}
async fn reasoning_matches_route(
    row: &RowDirectory,
    context: &ProjectContext<'_>,
) -> io::Result<bool> {
    if let Some(replay) = context.replay {
        let RowDirectory::AssistantPart {
            model_id,
            route_identity,
            ..
        } = row
        else {
            return Err(invalid());
        };
        if !json::text_eq(
            &row_text(*model_id, context)?,
            &replay.model,
            context.budget.clone(),
        )
        .await?
            || !json::text_eq(
                &row_text(*route_identity, context)?,
                &replay.route,
                context.budget.clone(),
            )
            .await?
        {
            return Ok(false);
        }
    }
    Ok(true)
}

async fn call_kind(
    options: Option<&JsonSource>,
    context: &ProjectContext<'_>,
) -> io::Result<ToolCallKind> {
    if let Some(options) = options
        && json::kind(options, context.budget.clone()).await? == JsonKind::Object
        && let Some(kind) =
            json::field(options, &["openai", "toolKind"], context.budget.clone()).await?
        && kind.kind == JsonKind::String
        && json::text_eq(&kind.text()?, "custom", context.budget.clone()).await?
    {
        return Ok(ToolCallKind::Custom);
    }
    Ok(ToolCallKind::Function)
}

async fn project_text(
    text: TextSource,
    mut provider_options: Option<JsonSource>,
    thinking: bool,
    context: &ProjectContext<'_>,
) -> io::Result<ProjectedRow> {
    if thinking
        && matches!(context.provider, ProviderKind::OpenaiCompatible { .. })
        && let Some(options) = provider_options.as_ref()
        && let Some(field) = json::field(
            options,
            &["maka", "openAiChatReasoningField"],
            context.budget.clone(),
        )
        .await?
        && field.kind == JsonKind::String
        && (json::text_eq(&field.text()?, "reasoning", context.budget.clone()).await?
            || json::text_eq(&field.text()?, "reasoning_content", context.budget.clone()).await?)
    {
        if text.encoding() != TextEncoding::JsonString {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "compatible reasoning requires captured quoted text source",
            ));
        }
        let prefix = if json::text_eq(&field.text()?, "reasoning", context.budget.clone()).await? {
            "{\"openaiCompatible\":{\"reasoning\":"
        } else {
            "{\"openaiCompatible\":{\"reasoning_content\":"
        };
        let bytes = super::joined_source::join(
            vec![
                literal(prefix).into_bytes(),
                text.into_bytes(),
                literal("}}").into_bytes(),
            ],
            context.directory_owner.clone(),
        )?;
        return Ok(ProjectedRow::AssistantMetadata {
            options: JsonSource::new(bytes),
        });
    }
    if thinking && let ProviderKind::OpenResponses(contract) = context.provider {
        match contract.reasoning_replay {
            maka_agent_facts::model::PlaintextReasoningReplay::PlaintextContent => {
                if json::text_eq(&text, "", context.budget.clone()).await? {
                    return Ok(ProjectedRow::Skip);
                }
                provider_options = None;
            }
            maka_agent_facts::model::PlaintextReasoningReplay::PlaintextSummary => {
                let Some(options) = provider_options.as_ref() else {
                    return Ok(ProjectedRow::Skip);
                };
                let Some(projected) =
                    summary::project(&text, options, *contract, true, context).await?
                else {
                    return Ok(ProjectedRow::Skip);
                };
                provider_options = projected.options;
            }
        }
    }
    Ok(ProjectedRow::Assistant(if thinking {
        AssistantRecipe::Reasoning {
            text,
            provider_options,
        }
    } else {
        AssistantRecipe::Text {
            text,
            provider_options,
        }
    }))
}

fn concat(parts: Vec<TextSource>, context: &ProjectContext<'_>) -> TextSource {
    source_text::concat(list(parts, context), context.budget.clone())
}
fn raw_json(value: JsonSource) -> TextSource {
    TextSource::new(value.into_bytes(), TextEncoding::Utf8)
}
struct Children {
    captured: CapturedSource,
    root: PayloadSource,
    kind: ListKind,
    page: Option<ChildPage<ChargedBuffer>>,
    buffer: Option<ChargedBuffer>,
    after: Option<u64>,
    remaining: u64,
    finished: bool,
    cancellation: tokio_util::sync::CancellationToken,
}
impl Children {
    async fn open(kind: ListKind, count: u64, context: &ProjectContext<'_>) -> io::Result<Self> {
        Ok(Self {
            captured: context.captured.ok_or_else(invalid)?.clone(),
            root: context.payload_root.ok_or_else(invalid)?.clone(),
            kind,
            page: None,
            buffer: Some(context.budget.allocate(32 * 1024).await?),
            after: None,
            remaining: count,
            finished: false,
            cancellation: context.cancellation.clone(),
        })
    }
    async fn next(&mut self) -> io::Result<Option<ChildDirectory>> {
        loop {
            if self.cancellation.is_cancelled() {
                return Err(crate::preparation_cancelled("capture cancelled"));
            }
            if let Some(page) = &mut self.page {
                if let Some(child) = page.next_child().map_err(io::Error::other)? {
                    self.remaining = self.remaining.checked_sub(1).ok_or_else(invalid)?;
                    return Ok(Some(child));
                }
                let page = self.page.take().expect("page is present");
                self.after = page.next;
                self.finished = self.after.is_none();
                self.buffer = Some(page.into_buffer());
            }
            if self.finished {
                if self.remaining != 0 {
                    return Err(invalid());
                }
                return Ok(None);
            }
            self.page = Some(
                self.captured
                    .child_page(
                        &self.root,
                        self.kind,
                        self.after,
                        self.buffer
                            .take()
                            .expect("page buffer is returned before refill"),
                    )
                    .await
                    .map_err(io::Error::other)?,
            );
        }
    }
}
fn steering_prefix(language: Language) -> &'static str {
    match language {
        Language::En => "The user sent a message while you were working:\n<user_query>\n",
        Language::ZhCn => "用户在你工作期间发来消息：\n<user_query>\n",
        Language::ZhTw => "使用者在你工作期間傳來訊息：\n<user_query>\n",
    }
}
fn quote_pieces(
    quote: ChildDirectory,
    first: bool,
    context: &ProjectContext<'_>,
) -> io::Result<Vec<TextSource>> {
    let ChildDirectory::Quote {
        label,
        source,
        text,
    } = quote
    else {
        return Err(invalid());
    };
    let mut pieces = Vec::with_capacity(11);
    pieces.push(literal(if first { "\n\n" } else { "\n" }));
    pieces.push(literal("<quoted_excerpt"));
    if let Some(label) = label {
        pieces.push(literal(" label=\""));
        pieces.push(source_text::quote_label(
            located::text(label, context)?,
            context.budget.clone(),
        ));
        pieces.push(literal("\""));
    }
    pieces.push(literal(">\n"));
    if let Some(source) = source {
        pieces.push(literal(match context.language {
            Language::En => "Session snapshot provenance (display-only): ",
            Language::ZhCn => "会话快照来源（仅供展示）：",
            Language::ZhTw => "工作階段快照來源（僅供顯示）：",
        }));
        pieces.push(source_text::html(
            raw_json(located::json(source, context)?),
            context.budget.clone(),
        ));
        pieces.push(literal("\n"));
    }
    pieces.push(located::text(text, context)?);
    pieces.push(literal("\n</quoted_excerpt>"));
    Ok(pieces)
}
async fn reference_pieces(
    references: Option<maka_agent_facts::history::semantic::directory::JsonSpan>,
    context: &ProjectContext<'_>,
) -> io::Result<Vec<TextSource>> {
    let Some(references) = references else {
        return Ok(Vec::new());
    };
    let references = located::json(references, context)?;
    let mut cursor = json::ArrayCursor::open(references.clone(), context.budget.clone()).await?;
    if cursor.next().await?.is_none() {
        return Ok(Vec::new());
    }
    Ok(vec![
        literal("\n\n<directory_references>\n"),
        literal(match context.language {
            Language::En => {
                "Live directory paths on the originating Runtime Host, accessible with Glob/Read. The project and working directory are unchanged.\n"
            }
            Language::ZhCn => {
                "原始运行时主机上的实时目录路径，可通过 Glob/Read 访问。项目与工作目录不变。\n"
            }
            Language::ZhTw => {
                "原始執行階段主機上的即時目錄路徑，可透過 Glob/Read 存取。專案與工作目錄不變。\n"
            }
        }),
        source_text::html(raw_json(references), context.budget.clone()),
        literal("\n</directory_references>"),
    ])
}
async fn user(
    input: &PayloadDirectory,
    steering: bool,
    context: &ProjectContext<'_>,
) -> io::Result<ProjectedRow> {
    let PayloadDirectory::User {
        text,
        quotes,
        attachments,
        directory_references,
    } = input
    else {
        return Err(invalid());
    };
    let (_, piece_count, content_count) = user_layout(input, steering, context).await?;
    let mut content = Vec::with_capacity(content_count);
    content.push(ContentRecipe::Text {
        text: literal(""),
        provider_options: None,
    });
    let mut pieces = Vec::with_capacity(piece_count);
    if steering {
        pieces.push(literal(steering_prefix(context.language)));
    }
    pieces.push(located::text(*text, context)?);
    let mut cursor = Children::open(ListKind::Quotes, *quotes, context).await?;
    let mut first = true;
    while let Some(quote) = cursor.next().await? {
        pieces.extend(quote_pieces(quote, first, context)?);
        first = false;
    }
    drop(cursor);
    let mut cursor = Children::open(ListKind::Attachments, *attachments, context).await?;
    let mut first = true;
    while let Some(child) = cursor.next().await? {
        let ChildDirectory::Attachment(attachment) = child else {
            return Err(invalid());
        };
        pieces.push(literal(if first { "\n\n" } else { "\n" }));
        first = false;
        let projected = media::attachment(&attachment, media::Mode::Capture, context).await?;
        pieces.extend(projected.pieces);
        if let Some(part) = projected.content {
            content.push(part);
        }
    }
    pieces.extend(reference_pieces(*directory_references, context).await?);
    if steering {
        pieces.push(literal("\n</user_query>"));
    }
    content[0] = ContentRecipe::Text {
        text: concat(pieces, context),
        provider_options: None,
    };
    Ok(ProjectedRow::User(list(content, context)))
}
async fn tool_output(
    projection: &ToolDirectory,
    archived: bool,
    error: bool,
    context: &ProjectContext<'_>,
) -> io::Result<ToolOutputRecipe> {
    Ok(match projection {
        ToolDirectory::Text(text) => ToolOutputRecipe::Text(located::text(*text, context)?),
        ToolDirectory::Json(value) => {
            let mut value = located::json(*value, context)?;
            if archived {
                value = archive(value, context).await?;
            }
            if error && archived {
                ToolOutputRecipe::ErrorJson(value)
            } else {
                ToolOutputRecipe::Json(value)
            }
        }
        ToolDirectory::Failure => ToolOutputRecipe::ErrorText(literal(match context.language {
            Language::En => maka_agent_facts::tool_output::DURABLE_TOOL_PROJECTION_FAILURE_MESSAGE,
            Language::ZhCn => "工具已完成，但无法安全投影其供模型读取的结果。",
            Language::ZhTw => "工具已完成，但無法安全投影其供模型讀取的結果。",
        })),
        ToolDirectory::Content { parts } => {
            let mut content =
                Vec::with_capacity(usize::try_from(*parts).map_err(io::Error::other)?);
            let mut cursor = Children::open(ListKind::ToolParts, *parts, context).await?;
            while let Some(child) = cursor.next().await? {
                let ChildDirectory::ToolPart(part) = child else {
                    return Err(invalid());
                };
                content.push(match part {
                    ToolPartDirectory::Text(text) => ContentRecipe::Text {
                        text: located::text(text, context)?,
                        provider_options: None,
                    },
                    part => media::tool(&part, media::Mode::Capture, context)
                        .await?
                        .content
                        .ok_or_else(invalid)?,
                });
            }
            ToolOutputRecipe::Content(list(content, context))
        }
    })
}

fn archive_instruction(language: Language) -> &'static str {
    match language {
        Language::En => {
            r#""Use page.next only with a selected Session tool-result reader; without one, the remainder is unavailable.""#
        }
        Language::ZhCn => {
            r#""仅使用已选定的会话工具结果读取工具读取 page.next；没有读取工具时，其余内容不可用。""#
        }
        Language::ZhTw => {
            r#""僅使用已選定的工作階段工具結果讀取工具讀取 page.next；沒有讀取工具時，其餘內容無法取得。""#
        }
    }
}
enum ArchivePlacement {
    Replace(std::ops::Range<u64>),
    Append { nonempty: bool },
}
async fn archive_placement(
    value: &JsonSource,
    context: &ProjectContext<'_>,
) -> io::Result<ArchivePlacement> {
    let mut cursor = json::ObjectCursor::open(value.clone(), context.budget.clone()).await?;
    let mut nonempty = false;
    let mut replacement = None;
    while let Some((field, selected)) = cursor
        .next_named_spans(["readInstructions"].into_iter())
        .await?
    {
        nonempty = true;
        if selected.is_some() && replacement.is_none() {
            replacement = Some(field.value_range);
        }
    }
    Ok(match replacement {
        Some(range) => ArchivePlacement::Replace(range),
        None => ArchivePlacement::Append { nonempty },
    })
}
async fn archive_shape(
    value: &JsonSource,
    context: &ProjectContext<'_>,
) -> io::Result<(usize, usize)> {
    let (parts, spans) = match archive_placement(value, context).await? {
        ArchivePlacement::Replace(_) => (3, 2),
        ArchivePlacement::Append { .. } => (5, 1),
    };
    let mut bytes = raw_footprint(value.bytes())?
        .checked_mul(spans)
        .ok_or_else(invalid)?;
    footprint_add(&mut bytes, super::joined_source::metadata_bytes(parts)?)?;
    Ok((parts, bytes))
}
async fn archive(value: JsonSource, context: &ProjectContext<'_>) -> io::Result<JsonSource> {
    let length = match value.bytes() {
        SourceBytes::Inline(bytes) => bytes.len() as u64,
        SourceBytes::Source(source) => source.len().ok_or_else(invalid)?,
    };
    let pieces = match archive_placement(&value, context).await? {
        ArchivePlacement::Replace(range) => vec![
            value.bytes().slice(0..range.start)?,
            literal(archive_instruction(context.language)).into_bytes(),
            value.bytes().slice(range.end..length)?,
        ],
        ArchivePlacement::Append { nonempty } => vec![
            value
                .bytes()
                .slice(0..length.checked_sub(1).ok_or_else(invalid)?)?,
            literal(if nonempty { "," } else { "" }).into_bytes(),
            literal(r#""readInstructions":"#).into_bytes(),
            literal(archive_instruction(context.language)).into_bytes(),
            literal("}").into_bytes(),
        ],
    };
    Ok(JsonSource::new(super::joined_source::join(
        pieces,
        context.directory_owner.clone(),
    )?))
}

fn unknown(language: Language) -> &'static str {
    match language {
        Language::En => {
            "outcome_unknown: The tool was dispatched, but no durable result was recorded. Its effect may have happened. Inspect current state before repeating it."
        }
        Language::ZhCn => {
            "outcome_unknown: 工具已派发，但未记录持久结果；操作可能已生效。重复操作前先检查当前状态。"
        }
        Language::ZhTw => {
            "outcome_unknown: 工具已派發，但未記錄持久結果；操作可能已生效。重複操作前先檢查目前狀態。"
        }
    }
}

pub(super) async fn chat_shape_row(
    row: &RowDirectory,
    payload: Option<&PayloadDirectory>,
    context: &ProjectContext<'_>,
) -> io::Result<super::chat_source::ChatShape> {
    let mut shape = super::chat_source::ChatShape::default();
    if !context.vision
        || !matches!(
            context.provider,
            ProviderKind::OpenaiChatCompletions | ProviderKind::OpenaiCompatible { .. }
        )
        || !matches!(row, RowDirectory::ToolResult { .. })
    {
        return Ok(shape);
    }
    let Some(PayloadDirectory::Tool(ToolDirectory::Content { parts })) = payload else {
        return Ok(shape);
    };
    shape.content_parts = usize::try_from(*parts).map_err(io::Error::other)?;
    let mut cursor = Children::open(ListKind::ToolParts, *parts, context).await?;
    while let Some(child) = cursor.next().await? {
        match child {
            ChildDirectory::ToolPart(ToolPartDirectory::Text(_)) => {}
            ChildDirectory::ToolPart(_) => {
                shape.media_parts = shape.media_parts.checked_add(1).ok_or_else(invalid)?
            }
            _ => return Err(invalid()),
        }
    }
    shape.media_results = usize::from(shape.media_parts != 0);
    Ok(shape)
}

fn footprint_add(total: &mut usize, bytes: usize) -> io::Result<()> {
    *total = total.checked_add(bytes).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "projection metadata footprint overflow",
        )
    })?;
    Ok(())
}
fn arc_bytes(size: usize, alignment: usize) -> io::Result<usize> {
    let value = std::alloc::Layout::from_size_align(size, alignment).map_err(io::Error::other)?;
    let (layout, _) = std::alloc::Layout::new::<[usize; 2]>()
        .extend(value)
        .map_err(io::Error::other)?;
    Ok(layout.pad_to_align().size())
}

fn raw_footprint(source: &SourceBytes) -> io::Result<usize> {
    match source {
        SourceBytes::Inline(_) => Ok(0),
        SourceBytes::Source(source) => arc_bytes(
            std::mem::size_of_val(source.as_ref()),
            std::mem::align_of_val(source.as_ref()),
        ),
    }
}
fn items_footprint<T>(count: usize) -> io::Result<usize> {
    let body = arc_bytes(
        std::mem::size_of::<super::frozen::Items<T>>(),
        std::mem::align_of::<super::frozen::Items<T>>(),
    )?;
    let array = std::mem::size_of::<T>()
        .checked_mul(count)
        .ok_or_else(invalid)?;
    body.checked_add(arc_bytes(array, std::mem::align_of::<T>())?)
        .ok_or_else(invalid)
}
/// Count retained allocations before reserving the frozen directory.
pub(super) async fn footprint_row(
    row: &RowDirectory,
    payload: Option<&PayloadDirectory>,
    context: &ProjectContext<'_>,
) -> io::Result<usize> {
    let mut bytes = 0;
    if matches!(
        row,
        RowDirectory::ToolResult { .. }
            | RowDirectory::Notification { .. }
            | RowDirectory::UnknownTool { .. }
    ) {
        // Tool builders own one box until conversion into the frozen recipe list.
        footprint_add(&mut bytes, std::mem::size_of::<ToolResultRecipe>())?;
    }
    match row {
        RowDirectory::ToolResult { call_id, name, .. }
        | RowDirectory::UnknownTool { call_id, name, .. } => {
            footprint_add(
                &mut bytes,
                raw_footprint(row_text(*call_id, context)?.bytes())?,
            )?;
            footprint_add(
                &mut bytes,
                raw_footprint(row_text(*name, context)?.bytes())?,
            )?;
        }
        RowDirectory::Notification { call_id, .. } => footprint_add(
            &mut bytes,
            raw_footprint(row_text(*call_id, context)?.bytes())?,
        )?,
        _ => {}
    }
    if matches!(row, RowDirectory::UnknownTool { .. }) {
        return Ok(bytes);
    }
    footprint_add(
        &mut bytes,
        error_metadata_bytes(row, payload, context).await?,
    )?;
    match payload.ok_or_else(invalid)? {
        payload @ PayloadDirectory::User { .. } => {
            let RowDirectory::User { steering, .. } = row else {
                return Err(invalid());
            };
            footprint_add(
                &mut bytes,
                user_layout(payload, *steering, context).await?.0,
            )?;
        }
        PayloadDirectory::Text(text) => {
            footprint_add(
                &mut bytes,
                raw_footprint(located::text(*text, context)?.bytes())?,
            )?;
            if matches!(row, RowDirectory::ImportedUser { .. }) {
                footprint_add(&mut bytes, items_footprint::<ContentRecipe>(1)?)?;
            }
        }
        PayloadDirectory::Part(part) => match part {
            PartDirectory::Source => {}
            PartDirectory::Text {
                text,
                text_kind,
                provider_options,
            } => {
                let text = located::text(*text, context)?;
                let options = provider_options
                    .map(|value| located::json(value, context))
                    .transpose()?;
                footprint_add(
                    &mut bytes,
                    text_footprint(
                        &text,
                        options.as_ref(),
                        matches!(text_kind, TextKind::Thinking),
                        context,
                    )
                    .await?,
                )?;
            }
            PartDirectory::ToolCall {
                id,
                name,
                input,
                provider_options,
                ..
            } => {
                for span in [id, name] {
                    footprint_add(
                        &mut bytes,
                        raw_footprint(located::text(*span, context)?.bytes())?,
                    )?;
                }
                let input = match input {
                    InputDirectory::Json(value) => located::json(*value, context)?.into_bytes(),
                    InputDirectory::Text(value) => located::text(*value, context)?.into_bytes(),
                };
                footprint_add(&mut bytes, raw_footprint(&input)?)?;
                if let Some(options) = provider_options {
                    footprint_add(
                        &mut bytes,
                        raw_footprint(located::json(*options, context)?.bytes())?,
                    )?;
                }
            }
            PartDirectory::ToolResult {
                id,
                name,
                output,
                provider_options,
                ..
            } => {
                for span in [id, name] {
                    footprint_add(
                        &mut bytes,
                        raw_footprint(located::text(*span, context)?.bytes())?,
                    )?;
                }
                footprint_add(
                    &mut bytes,
                    raw_footprint(located::json(*output, context)?.bytes())?,
                )?;
                if let Some(options) = provider_options {
                    footprint_add(
                        &mut bytes,
                        raw_footprint(located::json(*options, context)?.bytes())?,
                    )?;
                }
            }
        },
        PayloadDirectory::Tool(tool) => match tool {
            ToolDirectory::Text(text) => footprint_add(
                &mut bytes,
                raw_footprint(located::text(*text, context)?.bytes())?,
            )?,
            ToolDirectory::Json(value) => {
                let value = located::json(*value, context)?;
                let size = if matches!(row, RowDirectory::ToolResult { archived: true, .. }) {
                    archive_shape(&value, context).await?.1
                } else {
                    raw_footprint(value.bytes())?
                };
                footprint_add(&mut bytes, size)?;
            }
            ToolDirectory::Failure => {}
            ToolDirectory::Content { parts } => {
                let mut cursor = Children::open(ListKind::ToolParts, *parts, context).await?;
                while let Some(child) = cursor.next().await? {
                    let ChildDirectory::ToolPart(part) = child else {
                        return Err(invalid());
                    };
                    let size = match part {
                        ToolPartDirectory::Text(text) => {
                            raw_footprint(located::text(text, context)?.bytes())?
                        }
                        part => {
                            media::tool(&part, media::Mode::Probe, context)
                                .await?
                                .metadata_bytes
                        }
                    };
                    footprint_add(&mut bytes, size)?;
                }
                footprint_add(
                    &mut bytes,
                    items_footprint::<ContentRecipe>(
                        usize::try_from(*parts).map_err(io::Error::other)?,
                    )?,
                )?;
            }
        },
    }
    Ok(bytes)
}

async fn text_footprint(
    text: &TextSource,
    options: Option<&JsonSource>,
    thinking: bool,
    context: &ProjectContext<'_>,
) -> io::Result<usize> {
    let mut bytes = raw_footprint(text.bytes())?;
    if thinking
        && matches!(context.provider, ProviderKind::OpenaiCompatible { .. })
        && let Some(options) = options
        && let Some(field) = json::field(
            options,
            &["maka", "openAiChatReasoningField"],
            context.budget.clone(),
        )
        .await?
        && field.kind == JsonKind::String
        && (json::text_eq(&field.text()?, "reasoning", context.budget.clone()).await?
            || json::text_eq(&field.text()?, "reasoning_content", context.budget.clone()).await?)
    {
        footprint_add(&mut bytes, super::joined_source::metadata_bytes(3)?)?;
        return Ok(bytes);
    }
    if thinking
        && let ProviderKind::OpenResponses(contract) = context.provider
        && contract.reasoning_replay
            == maka_agent_facts::model::PlaintextReasoningReplay::PlaintextContent
    {
        return if json::text_eq(text, "", context.budget.clone()).await? {
            Ok(0)
        } else {
            Ok(bytes)
        };
    }
    if thinking
        && let ProviderKind::OpenResponses(contract) = context.provider
        && contract.reasoning_replay
            == maka_agent_facts::model::PlaintextReasoningReplay::PlaintextSummary
    {
        let Some(options) = options else { return Ok(0) };
        let Some(projected) = summary::project(text, options, *contract, false, context).await?
        else {
            return Ok(0);
        };
        footprint_add(&mut bytes, projected.metadata_bytes)?;
        return Ok(bytes);
    }
    if let Some(options) = options {
        footprint_add(&mut bytes, raw_footprint(options.bytes())?)?;
    }
    Ok(bytes)
}

async fn error_text(
    output: &ToolOutputRecipe,
    context: &ProjectContext<'_>,
) -> io::Result<Option<TextSource>> {
    if !matches!(context.provider, ProviderKind::Anthropic) {
        return Ok(None);
    }
    match output {
        ToolOutputRecipe::ErrorText(text) => Ok(Some(text.clone())),
        ToolOutputRecipe::ErrorJson(value)
            if json::kind(value, context.budget.clone()).await? == JsonKind::String =>
        {
            Ok(Some(TextSource::new(
                value.bytes().clone(),
                TextEncoding::JsonString,
            )))
        }
        _ => Ok(None),
    }
}

async fn decoded_bytes(text: TextSource, context: &ProjectContext<'_>) -> io::Result<usize> {
    let mut cursor = source_text::cursor(text, context.budget.clone());
    let mut buffer = context.budget.allocate(4096).await?;
    let mut length = 0usize;
    loop {
        let read = cursor.read_chunk(buffer).await?;
        length = length.checked_add(read.bytes_read).ok_or_else(invalid)?;
        buffer = read.buffer;
        if read.eof {
            return Ok(length);
        }
        if read.bytes_read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "error text source made no progress",
            ));
        }
    }
}

enum SecondError {
    Same,
    Null,
    Decoded(TextSource),
}
struct ErrorPlan {
    value: Option<TextSource>,
    second: SecondError,
    bytes: usize,
}
async fn validated_error(
    text: TextSource,
    context: &ProjectContext<'_>,
) -> io::Result<Option<(TextSource, JsonKind, usize)>> {
    let bytes = source_text::bytes(text, context.budget.clone());
    match json::validate_value_bytes(&bytes, context.budget.clone()).await {
        Ok(kind) => {
            let text = TextSource::new(bytes, TextEncoding::Utf8);
            let length = decoded_bytes(text.clone(), context).await?;
            Ok(Some((text, kind, length)))
        }
        Err(error) if json::is_syntax_error(&error) => Ok(None),
        Err(error) => Err(error),
    }
}
async fn error_plan(text: TextSource, context: &ProjectContext<'_>) -> io::Result<ErrorPlan> {
    let Some((value, kind, length)) = validated_error(text, context).await? else {
        return Ok(ErrorPlan {
            value: None,
            second: SecondError::Null,
            bytes: 0,
        });
    };
    if kind != JsonKind::String {
        return Ok(ErrorPlan {
            value: Some(value),
            second: SecondError::Same,
            bytes: length,
        });
    }
    let nested = TextSource::new(value.bytes().clone(), TextEncoding::JsonString);
    let Some((second, _, second_length)) = validated_error(nested, context).await? else {
        return Ok(ErrorPlan {
            value: Some(value),
            second: SecondError::Null,
            bytes: length,
        });
    };
    let bytes = length.checked_add(second_length).ok_or_else(invalid)?;
    Ok(ErrorPlan {
        value: Some(value),
        second: SecondError::Decoded(second),
        bytes,
    })
}

fn null_json() -> JsonSource {
    JsonSource::new(literal("null").into_bytes())
}
async fn freeze_error(
    result: &mut ToolResultRecipe,
    context: &ProjectContext<'_>,
) -> io::Result<()> {
    let Some(text) = error_text(&result.output, context).await? else {
        return Ok(());
    };
    let plan = error_plan(text, context).await?;
    let Some(value) = plan.value else {
        result.parsed_error = Some(ParsedToolError {
            value: null_json(),
            code_value: null_json(),
        });
        return Ok(());
    };
    let arena = context.arena.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "Anthropic embedded error requires request backing",
        )
    })?;
    let value = arena
        .append_text(value, context.budget.clone(), context.cancellation)
        .await?;
    let value = if context.internal_arena {
        value.inspection
    } else {
        value.source
    };
    let code_value = match plan.second {
        SecondError::Same => value.clone(),
        SecondError::Null => null_json(),
        SecondError::Decoded(text) => {
            let value = arena
                .append_text(text, context.budget.clone(), context.cancellation)
                .await?;
            if context.internal_arena {
                value.inspection
            } else {
                value.source
            }
        }
    };
    result.parsed_error = Some(ParsedToolError { value, code_value });
    Ok(())
}

async fn row_error_text(
    row: &RowDirectory,
    payload: Option<&PayloadDirectory>,
    context: &ProjectContext<'_>,
) -> io::Result<Option<TextSource>> {
    if !matches!(context.provider, ProviderKind::Anthropic) {
        return Ok(None);
    }
    match (row, payload) {
        (
            RowDirectory::AssistantPart { .. },
            Some(PayloadDirectory::Part(PartDirectory::ToolResult {
                output,
                is_error: true,
                ..
            })),
        ) => {
            error_text(
                &ToolOutputRecipe::ErrorJson(located::json(*output, context)?),
                context,
            )
            .await
        }
        (RowDirectory::ToolResult { .. }, Some(PayloadDirectory::Text(text))) => {
            Ok(Some(located::text(*text, context)?))
        }
        _ => Ok(None),
    }
}
/// Derived backing is separate from retained recipe metadata.
pub(super) async fn backing_bytes_row(
    row: &RowDirectory,
    payload: Option<&PayloadDirectory>,
    context: &ProjectContext<'_>,
) -> io::Result<usize> {
    let mut bytes = 0;
    let (kind, count) = match payload {
        Some(PayloadDirectory::User { attachments, .. })
            if matches!(row, RowDirectory::User { .. }) =>
        {
            (ListKind::Attachments, *attachments)
        }
        Some(PayloadDirectory::Tool(ToolDirectory::Content { parts }))
            if matches!(row, RowDirectory::ToolResult { .. }) =>
        {
            (ListKind::ToolParts, *parts)
        }
        _ => (ListKind::ToolParts, 0),
    };
    if count != 0 {
        let mut cursor = Children::open(kind, count, context).await?;
        while let Some(child) = cursor.next().await? {
            let size = match child {
                ChildDirectory::Attachment(value) => {
                    media::attachment(&value, media::Mode::Probe, context)
                        .await?
                        .backing_bytes
                }
                ChildDirectory::ToolPart(ToolPartDirectory::Text(_)) => 0,
                ChildDirectory::ToolPart(part) => {
                    media::tool(&part, media::Mode::Probe, context)
                        .await?
                        .backing_bytes
                }
                _ => return Err(invalid()),
            };
            footprint_add(&mut bytes, size)?;
        }
    }
    if let Some(text) = row_error_text(row, payload, context).await? {
        footprint_add(&mut bytes, error_plan(text, context).await?.bytes)?;
    }
    Ok(bytes)
}
async fn error_metadata_bytes(
    row: &RowDirectory,
    payload: Option<&PayloadDirectory>,
    context: &ProjectContext<'_>,
) -> io::Result<usize> {
    let Some(text) = row_error_text(row, payload, context).await? else {
        return Ok(0);
    };
    let plan = error_plan(text, context).await?;
    let count = usize::from(plan.value.is_some())
        + usize::from(matches!(plan.second, SecondError::Decoded(_)));
    super::capture_arena::source_metadata_bytes(count)
}
async fn user_layout(
    input: &PayloadDirectory,
    steering: bool,
    context: &ProjectContext<'_>,
) -> io::Result<(usize, usize, usize)> {
    let PayloadDirectory::User {
        text,
        quotes,
        attachments,
        directory_references,
    } = input
    else {
        return Err(invalid());
    };
    let mut bytes = raw_footprint(located::text(*text, context)?.bytes())?;
    let mut content_count = 1usize;
    let mut pieces = 1usize + usize::from(steering) * 2;
    let mut cursor = Children::open(ListKind::Quotes, *quotes, context).await?;
    while let Some(child) = cursor.next().await? {
        let ChildDirectory::Quote {
            label,
            source,
            text,
        } = child
        else {
            return Err(invalid());
        };
        pieces = pieces.checked_add(5).ok_or_else(invalid)?;
        if let Some(label) = label {
            pieces = pieces.checked_add(3).ok_or_else(invalid)?;
            footprint_add(
                &mut bytes,
                raw_footprint(located::text(label, context)?.bytes())?,
            )?;
            footprint_add(
                &mut bytes,
                source_text::transform_metadata_bytes(TextEncoding::JsonString)?,
            )?;
        }
        if let Some(source) = source {
            pieces = pieces.checked_add(3).ok_or_else(invalid)?;
            footprint_add(
                &mut bytes,
                raw_footprint(located::json(source, context)?.bytes())?,
            )?;
            footprint_add(
                &mut bytes,
                source_text::transform_metadata_bytes(TextEncoding::Utf8)?,
            )?;
        }
        footprint_add(
            &mut bytes,
            raw_footprint(located::text(text, context)?.bytes())?,
        )?;
    }
    drop(cursor);
    let mut cursor = Children::open(ListKind::Attachments, *attachments, context).await?;
    while let Some(child) = cursor.next().await? {
        let ChildDirectory::Attachment(value) = child else {
            return Err(invalid());
        };
        let attachment = media::attachment(&value, media::Mode::Probe, context).await?;
        pieces = pieces
            .checked_add(1)
            .and_then(|v| v.checked_add(attachment.pieces.len()))
            .ok_or_else(invalid)?;
        footprint_add(&mut bytes, attachment.metadata_bytes)?;
        content_count = content_count
            .checked_add(usize::from(attachment.has_content))
            .ok_or_else(invalid)?;
    }
    let references = reference_pieces(*directory_references, context).await?;
    if !references.is_empty() {
        pieces = pieces.checked_add(references.len()).ok_or_else(invalid)?;
        if let Some(span) = directory_references {
            footprint_add(
                &mut bytes,
                raw_footprint(located::json(*span, context)?.bytes())?,
            )?;
        }
        footprint_add(
            &mut bytes,
            source_text::transform_metadata_bytes(TextEncoding::Utf8)?,
        )?;
    }
    footprint_add(&mut bytes, items_footprint::<TextSource>(pieces)?)?;
    footprint_add(&mut bytes, source_text::concat_metadata_bytes()?)?;
    footprint_add(&mut bytes, items_footprint::<ContentRecipe>(content_count)?)?;
    Ok((bytes, pieces, content_count))
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::model::prompt_source::source::{Allocate, ChargedBuffer};
    struct Budget;
    impl SourceBudget for Budget {
        fn allocate(&self, minimum: usize) -> Allocate<'_> {
            Box::pin(async move { Ok(ChargedBuffer::new(vec![0; minimum.max(256)], ())) })
        }
    }
    fn json_literal(value: &'static str) -> JsonSource {
        JsonSource::new(SourceBytes::Inline(value.as_bytes().into()))
    }
    #[tokio::test]
    async fn archived_instruction_replaces_in_place_and_remains_indexed() {
        let context = ProjectContext {
            language: Language::En,
            vision: false,
            provider: &ProviderKind::Anthropic,
            replay: None,
            captured: None,
            row_root: None,
            payload_root: None,
            arena: None,
            internal_arena: false,
            cancellation: &tokio_util::sync::CancellationToken::new(),
            budget: Arc::new(Budget),
            directory_owner: Arc::new(()),
        };
        let duplicate = r#"{"read\u0049nstructions":"first","readInstructions":"second"}"#;
        let ArchivePlacement::Replace(range) =
            archive_placement(&json_literal(duplicate), &context)
                .await
                .unwrap()
        else {
            panic!("existing instruction must be replaced")
        };
        assert_eq!(
            &duplicate[range.start as usize..range.end as usize],
            r#""first""#
        );
        assert!(
            archive_placement(
                &json_literal(r#"{"readInstructions":"first","later":[true,]}"#),
                &context,
            )
            .await
            .is_err()
        );
        let value = archive(
            json_literal(r#"{"before":1,"readInstructions":"old","after":{"x":2}}"#),
            &context,
        )
        .await
        .unwrap();
        let mut cursor = json::ObjectCursor::open(value.clone(), context.budget.clone())
            .await
            .unwrap();
        for expected in ["before", "readInstructions", "after"] {
            let field = cursor.next().await.unwrap().unwrap();
            assert!(
                json::text_eq(&field.key, expected, context.budget.clone())
                    .await
                    .unwrap()
            );
        }
        assert!(cursor.next().await.unwrap().is_none());
        let after = json::field(&value, &["after", "x"], context.budget.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            json::u64_value(&after.source, context.budget.clone())
                .await
                .unwrap(),
            2
        );
        let instruction = json::field(&value, &["readInstructions"], context.budget.clone())
            .await
            .unwrap()
            .unwrap();
        assert!(json::text_eq(&instruction.text().unwrap(),"Use page.next only with a selected Session tool-result reader; without one, the remainder is unavailable.",context.budget.clone()).await.unwrap());
    }
    #[tokio::test]
    async fn archived_instruction_appends_to_empty_and_nonempty_objects() {
        let context = ProjectContext {
            language: Language::En,
            vision: false,
            provider: &ProviderKind::Anthropic,
            replay: None,
            captured: None,
            row_root: None,
            payload_root: None,
            arena: None,
            internal_arena: false,
            cancellation: &tokio_util::sync::CancellationToken::new(),
            budget: Arc::new(Budget),
            directory_owner: Arc::new(()),
        };
        for raw in ["{}", r#"{"before":{"large":"preserved"}}"#] {
            let value = archive(json_literal(raw), &context).await.unwrap();
            let expected: serde_json::Value = serde_json::from_str(raw).unwrap();
            let mut fields = json::ObjectCursor::open(value.clone(), context.budget.clone())
                .await
                .unwrap();
            if expected.get("before").is_some() {
                let first = fields.next().await.unwrap().unwrap();
                assert!(
                    json::text_eq(&first.key, "before", context.budget.clone())
                        .await
                        .unwrap()
                );
                let preserved = json::field(&value, &["before", "large"], context.budget.clone())
                    .await
                    .unwrap()
                    .unwrap()
                    .text()
                    .unwrap();
                assert!(
                    json::text_eq(&preserved, "preserved", context.budget.clone())
                        .await
                        .unwrap()
                );
            }
            let last = fields.next().await.unwrap().unwrap();
            assert!(
                json::text_eq(&last.key, "readInstructions", context.budget.clone())
                    .await
                    .unwrap()
            );
            assert!(fields.next().await.unwrap().is_none());
        }
    }
    #[tokio::test]
    async fn compatible_reasoning_metadata_retains_empty_committed_text() {
        let provider = ProviderKind::OpenaiCompatible {
            name: "test".into(),
        };
        let context = ProjectContext {
            language: Language::En,
            vision: false,
            provider: &provider,
            replay: None,
            captured: None,
            row_root: None,
            payload_root: None,
            arena: None,
            internal_arena: false,
            cancellation: &tokio_util::sync::CancellationToken::new(),
            budget: Arc::new(Budget),
            directory_owner: Arc::new(()),
        };
        let text = json::inspect(&json_literal(r#""""#), context.budget.clone())
            .await
            .unwrap()
            .text()
            .unwrap();
        let options = json_literal(r#"{"maka":{"openAiChatReasoningField":"reasoning_content"}}"#);
        let ProjectedRow::AssistantMetadata { options } =
            project_text(text, Some(options), true, &context)
                .await
                .unwrap()
        else {
            panic!("expected committed message metadata")
        };
        let field = json::field(
            &options,
            &["openaiCompatible", "reasoning_content"],
            context.budget.clone(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(
            json::text_eq(&field.text().unwrap(), "", context.budget.clone())
                .await
                .unwrap()
        );
    }
    #[tokio::test]
    async fn plaintext_summary_keeps_unicode_boundaries_and_empty_segments() {
        let contract = maka_agent_facts::model::PlaintextResponses {
            reasoning_replay: maka_agent_facts::model::PlaintextReasoningReplay::PlaintextSummary,
            compatibility: None,
        };
        let provider = ProviderKind::OpenResponses(contract);
        let context = ProjectContext {
            language: Language::En,
            vision: false,
            provider: &provider,
            replay: None,
            captured: None,
            row_root: None,
            payload_root: None,
            arena: None,
            internal_arena: false,
            cancellation: &tokio_util::sync::CancellationToken::new(),
            budget: Arc::new(Budget),
            directory_owner: Arc::new(()),
        };
        let text = json::inspect(&json_literal(r#""想😀好""#), context.budget.clone())
            .await
            .unwrap()
            .text()
            .unwrap();
        let options = json_literal(
            r#"{"makaResponses":{"version":1,"profile":"plaintext-summary:standard","itemId":"rs_1","summaryPartLengths":[3,0,1]}}"#,
        );
        let ProjectedRow::Assistant(AssistantRecipe::Reasoning {
            provider_options: Some(options),
            ..
        }) = project_text(text, Some(options), true, &context)
            .await
            .unwrap()
        else {
            panic!("expected summary reasoning")
        };
        let parts = json::field(
            &options,
            &["openResponses", "reasoningSummary"],
            context.budget.clone(),
        )
        .await
        .unwrap()
        .unwrap()
        .source;
        let mut cursor = json::ArrayCursor::open(parts, context.budget.clone())
            .await
            .unwrap();
        for expected in ["想😀", "", "好"] {
            let part = cursor.next().await.unwrap().unwrap();
            let text = json::field(&part.source, &["text"], context.budget.clone())
                .await
                .unwrap()
                .unwrap()
                .text()
                .unwrap();
            assert!(
                json::text_eq(&text, expected, context.budget.clone())
                    .await
                    .unwrap()
            );
        }
        assert!(cursor.next().await.unwrap().is_none());
    }
    #[tokio::test]
    async fn plaintext_summary_rejects_utf16_boundary_inside_scalar() {
        let contract = maka_agent_facts::model::PlaintextResponses {
            reasoning_replay: maka_agent_facts::model::PlaintextReasoningReplay::PlaintextSummary,
            compatibility: None,
        };
        let provider = ProviderKind::OpenResponses(contract);
        let context = ProjectContext {
            language: Language::En,
            vision: false,
            provider: &provider,
            replay: None,
            captured: None,
            row_root: None,
            payload_root: None,
            arena: None,
            internal_arena: false,
            cancellation: &tokio_util::sync::CancellationToken::new(),
            budget: Arc::new(Budget),
            directory_owner: Arc::new(()),
        };
        let text = json::inspect(&json_literal(r#""😀""#), context.budget.clone())
            .await
            .unwrap()
            .text()
            .unwrap();
        let options = json_literal(
            r#"{"makaResponses":{"version":1,"profile":"plaintext-summary:standard","itemId":"rs_1","summaryPartLengths":[1,1]}}"#,
        );
        assert!(matches!(
            project_text(text, Some(options), true, &context)
                .await
                .unwrap(),
            ProjectedRow::Skip
        ));
    }
    #[tokio::test]
    async fn nested_error_plan_stops_after_two_decodes() {
        let context = ProjectContext {
            language: Language::En,
            vision: false,
            provider: &ProviderKind::Anthropic,
            replay: None,
            captured: None,
            row_root: None,
            payload_root: None,
            arena: None,
            internal_arena: false,
            cancellation: &tokio_util::sync::CancellationToken::new(),
            budget: Arc::new(Budget),
            directory_owner: Arc::new(()),
        };
        let plan = error_plan(literal(r#""{\"error_code\":\"quota\"}""#), &context)
            .await
            .unwrap();
        assert!(plan.value.is_some());
        let SecondError::Decoded(text) = plan.second else {
            panic!("expected exactly second decoded source")
        };
        assert!(
            json::text_eq(&text, r#"{"error_code":"quota"}"#, context.budget.clone())
                .await
                .unwrap()
        );
        assert_eq!(
            plan.bytes,
            r#""{\"error_code\":\"quota\"}""#.len() + r#"{"error_code":"quota"}"#.len()
        );
        let invalid = error_plan(literal("not JSON"), &context).await.unwrap();
        assert!(invalid.value.is_none());
        assert_eq!(invalid.bytes, 0);
    }
    #[tokio::test]
    async fn embedded_error_parser_propagates_storage_invalid_data() {
        use maka_agent_facts::model::prompt_source::source::{ByteCursor, ByteSource, ReadSource};
        struct Failure;
        impl ByteSource for Failure {
            fn len(&self) -> Option<u64> {
                Some(1)
            }
            fn open(&self, _budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
                Box::new(Failure)
            }
        }
        impl ByteCursor for Failure {
            fn read_chunk(&mut self, _buffer: ChargedBuffer) -> ReadSource<'_> {
                Box::pin(async {
                    Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "storage checksum failed",
                    ))
                })
            }
        }
        let context = ProjectContext {
            language: Language::En,
            vision: false,
            provider: &ProviderKind::Anthropic,
            replay: None,
            captured: None,
            row_root: None,
            payload_root: None,
            arena: None,
            internal_arena: false,
            cancellation: &tokio_util::sync::CancellationToken::new(),
            budget: Arc::new(Budget),
            directory_owner: Arc::new(()),
        };
        let source = TextSource::new(SourceBytes::Source(Arc::new(Failure)), TextEncoding::Utf8);
        let error = match error_plan(source, &context).await {
            Ok(_) => panic!("storage failure must not become a null hint"),
            Err(error) => error,
        };
        assert_eq!(error.to_string(), "storage checksum failed");
    }
    #[tokio::test]
    async fn embedded_error_validation_preserves_legacy_value_depth_and_numbers() {
        let context = ProjectContext {
            language: Language::En,
            vision: false,
            provider: &ProviderKind::Anthropic,
            replay: None,
            captured: None,
            row_root: None,
            payload_root: None,
            arena: None,
            internal_arena: false,
            cancellation: &tokio_util::sync::CancellationToken::new(),
            budget: Arc::new(Budget),
            directory_owner: Arc::new(()),
        };
        for depth in [126, 127, 128, 140] {
            let text = format!(
                "{{\"error_code\":\"quota\",\"ignored\":{}0{}}}",
                "[".repeat(depth),
                "]".repeat(depth)
            );
            let expected = serde_json::from_str::<serde_json::Value>(&text).is_ok();
            let plan = error_plan(
                maka_agent_facts::model::prompt_source::source::generated::text(text),
                &context,
            )
            .await
            .unwrap();
            assert_eq!(
                plan.value.is_some(),
                expected,
                "legacy recursion policy at depth {depth}"
            );
        }
        for text in [
            r#"{"error_code":"quota","ignored":1e400}"#,
            r#"{"error_code":"quota","ignored":1e308}"#,
        ] {
            let expected = serde_json::from_str::<serde_json::Value>(text).is_ok();
            let plan = error_plan(literal(text), &context).await.unwrap();
            assert_eq!(
                plan.value.is_some(),
                expected,
                "ignored numeric field must still be Value-valid"
            );
        }
    }
}
