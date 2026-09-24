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

use crate::{Inner, RunError, RunInput, compact, history};
use maka_event_log::context::{LatestMainContext, ModelContextSource};
use maka_runtime::{
    context::{CheckpointMode, ModelRequestContext},
    event::{EventWrite, Fact},
};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

/// A cap on this request, never a mutation of the configured model limit.
pub(super) fn output_limit(
    input: &RunInput,
    source: &ModelContextSource,
    reshaped: bool,
) -> Result<Option<u64>, RunError> {
    const RECOVERY_OUTPUT: u64 = 8000;
    let limit = input.main_output_limit;
    if reshaped {
        return Ok(Some(limit.unwrap_or(RECOVERY_OUTPUT).min(RECOVERY_OUTPUT)));
    }
    let Some((limit, window)) = limit.zip(
        input
            .context
            .as_ref()
            .and_then(|context| context.model_context_window),
    ) else {
        return Ok(limit);
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
    let retained = tokens.saturating_add(latest.usage.output_tokens.unwrap_or(0));
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

pub(super) fn due(input: &RunInput, source: &ModelContextSource) -> bool {
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
    let output = output.unwrap_or(0);
    input
        .saturating_add(output)
        .saturating_add(output.saturating_mul(2).min(8000))
        >= window
}

pub(super) async fn attempt(
    inner: &Arc<Inner>,
    input: &mut RunInput,
    source: &ModelContextSource,
    mid_turn: bool,
    cancellation: &CancellationToken,
    continuation_base: Option<u64>,
) -> Result<bool, RunError> {
    let opening = source
        .anchor
        .iter()
        .chain(source.tail.iter().filter_map(|event| match event {
            maka_event_log::context::ContextEvent::Canonical(stored) => Some(stored.as_ref()),
            _ => None,
        }))
        .find(|stored| {
            stored.event.invocation.invocation_id == input.invocation.invocation_id
                && matches!(stored.event.fact, Fact::InvocationOpened { .. })
        })
        .ok_or_else(|| {
            RunError::ReconciliationRequired(
                "automatic compaction lacks its canonical opening".into(),
            )
        })?;
    let mode = if mid_turn {
        CheckpointMode::MidTurn {
            anchor_event_id: opening.event.id.clone(),
        }
    } else {
        CheckpointMode::PreTurn
    };
    let result = compact::run(inner, input, &mode, cancellation, continuation_base).await;
    let (_, checkpoint) = match result {
        Ok(result) => result,
        Err(RunError::Model(
            maka_model::ModelError::Adapter(_)
            | maka_model::ModelError::Provider(_)
            | maka_model::ModelError::TimedOut
            | maka_model::ModelError::ContextOverflow { .. },
        )) => return Ok(false),
        Err(error) => return Err(error),
    };
    let Some(checkpoint) = checkpoint else {
        return Ok(false);
    };
    // The candidate is a checked text summary plus this exact durable opening.
    // Materialize its attachments with the normal bounded reader before adopting.
    history::materialize(
        &inner.log,
        &[],
        Some(opening),
        &input.invocation.session_id,
        input.supports_vision,
        cancellation,
    )
    .await?;
    if cancellation.is_cancelled() {
        return Err(RunError::Cancelled);
    }
    inner.log.append(&EventWrite::plain(checkpoint)?).await?;
    Ok(true)
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
    fn actual_usage_threshold_preserves_unknown_and_caps_reply_reserve() {
        assert!(!threshold(None, Some(5000), 1));
        assert!(!threshold(Some(0), Some(5000), 1));
        assert!(threshold(Some(100), None, 100));
        assert!(!threshold(Some(100), None, 101));
        assert!(threshold(Some(100), Some(20), 160));
        assert!(!threshold(Some(100), Some(20), 161));
        assert!(threshold(Some(100), Some(5000), 13100));
        assert!(!threshold(Some(100), Some(5000), 13101));
    }
}
