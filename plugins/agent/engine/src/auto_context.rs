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

// Measured usage and separate preparation/adoption follow OpenCode V2
// 55276f2108c8853f94cf16dc530e7754a6ce8318; see docs/code-origin-audit.md and LICENSE.
use crate::{RunContext, RunError, RunSettings, compact};
use maka_agent_facts::context::CheckpointMode;
use maka_agent_facts::context::ModelRequestContext;
use maka_agent_facts::event::EventWrite;
use maka_event_log::context::{ContextView, LatestMainContext};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy)]
pub(super) struct Calibration {
    input: u64,
    estimated: u64,
}
impl Calibration {
    pub fn estimate(self, current: u64) -> u64 {
        if current >= self.estimated {
            self.input.saturating_add(current - self.estimated)
        } else {
            self.input.saturating_sub(self.estimated - current)
        }
    }
}

pub(super) fn calibration(
    provider: &maka_model::ProviderConfig,
    binding: Option<&maka_agent_facts::execution::ModelBinding>,
    latest: &LatestMainContext,
    checkpoint: Option<&str>,
) -> Result<Option<Calibration>, RunError> {
    let (Some(binding), LatestMainContext::Selected(latest)) = (binding, latest) else {
        return Ok(None);
    };
    if latest.model_id != provider.model
        || latest.route_identity != crate::runner::digest(provider)?
        || latest.connection_id.as_deref() != Some(binding.connection_id.as_str())
        || latest.checkpoint_event_id.as_deref() != checkpoint
    {
        return Ok(None);
    }
    let (Some(input), Some(breakdown)) = (
        latest.usage.input_tokens.filter(|n| *n > 0),
        latest.context_breakdown.as_ref(),
    ) else {
        return Ok(None);
    };
    // The previous input is measured, including cache reads. Only the change in
    // rendered input is estimated, including archived results removed since that request.
    Ok(Some(Calibration {
        input,
        estimated: breakdown.estimated_tokens(),
    }))
}

pub(super) fn estimate(
    input: &RunSettings,
    source: &ContextView,
    prompt: &crate::prepared_prompt::PreparedPrompt,
    tools: &[Arc<maka_agent_facts::tools::ToolDefinition>],
) -> Result<u64, RunError> {
    let current = prompt.breakdown().estimated_tokens().saturating_add(
        maka_agent_facts::context::measure::breakdown(&[], tools).estimated_tokens(),
    );
    let baseline = calibration(
        &input.provider,
        input.configuration.model.as_ref(),
        &source.latest_main,
        source
            .baseline
            .as_ref()
            .map(|baseline| baseline.event_id.as_str()),
    )?;
    Ok(baseline.map_or(current, |baseline| baseline.estimate(current)))
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Timing {
    Continue,
    Prepare,
    Adopt,
}

// Starting at 85% of the adoption threshold gives the summarizer time to run
// while Main continues. This does not reduce the admitted context window.
const PREPARE_PERCENT: u128 = 85;

pub(super) fn timing(input: &RunSettings, tokens: u64) -> Timing {
    let Some(ModelRequestContext {
        operation: maka_agent_facts::context::ModelOperation::Inference,
        declared_window: Some(window),
        ..
    }) = &input.context
    else {
        return Timing::Continue;
    };
    if tokens >= *window {
        Timing::Adopt
    } else if u128::from(tokens) * 100 >= u128::from(*window) * PREPARE_PERCENT {
        Timing::Prepare
    } else {
        Timing::Continue
    }
}

pub(super) async fn start(
    inner: &Arc<RunContext>,
    input: &mut RunSettings,
    opening_id: &str,
    mid_turn: bool,
    cancellation: &CancellationToken,
    continuation_base: Option<u64>,
) -> Result<Option<Pending>, RunError> {
    let mode = if mid_turn {
        CheckpointMode::MidTurn {
            anchor_event_id: opening_id.to_owned(),
        }
    } else {
        CheckpointMode::PreTurn
    };
    let job = match compact::capture(inner, input, &mode, cancellation, continuation_base).await {
        Ok(Some(job)) => job,
        Ok(None) => {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    let cancellation = cancellation.child_token();
    let worker_cancel = cancellation.clone();
    let inner = inner.clone();
    let cleanup = crate::cleanup::current();
    let worker =
        tokio::spawn(async move { cleanup.scope(job.execute(&inner, &worker_cancel)).await });
    Ok(Some(Pending {
        cancellation: CancelGuard(cancellation),
        state: CandidateState::Running(worker),
    }))
}

struct CancelGuard(CancellationToken);

impl Drop for CancelGuard {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

enum CandidateState {
    Running(tokio::task::JoinHandle<Result<compact::Candidate, RunError>>),
    Ready(Box<maka_agent_facts::event::RuntimeEvent>),
}

pub(super) struct Pending {
    cancellation: CancelGuard,
    state: CandidateState,
}

async fn join_worker(
    worker: tokio::task::JoinHandle<Result<compact::Candidate, RunError>>,
) -> Result<Option<maka_agent_facts::event::RuntimeEvent>, RunError> {
    match worker.await.map_err(|_| crate::cleanup::unconfirmed())? {
        Ok((_, checkpoint)) => Ok(checkpoint),
        Err(RunError::Model(_) | RunError::Cancelled) => Ok(None),
        Err(error) => Err(error),
    }
}

impl Pending {
    pub async fn adopt(
        self,
        inner: &RunContext,
        invocation: &maka_agent_facts::event::Invocation,
        cancellation: &CancellationToken,
    ) -> Result<bool, RunError> {
        let Self {
            cancellation: guard,
            state,
        } = self;
        let checkpoint = match state {
            CandidateState::Ready(checkpoint) => Some(*checkpoint),
            CandidateState::Running(worker) => {
                let waiting: Result<(), RunError> = async {
                    if !worker.is_finished() && !cancellation.is_cancelled() {
                        inner
                            .log
                            .append(&EventWrite::plain(
                                maka_agent_facts::event::RuntimeEvent::new(
                                    invocation.clone(),
                                    maka_agent_facts::event::Fact::ContextCompactionWaiting,
                                ),
                            )?)
                            .await?;
                    }
                    Ok(())
                }
                .await;
                if waiting.is_err() {
                    guard.0.cancel();
                }
                let checkpoint = join_worker(worker).await?;
                waiting?;
                checkpoint
            }
        };
        if cancellation.is_cancelled() {
            return Err(RunError::Cancelled);
        }
        let Some(checkpoint) = checkpoint else {
            return Ok(false);
        };
        record(inner, checkpoint).await?;
        Ok(true)
    }
}

pub(super) async fn settle(pending: &mut Option<Pending>) -> Result<(), RunError> {
    if !matches!(
        pending,
        Some(Pending {
            state: CandidateState::Running(worker),
            ..
        }) if worker.is_finished()
    ) {
        return Ok(());
    }
    let Some(Pending {
        cancellation,
        state: CandidateState::Running(worker),
    }) = pending.take()
    else {
        unreachable!();
    };
    if let Some(checkpoint) = join_worker(worker).await? {
        *pending = Some(Pending {
            cancellation,
            state: CandidateState::Ready(Box::new(checkpoint)),
        });
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn compact_now(
    inner: &Arc<RunContext>,
    input: &mut RunSettings,
    opening_id: &str,
    mid_turn: bool,
    cancellation: &CancellationToken,
    continuation_base: Option<u64>,
    pending: &mut Option<Pending>,
    compaction: &mut maka_agent_facts::handoff::CompactionBudget,
) -> Result<bool, RunError> {
    if let Some(candidate) = pending.take()
        && candidate
            .adopt(inner, &input.invocation, cancellation)
            .await?
    {
        return Ok(true);
    }
    if *compaction != maka_agent_facts::handoff::CompactionBudget::Available {
        return Ok(false);
    }
    *compaction = maka_agent_facts::handoff::CompactionBudget::Failed;
    let Some(candidate) = start(
        inner,
        input,
        opening_id,
        mid_turn,
        cancellation,
        continuation_base,
    )
    .await?
    else {
        return Ok(false);
    };
    candidate
        .adopt(inner, &input.invocation, cancellation)
        .await
}

pub(super) async fn record(
    inner: &RunContext,
    checkpoint: maka_agent_facts::event::RuntimeEvent,
) -> Result<(), RunError> {
    let session = checkpoint.invocation.session_id.clone();
    inner.log.append(&EventWrite::plain(checkpoint)?).await?;
    inner.shared.clear_loaded(&session)?;
    Ok(())
}

pub(super) async fn drain(
    pending: &mut Option<Pending>,
) -> Result<Option<maka_agent_facts::event::RuntimeEvent>, RunError> {
    if let Some(Pending {
        cancellation,
        state,
    }) = pending.take()
    {
        cancellation.0.cancel();
        match state {
            CandidateState::Running(worker) => return join_worker(worker).await,
            CandidateState::Ready(checkpoint) => return Ok(Some(*checkpoint)),
        }
    }
    Ok(None)
}
