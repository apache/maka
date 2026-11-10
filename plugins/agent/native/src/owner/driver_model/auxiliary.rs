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

//! Original completed request data, prepared under a separately authorized auxiliary model.
use super::*;
use crate::contract::{ContextRequest, ContextRequestState};
use maka_agent_engine::{PreparedModel, prepared_prompt::PreparedPrompt};
use maka_agent_facts::accounting::Outcome;
use maka_agent_state::session_history::{HistoryCut, SessionHistory};

pub(in crate::owner) struct PreparedAuxiliary {
    request: ModelRequest,
    prompt: PreparedPrompt,
}
impl PreparedAuxiliary {
    pub(in crate::owner) fn request(&self) -> ModelRequest {
        ModelRequest {
            operation: self.request.operation,
            language: self.request.language,
            provider: self.request.provider.clone(),
            prompt: self.request.prompt.clone(),
            tools: self.request.tools.clone(),
            tool_choice: self.request.tool_choice,
            provider_options: self.request.provider_options.clone(),
            max_output_tokens: self.request.max_output_tokens,
        }
    }
    pub(in crate::owner) async fn close(self) -> Result<(), RunError> {
        let Self { request, prompt } = self;
        drop(request);
        prompt.close().await.map_err(RunError::PreparationCleanup)
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "Auxiliary preparation binds the captured history cut, model, purpose and original preparation resources"
)]
pub(in crate::owner) async fn prepare_completed(
    history: &SessionHistory,
    cut: &HistoryCut,
    context: &ContextRequest,
    io: preparation::PreparationIo,
    resources: ModelPreparationResources,
    model: &PreparedModel,
    purpose: ModelPurpose,
    instruction: String,
    cancellation: &CancellationToken,
) -> Result<PreparedAuxiliary, RunError> {
    if cancellation.is_cancelled() {
        return Err(RunError::Cancelled);
    }
    let run = context.execution.run_id;
    let source = history.run_source(run).await?;
    let request = history.request(cut, run, context.step_id).await?;
    let opening = history
        .item(cut, context.sequence)
        .await?
        .ok_or_else(|| unsupported("auxiliary-original-step"))?;
    if source.execution() != context.execution
        || !matches!(context.state, ContextRequestState::Completed)
        || opening.recorded.run != run
        || !matches!(opening.recorded.fact, Fact::StepPrepared { step, .. } if step == request.step)
        || request.protocol != PROTOCOL
        || request.protocol_version != VERSION
        || request.accounting.purpose != ModelPurpose::Main
    {
        return Err(unsupported("auxiliary-original-main-request"));
    }
    let frozen: FrozenInput = decode(history, cut, run, &request.request).await?;
    let recovery: FrozenRecovery = decode(history, cut, run, &request.recovery_contract).await?;
    let BackendSpec::Model {
        descriptor,
        binding,
    } = &source.spec.backend
    else {
        return Err(unsupported("auxiliary-original-model"));
    };
    let accepted = AcceptedModel::from_backend(
        &source.spec.backend,
        &history.content(run, descriptor).await?,
    )?;
    if frozen.accepted != accepted
        || &frozen.accepted.binding != binding
        || request.accounting.binding != *binding
        || request.request_contents != frozen.content_refs()
        || recovery.protocol != format!("{PROTOCOL}/recovery")
        || recovery.version != VERSION
        || recovery.request != request.request
        || recovery.adapter != frozen.adapter
        || !request.composition.sources.contains(&frozen.adapter)
    {
        return Err(unsupported("auxiliary-original-source-evidence"));
    }
    let original = preparation::restore_prompt_from(
        io.clone(),
        resources.clone(),
        preparation::ContentSource::Live { history, cut },
        run,
        &frozen.prompt,
        &frozen.prompt_chunks,
        &frozen.layout,
        cancellation,
    )
    .await?
    .with_frozen_transport(frozen.instructions.as_deref(), frozen.normalization.clone());
    let mut builder = match preparation::PromptBuilder::new(io, resources, cancellation).await {
        Ok(builder) => builder,
        Err(error) => return close_result(Err(error), &original).await,
    };
    let copied = async {
        let model = original.model();
        let recipes = model
            .recipes()
            .ok_or_else(|| unsupported("auxiliary-original-recipes"))?;
        let count = model.len();
        let prefix = recipes.prefix_identity(count).await?;
        let instructions = model
            .instructions_source()
            .map(|source| *source.commitment());
        let mut cursor = recipes.open(0);
        while let Some(recipe) = cursor.next().await? {
            if cancellation.is_cancelled() {
                return Err(RunError::Cancelled);
            }
            builder.append_recipe(&recipe).await?;
        }
        append_completion(history, cut, context, &mut builder, cancellation).await?;
        Ok((count, prefix, instructions))
    }
    .await;
    let copied = close_result(copied, &original).await;
    let (count, prefix, instructions) = match copied {
        Ok(copied) => copied,
        Err(error) => {
            return match builder.close().await {
                Ok(()) => Err(error),
                Err(close) => Err(preparation::preparation_cleanup_error(error, close)),
            };
        }
    };
    let settings = PromptSettings {
        operation: ModelOperation::Inference,
        codex: model
            .context
            .as_ref()
            .and_then(|context| context.codex.as_ref()),
        language: frozen.language,
        provider: &model.provider,
        options: &model.options,
        context_window: model
            .context
            .as_ref()
            .and_then(|context| context.model_context_window),
        tool_choice: ToolChoiceMode::None,
    };
    let mut prompt = preparation::prepare_prompt(
        builder,
        &settings,
        cancellation,
        None,
        purpose,
        Some(Arc::new(instruction)),
    )
    .await?
    .with_frozen_transport(frozen.instructions.as_deref(), None);
    let result = async {
        // Old definitions are data, never a restored executable catalog. This
        // auxiliary request cannot ask the Host to activate a historical tool.
        preparation::prepare_wire(
            &settings,
            &mut prompt,
            &[],
            model.main_output_limit,
            cancellation,
        )
        .await?;
        let actual = prompt.model();
        if actual.len() <= count
            || actual
                .instructions_source()
                .map(|source| *source.commitment())
                != instructions
            || actual
                .recipes()
                .ok_or_else(|| unsupported("auxiliary-prefix-recipes"))?
                .prefix_identity(count)
                .await?
                != prefix
        {
            return Err(unsupported("auxiliary-original-prefix-changed"));
        }
        Ok(preparation::prepare_request(
            &settings,
            prompt.clone(),
            vec![],
            model.main_output_limit,
            purpose,
            None,
        )?
        .request)
    }
    .await;
    match result {
        Ok(request) => Ok(PreparedAuxiliary { request, prompt }),
        Err(error) => close_result(Err(error), &prompt).await,
    }
}

async fn append_completion(
    history: &SessionHistory,
    cut: &HistoryCut,
    context: &ContextRequest,
    builder: &mut preparation::PromptBuilder,
    cancellation: &CancellationToken,
) -> Result<(), RunError> {
    let mut after = context.sequence;
    let mut prepared = false;
    let mut index = 0;
    let mut parts = vec![];
    loop {
        if cancellation.is_cancelled() {
            return Err(RunError::Cancelled);
        }
        let page = history.page(cut, after, 128).await?;
        for item in page.items {
            if item.recorded.run != context.execution.run_id {
                continue;
            }
            match item.recorded.fact {
                Fact::ModelAttemptPrepared { attempt, step } if attempt == context.attempt_id => {
                    if step != context.step_id {
                        return Err(unsupported("auxiliary-original-attempt-step"));
                    }
                    prepared = true;
                }
                Fact::ModelObserved {
                    attempt,
                    index: observed,
                    part,
                    ..
                } if attempt == context.attempt_id => {
                    if !prepared || observed != index {
                        return Err(unsupported("auxiliary-original-item-sequence"));
                    }
                    index += 1;
                    if let Some(part) = preparation::assistant_part(&part)? {
                        parts.push(part);
                    }
                }
                Fact::ModelClosed {
                    attempt, outcome, ..
                } if attempt == context.attempt_id => {
                    if !prepared || outcome != Outcome::Success {
                        return Err(unsupported("auxiliary-original-attempt-incomplete"));
                    }
                    flush_assistant(builder, &mut parts).await?;
                    return Ok(());
                }
                _ => {}
            }
        }
        match page.next {
            Some(next) => after = next,
            None => return Err(unsupported("auxiliary-original-closure-missing")),
        }
    }
}
async fn decode<T: serde::de::DeserializeOwned + Send + 'static>(
    history: &SessionHistory,
    cut: &HistoryCut,
    run: RunId,
    reference: &ContentRef,
) -> Result<T, RunError> {
    history
        .with_content(cut, run, reference, |reader| {
            Ok(serde_json::from_reader::<_, T>(reader))
        })
        .await?
        .map_err(RunError::Json)
}
async fn close_result<T>(
    result: Result<T, RunError>,
    prompt: &PreparedPrompt,
) -> Result<T, RunError> {
    match prompt.close().await {
        Ok(()) => result,
        Err(close) => Err(match result {
            Ok(_) => RunError::PreparationCleanup(close),
            Err(original) => preparation::preparation_cleanup_error(original, close),
        }),
    }
}
