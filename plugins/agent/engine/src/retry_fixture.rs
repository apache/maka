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

//! Canonical historical retry seeds for cross-crate lifecycle tests.

use crate::{
    Engine, RunContext, RunError, RunInput, RunWork, model_attempt, request_composition::Surface,
    steps::ModelResumePoint,
};
use maka_agent_facts::{
    context::ModelPurpose,
    event::{EventWrite, Fact, InvocationInput, ModelInterruption, RuntimeEvent},
    handoff::CompactionBudget,
    model::{
        error::{ModelFailureCause, ProviderFailureReason},
        retry_transport::RetryTransportPhase,
    },
    model_retry::RetryPlan,
    native_approval::{ActivationCheckpoint, ActivationSuspension},
};
use maka_event_log::{
    native_approvals::{ActivationCheckpointRecord, ParkResult},
    root_store::SessionStore,
};
use std::{
    sync::Arc,
    time::{Duration, SystemTime},
};
use tokio_util::sync::CancellationToken;

/// Canonical evidence only; actual resumption must go through the owning Host.
#[derive(Debug)]
pub struct SeededModelRetry {
    pub checkpoint: ActivationCheckpointRecord,
    pub request_event_id: String,
    pub input_digest: String,
}

/// Journal an elapsed no-progress retry using the real input preparation pipeline.
/// The caller must hold the Session ordering gate until this function finishes,
/// so an active Host cannot resume before the fixture's physical custody drains.
///
/// # Errors
/// Returns admission, input preparation, canonical publication, or cleanup failures.
pub async fn seed_due_model_retry(
    engine: &Engine,
    store: SessionStore,
    input: RunInput,
) -> Result<SeededModelRetry, RunError> {
    crate::require_session(&store, &input.invocation)?;
    let (input, work) = input.into_context();
    let RunWork::Message {
        message,
        source_messages,
        tools: catalog,
    } = work
    else {
        return Err(RunError::InvalidInput(
            "retry fixture requires a plain message".into(),
        ));
    };
    if !source_messages.is_empty() {
        return Err(RunError::InvalidInput(
            "retry fixture owns its canonical opening".into(),
        ));
    }
    let native_basis = input.native_activation_basis.as_ref().ok_or_else(|| {
        RunError::InvalidInput("retry fixture requires accepted Native evidence".into())
    })?;
    let decision_at = SystemTime::now()
        .checked_sub(Duration::from_secs(6 * 60 * 60))
        .ok_or_else(|| RunError::InvalidInput("retry fixture decision time underflow".into()))?;
    let deadline_at = decision_at
        .checked_add(Duration::from_secs(5 * 60 * 60))
        .ok_or_else(|| RunError::InvalidInput("retry fixture deadline overflow".into()))?;
    let deadline = u64::try_from(
        deadline_at
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_err(|error| RunError::InvalidInput(format!("invalid fixture deadline: {error}")))?
            .as_millis(),
    )
    .map_err(|error| RunError::InvalidInput(format!("fixture deadline overflow: {error}")))?;
    let cancellation = CancellationToken::new();
    let (execution, effects) = store
        .execution_scope(crate::permission_basis(&input.configuration))
        .await?
        .accept_invocation(input.invocation.clone(), cancellation.clone())?;
    let inner = RunContext::new(
        engine.0.clone(),
        execution.store().clone(),
        &input.invocation,
    )?;
    let tools = maka_tools::RunTools::new(
        input.configuration.language,
        inner.log.clone(),
        input.invocation.clone(),
        catalog,
        input.configuration.tool_mode,
        engine
            .0
            .cells
            .clone()
            .with_language(input.configuration.code_language),
        engine.0.loaded(&input.invocation.session_id),
    )
    .with_model(input.provider.tool_context())
    .with_behavior(input.configuration.orchestration_mode.clone());
    let mut retained_prompt = None;
    let result = async {
        let mut opening = RuntimeEvent::new(
            input.invocation.clone(),
            Fact::InvocationOpened {
                configuration: Some(Box::new(input.configuration.clone())),
                input: InvocationInput::Message {
                    content: message,
                    source_messages: vec![],
                    request_fingerprint: input.request_fingerprint.clone(),
                },
            },
        );
        opening.recorded_at = decision_at;
        let opening_id = opening.id.clone();
        inner.log.append(&EventWrite::plain(opening)?).await?;
        let request_tools = tools
            .capture(&input.configuration.cwd, cancellation.clone())
            .await?;
        let view = Arc::new(
            inner
                .log
                .read_model_view(
                    &input.invocation.session_id,
                    Some(&input.invocation.invocation_id),
                )
                .await?,
        );
        let source = model_attempt::RequestSource::from(view.as_ref());
        let surface = Surface::capture(&request_tools, &inner.shared.model, &input, &view, None)?;
        retained_prompt = Some(
            model_attempt::prompt(
                &inner,
                &input,
                &view,
                &cancellation,
                None,
                &input.invocation.invocation_id,
                false,
                surface.system(),
                ModelPurpose::Main,
            )
            .await?,
        );
        drop(view);
        let prompt = retained_prompt
            .as_mut()
            .expect("fixture prompt prepared above");
        let definitions = request_tools.definitions();
        model_attempt::prepare_wire(
            &input,
            prompt,
            &definitions,
            surface.max_output_tokens,
            &cancellation,
        )
        .await?;
        let prepared = model_attempt::prepare_request(
            &input,
            prompt.clone(),
            definitions,
            surface.max_output_tokens,
            ModelPurpose::Main,
        )?;
        let input_digest = prepared.input_digest.clone();
        let step_id = "fixture-original".to_owned();
        let mut request = RuntimeEvent::new(
            input.invocation.clone(),
            Fact::ModelRequested {
                source_capture: source.capture,
                item_acceptance: surface.adapter.supports_item_acceptance(),
                effective_source_digest: Some(source.effective_digest),
                purpose: ModelPurpose::Main,
                context: input.context.clone(),
                context_breakdown: Some(prepared.context_breakdown),
                checkpoint_event_id: source.checkpoint,
                step_id: step_id.clone(),
                model_id: input.provider.model.clone(),
                source_scope: source.evidence.scope,
                source_high_water: source.evidence.high_water,
                source_digest: source.evidence.digest,
                input_digest: prepared.input_digest,
                route_identity: prepared.route_identity,
            },
        );
        request.recorded_at = decision_at;
        let request_event_id = request.id.clone();
        inner
            .log
            .append(&EventWrite::plain(request)?.with_composition(surface.evidence())?)
            .await?;
        surface.committed(request_event_id.clone());
        drop(prepared.request);
        let mut failure = RuntimeEvent::new(
            input.invocation.clone(),
            Fact::ModelInterrupted {
                step_id,
                status: ModelInterruption::RetryableFailure,
                diagnostic: None,
                partial: None,
                model_failure: Some(ModelFailureCause::Provider {
                    reason: ProviderFailureReason::RateLimit,
                    retry_at_unix_ms: Some(deadline),
                }),
            },
        );
        failure.recorded_at = decision_at;
        let failure_event_id = failure.id.clone();
        inner.log.append(&EventWrite::plain(failure)?).await?;
        let prompt = retained_prompt.take().expect("fixture prompt still owned");
        prompt
            .close()
            .await
            .map_err(crate::cleanup::preparation_failed)?;
        drop(prompt);
        drop(request_tools);
        drop(surface);
        if !tools.code_idle() || !effects.is_idle() {
            return Err(RunError::ReconciliationRequired(
                "retry fixture preparation has not drained".into(),
            ));
        }
        let point = ModelResumePoint {
            opening_id,
            context: input.context.clone(),
            provider_options: input.provider_options.clone(),
            main_output_limit: input.main_output_limit,
            supports_vision: input.supports_vision,
            tools: tools.checkpoint()?,
            compaction: CompactionBudget::Available,
            replay_base: None,
            prior_unknown: false,
            inspected_through: 0,
            main_progress: false,
            finish_turn: false,
        };
        let checkpoint = ActivationCheckpoint {
            id: uuid::Uuid::new_v4().to_string(),
            invocation: input.invocation.clone(),
            through: inner.log.committed_sequence().await?,
            engine: serde_json::to_value(point).map_err(RunError::Checkpoint)?,
            native_basis: native_basis
                .checkpoint_value()
                .map_err(RunError::Checkpoint)?,
            suspension: ActivationSuspension::ModelRetry {
                plan: RetryPlan {
                    failure_event_id,
                    not_before_unix_ms: deadline,
                    failures: 1,
                    transport_phase: RetryTransportPhase::Primary,
                },
            },
        };
        if !matches!(
            inner.log.park_model_retry(checkpoint).await?,
            ParkResult::Parked(_)
        ) {
            return Err(RunError::ReconciliationRequired(
                "retry fixture frontier changed".into(),
            ));
        }
        let checkpoint = inner
            .log
            .activation_checkpoint(&input.invocation.session_id)
            .await?
            .ok_or_else(|| {
                RunError::ReconciliationRequired("retry fixture checkpoint missing".into())
            })?;
        Ok(SeededModelRetry {
            checkpoint,
            request_event_id,
            input_digest,
        })
    }
    .await;
    let result = match retained_prompt {
        Some(prompt) => match prompt.close().await {
            Ok(()) => result,
            Err(error) => {
                model_attempt::additional_failure(result, crate::cleanup::preparation_failed(error))
            }
        },
        None => result,
    };
    let result = match tools.shutdown().await {
        Ok(()) => result,
        Err(error) => model_attempt::additional_failure(result, error.into()),
    };
    drop(tools);
    let result = match effects.settle().await {
        Ok(()) => result,
        Err(error) => model_attempt::additional_failure(result, error.into()),
    };
    drop(inner);
    if result.as_ref().is_err_and(RunError::is_cleanup_unconfirmed) {
        execution.retain_unconfirmed();
    } else {
        execution.finish();
    }
    result
}
