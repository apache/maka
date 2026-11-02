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

//! Explicit generated-input conversion; canonical history never uses this boundary.
use super::*;
use crate::model::{
    ToolInput,
    prompt::{AssistantPart, ContentPart, FileData, Message, ToolOutput},
};
use sha2::{Digest, Sha256};

pub fn text(value: impl Into<String>) -> TextSource {
    TextSource::new(
        SourceBytes::Inline(Bytes::from(value.into())),
        TextEncoding::Utf8,
    )
}
pub fn json(value: &serde_json::Value) -> JsonSource {
    JsonSource::new(SourceBytes::Inline(Bytes::from(
        serde_json::to_vec(value).expect("generated JSON serialization"),
    )))
}
fn options(value: &Option<serde_json::Value>) -> Option<JsonSource> {
    value.as_ref().map(json)
}

#[derive(Clone)]
pub struct GeneratedRecipes<T>(Arc<[T]>);
impl<T> GeneratedRecipes<T> {
    pub fn new(items: Vec<T>) -> Self {
        Self(items.into())
    }
}
struct Cursor<T> {
    items: Arc<[T]>,
    position: usize,
}
impl<T: Clone + Send + Sync + 'static> RecipeSource<T> for GeneratedRecipes<T> {
    fn len(&self) -> usize {
        self.0.len()
    }
    fn open(&self, start: usize) -> Box<dyn RecipeCursor<T>> {
        Box::new(Cursor {
            items: self.0.clone(),
            position: start,
        })
    }
}
impl<T: Clone + Send + Sync + 'static> RecipeCursor<T> for Cursor<T> {
    fn next(&mut self) -> NextRecipe<'_, T> {
        Box::pin(async move {
            let item = self.items.get(self.position).cloned();
            self.position += usize::from(item.is_some());
            Ok(item)
        })
    }
}
fn content(item: &ContentPart) -> ContentRecipe {
    match item {
        ContentPart::Text {
            text: value,
            provider_options,
        } => ContentRecipe::Text {
            text: text(value.clone()),
            provider_options: options(provider_options),
        },
        ContentPart::File {
            data: FileData::Data(data),
            media_type,
            provider_options,
        } => {
            // Explicit generated media already uses base64; decode once at this owned-input boundary.
            use base64::Engine as _;
            let bytes = match base64::engine::general_purpose::STANDARD.decode(data) {
                Ok(bytes) => SourceBytes::Inline(Bytes::from(bytes)),
                Err(_) => SourceBytes::Source(Arc::new(InvalidMedia)),
            };
            ContentRecipe::Media {
                media: MediaSource {
                    bytes,
                    media_type: text(media_type.clone()),
                    detail: provider_options
                        .as_ref()
                        .and_then(|v| v["openai"]["imageDetail"].as_str())
                        .map(|v| text(v.to_owned())),
                },
                provider_options: options(provider_options),
            }
        }
    }
}
fn output(value: &ToolOutput) -> ToolOutputRecipe {
    match value {
        ToolOutput::Text(v) => ToolOutputRecipe::Text(text(v.clone())),
        ToolOutput::ErrorText(v) => ToolOutputRecipe::ErrorText(text(v.clone())),
        ToolOutput::Json(v) => ToolOutputRecipe::Json(json(v)),
        ToolOutput::ErrorJson(v) => ToolOutputRecipe::ErrorJson(json(v)),
        ToolOutput::Content(parts) => ToolOutputRecipe::Content(Arc::new(GeneratedRecipes::new(
            parts.iter().map(content).collect(),
        ))),
    }
}
fn parsed_error(value: &ToolOutput) -> Option<ParsedToolError> {
    let encoded = match value {
        ToolOutput::ErrorText(value) => value,
        ToolOutput::ErrorJson(serde_json::Value::String(value)) => value,
        _ => return None,
    };
    let value: serde_json::Value = serde_json::from_str(encoded).unwrap_or(serde_json::Value::Null);
    let source = json(&value);
    let code_value = match value {
        serde_json::Value::String(encoded) => {
            json(&serde_json::from_str(&encoded).unwrap_or(serde_json::Value::Null))
        }
        _ => source.clone(),
    };
    Some(ParsedToolError {
        value: source,
        code_value,
    })
}
pub fn message(value: &Message) -> MessageRecipe {
    message_with_mcp(value, &mut std::collections::HashSet::new())
}
fn message_with_mcp(value: &Message, mcp: &mut std::collections::HashSet<String>) -> MessageRecipe {
    if !matches!(value, Message::Assistant { .. }) {
        mcp.clear();
    }
    match value {
        Message::System {
            content,
            provider_options,
        } => MessageRecipe::System {
            content: text(content.clone()),
            provider_options: options(provider_options),
        },
        Message::User {
            content: parts,
            provider_options,
        } => MessageRecipe::User {
            content: Arc::new(GeneratedRecipes::new(parts.iter().map(content).collect())),
            provider_options: options(provider_options),
        },
        Message::Assistant {
            content: parts,
            provider_options,
        } => MessageRecipe::Assistant {
            content: Arc::new(GeneratedRecipes::new(
                parts
                    .iter()
                    .map(|part| match part {
                        AssistantPart::Text {
                            text: value,
                            provider_options,
                        } => AssistantRecipe::Text {
                            text: text(value.clone()),
                            provider_options: options(provider_options),
                        },
                        AssistantPart::Reasoning {
                            text: value,
                            provider_options,
                        } => AssistantRecipe::Reasoning {
                            text: text(value.clone()),
                            provider_options: options(provider_options),
                        },
                        AssistantPart::ToolCall {
                            tool_call_id,
                            tool_name,
                            input,
                            provider_executed,
                            provider_options,
                        } => {
                            if *provider_executed == Some(true)
                                && provider_options
                                    .as_ref()
                                    .is_some_and(|v| v["anthropic"]["type"] == "mcp-tool-use")
                            {
                                mcp.insert(tool_call_id.clone());
                            }
                            AssistantRecipe::ToolCall {
                                tool_call_id: text(tool_call_id.clone()),
                                tool_name: text(tool_name.clone()),
                                input: match input {
                                    ToolInput::Json(v) => ToolInputRecipe::Json(json(v)),
                                    ToolInput::InvalidJson { raw } => {
                                        ToolInputRecipe::Text(text(raw.clone()))
                                    }
                                },
                                kind: if provider_options.as_ref().is_some_and(|v| {
                                    v["openai"]["toolKind"] == "custom"
                                        || v["openResponses"]["toolKind"] == "custom"
                                }) {
                                    ToolCallKind::Custom
                                } else {
                                    ToolCallKind::Function
                                },
                                provider_executed: *provider_executed,
                                provider_options: options(provider_options),
                            }
                        }
                        AssistantPart::ToolResult {
                            tool_call_id,
                            tool_name,
                            output: value,
                            provider_options,
                        } => AssistantRecipe::ToolResult(ToolResultRecipe {
                            tool_call_id: text(tool_call_id.clone()),
                            tool_name: text(tool_name.clone()),
                            kind: ToolResultKind::Settled,
                            call_kind: ToolCallKind::Function,
                            output: output(value),
                            parsed_error: parsed_error(value),
                            replay: if mcp.contains(tool_call_id) {
                                ToolResultReplay::AnthropicMcp
                            } else {
                                ToolResultReplay::Ordinary
                            },
                            provider_options: options(provider_options),
                        }),
                    })
                    .collect(),
            )),
            provider_options: options(provider_options),
        },
        Message::Tool {
            content: parts,
            provider_options,
        } => MessageRecipe::Tool {
            content: Arc::new(GeneratedRecipes::new(
                parts
                    .iter()
                    .map(|part| ToolResultRecipe {
                        tool_call_id: text(part.tool_call_id.clone()),
                        tool_name: text(part.tool_name.clone()),
                        kind: if part.is_notification() {
                            ToolResultKind::Notification
                        } else {
                            ToolResultKind::Settled
                        },
                        call_kind: if part.is_custom() {
                            ToolCallKind::Custom
                        } else {
                            ToolCallKind::Function
                        },
                        output: output(&part.output),
                        parsed_error: parsed_error(&part.output),
                        replay: ToolResultReplay::Ordinary,
                        provider_options: options(&part.provider_options),
                    })
                    .collect(),
            )),
            provider_options: options(provider_options),
        },
    }
}

pub struct GeneratedMessages {
    messages: GeneratedRecipes<MessageRecipe>,
    metadata: GeneratedRecipes<MessageMetadata>,
}
impl GeneratedMessages {
    pub fn new(messages: &[Message]) -> Self {
        let metadata = messages
            .iter()
            .enumerate()
            .map(|(index, m)| {
                let identity = hex::encode(Sha256::digest(
                    serde_json::to_vec(m).expect("generated message serialization"),
                ));
                let (role, ids) = match m {
                    Message::System { .. } => (MessageRole::System, Vec::new()),
                    Message::User { .. } => (MessageRole::User, Vec::new()),
                    Message::Assistant { content, .. } => (MessageRole::Assistant, content.iter().filter_map(|part|match part {
                        AssistantPart::ToolResult { tool_call_id, .. } => Some(IdentifiedText { text: text(tool_call_id.clone()), identity: Sha256::digest(tool_call_id.as_bytes()).into() }),
                        _ => None,
                    }).collect()),
                    Message::Tool { content, .. } => (
                        MessageRole::Tool,
                        content
                            .iter()
                            .filter(|p| !p.is_notification())
                            .map(|p| IdentifiedText {
                                text: text(p.tool_call_id.clone()),
                                identity: Sha256::digest(p.tool_call_id.as_bytes()).into(),
                            })
                            .collect(),
                    ),
                };
                MessageMetadata {
                    message_index: index,
                    logical_identity: identity.into(),
                    role,
                    last_is_tool_result: matches!(m, Message::Assistant { content, .. } if matches!(content.last(), Some(AssistantPart::ToolResult { .. }))),
                    local_tool_names: Arc::new(GeneratedRecipes::new(match m {
                        Message::Assistant { content, .. } => content.iter().filter_map(|part| match part {
                            AssistantPart::ToolCall { tool_name, provider_executed, .. } if *provider_executed != Some(true) => Some(IdentifiedText { text: text(tool_name.clone()), identity: Sha256::digest(tool_name.as_bytes()).into() }),
                            _ => None,
                        }).collect(),
                        _ => Vec::new(),
                    })),
                    settled_tool_call_ids: Arc::new(GeneratedRecipes::new(ids)),
                }
            })
            .collect();
        let mut mcp = std::collections::HashSet::new();
        Self {
            messages: GeneratedRecipes::new(
                messages
                    .iter()
                    .map(|value| message_with_mcp(value, &mut mcp))
                    .collect(),
            ),
            metadata: GeneratedRecipes::new(metadata),
        }
    }
}
impl RecipeSource<MessageRecipe> for GeneratedMessages {
    fn len(&self) -> usize {
        self.messages.len()
    }
    fn open(&self, start: usize) -> Box<dyn RecipeCursor<MessageRecipe>> {
        self.messages.open(start)
    }
}
impl MessageSource for GeneratedMessages {
    fn open_metadata(&self, start: usize) -> Box<dyn RecipeCursor<MessageMetadata>> {
        self.metadata.open(start)
    }
    fn prefix_identity(&self, messages: usize) -> RecipeIdentity<'_> {
        Box::pin(async move {
            if messages > self.messages.len() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "generated prefix exceeds input",
                ));
            }
            let mut hash = Sha256::new();
            hash.update(b"maka-generated-prefix\0");
            for item in self.metadata.0.iter().take(messages) {
                hash.update(item.logical_identity.as_bytes());
            }
            Ok(hex::encode(hash.finalize()))
        })
    }
}

struct InvalidMedia;
impl ByteSource for InvalidMedia {
    fn len(&self) -> Option<u64> {
        None
    }
    fn open(&self, _budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
        Box::new(InvalidMedia)
    }
}
impl ByteCursor for InvalidMedia {
    fn read_chunk(&mut self, _buffer: ChargedBuffer) -> ReadSource<'_> {
        Box::pin(async {
            Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "generated media is invalid base64",
            ))
        })
    }
}
