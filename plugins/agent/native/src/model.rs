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

pub(crate) mod codex_inventory;
mod diagnostics;
pub(crate) mod oauth;

use futures_util::future::BoxFuture;
use maka_agent_engine::{ModelSource, PreparedModel, RunError};
use maka_agent_facts::composition::SourceRevision;
use maka_agent_facts::configuration::ModelInfo;
use maka_agent_facts::configuration::ModelOverride;
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

/// Transport identity stays valid independently of mutable request defaults.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecutionRoute {
    adapter: String,
    protocol: maka_agent_facts::model::request::ProviderKind,
    base_url: String,
}
impl ExecutionRoute {
    fn new(model: &Model) -> Self {
        Self {
            adapter: model.adapter.clone(),
            protocol: model.protocol.clone(),
            base_url: model.base_url.clone(),
        }
    }
    fn matches(&self, model: &Model) -> bool {
        self.adapter == model.adapter
            && self.protocol == model.protocol
            && self.base_url == model.base_url
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
    /// Public defaults at admission; account model observations are resolved per request.
    #[serde(deserialize_with = "Option::deserialize")]
    public_model: Option<ModelInfo>,
    provider: maka_agent_facts::provider::Identity,
    route: ExecutionRoute,
    model_override: Option<ModelOverride>,
    body_overlay: Option<Value>,
}
impl AcceptedModel {
    pub(crate) fn same_execution_route(&self, current: &Self) -> bool {
        self.binding.connection_id == current.binding.connection_id
            && self.binding.model == current.binding.model
            && self.provider == current.provider
            && self.route == current.route
    }
    /// Decodes accepted route data only; the current activation must restore its own authority.
    pub(crate) fn from_backend(
        backend: &maka_agent_facts::durable::BackendSpec,
        bytes: &[u8],
    ) -> Result<Self, RunError> {
        let maka_agent_facts::durable::BackendSpec::Model {
            binding,
            descriptor,
        } = backend
        else {
            return Err(RunError::InvalidInput("run backend is not a model".into()));
        };
        if descriptor.bytes != bytes.len() as u64
            || descriptor.digest != maka_agent_facts::artifact::content_digest(bytes)
        {
            return Err(RunError::ReconciliationRequired(
                "accepted model descriptor changed".into(),
            ));
        }
        let accepted: Self = serde_json::from_slice(bytes)
            .map_err(|error| RunError::InvalidInput(format!("invalid accepted model: {error}")))?;
        if &accepted.binding != binding {
            return Err(RunError::ReconciliationRequired(
                "accepted model binding changed".into(),
            ));
        }
        Ok(accepted)
    }
}

// The fixture starts at provider observation, not recorded requests or Host authority.
#[cfg(test)]
pub(crate) type Observation = fn(&ModelBinding, &mut Model) -> ModelRequestContext;

#[derive(Clone)]
pub(crate) struct Credentials {
    pub executor: maka_model::ModelExecutor,
    pub refresh: Arc<oauth::Authority>,
    pub inventory: Arc<codex_inventory::Authority>,
    #[cfg(test)]
    pub observation: Option<Observation>,
}
pub(crate) struct Source {
    configuration: Arc<ConfigurationStore>,
    pricing: Arc<dyn maka_agent_engine::pricing::Pricing>,
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
                .ok_or(RunError::ModelUnavailable)?;
            drop(public_guard);
            let define = |snapshot: &maka_providers::catalog::Snapshot,
                          row: &maka_agent_facts::configuration::ConnectionCatalogEntry| {
                let reference = row.model_overrides.as_ref().and_then(|models| models.get(&selection.model_id))
                    .and_then(|value| value.catalog_model.as_ref());
                let public_model = snapshot.model_base(&row.provider.name, &selection.model_id, reference)
                    .map(std::borrow::Cow::into_owned);
                let model_snapshot = Arc::new(maka_providers::catalog::Snapshot::for_model(
                    &row.provider.name, &selection.model_id, public_model.clone(),
                ).map_err(|_| unavailable())?);
                let definition = Arc::new(maka_providers::definition(&row.provider, model_snapshot).map_err(|_| {
                    tracing::warn!(stage = "provider_definition", cause = "provider_definition_unavailable",
                        provider = %row.provider.name, "Model preparation failed");
                    unavailable()
                })?);
                Ok::<_, RunError>((public_model, definition))
            };
            let (mut public_model, mut definition) = define(&snapshot, &material.connection)?;
            let row = &material.connection;
            let material = if row.provider.package_id == maka_providers::codex::ID
                && row.provider.name == "chatgpt"
            {
                let binding = ModelBinding {
                    connection_id: row.connection_id.clone(),
                    connection_slug: row.slug.clone(),
                    model: selection.model_id.clone(),
                };
                credentials.inventory.ensure(
                    configuration.clone(), credentials.clone(), definition.clone(),
                    binding.clone(), &material,
                ).await;
                let public_guard = catalog.snapshot.read().await;
                let current_snapshot = public_guard.as_ref().map_err(|_| unavailable())?;
                let current = configuration.observe_selected_model(selection.clone()).await
                    .map_err(|_| unavailable())?.ok_or(RunError::ModelUnavailable)?;
                (public_model, definition) = define(current_snapshot, &current.connection)?;
                current
            } else {
                material
            };
            let row = &material.connection;
            let binding = ModelBinding {
                connection_id: row.connection_id.clone(),
                connection_slug: row.slug.clone(),
                model: selection.model_id.clone(),
            };
            let model = resolve(
                &definition,
                row,
                &selection.model_id,
                thinking_level,
                row.model_overrides.as_ref().and_then(|models| models.get(&selection.model_id)),
            ).await?;
            #[cfg(test)]
            let model = {
                let mut model = model;
                if let Some(observe) = credentials.observation {
                    observe(&binding, &mut model);
                }
                model
            };
            revision.name = row.provider.name.clone();
            let source = Self {
                pricing:Arc::new(ConfigPricing(configuration.clone())),
                configuration,
                credentials,
                accepted: AcceptedModel {
                    public_model,
                    editing_tools: Some(editing_tools(row, &selection.model_id, &model.base_url)),
                    tool_mode: ToolMode::from_override(
                        row.model_overrides
                            .as_ref()
                            .and_then(|models| models.get(&selection.model_id))
                            .and_then(|overrides| overrides.code_mode),
                    ),
                    code_language: row.model_overrides.as_ref()
                        .and_then(|models| models.get(&selection.model_id))
                        .and_then(|overrides| overrides.code_mode_language)
                        .unwrap_or_default(),
                    binding,
                    thinking_level,
                    provider: row.provider.clone(),
                    route: ExecutionRoute::new(&model),
                    model_override: row.model_overrides.as_ref()
                        .and_then(|models| models.get(&model.info.id)).cloned(),
                    body_overlay: row.request_body_overlay.clone(),
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
            pricing: Arc::new(ConfigPricing(configuration.clone())),
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
        #[cfg(test)]
        let (model, observed_context) = {
            let mut model = model;
            let context = self
                .credentials
                .observation
                .map(|observe| observe(&self.accepted.binding, &mut model));
            (model, context)
        };
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
        let credential = match material.credential.as_ref() {
            Some(snapshot) if snapshot.credential().refresh_at.is_some() => Some(
                self.credentials
                    .refresh
                    .bind(snapshot.clone())
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
        let mut request_context =
            request_context(row, &model.info, self.accepted.model_override.as_ref())?;
        if self.accepted.provider.package_id == maka_providers::codex::ID
            && self.accepted.provider.name == "chatgpt"
        {
            let mut provenance = self
                .credentials
                .inventory
                .provenance(&material, &self.accepted.binding.model);
            let account_id = credential
                .as_ref()
                .map(maka_providers::codex::credential_account_id)
                .transpose()
                .map_err(|_| RunError::InvalidInput("agent_authentication_unavailable".into()))?
                .flatten();
            if provenance.account_id != account_id {
                provenance.compatibility = None;
            }
            provenance.account_id = account_id;
            request_context.codex = Some(provenance);
        }
        #[cfg(test)]
        if let Some(context) = observed_context {
            request_context = context;
        }
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
                image_input: model.info.image_input.clone(),
                kind: model.protocol,
                model: self.accepted.binding.model.clone(),
                base_url: model.base_url,
                auth,
                headers: material.request_headers,
                network,
                body_overlay: self
                    .accepted
                    .body_overlay
                    .as_ref()
                    .map(|value| value.as_object().expect("validated overlay").clone()),
            },
            options: model.provider_options,
            context: Some(request_context),
            main_output_limit: model.main_output_limit,
            supports_vision: capabilities.vision.unwrap_or(false),
            revision: self.revision.clone(),
        })
    }
}
fn request_context(
    row: &maka_agent_facts::configuration::ConnectionCatalogEntry,
    model: &ModelInfo,
    overrides: Option<&ModelOverride>,
) -> Result<ModelRequestContext, RunError> {
    if matches!((model.context_window, model.input_limit), (Some(capacity), Some(input)) if input > capacity)
    {
        tracing::warn!(stage = "request_context", cause = "input_limit_exceeds_context", connection_id = %row.connection_id, "Model preparation failed");
        return Err(unavailable());
    }
    let input =
        maka_agent_facts::context::effective_input_limit(model.context_window, model.input_limit);
    let context = ModelRequestContext {
        operation: maka_agent_facts::context::ModelOperation::Inference,
        codex: None,
        provider_id: row.provider.name.clone(),
        context_window: input,
        model_context_window: model.context_window,
        declared_window: overrides
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
        let material = if material.connection.provider.package_id == maka_providers::codex::ID
            && material.connection.provider.name == "chatgpt"
        {
            self.credentials
                .inventory
                .ensure(
                    self.configuration.clone(),
                    self.credentials.clone(),
                    self.definition.clone(),
                    self.accepted.binding.clone(),
                    &material,
                )
                .await;
            self.configuration
                .observe_model(self.accepted.binding.clone())
                .await
                .map_err(|_| unavailable())?
                .ok_or_else(unavailable)?
        } else {
            material
        };
        let row = &material.connection;
        if row.provider != self.accepted.provider {
            tracing::warn!(
                stage = "accepted_model_observation",
                cause = "accepted_provider_changed",
                "Model preparation failed"
            );
            return Err(unavailable());
        }
        let model = resolve(
            &self.definition,
            row,
            &self.accepted.binding.model,
            self.accepted.thinking_level,
            self.accepted.model_override.as_ref(),
        )
        .await?;
        #[cfg(test)]
        let model = {
            let mut model = model;
            if let Some(observe) = self.credentials.observation {
                observe(&self.accepted.binding, &mut model);
            }
            model
        };
        if !self.accepted.route.matches(&model) {
            tracing::warn!(
                stage = "accepted_model_observation",
                cause = "accepted_route_changed",
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
                        self.accepted.model_override.as_ref(),
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
    let model = resolve(
        &definition,
        row,
        &selection.model_id,
        thinking_level,
        row.model_overrides
            .as_ref()
            .and_then(|models| models.get(&selection.model_id)),
    )
    .await?;
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
    overrides: Option<&ModelOverride>,
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
            overrides: overrides.cloned(),
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

struct ConfigPricing(Arc<ConfigurationStore>);
impl maka_agent_engine::pricing::Pricing for ConfigPricing {
    fn quote<'a>(
        &'a self,
        provider: &'a str,
        model: &'a str,
    ) -> BoxFuture<'a, Result<maka_agent_facts::pricing::Quote, RunError>> {
        Box::pin(async move {
            self.0
                .quote_model(provider.to_owned(), model.to_owned())
                .await
                .map_err(|error| {
                    diagnostics::configuration("model_pricing", &error, None);
                    RunError::Internal(format!("model pricing snapshot unavailable: {error}"))
                })
        })
    }
}
impl Source {
    pub(crate) fn with_pricing(
        mut self,
        pricing: Arc<dyn maka_agent_engine::pricing::Pricing>,
    ) -> Self {
        self.pricing = pricing;
        self
    }
    pub(crate) async fn quote(
        &self,
        prepared: &PreparedModel,
    ) -> Result<maka_agent_facts::pricing::Quote, RunError> {
        self.pricing
            .quote(&prepared.provider_id, &prepared.provider.model)
            .await
    }
}

pub(crate) fn inference_outcome(
    error: &maka_model::ModelError,
) -> maka_agent_facts::accounting::Outcome {
    use maka_agent_facts::{
        accounting::Outcome,
        model::error::{ModelError, ProviderFailureReason},
    };
    match error {
        ModelError::Cancelled | ModelError::LocalAuthorization(_) => Outcome::Aborted,
        ModelError::Http { .. }
        | ModelError::ContextOverflow { .. }
        | ModelError::ImageInputPayloadTooLarge { .. }
        | ModelError::ImageInputRejected { .. } => Outcome::Error,
        ModelError::Provider(failure) => match failure.reason() {
            ProviderFailureReason::RateLimit
            | ProviderFailureReason::QuotaExhausted
            | ProviderFailureReason::ProviderUnavailable => Outcome::Error,
            ProviderFailureReason::Network
            | ProviderFailureReason::TimedOut
            | ProviderFailureReason::StreamTruncated => Outcome::Unknown,
        },
        ModelError::Adapter(_) | ModelError::TimedOut | ModelError::CleanupUnconfirmed => {
            Outcome::Unknown
        }
    }
}
