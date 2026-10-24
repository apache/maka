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

use crate::{RunContext, RunError, RunSettings, context_input, model_attempt};
use maka_agent_facts::context::CheckpointMode;
use maka_agent_facts::context::CompactOutcome;
use maka_agent_facts::context::ContextCheckpoint;
use maka_agent_facts::context::TextSummary;
use maka_agent_facts::context::default_compaction_prompt;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::RuntimeEvent;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub(super) type Candidate = (CompactOutcome, Option<RuntimeEvent>);

pub(super) struct Job {
    input: RunSettings,
    source: model_attempt::RequestSource,
    mode: CheckpointMode,
    prompt: crate::prepared_prompt::PreparedPrompt,
    surface: Arc<crate::request_composition::Surface>,
    definitions: Vec<maka_model::ToolDefinition>,
}

pub(super) async fn run(
    inner: &Arc<RunContext>,
    input: &mut RunSettings,
    mode: &CheckpointMode,
    cancellation: &CancellationToken,
    continuation_base: Option<u64>,
) -> Result<Candidate, RunError> {
    let Some(job) = capture(inner, input, mode, cancellation, continuation_base).await? else {
        return Ok((
            CompactOutcome::Unchanged {
                reason: "no_new_history".into(),
            },
            None,
        ));
    };
    job.execute(inner, cancellation).await
}

pub(super) async fn capture(
    inner: &Arc<RunContext>,
    input: &mut RunSettings,
    mode: &CheckpointMode,
    cancellation: &CancellationToken,
    continuation_base: Option<u64>,
) -> Result<Option<Job>, RunError> {
    input.refresh_model(cancellation).await?;
    let source = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(RunError::Cancelled),
        source = inner.log.prepare_compaction_view(
            &input.invocation.session_id,
            Some(&input.invocation.invocation_id),
            mode,
        ) => source?,
    };
    let has_new_history = source.has_new_history;
    let prompt = model_attempt::prompt(
        inner,
        input,
        &source,
        cancellation,
        continuation_base,
        &input.invocation.invocation_id,
        false,
    )
    .await?;
    if !has_new_history
        && (source.baseline.is_none() || !context_input::needs_compaction(input, &prompt))
    {
        return Ok(None);
    }
    let adapter = inner.shared.model.binding(&input.provider)?;
    let prior = match &source.latest_main {
        maka_event_log::context::LatestMainContext::Selected(latest)
            if latest.model_id == input.provider.model
                && latest.route_identity == model_attempt::route_identity(input)?
                && latest.connection_id.as_deref()
                    == input
                        .configuration
                        .model
                        .as_ref()
                        .map(|model| model.connection_id.as_str()) =>
        {
            inner
                .log
                .completed_request_composition(&input.invocation.session_id, latest.sequence)
                .await?
        }
        _ => None,
    };
    let mut composition =
        prior.unwrap_or_else(|| maka_agent_facts::composition::RequestComposition {
            system_prompt: input
                .configuration
                .system_prompt
                .as_ref()
                .map(|prompt| prompt.text.clone()),
            dynamic_context: vec![],
            tool_catalog_digest: maka_agent_facts::artifact::content_digest(b"[]"),
            tools: vec![],
            provider_options: Some(input.provider_options.clone()),
            max_output_tokens: None,
            sources: input
                .configuration
                .system_prompt
                .as_ref()
                .map(|prompt| prompt.sources.clone())
                .unwrap_or_default(),
        });
    // A relocated project can change the admitted cwd since the last Main.
    composition.dynamic_context = crate::request_composition::session_context(input);
    // Reuse the Main system/tool prefix for provider prefix caching. The summary
    // instruction is appended after history; execution binds the current adapter
    // and model revision on this admitted route.
    composition.sources.retain(|source| {
        !matches!(
            source.kind,
            maka_agent_facts::composition::SourceKind::ModelAdapter
                | maka_agent_facts::composition::SourceKind::ModelProvider
        )
    });
    composition.sources.push(adapter.source().clone());
    composition
        .sources
        .extend(input.model_revision.iter().cloned());
    let definitions = composition.tools.clone();
    let mut captured = input.clone();
    if let Some(options) = &composition.provider_options {
        captured.provider_options = options.clone();
    }
    let surface = Arc::new(crate::request_composition::Surface::summary(
        adapter,
        composition,
        context_input::summary_output_budget(input),
    )?);
    let prompt = surface.apply(prompt);
    Ok(Some(Job {
        input: captured,
        source: model_attempt::RequestSource::from(&source),
        mode: mode.clone(),
        prompt,
        surface,
        definitions,
    }))
}

impl Job {
    pub async fn execute(
        self,
        inner: &Arc<RunContext>,
        cancellation: &CancellationToken,
    ) -> Result<Candidate, RunError> {
        let Self {
            input,
            source,
            mode,
            prompt,
            surface,
            definitions,
        } = self;
        let instruction = maka_model::prompt::Message::user(
            input
                .configuration
                .compaction_prompt
                .clone()
                .unwrap_or_else(|| default_compaction_prompt(input.configuration.language).into()),
        );
        let mut input_budget = context_input::summary_budget(&input)
            .saturating_sub(context_input::estimate(std::slice::from_ref(&instruction)))
            .saturating_sub(context_input::json_tokens(&definitions));
        let mut overflowed = false;
        loop {
            let mut request = if overflowed {
                context_input::fit_prepared_summary(
                    &prompt,
                    input_budget,
                    input.configuration.language,
                    cancellation,
                )
                .await?
            } else {
                prompt.clone()
            };
            request.push(instruction.clone());
            let result = model_attempt::execute_once(
                inner,
                &input,
                &source,
                request,
                definitions.clone(),
                model_attempt::Attempt::Summary {
                    surface: surface.clone(),
                },
                cancellation,
                &mut false,
                &mut None,
            )
            .await;
            let (step_id, output) = match result {
                Ok(output) => output,
                Err(RunError::Model(maka_model::ModelError::ContextOverflow {
                    observed_output: false,
                })) if input_budget > 256 => {
                    input_budget = input_budget
                        .min(prompt.breakdown().estimated_tokens())
                        .max(1)
                        / 2;
                    overflowed = true;
                    continue;
                }
                Err(error) => return Err(error),
            };
            let summary = match TextSummary::from_model_step(&output) {
                Ok(summary) => summary,
                Err(defect) => return Ok(failed(&defect.to_string())),
            };
            let checkpoint = RuntimeEvent::new(
                input.invocation.clone(),
                Fact::ContextCheckpointRecorded {
                    checkpoint: ContextCheckpoint {
                        mode: mode.clone(),
                        covered_through: source.evidence.high_water,
                        source_digest: source.evidence.digest.clone(),
                        previous_checkpoint_id: source.checkpoint.clone(),
                        summary,
                        summary_step_id: step_id,
                    },
                },
            );
            return Ok((
                CompactOutcome::Compacted {
                    checkpoint_id: checkpoint.id.clone(),
                },
                Some(checkpoint),
            ));
        }
    }
}
fn failed(reason: &str) -> (CompactOutcome, Option<RuntimeEvent>) {
    (
        CompactOutcome::Failed {
            reason: reason.into(),
        },
        None,
    )
}
