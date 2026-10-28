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

use maka_agent_facts::language::Language;

use crate::prepared_prompt::PreparedPrompt;
use crate::{
    RunContext, RunError, RunInput, RunSettings, history,
    runner::{append, digest},
};
use maka_agent_facts::context::ModelPurpose;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::ModelInterruption;
use maka_agent_facts::model::ModelStep;
use maka_event_log::context::ContextView;
use maka_model::{ModelError, ModelEvent, ModelRequest, StepBuilder, ToolDefinition};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub(super) struct Main<'a> {
    pub lane: maka_model::Conversation,
    pub continuation_base: Option<u64>,
    pub surface: Arc<crate::request_composition::Surface>,
    pub tools: &'a maka_tools::RequestTools<'a>,
    pub prior_unknown: bool,
}

pub(super) enum Attempt<'a> {
    Main(Main<'a>),
    Summary {
        surface: Arc<crate::request_composition::Surface>,
    },
}

#[expect(
    clippy::large_enum_variant,
    reason = "One result per request; keep the ordinary response inline without another allocation."
)]
pub(super) enum Outcome {
    Response(ModelStep),
    FinishedByTool,
}
impl From<(String, ModelStep)> for Outcome {
    fn from((_, output): (String, ModelStep)) -> Self {
        Self::Response(output)
    }
}

#[allow(clippy::too_many_arguments)] // Keep the admitted history policy explicit at each model request.
pub(super) async fn prompt<W>(
    inner: &RunContext,
    input: &RunInput<W>,
    source: &Arc<ContextView>,
    cancellation: &CancellationToken,
    continuation_base: Option<u64>,
    current: &str,
    prior_unknown: bool,
    system: Option<Arc<String>>,
    purpose: ModelPurpose,
) -> Result<PreparedPrompt, RunError> {
    let route = route_identity(input)?;
    let mut selection = source.selection.clone();
    selection.replay =
        continuation_base.map(|base| maka_event_log::context::semantic::SemanticReplay {
            base,
            current: current.to_owned(),
            route,
            model: input.provider.model.clone(),
        });
    selection.prior_unknown = prior_unknown;
    let overlay_bytes = PreparedPrompt::overlay_plan_bytes(
        system.is_some(),
        source.baseline.is_some(),
        purpose == ModelPurpose::Summary,
    );
    let body = history::prepare_view(
        &inner.log,
        selection,
        input.configuration.language,
        input.supports_vision,
        &input.provider.kind,
        cancellation,
        inner.shared.preparation_resources.clone(),
        overlay_bytes,
    )
    .await?;
    let mut prompt = PreparedPrompt::from_history(body);
    let label = match input.configuration.language {
        Language::En => {
            "Historical checkpoint, not a new user request. Reconcile the following messages with this snapshot, then continue the remaining work:\n\n"
        }
        Language::ZhCn => {
            "历史检查点，不是新的用户请求。请结合后续消息更新此快照中的状态，然后继续尚未完成的工作：\n\n"
        }
        Language::ZhTw => {
            "歷史檢查點，不是新的使用者請求。請結合後續訊息更新此快照中的狀態，然後繼續尚未完成的工作：\n\n"
        }
    };
    if let Err(error) = prompt
        .initialize_overlays(
            system,
            source.clone(),
            label,
            purpose == ModelPurpose::Summary,
        )
        .await
    {
        prompt
            .close()
            .await
            .map_err(crate::cleanup::preparation_failed)?;
        return Err(error);
    }
    Ok(prompt)
}

pub(super) fn rendered_system<W>(input: &RunInput<W>) -> Option<Arc<String>> {
    crate::request_composition::render_system(
        input
            .configuration
            .system_prompt
            .as_ref()
            .map(|system| system.text.as_str()),
        &crate::request_composition::session_context(input),
    )
    .map(Arc::new)
}

pub(super) fn prior_unknown_notice(source: &ContextView, language: Language) -> String {
    let unknown = &source.unknown_tools;
    if unknown.is_empty() {
        return String::new();
    }
    let mut notice = String::from(match language {
        Language::En => {
            "Prior execution was interrupted after these tools were dispatched. Their results were never recorded; effects may or may not have happened. Inspect current state before repeating any action. This is historical uncertainty, not a new tool result:"
        }
        Language::ZhCn => {
            "先前执行在派发以下工具后中断，未记录结果；操作可能已经生效。重复操作前先检查当前状态。这是历史不确定性，不是新的工具结果："
        }
        Language::ZhTw => {
            "先前執行在派發以下工具後中斷，未記錄結果；操作可能已經生效。重複操作前先檢查目前狀態。這是歷史不確定性，不是新的工具結果："
        }
    });
    for (name, operation) in unknown.iter().take(64) {
        notice.push_str(&match language {
            Language::En => format!("\n- {name} (operation {operation})"),
            Language::ZhCn => format!("\n- {name}（操作 {operation}）"),
            Language::ZhTw => format!("\n- {name}（操作 {operation}）"),
        });
    }
    if source.unknown_tool_count > 64 {
        let remaining = source.unknown_tool_count - 64;
        notice.push_str(&match language {
            Language::En => format!("\n- and {remaining} more unknown operations"),
            Language::ZhCn => format!("\n- 另有 {remaining} 个结果未知的操作"),
            Language::ZhTw => format!("\n- 另有 {remaining} 個結果未知的操作"),
        });
    }
    notice
}

pub(super) struct RequestSource {
    pub evidence: maka_event_log::context::SourceEvidence,
    pub effective_digest: String,
    pub checkpoint: Option<String>,
}

impl From<&ContextView> for RequestSource {
    fn from(source: &ContextView) -> Self {
        Self {
            evidence: source.source_evidence.clone(),
            effective_digest: source.effective_source_digest.clone(),
            checkpoint: source
                .baseline
                .as_ref()
                .map(|baseline| baseline.event_id.clone()),
        }
    }
}

pub(super) async fn read_source(
    inner: &RunContext,
    input: &RunSettings,
    prior_unknown: bool,
    cancellation: &CancellationToken,
) -> Result<Arc<ContextView>, RunError> {
    // Only abandon the read reply. Its snapshot remains owned by the log's
    // independent reader until completion; no append or external effect is raced.
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(RunError::Cancelled),
        source = async {
            if prior_unknown {
                inner.log.read_manual_message_view(
                    &input.invocation.session_id,
                    &input.invocation.invocation_id,
                ).await
            } else {
                inner.log.read_model_view(
                    &input.invocation.session_id,
                    Some(&input.invocation.invocation_id),
                ).await
            }
        } => Ok(Arc::new(source?)),
    }
}

pub(super) async fn execute_main(
    inner: &Arc<RunContext>,
    input: &RunSettings,
    context: Arc<ContextView>,
    prompt: PreparedPrompt,
    main: Main<'_>,
    cancellation: &CancellationToken,
) -> (u64, Result<Outcome, RunError>) {
    let Main {
        lane,
        continuation_base,
        surface,
        tools,
        prior_unknown,
    } = main;
    let mut source = RequestSource::from(context.as_ref());
    let mut high_water = source.evidence.high_water;
    drop(context);
    let mut retry = Some(prompt);
    let result = async {
        let mut failures = 0;
        loop {
            // Preserve captured capabilities. Rebuild history only when a completed
            // item advanced canonical progress, never from a shortened WS request.
            let mut progressed = false;
            let result = execute_once(
                inner,
                input,
                &source,
                retry
                    .as_ref()
                    .expect("unprogressed attempt retains its prompt")
                    .clone(),
                // Re-project this step's captured catalog only for the attempt.
                // Keeping an owned schema vector here would retain a redundant
                // copy for the entire response, including stalled streams.
                tools.definitions(),
                Attempt::Main(Main {
                    lane: lane.clone(),
                    continuation_base,
                    surface: surface.clone(),
                    tools,
                    prior_unknown,
                }),
                cancellation,
                &mut progressed,
                &mut retry,
            )
            .await;
            let delay = match &result {
                Err(RunError::Model(maka_model::ModelError::Provider(failure)))
                    if failure.replay_safe() || (progressed && failure.retained_output_safe()) =>
                {
                    if cancellation.is_cancelled() {
                        return Err(RunError::Cancelled);
                    }
                    // A successful finishing effect is already authoritative. Safe
                    // stream recovery must not reopen this turn for another model.
                    if tools.finished() {
                        return Ok(Outcome::FinishedByTool);
                    }
                    if failures >= 9 {
                        if !lane.try_switch_fallback_transport() {
                            return result.map(Outcome::from);
                        }
                        failures = 0;
                        failure.retry_after().unwrap_or_default()
                    } else {
                        // Codex's ordinary stream recovery starts at 200 ms with
                        // +/-10% jitter. The bounded attempt count caps this delay.
                        let base_ms = 200u64 << failures;
                        failures += 1;
                        failure.retry_after().unwrap_or_else(|| {
                            std::time::Duration::from_millis(fastrand::u64(
                                base_ms * 9 / 10..=base_ms * 11 / 10,
                            ))
                        })
                    }
                }
                _ => return result.map(Outcome::from),
            };
            if progressed {
                // Accepted progress replaces the frozen retry prompt. Release it
                // before materializing the next canonical source.
                close_retry(&mut retry).await?;
                let context = read_source(inner, input, prior_unknown, cancellation).await?;
                high_water = context.source_evidence.high_water;
                source = RequestSource::from(context.as_ref());
                let prompt = self::prompt(
                    inner,
                    input,
                    &context,
                    cancellation,
                    continuation_base,
                    &input.invocation.invocation_id,
                    prior_unknown,
                    surface.system(),
                    ModelPurpose::Main,
                )
                .await?;
                drop(context);
                retry = Some(prompt);
            }
            // execute_once has drained the worker and committed ModelInterrupted.
            // A local/storage error cannot reach this wait or authorize another send.
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err(RunError::Cancelled),
                _ = tokio::time::sleep(delay) => {}
            }
        }
    }
    .await;
    let result = if result.as_ref().is_err_and(RunError::is_cleanup_unconfirmed) {
        result
    } else {
        match close_retry(&mut retry).await {
            Ok(()) => result,
            Err(error) => Err(error),
        }
    };
    (high_water, result)
}

async fn close_retry(retry: &mut Option<PreparedPrompt>) -> Result<(), RunError> {
    if let Some(prompt) = retry.take() {
        prompt
            .close()
            .await
            .map_err(crate::cleanup::preparation_failed)?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn execute_once(
    inner: &Arc<RunContext>,
    input: &RunSettings,
    source: &RequestSource,
    mut prompt: PreparedPrompt,
    definitions: Vec<ToolDefinition>,
    attempt: Attempt<'_>,
    cancellation: &CancellationToken,
    progressed: &mut bool,
    retry: &mut Option<PreparedPrompt>,
) -> Result<(String, ModelStep), RunError> {
    let (purpose, lane, surface, tools) = match attempt {
        Attempt::Main(Main {
            lane,
            surface,
            tools,
            ..
        }) => (ModelPurpose::Main, Some(lane), surface, Some(tools)),
        Attempt::Summary { surface } => (ModelPurpose::Summary, None, surface, None),
    };
    if cancellation.is_cancelled() {
        return Err(RunError::Cancelled);
    }
    prompt
        .compile_wire(
            input.configuration.language,
            &input.provider,
            &input.provider_options,
            &definitions,
            cancellation,
        )
        .await?;
    if purpose == ModelPurpose::Main && retry.is_some() {
        *retry = Some(prompt.clone());
    }
    let prepared = prepare_request(
        input,
        prompt,
        definitions,
        surface.max_output_tokens,
        purpose,
    )?;
    let binding = surface.adapter.clone();
    let composition = surface.evidence.clone();
    let item_acceptance = purpose == ModelPurpose::Main && binding.supports_item_acceptance();
    let step_id = Uuid::new_v4().to_string();
    let event = maka_agent_facts::event::RuntimeEvent::new(
        input.invocation.clone(),
        Fact::ModelRequested {
            item_acceptance,
            effective_source_digest: Some(source.effective_digest.clone()),
            purpose,
            context: input.context.clone(),
            context_breakdown: Some(prepared.context_breakdown),
            step_id: step_id.clone(),
            model_id: input.provider.model.clone(),
            source_scope: source.evidence.scope.clone(),
            source_high_water: source.evidence.high_water,
            source_digest: source.evidence.digest.clone(),
            input_digest: prepared.input_digest,
            route_identity: prepared.route_identity,
            checkpoint_event_id: source.checkpoint.clone(),
        },
    );
    let mut write =
        maka_agent_facts::event::EventWrite::plain(event)?.with_composition(composition)?;
    if let Some(pricing) = &inner.shared.pricing {
        write = write.with_quote(
            pricing
                .quote(&input.provider_id, &input.provider.model)
                .await?,
        )?;
    }
    use maka_agent_facts::event::EventSink;
    inner.log.clone().commit(write).await?;
    let result: Result<_, RunError> = async {
        let stream = inner
            .shared
            .model
            .stream_with_adapter(prepared.request, cancellation.clone(), lane, binding)
            .await?;
        receive(
            inner,
            input,
            &step_id,
            purpose,
            stream,
            tools
                .filter(|_| item_acceptance)
                .map(|tools| tools.clone().into_step(&step_id)),
            progressed,
            cancellation,
            retry,
        )
        .await
    }
    .await;
    let accepted = finish(
        inner,
        input,
        step_id,
        purpose,
        result,
        cancellation,
        item_acceptance,
    )
    .await?;
    if !item_acceptance && let Some(tools) = tools {
        // The successful request no longer needs its retry payload while tools run.
        close_retry(retry).await?;
        use futures_util::{FutureExt, StreamExt, stream::FuturesUnordered};
        let mut step = tools.clone().into_step(&accepted.0);
        let tool_cancellation = cancellation.child_token();
        let mut running = FuturesUnordered::new();
        for call in accepted
            .1
            .tool_calls()
            .filter(|call| !call.provider_executed)
        {
            let future = step.dispatch(call.clone(), tool_cancellation.clone());
            running.push(async move {
                std::panic::AssertUnwindSafe(future)
                    .catch_unwind()
                    .await
                    .unwrap_or_else(|_| {
                        Err(maka_agent_facts::tools::ToolError::CleanupUnconfirmed(
                            "tool panicked".into(),
                        ))
                    })
            });
        }
        let mut cleanup = Ok(());
        while let Some(result) = running.next().await {
            if let Err(error) = tool_result(result) {
                tool_cancellation.cancel();
                if cleanup.is_ok() {
                    cleanup = Err(error);
                }
            }
        }
        cleanup?;
    }
    Ok(accepted)
}

pub(super) struct PreparedRequest {
    pub context_breakdown: maka_agent_facts::context::PreparedContextBreakdown,
    pub request: ModelRequest,
    pub input_digest: String,
    pub route_identity: String,
}

pub(super) fn route_identity<W>(input: &RunInput<W>) -> Result<String, RunError> {
    digest(&input.provider)
}

pub(super) fn prepare_request<W>(
    input: &RunInput<W>,
    prompt: PreparedPrompt,
    definitions: Vec<ToolDefinition>,
    max_output_tokens: Option<u64>,
    purpose: ModelPurpose,
) -> Result<PreparedRequest, RunError> {
    let prompt = prompt.model();
    let format = match input.provider.kind {
        maka_model::ProviderKind::OpenaiChatCompletions
        | maka_model::ProviderKind::OpenaiCompatible { .. } => {
            maka_model::prompt::WireFormat::ChatCompletions
        }
        maka_model::ProviderKind::OpenaiResponses | maka_model::ProviderKind::OpenResponses(_) => {
            maka_model::prompt::WireFormat::Responses
        }
        maka_model::ProviderKind::Anthropic => maka_model::prompt::WireFormat::Anthropic,
    };
    let wire = prompt
        .wire(format)
        .ok_or_else(|| RunError::Internal("request evidence requires prepared wire".into()))?;
    let mut context_breakdown = prompt.breakdown().clone();
    context_breakdown.accumulate(&maka_agent_facts::context::measure::breakdown(
        &[],
        &definitions,
    ));
    context_breakdown
        .validate()
        .map_err(|error| RunError::Internal(error.into()))?;
    let max_output_tokens = Some(crate::context_input::output_limit(
        input,
        context_breakdown.estimated_tokens(),
        maka_agent_facts::context::effective_output_limit(max_output_tokens),
        purpose,
    ));
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Evidence<'a> {
        projection: &'static str,
        #[serde(skip_serializing_if = "Language::is_english")]
        language: Language,
        prompt_root: &'a str,
        wire_codec: &'a str,
        wire_root: &'a str,
        route_identity: &'a str,
        tools: &'a [ToolDefinition],
        provider_options: &'a serde_json::Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        max_output_tokens: Option<u64>,
    }
    let route_identity = route_identity(input)?;
    let input_digest = digest(&Evidence {
        projection: "maka.model-history.v1",
        language: input.configuration.language,
        prompt_root: prompt.identity(),
        wire_codec: &wire.codec,
        wire_root: &wire.identity,
        route_identity: &route_identity,
        tools: &definitions,
        provider_options: &input.provider_options,
        max_output_tokens,
    })?;
    Ok(PreparedRequest {
        context_breakdown,
        request: ModelRequest {
            language: input.configuration.language,
            provider: input.provider.clone(),
            prompt,
            tools: definitions,
            provider_options: input.provider_options.clone(),
            max_output_tokens,
        },
        input_digest,
        route_identity,
    })
}

#[allow(clippy::too_many_arguments)]
async fn receive(
    inner: &Arc<RunContext>,
    input: &RunSettings,
    step_id: &str,
    purpose: ModelPurpose,
    mut stream: maka_model::ModelStream,
    mut tools: Option<maka_tools::StepTools<'_>>,
    progressed: &mut bool,
    cancellation: &CancellationToken,
    retry: &mut Option<PreparedPrompt>,
) -> Result<ModelStep, RunError> {
    use futures_util::{FutureExt, StreamExt, stream::FuturesUnordered};
    use maka_agent_facts::tools::ToolError;
    let mut builder = StepBuilder::for_step(step_id)?;
    let tool_cancellation = cancellation.child_token();
    let mut running = FuturesUnordered::new();
    let mut retired_prompt = None;
    let result: Result<_, RunError> = async {
        loop {
            tokio::select! {
                biased;
                result = running.next(), if !running.is_empty() => { tool_result(result.unwrap())?; }
                event = stream.next() => {
                    let Some(event) = event else { break; };
                    let observations = ready_observations(&mut builder, event, || {
                        stream.next().now_or_never().flatten()
                    });
                    use maka_agent_facts::event::{EventWrite, RuntimeEvent};
                    // Summary prose is private until completion. Tool observations
                    // still record possible effects and provider-reported usage.
                    let writes = observations.events.iter().filter(|event| match purpose {
                        ModelPurpose::Main => true,
                        ModelPurpose::Summary => match event {
                            ModelEvent::ToolCall(_)
                            | ModelEvent::ProviderToolResult { .. }
                            | ModelEvent::Finished { .. } => true,
                            ModelEvent::Source(_)
                            | ModelEvent::PartStarted { .. }
                            | ModelEvent::PartDelta { .. }
                            | ModelEvent::PartFinished { .. }
                            | ModelEvent::ToolInputStarted { .. }
                            | ModelEvent::ToolInputDelta { .. }
                            | ModelEvent::ToolInputFinished { .. }
                            | ModelEvent::ResponseMetadata { .. } => false,
                        },
                    }).map(|event| {
                        EventWrite::plain(RuntimeEvent::new(input.invocation.clone(), Fact::ModelObserved {
                                step_id: step_id.to_owned(), event: event.clone(),
                        }))
                    }).collect::<Result<Vec<_>, _>>()?;
                    if !writes.is_empty() {
                        inner.log.append_batch(&writes).await?;
                    }
                    drop(observations.reservations);
                    if tools.is_some() && observations.accepted_item {
                        *progressed = true;
                        // Keep the obsolete request until its upload and readers
                        // physically settle, including an early provider reply.
                        if retired_prompt.is_none() {
                            retired_prompt = retry.take();
                        }
                    }
                    // Every call's acceptance is durable before dispatch, even
                    // when a later ready event failed validation or cancelled.
                    for event in observations.events {
                        if let ModelEvent::ToolCall(call) = event
                            && !call.provider_executed
                            && let Some(tools) = tools.as_mut()
                        {
                            let future = tools.dispatch(call, tool_cancellation.clone());
                            running.push(async move {
                                std::panic::AssertUnwindSafe(future).catch_unwind().await
                                    .unwrap_or_else(|_| Err(ToolError::CleanupUnconfirmed("tool panicked".into())))
                            });
                        }
                    }
                    if let Some(error) = observations.error {
                        return Err(error.into());
                    }
                }
            }
        }
        builder.finish().map_err(Into::into)
    }.await;
    let stream_cleanup = stream.cancel_and_wait().await;
    if matches!(result, Err(ref error) if !matches!(error, RunError::Model(_)) || error.is_cleanup_unconfirmed())
    {
        tool_cancellation.cancel();
    }
    let mut cleanup = Ok(());
    while let Some(result) = running.next().await {
        if let Err(error) = tool_result(result) {
            tool_cancellation.cancel();
            if cleanup.is_ok() {
                cleanup = Err(error);
            }
        }
    }
    stream_cleanup.map_err(|_| crate::cleanup::unconfirmed())?;
    close_retry(&mut retired_prompt).await?;
    cleanup?;
    let output = result?;
    if purpose == ModelPurpose::Summary
        && output.parts.iter().any(|part| {
            matches!(
                part,
                maka_agent_facts::model::ModelPart::ToolCall { .. }
                    | maka_agent_facts::model::ModelPart::ToolResult { .. }
            )
        })
    {
        return Err(maka_model::ModelError::Adapter("summary contains tool content".into()).into());
    }
    Ok(output)
}

struct ReadyObservations {
    events: Vec<ModelEvent>,
    reservations: Vec<Arc<tokio::sync::OwnedSemaphorePermit>>,
    accepted_item: bool,
    error: Option<ModelError>,
}

/// Take only the currently available prefix. A failed tail must not roll back
/// earlier valid observations or cause us to consume events beyond the failure.
fn ready_observations(
    builder: &mut StepBuilder,
    first: Result<maka_model::Emission, ModelError>,
    mut next_ready: impl FnMut() -> Option<Result<maka_model::Emission, ModelError>>,
) -> ReadyObservations {
    let mut observations = ReadyObservations {
        events: Vec::new(),
        reservations: Vec::new(),
        accepted_item: false,
        error: None,
    };
    let mut next = Some(first);
    while let Some(event) = next {
        match event.and_then(|emission| {
            builder.push(emission.event.clone())?;
            if let Some(reservation) = emission.reservation {
                observations.reservations.push(reservation);
            }
            Ok(emission.event)
        }) {
            Ok(event) => {
                observations.accepted_item |= builder.accepted_item().is_some();
                // Provider chunk boundaries have no durable identity. Retain the
                // existing 8 KiB text-observation budget after validating every
                // original event, and never merge across metadata or other events.
                if let (
                    Some(ModelEvent::PartDelta {
                        id,
                        text,
                        provider_options,
                    }),
                    ModelEvent::PartDelta {
                        id: next_id,
                        text: next_text,
                        provider_options: next_options,
                    },
                ) = (observations.events.last_mut(), &event)
                    && id.as_str() == next_id.as_str()
                    && provider_options.as_ref() == next_options.as_ref()
                    && text.len().saturating_add(next_text.len()) <= 8 * 1024
                {
                    text.push_str(next_text);
                } else {
                    observations.events.push(event);
                }
            }
            Err(error) => {
                observations.error = Some(error);
                break;
            }
        }
        next = next_ready();
    }
    observations
}

fn tool_result(
    result: Result<serde_json::Value, maka_agent_facts::tools::ToolError>,
) -> Result<(), RunError> {
    use maka_agent_facts::tools::ToolError;
    match result {
        Ok(_)
        | Err(
            ToolError::Failed(_)
            | ToolError::Io { .. }
            | ToolError::OutcomeUnknown(_)
            | ToolError::OperationUnknown { .. },
        ) => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[allow(clippy::too_many_arguments)]
async fn finish(
    inner: &Arc<RunContext>,
    input: &RunSettings,
    step_id: String,
    purpose: ModelPurpose,
    result: Result<ModelStep, RunError>,
    cancellation: &CancellationToken,
    item_acceptance: bool,
) -> Result<(String, ModelStep), RunError> {
    let output = match result {
        Ok(output) => output,
        Err(RunError::Model(error)) => {
            let status = match error {
                maka_model::ModelError::CleanupUnconfirmed => {
                    return Err(crate::cleanup::unconfirmed());
                }
                maka_model::ModelError::Cancelled => ModelInterruption::Cancelled,
                maka_model::ModelError::TimedOut => ModelInterruption::TimedOut,
                maka_model::ModelError::Adapter(_) | maka_model::ModelError::Http { .. } => {
                    ModelInterruption::Failed
                }
                maka_model::ModelError::ContextOverflow { .. } => ModelInterruption::Failed,
                maka_model::ModelError::Provider(ref failure)
                    if failure.replay_safe()
                        || (item_acceptance && failure.retained_output_safe()) =>
                {
                    ModelInterruption::RetryableFailure
                }
                maka_model::ModelError::Provider(ref failure)
                    if failure.reason() == maka_model::ProviderFailureReason::TimedOut =>
                {
                    ModelInterruption::TimedOut
                }
                maka_model::ModelError::Provider(_) => ModelInterruption::Failed,
            };
            append(
                inner,
                &input.invocation,
                Fact::ModelInterrupted {
                    step_id: step_id.clone(),
                    status,
                    diagnostic: Some(error.to_string().chars().take(1024).collect()),
                    model_failure: error.failure_cause(),
                },
            )
            .await?;
            return Err(error.into());
        }
        Err(error) => return Err(error),
    };
    use maka_agent_facts::event::EventWrite;
    use maka_agent_facts::event::RuntimeEvent;
    let incomplete = purpose == ModelPurpose::Main
        && output.finish_reason == maka_agent_facts::model::ModelFinishReason::Length;
    let mut writes = Vec::new();
    if incomplete && !item_acceptance {
        for call in output.tool_calls().filter(|call| !call.provider_executed) {
            writes.push(EventWrite::plain(RuntimeEvent::new(
                input.invocation.clone(),
                Fact::ToolRejected {
                    operation_id: format!("{step_id}:{}", call.id),
                    call: maka_agent_facts::tool_call::ToolCallIdentity::provider(
                        step_id.clone(),
                        call.id.clone(),
                    ),
                    name: call.name.clone(),
                    input: call.input.clone(),
                    reason: maka_agent_facts::tool_call::ToolRejection::PreparationFailed {
                        message: RunError::ModelIncomplete.to_string(),
                    },
                },
            ))?);
        }
    }
    writes.insert(
        0,
        EventWrite::plain(RuntimeEvent::new(
            input.invocation.clone(),
            Fact::ModelCompleted {
                step_id: step_id.clone(),
                output,
            },
        ))?,
    );
    inner.log.append_batch(&writes).await?;
    if incomplete {
        return Err(RunError::ModelIncomplete);
    }
    if cancellation.is_cancelled() {
        return Err(RunError::Cancelled);
    }
    let Fact::ModelCompleted { output, .. } = writes.remove(0).into_event().fact else {
        unreachable!("first write is the model completion");
    };
    Ok((step_id, output))
}

#[cfg(test)]
mod tests {
    use super::ready_observations;
    use maka_agent_facts::model::{ModelFinishReason, ModelPart, ModelStep, TextKind};
    use maka_model::{ModelError, ModelEvent, StepBuilder};
    use serde_json::{Value, json};

    #[test]
    fn tool_state_persistence_failure_stops_the_model_loop() {
        use maka_agent_facts::tools::ToolError;
        assert!(matches!(
            super::tool_result(Err(ToolError::Persistence(
                "discovery state commit failed after T2".into()
            ))),
            Err(crate::RunError::Tool(ToolError::Persistence(_)))
        ));
    }

    fn started(id: &str) -> ModelEvent {
        ModelEvent::PartStarted {
            id: id.into(),
            text_kind: TextKind::Text,
            provider_options: None,
        }
    }

    fn delta(id: &str, text: &str, provider_options: Option<Value>) -> ModelEvent {
        ModelEvent::PartDelta {
            id: id.into(),
            text: text.into(),
            provider_options,
        }
    }

    fn closed(id: &str) -> ModelEvent {
        ModelEvent::PartFinished {
            id: id.into(),
            provider_options: None,
        }
    }

    fn replay(events: &[ModelEvent]) -> ModelStep {
        let mut builder = StepBuilder::default();
        for event in events {
            builder.push(event.clone()).unwrap();
        }
        builder
            .push(ModelEvent::Finished {
                reason: ModelFinishReason::Stop,
                usage: Default::default(),
                provider_options: None,
            })
            .unwrap();
        builder.finish().unwrap()
    }

    fn batch(events: &[ModelEvent]) -> super::ReadyObservations {
        let mut ready = events.iter().cloned().map(|event| Ok(event.into()));
        ready_observations(&mut StepBuilder::default(), ready.next().unwrap(), || {
            ready.next()
        })
    }

    #[tokio::test]
    async fn coalesced_observations_retain_all_input_reservations_until_commit() {
        use std::sync::Arc;
        let budget = Arc::new(tokio::sync::Semaphore::new(2));
        let mut builder = StepBuilder::default();
        builder.push(started("text")).unwrap();
        let first = maka_model::Emission {
            event: delta("text", "one", None),
            reservation: Some(Arc::new(budget.clone().acquire_owned().await.unwrap())),
        };
        let second = maka_model::Emission {
            event: delta("text", " two", None),
            reservation: Some(Arc::new(budget.clone().acquire_owned().await.unwrap())),
        };
        let mut second = Some(Ok(second));
        let batch = ready_observations(&mut builder, Ok(first), || second.take());
        assert_eq!(batch.events, [delta("text", "one two", None)]);
        assert_eq!(
            budget.available_permits(),
            0,
            "uncommitted observations own both inputs"
        );
        drop(batch);
        assert_eq!(budget.available_permits(), 2);
        // StepBuilder retains the answer, but no longer owns in-flight capacity.
        builder.push(closed("text")).unwrap();
    }

    #[test]
    fn ready_deltas_preserve_metadata_changes_and_other_event_boundaries() {
        let original = vec![
            started("text"),
            delta(
                "text",
                "one",
                Some(json!({"provider":{"signature":"same"}})),
            ),
            delta(
                "text",
                " two",
                Some(json!({"provider":{"signature":"same"}})),
            ),
            delta(
                "text",
                " three",
                Some(json!({"provider":{"signature":"changed"}})),
            ),
            ModelEvent::ResponseMetadata {
                id: Some("response".into()),
                model: None,
                timestamp: None,
            },
            delta(
                "text",
                " four",
                Some(json!({"provider":{"signature":"changed"}})),
            ),
            closed("text"),
        ];
        let merged = batch(&original);
        assert!(merged.error.is_none());
        assert_eq!(
            merged.events,
            vec![
                started("text"),
                delta(
                    "text",
                    "one two",
                    Some(json!({"provider":{"signature":"same"}}))
                ),
                original[3].clone(),
                original[4].clone(),
                original[5].clone(),
                closed("text"),
            ]
        );
        let output = replay(&merged.events);
        assert_eq!(output, replay(&original));
        assert_eq!(
            output.parts,
            vec![ModelPart::Text {
                text_kind: TextKind::Text,
                text: "one two three four".into(),
                provider_options: Some(json!({"provider":{"signature":"changed"}})),
            }]
        );
    }

    #[test]
    fn ready_deltas_preserve_interleaved_parts() {
        let original = vec![
            started("a"),
            started("b"),
            delta("a", "first", None),
            delta("b", "second", None),
            delta("a", " third", None),
            delta("a", " fourth", None),
            closed("a"),
            closed("b"),
        ];
        let merged = batch(&original);
        assert!(merged.error.is_none());
        assert_eq!(
            merged.events,
            vec![
                started("a"),
                started("b"),
                delta("a", "first", None),
                delta("b", "second", None),
                delta("a", " third fourth", None),
                closed("a"),
                closed("b"),
            ]
        );
        assert_eq!(replay(&merged.events), replay(&original));
    }

    #[test]
    fn ready_deltas_keep_utf8_and_the_existing_text_byte_budget() {
        for (first, expected_lengths) in [
            ("x".repeat(8188), vec![8192, 2]),
            ("x".repeat(8189), vec![8189, 6]),
        ] {
            let original = vec![
                started("text"),
                delta("text", &first, None),
                delta("text", "😀", None),
                delta("text", "é", None),
                closed("text"),
            ];
            let merged = batch(&original);
            assert!(merged.error.is_none());
            let lengths: Vec<_> = merged
                .events
                .iter()
                .filter_map(|event| match event {
                    ModelEvent::PartDelta { text, .. } => Some(text.len()),
                    _ => None,
                })
                .collect();
            assert_eq!(lengths, expected_lengths);
            assert_eq!(replay(&merged.events), replay(&original));
        }
    }

    #[test]
    fn ready_observations_keep_valid_prefix_before_invalid_tail() {
        let valid = [
            started("text"),
            ModelEvent::PartDelta {
                id: "text".into(),
                text: "saved".into(),
                provider_options: None,
            },
            delta("text", " prefix", None),
            closed("text"),
        ];
        let mut ready = valid[1..].iter().cloned().map(Ok).chain([
            Ok(ModelEvent::PartFinished {
                id: "unknown".into(),
                provider_options: None,
            }),
            Ok(started("must-not-be-read")),
        ]);
        let batch = ready_observations(
            &mut StepBuilder::default(),
            Ok(valid[0].clone().into()),
            || ready.next().map(|result| result.map(Into::into)),
        );
        assert_eq!(
            batch.events,
            [
                started("text"),
                delta("text", "saved prefix", None),
                closed("text")
            ]
        );
        assert_eq!(replay(&batch.events), replay(&valid));
        assert!(batch.accepted_item);
        assert!(batch.error.is_some());
        assert_eq!(ready.next().unwrap().unwrap(), started("must-not-be-read"));
    }

    #[test]
    fn ready_observations_keep_prefix_on_cancellation_and_provider_failure() {
        for error in [
            ModelError::Cancelled,
            ModelError::Adapter("provider failed".into()),
        ] {
            let event = started("saved");
            let mut next = Some(Err(error));
            let batch = ready_observations(
                &mut StepBuilder::default(),
                Ok(event.clone().into()),
                || next.take(),
            );
            assert_eq!(batch.events, [event]);
            assert!(batch.error.is_some());
            assert!(!batch.accepted_item);
        }
    }

    #[test]
    fn ready_observations_flush_when_no_more_events_are_ready() {
        let mut builder = StepBuilder::default();
        let event = ModelEvent::Finished {
            reason: ModelFinishReason::Stop,
            usage: Default::default(),
            provider_options: None,
        };
        let batch = ready_observations(&mut builder, Ok(event.clone().into()), || None);
        assert_eq!(batch.events, [event]);
        assert!(batch.error.is_none());
        builder.finish().unwrap();
    }
}
