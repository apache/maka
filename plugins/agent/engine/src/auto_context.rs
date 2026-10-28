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

use crate::{RunContext, RunError, RunSettings, compact};
use maka_agent_facts::context::CheckpointMode;
use maka_agent_facts::context::ModelRequestContext;
use maka_agent_facts::event::EventWrite;
use maka_event_log::context::{ContextView, LatestMainContext};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

/// A cap on this request, never a mutation of the configured model limit.
pub(super) fn output_limit(
    input: &RunSettings,
    source: &ContextView,
) -> Result<Option<u64>, RunError> {
    let limit = maka_agent_facts::context::effective_output_limit(input.main_output_limit);
    let Some(window) = input
        .context
        .as_ref()
        .and_then(|context| context.model_context_window)
    else {
        return Ok(Some(limit));
    };
    let LatestMainContext::Selected(latest) = &source.latest_main else {
        return Ok(Some(limit));
    };
    let connection = input
        .configuration
        .model
        .as_ref()
        .map(|model| model.connection_id.as_str());
    if connection.is_none()
        || latest.connection_id.as_deref() != connection
        || latest.model_id != input.provider.model
        || latest.route_identity != crate::model_attempt::route_identity(input)?
        || !latest.projection_current
        || latest.checkpoint_event_id.as_deref()
            != source
                .baseline
                .as_ref()
                .map(|baseline| baseline.event_id.as_str())
    {
        return Ok(Some(limit));
    }
    let Some(tokens) = latest.usage.input_tokens.filter(|tokens| *tokens > 0) else {
        return Ok(Some(limit));
    };
    let Some(output) = latest.usage.output_tokens else {
        return Ok(Some(limit));
    };
    let retained = tokens.saturating_add(output);
    let thinking = input
        .provider_options
        .pointer("/anthropic/thinking")
        .filter(|thinking| thinking["type"] == "enabled")
        .and_then(|thinking| thinking["budgetTokens"].as_u64())
        .unwrap_or(0);
    Ok(Some(cap_output(limit, window, retained, thinking)))
}

fn cap_output(limit: u64, window: u64, retained: u64, thinking: u64) -> u64 {
    // Leave room for newly appended input. This is not a tokenizer or a proof
    // the next request fits: a useful floor preserves reactive recovery.
    let available = window
        .saturating_sub(retained)
        .saturating_sub(8000)
        .saturating_sub(thinking);
    available.min(limit).max(limit.min(8000))
}

pub(super) fn due(input: &RunSettings, source: &ContextView) -> bool {
    let Some(ModelRequestContext {
        declared_window: Some(window),
        ..
    }) = &input.context
    else {
        return false;
    };
    let LatestMainContext::Selected(latest) = &source.latest_main else {
        return false;
    };
    let Some(connection) = input
        .configuration
        .model
        .as_ref()
        .map(|binding| binding.connection_id.as_str())
    else {
        return false;
    };
    if !latest.projection_current
        || latest.model_id != input.provider.model
        || crate::model_attempt::route_identity(input).as_ref().ok() != Some(&latest.route_identity)
        || latest.connection_id.as_deref() != Some(connection)
        || latest.checkpoint_event_id.as_deref()
            != source
                .baseline
                .as_ref()
                .map(|baseline| baseline.event_id.as_str())
    {
        return false;
    }
    threshold(
        latest.usage.input_tokens,
        latest.usage.output_tokens,
        *window,
    )
}

fn threshold(input: Option<u64>, output: Option<u64>, window: u64) -> bool {
    let Some(input) = input.filter(|tokens| *tokens > 0) else {
        return false;
    };
    input >= window || output.is_some_and(|output| input.saturating_add(output) >= window)
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
        cancellation,
        worker: Some(worker),
    }))
}

pub(super) struct Pending {
    cancellation: CancellationToken,
    worker: Option<tokio::task::JoinHandle<Result<compact::Candidate, RunError>>>,
}

impl Pending {
    pub fn is_finished(&self) -> bool {
        self.worker
            .as_ref()
            .is_some_and(|worker| worker.is_finished())
    }

    async fn join(mut self) -> Result<Option<maka_agent_facts::event::RuntimeEvent>, RunError> {
        match self
            .worker
            .take()
            .expect("candidate has one owner")
            .await
            .map_err(|_| crate::cleanup::unconfirmed())?
        {
            Ok((_, checkpoint)) => Ok(checkpoint),
            Err(RunError::Model(_) | RunError::Cancelled) => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub async fn adopt(
        self,
        inner: &RunContext,
        invocation: &maka_agent_facts::event::Invocation,
        cancellation: &CancellationToken,
    ) -> Result<bool, RunError> {
        let waiting: Result<(), RunError> = async {
            if !self.is_finished() && !cancellation.is_cancelled() {
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
            self.cancellation.cancel();
        }
        let checkpoint = self.join().await?;
        waiting?;
        if cancellation.is_cancelled() {
            return Err(RunError::Cancelled);
        }
        let Some(checkpoint) = checkpoint else {
            return Ok(false);
        };
        let session = checkpoint.invocation.session_id.clone();
        inner.log.append(&EventWrite::plain(checkpoint)?).await?;
        inner.shared.clear_loaded(&session)?;
        Ok(true)
    }
}

impl Drop for Pending {
    fn drop(&mut self) {
        self.cancellation.cancel();
    }
}

pub(super) async fn drain(pending: &mut Option<Pending>) -> Result<(), RunError> {
    if let Some(pending) = pending.take() {
        pending.cancellation.cancel();
        pending.join().await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{cap_output, threshold};
    #[test]
    fn output_reserve_keeps_a_useful_floor_without_exceeding_the_selected_limit() {
        assert_eq!(cap_output(128_000, 200_000, 100_000, 0), 92_000);
        assert_eq!(cap_output(128_000, 200_000, 100_000, 1024), 90_976);
        assert_eq!(cap_output(128_000, 200_000, 191_999, 0), 8000);
        assert_eq!(cap_output(128_000, 200_000, u64::MAX, u64::MAX), 8000);
        assert_eq!(cap_output(4096, 200_000, 199_999, 0), 4096);
    }
    #[test]
    fn actual_usage_threshold_preserves_unknown_without_reserving_output_twice() {
        assert!(!threshold(None, Some(5000), 1));
        assert!(!threshold(Some(0), Some(5000), 1));
        assert!(threshold(Some(100), None, 100));
        assert!(!threshold(Some(100), None, 101));
        assert!(threshold(Some(100), Some(20), 120));
        assert!(!threshold(Some(100), Some(20), 121));
        assert!(threshold(Some(100), Some(5000), 5100));
        assert!(!threshold(Some(100), Some(5000), 5101));
    }
}
