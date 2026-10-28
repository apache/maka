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
            payload_root,
            arena: self.arena,
            internal_arena: self.internal_arena,
            cancellation: self.cancellation,
            budget: self.budget.clone(),
            directory_owner: self.directory_owner.clone(),
        }
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
    TextSource {
        bytes: SourceBytes::Inline(value.as_bytes().into()),
        encoding: TextEncoding::Utf8,
    }
}
fn required(value: Option<JsonValue>) -> io::Result<JsonValue> {
    value.ok_or_else(invalid)
}
fn options(value: Option<JsonValue>) -> Option<JsonSource> {
    value
        .filter(|value| value.kind != JsonKind::Null)
        .map(|value| value.source)
}
async fn lookup(
    source: &JsonSource,
    name: &str,
    context: &ProjectContext<'_>,
) -> io::Result<JsonValue> {
    required(json::field(source, &[name], context.budget.clone()).await?)
}
async fn tagged(source: &JsonSource, name: &str, context: &ProjectContext<'_>) -> io::Result<bool> {
    json::text_eq(
        &lookup(source, "kind", context).await?.text()?,
        name,
        context.budget.clone(),
    )
    .await
}
async fn flag(source: &JsonSource, name: &str, context: &ProjectContext<'_>) -> io::Result<bool> {
    json::bool_value(
        &lookup(source, name, context).await?.source,
        context.budget.clone(),
    )
    .await
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
    metadata: JsonSource,
    payload: Option<JsonSource>,
    context: &ProjectContext<'_>,
) -> io::Result<ProjectedRow> {
    let kind = lookup(&metadata, "kind", context).await?.source;
    let names = [
        "User",
        "ImportedUser",
        "ImportedAssistant",
        "ExecutorText",
        "AssistantPart",
        "ToolResult",
        "Notification",
        "UnknownTool",
    ];
    let fields = json::fields(&kind, &names, context.budget.clone()).await?;
    let (which, row) = fields
        .into_iter()
        .enumerate()
        .find_map(|(i, v)| v.map(|v| (i, v.source)))
        .ok_or_else(invalid)?;
    if which == 7 {
        return Ok(ProjectedRow::Tool(
            result(
                &row,
                ToolOutputRecipe::ErrorText(literal(unknown(context.language))),
                ToolResultKind::Settled,
                context,
            )
            .await?,
        ));
    }
    let payload = payload.ok_or_else(invalid)?;
    match which {
        0 => {
            let input = lookup(&payload, "User", context).await?.source;
            super::source_projector::user(&input, flag(&row, "steering", context).await?, context)
                .await
        }
        1 | 2 | 3 | 6 => {
            let text = lookup(&payload, "Text", context).await?.text()?;
            Ok(match which {
                1 => ProjectedRow::User(list(
                    vec![ContentRecipe::Text {
                        text,
                        provider_options: None,
                    }],
                    context,
                )),
                2 | 3 => ProjectedRow::Assistant(AssistantRecipe::Text {
                    text,
                    provider_options: None,
                }),
                _ => ProjectedRow::Tool(
                    result(
                        &row,
                        ToolOutputRecipe::Text(text),
                        ToolResultKind::Notification,
                        context,
                    )
                    .await?,
                ),
            })
        }
        4 => {
            let part = lookup(&payload, "Part", context).await?.source;
            if tagged(&part, "text", context).await? {
                let thinking = json::text_eq(
                    &lookup(&part, "text_kind", context).await?.text()?,
                    "thinking",
                    context.budget.clone(),
                )
                .await?;
                check_route(&metadata, thinking, context).await?;
            }
            assistant(&part, context).await
        }
        5 => {
            let fields = json::fields(&payload, &["Text", "Tool"], context.budget.clone()).await?;
            let mut fields = fields.into_iter();
            let text = fields.next().flatten();
            let tool = fields.next().flatten();
            let output = if let Some(text) = text {
                ToolOutputRecipe::ErrorText(text.text()?)
            } else {
                let projection = tool.map_or(payload, |tool| tool.source);
                tool_output(
                    &projection,
                    flag(&row, "archived", context).await?,
                    flag(&row, "is_error", context).await?,
                    context,
                )
                .await?
            };
            Ok(ProjectedRow::Tool(
                result(&row, output, ToolResultKind::Settled, context).await?,
            ))
        }
        _ => Err(invalid()),
    }
}

async fn result(
    row: &JsonSource,
    output: ToolOutputRecipe,
    kind: ToolResultKind,
    context: &ProjectContext<'_>,
) -> io::Result<ToolResultRecipe> {
    let mut fields = json::fields(row, &["call_id", "name", "custom"], context.budget.clone())
        .await?
        .into_iter();
    let tool_call_id = required(fields.next().flatten())?.text()?;
    let tool_name = match fields.next().flatten() {
        Some(value) => value.text()?,
        None => literal("exec"),
    };
    let custom = required(fields.next().flatten())?;
    let custom = json::bool_value(&custom.source, context.budget.clone()).await?;
    let mut result = ToolResultRecipe {
        tool_call_id,
        tool_name,
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

async fn assistant(part: &JsonSource, context: &ProjectContext<'_>) -> io::Result<ProjectedRow> {
    let kind = lookup(part, "kind", context).await?.text()?;
    if json::text_eq(&kind, "source", context.budget.clone()).await? {
        return Ok(ProjectedRow::Skip);
    }
    if json::text_eq(&kind, "text", context.budget.clone()).await? {
        let fields = json::fields(
            part,
            &["text", "provider_options", "text_kind"],
            context.budget.clone(),
        )
        .await?;
        let mut fields = fields.into_iter();
        let text = required(fields.next().flatten())?.text()?;
        let options = options(fields.next().flatten());
        let thinking = json::text_eq(
            &required(fields.next().flatten())?.text()?,
            "thinking",
            context.budget.clone(),
        )
        .await?;
        return project_text(text, options, thinking, context).await;
    }
    if json::text_eq(&kind, "tool_call", context.budget.clone()).await? {
        let call = lookup(part, "call", context).await?.source;
        let mut fields = json::fields(
            &call,
            &[
                "id",
                "name",
                "input",
                "provider_executed",
                "provider_options",
            ],
            context.budget.clone(),
        )
        .await?
        .into_iter();
        let tool_call_id = required(fields.next().flatten())?.text()?;
        let tool_name = required(fields.next().flatten())?.text()?;
        let input = required(fields.next().flatten())?.source;
        let executed = required(fields.next().flatten())?.source;
        let provider_options = options(fields.next().flatten());
        let data = lookup(&input, "data", context).await?.source;
        let input = if tagged(&input, "json", context).await? {
            ToolInputRecipe::Json(data)
        } else {
            ToolInputRecipe::Text(lookup(&data, "raw", context).await?.text()?)
        };
        let provider_executed = Some(json::bool_value(&executed, context.budget.clone()).await?);
        let mut kind = call_kind(provider_options.as_ref(), context).await?;
        if kind == ToolCallKind::Function
            && let Some(options) = provider_options.as_ref()
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
        return Ok(ProjectedRow::Assistant(AssistantRecipe::ToolCall {
            tool_call_id,
            tool_name,
            input,
            kind,
            provider_executed,
            provider_options,
        }));
    }
    if json::text_eq(&kind, "tool_result", context.budget.clone()).await? {
        let mut fields = json::fields(
            part,
            &["id", "name", "output", "is_error", "provider_options"],
            context.budget.clone(),
        )
        .await?
        .into_iter();
        let tool_call_id = required(fields.next().flatten())?.text()?;
        let tool_name = required(fields.next().flatten())?.text()?;
        let output = required(fields.next().flatten())?.source;
        let error = required(fields.next().flatten())?.source;
        let provider_options = options(fields.next().flatten());
        let error = json::bool_value(&error, context.budget.clone()).await?;
        let call_kind = call_kind(provider_options.as_ref(), context).await?;
        let mut result = ToolResultRecipe {
            tool_call_id,
            tool_name,
            kind: ToolResultKind::Settled,
            call_kind,
            parsed_error: None,
            replay: ToolResultReplay::Ordinary,
            output: if error {
                ToolOutputRecipe::ErrorJson(output)
            } else {
                ToolOutputRecipe::Json(output)
            },
            provider_options,
        };
        freeze_error(&mut result, context).await?;
        return Ok(ProjectedRow::Assistant(AssistantRecipe::ToolResult(result)));
    }
    Err(invalid())
}

async fn check_route(
    metadata: &JsonSource,
    thinking: bool,
    context: &ProjectContext<'_>,
) -> io::Result<()> {
    if !thinking {
        return Ok(());
    }
    if let Some(replay) = context.replay {
        let row = json::field(metadata, &["kind", "AssistantPart"], context.budget.clone())
            .await?
            .ok_or_else(invalid)?
            .source;
        let mut fields = json::fields(
            &row,
            &["model_id", "route_identity"],
            context.budget.clone(),
        )
        .await?
        .into_iter();
        let model = required(fields.next().flatten())?.text()?;
        let route = required(fields.next().flatten())?.text()?;
        if !json::text_eq(&model, &replay.model, context.budget.clone()).await?
            || !json::text_eq(&route, &replay.route, context.budget.clone()).await?
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "continuation reasoning belongs to another provider route or model",
            ));
        }
    }
    Ok(())
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

pub(super) async fn project_text_part(
    metadata: JsonSource,
    text: TextSource,
    provider_options: Option<JsonSource>,
    context: &ProjectContext<'_>,
) -> io::Result<ProjectedRow> {
    let text_kind = json::field(
        &metadata,
        &["kind", "AssistantPart", "payload", "Text", "text_kind"],
        context.budget.clone(),
    )
    .await?
    .ok_or_else(invalid)?
    .text()?;
    let thinking = json::text_eq(&text_kind, "thinking", context.budget.clone()).await?;
    check_route(&metadata, thinking, context).await?;
    project_text(text, provider_options, thinking, context).await
}
/// A contribution-wise upper bound; streamed text and option-overlay storage are charged separately.
pub(super) async fn footprint_text_policy(
    metadata: &JsonSource,
    contribution: Option<&JsonSource>,
    context: &ProjectContext<'_>,
) -> io::Result<usize> {
    let kind = json::field(
        metadata,
        &["kind", "AssistantPart", "payload", "Text", "text_kind"],
        context.budget.clone(),
    )
    .await?
    .ok_or_else(invalid)?
    .text()?;
    if !json::text_eq(&kind, "thinking", context.budget.clone()).await? {
        return Ok(0);
    }
    if matches!(context.provider, ProviderKind::OpenaiCompatible { .. }) {
        return super::joined_source::metadata_bytes(3);
    }
    let ProviderKind::OpenResponses(contract) = context.provider else {
        return Ok(0);
    };
    if contract.reasoning_replay
        != maka_agent_facts::model::PlaintextReasoningReplay::PlaintextSummary
    {
        return Ok(0);
    }
    let span = super::joined_source::span_metadata_bytes();
    let mut weight = span;
    let mut retained = 0usize;
    let mut count = 0usize;
    if let Some(contribution) = contribution {
        weight = weight.max(raw_footprint(&contribution.bytes)?);
        if let Some(state) =
            json::field(contribution, &["makaResponses"], context.budget.clone()).await?
            && state.kind == JsonKind::Object
        {
            for field in json::fields(
                &state.source,
                &["profile", "itemId", "summaryPartLengths"],
                context.budget.clone(),
            )
            .await?
            .into_iter()
            .flatten()
            {
                let bytes = raw_footprint(&field.source.bytes)?;
                weight = weight.max(bytes);
                footprint_add(&mut retained, bytes)?;
            }
            if let Some(lengths) = json::field(
                &state.source,
                &["summaryPartLengths"],
                context.budget.clone(),
            )
            .await?
                && lengths.kind == JsonKind::Array
            {
                let mut cursor =
                    json::ArrayCursor::open(lengths.source, context.budget.clone()).await?;
                while cursor.next().await?.is_some() {
                    count = count.checked_add(1).ok_or_else(invalid)?;
                }
            }
        }
    }
    let parts = count
        .checked_mul(4)
        .and_then(|count| count.checked_add(10))
        .ok_or_else(invalid)?;
    let mut bytes = super::joined_source::metadata_bytes(parts)?;
    footprint_add(&mut bytes, count.checked_mul(span).ok_or_else(invalid)?)?;
    footprint_add(&mut bytes, retained)?;
    footprint_add(&mut bytes, weight.checked_mul(3).ok_or_else(invalid)?)?;
    Ok(bytes)
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
        if text.encoding != TextEncoding::JsonString {
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
            vec![literal(prefix).bytes, text.bytes, literal("}}").bytes],
            context.directory_owner.clone(),
        )?;
        return Ok(ProjectedRow::AssistantMetadata {
            options: JsonSource { bytes },
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
    TextSource {
        bytes: value.bytes,
        encoding: TextEncoding::Utf8,
    }
}
async fn user(
    input: &JsonSource,
    steering: bool,
    context: &ProjectContext<'_>,
) -> io::Result<ProjectedRow> {
    let mut fields = json::fields(
        input,
        &["text", "quotes", "attachments", "directory_references"],
        context.budget.clone(),
    )
    .await?
    .into_iter();
    let (_, piece_count, content_count) = user_layout(input, steering, context).await?;
    let mut content = Vec::with_capacity(content_count);
    content.push(ContentRecipe::Text {
        text: literal(""),
        provider_options: None,
    });
    let mut pieces = Vec::with_capacity(piece_count);
    pieces.push(required(fields.next().flatten())?.text()?);
    if let Some(quotes) = options(fields.next().flatten()) {
        let mut quotes = json::ArrayCursor::open(quotes, context.budget.clone()).await?;
        let mut first = true;
        while let Some(quote) = quotes.next().await? {
            pieces.push(literal(if first { "\n\n" } else { "\n" }));
            first = false;
            pieces.push(literal("<quoted_excerpt"));
            let mut fields = json::fields(
                &quote.source,
                &["label", "source", "text"],
                context.budget.clone(),
            )
            .await?
            .into_iter();
            if let Some(label) = fields
                .next()
                .flatten()
                .filter(|value| value.kind != JsonKind::Null)
            {
                pieces.push(literal(" label=\""));
                pieces.push(source_text::quote_label(
                    label.text()?,
                    context.budget.clone(),
                ));
                pieces.push(literal("\""));
            }
            pieces.push(literal(">\n"));
            if let Some(source) = options(fields.next().flatten()) {
                pieces.push(literal(match context.language {
                    Language::En => "Session snapshot provenance (display-only): ",
                    Language::ZhCn => "会话快照来源（仅供展示）：",
                    Language::ZhTw => "工作階段快照來源（僅供顯示）：",
                }));
                pieces.push(source_text::html(raw_json(source), context.budget.clone()));
                pieces.push(literal("\n"));
            }
            pieces.push(required(fields.next().flatten())?.text()?);
            pieces.push(literal("\n</quoted_excerpt>"));
        }
    }
    if let Some(attachments) = options(fields.next().flatten()) {
        let mut cursor =
            located::Values::open(attachments, located::attachments(context).await?, context)
                .await?;
        let mut first = true;
        while let Some(attachment) = cursor.next().await? {
            pieces.push(literal(if first { "\n\n" } else { "\n" }));
            first = false;
            let projected = media::attachment(
                &attachment.value.source,
                attachment.location.as_ref(),
                media::Mode::Capture,
                context,
            )
            .await?;
            pieces.extend(projected.pieces);
            if let Some(part) = projected.content {
                content.push(part);
            }
        }
    }
    if let Some(references) = options(fields.next().flatten()) {
        let mut cursor =
            json::ArrayCursor::open(references.clone(), context.budget.clone()).await?;
        if cursor.next().await?.is_some() {
            pieces.push(literal("\n\n<directory_references>\n"));
            pieces.push(literal(match context.language {Language::En=>"Live directory paths on the originating Runtime Host, accessible with Glob/Read. The project and working directory are unchanged.\n",Language::ZhCn=>"原始运行时主机上的实时目录路径，可通过 Glob/Read 访问。项目与工作目录不变。\n",Language::ZhTw=>"原始執行階段主機上的即時目錄路徑，可透過 Glob/Read 存取。專案與工作目錄不變。\n"}));
            pieces.push(source_text::html(
                raw_json(references),
                context.budget.clone(),
            ));
            pieces.push(literal("\n</directory_references>"));
        }
    }
    if steering {
        pieces.insert(
            0,
            literal(match context.language {
                Language::En => "The user sent a message while you were working:\n<user_query>\n",
                Language::ZhCn => "用户在你工作期间发来消息：\n<user_query>\n",
                Language::ZhTw => "使用者在你工作期間傳來訊息：\n<user_query>\n",
            }),
        );
        pieces.push(literal("\n</user_query>"));
    }
    let text = concat(pieces, context);
    content[0] = ContentRecipe::Text {
        text,
        provider_options: None,
    };
    Ok(ProjectedRow::User(list(content, context)))
}

async fn tool_output(
    projection: &JsonSource,
    archived: bool,
    error: bool,
    context: &ProjectContext<'_>,
) -> io::Result<ToolOutputRecipe> {
    let kind = lookup(projection, "kind", context).await?.text()?;
    if json::text_eq(&kind, "text", context.budget.clone()).await? {
        return Ok(ToolOutputRecipe::Text(
            lookup(projection, "text", context).await?.text()?,
        ));
    }
    if json::text_eq(&kind, "json", context.budget.clone()).await? {
        let mut value = lookup(projection, "value", context).await?.source;
        if archived {
            value = archive(value, context).await?;
        }
        return Ok(if error && archived {
            ToolOutputRecipe::ErrorJson(value)
        } else {
            ToolOutputRecipe::Json(value)
        });
    }
    if json::text_eq(&kind, "failure", context.budget.clone()).await? {
        return Ok(ToolOutputRecipe::ErrorText(literal(
            match context.language {
                Language::En => {
                    maka_agent_facts::tool_output::DURABLE_TOOL_PROJECTION_FAILURE_MESSAGE
                }
                Language::ZhCn => "工具已完成，但无法安全投影其供模型读取的结果。",
                Language::ZhTw => "工具已完成，但無法安全投影其供模型讀取的結果。",
            },
        )));
    }
    let parts = lookup(projection, "parts", context).await?.source;
    let mut cursor =
        located::Values::open(parts.clone(), located::tool_parts(context).await?, context).await?;
    let mut count_cursor = json::ArrayCursor::open(parts.clone(), context.budget.clone()).await?;
    let mut part_count = 0usize;
    while count_cursor.next().await?.is_some() {
        part_count = part_count.checked_add(1).ok_or_else(invalid)?;
    }
    let mut content = Vec::with_capacity(part_count);
    while let Some(part) = cursor.next().await? {
        if tagged(&part.value.source, "text", context).await? {
            content.push(ContentRecipe::Text {
                text: lookup(&part.value.source, "text", context).await?.text()?,
                provider_options: None,
            });
        } else {
            content.push(
                media::tool(
                    &part.value.source,
                    part.location.as_ref(),
                    media::Mode::Capture,
                    context,
                )
                .await?
                .content
                .ok_or_else(invalid)?,
            );
        }
    }
    Ok(ToolOutputRecipe::Content(list(content, context)))
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
    while let Some(field) = cursor.next_spans().await? {
        nonempty = true;
        let key = TextSource {
            bytes: value.bytes.slice(field.key_range)?,
            encoding: TextEncoding::JsonString,
        };
        if json::text_eq(&key, "readInstructions", context.budget.clone()).await? {
            return Ok(ArchivePlacement::Replace(field.value_range));
        }
    }
    Ok(ArchivePlacement::Append { nonempty })
}
async fn archive_shape(
    value: &JsonSource,
    context: &ProjectContext<'_>,
) -> io::Result<(usize, usize)> {
    let (parts, spans) = match archive_placement(value, context).await? {
        ArchivePlacement::Replace(_) => (3, 2),
        ArchivePlacement::Append { .. } => (5, 1),
    };
    let mut bytes = raw_footprint(&value.bytes)?
        .checked_mul(spans)
        .ok_or_else(invalid)?;
    footprint_add(&mut bytes, super::joined_source::metadata_bytes(parts)?)?;
    Ok((parts, bytes))
}
async fn archive(value: JsonSource, context: &ProjectContext<'_>) -> io::Result<JsonSource> {
    let length = match &value.bytes {
        SourceBytes::Inline(bytes) => bytes.len() as u64,
        SourceBytes::Source(source) => source.len().ok_or_else(invalid)?,
    };
    let pieces = match archive_placement(&value, context).await? {
        ArchivePlacement::Replace(range) => vec![
            value.bytes.slice(0..range.start)?,
            literal(archive_instruction(context.language)).bytes,
            value.bytes.slice(range.end..length)?,
        ],
        ArchivePlacement::Append { nonempty } => vec![
            value
                .bytes
                .slice(0..length.checked_sub(1).ok_or_else(invalid)?)?,
            literal(if nonempty { "," } else { "" }).bytes,
            literal(r#""readInstructions":"#).bytes,
            literal(archive_instruction(context.language)).bytes,
            literal("}").bytes,
        ],
    };
    Ok(JsonSource {
        bytes: super::joined_source::join(pieces, context.directory_owner.clone())?,
    })
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
    metadata: JsonSource,
    payload: Option<JsonSource>,
    context: &ProjectContext<'_>,
) -> io::Result<super::chat_source::ChatShape> {
    let mut shape = super::chat_source::ChatShape::default();
    if !context.vision
        || !matches!(
            context.provider,
            ProviderKind::OpenaiChatCompletions | ProviderKind::OpenaiCompatible { .. }
        )
    {
        return Ok(shape);
    }
    if json::field(&metadata, &["kind", "ToolResult"], context.budget.clone())
        .await?
        .is_none()
    {
        return Ok(shape);
    }
    let Some(payload) = payload else {
        return Ok(shape);
    };
    let mut fields = json::fields(&payload, &["Text", "Tool", "kind"], context.budget.clone())
        .await?
        .into_iter();
    if fields.next().flatten().is_some() {
        return Ok(shape);
    }
    let projection = match fields.next().flatten() {
        Some(value) => value.source,
        None => {
            if fields.next().flatten().is_none() {
                return Ok(shape);
            }
            payload
        }
    };
    if !tagged(&projection, "content", context).await? {
        return Ok(shape);
    }
    let mut cursor = located::Values::open(
        lookup(&projection, "parts", context).await?.source,
        located::tool_parts(context).await?,
        context,
    )
    .await?;
    while let Some(part) = cursor.next().await? {
        shape.content_parts = shape.content_parts.checked_add(1).ok_or_else(invalid)?;
        let kind = lookup(&part.value.source, "kind", context).await?.text()?;
        if json::text_eq(&kind, "artifact", context.budget.clone()).await?
            || json::text_eq(&kind, "audio", context.budget.clone()).await?
        {
            shape.media_parts = shape.media_parts.checked_add(1).ok_or_else(invalid)?;
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
fn value_footprint(value: Option<JsonValue>) -> io::Result<usize> {
    match value {
        Some(value) => raw_footprint(&value.source.bytes),
        None => Ok(0),
    }
}

/// Count only nested retained allocations before reserving the frozen directory.
/// The engine separately charges top-level message, assistant, and tool arrays.
pub(super) async fn footprint_row(
    metadata: JsonSource,
    payload: Option<JsonSource>,
    context: &ProjectContext<'_>,
) -> io::Result<usize> {
    let kind = lookup(&metadata, "kind", context).await?.source;
    let names = [
        "User",
        "ImportedUser",
        "ImportedAssistant",
        "ExecutorText",
        "AssistantPart",
        "ToolResult",
        "Notification",
        "UnknownTool",
    ];
    let fields = json::fields(&kind, &names, context.budget.clone()).await?;
    let (which, row) = fields
        .into_iter()
        .enumerate()
        .find_map(|(index, value)| value.map(|value| (index, value.source)))
        .ok_or_else(invalid)?;
    let mut bytes = 0usize;
    if matches!(which, 5..=7) {
        for value in json::fields(&row, &["call_id", "name"], context.budget.clone()).await? {
            footprint_add(&mut bytes, value_footprint(value)?)?;
        }
    }
    if which == 7 {
        return Ok(bytes);
    }
    if matches!(which, 4 | 5) {
        footprint_add(
            &mut bytes,
            error_metadata_bytes(metadata.clone(), payload.clone(), context).await?,
        )?;
    }
    let payload = payload.ok_or_else(invalid)?;
    match which {
        0 => footprint_add(
            &mut bytes,
            user_footprint(
                &lookup(&payload, "User", context).await?.source,
                flag(&row, "steering", context).await?,
                context,
            )
            .await?,
        )?,
        1 | 2 | 3 | 6 => {
            footprint_add(
                &mut bytes,
                value_footprint(Some(lookup(&payload, "Text", context).await?))?,
            )?;
            if which == 1 {
                footprint_add(&mut bytes, items_footprint::<ContentRecipe>(1)?)?;
            }
        }
        4 => {
            let part = lookup(&payload, "Part", context).await?.source;
            let kind = lookup(&part, "kind", context).await?.text()?;
            if json::text_eq(&kind, "text", context.budget.clone()).await? {
                let mut fields = json::fields(
                    &part,
                    &["text", "provider_options", "text_kind"],
                    context.budget.clone(),
                )
                .await?
                .into_iter();
                let text = required(fields.next().flatten())?.text()?;
                let options = options(fields.next().flatten());
                let thinking = json::text_eq(
                    &required(fields.next().flatten())?.text()?,
                    "thinking",
                    context.budget.clone(),
                )
                .await?;
                footprint_add(
                    &mut bytes,
                    text_footprint(&text, options.as_ref(), thinking, context).await?,
                )?;
            } else if json::text_eq(&kind, "tool_call", context.budget.clone()).await? {
                let call = lookup(&part, "call", context).await?.source;
                let mut retained = json::fields(
                    &call,
                    &["id", "name", "provider_options"],
                    context.budget.clone(),
                )
                .await?
                .into_iter();
                footprint_add(&mut bytes, value_footprint(retained.next().flatten())?)?;
                footprint_add(&mut bytes, value_footprint(retained.next().flatten())?)?;
                if let Some(options) = options(retained.next().flatten()) {
                    footprint_add(&mut bytes, raw_footprint(&options.bytes)?)?;
                }
                let input = lookup(&call, "input", context).await?.source;
                let data = lookup(&input, "data", context).await?;
                let retained = if tagged(&input, "json", context).await? {
                    data
                } else {
                    lookup(&data.source, "raw", context).await?
                };
                footprint_add(&mut bytes, value_footprint(Some(retained))?)?;
            } else if json::text_eq(&kind, "tool_result", context.budget.clone()).await? {
                let mut retained = json::fields(
                    &part,
                    &["id", "name", "output", "provider_options"],
                    context.budget.clone(),
                )
                .await?
                .into_iter();
                for _ in 0..3 {
                    footprint_add(&mut bytes, value_footprint(retained.next().flatten())?)?;
                }
                if let Some(options) = options(retained.next().flatten()) {
                    footprint_add(&mut bytes, raw_footprint(&options.bytes)?)?;
                }
            }
        }
        5 => {
            let mut fields = json::fields(&payload, &["Text", "Tool"], context.budget.clone())
                .await?
                .into_iter();
            if let Some(text) = fields.next().flatten() {
                footprint_add(&mut bytes, value_footprint(Some(text))?)?;
            } else {
                let projection = fields
                    .next()
                    .flatten()
                    .map_or(payload, |value| value.source);
                let kind = lookup(&projection, "kind", context).await?.text()?;
                if json::text_eq(&kind, "text", context.budget.clone()).await? {
                    footprint_add(
                        &mut bytes,
                        value_footprint(Some(lookup(&projection, "text", context).await?))?,
                    )?;
                } else if json::text_eq(&kind, "json", context.budget.clone()).await? {
                    let value = lookup(&projection, "value", context).await?.source;
                    let footprint = if flag(&row, "archived", context).await? {
                        archive_shape(&value, context).await?.1
                    } else {
                        raw_footprint(&value.bytes)?
                    };
                    footprint_add(&mut bytes, footprint)?;
                } else if json::text_eq(&kind, "content", context.budget.clone()).await? {
                    let mut cursor = located::Values::open(
                        lookup(&projection, "parts", context).await?.source,
                        located::tool_parts(context).await?,
                        context,
                    )
                    .await?;
                    let mut count = 0usize;
                    while let Some(part) = cursor.next().await? {
                        if tagged(&part.value.source, "text", context).await? {
                            footprint_add(
                                &mut bytes,
                                value_footprint(Some(
                                    lookup(&part.value.source, "text", context).await?,
                                ))?,
                            )?;
                        } else {
                            footprint_add(
                                &mut bytes,
                                media::tool(
                                    &part.value.source,
                                    part.location.as_ref(),
                                    media::Mode::Probe,
                                    context,
                                )
                                .await?
                                .metadata_bytes,
                            )?;
                        }
                        count = count.checked_add(1).ok_or_else(invalid)?;
                    }
                    footprint_add(&mut bytes, items_footprint::<ContentRecipe>(count)?)?;
                }
            }
        }
        _ => return Err(invalid()),
    }
    Ok(bytes)
}

async fn text_footprint(
    text: &TextSource,
    options: Option<&JsonSource>,
    thinking: bool,
    context: &ProjectContext<'_>,
) -> io::Result<usize> {
    let mut bytes = raw_footprint(&text.bytes)?;
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
        footprint_add(&mut bytes, raw_footprint(&options.bytes)?)?;
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
            Ok(Some(TextSource {
                bytes: value.bytes.clone(),
                encoding: TextEncoding::JsonString,
            }))
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
            let text = TextSource {
                bytes,
                encoding: TextEncoding::Utf8,
            };
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
    let nested = TextSource {
        bytes: value.bytes.clone(),
        encoding: TextEncoding::JsonString,
    };
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
    JsonSource {
        bytes: literal("null").bytes,
    }
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
    metadata: JsonSource,
    payload: Option<JsonSource>,
    context: &ProjectContext<'_>,
) -> io::Result<Option<TextSource>> {
    if !matches!(context.provider, ProviderKind::Anthropic) {
        return Ok(None);
    }
    let Some(payload) = payload else {
        return Ok(None);
    };
    let row_kind = lookup(&metadata, "kind", context).await?.source;
    if json::fields(
        &row_kind,
        &["AssistantPart", "ToolResult"],
        context.budget.clone(),
    )
    .await?
    .iter()
    .all(Option::is_none)
    {
        return Ok(None);
    }
    let mut fields = json::fields(&payload, &["Part", "Text"], context.budget.clone())
        .await?
        .into_iter();
    let candidate = if let Some(part) = fields.next().flatten() {
        if !tagged(&part.source, "tool_result", context).await?
            || !flag(&part.source, "is_error", context).await?
        {
            return Ok(None);
        }
        let output =
            ToolOutputRecipe::ErrorJson(lookup(&part.source, "output", context).await?.source);
        error_text(&output, context).await?
    } else if let Some(text) = fields.next().flatten() {
        let Some(_) =
            json::field(&metadata, &["kind", "ToolResult"], context.budget.clone()).await?
        else {
            return Ok(None);
        };
        error_text(&ToolOutputRecipe::ErrorText(text.text()?), context).await?
    } else {
        None
    };
    Ok(candidate)
}

/// The derived JSON backing is separate from retained recipe metadata.
pub(super) async fn backing_bytes_row(
    metadata: JsonSource,
    payload: Option<JsonSource>,
    context: &ProjectContext<'_>,
) -> io::Result<usize> {
    let row_kind = lookup(&metadata, "kind", context).await?.source;
    let media = json::fields(&row_kind, &["User", "ToolResult"], context.budget.clone())
        .await?
        .iter()
        .any(Option::is_some);
    let mut bytes = if media {
        media_backing_bytes(payload.as_ref(), context).await?
    } else {
        0
    };
    if let Some(text) = row_error_text(metadata, payload, context).await? {
        footprint_add(&mut bytes, error_plan(text, context).await?.bytes)?;
    }
    Ok(bytes)
}
async fn media_backing_bytes(
    payload: Option<&JsonSource>,
    context: &ProjectContext<'_>,
) -> io::Result<usize> {
    let Some(payload) = payload else { return Ok(0) };
    if let Some(user) = json::field(payload, &["User"], context.budget.clone()).await? {
        let Some(attachments) =
            json::field(&user.source, &["attachments"], context.budget.clone()).await?
        else {
            return Ok(0);
        };
        if attachments.kind == JsonKind::Null {
            return Ok(0);
        }
        let mut cursor = located::Values::open(
            attachments.source,
            located::attachments(context).await?,
            context,
        )
        .await?;
        let mut bytes = 0usize;
        while let Some(attachment) = cursor.next().await? {
            footprint_add(
                &mut bytes,
                media::attachment(
                    &attachment.value.source,
                    attachment.location.as_ref(),
                    media::Mode::Probe,
                    context,
                )
                .await?
                .backing_bytes,
            )?;
        }
        return Ok(bytes);
    }
    let tool = match json::field(payload, &["Tool"], context.budget.clone()).await? {
        Some(tool) => tool.source,
        None => {
            if json::field(payload, &["kind"], context.budget.clone())
                .await?
                .is_none()
            {
                return Ok(0);
            }
            payload.clone()
        }
    };
    if !tagged(&tool, "content", context).await? {
        return Ok(0);
    }
    let mut cursor = located::Values::open(
        lookup(&tool, "parts", context).await?.source,
        located::tool_parts(context).await?,
        context,
    )
    .await?;
    let mut bytes = 0usize;
    while let Some(part) = cursor.next().await? {
        if !tagged(&part.value.source, "text", context).await? {
            footprint_add(
                &mut bytes,
                media::tool(
                    &part.value.source,
                    part.location.as_ref(),
                    media::Mode::Probe,
                    context,
                )
                .await?
                .backing_bytes,
            )?;
        }
    }
    Ok(bytes)
}
async fn error_metadata_bytes(
    metadata: JsonSource,
    payload: Option<JsonSource>,
    context: &ProjectContext<'_>,
) -> io::Result<usize> {
    let Some(text) = row_error_text(metadata, payload, context).await? else {
        return Ok(0);
    };
    let plan = error_plan(text, context).await?;
    let count = usize::from(plan.value.is_some())
        + usize::from(matches!(plan.second, SecondError::Decoded(_)));
    super::capture_arena::source_metadata_bytes(count)
}

async fn user_layout(
    input: &JsonSource,
    steering: bool,
    context: &ProjectContext<'_>,
) -> io::Result<(usize, usize, usize)> {
    let mut bytes = 0usize;
    let mut content_count = 1usize;
    let mut pieces = 1usize + usize::from(steering) * 2;
    let mut fields = json::fields(
        input,
        &["text", "quotes", "attachments", "directory_references"],
        context.budget.clone(),
    )
    .await?
    .into_iter();
    footprint_add(&mut bytes, value_footprint(fields.next().flatten())?)?;
    if let Some(quotes) = options(fields.next().flatten()) {
        let mut cursor = json::ArrayCursor::open(quotes, context.budget.clone()).await?;
        while let Some(quote) = cursor.next().await? {
            pieces = pieces.checked_add(5).ok_or_else(invalid)?;
            let mut fields = json::fields(
                &quote.source,
                &["label", "source", "text"],
                context.budget.clone(),
            )
            .await?
            .into_iter();
            if let Some(label) = fields
                .next()
                .flatten()
                .filter(|value| value.kind != JsonKind::Null)
            {
                pieces = pieces.checked_add(3).ok_or_else(invalid)?;
                footprint_add(&mut bytes, value_footprint(Some(label))?)?;
                footprint_add(
                    &mut bytes,
                    source_text::transform_metadata_bytes(TextEncoding::JsonString)?,
                )?;
            }
            if let Some(source) = options(fields.next().flatten()) {
                pieces = pieces.checked_add(3).ok_or_else(invalid)?;
                footprint_add(&mut bytes, raw_footprint(&source.bytes)?)?;
                footprint_add(
                    &mut bytes,
                    source_text::transform_metadata_bytes(TextEncoding::Utf8)?,
                )?;
            }
            footprint_add(&mut bytes, value_footprint(fields.next().flatten())?)?;
        }
    }
    if let Some(attachments) = options(fields.next().flatten()) {
        let mut cursor =
            located::Values::open(attachments, located::attachments(context).await?, context)
                .await?;
        while let Some(attachment) = cursor.next().await? {
            let attachment = media::attachment(
                &attachment.value.source,
                attachment.location.as_ref(),
                media::Mode::Probe,
                context,
            )
            .await?;
            pieces = pieces
                .checked_add(1)
                .and_then(|count| count.checked_add(attachment.pieces.len()))
                .ok_or_else(invalid)?;
            footprint_add(&mut bytes, attachment.metadata_bytes)?;
            content_count = content_count
                .checked_add(usize::from(attachment.has_content))
                .ok_or_else(invalid)?;
        }
    }
    if let Some(references) = options(fields.next().flatten()) {
        let mut cursor =
            json::ArrayCursor::open(references.clone(), context.budget.clone()).await?;
        if cursor.next().await?.is_some() {
            pieces = pieces.checked_add(4).ok_or_else(invalid)?;
            footprint_add(&mut bytes, raw_footprint(&references.bytes)?)?;
            footprint_add(
                &mut bytes,
                source_text::transform_metadata_bytes(TextEncoding::Utf8)?,
            )?;
        }
    }
    footprint_add(&mut bytes, items_footprint::<TextSource>(pieces)?)?;
    footprint_add(&mut bytes, source_text::concat_metadata_bytes()?)?;
    footprint_add(&mut bytes, items_footprint::<ContentRecipe>(content_count)?)?;
    Ok((bytes, pieces, content_count))
}

async fn user_footprint(
    input: &JsonSource,
    steering: bool,
    context: &ProjectContext<'_>,
) -> io::Result<usize> {
    Ok(user_layout(input, steering, context).await?.0)
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
        JsonSource {
            bytes: SourceBytes::Inline(value.as_bytes().into()),
        }
    }
    #[tokio::test]
    async fn opaque_json_tool_output_does_not_become_media() {
        let context = ProjectContext {
            language: Language::En,
            vision: false,
            provider: &ProviderKind::Anthropic,
            replay: None,
            captured: None,
            payload_root: None,
            arena: None,
            internal_arena: false,
            cancellation: &tokio_util::sync::CancellationToken::new(),
            budget: Arc::new(Budget),
            directory_owner: Arc::new(()),
        };
        let metadata = json_literal(
            r#"{"kind":{"ToolResult":{"call_id":"call","name":"read","custom":false,"archived":false,"is_error":false}}}"#,
        );
        let payload = json_literal(
            r#"{"Tool":{"kind":"json","value":{"kind":"artifact","image":{"ref":"not-authority"}}}}"#,
        );
        let ProjectedRow::Tool(result) = project_row(metadata, Some(payload), &context)
            .await
            .unwrap()
        else {
            panic!("expected tool recipe")
        };
        let ToolOutputRecipe::Json(value) = result.output else {
            panic!("opaque JSON must remain JSON")
        };
        let kind = json::field(&value, &["kind"], context.budget.clone())
            .await
            .unwrap()
            .unwrap();
        assert!(
            json::text_eq(&kind.text().unwrap(), "artifact", context.budget.clone())
                .await
                .unwrap()
        );
    }
    #[tokio::test]
    async fn malformed_tool_input_preserves_raw_text_and_execution_flag() {
        let context = ProjectContext {
            language: Language::En,
            vision: false,
            provider: &ProviderKind::Anthropic,
            replay: None,
            captured: None,
            payload_root: None,
            arena: None,
            internal_arena: false,
            cancellation: &tokio_util::sync::CancellationToken::new(),
            budget: Arc::new(Budget),
            directory_owner: Arc::new(()),
        };
        let payload = json_literal(
            r#"{"kind":"tool_call","call":{"id":"call","name":"read","input":{"kind":"invalid_json","data":{"raw":"{\\n"}},"provider_executed":true,"provider_options":null}}"#,
        );
        let ProjectedRow::Assistant(AssistantRecipe::ToolCall {
            input,
            provider_executed,
            ..
        }) = assistant(&payload, &context).await.unwrap()
        else {
            panic!("expected tool call")
        };
        assert_eq!(provider_executed, Some(true));
        let ToolInputRecipe::Text(raw) = input else {
            panic!("malformed input must remain text")
        };
        assert!(
            json::text_eq(&raw, "{\\n", context.budget.clone())
                .await
                .unwrap()
        );
    }
    #[tokio::test]
    async fn steering_quotes_preserve_text_and_escape_display_provenance() {
        let context = ProjectContext {
            language: Language::En,
            vision: false,
            provider: &ProviderKind::Anthropic,
            replay: None,
            captured: None,
            payload_root: None,
            arena: None,
            internal_arena: false,
            cancellation: &tokio_util::sync::CancellationToken::new(),
            budget: Arc::new(Budget),
            directory_owner: Arc::new(()),
        };
        let input = json_literal(
            r#"{"text":"ask","quotes":[{"label":"a\"b","text":"<quoted>","source":{"sessionName":"<&>"}}],"attachments":[],"directory_references":[]}"#,
        );
        let ProjectedRow::User(content) = user(&input, true, &context).await.unwrap() else {
            panic!("expected user")
        };
        let mut cursor = content.open(0);
        let Some(ContentRecipe::Text { text, .. }) = cursor.next().await.unwrap() else {
            panic!("expected source text")
        };
        assert!(
            json::text_eq(
                &text,
                concat!(
                    "The user sent a message while you were working:\n<user_query>\nask\n\n",
                    "<quoted_excerpt label=\"a'b\">\nSession snapshot provenance (display-only): ",
                    r#"{"sessionName":"\u003c\u0026\u003e"}"#,
                    "\n<quoted>\n</quoted_excerpt>\n</user_query>"
                ),
                context.budget.clone()
            )
            .await
            .unwrap()
        );
    }
    #[tokio::test]
    async fn archived_instruction_replaces_in_place_and_remains_indexed() {
        let context = ProjectContext {
            language: Language::En,
            vision: false,
            provider: &ProviderKind::Anthropic,
            replay: None,
            captured: None,
            payload_root: None,
            arena: None,
            internal_arena: false,
            cancellation: &tokio_util::sync::CancellationToken::new(),
            budget: Arc::new(Budget),
            directory_owner: Arc::new(()),
        };
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
            payload_root: None,
            arena: None,
            internal_arena: false,
            cancellation: &tokio_util::sync::CancellationToken::new(),
            budget: Arc::new(Budget),
            directory_owner: Arc::new(()),
        };
        let source = TextSource {
            bytes: SourceBytes::Source(Arc::new(Failure)),
            encoding: TextEncoding::Utf8,
        };
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
