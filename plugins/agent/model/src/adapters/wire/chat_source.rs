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

//! Chat message recipes with streaming text, JSON strings and media.

use super::source::{self, SourceFragment as F, SourceItem};
use crate::ModelError;
use bytes::Bytes;
use maka_agent_facts::language::Language;
use maka_agent_facts::model::prompt_source::source::{self as recipe, *};
use maka_provider_protocol::chat_completions::request::PromptOptions;
use std::sync::Arc;
mod assistant;

fn l(value: &'static [u8]) -> F {
    F::literal(value)
}
fn generated(value: &'static str) -> TextSource {
    TextSource::new(
        SourceBytes::Inline(Bytes::from_static(value.as_bytes())),
        TextEncoding::Utf8,
    )
}
fn text(value: TextSource) -> Vec<F> {
    source::quoted(value)
}
fn error(value: std::io::Error) -> ModelError {
    ModelError::Adapter(value.to_string())
}
async fn validate_options(
    options: &Option<JsonSource>,
    budget: &Arc<dyn SourceBudget>,
) -> Result<(), ModelError> {
    if let Some(options) = options {
        let kind = recipe::json::kind(options, budget.clone())
            .await
            .map_err(error)?;
        if !matches!(
            kind,
            recipe::json::JsonKind::Object | recipe::json::JsonKind::Null
        ) {
            return Err(ModelError::Adapter(
                "provider options must be an object".into(),
            ));
        }
    }
    Ok(())
}
async fn overlay(
    options: Option<JsonSource>,
    fields: Vec<(&'static str, Vec<F>)>,
    budget: &Arc<dyn SourceBudget>,
) -> Result<Vec<F>, ModelError> {
    let extensions = match options {
        Some(source) => recipe::json::field(&source, &["openaiCompatible"], budget.clone())
            .await
            .map_err(error)?
            .map(|value| value.source),
        None => None,
    };
    source::object_with_overlay(fields, extensions, budget.clone())
        .await
        .map_err(error)
}
async fn media(
    media: MediaSource,
    options: Option<JsonSource>,
    budget: &Arc<dyn SourceBudget>,
) -> Result<Vec<F>, ModelError> {
    let kind = source::media_kind(&media.media_type, budget.clone())
        .await
        .map_err(error)?;
    let data = vec![
        l(b"\"data:"),
        F::Text(media.media_type.clone()),
        l(b";base64,"),
        F::Base64(media.bytes.clone()),
        l(b"\""),
    ];
    let (kind, key, body) = if kind == source::MediaKind::Image {
        let mut fields = vec![("url", data)];
        if let Some(detail) = media.detail {
            let mut valid = false;
            for candidate in ["auto", "low", "high", "original"] {
                if recipe::json::text_eq(&detail, candidate, budget.clone())
                    .await
                    .map_err(error)?
                {
                    valid = true;
                    break;
                }
            }
            if !valid {
                return Err(ModelError::Adapter("invalid image detail".into()));
            }
            fields.push(("detail", text(detail)));
        }
        (
            "image_url",
            "image_url",
            source::object_with_fields(None, fields, budget.clone())
                .await
                .map_err(error)?,
        )
    } else if kind == source::MediaKind::Video {
        (
            "video_url",
            "video_url",
            source::object_with_fields(None, vec![("url", data)], budget.clone())
                .await
                .map_err(error)?,
        )
    } else if matches!(
        kind,
        source::MediaKind::AudioWav | source::MediaKind::AudioMp3
    ) {
        let data = vec![l(b"\""), F::Base64(media.bytes), l(b"\"")];
        (
            "input_audio",
            "input_audio",
            source::object_with_fields(
                None,
                vec![
                    ("data", data),
                    (
                        "format",
                        text(generated(if kind == source::MediaKind::AudioWav {
                            "wav"
                        } else {
                            "mp3"
                        })),
                    ),
                ],
                budget.clone(),
            )
            .await
            .map_err(error)?,
        )
    } else if kind == source::MediaKind::Pdf {
        (
            "file",
            "file",
            source::object_with_fields(
                None,
                vec![
                    ("filename", text(generated("document.pdf"))),
                    ("file_data", data),
                ],
                budget.clone(),
            )
            .await
            .map_err(error)?,
        )
    } else if kind == source::MediaKind::Text {
        return overlay(
            options,
            vec![
                ("type", text(generated("text"))),
                ("text", vec![l(b"\""), F::LossyText(media.bytes), l(b"\"")]),
            ],
            budget,
        )
        .await;
    } else {
        return Err(ModelError::Adapter("unsupported Chat media type".into()));
    };
    overlay(
        options,
        vec![("type", text(generated(kind))), (key, body)],
        budget,
    )
    .await
}
pub(in crate::adapters::wire) async fn render_content_part(
    part: ContentRecipe,
    language: Language,
    budget: Arc<dyn SourceBudget>,
) -> Result<Vec<F>, ModelError> {
    let mut owned = 0;
    let part = audio_fallback(part, language, budget.clone(), &mut owned).await?;
    let options = match &part {
        ContentRecipe::Text {
            provider_options, ..
        }
        | ContentRecipe::Media {
            provider_options, ..
        } => provider_options,
    };
    validate_options(options, &budget).await?;
    match part {
        ContentRecipe::Text {
            text: value,
            provider_options,
        } => {
            overlay(
                provider_options,
                vec![("type", text(generated("text"))), ("text", text(value))],
                &budget,
            )
            .await
        }
        ContentRecipe::Media {
            media: value,
            provider_options,
        } => media(value, provider_options, &budget).await,
    }
}
fn content(
    parts: Arc<dyn RecipeSource<ContentRecipe>>,
    language: Language,
) -> Result<Vec<F>, ModelError> {
    source::chat_content_array(parts, language).map_err(error)
}
pub(in crate::adapters::wire) async fn render_tool_textual_part(
    part: ContentRecipe,
    language: Language,
    budget: Arc<dyn SourceBudget>,
) -> Result<Vec<F>, ModelError> {
    let mut owned = 0;
    let part = audio_fallback(part, language, budget.clone(), &mut owned).await?;
    let (fields, options) = match part {
        ContentRecipe::Text {
            text: value,
            provider_options,
        } => (
            vec![("type", text(generated("text"))), ("text", text(value))],
            provider_options,
        ),
        ContentRecipe::Media {
            media,
            provider_options,
        } => {
            let data = source::object_with_fields(
                None,
                vec![
                    ("type", text(generated("data"))),
                    ("data", vec![l(b"\""), F::Base64(media.bytes), l(b"\"")]),
                ],
                budget.clone(),
            )
            .await
            .map_err(error)?;
            (
                vec![
                    ("type", text(generated("file"))),
                    ("data", data),
                    ("mediaType", text(media.media_type)),
                ],
                provider_options,
            )
        }
    };
    validate_options(&options, &budget).await?;
    let mut fields = fields;
    if let Some(options) = options {
        fields.push(("providerOptions", vec![F::Raw(options)]));
    }
    source::object_with_fields(None, fields, budget)
        .await
        .map_err(error)
}
fn textual_content(
    parts: Arc<dyn RecipeSource<ContentRecipe>>,
    language: Language,
) -> Result<Vec<F>, ModelError> {
    source::chat_textual_array(parts, language).map_err(error)
}
async fn encode(
    message: MessageRecipe,
    options: &PromptOptions,
    language: Language,
    budget: Arc<dyn SourceBudget>,
) -> Result<Vec<SourceItem>, ModelError> {
    let options_ref = match &message {
        MessageRecipe::System {
            provider_options, ..
        }
        | MessageRecipe::User {
            provider_options, ..
        }
        | MessageRecipe::Assistant {
            provider_options, ..
        }
        | MessageRecipe::Tool {
            provider_options, ..
        } => provider_options,
    };
    validate_options(options_ref, &budget).await?;
    let mut items = Vec::new();
    match message {
        MessageRecipe::System {
            content: value,
            provider_options,
        } => items.push(
            overlay(
                provider_options,
                vec![
                    ("role", text(generated("system"))),
                    ("content", text(value)),
                ],
                &budget,
            )
            .await?,
        ),
        MessageRecipe::User {
            content: parts,
            provider_options,
        } => {
            let value = if parts.len() == 1 {
                let mut cursor = parts.open(0);
                match cursor
                    .next()
                    .await
                    .map_err(error)?
                    .expect("one content recipe")
                {
                    ContentRecipe::Text {
                        text: value,
                        provider_options,
                    } => {
                        validate_options(&provider_options, &budget).await?;
                        items.push(
                            overlay(
                                provider_options,
                                vec![("role", text(generated("user"))), ("content", text(value))],
                                &budget,
                            )
                            .await?,
                        );
                        return Ok(items
                            .into_iter()
                            .map(|fragments| SourceItem {
                                fragments: fragments.into(),
                                metadata: None,
                                citation: None,
                                owned_bytes: 0,
                            })
                            .collect());
                    }
                    ContentRecipe::Media { .. } => content(parts, language)?,
                }
            } else {
                content(parts, language)?
            };
            items.push(
                overlay(
                    provider_options,
                    vec![("role", text(generated("user"))), ("content", value)],
                    &budget,
                )
                .await?,
            );
        }
        MessageRecipe::Assistant {
            content: parts,
            provider_options,
        } => {
            let mut cursor = parts.open(0);
            let mut nonempty_text = false;
            let mut nonempty_reasoning = false;
            let mut has_calls = false;
            while let Some(part) = cursor.next().await.map_err(error)? {
                tokio::task::yield_now().await;
                let part_options = match &part {
                    AssistantRecipe::Text {
                        provider_options, ..
                    }
                    | AssistantRecipe::Reasoning {
                        provider_options, ..
                    }
                    | AssistantRecipe::ToolCall {
                        provider_options, ..
                    } => provider_options,
                    AssistantRecipe::ToolResult(result) => &result.provider_options,
                };
                validate_options(part_options, &budget).await?;
                match part {
                    AssistantRecipe::Text { text, .. } if !nonempty_text => {
                        nonempty_text = !source::escaped_equals(&text, b"", budget.clone())
                            .await
                            .map_err(error)?
                    }
                    AssistantRecipe::Reasoning { text, .. } if !nonempty_reasoning => {
                        nonempty_reasoning = !source::escaped_equals(&text, b"", budget.clone())
                            .await
                            .map_err(error)?
                    }
                    AssistantRecipe::ToolCall { .. } => has_calls = true,
                    _ => {}
                }
            }
            let content = if has_calls && !nonempty_text {
                vec![l(b"null")]
            } else {
                assistant::plan(parts.clone(), assistant::Mode::Text)?
            };
            let mut fields = vec![("role", text(generated("assistant"))), ("content", content)];
            if has_calls {
                fields.push((
                    "tool_calls",
                    assistant::plan(
                        parts.clone(),
                        assistant::Mode::Calls(Arc::from(options.metadata_namespace.as_str())),
                    )?,
                ));
            }
            if nonempty_reasoning {
                fields.push((
                    "reasoning_content",
                    assistant::plan(parts, assistant::Mode::Reasoning)?,
                ));
            }
            items.push(overlay(provider_options, fields, &budget).await?);
        }
        MessageRecipe::Tool {
            content: results, ..
        } => {
            let mut cursor = results.open(0);
            while let Some(result) = cursor.next().await.map_err(error)? {
                tokio::task::yield_now().await;
                validate_options(&result.provider_options, &budget).await?;
                let output = match result.output {
                    ToolOutputRecipe::Text(value) | ToolOutputRecipe::ErrorText(value) => {
                        text(value)
                    }
                    ToolOutputRecipe::Json(value) | ToolOutputRecipe::ErrorJson(value) => {
                        vec![l(b"\""), F::JsonString(value), l(b"\"")]
                    }
                    ToolOutputRecipe::Content(parts) if options.multipart_tool_content => {
                        content(parts, language)?
                    }
                    ToolOutputRecipe::Content(parts) => textual_content(parts, language)?,
                };
                items.push(
                    overlay(
                        result.provider_options,
                        vec![
                            ("role", text(generated("tool"))),
                            ("tool_call_id", text(result.tool_call_id)),
                            ("content", output),
                        ],
                        &budget,
                    )
                    .await?,
                );
            }
        }
    }
    Ok(items
        .into_iter()
        .map(|fragments| SourceItem {
            fragments: fragments.into(),
            metadata: None,
            citation: None,
            owned_bytes: 0,
        })
        .collect())
}

async fn render_call(
    tool_call_id: TextSource,
    tool_name: TextSource,
    input: ToolInputRecipe,
    provider_options: Option<JsonSource>,
    metadata_namespace: &str,
    budget: &Arc<dyn SourceBudget>,
) -> Result<Vec<F>, ModelError> {
    let arguments = match input {
        ToolInputRecipe::Text(_) => text(generated("{}")),
        ToolInputRecipe::Json(value) => {
            vec![l(b"\""), F::JsonString(value), l(b"\"")]
        }
    };
    let function = source::object_with_fields(
        None,
        vec![("name", text(tool_name)), ("arguments", arguments)],
        budget.clone(),
    )
    .await
    .map_err(error)?;
    let mut finals = Vec::new();
    let extensions = if let Some(provider_options) = &provider_options {
        recipe::json::field(provider_options, &["openaiCompatible"], budget.clone())
            .await
            .map_err(error)?
            .map(|value| value.source)
    } else {
        None
    };
    if let Some(provider_options) = provider_options {
        let primary = recipe::json::field(
            &provider_options,
            &[metadata_namespace, "thoughtSignature"],
            budget.clone(),
        )
        .await
        .map_err(error)?;
        let signature = match primary {
            Some(value) if value.kind != recipe::json::JsonKind::Null => Some(value),
            _ => recipe::json::field(
                &provider_options,
                &["google", "thoughtSignature"],
                budget.clone(),
            )
            .await
            .map_err(error)?,
        };
        if let Some(signature) = signature {
            let include = match signature.kind {
                recipe::json::JsonKind::Null => false,
                recipe::json::JsonKind::Bool => {
                    recipe::json::bool_value(&signature.source, budget.clone())
                        .await
                        .map_err(error)?
                }
                recipe::json::JsonKind::String => {
                    !recipe::json::text_eq(&signature.text().map_err(error)?, "", budget.clone())
                        .await
                        .map_err(error)?
                }
                _ => true,
            };
            if include {
                let signature = if signature.kind == recipe::json::JsonKind::String {
                    text(signature.text().map_err(error)?)
                } else {
                    vec![l(b"\""), F::JsonString(signature.source), l(b"\"")]
                };
                let google = source::object_with_fields(
                    None,
                    vec![("thought_signature", signature)],
                    budget.clone(),
                )
                .await
                .map_err(error)?;
                let extra =
                    source::object_with_fields(None, vec![("google", google)], budget.clone())
                        .await
                        .map_err(error)?;
                finals.push(("extra_content", extra));
            }
        }
    }
    let call = source::object_with_overlay_and_final(
        vec![
            ("id", text(tool_call_id)),
            ("type", text(generated("function"))),
            ("function", function),
        ],
        extensions,
        finals,
        budget.clone(),
    )
    .await
    .map_err(error)?;

    Ok(call)
}

struct Parts<T>(Arc<[T]>);
struct PartCursor<T> {
    items: Arc<[T]>,
    index: usize,
}
impl<T: Clone + Send + Sync + 'static> RecipeSource<T> for Parts<T> {
    fn len(&self) -> usize {
        self.0.len()
    }
    fn open(&self, start: usize) -> Box<dyn RecipeCursor<T>> {
        Box::new(PartCursor {
            items: self.0.clone(),
            index: start,
        })
    }
}
impl<T: Clone + Send + Sync + 'static> RecipeCursor<T> for PartCursor<T> {
    fn next(&mut self) -> NextRecipe<'_, T> {
        Box::pin(async move {
            let item = self.items.get(self.index).cloned();
            self.index += usize::from(item.is_some());
            Ok(item)
        })
    }
}
fn parts_metadata<T>(count: usize) -> Result<usize, ModelError> {
    let mut total = 0usize;
    for layout in [
        std::alloc::Layout::new::<Parts<T>>(),
        std::alloc::Layout::array::<T>(count)
            .map_err(|error| ModelError::Adapter(error.to_string()))?,
    ] {
        let (layout, _) = std::alloc::Layout::new::<[usize; 2]>()
            .extend(layout)
            .map_err(|error| ModelError::Adapter(error.to_string()))?;
        total = total
            .checked_add(layout.pad_to_align().size())
            .ok_or_else(|| ModelError::Adapter("part metadata overflow".into()))?;
    }
    Ok(total)
}
fn parts<T: Clone + Send + Sync + 'static>(items: Vec<T>) -> Arc<dyn RecipeSource<T>> {
    Arc::new(Parts(items.into()))
}
fn combined(
    values: Vec<TextSource>,
    budget: Arc<dyn SourceBudget>,
    owned: &mut usize,
) -> Result<TextSource, ModelError> {
    let mut bytes = recipe::text::concat_metadata_bytes().map_err(error)?;
    for layout in [
        std::alloc::Layout::new::<Parts<TextSource>>(),
        std::alloc::Layout::array::<TextSource>(values.len())
            .map_err(|error| ModelError::Adapter(error.to_string()))?,
    ] {
        let (layout, _) = std::alloc::Layout::new::<[usize; 2]>()
            .extend(layout)
            .map_err(|error| ModelError::Adapter(error.to_string()))?;
        bytes = bytes
            .checked_add(layout.pad_to_align().size())
            .ok_or_else(|| ModelError::Adapter("generated text metadata size overflow".into()))?;
    }
    *owned = owned
        .checked_add(bytes)
        .ok_or_else(|| ModelError::Adapter("generated text metadata size overflow".into()))?;
    Ok(recipe::text::concat(parts(values), budget))
}
fn text_part(text: TextSource) -> ContentRecipe {
    ContentRecipe::Text {
        text,
        provider_options: None,
    }
}
async fn audio_fallback(
    part: ContentRecipe,
    language: Language,
    budget: Arc<dyn SourceBudget>,
    owned: &mut usize,
) -> Result<ContentRecipe, ModelError> {
    let ContentRecipe::Media {
        media,
        provider_options,
    } = part
    else {
        return Ok(part);
    };
    let kind = source::media_kind(&media.media_type, budget.clone())
        .await
        .map_err(error)?;
    if kind != source::MediaKind::AudioOther {
        return Ok(ContentRecipe::Media {
            media,
            provider_options,
        });
    }
    let length = match &media.bytes {
        SourceBytes::Inline(bytes) => bytes.len() as u64,
        SourceBytes::Source(source) => match source.len() {
            Some(length) => length,
            None => {
                let mut cursor = source.open(budget.clone());
                let mut count = 0u64;
                loop {
                    let buffer = budget.allocate(2048).await.map_err(error)?;
                    let read = cursor.read_chunk(buffer).await.map_err(error)?;
                    count += read.bytes_read as u64;
                    if read.eof {
                        break;
                    }
                    if read.bytes_read == 0 {
                        return Err(ModelError::Adapter("media source made no progress".into()));
                    }
                }
                count
            }
        },
    };
    let digits = length
        .div_ceil(3)
        .checked_mul(4)
        .ok_or_else(|| ModelError::Adapter("base64 media length overflow".into()))?
        .to_string();
    *owned = owned
        .checked_add(digits.capacity())
        .ok_or_else(|| ModelError::Adapter("generated text allocation size overflow".into()))?;
    let length = recipe::generated::text(digits);
    let (prefix, middle, suffix) = match language {
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
    Ok(text_part(combined(
        vec![
            generated(prefix),
            media.media_type,
            generated(middle),
            length,
            generated(suffix),
        ],
        budget,
        owned,
    )?))
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Projection {
    Generated,
    Captured,
}
pub(super) struct Compiler {
    options: PromptOptions,
    language: Language,
    media: Vec<ContentRecipe>,
    owned_bytes: usize,
    projection: Projection,
}
pub(super) struct MessageCursor<'a> {
    compiler: &'a mut Compiler,
    state: MessageState,
    budget: Arc<dyn SourceBudget>,
}
enum MessageState {
    Complete,
    One {
        message: MessageRecipe,
        last_tool: bool,
    },
    Tool {
        results: Box<dyn RecipeCursor<ToolResultRecipe>>,
        provider_options: Option<JsonSource>,
    },
    Ready(std::vec::IntoIter<SourceItem>),
}
impl MessageCursor<'_> {
    pub(super) async fn next(&mut self) -> Result<Option<SourceItem>, ModelError> {
        loop {
            tokio::task::yield_now().await;
            match &mut self.state {
                MessageState::Complete => return Ok(None),
                MessageState::Ready(items) => return Ok(items.next()),
                MessageState::One { .. } => {
                    let MessageState::One { message, last_tool } =
                        std::mem::replace(&mut self.state, MessageState::Complete)
                    else {
                        unreachable!()
                    };
                    self.state = MessageState::Ready(
                        self.compiler
                            .compile(message, last_tool, self.budget.clone())
                            .await?
                            .into_iter(),
                    );
                }
                MessageState::Tool {
                    results,
                    provider_options,
                } => {
                    let Some(result) = results.next().await.map_err(error)? else {
                        self.state = MessageState::Complete;
                        return Ok(None);
                    };
                    let mut items = self
                        .compiler
                        .compile(
                            MessageRecipe::Tool {
                                content: parts(vec![result]),
                                provider_options: provider_options.clone(),
                            },
                            true,
                            self.budget.clone(),
                        )
                        .await?
                        .into_iter();
                    if let Some(item) = items.next() {
                        debug_assert!(
                            items.next().is_none(),
                            "captured Tool result emits at most one item"
                        );
                        return Ok(Some(item));
                    }
                }
            }
        }
    }
}
impl Compiler {
    pub(super) fn open(
        &mut self,
        message: MessageRecipe,
        last_tool: bool,
        budget: Arc<dyn SourceBudget>,
    ) -> MessageCursor<'_> {
        let state = match message {
            MessageRecipe::Tool {
                content,
                provider_options,
            } if self.projection == Projection::Captured => MessageState::Tool {
                results: content.open(0),
                provider_options,
            },
            message => MessageState::One { message, last_tool },
        };
        MessageCursor {
            compiler: self,
            state,
            budget,
        }
    }
    pub(super) fn new(options: &PromptOptions, language: Language) -> Self {
        Self {
            options: options.clone(),
            language,
            media: Vec::new(),
            owned_bytes: 0,
            projection: Projection::Generated,
        }
    }
    pub(super) fn captured(options: &PromptOptions, language: Language) -> Self {
        Self {
            projection: Projection::Captured,
            ..Self::new(options, language)
        }
    }
    async fn flush(
        &mut self,
        budget: Arc<dyn SourceBudget>,
        items: &mut Vec<SourceItem>,
    ) -> Result<(), ModelError> {
        if !self.media.is_empty() {
            self.owned_bytes = self
                .owned_bytes
                .checked_add(parts_metadata::<ContentRecipe>(self.media.len())?)
                .ok_or_else(|| ModelError::Adapter("deferred media metadata overflow".into()))?;
            items.extend(
                encode(
                    MessageRecipe::User {
                        content: parts(std::mem::take(&mut self.media)),
                        provider_options: None,
                    },
                    &self.options,
                    self.language,
                    budget,
                )
                .await?,
            );
        }
        Ok(())
    }
    pub(super) async fn compile(
        &mut self,
        message: MessageRecipe,
        last_tool: bool,
        budget: Arc<dyn SourceBudget>,
    ) -> Result<Vec<SourceItem>, ModelError> {
        let before = self.owned_bytes;
        let mut items = self.compile_items(message, last_tool, budget).await?;
        if let Some(item) = items.first_mut() {
            item.owned_bytes = item
                .owned_bytes
                .checked_add(self.owned_bytes - before)
                .ok_or_else(|| ModelError::Adapter("wire owned metadata size overflow".into()))?;
        }
        Ok(items)
    }
    async fn compile_items(
        &mut self,
        message: MessageRecipe,
        last_tool: bool,
        budget: Arc<dyn SourceBudget>,
    ) -> Result<Vec<SourceItem>, ModelError> {
        let mut items = Vec::new();
        let message = if let MessageRecipe::User {
            content,
            provider_options,
        } = message
        {
            if content.len() == 1 {
                let mut cursor = content.open(0);
                let part = cursor
                    .next()
                    .await
                    .map_err(error)?
                    .expect("single content recipe");
                let was_media = matches!(part, ContentRecipe::Media { .. });
                let adapted =
                    audio_fallback(part, self.language, budget.clone(), &mut self.owned_bytes)
                        .await?;
                if was_media && matches!(adapted, ContentRecipe::Text { .. }) {
                    MessageRecipe::User {
                        content: parts(vec![adapted]),
                        provider_options,
                    }
                } else {
                    MessageRecipe::User {
                        content,
                        provider_options,
                    }
                }
            } else {
                MessageRecipe::User {
                    content,
                    provider_options,
                }
            }
        } else {
            message
        };
        let MessageRecipe::Tool {
            content,
            provider_options,
        } = message
        else {
            return encode(message, &self.options, self.language, budget).await;
        };
        let mut cursor = content.open(0);
        while let Some(mut result) = cursor.next().await.map_err(error)? {
            tokio::task::yield_now().await;
            if result.kind == ToolResultKind::Notification {
                if let ToolOutputRecipe::Text(value) = result.output {
                    self.flush(budget.clone(), &mut items).await?;
                    let (prefix, suffix) = match self.language {
                        Language::En => ("[Notification from exec ", "]\n"),
                        Language::ZhCn => ("[来自 exec ", " 的通知]\n"),
                        Language::ZhTw => ("[來自 exec ", " 的通知]\n"),
                    };
                    let text = combined(
                        vec![
                            generated(prefix),
                            result.tool_call_id,
                            generated(suffix),
                            value,
                        ],
                        budget.clone(),
                        &mut self.owned_bytes,
                    )?;
                    items.extend(
                        encode(
                            MessageRecipe::User {
                                content: parts(vec![text_part(text)]),
                                provider_options: None,
                            },
                            &self.options,
                            self.language,
                            budget.clone(),
                        )
                        .await?,
                    );
                }
                continue;
            }
            if self.projection == Projection::Generated
                && let ToolOutputRecipe::Content(content) = result.output
            {
                let mut projected = Vec::new();
                let mut cursor = content.open(0);
                let mut labelled = false;
                while let Some(part) = cursor.next().await.map_err(error)? {
                    tokio::task::yield_now().await;
                    let part =
                        audio_fallback(part, self.language, budget.clone(), &mut self.owned_bytes)
                            .await?;
                    if let ContentRecipe::Media {
                        media,
                        provider_options: media_options,
                    } = part
                    {
                        let kind = source::media_kind(&media.media_type, budget.clone())
                            .await
                            .map_err(error)?;
                        if self.projection == Projection::Generated
                            && (kind == source::MediaKind::Image
                                || matches!(
                                    kind,
                                    source::MediaKind::AudioWav
                                        | source::MediaKind::AudioMp3
                                        | source::MediaKind::AudioOther
                                ))
                        {
                            let audio = matches!(
                                kind,
                                source::MediaKind::AudioWav
                                    | source::MediaKind::AudioMp3
                                    | source::MediaKind::AudioOther
                            );
                            let kind = match (self.language, audio) {
                                (Language::En, true) => "Audio",
                                (Language::En, false) => "Image",
                                (Language::ZhCn, true) => "音频",
                                (Language::ZhCn, false) => "图像",
                                (Language::ZhTw, true) => "音訊",
                                (Language::ZhTw, false) => "影像",
                            };
                            if !labelled {
                                let label = match self.language {
                                    Language::En => combined(
                                        vec![
                                            generated(kind),
                                            generated(" from tool "),
                                            result.tool_name.clone(),
                                            generated(" ("),
                                            result.tool_call_id.clone(),
                                            generated("):"),
                                        ],
                                        budget.clone(),
                                        &mut self.owned_bytes,
                                    )?,
                                    Language::ZhCn => combined(
                                        vec![
                                            generated("来自工具 "),
                                            result.tool_name.clone(),
                                            generated("（"),
                                            result.tool_call_id.clone(),
                                            generated("）的"),
                                            generated(kind),
                                            generated("："),
                                        ],
                                        budget.clone(),
                                        &mut self.owned_bytes,
                                    )?,
                                    Language::ZhTw => combined(
                                        vec![
                                            generated("來自工具 "),
                                            result.tool_name.clone(),
                                            generated("（"),
                                            result.tool_call_id.clone(),
                                            generated("）的"),
                                            generated(kind),
                                            generated("："),
                                        ],
                                        budget.clone(),
                                        &mut self.owned_bytes,
                                    )?,
                                };
                                self.media.push(text_part(label));
                                labelled = true;
                            }
                            self.media.push(ContentRecipe::Media {
                                media,
                                provider_options: media_options,
                            });
                            let suffix = match self.language {
                                Language::En => " supplied below.",
                                Language::ZhCn => "见下方。",
                                Language::ZhTw => "見下方。",
                            };
                            projected.push(text_part(combined(
                                vec![generated(kind), generated(suffix)],
                                budget.clone(),
                                &mut self.owned_bytes,
                            )?));
                        } else {
                            projected.push(ContentRecipe::Media {
                                media,
                                provider_options: media_options,
                            });
                        }
                    } else {
                        projected.push(part);
                    }
                }
                self.owned_bytes = self
                    .owned_bytes
                    .checked_add(parts_metadata::<ContentRecipe>(projected.len())?)
                    .ok_or_else(|| {
                        ModelError::Adapter("projected content metadata overflow".into())
                    })?;
                result.output = ToolOutputRecipe::Content(parts(projected));
            }
            items.extend(
                encode(
                    MessageRecipe::Tool {
                        content: parts(vec![result]),
                        provider_options: provider_options.clone(),
                    },
                    &self.options,
                    self.language,
                    budget.clone(),
                )
                .await?,
            );
        }
        if last_tool {
            self.flush(budget, &mut items).await?;
        }
        Ok(items)
    }
}
