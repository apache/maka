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

use crate::{RunContext, RunError, RunSettings, auto_context, model_attempt, prune};
use futures_util::FutureExt;
use maka_tools::RunTools;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[allow(clippy::too_many_arguments)] // Admission policy must remain visible across the step loop.
pub(super) async fn run(
    inner: &Arc<RunContext>,
    input: &mut RunSettings,
    work: crate::runner::ModelWork,
    opening_id: &str,
    cancellation: &CancellationToken,
    continuation_base: Option<u64>,
    handoff: &crate::HandoffGate,
    prior_unknown: bool,
    effects: &maka_event_log::root_store::InvocationEffects,
) -> Result<maka_agent_facts::event::InvocationOutcome, RunError> {
    let crate::runner::ModelWork {
        tools: catalog,
        restored,
    } = work;
    let lane = maka_model::Conversation::default();
    let mut tools = RunTools::new(
        input.configuration.language,
        inner.log.clone(),
        input.invocation.clone(),
        catalog,
        input.configuration.tool_mode,
        inner
            .shared
            .cells
            .clone()
            .with_language(input.configuration.code_language),
        inner.shared.loaded(&input.invocation.session_id),
    )
    .with_model(input.provider.tool_context())
    .with_behavior(input.configuration.orchestration_mode.clone());
    let mut pending: Option<auto_context::Pending> = None;
    let mut handoff_cleanup = None;
    let result = std::panic::AssertUnwindSafe(async {
        use maka_agent_facts::handoff::CompactionBudget;
        let mut compaction = CompactionBudget::Available;
        // This tracks work after this physical opening, not after the logical root.
        // A successor may compact the sealed prefix with a PreTurn boundary.
        let mut main_progress = false;
        if let Some((checkpoint, budget)) = restored {
            tools.restore(&checkpoint)?;
            compaction = budget;
        }
        loop {
            crate::interactions::wait_until_clear(&inner.log, &input.invocation, cancellation)
                .await?;
            inner.log.commit_pending_steering(&input.invocation).await?;
            if let Some(pause) = handoff
                .boundary(cancellation, |intent| async {
                    if let Err(error) = auto_context::drain(&mut pending).await {
                        handoff_cleanup = Some(error);
                        return None;
                    }
                    // Live cells retain the current step's capabilities and effects.
                    // A handoff can seal only after those independent jobs settle.
                    if !tools.code_idle() || !effects.is_idle() {
                        return None;
                    }
                    let context = model_attempt::read_source(inner, input, false, cancellation)
                        .await
                        .ok()?;
                    // Read the live source, but project from the successor's point of
                    // view: manual replay cuts distinguish current from inherited work.
                    let prompt = model_attempt::prompt(
                        inner,
                        input,
                        &context,
                        cancellation,
                        continuation_base,
                        &intent.successor_invocation_id,
                        prior_unknown,
                    )
                    .await
                    .ok()?;
                    let checkpoint = match tools.checkpoint() {
                        Ok(checkpoint) => checkpoint,
                        Err(error) => {
                            handoff_cleanup = Some(error.into());
                            return None;
                        }
                    };
                    let replay = crate::continuation::replay(
                        input,
                        prompt,
                        tools.replay_selected(&checkpoint.loaded),
                        cancellation,
                    )
                    .await
                    .ok()?;
                    let pause = maka_agent_facts::handoff::HandoffPause {
                        intent,
                        execution: Box::new(maka_agent_facts::handoff::HandoffExecution {
                            replay,
                            context: input.context.clone(),
                            provider_options: input.provider_options.clone(),
                            main_output_limit: input.main_output_limit,
                            supports_vision: input.supports_vision,
                            tools: checkpoint,
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
                return Ok(maka_agent_facts::event::InvocationOutcome::HandoffPaused { pause });
            }
            if let Some(error) = handoff_cleanup.take() {
                return Err(error);
            }
            if cancellation.is_cancelled() {
                return Err(RunError::Cancelled);
            }
            input.refresh_model(cancellation).await?;
            if tools.code_idle()
                && effects.is_idle()
                && pending
                    .as_ref()
                    .is_some_and(auto_context::Pending::is_finished)
                && pending
                    .take()
                    .expect("finished candidate")
                    .adopt(inner, cancellation)
                    .await?
            {
                compaction = CompactionBudget::Reshaped;
            }
            let mut context =
                model_attempt::read_source(inner, input, prior_unknown, cancellation).await?;
            let mut prompt = model_attempt::prompt(
                inner,
                input,
                &context,
                cancellation,
                continuation_base,
                &input.invocation.invocation_id,
                prior_unknown,
            )
            .await?;
            let needs_compaction = crate::context_input::needs_compaction(input, &prompt);
            if tools.code_idle()
                && effects.is_idle()
                && compaction == CompactionBudget::Available
                && pending.is_none()
                && !prior_unknown
                && (needs_compaction || auto_context::due(input, &context))
            {
                drop(prompt);
                drop(context);
                compaction = CompactionBudget::Failed;
                if let Some(candidate) = auto_context::start(
                    inner,
                    input,
                    opening_id,
                    main_progress,
                    cancellation,
                    continuation_base,
                )
                .await?
                {
                    if !needs_compaction {
                        pending = Some(candidate);
                    } else if candidate.adopt(inner, cancellation).await? {
                        compaction = CompactionBudget::Reshaped;
                    }
                }
                // Compaction makes its own logical requests. The next Main
                // must observe any provider change made meanwhile.
                input.refresh_model(cancellation).await?;
                context =
                    model_attempt::read_source(inner, input, prior_unknown, cancellation).await?;
                prompt = model_attempt::prompt(
                    inner,
                    input,
                    &context,
                    cancellation,
                    continuation_base,
                    &input.invocation.invocation_id,
                    prior_unknown,
                )
                .await?;
            }
            tools.set_model(input.provider.tool_context());
            let request_tools = tools
                .capture(&input.configuration.cwd, cancellation.clone())
                .await?;
            let unknown_notice = prior_unknown.then(|| {
                model_attempt::prior_unknown_notice(&context, input.configuration.language)
            });
            if unknown_notice.as_deref() == Some("") {
                return Err(RunError::ReconciliationRequired(
                    "unknown prior tool is missing from model context".into(),
                ));
            }
            let surface = Arc::new(crate::request_composition::Surface::capture(
                &request_tools,
                &inner.shared.model,
                input,
                &context,
                unknown_notice.as_deref(),
            )?);
            let initial_high_water = context.source_evidence.high_water;
            let (high_water, result) = model_attempt::execute_main(
                inner,
                input,
                context,
                surface.apply(prompt),
                model_attempt::Main {
                    lane: lane.clone(),
                    continuation_base,
                    surface: surface.clone(),
                    tools: &request_tools,
                    prior_unknown,
                },
                cancellation,
            )
            .await;
            // Recovery advances this source only after retaining complete Main
            // items. They renew compaction just like a completed response, even
            // if the resumed request itself immediately exceeds context.
            if high_water > initial_high_water {
                main_progress = true;
                compaction = CompactionBudget::Available;
            }
            let output = match result {
                Ok(model_attempt::Outcome::Response(output)) => output,
                Ok(model_attempt::Outcome::FinishedByTool) => {
                    crate::interactions::wait_until_clear(
                        &inner.log,
                        &input.invocation,
                        cancellation,
                    )
                    .await?;
                    return Ok(maka_agent_facts::event::InvocationOutcome::Completed);
                }
                Err(
                    error @ RunError::Model(maka_model::ModelError::ContextOverflow {
                        observed_output: false,
                    }),
                ) if (compaction == CompactionBudget::Available || pending.is_some())
                    && tools.code_idle()
                    && effects.is_idle()
                    && !cancellation.is_cancelled() =>
                {
                    let candidate = match pending.take() {
                        Some(candidate) => Some(candidate),
                        None => {
                            auto_context::start(
                                inner,
                                input,
                                opening_id,
                                main_progress,
                                cancellation,
                                continuation_base,
                            )
                            .await?
                        }
                    };
                    if let Some(candidate) = candidate
                        && candidate.adopt(inner, cancellation).await?
                    {
                        compaction = CompactionBudget::Reshaped;
                        continue;
                    }
                    return Err(error);
                }
                Err(error) => return Err(error),
            };
            // Only accepted Main progress renews the budget. Summary events
            // never replenish their own attempts, even though the log advances.
            compaction = CompactionBudget::Available;
            let local_calls: Vec<_> = output
                .tool_calls()
                .filter(|call| !call.provider_executed)
                .collect();
            if local_calls.is_empty() {
                if !tools.finish_output(high_water).await? {
                    main_progress = true;
                    continue;
                }
                return Ok(maka_agent_facts::event::InvocationOutcome::Completed);
            }
            // An exec/wait observation can settle while its cell is still
            // asking the user. Pause before advancing. First settle/reject
            // the entire model tool batch:
            // cancellation must still journal every remaining provider call.
            crate::interactions::wait_until_clear(&inner.log, &input.invocation, cancellation)
                .await?;
            // Pruning/compaction require a settled boundary. A yielded cell is
            // still live work, not a corrupt boundary or a reason to cancel it.
            // Defer maintenance until it settles; the model can still call wait.
            if tools.code_idle() && effects.is_idle() && pending.is_none() && !prior_unknown {
                prune::run(inner, input, cancellation).await?;
            }
            if request_tools.finished() {
                return Ok(maka_agent_facts::event::InvocationOutcome::Completed);
            }
            if !cancellation.is_cancelled() && lane.needs_confirmation() {
                let context =
                    model_attempt::read_source(inner, input, prior_unknown, cancellation).await?;
                let replay = model_attempt::prompt(
                    inner,
                    input,
                    &context,
                    cancellation,
                    continuation_base,
                    &input.invocation.invocation_id,
                    prior_unknown,
                )
                .await?;
                let ids: Vec<_> = local_calls.iter().map(|call| call.id.as_str()).collect();
                let mut replay = surface.apply(replay);
                replay
                    .compile_wire(
                        input.configuration.language,
                        &input.provider,
                        &input.provider_options,
                        &request_tools.definitions(),
                        cancellation,
                    )
                    .await?;
                lane.confirm(&replay.model(), &ids, output.response_id.as_deref())
                    .await;
            }
            main_progress = true;
        }
    })
    .catch_unwind()
    .await
    .unwrap_or_else(|_| Err(crate::cleanup::unconfirmed()));
    let summary_cleanup = auto_context::drain(&mut pending).await;
    let tool_cleanup = tools.shutdown().await;
    if matches!(&result, Err(error) if error.is_cleanup_unconfirmed())
        || matches!(&summary_cleanup, Err(error) if error.is_cleanup_unconfirmed())
        || matches!(
            &tool_cleanup,
            Err(maka_agent_facts::tools::ToolError::CleanupUnconfirmed(_))
        )
    {
        return Err(crate::cleanup::unconfirmed());
    }
    tool_cleanup?;
    summary_cleanup?;
    if matches!(
        result,
        Ok(maka_agent_facts::event::InvocationOutcome::Completed)
    ) && !prior_unknown
    {
        // The last Main can finish while a background Summary fails. Drain first,
        // then reuse admission's zero-materialization safety check so an unknown
        // summary effect becomes a sealed failure, never apparent Turn success.
        inner
            .log
            .prepare_prune_candidates(
                &input.invocation.session_id,
                Some(&input.invocation.invocation_id),
                0,
                0,
                None,
            )
            .await
            .map_err(|error| match error {
                maka_event_log::StoreError::InvalidTransition(reason) => {
                    RunError::ReconciliationRequired(reason)
                }
                maka_event_log::StoreError::HistoryUnsettled => RunError::ReconciliationRequired(
                    "Session contains unsealed or unresolved prior execution".into(),
                ),
                maka_event_log::StoreError::HistoryProviderEffectUnresolved => {
                    RunError::ReconciliationRequired(
                        "Session contains an unresolved prior provider tool effect".into(),
                    )
                }
                error => RunError::Store(error),
            })?;
    }
    result
}
