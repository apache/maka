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

//! Incremental provider-specific encoding for dirty semantic groups.
use super::{chat_completions::Projector, media, prompt};
use crate::prompt::{Message, WireChunk, WireFormat, WireGroup};
use crate::{ModelError, ProviderConfig, ProviderKind, ToolDefinition};
use maka_agent_facts::{language::Language, model::PlaintextResponses};
use maka_provider_protocol::{chat_completions::request as chat, json_stream::JsonChunks};
use serde_json::Value;
use std::collections::VecDeque;

fn effective_options(provider: &ProviderConfig, options: &Value) -> Result<Value, ModelError> {
    let mut options = options.clone();
    if provider.adapter.as_deref() == Some(maka_providers::codex::ADAPTER) {
        if options.is_null() {
            options = serde_json::json!({});
        }
        let object = options
            .as_object_mut()
            .ok_or_else(|| ModelError::Adapter("provider options must be an object".into()))?;
        let openai = object
            .entry("openai")
            .or_insert_with(|| serde_json::json!({}));
        openai
            .as_object_mut()
            .ok_or_else(|| ModelError::Adapter("OpenAI options must be an object".into()))?
            .insert("store".into(), Value::Bool(false));
    }
    Ok(options)
}

pub(super) fn chat_options(
    kind: &ProviderKind,
    options: &Value,
) -> Result<chat::PromptOptions, ModelError> {
    let namespace = match kind {
        ProviderKind::OpenaiChatCompletions => "openai",
        ProviderKind::OpenaiCompatible { name } => name,
        _ => return Err(ModelError::Adapter("not a Chat Completions codec".into())),
    };
    Ok(chat::prompt_options(
        namespace,
        &prompt::extensions(Some(options.clone()))?,
        false,
    ))
}
pub(super) fn chat_codec(language: Language, options: &chat::PromptOptions) -> String {
    serde_json::json!({"codec":"maka.chat-items.v1","language":language,
        "namespace":options.provider_namespace,"metadataNamespace":options.metadata_namespace,
        "multipartToolContent":options.multipart_tool_content})
    .to_string()
}

/// Immutable message encoding policy. Tool schemas belong to the request header;
/// replayable message sources retain only the protocol options they consume.
pub struct WireEncoding {
    language: Language,
    codec: String,
    options: WireOptions,
}
enum WireOptions {
    Chat(chat::PromptOptions),
    Responses {
        plaintext: Option<PlaintextResponses>,
        options: Value,
    },
    Anthropic(maka_provider_protocol::anthropic::prompt::streaming::StreamOptions),
}
impl WireEncoding {
    pub fn new(
        language: Language,
        provider: &ProviderConfig,
        options: &Value,
        tools: &[ToolDefinition],
    ) -> Result<Self, ModelError> {
        let options = effective_options(provider, options)?;
        let (codec, options) = match &provider.kind {
            ProviderKind::OpenaiChatCompletions | ProviderKind::OpenaiCompatible { .. } => {
                let options = chat_options(&provider.kind, &options)?;
                (chat_codec(language, &options), WireOptions::Chat(options))
            }
            ProviderKind::OpenaiResponses => (
                maka_responses::request::wire_codec(language, None, &options),
                WireOptions::Responses {
                    plaintext: None,
                    options,
                },
            ),
            ProviderKind::OpenResponses(contract) => (
                maka_responses::request::wire_codec(language, Some(*contract), &options),
                WireOptions::Responses {
                    plaintext: Some(*contract),
                    options,
                },
            ),
            ProviderKind::Anthropic => {
                let options = anthropic_options(&options, tools)?;
                (
                    anthropic_codec(language, &options),
                    WireOptions::Anthropic(options),
                )
            }
        };
        Ok(Self {
            language,
            codec,
            options,
        })
    }

    pub fn codec(&self) -> &str {
        &self.codec
    }

    pub fn format(&self) -> WireFormat {
        match self.options {
            WireOptions::Chat(_) => WireFormat::ChatCompletions,
            WireOptions::Responses { .. } => WireFormat::Responses,
            WireOptions::Anthropic(_) => WireFormat::Anthropic,
        }
    }

    pub fn prepare_group(&self, messages: Vec<Message>, context: &PreparationContext) -> WireGroup {
        let message_count = messages.len();
        let chunks: Box<dyn Iterator<Item = Result<WireChunk, ModelError>> + Send> =
            match &self.options {
                WireOptions::Chat(options) => Box::new(Group::new(
                    messages,
                    self.language,
                    Encoder::Chat {
                        options: options.clone(),
                        projector: Some(Projector::new(self.language)),
                    },
                )),
                WireOptions::Responses { plaintext, options } => Box::new(Group::new(
                    messages,
                    self.language,
                    Encoder::Responses {
                        plaintext: *plaintext,
                        options: options.clone(),
                    },
                )),
                WireOptions::Anthropic(options) => Box::new(AnthropicGroup::new(
                    messages,
                    self.language,
                    options.clone(),
                    context,
                )),
            };
        WireGroup {
            format: self.format(),
            codec: self.codec.clone(),
            message_count,
            chunks,
        }
    }
}

#[derive(Default)]
pub struct PreparationContext {
    /// Only IDs referenced by this dirty leading assistant run, checked against
    /// the indexed preceding assistant run by the projection owner.
    pub anthropic_mcp_ids: Vec<String>,
}
pub fn wire_preparation_dependencies(messages: &[Message], provider: &ProviderKind) -> Vec<String> {
    use crate::prompt::AssistantPart;
    if !matches!(provider, ProviderKind::Anthropic) {
        return Vec::new();
    }
    let mut local = std::collections::BTreeSet::new();
    let mut needed = std::collections::BTreeSet::new();
    for message in messages {
        let Message::Assistant { content, .. } = message else {
            break;
        };
        for part in content {
            match part {
                AssistantPart::ToolCall {
                    tool_call_id,
                    provider_executed: Some(true),
                    provider_options: Some(options),
                    ..
                } if options["anthropic"]["type"] == "mcp-tool-use" => {
                    local.insert(tool_call_id.clone());
                }
                AssistantPart::ToolResult { tool_call_id, .. } if !local.contains(tool_call_id) => {
                    needed.insert(tool_call_id.clone());
                }
                _ => {}
            }
        }
    }
    needed.into_iter().collect()
}
enum Encoder {
    Chat {
        options: chat::PromptOptions,
        projector: Option<Projector>,
    },
    Responses {
        plaintext: Option<PlaintextResponses>,
        options: Value,
    },
}
struct Current {
    chunks: std::iter::Peekable<JsonChunks>,
    index: usize,
    first: bool,
    metadata: Option<Value>,
}
struct Group {
    messages: std::iter::Enumerate<std::vec::IntoIter<Message>>,
    language: Language,
    encoder: Encoder,
    pending: VecDeque<(usize, Message)>,
    values: VecDeque<(usize, Value)>,
    current: Option<Current>,
    metadata: Option<(usize, Value)>,
    last_index: usize,
    ended: bool,
}
impl Group {
    fn new(messages: Vec<Message>, language: Language, encoder: Encoder) -> Self {
        Self {
            messages: messages.into_iter().enumerate(),
            language,
            encoder,
            pending: VecDeque::new(),
            values: VecDeque::new(),
            current: None,
            metadata: None,
            last_index: 0,
            ended: false,
        }
    }

    fn step(&mut self) -> Result<Option<WireChunk>, ModelError> {
        loop {
            if let Some(current) = &mut self.current {
                if let Some(bytes) = current.chunks.next() {
                    let item_start = std::mem::take(&mut current.first);
                    return Ok(Some(WireChunk {
                        bytes,
                        item_start,
                        item_end: current.chunks.peek().is_none(),
                        message_index: current.index,
                        metadata: if item_start {
                            current.metadata.take()
                        } else {
                            None
                        },
                    }));
                }
                self.current = None;
            }
            if let Some((index, value)) = self.values.pop_front() {
                self.current = Some(Current {
                    chunks: JsonChunks::new(value).peekable(),
                    index,
                    first: true,
                    metadata: if self
                        .metadata
                        .as_ref()
                        .is_some_and(|(message_index, _)| *message_index == index)
                    {
                        self.metadata.take().map(|(_, value)| value)
                    } else {
                        None
                    },
                });
                continue;
            }
            if let Some((index, message)) = self.pending.pop_front() {
                if matches!(self.encoder, Encoder::Responses { .. }) {
                    self.metadata = Some((index, wire_message_metadata(&message)));
                }
                let values = match &self.encoder {
                    Encoder::Chat { options, .. } => {
                        chat::messages(&prompt::messages(vec![message])?, options)
                            .map_err(super::failure)?
                    }
                    Encoder::Responses { plaintext, options } => {
                        maka_responses::request::encode_message(
                            &message,
                            self.language,
                            *plaintext,
                            options,
                        )
                        .map_err(|error| ModelError::Adapter(error.to_string()))?
                    }
                };
                if values.is_empty()
                    && let Some((message_index, metadata)) = self.metadata.take()
                {
                    return Ok(Some(WireChunk {
                        bytes: Vec::new(),
                        item_start: true,
                        item_end: true,
                        message_index,
                        metadata: Some(metadata),
                    }));
                }
                self.values
                    .extend(values.into_iter().map(|value| (index, value)));
                continue;
            }
            if self.ended {
                return Ok(None);
            }
            match self.messages.next() {
                Some((index, message)) => match &mut self.encoder {
                    Encoder::Chat { projector, .. } => {
                        let mut messages =
                            crate::prompt::notification_fallback(vec![message], self.language);
                        media::audio_fallback(&mut messages, self.language, false);
                        for message in messages {
                            let projected =
                                projector.as_mut().expect("active projector").push(message);
                            let count = projected.len();
                            self.pending.extend(projected.into_iter().enumerate().map(
                                |(offset, message)| {
                                    (
                                        if count > 1 && offset == 0 {
                                            self.last_index
                                        } else {
                                            index
                                        },
                                        message,
                                    )
                                },
                            ));
                            self.last_index = index;
                        }
                    }
                    Encoder::Responses { .. } => self.pending.push_back((index, message)),
                },
                None => {
                    self.ended = true;
                    if let Encoder::Chat { projector, .. } = &mut self.encoder {
                        self.pending.extend(
                            projector
                                .take()
                                .expect("active projector")
                                .finish()
                                .map(|message| (self.last_index, message)),
                        );
                    }
                }
            }
        }
    }
}
impl Iterator for Group {
    type Item = Result<WireChunk, ModelError>;
    fn next(&mut self) -> Option<Self::Item> {
        match self.step() {
            Ok(chunk) => chunk.map(Ok),
            Err(error) => {
                self.ended = true;
                self.pending.clear();
                self.values.clear();
                self.current = None;
                Some(Err(error))
            }
        }
    }
}

pub fn wire_message_metadata(message: &Message) -> Value {
    let (role, ids) = match message {
        Message::System { .. } => ("system", Vec::new()),
        Message::User { .. } => ("user", Vec::new()),
        Message::Assistant { .. } => ("assistant", Vec::new()),
        Message::Tool { content, .. } => (
            "tool",
            content
                .iter()
                .filter(|result| !result.is_notification())
                .map(|result| result.tool_call_id.clone())
                .collect(),
        ),
    };
    serde_json::json!({"kind":"message","role":role,"settledToolCallIds":ids})
}

pub(super) fn anthropic_options(
    options: &Value,
    tools: &[ToolDefinition],
) -> Result<maka_provider_protocol::anthropic::prompt::streaming::StreamOptions, ModelError> {
    use maka_provider_protocol::anthropic::{self, HostedTool};
    let options =
        anthropic::request::options::ProviderOptions::parse(options.get("anthropic"), None)
            .map_err(super::failure)?;
    let mut tool_names = std::collections::BTreeMap::new();
    for tool in tools {
        if let Some(provider) = &tool.provider {
            let hosted = HostedTool::from_definition(&provider.id, &provider.args)
                .map_err(super::failure)?;
            match hosted {
                Some(
                    hosted @ (HostedTool::CodeExecution(_)
                    | HostedTool::WebFetch(..)
                    | HostedTool::WebSearch(..)
                    | HostedTool::ToolSearch(_)
                    | HostedTool::Advisor(_)),
                ) => {
                    tool_names.insert(
                        tool.name.clone(),
                        hosted.name().unwrap_or("computer").to_owned(),
                    );
                }
                _ => {
                    return Err(ModelError::Adapter(format!(
                        "Unsupported provider-executed tool: {}",
                        provider.id
                    )));
                }
            }
        }
    }
    Ok(anthropic::prompt::streaming::StreamOptions {
        send_reasoning: options.send_reasoning.unwrap_or(true),
        cache_namespace: "anthropic".into(),
        tool_names,
        toolsets: Default::default(),
    })
}
pub(super) fn anthropic_codec(
    language: Language,
    options: &maka_provider_protocol::anthropic::prompt::streaming::StreamOptions,
) -> String {
    serde_json::json!({"codec":"maka.anthropic-blocks.v1","language":language,"sendReasoning":options.send_reasoning,
        "cacheNamespace":options.cache_namespace,"toolNames":options.tool_names,"toolsets":options.toolsets}).to_string()
}

struct AnthropicCurrent {
    chunks:
        std::iter::Peekable<maka_provider_protocol::anthropic::prompt::prepared::PreparedChunks>,
    metadata: Option<Value>,
    index: usize,
    first: bool,
}
struct AnthropicGroup {
    messages: std::iter::Enumerate<std::vec::IntoIter<Message>>,
    language: Language,
    encoder: maka_provider_protocol::anthropic::prompt::prepared::PreparedEncoder,
    pending: VecDeque<(usize, maka_provider_protocol::input::Message)>,
    active: Option<(usize, maka_provider_protocol::input::Message, usize, usize)>,
    current: Option<AnthropicCurrent>,
    failed: bool,
}
impl AnthropicGroup {
    fn new(
        messages: Vec<Message>,
        language: Language,
        options: maka_provider_protocol::anthropic::prompt::streaming::StreamOptions,
        context: &PreparationContext,
    ) -> Self {
        let mut encoder =
            maka_provider_protocol::anthropic::prompt::prepared::PreparedEncoder::new(options);
        encoder.seed_assistant_mcp(context.anthropic_mcp_ids.clone());
        Self {
            messages: messages.into_iter().enumerate(),
            language,
            encoder,
            pending: VecDeque::new(),
            active: None,
            current: None,
            failed: false,
        }
    }
    fn step(&mut self) -> Result<Option<WireChunk>, ModelError> {
        loop {
            if let Some(current) = &mut self.current {
                if let Some(bytes) = current.chunks.next() {
                    let item_start = std::mem::take(&mut current.first);
                    return Ok(Some(WireChunk {
                        bytes,
                        item_start,
                        item_end: current.chunks.peek().is_none(),
                        message_index: current.index,
                        metadata: if item_start {
                            current.metadata.take()
                        } else {
                            None
                        },
                    }));
                }
                self.current = None;
            }
            if let Some((index, message, part, count)) = &mut self.active {
                if *part < *count {
                    let prepared = self.encoder.part(message, *part).map_err(super::failure)?;
                    *part += 1;
                    self.current = Some(AnthropicCurrent {
                        chunks: prepared.chunks.peekable(),
                        metadata: Some(
                            serde_json::to_value(prepared.metadata)
                                .map_err(|error| ModelError::Adapter(error.to_string()))?,
                        ),
                        index: *index,
                        first: true,
                    });
                    continue;
                }
                self.active = None;
            }
            if let Some((index, message)) = self.pending.pop_front() {
                let count = self.encoder.begin(&message).map_err(super::failure)?;
                self.active = Some((index, message, 0, count));
                continue;
            }
            let Some((index, message)) = self.messages.next() else {
                return Ok(None);
            };
            let mut messages = crate::prompt::notification_fallback(vec![message], self.language);
            media::audio_fallback(&mut messages, self.language, true);
            self.pending.extend(
                prompt::messages(messages)?
                    .into_iter()
                    .map(|message| (index, message)),
            );
        }
    }
}
impl Iterator for AnthropicGroup {
    type Item = Result<WireChunk, ModelError>;
    fn next(&mut self) -> Option<Self::Item> {
        if self.failed {
            return None;
        }
        match self.step() {
            Ok(chunk) => chunk.map(Ok),
            Err(error) => {
                self.failed = true;
                Some(Err(error))
            }
        }
    }
}
