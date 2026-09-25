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

use crate::session::SessionConfiguration;
use maka_model::ProviderConfig;
use maka_plugins::provider::{Binding as ProviderBinding, Connection, Resolve};
use maka_protocol::{OperationError, OperationErrorCode};
use maka_runtime::{configuration::*, context::ModelRequestContext, scope::Scope};
use serde_json::Value;
use std::sync::Arc;

mod auth;
mod context;

pub(super) struct PreparedProvider {
    pub source: Arc<Source>,
    pub revision: maka_runtime::composition::SourceRevision,
    pub provider_id: String,
    pub tool_mode: maka_runtime::execution::ToolMode,
    pub editing_tools: maka_runtime::execution::EditingTools,
    pub config: ProviderConfig,
    pub options: Value,
    pub supports_vision: bool,
    pub context: ModelRequestContext,
    pub main_output_limit: Option<u64>,
    binding: Arc<auth::Binding>,
}

impl PreparedProvider {
    pub(super) fn admit(self, oauth: &crate::oauth::Authority) -> Result<Self, OperationError> {
        self.binding.admit(oauth)?;
        Ok(self)
    }
}

fn unavailable(message: impl Into<String>) -> OperationError {
    OperationError {
        code: OperationErrorCode::OperationUnavailable,
        message: message.into(),
    }
}

pub(super) async fn resolve(
    executions: &super::Executions,
    session_id: &str,
    session: &SessionConfiguration,
) -> Result<PreparedProvider, OperationError> {
    observe(executions, session_id, session)
        .await?
        .admit(&executions.oauth)
}

/// Observe configuration and credentials without granting execution authority.
pub(super) async fn observe(
    executions: &super::Executions,
    session_id: &str,
    session: &SessionConfiguration,
) -> Result<PreparedProvider, OperationError> {
    let model = session
        .target
        .model()
        .ok_or_else(|| unavailable("Executor Session has no model backend"))?;
    observe_binding(executions, session_id, model, session.thinking_level).await
}

/// The caller supplies the admitted model identity, never a replacement Session.
pub(super) async fn observe_binding(
    executions: &super::Executions,
    session_id: &str,
    target: &maka_runtime::execution::ModelBinding,
    thinking_level: Option<maka_runtime::execution::ThinkingLevel>,
) -> Result<PreparedProvider, OperationError> {
    Source {
        configuration: executions.configuration.clone(),
        models: executions.models.clone(),
        plugin_catalog: executions.plugin_catalog.clone(),
        oauth: executions.oauth.clone(),
        session_id: session_id.into(),
        target: target.clone(),
        thinking_level,
    }
    .observe()
    .await
}

#[derive(Clone)]
pub(super) struct Source {
    configuration: Arc<maka_config::ConfigurationStore>,
    models: maka_model::ModelExecutor,
    plugin_catalog: maka_plugins::contributions::Catalog,
    oauth: Arc<crate::oauth::Authority>,
    session_id: String,
    target: maka_runtime::execution::ModelBinding,
    thinking_level: Option<maka_runtime::execution::ThinkingLevel>,
}

impl maka_agent::ModelSource for Source {
    fn capture(
        &self,
    ) -> futures_util::future::BoxFuture<'_, Result<maka_agent::PreparedModel, maka_agent::RunError>>
    {
        Box::pin(async move {
            let prepared = self
                .observe()
                .await
                .and_then(|prepared| prepared.admit(&self.oauth))
                .map_err(|error| {
                    maka_agent::RunError::Model(maka_model::ModelError::Adapter(error.message))
                })?;
            Ok(maka_agent::PreparedModel {
                provider_id: prepared.provider_id,
                provider: prepared.config,
                options: prepared.options,
                context: Some(prepared.context),
                main_output_limit: prepared.main_output_limit,
                supports_vision: prepared.supports_vision,
                revision: prepared.revision,
            })
        })
    }
}

impl Source {
    async fn observe(&self) -> Result<PreparedProvider, OperationError> {
        let session_id = self.session_id.as_str();
        let target = &self.target;
        let thinking_level = self.thinking_level;
        // One targeted SQL snapshot supplies configuration, credentials, headers
        // and proxy without scanning the catalog on every logical model step.
        let material = self
            .configuration
            .observe_model(target.clone())
            .await
            .map_err(crate::server::configuration::failure)?
            .ok_or_else(|| {
                unavailable("Session model connection or enabled model is unavailable")
            })?;
        let row = &material.connection;
        match &row.provider.scope {
            Scope::Profile => {}
            Scope::Session(owner) if owner == session_id => {}
            _ => return Err(unavailable("Model provider is outside the execution scope")),
        }
        let provider = ProviderBinding::resolve(&row.provider, &self.plugin_catalog)
            .map_err(|error| unavailable(error.to_string()))?;
        let revision = provider
            .source()
            .map_err(|error| unavailable(error.to_string()))?;
        let overrides = row
            .model_overrides
            .as_ref()
            .and_then(|models| models.get(&target.model));
        let reported = row
            .models
            .iter()
            .find(|model| model.id == target.model)
            .cloned()
            .unwrap_or_else(|| ModelInfo::new(&target.model));
        let model = provider
            .prepare(Resolve {
                connection: Connection {
                    id: row.connection_id.clone(),
                    revision: row.revision,
                    configuration: row.configuration.clone(),
                },
                model: reported,
                overrides: overrides.cloned(),
                thinking_level,
            })
            .await
            .map_err(|error| unavailable(error.to_string()))?;
        let capabilities = model.info.capabilities.unwrap_or_default();
        let no_text = model.info.modalities.as_ref().is_some_and(|modalities| {
            !modalities.output.is_empty() && !modalities.output.contains(&ModelModality::Text)
        });
        if capabilities.chat == Some(false)
            || (capabilities.chat != Some(true) && no_text)
            || (capabilities.image_generation == Some(true)
                && capabilities.chat != Some(true)
                && capabilities.reasoning != Some(true)
                && capabilities.function_calling != Some(true))
        {
            return Err(unavailable("Selected model does not support conversation"));
        }
        if thinking_level.is_some_and(|level| !model.thinking_levels.contains(&level)) {
            return Err(unavailable("Session thinking level is no longer supported"));
        }
        let tool_mode = maka_runtime::execution::ToolMode::for_model(
            &target.model,
            &model.base_url,
            overrides.and_then(|value| value.code_mode),
        );
        let editing_tools = maka_runtime::execution::EditingTools::for_model(
            &target.model,
            &model.base_url,
            overrides.and_then(|value| value.apply_patch),
        );
        let context = context::resolve(row, &model.info)?;
        let main_output_limit = Some(context::output_limit(&model)?);
        let binding = auth::observe(&self.models, provider, &material, session_id)?;
        let network = maka_network::Policy::from_host_settings(
            &material.network.proxy,
            material.network.password.as_deref(),
        )
        .map_err(|error| unavailable(error.to_string()))?;
        let config = ProviderConfig {
            adapter: Some(model.adapter),
            capabilities,
            kind: model.protocol,
            model: target.model.clone(),
            base_url: model.base_url,
            auth: binding.auth()?,
            headers: material.request_headers,
            network,
            body_overlay: row.request_body_overlay.as_ref().map(|value| {
                value
                    .as_object()
                    .expect("validated request body overlay")
                    .clone()
            }),
        };
        self.models
            .binding_in_scope(&config, &Scope::Session(session_id.into()))
            .map_err(|error| unavailable(error.to_string()))?;
        Ok(PreparedProvider {
            source: Arc::new(self.clone()),
            revision,
            provider_id: row.provider.name.clone(),
            tool_mode,
            editing_tools,
            binding,
            config,
            options: model.provider_options,
            supports_vision: capabilities.vision.unwrap_or(false),
            context,
            main_output_limit,
        })
    }
}
