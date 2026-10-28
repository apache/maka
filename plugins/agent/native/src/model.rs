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

mod diagnostics;
pub(crate) mod oauth;

use futures_util::future::BoxFuture;
use maka_agent_engine::{ModelSource, PreparedModel, RunError};
use maka_agent_facts::composition::SourceRevision;
use maka_agent_facts::configuration::ModelCapabilities;
use maka_agent_facts::configuration::ModelInfo;
use maka_agent_facts::configuration::ModelSelection;
use maka_agent_facts::context::ModelRequestContext;
use maka_agent_facts::execution::EditingTools;
use maka_agent_facts::execution::ModelBinding;
use maka_agent_facts::execution::ThinkingLevel;
use maka_agent_facts::execution::ToolMode;
use maka_agent_ports::provider::Connection;
use maka_agent_ports::provider::Definition;
use maka_agent_ports::provider::Model;
use maka_agent_ports::provider::Resolve;
use maka_config::{ConfigurationStore, ConnectionObservation};
use maka_model::{ProviderAuth, ProviderConfig};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use tracing::Instrument;

/// Only parameters actually supplied to execution. Catalog labels, tests and
/// other models are observations, not a mutable authority over an accepted run.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecutionBasis {
    adapter: String,
    protocol: maka_agent_facts::model::request::ProviderKind,
    base_url: String,
    capabilities: ModelCapabilities,
    options: Value,
    main_output_limit: Option<u64>,
    body_overlay: Option<Value>,
}
impl ExecutionBasis {
    fn new(model: &Model, row: &maka_agent_facts::configuration::ConnectionCatalogEntry) -> Self {
        Self {
            adapter: model.adapter.clone(),
            protocol: model.protocol.clone(),
            base_url: model.base_url.clone(),
            capabilities: model.info.capabilities.unwrap_or_default(),
            options: model.provider_options.clone(),
            main_output_limit: model.main_output_limit,
            body_overlay: row.request_body_overlay.clone(),
        }
    }
}
/// Accepted route facts, without credentials or live activation handles.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AcceptedModel {
    pub binding: ModelBinding,
    pub thinking_level: Option<ThinkingLevel>,
    /// Execution policy is captured at message admission. Later model settings
    /// do not reinterpret queued work.
    pub tool_mode: ToolMode,
    #[serde(
        default,
        skip_serializing_if = "maka_agent_facts::execution::CodeLanguage::is_javascript"
    )]
    pub code_language: maka_agent_facts::execution::CodeLanguage,
    /// None captures an unfiltered tool selection.
    #[serde(deserialize_with = "Option::deserialize")]
    pub editing_tools: Option<EditingTools>,
    context: ModelRequestContext,
    /// Public defaults at admission only; account reports and overrides stay live.
    #[serde(deserialize_with = "Option::deserialize")]
    public_model: Option<ModelInfo>,
    provider: maka_agent_facts::provider::Identity,
    provider_configuration: Value,
    basis: ExecutionBasis,
}
#[derive(Clone)]
pub(crate) struct Credentials {
    pub executor: maka_model::ModelExecutor,
    pub refresh: Arc<oauth::Authority>,
}
pub(crate) struct Source {
    configuration: Arc<ConfigurationStore>,
    credentials: Credentials,
    pub accepted: AcceptedModel,
    definition: Arc<Definition>,
    session: String,
    revision: SourceRevision,
}
impl Source {
    pub async fn select(
        configuration: Arc<ConfigurationStore>,
        catalog: Arc<maka_providers::catalog::Catalog>,
        credentials: Credentials,
        selection: ModelSelection,
        thinking_level: Option<ThinkingLevel>,
        session: String,
        mut revision: SourceRevision,
    ) -> Result<(Self, PreparedModel), RunError> {
        let span = tracing::warn_span!("agent_model_preparation", session_id = %session,
            connection_id = %selection.connection_id, activation = %revision.activation);
        async move {
            let public_guard = catalog.snapshot.read().await;
            let snapshot = public_guard.as_ref().map_err(|_| unavailable())?.clone();
            let material = configuration
                .observe_selected_model(selection.clone())
                .await
                .map_err(|error| {
                    diagnostics::configuration("selected_model_observation", &error, Some(&selection.connection_id));
                    unavailable()
                })?
                .ok_or_else(unavailable)?;
            drop(public_guard);
            let row = &material.connection;
            let public_model = snapshot.get(&row.provider.name, &selection.model_id).cloned();
            let snapshot = Arc::new(maka_providers::catalog::Snapshot::for_model(
                &row.provider.name, &selection.model_id, public_model.clone(),
            ).map_err(|_| unavailable())?);
            let definition =
                Arc::new(maka_providers::definition(&row.provider, snapshot).map_err(|_| {
                    tracing::warn!(stage = "provider_definition", cause = "provider_definition_unavailable",
                        provider = %row.provider.name, "Model preparation failed");
                    unavailable()
                })?);
            let model = resolve(&definition, row, &selection.model_id, thinking_level).await?;
            revision.name = row.provider.name.clone();
            let source = Self {
                configuration,
                credentials,
                accepted: AcceptedModel {
                    context: request_context(row, &model.info)?,
                    public_model,
                    editing_tools: Some(editing_tools(row, &selection.model_id, &model.base_url)),
                    tool_mode: ToolMode::for_model(
                        &selection.model_id,
                        &model.base_url,
                        row.model_overrides
                            .as_ref()
                            .and_then(|models| models.get(&selection.model_id))
                            .and_then(|overrides| overrides.code_mode),
                    ),
                    code_language: row.model_overrides.as_ref()
                        .and_then(|models| models.get(&selection.model_id))
                        .and_then(|overrides| overrides.code_mode_language)
                        .unwrap_or_default(),
                    binding: ModelBinding {
                        connection_id: row.connection_id.clone(),
                        connection_slug: row.slug.clone(),
                        model: selection.model_id,
                    },
                    thinking_level,
                    provider: row.provider.clone(),
                    provider_configuration: row.configuration.clone(),
                    basis: ExecutionBasis::new(&model, row),
                },
                definition,
                session,
                revision,
            };
            let prepared = source.prepare(material, model).await?;
            Ok((source, prepared))
        }.instrument(span).await
    }

    pub fn restore(
        configuration: Arc<ConfigurationStore>,
        credentials: Credentials,
        accepted: AcceptedModel,
        session: String,
        mut revision: SourceRevision,
    ) -> Result<Self, RunError> {
        let _span = tracing::warn_span!("agent_model_preparation", session_id = %session,
            connection_id = %accepted.binding.connection_id, activation = %revision.activation)
        .entered();
        let snapshot = maka_providers::catalog::Snapshot::for_model(
            &accepted.provider.name,
            &accepted.binding.model,
            accepted.public_model.clone(),
        )
        .map_err(|_| unavailable())?;
        let definition =
            Arc::new(maka_providers::definition(&accepted.provider, Arc::new(snapshot)).map_err(|_| {
                tracing::warn!(stage = "restore_provider_definition", cause = "provider_definition_unavailable",
                    provider = %accepted.provider.name, "Model preparation failed");
                unavailable()
            })?);
        revision.name = accepted.provider.name.clone();
        Ok(Self {
            configuration,
            credentials,
            accepted,
            definition,
            session,
            revision,
        })
    }
    async fn prepare(
        &self,
        material: ConnectionObservation,
        model: Model,
    ) -> Result<PreparedModel, RunError> {
        let capabilities = model.info.capabilities.unwrap_or_default();
        if capabilities.chat == Some(false) {
            tracing::warn!(
                stage = "model_capabilities",
                cause = "chat_unsupported",
                "Model preparation failed"
            );
            return Err(unavailable());
        }
        let row = &material.connection;
        let network = maka_network::Policy::from_host_settings(
            &material.network.proxy,
            material.network.password.as_deref(),
        )
        .map_err(|error| {
            diagnostics::network(
                "network_policy",
                &error,
                &self.accepted.binding.connection_id,
            );
            unavailable()
        })?;
        let credential = match material.credential {
            Some(snapshot) if snapshot.credential().refresh_at.is_some() => Some(
                self.credentials
                    .refresh
                    .bind(snapshot)
                    .map_err(|_| RunError::InvalidInput("agent_authentication_unavailable".into()))?
                    .resolve_native(
                        self.accepted.provider.clone(),
                        self.definition.clone(),
                        maka_agent_ports::provider::Context {
                            transport: self.credentials.executor.transport(&network).map_err(
                                |error| {
                                    diagnostics::model(
                                        "credential_transport",
                                        &error,
                                        &self.accepted.binding.connection_id,
                                    );
                                    unavailable()
                                },
                            )?,
                            cancellation: tokio_util::sync::CancellationToken::new(),
                            interaction: None,
                        },
                    )
                    .await
                    .map_err(|_| RunError::InvalidInput("agent_authentication_unavailable".into()))?
                    .credential()
                    .clone(),
            ),
            Some(snapshot) => Some(snapshot.credential().clone()),
            None => None,
        };
        let credentials = self
            .definition
            .authorize(connection(row), credential, self.session.clone())
            .await
            .map_err(|error| {
                diagnostics::provider(
                    "provider_authorize",
                    &error,
                    &row.connection_id,
                    &row.provider.name,
                );
                RunError::InvalidInput("agent_authentication_unavailable".into())
            })?;
        let auth = match credentials {
            maka_agent_ports::model::Credentials::ApiKey(key) => ProviderAuth::ApiKey(key),
            maka_agent_ports::model::Credentials::RequestHeaders(headers) => {
                ProviderAuth::RequestHeaders(headers)
            }
        };
        Ok(PreparedModel {
            provider_id: self.accepted.provider.name.clone(),
            provider: ProviderConfig {
                adapter: Some(model.adapter),
                capabilities,
                kind: model.protocol,
                model: self.accepted.binding.model.clone(),
                base_url: model.base_url,
                auth,
                headers: material.request_headers,
                network,
                body_overlay: row
                    .request_body_overlay
                    .as_ref()
                    .map(|value| value.as_object().expect("validated overlay").clone()),
            },
            options: model.provider_options,
            context: Some(self.accepted.context.clone()),
            main_output_limit: model.main_output_limit,
            supports_vision: capabilities.vision.unwrap_or(false),
            revision: self.revision.clone(),
        })
    }
}
fn request_context(
    row: &maka_agent_facts::configuration::ConnectionCatalogEntry,
    model: &ModelInfo,
) -> Result<ModelRequestContext, RunError> {
    if matches!((model.context_window, model.input_limit), (Some(capacity), Some(input)) if input > capacity)
    {
        tracing::warn!(stage = "request_context", cause = "input_limit_exceeds_context", connection_id = %row.connection_id, "Model preparation failed");
        return Err(unavailable());
    }
    let input =
        maka_agent_facts::context::effective_input_limit(model.context_window, model.input_limit);
    let context = ModelRequestContext {
        provider_id: row.provider.name.clone(),
        context_window: input,
        model_context_window: model.context_window,
        declared_window: row
            .model_overrides
            .as_ref()
            .and_then(|models| models.get(&model.id))
            .and_then(|profile| profile.compaction_threshold)
            .or_else(|| {
                maka_agent_facts::context::default_compaction_threshold(
                    model.context_window,
                    model.input_limit,
                )
            }),
    };
    context.validate().map_err(|_| {
        tracing::warn!(stage = "request_context", cause = "request_context_invalid", connection_id = %row.connection_id, "Model preparation failed");
        unavailable()
    })?;
    Ok(context)
}
impl Source {
    fn preparation_span(&self) -> tracing::Span {
        tracing::warn_span!("agent_model_preparation", session_id = %self.session,
            connection_id = %self.accepted.binding.connection_id, activation = %self.revision.activation,
            provider = %self.accepted.provider.name)
    }
    async fn observe(&self) -> Result<(ConnectionObservation, Model), RunError> {
        let material = self
            .configuration
            .observe_model(self.accepted.binding.clone())
            .await
            .map_err(|error| {
                diagnostics::configuration(
                    "accepted_model_observation",
                    &error,
                    Some(&self.accepted.binding.connection_id),
                );
                unavailable()
            })?
            .ok_or_else(|| {
                tracing::warn!(
                    stage = "accepted_model_observation",
                    cause = "accepted_source_unavailable",
                    "Model preparation failed"
                );
                unavailable()
            })?;
        let row = &material.connection;
        if row.provider != self.accepted.provider {
            tracing::warn!(
                stage = "accepted_model_observation",
                cause = "accepted_provider_changed",
                "Model preparation failed"
            );
            return Err(unavailable());
        }
        if row.configuration != self.accepted.provider_configuration {
            tracing::warn!(
                stage = "accepted_model_observation",
                cause = "accepted_configuration_changed",
                "Model preparation failed"
            );
            return Err(unavailable());
        }
        let model = resolve(
            &self.definition,
            row,
            &self.accepted.binding.model,
            self.accepted.thinking_level,
        )
        .await?;
        if ExecutionBasis::new(&model, row) != self.accepted.basis {
            tracing::warn!(
                stage = "accepted_model_observation",
                cause = "accepted_execution_basis_changed",
                "Model preparation failed"
            );
            return Err(unavailable());
        }
        Ok((material, model))
    }
    /// The original accepted route, with the least declared reasoning for a short auxiliary task.
    pub(crate) async fn capture_auxiliary(&self) -> Result<PreparedModel, RunError> {
        async {
            let (material, model) = self.observe().await?;
            let least = ThinkingLevel::ALL
                .into_iter()
                .find(|level| model.thinking_levels.contains(level));
            let model = match least {
                Some(level) => {
                    resolve(
                        &self.definition,
                        &material.connection,
                        &self.accepted.binding.model,
                        Some(level),
                    )
                    .await?
                }
                None => model,
            };
            self.prepare(material, model).await
        }
        .instrument(self.preparation_span())
        .await
    }
}
impl ModelSource for Source {
    fn capture(&self) -> BoxFuture<'_, Result<PreparedModel, RunError>> {
        Box::pin(
            async move {
                let (material, model) = self.observe().await?;
                self.prepare(material, model).await
            }
            .instrument(self.preparation_span()),
        )
    }
}

/// Resolve tool compatibility without preparing credentials or starting execution.
pub(crate) async fn candidate_editing_tools(
    configuration: &Arc<ConfigurationStore>,
    catalog: &maka_providers::catalog::Catalog,
    selection: ModelSelection,
    thinking_level: Option<ThinkingLevel>,
) -> Result<EditingTools, RunError> {
    let public_guard = catalog.snapshot.read().await;
    let snapshot = public_guard.as_ref().map_err(|_| unavailable())?.clone();
    let material = configuration
        .observe_selected_model(selection.clone())
        .await
        .map_err(|error| {
            diagnostics::configuration(
                "candidate_model_observation",
                &error,
                Some(&selection.connection_id),
            );
            unavailable()
        })?
        .ok_or_else(unavailable)?;
    drop(public_guard);
    let row = &material.connection;
    let definition = maka_providers::definition(&row.provider, snapshot).map_err(|_| {
        tracing::warn!(stage = "provider_definition", cause = "provider_definition_unavailable", connection_id = %row.connection_id,
            provider = %row.provider.name, "Model preparation failed");
        unavailable()
    })?;
    let model = resolve(&definition, row, &selection.model_id, thinking_level).await?;
    Ok(editing_tools(row, &selection.model_id, &model.base_url))
}
fn editing_tools(
    row: &maka_agent_facts::configuration::ConnectionCatalogEntry,
    model: &str,
    base_url: &str,
) -> EditingTools {
    EditingTools::for_model(
        model,
        base_url,
        row.model_overrides
            .as_ref()
            .and_then(|models| models.get(model))
            .and_then(|overrides| overrides.apply_patch),
    )
}

async fn resolve(
    definition: &Definition,
    row: &maka_agent_facts::configuration::ConnectionCatalogEntry,
    model: &str,
    thinking_level: Option<ThinkingLevel>,
) -> Result<Model, RunError> {
    definition
        .prepare(Resolve {
            connection: connection(row),
            model: row
                .models
                .iter()
                .find(|info| info.id == model)
                .cloned()
                .unwrap_or_else(|| ModelInfo::new(model)),
            overrides: row
                .model_overrides
                .as_ref()
                .and_then(|models| models.get(model))
                .cloned(),
            thinking_level,
        })
        .await
        .map_err(|error| {
            diagnostics::provider(
                "provider_prepare",
                &error,
                &row.connection_id,
                &row.provider.name,
            );
            unavailable()
        })
}
fn connection(row: &maka_agent_facts::configuration::ConnectionCatalogEntry) -> Connection {
    Connection {
        id: row.connection_id.clone(),
        revision: row.revision,
        configuration: row.configuration.clone(),
    }
}
fn unavailable() -> RunError {
    RunError::InvalidInput("agent_model_unavailable".into())
}

/// Capture the actual Root rate decision for every physical provider request.
pub(crate) struct Prices(pub Arc<ConfigurationStore>);
impl maka_agent_engine::pricing::Pricing for Prices {
    fn quote<'a>(
        &'a self,
        provider: &'a str,
        model: &'a str,
    ) -> BoxFuture<'a, Result<maka_agent_facts::pricing::Quote, RunError>> {
        Box::pin(
            async move {
                self.0
                    .quote_model(provider.into(), model.into())
                    .await
                    .map_err(|error| {
                        diagnostics::configuration("model_pricing", &error, None);
                        match error {
                            maka_config::ConfigError::CommitUnknown => {
                                maka_agent_facts::event::CommitError::OutcomeUnknown(
                                    error.to_string(),
                                )
                                .into()
                            }
                            _ => RunError::Internal("model pricing unavailable".into()),
                        }
                    })
            }
            .instrument(tracing::warn_span!(
                "agent_model_pricing",
                provider,
                model_id = model
            )),
        )
    }
}
