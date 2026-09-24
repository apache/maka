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

use crate::{Inner, RunError, RunInput, auto_context, model_attempt, prune};
use futures_util::FutureExt;
use maka_runtime::{context::ModelPurpose, tools::ToolError};
use maka_tools::RunTools;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[allow(clippy::too_many_arguments)] // Admission policy must remain visible across the step loop.
pub(super) async fn run(
    inner: &Arc<Inner>,
    input: &mut RunInput,
    catalog: &maka_tools::ToolCatalog,
    max_steps: usize,
    cancellation: &CancellationToken,
    continuation_base: Option<u64>,
    handoff: &crate::HandoffGate,
    prior_unknown: bool,
) -> Result<maka_runtime::event::InvocationOutcome, RunError> {
    let lane = maka_model::Conversation::default();
    let mut tools = RunTools::new(
        inner.log.clone(),
        input.invocation.clone(),
        catalog.clone(),
        input.configuration.tool_mode,
        inner.cells.clone(),
    )
    .with_model(input.provider.tool_context());
    let result = std::panic::AssertUnwindSafe(async {
        use maka_runtime::handoff::CompactionBudget;
        let mut compaction = CompactionBudget::Available;
        // This tracks work after this physical opening, not after the logical root.
        // A successor may compact the sealed prefix with a PreTurn boundary.
        let mut completed_step = false;
        if let crate::RunWork::Handoff { pause, .. } = &input.work {
            tools.restore(&pause.execution.tools)?;
            compaction = pause.execution.compaction;
        }
        for step in 0..max_steps {
            crate::interactions::wait_until_clear(&inner.log, &input.invocation, cancellation)
                .await?;
            inner.log.commit_pending_steering(&input.invocation).await?;
            if let Some(pause) = handoff
                .boundary(cancellation, |intent| async {
                    // Live cells retain the current step's capabilities and effects.
                    // A handoff can seal only after those independent jobs settle.
                    if !tools.code_idle() {
                        return None;
                    }
                    let source = inner
                        .log
                        .read_model_context(
                            &input.invocation.session_id,
                            Some(&input.invocation.invocation_id),
                            10_000,
                            8 * 1024 * 1024,
                        )
                        .await
                        .ok()?;
                    // Read the live source, but project from the successor's point of
                    // view: manual replay cuts distinguish current from inherited work.
                    let prompt = model_attempt::prompt(
                        inner,
                        input,
                        &source,
                        ModelPurpose::Main,
                        cancellation,
                        continuation_base,
                        &intent.successor_invocation_id,
                        prior_unknown,
                    )
                    .await
                    .ok()?;
                    let replay = crate::continuation::replay(
                        input,
                        prompt,
                        tools.handoff_definitions(),
                        cancellation,
                    )
                    .ok()?;
                    let pause = maka_runtime::handoff::HandoffPause {
                        intent,
                        remaining_steps: std::num::NonZeroU16::new((max_steps - step) as u16)
                            .expect("validated step budget"),
                        execution: Box::new(maka_runtime::handoff::HandoffExecution {
                            replay,
                            context: input.context.clone(),
                            provider_options: input.provider_options.clone(),
                            main_output_limit: input.main_output_limit,
                            supports_vision: input.supports_vision,
                            tools: tools.checkpoint(),
                            compaction,
                            replay_base: continuation_base,
                        }),
                    };
                    inner
                        .log
                        .check_handoff(&input.invocation, &pause)
                        .await
                        .ok()?;
                    Some(pause)
                })
                .await
            {
                return Ok(maka_runtime::event::InvocationOutcome::HandoffPaused { pause });
            }
            if cancellation.is_cancelled() {
                return Err(RunError::Cancelled);
            }
            input.refresh_model(cancellation).await?;
            let mut source = if prior_unknown {
                inner
                    .log
                    .read_manual_message_context(
                        &input.invocation.session_id,
                        &input.invocation.invocation_id,
                        maka_runtime::context::MAX_HISTORY_EVENTS,
                        maka_runtime::context::MAX_HISTORY_BYTES,
                    )
                    .await?
            } else {
                inner
                    .log
                    .read_model_context(
                        &input.invocation.session_id,
                        Some(&input.invocation.invocation_id),
                        maka_runtime::context::MAX_HISTORY_EVENTS,
                        maka_runtime::context::MAX_HISTORY_BYTES,
                    )
                    .await?
            };
            if tools.code_idle()
                && compaction == CompactionBudget::Available
                && !prior_unknown
                && auto_context::due(input, &source)
            {
                compaction = CompactionBudget::Failed;
                if auto_context::attempt(
                    inner,
                    input,
                    &source,
                    completed_step,
                    cancellation,
                    continuation_base,
                )
                .await?
                {
                    compaction = CompactionBudget::Reshaped;
                    tools.clear_loaded();
                }
                source = inner
                    .log
                    .read_model_context(
                        &input.invocation.session_id,
                        Some(&input.invocation.invocation_id),
                        10_000,
                        8 * 1024 * 1024,
                    )
                    .await?;
                // Compaction makes its own logical requests. The following
                // main step must observe any provider change made meanwhile.
                input.refresh_model(cancellation).await?;
            }
            tools.set_model(input.provider.tool_context());
            let request_tools = tools
                .capture(&input.configuration.cwd, cancellation.clone())
                .await?;
            let unknown_notice =
                prior_unknown.then(|| model_attempt::prior_unknown_notice(&source));
            if unknown_notice.as_deref() == Some("") {
                return Err(RunError::ReconciliationRequired(
                    "unknown prior tool is missing from model context".into(),
                ));
            }
            let surface = Arc::new(
                crate::request_composition::Surface::capture(
                    &request_tools,
                    &inner.model,
                    input,
                    &source,
                    compaction == CompactionBudget::Reshaped,
                    cancellation,
                    unknown_notice.as_deref(),
                )
                .await?,
            );
            let prompt = model_attempt::prompt(
                inner,
                input,
                &source,
                ModelPurpose::Main,
                cancellation,
                continuation_base,
                &input.invocation.invocation_id,
                prior_unknown,
            )
            .await?;
            let result = model_attempt::execute(
                inner,
                input,
                &source,
                surface.apply(prompt),
                request_tools.definitions(),
                model_attempt::Attempt::Main {
                    lane: lane.clone(),
                    continuation_base,
                    surface: surface.clone(),
                },
                cancellation,
            )
            .await;
            let (step_id, output) = match result {
                Ok(output) => output,
                Err(
                    error @ RunError::Model(maka_model::ModelError::ContextOverflow {
                        observed_output: false,
                    }),
                ) if compaction == CompactionBudget::Available
                    && tools.code_idle()
                    && step + 1 < max_steps
                    && !cancellation.is_cancelled() =>
                {
                    if auto_context::attempt(
                        inner,
                        input,
                        &source,
                        completed_step,
                        cancellation,
                        continuation_base,
                    )
                    .await?
                    {
                        compaction = CompactionBudget::Reshaped;
                        tools.clear_loaded();
                        continue;
                    }
                    return Err(error);
                }
                Err(error) => return Err(error),
            };
            if compaction == CompactionBudget::Reshaped {
                compaction = CompactionBudget::Available;
            }
            let local_calls: Vec<_> = output
                .tool_calls()
                .filter(|call| !call.provider_executed)
                .collect();
            if local_calls.is_empty() {
                return Ok(maka_runtime::event::InvocationOutcome::Completed);
            }
            let mut step_tools = request_tools.into_step(&step_id);
            for call in &local_calls {
                let result = std::panic::AssertUnwindSafe(async {
                    step_tools.invoke(call, cancellation.clone()).await
                })
                .catch_unwind()
                .await
                .unwrap_or_else(|_| Err(ToolError::CleanupUnconfirmed("tool panicked".into())));
                match result {
                    Ok(_)
                    | Err(
                        ToolError::Failed(_) | ToolError::Io { .. } | ToolError::OutcomeUnknown(_),
                    ) => {}
                    Err(error) => return Err(error.into()),
                }
            }
            // An exec/wait observation can settle while its cell is still
            // asking the user. Pause before advancing or consuming the final
            // step budget. First settle/reject the entire model tool batch:
            // cancellation must still journal every remaining provider call.
            crate::interactions::wait_until_clear(&inner.log, &input.invocation, cancellation)
                .await?;
            // Pruning/compaction require a settled boundary. A yielded cell is
            // still live work, not a corrupt boundary or a reason to cancel it.
            // Defer maintenance until it settles; the model can still call wait.
            if tools.code_idle() && !prior_unknown {
                prune::run(inner, input, cancellation).await?;
            }
            if step_tools.finished() {
                return Ok(maka_runtime::event::InvocationOutcome::Completed);
            }
            if step + 1 < max_steps && !cancellation.is_cancelled() && lane.needs_confirmation() {
                let source = if prior_unknown {
                    inner
                        .log
                        .read_manual_message_context(
                            &input.invocation.session_id,
                            &input.invocation.invocation_id,
                            10_000,
                            8 * 1024 * 1024,
                        )
                        .await?
                } else {
                    inner
                        .log
                        .read_model_context(
                            &input.invocation.session_id,
                            Some(&input.invocation.invocation_id),
                            10_000,
                            8 * 1024 * 1024,
                        )
                        .await?
                };
                let replay = model_attempt::prompt(
                    inner,
                    input,
                    &source,
                    ModelPurpose::Main,
                    cancellation,
                    continuation_base,
                    &input.invocation.invocation_id,
                    prior_unknown,
                )
                .await?;
                let ids: Vec<_> = local_calls.iter().map(|call| call.id.as_str()).collect();
                lane.confirm(&surface.apply(replay), &ids, output.response_id.as_deref())
                    .await?;
            }
            completed_step = true;
        }
        if cancellation.is_cancelled() {
            Err(RunError::Cancelled)
        } else {
            Err(RunError::StepLimit)
        }
    })
    .catch_unwind()
    .await
    .unwrap_or_else(|_| Err(RunError::Internal("model step worker panicked".into())));
    tools.shutdown().await?;
    result
}
