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

//! Frozen provider policy and source-backed request item compilation.
use super::prompt;
use crate::prompt::WireFormat;
use crate::{ModelError, ProviderConfig, ProviderKind, ToolDefinition};
use maka_agent_facts::{language::Language, model::PlaintextResponses};
use maka_provider_protocol::chat_completions::request as chat;
use serde_json::Value;
use std::sync::Arc;

mod anthropic;
mod chat_source;
mod frozen;
mod responses;
pub(super) mod source;
pub use frozen::{EncodedWire, FrozenWire, SummaryWireBound, WirePlan, WireSink, WireWrite};

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
#[derive(Clone)]
pub struct WireEncoding {
    language: Language,
    codec: Arc<str>,
    options: Arc<WireOptions>,
}
enum WireOptions {
    Chat(chat::PromptOptions),
    Responses {
        plaintext: Option<PlaintextResponses>,
        options: Value,
    },
    Anthropic(Arc<maka_provider_protocol::anthropic::prompt::streaming::StreamOptions>),
}
impl WireEncoding {
    pub fn new(
        language: Language,
        provider: &ProviderConfig,
        options: &Value,
        tools: &[Arc<ToolDefinition>],
    ) -> Result<Self, ModelError> {
        let options = effective_options(provider, options)?;
        let (codec, options) = match &provider.kind {
            ProviderKind::OpenaiChatCompletions | ProviderKind::OpenaiCompatible { .. } => {
                let options = chat_options(&provider.kind, &options)?;
                (chat_codec(language, &options), WireOptions::Chat(options))
            }
            ProviderKind::OpenaiResponses => (
                crate::adapters::responses::request::wire_codec(language, None, &options),
                WireOptions::Responses {
                    plaintext: None,
                    options,
                },
            ),
            ProviderKind::OpenResponses(contract) => (
                crate::adapters::responses::request::wire_codec(
                    language,
                    Some(*contract),
                    &options,
                ),
                WireOptions::Responses {
                    plaintext: Some(*contract),
                    options,
                },
            ),
            ProviderKind::Anthropic => {
                let options = anthropic_options(&options, tools)?;
                (
                    anthropic_codec(language, &options),
                    WireOptions::Anthropic(Arc::new(options)),
                )
            }
        };
        Ok(Self {
            language,
            codec: codec.into(),
            options: Arc::new(options),
        })
    }

    pub fn codec(&self) -> &str {
        &self.codec
    }

    pub fn format(&self) -> WireFormat {
        match self.options.as_ref() {
            WireOptions::Chat(_) => WireFormat::ChatCompletions,
            WireOptions::Responses { .. } => WireFormat::Responses,
            WireOptions::Anthropic(_) => WireFormat::Anthropic,
        }
    }

    pub async fn count_source(
        &self,
        source: Arc<dyn maka_agent_facts::model::prompt_source::source::MessageSource>,
        resources: crate::ModelPreparationResources,
    ) -> Result<WirePlan, ModelError> {
        frozen::count(
            self.clone(),
            source,
            chat_source::Projection::Generated,
            resources,
        )
        .await
    }
    pub async fn count_prompt(
        &self,
        prompt: &crate::prompt::Prompt,
        resources: crate::ModelPreparationResources,
    ) -> Result<WirePlan, ModelError> {
        let source = prompt.recipes().cloned().ok_or_else(|| {
            ModelError::Adapter("native wire count requires frozen recipes".into())
        })?;
        let projection = if matches!(
            prompt.normalization(),
            Some(ProviderKind::OpenaiChatCompletions | ProviderKind::OpenaiCompatible { .. })
        ) {
            chat_source::Projection::Captured
        } else {
            chat_source::Projection::Generated
        };
        frozen::count(self.clone(), source, projection, resources).await
    }
    pub async fn count_summary_fit_bound(
        &self,
        original: &WirePlan,
        original_messages: usize,
        resources: crate::ModelPreparationResources,
    ) -> Result<SummaryWireBound, ModelError> {
        if !Arc::ptr_eq(&self.options, &original.encoding.options) {
            return Err(ModelError::Adapter(
                "summary bound policy differs from its first counted request".into(),
            ));
        }
        original
            .summary_fit_bound(original_messages, resources)
            .await
    }
    pub async fn prepare_source_with_plan(
        &self,
        plan: WirePlan,
        lease: crate::DirectoryLease,
        resources: crate::ModelPreparationResources,
    ) -> Result<FrozenWire, ModelError> {
        if !Arc::ptr_eq(&self.options, &plan.encoding.options) {
            return Err(ModelError::Adapter(
                "wire build policy differs from its counted plan".into(),
            ));
        }
        frozen::build(plan, lease, resources).await
    }
    /// Explicit generated inputs use the same count/build path with an isolated admission.
    pub async fn prepare_source(
        &self,
        source: Arc<dyn maka_agent_facts::model::prompt_source::source::MessageSource>,
        resources: crate::ModelPreparationResources,
    ) -> Result<FrozenWire, ModelError> {
        let plan = self.count_source(source, resources.clone()).await?;
        let stage = resources
            .reserve_staging(plan.allocation())
            .await
            .map_err(|error| ModelError::Adapter(error.to_string()))?;
        let active = stage
            .promote(plan.allocation())
            .await
            .map_err(|error| ModelError::Adapter(error.to_string()))?;
        let lease = active
            .directory(plan.allocation())
            .map_err(|error| ModelError::Adapter(error.to_string()))?;
        self.prepare_source_with_plan(plan, lease, resources).await
    }
}

pub(super) fn anthropic_options(
    options: &Value,
    tools: &[Arc<ToolDefinition>],
) -> Result<maka_provider_protocol::anthropic::prompt::streaming::StreamOptions, ModelError> {
    use maka_provider_protocol::anthropic::{self, HostedTool};
    let options =
        anthropic::request::options::ProviderOptions::parse(options.get("anthropic"), None)
            .map_err(super::http::failure)?;
    let mut tool_names = std::collections::BTreeMap::new();
    for tool in tools {
        if let Some(provider) = &tool.provider {
            let hosted = HostedTool::from_definition(&provider.id, &provider.args)
                .map_err(super::http::failure)?;
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
