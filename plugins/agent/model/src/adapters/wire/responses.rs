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

//! Responses item recipes; payloads stay in their captured byte sources.

use super::source::{self, SourceFragment as F, SourceItem};
use crate::ModelError;
use bytes::Bytes;
use maka_agent_facts::{
    language::Language,
    model::{
        PlaintextReasoningReplay, PlaintextResponses,
        prompt_source::source::{self as recipe, *},
    },
};
use std::sync::Arc;

mod replay;

fn literal(bytes: &'static [u8]) -> F {
    F::literal(bytes)
}
fn text(value: TextSource) -> Vec<F> {
    source::quoted(value)
}
fn generated(value: &'static str) -> TextSource {
    TextSource {
        bytes: SourceBytes::Inline(Bytes::from_static(value.as_bytes())),
        encoding: TextEncoding::Utf8,
    }
}
fn item(fragments: Vec<F>) -> SourceItem {
    SourceItem {
        fragments: fragments.into(),
        metadata: None,
        owned_bytes: 0,
    }
}
fn failure(error: std::io::Error) -> ModelError {
    ModelError::Adapter(error.to_string())
}
async fn field(
    options: &Option<JsonSource>,
    path: &[&str],
    budget: &Arc<dyn SourceBudget>,
) -> Result<Option<recipe::json::JsonValue>, ModelError> {
    match options {
        Some(source) => recipe::json::field(source, path, budget.clone())
            .await
            .map_err(failure),
        None => Ok(None),
    }
}
async fn string_field(
    options: &Option<JsonSource>,
    path: &[&str],
    budget: &Arc<dyn SourceBudget>,
) -> Result<Option<recipe::json::JsonValue>, ModelError> {
    Ok(field(options, path, budget)
        .await?
        .filter(|value| value.kind == recipe::json::JsonKind::String))
}
async fn replay_fields(
    template: &JsonSource,
    expected: &str,
    budget: &Arc<dyn SourceBudget>,
) -> Result<JsonSource, ModelError> {
    let fields = recipe::json::fields(template, &["version", "fields"], budget.clone())
        .await
        .map_err(failure)?;
    let mut fields = fields.into_iter();
    let version = fields
        .next()
        .flatten()
        .ok_or_else(|| ModelError::Adapter("invalid accepted Responses item metadata".into()))?;
    if recipe::json::u64_value(&version.source, budget.clone())
        .await
        .map_err(failure)?
        != 1
    {
        return Err(ModelError::Adapter(
            "invalid accepted Responses item metadata".into(),
        ));
    }
    let fields = fields
        .next()
        .flatten()
        .filter(|value| value.kind == recipe::json::JsonKind::Object)
        .ok_or_else(|| ModelError::Adapter("invalid accepted Responses item metadata".into()))?;
    let kind = recipe::json::field(&fields.source, &["type"], budget.clone())
        .await
        .map_err(failure)?
        .ok_or_else(|| ModelError::Adapter("accepted Responses item kind missing".into()))?;
    if !recipe::json::text_eq(&kind.text().map_err(failure)?, expected, budget.clone())
        .await
        .map_err(failure)?
    {
        return Err(ModelError::Adapter(
            "accepted Responses item kind changed".into(),
        ));
    }
    Ok(fields.source)
}
async fn object(
    fields: Vec<(&'static str, Vec<F>)>,
    budget: &Arc<dyn SourceBudget>,
) -> Result<Vec<F>, ModelError> {
    source::object_with_fields(None, fields, budget.clone())
        .await
        .map_err(failure)
}
async fn output(
    output: ToolOutputRecipe,
    budget: &Arc<dyn SourceBudget>,
) -> Result<Vec<F>, ModelError> {
    match output {
        ToolOutputRecipe::Text(value) | ToolOutputRecipe::ErrorText(value) => Ok(text(value)),
        ToolOutputRecipe::Json(value) | ToolOutputRecipe::ErrorJson(value) => {
            Ok(vec![literal(b"\""), F::JsonString(value), literal(b"\"")])
        }
        ToolOutputRecipe::Content(parts) => content(parts, budget).await,
    }
}
async fn media(media: MediaSource, budget: &Arc<dyn SourceBudget>) -> Result<Vec<F>, ModelError> {
    let kind = source::media_kind(&media.media_type, budget.clone())
        .await
        .map_err(failure)?;
    let (kind, key) = if kind == source::MediaKind::Image {
        ("input_image", "image_url")
    } else if matches!(
        kind,
        source::MediaKind::AudioWav | source::MediaKind::AudioMp3 | source::MediaKind::AudioOther
    ) {
        ("input_audio", "audio_url")
    } else if kind == source::MediaKind::Pdf {
        ("input_file", "file_data")
    } else {
        return Err(ModelError::Adapter(
            "Responses does not support this file media type".into(),
        ));
    };
    let data = vec![
        literal(b"\"data:"),
        F::Text(media.media_type),
        literal(b";base64,"),
        F::Base64(media.bytes),
        literal(b"\""),
    ];
    let mut fields = vec![("type", text(generated(kind))), (key, data)];
    if kind == "input_image" {
        fields.push((
            "detail",
            text(media.detail.unwrap_or_else(|| generated("auto"))),
        ));
    }
    if kind == "input_file" {
        fields.push(("filename", text(generated("document.pdf"))));
    }
    object(fields, budget).await
}
pub(in crate::adapters::wire) async fn render_content_part(
    part: ContentRecipe,
    budget: Arc<dyn SourceBudget>,
) -> Result<Vec<F>, ModelError> {
    match part {
        ContentRecipe::Text { text: value, .. } => {
            object(
                vec![
                    ("type", text(generated("input_text"))),
                    ("text", text(value)),
                ],
                &budget,
            )
            .await
        }
        ContentRecipe::Media { media: value, .. } => media(value, &budget).await,
    }
}
async fn content(
    parts: Arc<dyn RecipeSource<ContentRecipe>>,
    _budget: &Arc<dyn SourceBudget>,
) -> Result<Vec<F>, ModelError> {
    source::responses_content_array(parts).map_err(failure)
}
async fn message(
    role: &'static str,
    parts: Vec<F>,
    budget: &Arc<dyn SourceBudget>,
) -> Result<Vec<F>, ModelError> {
    object(
        vec![("role", text(generated(role))), ("content", parts)],
        budget,
    )
    .await
}
async fn assistant_text(
    value: TextSource,
    budget: &Arc<dyn SourceBudget>,
) -> Result<Vec<F>, ModelError> {
    let mut parts = vec![literal(b"[")];
    parts.extend(
        object(
            vec![
                ("type", text(generated("output_text"))),
                ("text", text(value)),
            ],
            budget,
        )
        .await?,
    );
    parts.push(literal(b"]"));
    message("assistant", parts, budget).await
}

async fn encode_message(
    message_recipe: MessageRecipe,
    language: Language,
    plaintext: Option<PlaintextResponses>,
    options: &serde_json::Value,
    budget: Arc<dyn SourceBudget>,
) -> Result<Vec<SourceItem>, ModelError> {
    let namespace = if plaintext.is_some() {
        "openResponses"
    } else {
        "openai"
    };
    let store = options[namespace]["store"] != false;
    let mut items = Vec::new();
    match message_recipe {
        MessageRecipe::System { content, .. } => {
            items.push(item(message("system", text(content), &budget).await?))
        }
        MessageRecipe::User { content: parts, .. } => items.push(item(
            message("user", content(parts, &budget).await?, &budget).await?,
        )),
        MessageRecipe::Assistant { content: parts, .. } => {
            let mut cursor = parts.open(0);
            while let Some(part) = cursor.next().await.map_err(failure)? {
                tokio::task::yield_now().await;
                match part {
                    AssistantRecipe::Text {
                        text: value,
                        provider_options,
                    } => {
                        if plaintext.is_none()
                            && let Some(replay) =
                                field(&provider_options, &["openai", "responsesReplay"], &budget)
                                    .await?
                        {
                            items.push(item(
                                replay_text(
                                    replay.source,
                                    value,
                                    "message",
                                    &provider_options,
                                    &budget,
                                )
                                .await?,
                            ));
                            continue;
                        }
                        items.push(item(assistant_text(value, &budget).await?));
                    }
                    AssistantRecipe::Reasoning {
                        text: value,
                        provider_options,
                    } => {
                        if plaintext.is_some_and(|contract| {
                            contract.reasoning_replay == PlaintextReasoningReplay::PlaintextContent
                        }) {
                            if source::escaped_equals(&value, b"", budget.clone())
                                .await
                                .map_err(failure)?
                            {
                                continue;
                            }
                            let mut body = vec![literal(b"[")];
                            body.extend(
                                object(
                                    vec![
                                        ("type", text(generated("reasoning_text"))),
                                        ("text", text(value)),
                                    ],
                                    &budget,
                                )
                                .await?,
                            );
                            body.push(literal(b"]"));
                            items.push(item(
                                object(
                                    vec![
                                        ("type", text(generated("reasoning"))),
                                        ("summary", vec![literal(b"[]")]),
                                        ("content", body),
                                    ],
                                    &budget,
                                )
                                .await?,
                            ));
                        } else if plaintext.is_some() {
                            if let Some(summary) =
                                field(&provider_options, &[namespace, "reasoningSummary"], &budget)
                                    .await?
                                    .filter(|value| value.kind == recipe::json::JsonKind::Array)
                            {
                                let mut fields = vec![("type", text(generated("reasoning")))];
                                if let Some(id) =
                                    string_field(&provider_options, &[namespace, "itemId"], &budget)
                                        .await?
                                {
                                    fields.push(("id", vec![F::Raw(id.source)]));
                                }
                                fields.push(("summary", vec![F::Raw(summary.source)]));
                                items.push(item(object(fields, &budget).await?));
                            }
                        } else if let Some(replay) =
                            field(&provider_options, &["openai", "responsesReplay"], &budget)
                                .await?
                        {
                            items.push(item(
                                replay_text(
                                    replay.source,
                                    value,
                                    "reasoning",
                                    &provider_options,
                                    &budget,
                                )
                                .await?,
                            ));
                        } else if let Some(encrypted) = string_field(
                            &provider_options,
                            &[namespace, "reasoningEncryptedContent"],
                            &budget,
                        )
                        .await?
                        {
                            let mut fields = vec![("type", text(generated("reasoning")))];
                            if let Some(id) =
                                string_field(&provider_options, &[namespace, "itemId"], &budget)
                                    .await?
                            {
                                fields.push(("id", vec![F::Raw(id.source)]));
                            }
                            fields.push(("summary", vec![literal(b"[]")]));
                            fields.push(("encrypted_content", vec![F::Raw(encrypted.source)]));
                            items.push(item(object(fields, &budget).await?));
                        } else if store
                            && let Some(id) =
                                string_field(&provider_options, &[namespace, "itemId"], &budget)
                                    .await?
                        {
                            items.push(item(
                                object(
                                    vec![
                                        ("type", text(generated("item_reference"))),
                                        ("id", vec![F::Raw(id.source)]),
                                    ],
                                    &budget,
                                )
                                .await?,
                            ));
                        }
                    }
                    AssistantRecipe::ToolCall {
                        tool_call_id,
                        tool_name,
                        input,
                        kind,
                        provider_executed,
                        provider_options,
                    } => {
                        if provider_executed == Some(true) {
                            if store
                                && let Some(id) =
                                    string_field(&provider_options, &[namespace, "itemId"], &budget)
                                        .await?
                            {
                                items.push(item(
                                    object(
                                        vec![
                                            ("type", text(generated("item_reference"))),
                                            ("id", vec![F::Raw(id.source)]),
                                        ],
                                        &budget,
                                    )
                                    .await?,
                                ));
                            }
                            continue;
                        }
                        let custom_source = kind == ToolCallKind::Custom
                            && match &input {
                                ToolInputRecipe::Json(value) => {
                                    recipe::json::kind(value, budget.clone())
                                        .await
                                        .map_err(failure)?
                                        == recipe::json::JsonKind::String
                                }
                                _ => false,
                            };
                        let custom = custom_source && plaintext.is_none();
                        let kind = if custom {
                            "custom_tool_call"
                        } else {
                            "function_call"
                        };
                        let tool_name =
                            if recipe::json::text_eq(&tool_name, "tool_search", budget.clone())
                                .await
                                .map_err(failure)?
                            {
                                generated("maka_tool_search")
                            } else {
                                tool_name
                            };
                        let payload = match input {
                            ToolInputRecipe::Text(value) => text(value),
                            ToolInputRecipe::Json(value) if custom => text(
                                recipe::json::JsonValue {
                                    source: value,
                                    kind: recipe::json::JsonKind::String,
                                }
                                .text()
                                .map_err(failure)?,
                            ),
                            ToolInputRecipe::Json(value)
                                if custom_source
                                    && plaintext.is_some()
                                    && source::escaped_equals(
                                        &tool_name,
                                        b"exec",
                                        budget.clone(),
                                    )
                                    .await
                                    .map_err(failure)?
                                    && recipe::json::kind(&value, budget.clone())
                                        .await
                                        .map_err(failure)?
                                        == recipe::json::JsonKind::String =>
                            {
                                vec![
                                    literal(b"\"{\\\"code\\\":"),
                                    F::JsonString(value),
                                    literal(b"}\""),
                                ]
                            }
                            ToolInputRecipe::Json(value) => {
                                vec![literal(b"\""), F::JsonString(value), literal(b"\"")]
                            }
                        };
                        let fields = vec![
                            ("type", text(generated(kind))),
                            ("call_id", text(tool_call_id)),
                            ("name", text(tool_name)),
                            (if custom { "input" } else { "arguments" }, payload),
                        ];
                        let replay = if plaintext.is_none() {
                            field(&provider_options, &["openai", "responsesReplay"], &budget)
                                .await?
                        } else {
                            None
                        };
                        let replay = match replay {
                            Some(value) => Some(replay_fields(&value.source, kind, &budget).await?),
                            None => None,
                        };
                        items.push(item(
                            source::object_with_fields(replay, fields, budget.clone())
                                .await
                                .map_err(failure)?,
                        ));
                    }
                    AssistantRecipe::ToolResult(result) => {
                        if plaintext.is_none()
                            && !store
                            && let Some(replay) = field(
                                &result.provider_options,
                                &["openai", "responsesReplay"],
                                &budget,
                            )
                            .await?
                        {
                            let replay =
                                replay_fields(&replay.source, "web_search_call", &budget).await?;
                            let value = match result.output {
                                ToolOutputRecipe::Json(value)
                                | ToolOutputRecipe::ErrorJson(value) => value,
                                _ => {
                                    return Err(ModelError::Adapter(
                                        "accepted Responses provider result is not JSON".into(),
                                    ));
                                }
                            };
                            let mut additions = Vec::new();
                            if let Some(action) = field(
                                &result.provider_options,
                                &["openai", "responsesReplay", "action"],
                                &budget,
                            )
                            .await?
                                && action.kind == recipe::json::JsonKind::Bool
                                && recipe::json::bool_value(&action.source, budget.clone())
                                    .await
                                    .map_err(failure)?
                            {
                                additions.push((
                                    "action",
                                    recipe::json::field(&value, &["action"], budget.clone())
                                        .await
                                        .map_err(failure)?
                                        .map(|value| vec![F::Raw(value.source)])
                                        .unwrap_or_else(|| vec![literal(b"null")]),
                                ));
                            }
                            items.push(item(
                                source::object_with_fields(Some(replay), additions, budget.clone())
                                    .await
                                    .map_err(failure)?,
                            ));
                        }
                    }
                }
            }
        }
        MessageRecipe::Tool {
            content: results, ..
        } => {
            let mut cursor = results.open(0);
            while let Some(result) = cursor.next().await.map_err(failure)? {
                tokio::task::yield_now().await;
                let custom = result.call_kind == ToolCallKind::Custom && plaintext.is_none();
                if result.kind == ToolResultKind::Notification && !custom {
                    if let ToolOutputRecipe::Text(value) = result.output {
                        let mut notification = vec![literal(b"\"")];
                        notification.extend(
                            text(generated(match language {
                                Language::En => "[Notification from exec ",
                                Language::ZhCn => "[来自 exec ",
                                Language::ZhTw => "[來自 exec ",
                            }))
                            .into_iter()
                            .skip(1)
                            .take(1),
                        );
                        notification.push(F::Text(result.tool_call_id));
                        notification.push(F::Text(generated(match language {
                            Language::En => "]\n",
                            Language::ZhCn => " 的通知]\n",
                            Language::ZhTw => " 的通知]\n",
                        })));
                        notification.push(F::Text(value));
                        notification.push(literal(b"\""));
                        let mut parts = vec![literal(b"[")];
                        parts.extend(
                            object(
                                vec![
                                    ("type", text(generated("input_text"))),
                                    ("text", notification),
                                ],
                                &budget,
                            )
                            .await?,
                        );
                        parts.push(literal(b"]"));
                        items.push(item(message("user", parts, &budget).await?));
                    }
                    continue;
                }
                items.push(item(
                    object(
                        vec![
                            (
                                "type",
                                text(generated(if custom {
                                    "custom_tool_call_output"
                                } else {
                                    "function_call_output"
                                })),
                            ),
                            ("call_id", text(result.tool_call_id)),
                            ("output", output(result.output, &budget).await?),
                        ],
                        &budget,
                    )
                    .await?,
                ));
            }
        }
    }
    Ok(items)
}

struct Single<T>(T);
struct SingleCursor<T>(Option<T>);
impl<T: Clone + Send + Sync + 'static> RecipeSource<T> for Single<T> {
    fn len(&self) -> usize {
        1
    }
    fn open(&self, start: usize) -> Box<dyn RecipeCursor<T>> {
        Box::new(SingleCursor((start == 0).then(|| self.0.clone())))
    }
}
impl<T: Send + 'static> RecipeCursor<T> for SingleCursor<T> {
    fn next(&mut self) -> NextRecipe<'_, T> {
        Box::pin(async move { Ok(self.0.take()) })
    }
}
enum MessageState {
    One(Option<MessageRecipe>),
    Assistant {
        parts: Box<dyn RecipeCursor<AssistantRecipe>>,
        options: Option<JsonSource>,
    },
    Tool {
        parts: Box<dyn RecipeCursor<ToolResultRecipe>>,
        options: Option<JsonSource>,
    },
}
pub(super) struct MessageCursor<'cfg> {
    state: MessageState,
    language: Language,
    plaintext: Option<PlaintextResponses>,
    options: &'cfg serde_json::Value,
    budget: Arc<dyn SourceBudget>,
    pending: std::collections::VecDeque<SourceItem>,
}
pub(super) fn open(
    message: MessageRecipe,
    language: Language,
    plaintext: Option<PlaintextResponses>,
    options: &serde_json::Value,
    budget: Arc<dyn SourceBudget>,
) -> MessageCursor<'_> {
    let state = match message {
        MessageRecipe::Assistant {
            content,
            provider_options,
        } => MessageState::Assistant {
            parts: content.open(0),
            options: provider_options,
        },
        MessageRecipe::Tool {
            content,
            provider_options,
        } => MessageState::Tool {
            parts: content.open(0),
            options: provider_options,
        },
        message => MessageState::One(Some(message)),
    };
    MessageCursor {
        state,
        language,
        plaintext,
        options,
        budget,
        pending: std::collections::VecDeque::new(),
    }
}
impl MessageCursor<'_> {
    pub(super) async fn next(&mut self) -> Result<Option<SourceItem>, ModelError> {
        loop {
            if let Some(item) = self.pending.pop_front() {
                return Ok(Some(item));
            }
            let message =
                match &mut self.state {
                    MessageState::One(message) => message.take(),
                    MessageState::Assistant { parts, options } => parts
                        .next()
                        .await
                        .map_err(failure)?
                        .map(|part| MessageRecipe::Assistant {
                            content: Arc::new(Single(part)),
                            provider_options: options.clone(),
                        }),
                    MessageState::Tool { parts, options } => parts
                        .next()
                        .await
                        .map_err(failure)?
                        .map(|part| MessageRecipe::Tool {
                            content: Arc::new(Single(part)),
                            provider_options: options.clone(),
                        }),
                };
            let Some(message) = message else {
                return Ok(None);
            };
            self.pending.extend(
                encode_message(
                    message,
                    self.language,
                    self.plaintext,
                    self.options,
                    self.budget.clone(),
                )
                .await?,
            );
        }
    }
}
#[cfg(test)]
async fn compile(
    message: MessageRecipe,
    language: Language,
    plaintext: Option<PlaintextResponses>,
    options: &serde_json::Value,
    budget: Arc<dyn SourceBudget>,
) -> Result<Vec<SourceItem>, ModelError> {
    let mut cursor = open(message, language, plaintext, options, budget);
    let mut items = Vec::new();
    while let Some(item) = cursor.next().await? {
        items.push(item)
    }
    Ok(items)
}

async fn replay_text(
    template: JsonSource,
    value: TextSource,
    kind: &'static str,
    provider_options: &Option<JsonSource>,
    budget: &Arc<dyn SourceBudget>,
) -> Result<Vec<F>, ModelError> {
    use recipe::json;
    let values = json::fields(
        &template,
        &["version", "fields", "textField", "parts", "encrypted"],
        budget.clone(),
    )
    .await
    .map_err(failure)?;
    let mut values = values.into_iter();
    let version = values.next().flatten();
    let fields = values.next().flatten();
    let text_field = values.next().flatten();
    let parts = values.next().flatten();
    let encrypted = values.next().flatten();
    let mut additions = Vec::new();
    if let Some(encrypted) = encrypted
        && encrypted.kind == recipe::json::JsonKind::Bool
        && json::bool_value(&encrypted.source, budget.clone())
            .await
            .map_err(failure)?
    {
        let value = field(
            provider_options,
            &["openai", "reasoningEncryptedContent"],
            budget,
        )
        .await?;
        additions.push((
            "encrypted_content",
            value
                .map(|value| vec![F::Raw(value.source)])
                .unwrap_or_else(|| vec![literal(b"null")]),
        ));
    }
    if version.is_none()
        || json::u64_value(&version.expect("checked").source, budget.clone())
            .await
            .map_err(failure)?
            != 1
    {
        return Err(ModelError::Adapter(
            "invalid accepted Responses item metadata".into(),
        ));
    }
    let fields =
        fields.ok_or_else(|| ModelError::Adapter("accepted Responses fields missing".into()))?;
    let encoded_kind = json::field(&fields.source, &["type"], budget.clone())
        .await
        .map_err(failure)?
        .ok_or_else(|| ModelError::Adapter("accepted Responses type missing".into()))?;
    if !json::text_eq(&encoded_kind.text().map_err(failure)?, kind, budget.clone())
        .await
        .map_err(failure)?
    {
        return Err(ModelError::Adapter(
            "accepted Responses item kind changed".into(),
        ));
    }
    let Some(text_field) = text_field else {
        if !source::escaped_equals(&value, b"", budget.clone())
            .await
            .map_err(failure)?
        {
            return Err(ModelError::Adapter(
                "accepted Responses item omitted its canonical text".into(),
            ));
        }
        return source::object_with_fields(Some(fields.source), additions, budget.clone())
            .await
            .map_err(failure);
    };
    let expected = if kind == "message" {
        "content"
    } else {
        "summary"
    };
    if !json::text_eq(
        &text_field.text().map_err(failure)?,
        expected,
        budget.clone(),
    )
    .await
    .map_err(failure)?
    {
        return Err(ModelError::Adapter(
            "invalid accepted Responses text field".into(),
        ));
    }
    let parts =
        parts.ok_or_else(|| ModelError::Adapter("accepted Responses parts missing".into()))?;
    let content = vec![replay::content(value, parts.source).map_err(failure)?];
    additions.insert(0, (expected, content));
    source::object_with_fields(Some(fields.source), additions, budget.clone())
        .await
        .map_err(failure)
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::model::{
        ToolInput,
        prompt::{AssistantPart, ContentPart, FileData, Message, ToolOutput},
    };
    use serde_json::json;
    struct Budget;
    impl SourceBudget for Budget {
        fn allocate(&self, minimum: usize) -> Allocate<'_> {
            Box::pin(async move { Ok(ChargedBuffer::new(vec![0; minimum], ())) })
        }
    }
    async fn encode_items(items: Vec<SourceItem>, budget: Arc<dyn SourceBudget>) -> Vec<Vec<u8>> {
        let mut result = Vec::new();
        for item in items {
            let mut bytes = Vec::new();
            for fragment in item.fragments.iter() {
                let mut cursor = source::FragmentCursor::new(fragment.clone());
                while let Some(chunk) = cursor.next(budget.clone()).await.expect("fixture fragment")
                {
                    bytes.extend_from_slice(&chunk);
                }
            }
            result.push(bytes);
        }
        result
    }
    #[tokio::test]
    async fn source_items_preserve_responses_and_openresponses_owned_bytes() {
        let media = |mime: &str| ContentPart::File {
            data: FileData::Data("AQIDBAU=".into()),
            media_type: mime.into(),
            provider_options: Some(json!({"openai":{"imageDetail":"high"}})),
        };
        let messages = vec![
            Message::System {
                content: "system\n原文".into(),
                provider_options: None,
            },
            Message::User {
                content: vec![
                    ContentPart::text("user\""),
                    media("image/png"),
                    media("audio/ogg"),
                    media("application/pdf"),
                ],
                provider_options: None,
            },
            Message::Assistant {
                content: vec![
                    AssistantPart::Text {
                        text: "first 🙂第二".into(),
                        provider_options: Some(
                            json!({"openai":{"responsesReplay":{"version":1,"fields":{"type":"message","id":"msg","role":"assistant","status":"completed","phase":"commentary"},"textField":"content","parts":[{"bytes":10,"key":"text","fields":{"type":"output_text","annotations":[{"type":"url_citation","url":"https://example.test"}]}},{"bytes":6,"key":"text","fields":{"type":"output_text","annotations":[]}}]}}}),
                        ),
                    },
                    AssistantPart::Reasoning {
                        text: "Check 🙂".into(),
                        provider_options: Some(
                            json!({"openai":{"itemId":"reason","reasoningEncryptedContent":"opaque\\\"","responsesReplay":{"version":1,"fields":{"type":"reasoning","id":"reason"},"textField":"summary","parts":[{"bytes":10,"key":"text","fields":{"type":"summary_text"}}],"encrypted":true}},"openResponses":{"itemId":"reason","reasoningSummary":[{"type":"summary_text","text":"Check 🙂"}]}}),
                        ),
                    },
                    AssistantPart::ToolCall {
                        tool_call_id: "function-id".into(),
                        tool_name: "tool_search".into(),
                        input: ToolInput::Json(json!({"b":"\\\"\n","a":[1,true]})),
                        provider_executed: None,
                        provider_options: None,
                    },
                    AssistantPart::ToolCall {
                        tool_call_id: "custom-id".into(),
                        tool_name: "exec".into(),
                        input: ToolInput::Json(json!("print(\"🙂\")")),
                        provider_executed: None,
                        provider_options: Some(json!({"openai":{"toolKind":"custom"}})),
                    },
                    AssistantPart::ToolResult {
                        tool_call_id: "web-id".into(),
                        tool_name: "search".into(),
                        output: ToolOutput::Json(
                            json!({"action":{"type":"search","query":"原文"},"ignored":true}),
                        ),
                        provider_options: Some(
                            json!({"openai":{"responsesReplay":{"version":1,"fields":{"type":"web_search_call","id":"ws","status":"completed"},"action":true}}}),
                        ),
                    },
                ],
                provider_options: None,
            },
            Message::tool(
                "function-id",
                "read",
                ToolOutput::Json(json!({"b":"原文\\","a":2})),
            ),
            Message::notification("exec-id", "worker\ntext"),
        ];
        let contracts = [
            None,
            Some(PlaintextResponses {
                reasoning_replay: PlaintextReasoningReplay::PlaintextContent,
                compatibility: None,
            }),
            Some(PlaintextResponses {
                reasoning_replay: PlaintextReasoningReplay::PlaintextSummary,
                compatibility: None,
            }),
        ];
        for plaintext in contracts {
            for language in [Language::En, Language::ZhCn, Language::ZhTw] {
                let options = json!({"openai":{"store":false},"openResponses":{"store":false}});
                let budget: Arc<dyn SourceBudget> = Arc::new(Budget);
                for message in &messages {
                    let expected = crate::adapters::responses::request::encode_message(
                        message, language, plaintext, &options,
                    )
                    .expect("owned Responses codec");
                    let actual = encode_items(
                        compile(
                            recipe::generated::message(message),
                            language,
                            plaintext,
                            &options,
                            budget.clone(),
                        )
                        .await
                        .expect("source Responses codec"),
                        budget.clone(),
                    )
                    .await;
                    let expected: Vec<Vec<u8>> = expected
                        .iter()
                        .map(|value| serde_json::to_vec(value).expect("owned JSON"))
                        .collect();
                    assert_eq!(
                        actual, expected,
                        "contract {plaintext:?}, locale {language:?}"
                    );
                }
            }
        }
    }
}
