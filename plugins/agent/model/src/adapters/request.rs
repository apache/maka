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

use super::{
    http::{Decoder, failure},
    prompt,
};
use crate::{ModelError, ProviderKind};
use maka_agent_ports::model::{Credentials, Request};
use maka_provider_protocol::{anthropic, chat_completions};
use serde_json::Value;
use std::collections::BTreeMap;

pub(super) struct Prepared {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Value,
    pub decoder: Decoder,
    pub compatible: bool,
    pub anthropic: bool,
    pub anthropic_source: Option<(
        crate::prompt::PreparedWire,
        std::sync::Arc<anthropic::prompt::streaming::Context>,
    )>,
    pub chat: Option<(
        crate::prompt::Prompt,
        chat_completions::request::PromptOptions,
        maka_agent_facts::language::Language,
    )>,
}
pub(super) async fn prepare(request: Request) -> Result<Prepared, ModelError> {
    let is_anthropic = matches!(request.provider.kind, ProviderKind::Anthropic);
    let compatible = matches!(request.provider.kind, ProviderKind::OpenaiCompatible { .. });
    let mut chat = None;
    let mut anthropic_source = None;
    let mut headers = BTreeMap::from([("content-type".to_owned(), "application/json".to_owned())]);
    let (mut body, decoder, suffix) = if is_anthropic {
        let stream_options =
            super::wire::anthropic_options(&request.provider_options, &request.tools)?;
        let codec = super::wire::anthropic_codec(request.language, &stream_options);
        let wire = if let Some(wire) = request.prompt.wire(crate::prompt::WireFormat::Anthropic) {
            if wire.codec.as_ref() != codec {
                return Err(ModelError::Adapter(
                    "prepared Anthropic codec does not match captured request".into(),
                ));
            }
            wire.clone()
        } else if request.prompt.memory_messages().is_some() {
            super::anthropic::direct_wire(request.prompt.clone(), request.language, stream_options)
        } else {
            return Err(ModelError::Adapter(
                "captured prompt is missing its prepared Anthropic wire projection".into(),
            ));
        };
        let document_count = wire.source.document_count();
        let documents = super::anthropic_documents::Documents::new(wire.source.clone())?;
        let metadata = super::anthropic::metadata(&wire).await?;
        let context = metadata.context.clone();
        let tools = request
            .tools
            .into_iter()
            .map(|tool| {
                let definition = if let Some(provider) = tool.provider {
                    let hosted =
                        anthropic::HostedTool::from_definition(&provider.id, &provider.args)
                            .map_err(failure)?;
                    match hosted {
                        Some(
                            hosted @ (anthropic::HostedTool::CodeExecution(_)
                            | anthropic::HostedTool::WebFetch(..)
                            | anthropic::HostedTool::WebSearch(..)
                            | anthropic::HostedTool::ToolSearch(_)
                            | anthropic::HostedTool::Advisor(_)),
                        ) => anthropic::Tool::Hosted(hosted),
                        _ => {
                            return Err(ModelError::Adapter(format!(
                                "Unsupported provider-executed tool: {}",
                                provider.id
                            )));
                        }
                    }
                } else {
                    anthropic::Tool::Function(anthropic::FunctionTool {
                        name: tool.name.clone(),
                        description: Some(tool.description),
                        input_schema: tool.input_schema,
                        cache_control: None,
                        strict: None,
                        defer_loading: None,
                        eager_input_streaming: None,
                        allowed_callers: None,
                        input_examples: None,
                    })
                };
                Ok(anthropic::request::ToolBinding {
                    name: tool.name,
                    definition,
                })
            })
            .collect::<Result<Vec<_>, ModelError>>()?;
        let choice = (!tools.is_empty()).then_some(anthropic::ToolChoice::Auto);
        let options = anthropic::request::options::ProviderOptions::parse(
            request.provider_options.get("anthropic"),
            None,
        )
        .map_err(failure)?;
        let mut prepared = anthropic::request::prepare_streaming(
            anthropic::request::Request {
                model: request.provider.model,
                messages: &[],
                tools,
                choice,
                sampling: anthropic::request::Sampling {
                    max_output_tokens: request.max_output_tokens,
                    ..Default::default()
                },
                reasoning: Default::default(),
                format: Default::default(),
                options,
                custom_namespace_used: false,
                streaming: true,
                header_betas: vec![
                    "interleaved-thinking-2025-05-14".into(),
                    "fine-grained-tool-streaming-2025-05-14".into(),
                ],
            },
            &Default::default(),
            metadata,
        )
        .map_err(failure)?;
        if document_count > 0 {
            prepared.response.documents =
                anthropic::citations::DocumentReferences::deferred(document_count);
        }
        anthropic_source = Some((wire, context));
        headers.insert("anthropic-version".into(), "2023-06-01".into());
        if !prepared.betas.is_empty() {
            headers.insert("anthropic-beta".into(), prepared.betas.join(","));
        }
        let mut fields =
            serde_json::to_value(prepared.body).map_err(|e| ModelError::Adapter(e.to_string()))?;
        fields
            .as_object_mut()
            .expect("Anthropic fields")
            .remove("messages");
        (
            fields,
            Decoder::Anthropic {
                stream: Box::new(anthropic::stream::Stream::new(prepared.response)),
                documents,
            },
            "messages",
        )
    } else {
        let namespace = match request.provider.kind {
            ProviderKind::OpenaiCompatible { name } => name,
            ProviderKind::OpenaiChatCompletions => "openai".into(),
            _ => return Err(ModelError::Adapter("unsupported provider protocol".into())),
        };
        let tools = request
            .tools
            .into_iter()
            .map(|tool| {
                if tool.provider.is_some() {
                    return Err(ModelError::Adapter(
                        "Chat Completions does not support provider-executed tools".into(),
                    ));
                }
                Ok(chat_completions::request::Tool::Function {
                    name: tool.name,
                    description: Some(tool.description),
                    schema: tool.input_schema,
                    strict: None,
                })
            })
            .collect::<Result<Vec<_>, ModelError>>()?;
        let tool_choice =
            (!tools.is_empty()).then_some(chat_completions::request::ToolChoice::Auto);
        let prepared = chat_completions::request::prepare_fields(
            chat_completions::request::Request {
                model: request.provider.model,
                messages: &[],
                tools,
                tool_choice,
                sampling: chat_completions::request::Sampling {
                    max_output_tokens: request.max_output_tokens,
                    ..Default::default()
                },
                format: Default::default(),
                reasoning: None,
                extensions: prompt::extensions(Some(request.provider_options))?,
                streaming: true,
            },
            &chat_completions::request::Config {
                provider_namespace: namespace.clone(),
                include_usage: true,
                ..Default::default()
            },
        )
        .map_err(failure)?;
        let options = chat_completions::request::PromptOptions {
            provider_namespace: namespace.clone(),
            metadata_namespace: prepared.metadata_namespace.clone(),
            multipart_tool_content: false,
        };
        if let Some(wire) = request
            .prompt
            .wire(crate::prompt::WireFormat::ChatCompletions)
        {
            if wire.codec.as_ref() != super::wire::chat_codec(request.language, &options) {
                return Err(ModelError::Adapter(
                    "prepared Chat Completions codec does not match captured request".into(),
                ));
            }
        } else {
            if request.prompt.memory_messages().is_none() {
                return Err(ModelError::Adapter(
                    "captured prompt is missing its prepared Chat Completions wire projection"
                        .into(),
                ));
            }
            super::body::validate(&request.prompt, &options, request.language).await?;
        }
        chat = Some((request.prompt, options, request.language));
        (
            prepared.body,
            Decoder::Chat(Box::new(
                chat_completions::Stream::new(prepared.metadata_namespace)
                    .with_reasoning_observations(compatible),
            )),
            "chat/completions",
        )
    };
    if let Some(overlay) = request.provider.body_overlay {
        for (key, value) in overlay {
            if body.get(&key).is_some()
                || key == "messages"
                || (key == "system"
                    && anthropic_source
                        .as_ref()
                        .is_some_and(|(_, context)| context.has_system()))
            {
                return Err(ModelError::Adapter(format!(
                    "Extra request body conflicts with a generated field: {key}"
                )));
            }
            body[&key] = value;
        }
    }
    match request.provider.auth {
        Credentials::ApiKey(key) => {
            headers.insert(
                if is_anthropic {
                    "x-api-key"
                } else {
                    "authorization"
                }
                .into(),
                if is_anthropic {
                    key
                } else {
                    format!("Bearer {key}")
                },
            );
        }
        Credentials::RequestHeaders(auth) => merge_headers(
            &mut headers,
            auth,
            "Authentication header conflicts with a protocol header",
        )?,
    }
    merge_headers(
        &mut headers,
        request.provider.headers,
        "Custom request header conflicts with a generated header",
    )?;
    let mut url = reqwest::Url::parse(&request.provider.base_url)
        .map_err(|_| ModelError::Adapter("invalid provider endpoint".into()))?;
    url.set_path(&format!("{}/{suffix}", url.path().trim_end_matches('/')));
    Ok(Prepared {
        url: url.into(),
        headers: headers.into_iter().collect(),
        body,
        decoder,
        compatible,
        anthropic: is_anthropic,
        chat,
        anthropic_source,
    })
}
fn merge_headers(
    target: &mut BTreeMap<String, String>,
    headers: BTreeMap<String, String>,
    message: &str,
) -> Result<(), ModelError> {
    for (name, value) in headers {
        let normalized = name.to_ascii_lowercase();
        if target.get(&normalized).is_some_and(|old| old != &value) {
            return Err(ModelError::Adapter(format!("{message}: {name}")));
        }
        target.insert(normalized, value);
    }
    Ok(())
}
