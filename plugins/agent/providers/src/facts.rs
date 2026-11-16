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

impl ProviderFacts {
    pub(crate) fn select_adapter<'a>(
        &'a self,
        override_: Option<&'a ModelRuntimeOverride>,
        requested_wire: Option<ApiProtocol>,
    ) -> Result<(ApiProtocol, &'a RuntimeAdapter, bool)> {
        let base = override_.map_or(&self.runtime_adapter, |value| &value.adapter);
        let base_wire = base.wire()?;
        let wire = requested_wire.unwrap_or(base_wire);
        if wire == base_wire {
            return Ok((wire, base, override_.is_some()));
        }
        if let Some(alternate) = self.protocol_adapters.get(&wire) {
            return Ok((wire, alternate, false));
        }
        if self.runtime_adapter.wire().ok() == Some(wire) {
            return Ok((wire, &self.runtime_adapter, false));
        }
        Err(Error::UnsupportedProtocol)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
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
        for (wire, alternate) in &provider.protocol_adapters {
            if alternate.wire().ok() != Some(*wire) {
                return Err(format!(
                    "{provider_id}: protocolAdapter for {wire:?} does not match adapter protocol"
                ));
            }
        }
        for (model_id, model) in &provider.models {
            let Some(wire) = model.api_protocol else {
                continue;
            };
            if provider
                .select_adapter(model.runtime_override.as_ref(), Some(wire))
                .is_err()
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
