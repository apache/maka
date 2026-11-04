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

//! Prepare an auxiliary suffix over the exact request prefix the conversation used.
use crate::{
    Engine, RunError, frozen_request::FrozenReplay, model_attempt, prepared_prompt::PreparedPrompt,
};
use maka_agent_facts::{
    composition::SourceRevision,
    context::ModelPurpose,
    event::{Fact, InvocationInput},
};
use maka_event_log::{context::FrozenModelRequest, root_store::SessionStore};
use maka_model::{ModelRequest, ProviderConfig};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

/// Original request evidence and the currently authorized route to that same model.
pub struct PredictionInput {
    pub frozen: FrozenModelRequest,
    pub provider: ProviderConfig,
    pub model_revision: Option<SourceRevision>,
    pub instruction: String,
}
impl std::fmt::Debug for PredictionInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PredictionInput")
            .field("invocation", &self.frozen.request.event.invocation)
            .field("model", &self.provider.model)
            .finish_non_exhaustive()
    }
}

/// Owns the prepared, storage-backed input until the auxiliary stream has settled.
pub struct PreparedPrediction {
    request: ModelRequest,
    prompt: PreparedPrompt,
}
impl std::fmt::Debug for PreparedPrediction {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PreparedPrediction")
            .field("model", &self.request.provider.model)
            .field("messages", &self.request.prompt.len())
            .finish_non_exhaustive()
    }
}
impl PreparedPrediction {
    /// Borrow the source through cheap handles; no history bodies are copied.
    pub fn request(&self) -> ModelRequest {
        ModelRequest {
            operation: maka_agent_facts::context::ModelOperation::Inference,
            language: self.request.language,
            provider: self.request.provider.clone(),
            prompt: self.request.prompt.clone(),
            tools: self.request.tools.clone(),
            tool_choice: self.request.tool_choice,
            provider_options: self.request.provider_options.clone(),
            max_output_tokens: self.request.max_output_tokens,
        }
    }

    /// Release preparation resources after the original auxiliary stream settles.
    ///
    /// # Errors
    /// Returns an error if closing the retained source could not be confirmed.
    pub async fn close(self) -> Result<(), RunError> {
        let Self { request, prompt } = self;
        drop(request);
        prompt
            .close()
            .await
            .map_err(crate::cleanup::preparation_failed)
    }
}

impl Engine {
    /// Reuse a checked Main prefix and append one prediction instruction without writing history.
    /// Tool definitions remain identical for provider caching; this method cannot dispatch them.
    /// `store` retains the auxiliary operation's physical preparation custody,
    /// independently of the already completed conversation invocation.
    ///
    /// # Errors
    /// Rejects changed routes, changed prefixes, cancellation and unavailable preparation resources.
    pub async fn prepare_prediction(
        &self,
        store: SessionStore,
        input: PredictionInput,
        cancellation: &CancellationToken,
    ) -> Result<PreparedPrediction, RunError> {
        crate::require_session(&store, &input.frozen.request.event.invocation)?;
        if cancellation.is_cancelled() {
            return Err(RunError::Cancelled);
        }
        let store = Arc::new(store);
        let adapter = self.0.model.binding(&input.provider)?;
        let replay = FrozenReplay::for_prediction(
            store.clone(),
            self.0.preparation_resources.clone(),
            &input,
            adapter,
        );
        let PredictionInput {
            frozen,
            provider,
            model_revision: _,
            instruction,
        } = input;
        let Fact::InvocationOpened {
            configuration: Some(configuration),
            input: opening,
        } = &frozen.opening.fact
        else {
            return Err(changed("original prediction request has no configuration"));
        };
        let language = configuration.language;
        let base = match opening {
            InvocationInput::Continuation { claim, .. } => Some(claim.base.high_water),
            InvocationInput::Handoff { pause, .. } => pause.execution.replay_base,
            InvocationInput::Message { .. } => None,
            _ => return Err(changed("original prediction request has no model history")),
        };
        let invocation = frozen.request.event.invocation.clone();
        let Fact::ModelRequested {
            context,
            source_capture,
            ..
        } = &frozen.request.event.fact
        else {
            return Err(changed("prediction source is not a Main model request"));
        };
        let context_window = context
            .as_ref()
            .and_then(|context| context.model_context_window);
        let codex = context.as_ref().and_then(|c| c.codex.clone());
        let prior_unknown = source_capture.prior_unknown;
        let system = crate::request_composition::render_system(
            frozen.composition.system_prompt.as_deref(),
            &frozen.composition.dynamic_context,
        )
        .map(Arc::new);
        let definitions = frozen.composition.tools.clone();
        let options = frozen
            .composition
            .provider_options
            .clone()
            .ok_or_else(|| changed("prediction source has no provider options"))?;
        let configured_output_limit = frozen.composition.max_output_tokens;
        let calibration = model_attempt::RequestSource::from(&frozen.view)
            .calibration(&provider, configuration.model.as_ref())?;
        // Validate against the actual committed Main input digest, not today's composition.
        let original = replay.prepare_frozen(frozen, cancellation).await?;
        let original_model = original.model();
        let messages = original_model.len();
        let original_prefix = match original_model.recipes() {
            Some(recipes) => recipes.prefix_identity(messages).await,
            None => Err(std::io::Error::other(
                "original prediction prefix has no source recipes",
            )),
        };
        let original_instructions = original_model
            .instructions_source()
            .map(|source| *source.commitment());
        let settings = model_attempt::PromptSettings {
            codex: codex.as_ref(),
            operation: maka_agent_facts::context::ModelOperation::Inference,
            language,
            provider: &provider,
            options: &options,
            context_window,
            tool_choice: Default::default(),
        };
        let original_output_limit = model_attempt::prepare_request_with_settings(
            &settings,
            original.clone(),
            definitions.clone(),
            configured_output_limit,
            ModelPurpose::Main,
            calibration,
        )
        .map(|prepared| prepared.request.max_output_tokens);
        let closed = original
            .close()
            .await
            .map_err(crate::cleanup::preparation_failed);
        drop(original_model);
        drop(original);
        closed?;
        let original_prefix = original_prefix.map_err(RunError::preparation)?;
        let max_output_tokens = original_output_limit?;
        let current = Arc::new(store.read_model_view(&invocation.session_id, None).await?);
        let mut prompt = model_attempt::prompt_with_resources(
            &store,
            self.0.preparation_resources.clone(),
            &settings,
            &current,
            cancellation,
            base,
            &invocation.invocation_id,
            prior_unknown,
            system,
            ModelPurpose::Main,
            Some(Arc::new(instruction)),
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
            let model = prompt.model();
            if model.len() < messages + 1
                || model
                    .instructions_source()
                    .map(|source| *source.commitment())
                    != original_instructions
            {
                return Err(changed(
                    "prediction would change the original request prefix",
                ));
            }
            let prefix = model
                .recipes()
                .ok_or_else(|| changed("prediction prefix has no source recipes"))?
                .prefix_identity(messages)
                .await
                .map_err(RunError::preparation)?;
            if prefix != original_prefix {
                return Err(changed(
                    "prediction would change the original request prefix",
                ));
            }
            Ok(ModelRequest {
                operation: maka_agent_facts::context::ModelOperation::Inference,
                language,
                provider: provider.clone(),
                prompt: model,
                tools: definitions,
                tool_choice: Default::default(),
                provider_options: options.clone(),
                max_output_tokens,
            })
        }
        .await;
        match prepared {
            Ok(request) => Ok(PreparedPrediction { request, prompt }),
            Err(error) => {
                prompt
                    .close()
                    .await
                    .map_err(crate::cleanup::preparation_failed)?;
                Err(error)
            }
        }
    }
}

fn changed(message: &str) -> RunError {
    RunError::ReconciliationRequired(message.into())
}
