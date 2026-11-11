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

use super::{Error, authentication::Method};
use maka_agent_facts::configuration::ModelInfo;
use maka_agent_facts::configuration::ModelOverride;
use maka_agent_facts::execution::ThinkingLevel;
use maka_agent_facts::model::request::ProviderKind;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Persistent user configuration is opaque to other providers, not a credential.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Connection {
    pub id: String,
    pub revision: u64,
    pub configuration: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Descriptor {
    pub label: String,
    /// Offers a user-selected endpoint instead of a named service.
    #[serde(default)]
    pub custom_endpoint: bool,
    pub configuration_schema: Value,
    pub configuration_defaults: Value,
    pub authentication: Vec<Method>,
    /// Whether the provider supports a connection without a stored credential.
    /// Presentation metadata; authorization remains the provider's decision.
    pub anonymous: bool,
    pub discovery: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_authentication: Option<UsageAuthentication>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum UsageAuthentication {
    Provider,
    AccessKey,
    TeamAccessKey,
}

impl Descriptor {
    pub fn validate(&self) -> Result<(), Error> {
        if self.label.trim().is_empty()
            || self.label.chars().any(char::is_control)
            || !self.configuration_schema.is_object()
            || !self.configuration_defaults.is_object()
        {
            return Err(Error::Invalid("invalid provider descriptor".into()));
        }
        let mut methods = std::collections::HashSet::new();
        for method in &self.authentication {
            method.validate()?;
            if !methods.insert(&method.id) {
                return Err(Error::Invalid("duplicate authentication method".into()));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Resolve {
    pub connection: Connection,
    pub model: ModelInfo,
    pub overrides: Option<ModelOverride>,
    pub thinking_level: Option<ThinkingLevel>,
}

/// Resolved protocol settings. No prompt, tools or credential writes are exposed.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Model {
    pub adapter: String,
    pub protocol: ProviderKind,
    pub base_url: String,
    pub info: ModelInfo,
    pub thinking_levels: Vec<ThinkingLevel>,
    pub provider_options: Value,
    /// Resolved reply budget, distinct from the model's advertised capacity.
    pub main_output_limit: Option<u64>,
}

impl Model {
    pub fn validate(&self) -> Result<(), Error> {
        crate::name(&self.adapter).map_err(|e| Error::Invalid(e.to_string()))?;
        maka_agent_facts::configuration::validation::normalize_base_url(&self.base_url)
            .map_err(Error::Invalid)?;
        self.info.validate().map_err(Error::Invalid)?;
        if let Some(limit) = self.main_output_limit {
            maka_agent_facts::configuration::validation::revision(limit, true)
                .map_err(Error::Invalid)?;
            if self
                .info
                .max_output_tokens
                .is_some_and(|capacity| limit > capacity)
            {
                return Err(Error::Invalid("reply budget exceeds model capacity".into()));
            }
        }
        if !self.provider_options.is_object() && !self.provider_options.is_null() {
            return Err(Error::Invalid("provider options must be an object".into()));
        }
        for (index, level) in self.thinking_levels.iter().enumerate() {
            if self.thinking_levels[..index].contains(level) {
                return Err(Error::Invalid("duplicate thinking level".into()));
            }
        }
        Ok(())
    }
}
