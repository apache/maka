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

//! Compiled API provider policies use explicit definitions and credential contracts.
use crate::facts::{self, AuthKind, ProviderFacts};
use futures_util::future::BoxFuture;
use maka_agent_facts::configuration::ApiProtocol as Wire;
use maka_agent_facts::configuration::ModelInfo;
use maka_agent_facts::configuration::ModelOverride;
use maka_agent_ports::provider::Connection;
use maka_agent_ports::provider::Definition;
use maka_agent_ports::provider::Descriptor;
use maka_agent_ports::provider::Error;
use maka_agent_ports::provider::Model;
use maka_agent_ports::provider::Provider;
use maka_agent_ports::provider::Resolve;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
mod authentication;
mod discovery;
mod effects;
mod inventory;
mod metadata;
mod options;
mod output;
mod preferred;
mod route;

pub const ID: &str = "maka.providers";

/// Catalog metadata and configured execution choices remain distinct: `info`
/// contains model facts; thinking policy includes the user's overrides.
pub struct ModelMetadata {
    pub info: ModelInfo,
    pub thinking_levels: Vec<maka_agent_facts::execution::ThinkingLevel>,
    pub default_thinking_level: Option<maka_agent_facts::execution::ThinkingLevel>,
}

pub struct ApiProviders;
impl ApiProviders {
    /// A compiled API implementation for a native application owner. Availability
    /// does not activate legacy contributions or grant execution authority.
    pub fn definition(
        id: &str,
        snapshot: Arc<crate::catalog::Snapshot>,
    ) -> Result<Definition, String> {
        Self::provider(id, snapshot)?.definition()
    }

    /// Selectable model metadata, checked by the same preparation policy as
    /// execution. No credentials or network access are needed. An invalid
    /// configured default is an error, never silently replaced by another level.
    pub fn model_metadata(
        id: &str,
        snapshot: Arc<crate::catalog::Snapshot>,
        connection: Connection,
        model: ModelInfo,
        overrides: Option<ModelOverride>,
    ) -> Result<ModelMetadata, String> {
        let provider = Self::provider(id, snapshot)?;
        let mut metadata = provider.model_metadata(model.clone(), overrides.as_ref());
        let mut request = Resolve {
            connection,
            model,
            overrides,
            thinking_level: None,
        };
        provider
            .prepare(request.clone())
            .map_err(|error| error.to_string())?;
        metadata.thinking_levels.retain(|level| {
            request.thinking_level = Some(*level);
            provider.prepare(request.clone()).is_ok()
        });
        Ok(metadata)
    }

    fn provider(id: &str, snapshot: Arc<crate::catalog::Snapshot>) -> Result<ApiProvider, String> {
        let (id, facts) = facts::all()
            .map_err(|error| error.to_string())?
            .iter()
            .find(|(name, facts)| {
                name.as_str() == id && !facts.retired && facts.auth_kind != AuthKind::OauthToken
            })
            .ok_or("API provider is unavailable")?;
        Ok(ApiProvider {
            id: id.as_str(),
            facts,
            snapshot,
        })
    }

    /// Available compiled API policies, without activating legacy contributions.
    pub fn names() -> Result<Vec<String>, String> {
        Ok(facts::all()
            .map_err(|error| error.to_string())?
            .iter()
            .filter(|(_, facts)| !facts.retired && facts.auth_kind != AuthKind::OauthToken)
            .map(|(name, _)| name.clone())
            .collect())
    }
}

#[derive(Clone)]
struct ApiProvider {
    id: &'static str,
    facts: &'static ProviderFacts,
    snapshot: Arc<crate::catalog::Snapshot>,
}

#[derive(Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Configuration {
    #[schemars(length(min = 1))]
    base_url: String,
}
impl Configuration {
    fn read(connection: &Connection) -> Result<Self, Error> {
        let mut configuration: Self = serde_json::from_value(connection.configuration.clone())
            .map_err(|_| Error::InvalidConfiguration)?;
        configuration.base_url = maka_agent_facts::configuration::validation::normalize_base_url(
            &configuration.base_url,
        )
        .map_err(|_| Error::InvalidConfiguration)?;
        Ok(configuration)
    }
}

/// Pure policy input, not a Host catalog or a credential handle.
struct Selection<'a> {
    provider: &'a str,
    connection: &'a Connection,
    base_url: &'a str,
    model: &'a ModelInfo,
    overrides: Option<&'a ModelOverride>,
}

impl ApiProvider {
    fn definition(&self) -> Result<Definition, String> {
        let authentication =
            authentication::methods(self.facts.auth_kind).map_err(|error| error.to_string())?;
        Definition::new(
            Descriptor {
                label: match self.id {
                    "openai-compatible" => "Chat Completions".into(),
                    "openai-responses-compatible" => "Responses".into(),
                    "anthropic-compatible" => "Anthropic Messages".into(),
                    _ => self.facts.label.clone(),
                },
                custom_endpoint: self.facts.base_url.is_empty(),
                configuration_schema: serde_json::to_value(schemars::schema_for!(Configuration))
                    .map_err(|error| error.to_string())?,
                configuration_defaults: if self.facts.base_url.is_empty() {
                    json!({})
                } else {
                    json!({"baseUrl":self.facts.base_url})
                },
                authentication,
                anonymous: matches!(
                    self.facts.auth_kind,
                    AuthKind::None | AuthKind::OptionalApiKey
                ),
                discovery: true,
            },
            Arc::new(self.clone()),
        )
        .map_err(|error| error.to_string())
    }

    fn model_metadata(&self, model: ModelInfo, overrides: Option<&ModelOverride>) -> ModelMetadata {
        let reported = metadata::enrich(
            &self.snapshot,
            self.id,
            model,
            overrides.and_then(|value| value.catalog_model.as_ref()),
        );
        let info =
            overrides.map_or_else(|| reported.clone(), |overrides| overrides.apply(&reported));
        let thinking_levels = overrides
            .and_then(|o| o.thinking_levels.clone())
            .or_else(|| info.thinking_levels.clone())
            .unwrap_or_default();
        let default_thinking_level = overrides.and_then(|o| o.default_thinking_level).or(info
            .default_thinking_level
            .filter(|level| thinking_levels.contains(level)));
        ModelMetadata {
            info,
            thinking_levels,
            default_thinking_level,
        }
    }

    fn prepare(&self, request: Resolve) -> Result<Model, Error> {
        let configuration = Configuration::read(&request.connection)?;
        let ModelMetadata {
            info,
            thinking_levels,
            default_thinking_level,
        } = self.model_metadata(request.model, request.overrides.as_ref());
        let selection = Selection {
            provider: self.id,
            connection: &request.connection,
            base_url: &configuration.base_url,
            model: &info,
            overrides: request.overrides.as_ref(),
        };
        let route = route::resolve(&selection, self.facts)?;
        route.check_execution()?;
        let level = request.thinking_level.or(default_thinking_level);
        if level.is_some_and(|level| !thinking_levels.contains(&level)) {
            return Err(Error::UnsupportedThinkingLevel);
        }
        let options = options::resolve(&selection, self.facts, &thinking_levels, level, &route)?;
        let output = output::resolve(&selection, route.wire, &options)?;
        let adapter = request
            .overrides
            .as_ref()
            .and_then(|o| o.adapter.clone())
            .unwrap_or_else(|| {
                match route.wire {
                    Wire::OpenaiChatCompletions => "chat-completions",
                    Wire::OpenaiResponses => "responses",
                    Wire::AnthropicMessages => "anthropic-messages",
                }
                .into()
            });
        let model = Model {
            adapter,
            protocol: route.kind,
            base_url: route.base_url,
            info,
            thinking_levels,
            provider_options: options,
            main_output_limit: output,
        };
        model.validate().map_err(|_| Error::InvalidPreparedModel)?;
        Ok(model)
    }
}

impl Provider for ApiProvider {
    fn resolve(&self, request: Resolve) -> BoxFuture<'_, Result<Model, Error>> {
        Box::pin(async move { self.prepare(request) })
    }

    fn authorize(
        &self,
        connection: Connection,
        credential: Option<maka_agent_facts::provider::Credential>,
        _: String,
    ) -> BoxFuture<'_, Result<maka_agent_ports::model::Credentials, Error>> {
        Box::pin(async move {
            Configuration::read(&connection)?;
            authentication::authorize(self.facts.auth_kind, credential)
        })
    }

    fn authenticate(
        &self,
        request: maka_agent_ports::provider::authentication::Authenticate,
        _: maka_agent_ports::provider::Context,
    ) -> BoxFuture<'_, Result<maka_agent_facts::provider::Credential, Error>> {
        Box::pin(async move {
            Configuration::read(&request.connection)?;
            authentication::authenticate(request)
        })
    }

    fn discover(
        &self,
        request: maka_agent_ports::provider::Discovery,
        context: maka_agent_ports::provider::Context,
    ) -> BoxFuture<'_, Result<Vec<ModelInfo>, Error>> {
        Box::pin(async move { effects::discover(self, request, context).await })
    }

    fn verify(
        &self,
        request: maka_agent_ports::provider::Verification,
        context: maka_agent_ports::provider::Context,
    ) -> BoxFuture<'_, Result<(), Error>> {
        Box::pin(async move { effects::verify(self, request, context).await })
    }
}
