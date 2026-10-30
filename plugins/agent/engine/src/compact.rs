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
    definitions: Vec<Arc<maka_model::ToolDefinition>>,
    instruction: crate::prepared_prompt::OwnedOverlay,
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
    let source = Arc::new(tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(RunError::Cancelled),
        source = inner.log.prepare_compaction_view(
            &input.invocation.session_id,
            Some(&input.invocation.invocation_id),
            mode,
        ) => source?,
    });
    let has_new_history = source.has_new_history;
    if !has_new_history && source.baseline.is_none() {
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
    let prompt = model_attempt::prompt(
        inner,
        &captured,
        &source,
        cancellation,
        continuation_base,
        &input.invocation.invocation_id,
        false,
        surface.system(),
        maka_agent_facts::context::ModelPurpose::Summary,
    )
    .await?;
    let arena = prompt.arena().cloned();
    let result = async {
        if !has_new_history && !context_input::needs_compaction(&captured, &prompt) {
            return Ok(None);
        }
        let instruction = prompt
            .freeze_summary_instruction(Arc::new(
                captured
                    .configuration
                    .compaction_prompt
                    .clone()
                    .unwrap_or_else(|| {
                        default_compaction_prompt(captured.configuration.language).into()
                    }),
            ))
            .await?;
        Ok(Some(Job {
            input: captured,
            source: model_attempt::RequestSource::from(source.as_ref()),
            mode: mode.clone(),
            prompt,
            surface,
            definitions,
            instruction,
        }))
    }
    .await;
    if !matches!(&result, Ok(Some(_)))
        && !result.as_ref().is_err_and(RunError::is_cleanup_unconfirmed)
        && let Some(arena) = arena
    {
        arena
            .close()
            .await
            .map_err(crate::cleanup::preparation_failed)?;
    }
    result
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
            instruction,
        } = self;
        let arena = prompt.arena().cloned();
        let result = async {
            let mut input_budget = context_input::summary_budget(&input)
                .saturating_sub(instruction.breakdown().estimated_tokens())
                .saturating_sub(context_input::json_tokens(&definitions));
            reserve_summary(
                &prompt,
                &instruction,
                &input,
                &definitions,
                input_budget,
                cancellation,
            )
            .await?;
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
                    &mut None,
                    None,
                )
                .await;
                let output = match result {
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
                let model_attempt::AttemptOutput::Summary { step_id, summary } = output else {
                    unreachable!("Summary request returns its summary business result");
                };
                let summary = match summary {
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
        .await;
        if !result.as_ref().is_err_and(RunError::is_cleanup_unconfirmed)
            && let Some(arena) = arena
        {
            arena
                .close()
                .await
                .map_err(crate::cleanup::preparation_failed)?;
        }
        result
    }
}
async fn reserve_summary(
    prompt: &crate::prepared_prompt::PreparedPrompt,
    instruction: &crate::prepared_prompt::OwnedOverlay,
    input: &RunSettings,
    definitions: &[Arc<maka_model::ToolDefinition>],
    tokens: u64,
    cancellation: &CancellationToken,
) -> Result<(), RunError> {
    let resources = prompt
        .resources()
        .ok_or_else(|| RunError::Internal("summary lacks Host preparation resources".into()))?
        .clone();
    let mut first = prompt.clone();
    first.push(instruction.clone());
    let encoding = maka_model::WireEncoding::new(
        input.configuration.language,
        &input.provider,
        &input.provider_options,
        definitions,
    )?;
    let logical = first.model();
    let plan = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(RunError::Cancelled),
        plan = encoding.count_prompt(&logical, resources.clone()) => plan?,
    };
    let fitted = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(RunError::Cancelled),
        fitted = encoding.count_summary_fit_bound(&plan, prompt.model().len(), resources.clone()) => fitted?,
    };
    let fit_peak = crate::history::source_summary::peak_bytes(
        prompt,
        tokens,
        input.configuration.language,
        cancellation,
    )
    .await
    .map_err(|error| match error {
        crate::history::source_summary::FitError::Run(error) => error,
        error => RunError::Preparation(std::io::Error::new(std::io::ErrorKind::Unsupported, error)),
    })?;
    let source_bytes = prompt
        .resident_bytes()
        .checked_add(first.overlay_bytes())
        .ok_or_else(|| {
            RunError::Preparation(std::io::Error::other(
                "summary source allocation peak overflow",
            ))
        })?;
    let wire_header = crate::prepared_prompt::PreparedPrompt::backed_wire_bytes();
    let resident_peak = fit_peak
        .checked_add(fitted.allocation().max(wire_header))
        .map(|fitted| fitted.max(plan.allocation().max(wire_header)))
        .and_then(|wire| source_bytes.checked_add(wire));
    let peak = match resident_peak {
        Some(peak) if peak <= resources.policy().resident_bytes => peak,
        _ => source_bytes
            .checked_add(
                crate::history::source_summary::backed_peak_bytes(input.configuration.language)
                    .map_err(RunError::Preparation)?,
            )
            .and_then(|source| {
                source.checked_add(crate::prepared_prompt::PreparedPrompt::backed_wire_bytes())
            })
            .ok_or_else(|| {
                RunError::Preparation(std::io::Error::other("summary allocation peak overflow"))
            })?,
    };
    drop(plan);
    drop(first);
    drop(logical);
    prompt.promote(peak, cancellation).await
}
fn failed(reason: &str) -> (CompactOutcome, Option<RuntimeEvent>) {
    (
        CompactOutcome::Failed {
            reason: reason.into(),
        },
        None,
    )
}
