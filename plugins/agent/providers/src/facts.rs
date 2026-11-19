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

use maka_agent_ports::provider::{Error, Policy};
type Result<T> = std::result::Result<T, Error>;
pub(crate) mod adapter;
pub(crate) mod discovery;
use adapter::{ModelRuntimeOverride, RuntimeAdapter};
use discovery::ModelDiscovery;
mod metadata;
use maka_agent_facts::configuration::ApiProtocol;
pub use metadata::{ModelMetadata, ThinkingOffBehavior};
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    sync::{Arc, OnceLock},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthKind {
    ApiKey,
    OauthToken,
    None,
    OptionalApiKey,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderFacts {
    #[serde(skip)]
    pub(crate) policy: OnceLock<std::result::Result<Arc<Policy>, String>>,
    pub label: String,
    pub base_url: String,
    pub auth_kind: AuthKind,
    pub runtime_adapter: RuntimeAdapter,
    pub protocol_adapters: BTreeMap<ApiProtocol, RuntimeAdapter>,
    pub retired: bool,
    pub model_discovery: ModelDiscovery,
    pub fallback_models: Vec<String>,
    pub models: BTreeMap<String, ModelFacts>,
}

pub(crate) struct SelectedAdapter<'a> {
    pub wire: ApiProtocol,
    pub adapter: &'a RuntimeAdapter,
    pub base_url: Option<&'a str>,
}

impl ProviderFacts {
    pub(crate) fn select_adapter(
        &self,
        model_id: &str,
        requested_wire: Option<ApiProtocol>,
    ) -> Result<SelectedAdapter<'_>> {
        let known = self.models.get(model_id);
        let override_ = known.and_then(|model| model.runtime_override.as_ref());
        let base = override_.map_or(&self.runtime_adapter, |value| &value.adapter);
        let base_wire = base.wire()?;
        let wire = requested_wire
            .or_else(|| known.and_then(|model| model.api_protocol))
            .unwrap_or(base_wire);
        if wire == base_wire {
            return Ok(SelectedAdapter {
                wire,
                adapter: base,
                base_url: override_.and_then(|value| value.base_url.as_deref()),
            });
        }
        if let Some(alternate) = self.protocol_adapters.get(&wire) {
            return Ok(SelectedAdapter {
                wire,
                adapter: alternate,
                base_url: None,
            });
        }
        if self.runtime_adapter.wire().ok() == Some(wire) {
            return Ok(SelectedAdapter {
                wire,
                adapter: &self.runtime_adapter,
                base_url: None,
            });
        }
        Err(Error::UnsupportedProtocol)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelFacts {
    pub metadata: ModelMetadata,
    pub runtime_override: Option<ModelRuntimeOverride>,
    pub api_protocol: Option<ApiProtocol>,
    pub entry: CatalogDefaults,
    /// Native Anthropic SDK capability, generated with the bundled SDK version.
    pub anthropic_adaptive_thinking: Option<bool>,
}

pub(crate) fn parse(raw: &str) -> std::result::Result<BTreeMap<String, ProviderFacts>, String> {
    let providers: BTreeMap<String, ProviderFacts> =
        serde_json::from_str(raw).map_err(|error| error.to_string())?;
    for (provider_id, provider) in &providers {
        let primary_wire = provider.runtime_adapter.wire().ok();
        for (wire, alternate) in &provider.protocol_adapters {
            if alternate.wire().ok() != Some(*wire) {
                return Err(format!(
                    "{provider_id}: protocolAdapter for {wire:?} does not match adapter protocol"
                ));
            }
            if primary_wire == Some(*wire) {
                return Err(format!(
                    "{provider_id}: protocolAdapter for {wire:?} duplicates runtimeAdapter"
                ));
            }
        }
        for (model_id, model) in &provider.models {
            if let Some(wire) = model.api_protocol
                && provider.select_adapter(model_id, None).is_err()
            {
                return Err(format!(
                    "{provider_id}/{model_id}: unsupported apiProtocol {wire:?}"
                ));
            }
        }
    }
    Ok(providers)
}

pub(crate) fn all() -> Result<&'static BTreeMap<String, ProviderFacts>> {
    static FACTS: OnceLock<std::result::Result<BTreeMap<String, ProviderFacts>, String>> =
        OnceLock::new();
    FACTS
        .get_or_init(|| parse(include_str!("../data/catalog-facts.json")))
        .as_ref()
        .map_err(|error| Error::Invalid(error.clone()))
}

pub fn provider_facts(provider: &str) -> Result<&'static ProviderFacts> {
    all()?
        .get(provider)
        .ok_or_else(|| Error::Invalid(format!("unknown provider: {provider}")))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogDefaults {
    pub can_use_as_chat_default: bool,
    pub supports_vision: bool,
    pub thinking_levels: Vec<maka_agent_facts::execution::ThinkingLevel>,
}

#[cfg(test)]
mod tests {
    use super::parse;
    use serde_json::{Value, json};

    fn catalog(adapter: Value, protocol_adapters: Value, model: Value) -> String {
        json!({
            "test": {
                "label": "Test",
                "baseUrl": "https://relay.test/v1",
                "authKind": "api_key",
                "runtimeAdapter": adapter,
                "protocolAdapters": protocol_adapters,
                "retired": false,
                "modelDiscovery": { "kind": "protocol" },
                "fallbackModels": [],
                "models": { "m": model }
            }
        })
        .to_string()
    }

    fn model(extra: Value) -> Value {
        let mut base = json!({
            "metadata": {},
            "entry": { "canUseAsChatDefault": true, "supportsVision": false, "thinkingLevels": [] }
        });
        base.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        base
    }

    #[test]
    fn parse_rejects_malformed_adapter_and_protocol_declarations() {
        let chat = json!({ "kind": "openai-chat" });
        let responses = json!({
            "kind": "openai-responses",
            "responses": { "adapter": "openai", "reasoningReplay": "encrypted-content" }
        });
        assert!(parse(&catalog(chat.clone(), json!({}), model(json!({})))).is_ok());

        for invalid in [
            catalog(
                json!({ "kind": "openai-chat", "apiProtocol": "openai-chat-completions" }),
                json!({}),
                model(json!({})),
            ),
            catalog(
                json!({ "kind": "google", "normalizeBaseUrl": false }),
                json!({}),
                model(json!({})),
            ),
            catalog(
                chat.clone(),
                json!({}),
                model(json!({ "api_protocol": "openai-chat-completions" })),
            ),
            catalog(
                chat.clone(),
                json!({}),
                model(json!({
                    "runtimeOverride": { "adapter": chat, "base_url": "https://relay.test/v2" }
                })),
            ),
            catalog(
                responses.clone(),
                json!({}),
                model(json!({ "apiProtocol": "openai-chat-completions" })),
            ),
            catalog(
                json!({ "kind": "openai-chat" }),
                json!({ "openai-chat-completions": responses }),
                model(json!({})),
            ),
            catalog(
                json!({ "kind": "openai-chat" }),
                json!({ "openai-chat-completions": { "kind": "openai-compatible", "name": "provider" } }),
                model(json!({})),
            ),
        ] {
            assert!(
                parse(&invalid).is_err(),
                "accepted invalid catalog: {invalid}"
            );
        }
    }
}
