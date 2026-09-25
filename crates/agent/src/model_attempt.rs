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

use crate::{
    Inner, RunError, RunInput, history,
    runner::{append, digest},
};
use maka_event_log::context::ModelContextSource;
use maka_model::prompt::Message;
use maka_model::{ModelRequest, StepBuilder, ToolDefinition};
use maka_runtime::{
    context::ModelPurpose,
    event::{Fact, ModelInterruption},
    model::ModelStep,
};
use serde_json::json;
use std::collections::HashSet;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub(super) enum Attempt<'a> {
    Main {
        lane: maka_model::Conversation,
        continuation_base: Option<u64>,
        surface: Arc<crate::request_composition::Surface>,
    },
    Summary {
        adapter: maka_plugins::model::Binding,
        reservation: Option<&'a mut maka_model::ModelReservation>,
    },
}

#[allow(clippy::too_many_arguments)] // Keep the admitted history policy explicit at each model request.
pub(super) async fn prompt(
    inner: &Inner,
    input: &RunInput,
    source: &ModelContextSource,
    purpose: ModelPurpose,
    cancellation: &CancellationToken,
    continuation_base: Option<u64>,
    current: &str,
    prior_unknown: bool,
) -> Result<Vec<Message>, RunError> {
    let route = route_identity(input)?;
    let replay = continuation_base.map(|base| history::Replay {
        base,
        current,
        route: &route,
        model: &input.provider.model,
    });
    let mut prompt = history::materialize_replay(
        &inner.log,
        &source.tail,
        source.anchor.as_ref(),
        &input.invocation.session_id,
        input.supports_vision,
        cancellation,
        replay,
        prior_unknown,
    )
    .await?;
    if let Some(baseline) = &source.baseline {
        let text = match purpose {
            ModelPurpose::Summary => format!(
                "Previous continuation summary:\n{}\n\nUpdate it using the newer conversation events that follow.",
                baseline.checkpoint.summary.text
            ),
            ModelPurpose::Main => format!(
                "Continuation summary:\n{}",
                baseline.checkpoint.summary.text
            ),
        };
        prompt.insert(0, Message::user(text));
    }
    if purpose == ModelPurpose::Main {
        let system_text = input
            .configuration
            .system_prompt
            .as_ref()
            .map(|system| system.text.clone())
            .unwrap_or_default();
        if !system_text.is_empty() {
            prompt.insert(
                0,
                Message::System {
                    content: system_text,
                    provider_options: None,
                },
            );
        }
    }
    Ok(prompt)
}

pub(super) fn prior_unknown_notice(source: &ModelContextSource) -> String {
    let events =
        source
            .anchor
            .iter()
            .map(|event| &event.event)
            .chain(source.tail.iter().filter_map(|event| match event {
                maka_event_log::context::ContextEvent::Canonical(event) => Some(&event.event),
                maka_event_log::context::ContextEvent::Archived(_) => None,
            }));
    let events: Vec<_> = events.collect();
    let sealed: HashSet<_> = events
        .iter()
        .filter_map(|event| match &event.fact {
            Fact::InvocationEnded {
                outcome: maka_runtime::event::InvocationOutcome::Failed { class, .. },
            } if class == "outcome_unknown" => Some(event.invocation.invocation_id.as_str()),
            _ => None,
        })
        .collect();
    let settled: HashSet<_> = events
        .iter()
        .filter_map(|event| match &event.fact {
            Fact::ToolSettled { operation_id, .. } => Some((
                event.invocation.invocation_id.as_str(),
                operation_id.as_str(),
            )),
            _ => None,
        })
        .collect();
    let unknown: Vec<_> = events
        .iter()
        .filter_map(|event| match &event.fact {
            Fact::ToolDispatched {
                operation_id, name, ..
            } if sealed.contains(event.invocation.invocation_id.as_str())
                && !settled.contains(&(
                    event.invocation.invocation_id.as_str(),
                    operation_id.as_str(),
                )) =>
            {
                Some((name.as_str(), operation_id.as_str()))
            }
            _ => None,
        })
        .collect();
    if unknown.is_empty() {
        return String::new();
    }
    let mut notice = String::from(
        "Prior execution was interrupted after these tools were dispatched. Their results were never recorded; effects may or may not have happened. Inspect current state before repeating any action. This is historical uncertainty, not a new tool result:",
    );
    for (name, operation) in unknown.iter().take(64) {
        notice.push_str(&format!("\n- {name} (operation {operation})"));
    }
    if unknown.len() > 64 {
        notice.push_str(&format!(
            "\n- and {} more unknown operations",
            unknown.len() - 64
        ));
    }
    notice
}

pub(super) async fn execute(
    inner: &Arc<Inner>,
    input: &RunInput,
    source: &ModelContextSource,
    prompt: Vec<Message>,
    definitions: Vec<ToolDefinition>,
    attempt: Attempt<'_>,
    cancellation: &CancellationToken,
) -> Result<(String, ModelStep), RunError> {
    let Attempt::Main {
        lane,
        continuation_base,
        surface,
    } = attempt
    else {
        return execute_once(
            inner,
            input,
            source,
            prompt,
            definitions,
            attempt,
            cancellation,
        )
        .await;
    };
    let mut failures = 0;
    let mut refreshed = None;
    loop {
        // Each physical request gets a new step and the same frozen inputs.
        // Never reuse a request shortened by Responses continuation preparation.
        let result = execute_once(
            inner,
            input,
            refreshed.as_ref().unwrap_or(source),
            prompt.clone(),
            definitions.clone(),
            Attempt::Main {
                lane: lane.clone(),
                continuation_base,
                surface: surface.clone(),
            },
            cancellation,
        )
        .await;
        let delay = match &result {
            Err(RunError::Model(maka_model::ModelError::Provider(failure)))
                if failure.replay_safe() && failures < 9 =>
            {
                let base_ms = 1_000u64 << failures.min(5);
                failure.retry_after().unwrap_or_else(|| {
                    std::time::Duration::from_millis(base_ms + fastrand::u64(0..=base_ms / 4))
                })
            }
            _ => return result,
        };
        failures += 1;
        // execute_once has drained the worker and committed ModelInterrupted.
        // A local/storage error cannot reach this wait or authorize another send.
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(RunError::Cancelled),
            _ = tokio::time::sleep(delay) => {}
        }
        if matches!(
            input.work,
            crate::RunWork::Continuation { .. } | crate::RunWork::Handoff { .. }
        ) {
            let next = inner
                .log
                .read_model_context(
                    &input.invocation.session_id,
                    Some(&input.invocation.invocation_id),
                    10_000,
                    8 * 1024 * 1024,
                )
                .await?;
            let replay = self::prompt(
                inner,
                input,
                &next,
                ModelPurpose::Main,
                cancellation,
                continuation_base,
                &input.invocation.invocation_id,
                false,
            )
            .await?;
            if surface.apply(replay) != prompt {
                return Err(RunError::ReconciliationRequired(
                    "continuation retry changed frozen model input".into(),
                ));
            }
            refreshed = Some(next);
        }
    }
}

async fn execute_once(
    inner: &Arc<Inner>,
    input: &RunInput,
    source: &ModelContextSource,
    prompt: Vec<Message>,
    definitions: Vec<ToolDefinition>,
    attempt: Attempt<'_>,
    cancellation: &CancellationToken,
) -> Result<(String, ModelStep), RunError> {
    let (purpose, lane, surface, summary_adapter, reservation) = match attempt {
        Attempt::Main { lane, surface, .. } => {
            (ModelPurpose::Main, Some(lane), Some(surface), None, None)
        }
        Attempt::Summary {
            adapter,
            reservation,
        } => (
            ModelPurpose::Summary,
            None,
            None,
            Some(adapter),
            reservation,
        ),
    };
    if cancellation.is_cancelled() {
        return Err(RunError::Cancelled);
    }
    let max_output_tokens = surface.as_ref().map_or(
        Some(input.main_output_limit.unwrap_or(8000).min(8000)),
        |surface| surface.max_output_tokens,
    );
    let prepared = prepare_request(input, prompt, definitions, max_output_tokens)?;
    let (binding, composition) = match surface {
        Some(surface) => (surface.adapter.clone(), surface.evidence.clone()),
        None => {
            let request = &prepared.request;
            let binding = summary_adapter.expect("summary adapter frozen at capture");
            let evidence = maka_runtime::composition::RequestComposition {
                system_prompt: request.prompt.iter().find_map(|message| match message {
                    Message::System { content, .. } => Some(content.clone()),
                    _ => None,
                }),
                dynamic_context: vec![],
                tool_catalog_digest: maka_runtime::artifact::content_digest(
                    &serde_json::to_vec(&request.tools)
                        .map_err(|error| RunError::Internal(error.to_string()))?,
                ),
                tools: request.tools.clone(),
                provider_options: Some(request.provider_options.clone()),
                max_output_tokens: request.max_output_tokens,
                sources: input
                    .model_revision
                    .iter()
                    .cloned()
                    .chain(std::iter::once(
                        binding.source(request.provider.adapter_name())?,
                    ))
                    .collect(),
            }
            .freeze()
            .map_err(|error| RunError::Internal(error.into()))?;
            (binding, Arc::new(evidence))
        }
    };
    let step_id = Uuid::new_v4().to_string();
    let event = maka_runtime::event::RuntimeEvent::new(
        input.invocation.clone(),
        Fact::ModelRequested {
            effective_source_digest: (purpose == ModelPurpose::Summary
                || matches!(
                    source.source_evidence.scope,
                    maka_runtime::event::LogScope::Lineage { .. }
                ))
            .then(|| source.effective_source_digest.clone()),
            purpose,
            context: input.context.clone(),
            step_id: step_id.clone(),
            model_id: input.provider.model.clone(),
            source_scope: source.source_evidence.scope.clone(),
            source_high_water: source.source_evidence.high_water,
            source_digest: source.source_evidence.digest.clone(),
            input_digest: prepared.input_digest,
            route_identity: prepared.route_identity,
            checkpoint_event_id: source
                .baseline
                .as_ref()
                .map(|baseline| baseline.event_id.clone()),
        },
    );
    let mut write = maka_runtime::event::EventWrite::plain(event)?.with_composition(composition)?;
    if let Some(pricing) = &inner.pricing {
        write = write.with_quote(
            pricing
                .quote(&input.provider_id, &input.provider.model)
                .await?,
        )?;
    }
    use maka_runtime::event::EventSink;
    inner.log.clone().commit(write).await?;
    let result: Result<_, RunError> = async {
        let stream = match reservation {
            Some(reservation) => {
                reservation
                    .stream_with_adapter(prepared.request, cancellation.clone(), binding)
                    .await?
            }
            None => {
                inner
                    .model
                    .stream_with_adapter(prepared.request, cancellation.clone(), lane, binding)
                    .await?
            }
        };
        receive(inner, input, &step_id, purpose, stream).await
    }
    .await;
    finish(inner, input, step_id, purpose, result, cancellation).await
}

pub(super) struct PreparedRequest {
    pub request: ModelRequest,
    pub input_digest: String,
    pub route_identity: String,
}

pub(super) fn route_identity(input: &RunInput) -> Result<String, RunError> {
    Ok(digest(
        &serde_json::to_vec(&input.provider)
            .map_err(|error| RunError::Internal(error.to_string()))?,
    ))
}

pub(super) fn prepare_request(
    input: &RunInput,
    prompt: Vec<Message>,
    definitions: Vec<ToolDefinition>,
    max_output_tokens: Option<u64>,
) -> Result<PreparedRequest, RunError> {
    let max_output_tokens = Some(max_output_tokens.unwrap_or(8000));
    let prompt = if input.supports_vision
        && matches!(
            &input.provider.kind,
            maka_model::ProviderKind::OpenaiChat
                | maka_model::ProviderKind::OpenaiCompatible { .. }
        ) {
        history::project_chat(prompt)
    } else {
        prompt
    };
    let prompt = history::project_compatible(prompt, &input.provider.kind);
    let prompt = maka_model::reasoning::project(prompt, &input.provider.kind);
    let mut evidence = json!({"projection":"maka.model-history.v1","prompt":prompt,
        "tools":definitions,"providerOptions":input.provider_options});
    if let Some(limit) = max_output_tokens {
        evidence["maxOutputTokens"] = json!(limit);
    }
    let input_digest = digest(
        &serde_json::to_vec(&evidence).map_err(|error| RunError::Internal(error.to_string()))?,
    );
    Ok(PreparedRequest {
        request: ModelRequest {
            provider: input.provider.clone(),
            prompt,
            tools: definitions,
            provider_options: input.provider_options.clone(),
            max_output_tokens,
        },
        input_digest,
        route_identity: route_identity(input)?,
    })
}

async fn receive(
    inner: &Arc<Inner>,
    input: &RunInput,
    step_id: &str,
    purpose: ModelPurpose,
    mut stream: maka_model::ModelStream,
) -> Result<ModelStep, RunError> {
    let mut builder = StepBuilder::for_step(step_id)?;
    let result: Result<_, RunError> = async {
        while let Some(event) = stream.next().await {
            let event = event?;
            builder.push(event.clone())?;
            append(
                inner,
                &input.invocation,
                Fact::ModelObserved {
                    step_id: step_id.to_owned(),
                    event,
                },
            )
            .await?;
        }
        builder.finish().map_err(Into::into)
    }
    .await;
    stream.cancel_and_wait().await;
    let output = result?;
    if purpose == ModelPurpose::Summary
        && output.parts.iter().any(|part| {
            matches!(
                part,
                maka_runtime::model::ModelPart::ToolCall { .. }
                    | maka_runtime::model::ModelPart::ToolResult { .. }
            )
        })
    {
        return Err(maka_model::ModelError::Adapter("summary contains tool content".into()).into());
    }
    Ok(output)
}

async fn finish(
    inner: &Arc<Inner>,
    input: &RunInput,
    step_id: String,
    purpose: ModelPurpose,
    result: Result<ModelStep, RunError>,
    cancellation: &CancellationToken,
) -> Result<(String, ModelStep), RunError> {
    let output = match result {
        Ok(output) => output,
        Err(RunError::Model(error)) => {
            let status = match error {
                maka_model::ModelError::Cancelled => ModelInterruption::Cancelled,
                maka_model::ModelError::TimedOut => ModelInterruption::TimedOut,
                maka_model::ModelError::Adapter(_) => ModelInterruption::Failed,
                maka_model::ModelError::ContextOverflow { .. } => ModelInterruption::Failed,
                maka_model::ModelError::Provider(ref failure) if failure.replay_safe() => {
                    ModelInterruption::RetryableFailure
                }
                maka_model::ModelError::Provider(_) => ModelInterruption::Failed,
            };
            append(
                inner,
                &input.invocation,
                Fact::ModelInterrupted {
                    step_id: step_id.clone(),
                    status,
                },
            )
            .await?;
            return Err(error.into());
        }
        Err(error) => return Err(error),
    };
    use maka_runtime::event::{EventWrite, RuntimeEvent};
    let incomplete = purpose == ModelPurpose::Main
        && output.finish_reason == maka_runtime::model::ModelFinishReason::Length;
    let mut writes = vec![EventWrite::plain(RuntimeEvent::new(
        input.invocation.clone(),
        Fact::ModelCompleted {
            step_id: step_id.clone(),
            output: output.clone(),
        },
    ))?];
    if incomplete {
        for call in output.tool_calls().filter(|call| !call.provider_executed) {
            writes.push(EventWrite::plain(RuntimeEvent::new(
                input.invocation.clone(),
                Fact::ToolRejected {
                    operation_id: format!("{step_id}:{}", call.id),
                    call: maka_runtime::tool_call::ToolCallIdentity::provider(
                        step_id.clone(),
                        call.id.clone(),
                    ),
                    name: call.name.clone(),
                    input: call.input.clone(),
                    reason: maka_runtime::tool_call::ToolRejection::PreparationFailed {
                        message: RunError::ModelIncomplete.to_string(),
                    },
                },
            ))?);
        }
    }
    inner.log.append_batch(&writes).await?;
    if incomplete {
        return Err(RunError::ModelIncomplete);
    }
    if cancellation.is_cancelled() {
        return Err(RunError::Cancelled);
    }
    Ok((step_id, output))
}
