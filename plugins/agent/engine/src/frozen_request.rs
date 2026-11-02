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

//! Rehydrate one original Main request without crossing a new request boundary.

use crate::{RunContext, RunError, RunSettings, model_attempt, prepared_prompt::PreparedPrompt};
use maka_agent_facts::{
    composition::{SourceKind, SourceRevision},
    context::ModelPurpose,
    event::{Fact, InvocationInput},
};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub(super) struct FrozenRequest<'tools> {
    pub input: RunSettings,
    pub source: model_attempt::RequestSource,
    pub prompt: PreparedPrompt,
    pub surface: Arc<crate::request_composition::Surface>,
    pub tools: maka_tools::RequestTools<'tools>,
}

fn same_source(left: &SourceRevision, right: &SourceRevision) -> bool {
    left.kind == right.kind
        && left.name == right.name
        && left.package_id == right.package_id
        && left.entry_id == right.entry_id
        && left.revision == right.revision
}

/// Native must first validate the saved accepted binding basis against its current
/// registry, then issue `tools` with fresh execution custody and the current ceiling.
/// Reading historical evidence never authorizes another attempt or any old tool call.
pub(super) async fn rehydrate_frozen_request<'tools>(
    inner: &RunContext,
    original: &str,
    fresh: &RunSettings,
    tools: &'tools maka_tools::RunTools,
    cancellation: &CancellationToken,
) -> Result<FrozenRequest<'tools>, RunError> {
    let frozen = inner
        .log
        .read_frozen_model_request(&fresh.invocation, original)
        .await?;
    let adapter = inner.shared.model.binding(&fresh.provider)?;
    let replay = FrozenReplay::new(inner, fresh, original.to_owned(), adapter.clone());
    let checked = replay.check(frozen)?;
    let frozen = &checked.0;
    let Fact::ModelRequested { context, .. } = &frozen.request.event.fact else {
        unreachable!("checked Main request");
    };
    let Fact::InvocationOpened {
        configuration: Some(configuration),
        ..
    } = &frozen.opening.fact
    else {
        unreachable!("checked opening configuration");
    };
    let mut input = fresh.clone();
    // Restoring projection settings does not restore historical authority.
    input.configuration = configuration.as_ref().clone();
    input.context = context.clone();
    input.provider_options = frozen
        .composition
        .provider_options
        .clone()
        .expect("checked options");
    let request_tools = tools
        .capture_frozen(
            &input.configuration.cwd,
            &frozen.composition,
            cancellation.clone(),
        )
        .await?;
    let surface = Arc::new(crate::request_composition::Surface::rehydrate(
        adapter,
        &frozen.composition,
        frozen.request.event.id.clone(),
        frozen.composition_digest.clone(),
    ));
    let source = model_attempt::RequestSource::from(&frozen.view);
    let prompt = replay.prepare_checked(checked, cancellation).await?;
    Ok(FrozenRequest {
        input,
        source,
        prompt,
        surface,
        tools: request_tools,
    })
}

/// Byte reconstruction for one still-live execution. Unlike activation recovery,
/// this neither captures tools again nor issues authority from historical facts.
pub(super) struct FrozenReplay {
    log: Arc<maka_event_log::root_store::SessionStore>,
    resources: maka_model::ModelPreparationResources,
    invocation: maka_agent_facts::event::Invocation,
    original: String,
    provider: Arc<maka_model::ProviderConfig>,
    adapter: maka_agent_ports::model::Binding,
    revision: Option<SourceRevision>,
}
struct CheckedFrozen(maka_event_log::context::FrozenModelRequest);

impl FrozenReplay {
    pub fn new(
        inner: &RunContext,
        input: &RunSettings,
        original: String,
        adapter: maka_agent_ports::model::Binding,
    ) -> Self {
        Self {
            log: inner.log.clone(),
            resources: inner.shared.preparation_resources.clone(),
            invocation: input.invocation.clone(),
            original,
            provider: Arc::new(input.provider.clone()),
            adapter,
            revision: input.model_revision.clone(),
        }
    }

    pub async fn prepared(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<PreparedPrompt, RunError> {
        if cancellation.is_cancelled() {
            return Err(RunError::Cancelled);
        }
        let frozen = self
            .log
            .read_frozen_model_request(&self.invocation, &self.original)
            .await?;
        self.prepare_checked(self.check(frozen)?, cancellation)
            .await
    }

    fn check(
        &self,
        frozen: maka_event_log::context::FrozenModelRequest,
    ) -> Result<CheckedFrozen, RunError> {
        let Fact::ModelRequested {
            model_id,
            route_identity,
            item_acceptance,
            ..
        } = &frozen.request.event.fact
        else {
            unreachable!("store returns a checked Main request");
        };
        if !matches!(
            &frozen.opening.fact,
            Fact::InvocationOpened {
                configuration: Some(_),
                ..
            }
        ) {
            return Err(RunError::ReconciliationRequired(
                "frozen request has no opening configuration".into(),
            ));
        }
        if frozen.composition.provider_options.is_none() {
            return Err(RunError::ReconciliationRequired(
                "frozen request has no provider options".into(),
            ));
        }
        if self.provider.model != *model_id
            || crate::runner::digest(self.provider.as_ref())? != *route_identity
            || self.adapter.supports_item_acceptance() != *item_acceptance
        {
            return Err(RunError::ReconciliationRequired(
                "frozen request route or acceptance contract changed".into(),
            ));
        }
        for source in frozen.composition.sources.iter().filter(|source| {
            matches!(
                source.kind,
                SourceKind::ModelAdapter | SourceKind::ModelProvider
            )
        }) {
            if !std::iter::once(self.adapter.source())
                .chain(self.revision.as_ref())
                .any(|candidate| same_source(source, candidate))
            {
                return Err(RunError::ReconciliationRequired(
                    "frozen request model implementation changed".into(),
                ));
            }
        }
        Ok(CheckedFrozen(frozen))
    }

    async fn prepare_checked(
        &self,
        checked: CheckedFrozen,
        cancellation: &CancellationToken,
    ) -> Result<PreparedPrompt, RunError> {
        let frozen = checked.0;
        let Fact::ModelRequested {
            input_digest,
            route_identity,
            context,
            source_capture,
            ..
        } = &frozen.request.event.fact
        else {
            unreachable!("store returns a checked Main request");
        };
        let Fact::InvocationOpened {
            configuration: Some(configuration),
            input: opening,
        } = &frozen.opening.fact
        else {
            unreachable!("checked opening configuration");
        };
        let options = frozen
            .composition
            .provider_options
            .as_ref()
            .expect("checked options");
        let settings = model_attempt::PromptSettings {
            language: configuration.language,
            provider: &self.provider,
            options,
            context_window: context
                .as_ref()
                .and_then(|context| context.model_context_window),
        };
        let base = match opening {
            InvocationInput::Continuation { claim, .. } => Some(claim.base.high_water),
            InvocationInput::Handoff { pause, .. } => pause.execution.replay_base,
            InvocationInput::Message { .. } => None,
            _ => unreachable!("store checked the opening input"),
        };
        let system = crate::request_composition::render_system(
            frozen.composition.system_prompt.as_deref(),
            &frozen.composition.dynamic_context,
        )
        .map(Arc::new);
        let definitions = frozen.composition.tools;
        let max_output_tokens = frozen.composition.max_output_tokens;
        let mut prompt = model_attempt::prompt_with_resources(
            &self.log,
            self.resources.clone(),
            &settings,
            &Arc::new(frozen.view),
            cancellation,
            base,
            &self.invocation.invocation_id,
            source_capture.prior_unknown,
            system,
            ModelPurpose::Main,
        )
        .await?;
        let prepared = async {
            model_attempt::prepare_wire_with_settings(
                &settings,
                &mut prompt,
                &definitions,
                max_output_tokens,
                cancellation,
            )
            .await?;
            let request = model_attempt::prepare_request_with_settings(
                &settings,
                prompt.clone(),
                definitions,
                max_output_tokens,
                ModelPurpose::Main,
            )?;
            if request.input_digest != *input_digest || request.route_identity != *route_identity {
                return Err(RunError::ReconciliationRequired(
                    "frozen request input identity changed".into(),
                ));
            }
            Ok(())
        }
        .await;
        if let Err(error) = prepared {
            prompt
                .close()
                .await
                .map_err(crate::cleanup::preparation_failed)?;
            return Err(error);
        }
        Ok(prompt)
    }
}
impl maka_agent_ports::model::FrozenPrompt for FrozenReplay {
    fn open(
        &self,
        cancellation: CancellationToken,
    ) -> futures_util::future::BoxFuture<
        '_,
        Result<maka_agent_ports::model::MaterializedPrompt, maka_model::ModelError>,
    > {
        Box::pin(async move {
            let prepared = self.prepared(&cancellation).await.map_err(|error| {
                if error.is_cleanup_unconfirmed() {
                    maka_model::ModelError::CleanupUnconfirmed
                } else if matches!(error, RunError::Cancelled) {
                    maka_model::ModelError::Cancelled
                } else {
                    maka_model::ModelError::Adapter(format!("reopen frozen request: {error}"))
                }
            })?;
            Ok(maka_agent_ports::model::MaterializedPrompt {
                prompt: prepared.model(),
                cleanup: prepared.cleanup(),
            })
        })
    }
}

#[cfg(test)]
pub(crate) mod tests;
