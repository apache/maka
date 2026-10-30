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

use std::sync::Arc;

use futures_util::{FutureExt, future::BoxFuture};
use maka_agent_facts::{
    event::InvocationOutcome, model_retry::ModelRetryConsumption,
    native_approval::ActivationSuspension,
};
use maka_event_log::{
    native_approvals::ActivationCheckpointRecord,
    root_store::{InvocationEffects, SessionStore},
};
use tokio_util::sync::CancellationToken;

use crate::{
    ActivationExit, Engine, HandoffGate, ResumeContinuation, RunContext, RunError,
    RunningInvocation,
};

/// Native preparation validates the accepted binding and grants a fresh execution ceiling.
pub struct RetryResumeInput {
    pub checkpoint: ActivationCheckpointRecord,
    /// Current session authority, captured independently of provider preparation.
    pub permission_basis: Option<maka_agent_facts::workspace::PermissionBasis>,
    pub continuation: BoxFuture<'static, Result<ResumeContinuation, RunError>>,
    pub owner_shutdown: CancellationToken,
    pub host_epoch: String,
}

impl Engine {
    /// Reopens physical custody without creating a new logical model request.
    pub async fn start_retry_resume(
        &self,
        store: SessionStore,
        input: RetryResumeInput,
        cancellation: CancellationToken,
    ) -> Result<RunningInvocation, RunError> {
        let RetryResumeInput {
            checkpoint,
            permission_basis,
            continuation,
            owner_shutdown,
            host_epoch: _,
        } = input;
        let invocation = checkpoint.checkpoint.invocation.clone();
        crate::require_session(&store, &invocation)?;
        if !matches!(
            checkpoint.checkpoint.suspension,
            ActivationSuspension::ModelRetry { .. }
        ) {
            return Err(RunError::InvalidInput(
                "checkpoint is not a model retry".into(),
            ));
        }
        let ActivationSuspension::ModelRetry { plan } = &checkpoint.checkpoint.suspension else {
            unreachable!("retry suspension checked above");
        };
        if checkpoint.stop_requested || checkpoint.revoked {
            return Err(RunError::Cancelled);
        }
        let postponed = owner_shutdown.is_cancelled()
            || maka_model::ProviderFailure::now_unix_ms() < plan.not_before_unix_ms;
        // Early wakes and owner shutdown keep the original durable checkpoint untouched.
        let next = if postponed {
            None
        } else {
            Some(continuation.await)
        };
        let fresh = next.as_ref().and_then(|next| next.as_ref().ok());
        if next
            .as_ref()
            .is_some_and(|next| next.as_ref().is_err_and(RunError::is_cleanup_unconfirmed))
        {
            return Err(crate::cleanup::unconfirmed());
        }
        let execution = store.execution_scope(permission_basis).await?;
        let context = RunContext::new(self.0.clone(), execution.store(), &invocation)?;
        let root = store
            .turn_boundary(&invocation.session_id, &invocation.turn_id)
            .await?
            .filter(|boundary| boundary.invocation == invocation)
            .ok_or_else(|| {
                RunError::ReconciliationRequired("parked invocation boundary changed".into())
            })?;
        let handoff = HandoffGate::new(invocation.clone(), root.root_invocation().run_id.clone());
        let names = Arc::new(
            fresh
                .map(|next| next.tools.names().into_iter().collect())
                .unwrap_or_default(),
        );
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
                        checkpoint,
                        next,
                        owner_shutdown,
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

#[allow(clippy::too_many_arguments)]
async fn run(
    context: Arc<RunContext>,
    expected: ActivationCheckpointRecord,
    next: Option<Result<ResumeContinuation, RunError>>,
    owner_shutdown: CancellationToken,
    cancellation: CancellationToken,
    admitted: tokio::sync::oneshot::Sender<()>,
    handoff: HandoffGate,
    effects: Arc<InvocationEffects>,
) -> Result<ActivationExit, RunError> {
    let invocation = expected.checkpoint.invocation.clone();
    let current = context
        .log
        .activation_checkpoint(&invocation.session_id)
        .await?
        .filter(|current| {
            current.checkpoint == expected.checkpoint && current.receipt == expected.receipt
        })
        .ok_or_else(|| RunError::ReconciliationRequired("model retry checkpoint changed".into()))?;
    let ActivationSuspension::ModelRetry { plan } = &current.checkpoint.suspension else {
        return Err(RunError::ReconciliationRequired(
            "model retry suspension changed".into(),
        ));
    };
    let _ = admitted.send(());
    let result = async {
        if current.stop_requested || current.revoked {
            return Ok(crate::steps::StepExit::Terminal(
                InvocationOutcome::Cancelled {
                    source: if current.stop_requested {
                        "turn_stopped"
                    } else {
                        "model_retry_revoked"
                    }
                    .into(),
                },
            ));
        }
        if owner_shutdown.is_cancelled() {
            return Ok(crate::steps::StepExit::Parked(current.receipt.clone()));
        }
        if cancellation.is_cancelled() {
            return Err(RunError::Cancelled);
        }
        if maka_model::ProviderFailure::now_unix_ms() < plan.not_before_unix_ms {
            return Ok(crate::steps::StepExit::Parked(current.receipt.clone()));
        }
        let ResumeContinuation {
            mut settings,
            tools,
        } = next.ok_or_else(|| {
            RunError::ReconciliationRequired("model retry has no fresh execution settings".into())
        })??;
        if settings.invocation != invocation {
            return Err(RunError::InvalidInput(
                "model retry invocation changed".into(),
            ));
        }
        let point: crate::steps::ModelResumePoint =
            serde_json::from_value(current.checkpoint.engine.clone()).map_err(|error| {
                RunError::InvalidInput(format!("invalid model retry checkpoint: {error}"))
            })?;
        let consumption = ModelRetryConsumption {
            checkpoint_id: current.receipt.checkpoint_id().into(),
            revision: current.receipt.revision(),
            plan: plan.clone(),
        };
        crate::steps::resume_retry(
            &context,
            &mut settings,
            crate::runner::ModelWork {
                tools,
                restored: None,
            },
            crate::steps::RetryContinuation { point, consumption },
            &cancellation,
            &handoff,
            &effects,
        )
        .await
    }
    .await;
    let result = if owner_shutdown.is_cancelled()
        && result.as_ref().is_err_and(|error| {
            matches!(
                error,
                RunError::Cancelled | RunError::Model(maka_model::ModelError::Cancelled)
            )
        }) {
        let latest = context
            .log
            .activation_checkpoint(&invocation.session_id)
            .await
            .map_err(|_| crate::cleanup::unconfirmed())?;
        match latest {
            Some(latest)
                if latest.receipt == current.receipt
                    && latest.checkpoint == current.checkpoint
                    && !latest.revoked
                    && !latest.stop_requested =>
            {
                Ok(crate::steps::StepExit::Parked(latest.receipt))
            }
            _ => result,
        }
    } else {
        result
    };
    if result.as_ref().is_err_and(RunError::is_cleanup_unconfirmed) {
        return Err(crate::cleanup::unconfirmed());
    }
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

#[cfg(test)]
mod tests;
