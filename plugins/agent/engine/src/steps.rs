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

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelResumePoint {
    pub opening_id: String,
    pub context: Option<maka_agent_facts::context::ModelRequestContext>,
    pub provider_options: serde_json::Value,
    pub main_output_limit: Option<u64>,
    pub supports_vision: bool,
    pub tools: maka_agent_facts::handoff::HandoffTools,
    pub compaction: maka_agent_facts::handoff::CompactionBudget,
    pub replay_base: Option<u64>,
    pub prior_unknown: bool,
    pub inspected_through: u64,
    pub main_progress: bool,
    pub finish_turn: bool,
}

pub(super) enum StepExit {
    Terminal(maka_agent_facts::event::InvocationOutcome),
    Parked(maka_event_log::native_approvals::ParkedActivationReceipt),
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn run(
    inner: &Arc<RunContext>,
    input: &mut RunSettings,
    work: crate::runner::ModelWork,
    opening_id: &str,
    cancellation: &CancellationToken,
    continuation_base: Option<u64>,
    handoff: &crate::HandoffGate,
    prior_unknown: bool,
    inspected_through: u64,
    effects: &maka_event_log::root_store::InvocationEffects,
) -> Result<StepExit, RunError> {
    run_from(
        inner,
        input,
        work,
        opening_id,
        cancellation,
        continuation_base,
        handoff,
        prior_unknown,
        inspected_through,
        effects,
        None,
    )
    .await
}

pub(super) async fn resume(
    inner: &Arc<RunContext>,
    input: &mut RunSettings,
    work: crate::runner::ModelWork,
    point: ModelResumePoint,
    cancellation: &CancellationToken,
    handoff: &crate::HandoffGate,
    effects: &maka_event_log::root_store::InvocationEffects,
) -> Result<StepExit, RunError> {
    input.context = point.context.clone();
    input.provider_options = point.provider_options.clone();
    input.main_output_limit = point.main_output_limit;
    input.supports_vision = point.supports_vision;
    let opening_id = point.opening_id.clone();
    run_from(
        inner,
        input,
        work,
        &opening_id,
        cancellation,
        point.replay_base,
        handoff,
        point.prior_unknown,
        point.inspected_through,
        effects,
        Some(point),
    )
    .await
}

#[allow(clippy::too_many_arguments)] // Admission policy must remain visible across the step loop.
async fn run_from(
    inner: &Arc<RunContext>,
    input: &mut RunSettings,
    work: crate::runner::ModelWork,
    opening_id: &str,
    cancellation: &CancellationToken,
    continuation_base: Option<u64>,
    handoff: &crate::HandoffGate,
    prior_unknown: bool,
    mut inspected_through: u64,
    effects: &maka_event_log::root_store::InvocationEffects,
    resume: Option<ModelResumePoint>,
) -> Result<StepExit, RunError> {
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
        let mut compaction = resume
            .as_ref()
            .map_or(CompactionBudget::Available, |point| point.compaction);
        // This tracks work after this physical opening, not after the logical root.
        // A successor may compact the sealed prefix with a PreTurn boundary.
        let mut main_progress = resume.as_ref().is_some_and(|point| point.main_progress);
        if let Some(point) = &resume {
            tools.restore(&point.tools)?;
            if point.finish_turn {
                return Ok(StepExit::Terminal(
                    maka_agent_facts::event::InvocationOutcome::Completed,
                ));
            }
        }
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
                        model_attempt::rendered_system(input),
                        maka_agent_facts::context::ModelPurpose::Main,
                    )
                    .await
                    .ok()?;
                    let checkpoint = match tools.checkpoint() {
                        Ok(checkpoint) => checkpoint,
                        Err(error) => {
                            handoff_cleanup = Some(match prompt.close().await {
                                Err(cleanup) => crate::cleanup::preparation_failed(cleanup),
                                Ok(()) => error.into(),
                            });
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
                return Ok(StepExit::Terminal(
                    maka_agent_facts::event::InvocationOutcome::HandoffPaused { pause },
                ));
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
                    .adopt(inner, &input.invocation, cancellation)
                    .await?
            {
                compaction = CompactionBudget::Reshaped;
            }
            let mut context =
                model_attempt::read_source(inner, input, prior_unknown, cancellation).await?;
            tools.set_model(input.provider.tool_context());
            let (mut request_tools, mut surface) =
                capture_surface(inner, input, &tools, &context, prior_unknown, cancellation)
                    .await?;
            let mut prompt = model_attempt::prompt(
                inner,
                input,
                &context,
                cancellation,
                continuation_base,
                &input.invocation.invocation_id,
                prior_unknown,
                surface.system(),
                maka_agent_facts::context::ModelPurpose::Main,
            )
            .await?;
            let needs_compaction = crate::context_input::needs_compaction(input, &prompt);
            if tools.code_idle()
                && effects.is_idle()
                && !prior_unknown
                && ((needs_compaction && pending.is_some())
                    || (compaction == CompactionBudget::Available
                        && pending.is_none()
                        && (needs_compaction || auto_context::due(input, &context))))
            {
                prompt
                    .close()
                    .await
                    .map_err(crate::cleanup::preparation_failed)?;
                drop(prompt);
                drop(context);
                drop(request_tools);
                drop(surface);
                compaction = CompactionBudget::Failed;
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
                if let Some(candidate) = candidate {
                    if !needs_compaction {
                        pending = Some(candidate);
                    } else if candidate
                        .adopt(inner, &input.invocation, cancellation)
                        .await?
                    {
                        compaction = CompactionBudget::Reshaped;
                    }
                }
                // Compaction makes its own logical requests. The next Main
                // must observe any provider change made meanwhile.
                input.refresh_model(cancellation).await?;
                context =
                    model_attempt::read_source(inner, input, prior_unknown, cancellation).await?;
                tools.set_model(input.provider.tool_context());
                (request_tools, surface) =
                    capture_surface(inner, input, &tools, &context, prior_unknown, cancellation)
                        .await?;
                prompt = model_attempt::prompt(
                    inner,
                    input,
                    &context,
                    cancellation,
                    continuation_base,
                    &input.invocation.invocation_id,
                    prior_unknown,
                    surface.system(),
                    maka_agent_facts::context::ModelPurpose::Main,
                )
                .await?;
            }
            let initial_high_water = context.source_evidence.high_water;
            let (high_water, result) = model_attempt::execute_main(
                inner,
                input,
                context,
                prompt,
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
            let mut output = match result {
                Ok(model_attempt::Outcome::Response(output)) => output,
                Ok(model_attempt::Outcome::FinishedByTool) => {
                    crate::interactions::wait_until_clear(
                        &inner.log,
                        &input.invocation,
                        cancellation,
                    )
                    .await?;
                    return Ok(StepExit::Terminal(
                        maka_agent_facts::event::InvocationOutcome::Completed,
                    ));
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
                        && candidate
                            .adopt(inner, &input.invocation, cancellation)
                            .await?
                    {
                        compaction = CompactionBudget::Reshaped;
                        continue;
                    }
                    return Err(error);
                }
                Err(error) => return Err(error),
            };
            if !output.approvals.is_empty() {
                let resume = ModelResumePoint {
                    opening_id: opening_id.to_owned(),
                    context: input.context.clone(),
                    provider_options: input.provider_options.clone(),
                    main_output_limit: input.main_output_limit,
                    supports_vision: input.supports_vision,
                    tools: tools.checkpoint()?,
                    compaction: CompactionBudget::Available,
                    replay_base: continuation_base,
                    prior_unknown,
                    inspected_through,
                    main_progress: true,
                    finish_turn: request_tools.finished(),
                };
                if let Some(receipt) = approval_frontier(
                    inner,
                    input,
                    &tools,
                    &request_tools,
                    &mut output.approvals,
                    &mut pending,
                    resume,
                    cancellation,
                    effects,
                )
                .await?
                {
                    return Ok(StepExit::Parked(receipt));
                }
            }
            // Only accepted Main progress renews the budget. Summary events
            // never replenish their own attempts, even though the log advances.
            compaction = CompactionBudget::Available;
            if output.local_call_ids.is_empty() {
                if !tools.finish_output(high_water).await? {
                    main_progress = true;
                    continue;
                }
                return Ok(StepExit::Terminal(
                    maka_agent_facts::event::InvocationOutcome::Completed,
                ));
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
                prune::run(inner, input, cancellation, &mut inspected_through).await?;
            }
            if request_tools.finished() {
                return Ok(StepExit::Terminal(
                    maka_agent_facts::event::InvocationOutcome::Completed,
                ));
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
                    surface.system(),
                    maka_agent_facts::context::ModelPurpose::Main,
                )
                .await?;
                let ids: Vec<_> = output.local_call_ids.iter().map(String::as_str).collect();
                let mut replay = replay;
                let confirmation = async {
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
                    Ok::<_, RunError>(())
                }
                .await;
                replay
                    .close()
                    .await
                    .map_err(crate::cleanup::preparation_failed)?;
                confirmation?;
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
        Ok(StepExit::Terminal(
            maka_agent_facts::event::InvocationOutcome::Completed
        ))
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

#[allow(clippy::too_many_arguments)]
async fn approval_frontier(
    inner: &Arc<RunContext>,
    input: &RunSettings,
    tools: &RunTools,
    request: &maka_tools::RequestTools<'_>,
    approvals: &mut futures_util::stream::FuturesUnordered<maka_tools::PendingCall>,
    summary: &mut Option<auto_context::Pending>,
    mut point: ModelResumePoint,
    cancellation: &CancellationToken,
    effects: &maka_event_log::root_store::InvocationEffects,
) -> Result<Option<maka_event_log::native_approvals::ParkedActivationReceipt>, RunError> {
    use futures_util::{StreamExt, stream::FuturesUnordered};
    use maka_event_log::native_approvals::ParkResult;
    let mut changes = inner
        .log
        .subscribe_session_commits(&input.invocation.session_id)?;
    let mut running = FuturesUnordered::new();
    let mut failure = None;
    // Summary cleanup may await physical provider work. Keep answering the
    // original calls while that independent owner confirms its cleanup.
    {
        let cleanup = auto_context::drain(summary);
        tokio::pin!(cleanup);
        loop {
            tokio::select! {
                result = &mut cleanup => {
                    if let Err(error) = result {
                        cancellation.cancel();
                        failure = Some(error);
                    }
                    break;
                }
                execution = approvals.next(), if !approvals.is_empty() => {
                    running.push(model_attempt::catch_tool(execution.expect("nonempty approval set")));
                }
                result = running.next(), if !running.is_empty() => {
                    if let Err(error) = model_attempt::tool_result(result.expect("nonempty native execution set")) {
                        cancellation.cancel();
                        failure = Some(error);
                    }
                }
            }
        }
    }
    let mut reconsider = true;
    loop {
        // Poll answers before capturing the immutable transaction proposal.
        while let Some(Some(execution)) = approvals.next().now_or_never() {
            running.push(model_attempt::catch_tool(execution));
        }
        if approvals.is_empty() && running.is_empty() {
            return failure.map_or(Ok(None), Err);
        }
        if failure.is_none() && cancellation.is_cancelled() {
            failure = Some(RunError::Cancelled);
        }
        if reconsider
            && failure.is_none()
            && running.is_empty()
            && tools.code_idle()
            && effects.is_idle()
            && let Some(native_basis) = input.native_activation_basis.as_ref()
        {
            let pending: Vec<_> = approvals
                .iter()
                .map(|call| call.pending().clone())
                .collect();
            let proposal = async {
                point.tools = tools.checkpoint()?;
                point.finish_turn = request.finished();
                let checkpoint = maka_agent_facts::native_approval::ActivationCheckpoint {
                    id: uuid::Uuid::new_v4().to_string(),
                    invocation: input.invocation.clone(),
                    through: inner.log.committed_sequence().await?,
                    engine: serde_json::to_value(&point)
                        .map_err(|error| RunError::Internal(error.to_string()))?,
                    native_basis: native_basis
                        .checkpoint_value()
                        .map_err(RunError::Checkpoint)?,
                };
                match inner
                    .log
                    .park_native_approvals(checkpoint.clone(), pending.clone())
                    .await
                {
                    Ok(ParkResult::Parked(receipt)) => Ok(Some(receipt)),
                    Ok(ParkResult::Changed) => Ok(None),
                    Err(
                        maka_event_log::StoreError::CommitUnknown(_)
                        | maka_event_log::StoreError::OperationUnknown,
                    ) => {
                        // Until an authoritative observation resolves this exact
                        // proposal, neither physical owner may start an effect.
                        loop {
                            match inner
                                .log
                                .confirm_native_approval_park(&checkpoint, &pending)
                                .await
                            {
                                Ok(receipt) => return Ok(receipt),
                                Err(_) => {
                                    if changes.changed().await.is_err() {
                                        std::future::pending::<()>().await;
                                    }
                                }
                            }
                        }
                    }
                    Err(error) => Err(error.into()),
                }
            };
            tokio::pin!(proposal);
            let proposal = loop {
                tokio::select! {
                    result = &mut proposal => break result,
                    execution = approvals.next(), if !approvals.is_empty() => {
                        // Answer reads may own queued fair permits needed by the
                        // proposal. Keep polling them, but freeze original effects
                        // until this exact proposal has an authoritative result.
                        running.push(model_attempt::catch_tool(execution.expect("nonempty approval set")));
                    }
                }
            };
            match proposal {
                Ok(Some(receipt)) => return Ok(Some(receipt)),
                Ok(None) => reconsider = false,
                Err(error) => {
                    cancellation.cancel();
                    failure = Some(error);
                }
            }
        }
        tokio::select! {
            execution = approvals.next(), if !approvals.is_empty() => {
                running.push(model_attempt::catch_tool(execution.expect("nonempty approval set")));
                reconsider = true;
            }
            result = running.next(), if !running.is_empty() => {
                if let Err(error) = model_attempt::tool_result(result.expect("nonempty native execution set")) {
                    cancellation.cancel();
                    failure = Some(error);
                }
                reconsider = true;
            }
            changed = changes.changed(), if failure.is_none() => {
                if let Err(error) = changed {
                    cancellation.cancel();
                    failure = Some(RunError::Internal(error.to_string()));
                }
                reconsider = true;
            }
            _ = cancellation.cancelled(), if failure.is_none() => {
                failure = Some(RunError::Cancelled);
            }
        }
    }
}

async fn capture_surface<'tools>(
    inner: &RunContext,
    input: &RunSettings,
    tools: &'tools RunTools,
    context: &maka_event_log::context::ContextView,
    prior_unknown: bool,
    cancellation: &CancellationToken,
) -> Result<
    (
        maka_tools::RequestTools<'tools>,
        Arc<crate::request_composition::Surface>,
    ),
    RunError,
> {
    let request_tools = tools
        .capture(&input.configuration.cwd, cancellation.clone())
        .await?;
    let unknown_notice = prior_unknown
        .then(|| model_attempt::prior_unknown_notice(context, input.configuration.language));
    if unknown_notice.as_deref() == Some("") {
        return Err(RunError::ReconciliationRequired(
            "unknown prior tool is missing from model context".into(),
        ));
    }
    let surface = Arc::new(crate::request_composition::Surface::capture(
        &request_tools,
        &inner.shared.model,
        input,
        context,
        unknown_notice.as_deref(),
    )?);
    Ok((request_tools, surface))
}
