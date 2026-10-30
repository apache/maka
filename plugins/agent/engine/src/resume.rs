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

use std::{future::Future, pin::Pin, sync::Arc};

use futures_util::{FutureExt, StreamExt, stream::FuturesUnordered};

use maka_agent_facts::{
    event::{CommitError, CommitFuture, EventWrite, Fact, Invocation},
    execution::InvocationConfiguration,
    interaction::{ClosureReason, Decision, InteractionOutcome},
    native_approval::NativeApprovalPending,
    tools::{PreparedEffect, ToolCallContext, ToolError, ToolJournal},
};
use maka_event_log::{
    StoreError,
    native_approvals::{
        ClaimedNativeApproval, NativeApprovalCheckpoint, ParkResult, ParkedActivationReceipt,
    },
    root_store::{InvocationEffects, SessionStore},
};
use tokio_util::sync::CancellationToken;

use crate::{
    ActivationExit, Engine, HandoffGate, RunContext, RunError, RunSettings, RunningInvocation,
};

/// Native owns decoding and authorization; the engine supplies fresh physical custody.
pub trait NativeApprovalExecutor: Send + Sync {
    fn prepare(
        &self,
        pending: NativeApprovalPending,
        context: ToolCallContext,
        cancellation: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<PreparedEffect, ToolError>> + Send + '_>>;
}

pub struct ResumeContinuation {
    pub settings: RunSettings,
    pub tools: maka_tools::ToolCatalog,
}

pub struct ResumeInput {
    pub configuration: InvocationConfiguration,
    pub checkpoint: NativeApprovalCheckpoint,
    pub executor: Arc<dyn NativeApprovalExecutor>,
    pub host_epoch: String,
    pub owner_shutdown: CancellationToken,
    pub continuation:
        futures_util::future::BoxFuture<'static, Result<ResumeContinuation, RunError>>,
    pub tool_names: std::collections::HashSet<String>,
}

impl Engine {
    /// Resumes only a canonical parked checkpoint under fresh session execution custody.
    pub async fn start_resume(
        &self,
        store: SessionStore,
        mut input: ResumeInput,
        cancellation: CancellationToken,
    ) -> Result<RunningInvocation, RunError> {
        let invocation = input.checkpoint.checkpoint.invocation.clone();
        crate::require_session(&store, &invocation)?;
        let execution = store
            .execution_scope(crate::permission_basis(&input.configuration))
            .await?;
        let context = RunContext::new(self.0.clone(), execution.store(), &invocation)?;
        let names = Arc::new(std::mem::take(&mut input.tool_names));
        let root = store
            .turn_boundary(&invocation.session_id, &invocation.turn_id)
            .await?
            .filter(|boundary| boundary.invocation == invocation)
            .ok_or_else(|| {
                RunError::ReconciliationRequired("parked invocation boundary changed".into())
            })?;
        let root_run_id = root.root_invocation().run_id.clone();
        drop(root);
        let handoff = HandoffGate::new(invocation.clone(), root_run_id);
        let worker_handoff = handoff.clone();
        context
            .clone()
            .start_owned(
                execution,
                invocation,
                names,
                Some(handoff),
                cancellation,
                move |cancellation, admitted, effects| {
                    run(
                        context,
                        input,
                        cancellation,
                        admitted,
                        worker_handoff,
                        effects,
                    )
                    .boxed()
                },
            )
            .await
    }
}

async fn checkpoint_state(
    context: &Arc<RunContext>,
    invocation: &Invocation,
    configuration: &InvocationConfiguration,
    current: &NativeApprovalCheckpoint,
) -> Result<crate::steps::ModelResumePoint, RunError> {
    let mut original = context
        .log
        .invocation_configuration(invocation)
        .await?
        .ok_or_else(|| {
            RunError::ReconciliationRequired("parked invocation has no configuration".into())
        })?;
    if original.workspace_binding.map(|binding| binding.id)
        != configuration.workspace_binding.map(|binding| binding.id)
    {
        return Err(RunError::InvalidInput(
            "parked invocation workspace binding changed".into(),
        ));
    }
    original.workspace_binding = configuration.workspace_binding;
    original.boundary_revision = configuration.boundary_revision;
    original.sandbox_mode = configuration.sandbox_mode;
    original.approval_policy = configuration.approval_policy;
    if original != *configuration {
        return Err(RunError::InvalidInput(
            "parked invocation execution configuration changed".into(),
        ));
    }
    let point: crate::steps::ModelResumePoint =
        serde_json::from_value(current.checkpoint.engine.clone()).map_err(|error| {
            RunError::InvalidInput(format!("invalid native approval checkpoint: {error}"))
        })?;
    if point.main_output_limit == Some(0) {
        return Err(RunError::InvalidInput("invalid Main output limit".into()));
    }
    if let Some(value) = &point.context {
        value
            .validate()
            .map_err(|reason| RunError::InvalidInput(reason.into()))?;
    }
    Ok(point)
}

async fn run(
    context: Arc<RunContext>,
    input: ResumeInput,
    cancellation: CancellationToken,
    admitted: tokio::sync::oneshot::Sender<()>,
    handoff: HandoffGate,
    effects: Arc<InvocationEffects>,
) -> Result<ActivationExit, RunError> {
    let ResumeInput {
        configuration,
        checkpoint,
        executor,
        host_epoch,
        owner_shutdown,
        continuation,
        tool_names: _,
    } = input;
    let invocation = checkpoint.checkpoint.invocation.clone();
    let current = context
        .log
        .native_approval_checkpoint(&invocation.session_id)
        .await?
        .ok_or_else(|| {
            RunError::ReconciliationRequired(
                "native approval checkpoint is no longer active".into(),
            )
        })?;
    if current.checkpoint != checkpoint.checkpoint || current.receipt != checkpoint.receipt {
        return Err(RunError::ReconciliationRequired(
            "native approval checkpoint changed".into(),
        ));
    }
    let claim = uuid::Uuid::new_v4().to_string();
    let operations = durable_transition(&context.log, || {
        context
            .log
            .claim_native_approvals(&current.receipt, &claim, &host_epoch)
    })
    .await?;
    let _ = admitted.send(());
    if current.stop_requested {
        cancellation.cancel();
    }
    let result = async {
        let mut state = checkpoint_state(&context, &invocation, &configuration, &current).await;
        let mut stopped = current.stop_requested;
        let mut revoked = current.revoked;
        let journal = ToolJournal::new(context.log.clone(), invocation.clone());
        let owner = NativeOwnerSignal {
            shutdown: owner_shutdown.clone(),
            cancellation: cancellation.clone(),
            epoch: host_epoch.clone(),
        };
        let mut operations = operations;
        let point = loop {
            loop {
                if operations.iter().any(|operation| {
                    matches!(
                        operation.outcome,
                        InteractionOutcome::Closure {
                            reason: ClosureReason::TurnStopped,
                            ..
                        }
                    )
                }) {
                    stopped = true;
                    cancellation.cancel();
                }
                let mut running = FuturesUnordered::new();
                for operation in operations {
                    running.push(
                        resume_operation(
                            context.clone(),
                            executor.clone(),
                            journal.clone(),
                            current.receipt.clone(),
                            operation,
                            owner.clone(),
                            state.is_ok() && !revoked,
                        )
                        .boxed(),
                    );
                }
                while let Some(result) = running.next().await {
                    if let Err(error) = result {
                        cancellation.cancel();
                        state = crate::model_attempt::additional_failure(state, error);
                    }
                }
                if state.as_ref().is_err_and(RunError::is_cleanup_unconfirmed) {
                    return Err(state.expect_err("unconfirmed state checked"));
                }
                let latest = context
                    .log
                    .native_approval_checkpoint(&invocation.session_id)
                    .await
                    .map_err(|error| {
                        quarantine(format!(
                            "native approval stop fence could not be read: {error}"
                        ))
                    })?
                    .ok_or_else(|| {
                        quarantine("native approval checkpoint disappeared before settlement")
                    })?;
                if latest.receipt != current.receipt {
                    return Err(quarantine(
                        "native approval checkpoint changed during settlement",
                    ));
                }
                revoked = latest.revoked;
                if latest.stop_requested {
                    stopped = true;
                    cancellation.cancel();
                }
                if owner_shutdown.is_cancelled()
                    && !stopped
                    && state.is_ok()
                    && (!revoked || latest.pending.is_empty())
                {
                    effects.settle().await?;
                    return Ok(crate::steps::StepExit::Parked(latest.receipt));
                }
                if state.is_ok() && !cancellation.is_cancelled() {
                    break;
                }
                context
                    .log
                    .close_run_interactions(&invocation, ClosureReason::TurnTerminal, now_millis()?)
                    .await?;
                operations = durable_transition(&context.log, || {
                    context
                        .log
                        .claim_native_approvals(&current.receipt, &claim, &host_epoch)
                })
                .await?;
                if operations.is_empty() {
                    break;
                }
            }
            if !effects.is_idle() {
                return Err(quarantine(
                    "native approval effects remain active after settlement",
                ));
            }
            let point = match state {
                Ok(point) => point,
                Err(error) => {
                    if !durable_transition(&context.log, || {
                        context.log.native_approvals_settled(&current.receipt)
                    })
                    .await?
                    {
                        return Err(RunError::ReconciliationRequired(
                            "native approval obligations remain unsettled".into(),
                        ));
                    }
                    return if stopped && !error.is_cleanup_unconfirmed() {
                        Err(RunError::Cancelled)
                    } else {
                        Err(error)
                    };
                }
            };
            if !durable_transition(&context.log, || {
                context.log.native_approvals_settled(&current.receipt)
            })
            .await?
            {
                let mut next = current.checkpoint.clone();
                next.id = uuid::Uuid::new_v4().to_string();
                next.through = context.log.committed_sequence().await?;
                next.engine = serde_json::to_value(&point)
                    .map_err(|error| RunError::Internal(error.to_string()))?;
                if let Some(receipt) = repark(&context.log, &current.receipt, next).await? {
                    return Ok(crate::steps::StepExit::Parked(receipt));
                }
                state = Ok(point);
                operations = durable_transition(&context.log, || {
                    context
                        .log
                        .claim_native_approvals(&current.receipt, &claim, &host_epoch)
                })
                .await?;
                continue;
            }
            break point;
        };
        if cancellation.is_cancelled() {
            if owner_shutdown.is_cancelled()
                && let Some(receipt) = parked_before_model(&context.log, &current.receipt).await?
            {
                return Ok(crate::steps::StepExit::Parked(receipt));
            }
            return Err(RunError::Cancelled);
        }
        if point.finish_turn {
            return Ok(crate::steps::StepExit::Terminal(
                maka_agent_facts::event::InvocationOutcome::Completed,
            ));
        }
        // Preparation may own OAuth workers; shutdown must drain its actual result.
        let next = continuation.await;
        let next = match next {
            Ok(next) => next,
            Err(error) => {
                if owner_shutdown.is_cancelled()
                    && lifecycle_cancelled(&error)
                    && let Some(receipt) =
                        parked_before_model(&context.log, &current.receipt).await?
                {
                    return Ok(crate::steps::StepExit::Parked(receipt));
                }
                return Err(error);
            }
        };
        if owner_shutdown.is_cancelled() {
            return match parked_before_model(&context.log, &current.receipt).await? {
                Some(receipt) => Ok(crate::steps::StepExit::Parked(receipt)),
                None => Err(RunError::Cancelled),
            };
        }
        let ResumeContinuation {
            mut settings,
            tools,
        } = next;
        if settings.invocation != invocation
            || settings.configuration != configuration
            || settings
                .configuration
                .model
                .as_ref()
                .is_some_and(|binding| binding.model != settings.provider.model)
        {
            return Err(RunError::InvalidInput(
                "parked invocation model settings changed".into(),
            ));
        }
        let next = crate::steps::resume(
            &context,
            &mut settings,
            crate::runner::ModelWork {
                tools,
                restored: None,
            },
            point,
            &cancellation,
            &handoff,
            &effects,
        )
        .await;
        if owner_shutdown.is_cancelled()
            && next.as_ref().is_err_and(lifecycle_cancelled)
            && let Some(receipt) = parked_before_model(&context.log, &current.receipt).await?
        {
            return Ok(crate::steps::StepExit::Parked(receipt));
        }
        next
    }
    .await;
    let result = match result {
        Err(error) if error.is_cleanup_unconfirmed() => return Err(error),
        result => result,
    };
    crate::runner::finish(
        &context,
        invocation,
        result.map(|exit| (exit, None)),
        &cancellation,
        Some(&handoff),
        &effects,
    )
    .await
}

fn lifecycle_cancelled(error: &RunError) -> bool {
    matches!(
        error,
        RunError::Cancelled | RunError::Model(maka_model::ModelError::Cancelled)
    )
}

async fn parked_before_model(
    store: &SessionStore,
    receipt: &ParkedActivationReceipt,
) -> Result<Option<ParkedActivationReceipt>, RunError> {
    let current = store
        .native_approval_checkpoint(&receipt.invocation().session_id)
        .await
        .map_err(|error| {
            quarantine(format!(
                "native approval cursor could not be confirmed during shutdown: {error}"
            ))
        })?;
    match current {
        Some(current) if current.receipt != *receipt => {
            Err(quarantine("native approval cursor changed during shutdown"))
        }
        Some(current) if current.stop_requested => Ok(None),
        Some(current) if current.revoked && !current.pending.is_empty() => Err(quarantine(
            "native approval revoked obligations remain unsettled during shutdown",
        )),
        Some(current) => Ok(Some(current.receipt)),
        None => Ok(None),
    }
}

#[derive(Clone)]
struct NativeOwnerSignal {
    shutdown: CancellationToken,
    cancellation: CancellationToken,
    epoch: String,
}

async fn resume_operation(
    context: Arc<RunContext>,
    executor: Arc<dyn NativeApprovalExecutor>,
    journal: ToolJournal,
    receipt: ParkedActivationReceipt,
    operation: ClaimedNativeApproval,
    owner: NativeOwnerSignal,
    can_execute: bool,
) -> Result<(), RunError> {
    let work = async {
        let pending = operation.pending;
        if can_execute
            && owner.shutdown.is_cancelled()
            && durable_transition(&context.log, || {
                context.log.release_native_approval_claim(
                    &receipt,
                    &pending.operation_id,
                    &operation.claim,
                    &owner.epoch,
                )
            })
            .await?
        {
            return Ok(());
        }
        let allowed = can_execute
            && !owner.shutdown.is_cancelled()
            && !owner.cancellation.is_cancelled()
            && matches!(
                operation.outcome,
                InteractionOutcome::ServiceApprovalDecision {
                    decision: Decision::Allow,
                    ..
                }
            );
        let native = if allowed {
            executor
                .prepare(
                    pending.clone(),
                    journal.context(pending.operation_id.clone()),
                    owner.cancellation.clone(),
                )
                .await
        } else {
            Err(ToolError::Failed("service call was not approved".into()))
        };
        let fatal_preparation = matches!(
            &native,
            Err(ToolError::Persistence(_)
                | ToolError::CleanupUnconfirmed(_)
                | ToolError::OperationCleanupUnconfirmed { .. })
        );
        if can_execute
            && owner.shutdown.is_cancelled()
            && !fatal_preparation
            && durable_transition(&context.log, || {
                context.log.release_native_approval_claim(
                    &receipt,
                    &pending.operation_id,
                    &operation.claim,
                    &owner.epoch,
                )
            })
            .await?
        {
            return Ok(());
        }
        let effect = match native {
            Ok(native) => {
                let start_id = uuid::Uuid::new_v4().to_string();
                if durable_transition(&context.log, || {
                    context.log.start_native_approval(
                        &receipt,
                        &pending.operation_id,
                        &operation.claim,
                        &start_id,
                    )
                })
                .await?
                {
                    native
                } else {
                    failed_effect("native approval start was fenced")
                }
            }
            Err(error) => PreparedEffect::new(move |_| Box::pin(async move { Err(error) })),
        };
        let publication_store = context.log.clone();
        let settled = journal
            .resume_prepared_output(
                pending.operation_id.clone(),
                pending.dispatch.sequence,
                owner.cancellation.clone(),
                effect,
                move |write| publish_original_t2(publication_store, write),
            )
            .await;
        if settled.as_ref().is_err_and(|error| {
            matches!(
                error,
                ToolError::CleanupUnconfirmed(_) | ToolError::OperationCleanupUnconfirmed { .. }
            )
        }) {
            return Err(settled.expect_err("unconfirmed error checked").into());
        }
        if let Err(ToolError::Persistence(message)) = &settled {
            return Err(quarantine(format!(
                "native approval T2 publication is unconfirmed: {message}"
            )));
        }
        crate::model_attempt::tool_result(settled.map(|output| output.to_json()))
    };
    std::panic::AssertUnwindSafe(work)
        .catch_unwind()
        .await
        .unwrap_or_else(|_| {
            owner.cancellation.cancel();
            Err(crate::cleanup::unconfirmed())
        })
}

fn publish_original_t2(store: Arc<SessionStore>, write: EventWrite) -> CommitFuture {
    Box::pin(async move {
        let mut changes = match store.subscribe_session_commits(store.id()) {
            Ok(changes) => changes,
            Err(error) => {
                let retained = (write, error);
                std::future::pending::<()>().await;
                drop(retained);
                unreachable!("closed publication observer remains retained")
            }
        };
        // The original normalized T2 and its effect lease stay owned until its receipt.
        let mut rechecked = false;
        let mut warned = false;
        loop {
            match store.append(&write).await {
                Ok(sequence) => return Ok(sequence),
                Err(error) => {
                    if !warned {
                        let operation_id = match &write.event().fact {
                            Fact::ToolSettled { operation_id, .. } => operation_id,
                            _ => unreachable!("the resumed publisher receives only original T2"),
                        };
                        let error_class = match error {
                            CommitError::Retired => "retired",
                            CommitError::PermissionRevoked => "permission_revoked",
                            CommitError::NativeTurnInterrupted => "native_turn_interrupted",
                            CommitError::Rejected(_) => "rejected",
                            CommitError::OutcomeUnknown(_) => "outcome_unknown",
                        };
                        tracing::warn!(
                            stage = "native_approval_t2_unconfirmed",
                            invocation_id = %write.event().invocation.invocation_id,
                            operation_id = %operation_id,
                            event_id = %write.event().id,
                            error_class,
                            "Native approval settlement retains its original owner until publication is confirmed"
                        );
                        warned = true;
                    }
                    if !rechecked {
                        rechecked = true;
                        continue;
                    }
                    if changes.changed().await.is_err() {
                        std::future::pending::<()>().await;
                    }
                    rechecked = false;
                }
            }
        }
    })
}

fn quarantine(message: impl Into<String>) -> RunError {
    ToolError::CleanupUnconfirmed(message.into()).into()
}

async fn durable_transition<T, F, Fut>(
    store: &SessionStore,
    mut operation: F,
) -> Result<T, RunError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, StoreError>>,
{
    let mut changes = store.subscribe_session_commits(store.id())?;
    let mut uncertain = false;
    loop {
        match operation().await {
            Ok(result) => return Ok(result),
            Err(StoreError::CommitUnknown(_) | StoreError::OperationUnknown) if !uncertain => {
                uncertain = true;
            }
            Err(error) if !uncertain || matches!(error, StoreError::InvalidTransition(_)) => {
                return Err(error.into());
            }
            Err(_) => {
                if changes.changed().await.is_err() {
                    std::future::pending::<()>().await;
                }
            }
        }
    }
}

async fn repark(
    store: &SessionStore,
    previous: &ParkedActivationReceipt,
    next: maka_agent_facts::native_approval::ActivationCheckpoint,
) -> Result<Option<ParkedActivationReceipt>, RunError> {
    let remaining = store
        .native_approval_checkpoint(&next.invocation.session_id)
        .await
        .map_err(|error| {
            quarantine(format!(
                "native approval repark checkpoint could not be read: {error}"
            ))
        })?
        .ok_or_else(|| quarantine("native approval checkpoint disappeared during repark"))?;
    let mut changes = store
        .subscribe_session_commits(&next.invocation.session_id)
        .map_err(|error| {
            quarantine(format!(
                "native approval repark observation unavailable: {error}"
            ))
        })?;
    loop {
        match store
            .repark_native_approvals(previous, next.clone(), remaining.pending.clone())
            .await
        {
            Ok(ParkResult::Parked(receipt)) => return Ok(Some(receipt)),
            Ok(ParkResult::Changed) => return Ok(None),
            Err(StoreError::CommitUnknown(_) | StoreError::OperationUnknown) => loop {
                match store
                    .confirm_native_approval_park(&next, &remaining.pending)
                    .await
                {
                    Ok(Some(receipt)) => return Ok(Some(receipt)),
                    Ok(None) => break,
                    Err(_) => {
                        if changes.changed().await.is_err() {
                            std::future::pending::<()>().await;
                        }
                    }
                }
            },
            Err(error) => {
                return Err(quarantine(format!(
                    "native approval repark failed: {error}"
                )));
            }
        }
    }
}

fn failed_effect(message: &'static str) -> PreparedEffect {
    PreparedEffect::new(move |_| Box::pin(async move { Err(ToolError::Failed(message.into())) }))
}
fn now_millis() -> Result<u64, RunError> {
    let value = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| RunError::Internal(error.to_string()))?
        .as_millis();
    u64::try_from(value).map_err(|error| RunError::Internal(error.to_string()))
}
