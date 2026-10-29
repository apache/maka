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
use crate::{RunContext, RunError, RunInput, RunSettings, history, runner::digest};
use maka_agent_facts::context::ModelPurpose;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::ModelInterruption;
use maka_agent_facts::model::ModelPart;
use maka_agent_facts::model::assembly::{AttemptBinding, AttemptWriter, PartReceipt};
use maka_agent_facts::model::recorded::{ModelObservation, RecordedPartRef};
use maka_event_log::context::ContextView;
use maka_model::{ModelError, ModelRequest, ToolDefinition};
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

pub(super) enum AttemptOutput {
    Main(MainResponse),
    Summary {
        step_id: String,
        summary: Result<
            maka_agent_facts::context::TextSummary,
            maka_agent_facts::context::SummaryDefect,
        >,
    },
}

pub(super) struct MainResponse {
    pub local_call_ids: Vec<String>,
    pub response_id: Option<String>,
}

pub(super) enum Outcome {
    Response(MainResponse),
    FinishedByTool,
}
impl From<AttemptOutput> for Outcome {
    fn from(output: AttemptOutput) -> Self {
        let AttemptOutput::Main(output) = output else {
            unreachable!("Main request returns Main attempt output");
        };
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
            Err(error) => additional_failure(result, error),
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
) -> Result<AttemptOutput, RunError> {
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
    let sequence = inner.log.clone().commit(write).await?;
    let mut writer = AttemptWriter::new(
        AttemptBinding {
            invocation: input.invocation.clone(),
            step_id: step_id.clone(),
            purpose,
        },
        item_acceptance,
    )?;
    writer.fenced(sequence);
    let finalizer = inner.attempts.register(writer.snapshot(), item_acceptance);
    let result: Result<_, RunError> = async {
        let stream = inner
            .shared
            .model
            .stream_with_adapter(prepared.request, cancellation.clone(), lane, binding)
            .await?;
        receive(
            inner,
            &mut writer,
            &finalizer,
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
    let completion_tools = tools.filter(|_| !item_acceptance);
    let result = finish(
        inner,
        writer,
        &finalizer,
        result,
        cancellation,
        completion_tools,
        retry,
    )
    .await;
    let result = match result {
        Err(error) if finalizer.publication().is_none() => {
            Err(seal_finalizer(inner, &finalizer, error).await)
        }
        other => other,
    };
    inner.attempts.remove(&step_id);
    result
}

async fn preserve_completion(
    inner: &Arc<RunContext>,
    completion: &maka_agent_facts::event::EventWrite,
    error: RunError,
) -> RunError {
    if let Err(flush) = inner.log.append(completion).await {
        let message = format!("{error}; model completion could not be persisted: {flush}");
        return if error.is_cleanup_unconfirmed() {
            maka_agent_facts::tools::ToolError::CleanupUnconfirmed(message).into()
        } else {
            maka_agent_facts::tools::ToolError::Persistence(message).into()
        };
    }
    error
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
    writer: &mut AttemptWriter,
    finalizer: &crate::preview::Finalizer,
    mut stream: maka_model::ModelStream,
    mut tools: Option<maka_tools::StepTools<'_>>,
    progressed: &mut bool,
    cancellation: &CancellationToken,
    retry: &mut Option<PreparedPrompt>,
) -> Result<(), RunError> {
    use futures_util::{FutureExt, StreamExt, stream::FuturesUnordered};
    use maka_agent_facts::tools::ToolError;
    let tool_cancellation = cancellation.child_token();
    let mut running = FuturesUnordered::new();
    let mut retired_prompt = None;
    let binding = finalizer.snapshot().binding.clone();
    let result: Result<_, RunError> = async {
        loop {
            tokio::select! {
                biased;
                result = running.next(), if !running.is_empty() => { tool_result(result.unwrap())?; }
                event = stream.next() => {
                    let Some(event) = event else { break; };
                    let observations = ready_observations(writer, event, || {
                        stream.next().now_or_never().flatten()
                    });
                    use maka_agent_facts::event::{EventWrite, RuntimeEvent};
                    let writes = observations.events.iter().map(|event| {
                        EventWrite::plain(RuntimeEvent::new(binding.invocation.clone(), Fact::ModelObserved {
                            step_id: binding.step_id.clone(), event: event.clone(),
                        }))
                    }).collect::<Result<Vec<_>, _>>()?;
                    if !writes.is_empty() {
                        let sequences = inner.log.append_batch(&writes).await?;
                        for (write, sequence) in writes.iter().zip(sequences) {
                            if let Fact::ModelObserved { event: ModelObservation::Part(part), .. } = &write.event().fact {
                                writer.recorded(PartReceipt {
                                    part: RecordedPartRef { event_id: write.event().id.clone(), ordinal: part.ordinal },
                                    sequence,
                                });
                            } else {
                                writer.fenced(sequence);
                            }
                        }
                    }
                    // The worker consumed ingress and any canonical writes physically settled.
                    drop(observations.reservations);
                    inner.attempts.publish(finalizer, writer.snapshot());
                    let accepted_item = observations.events.iter().any(|event| matches!(event, ModelObservation::Part(_)));
                    if tools.is_some() && accepted_item {
                        *progressed = true;
                        if retired_prompt.is_none() {
                            retired_prompt = retry.take();
                        }
                    }
                    // Complete items have their real canonical receipt before local dispatch.
                    for event in observations.events {
                        if let ModelObservation::Part(record) = event
                            && let ModelPart::ToolCall { call } = record.part.as_ref()
                            && !call.provider_executed
                            && let Some(tools) = tools.as_mut()
                        {
                            let future = tools.dispatch(call.clone(), None, tool_cancellation.clone());
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
        Ok(())
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
    let mut result = result;
    if stream_cleanup.is_err() {
        result = additional_failure(result, crate::cleanup::unconfirmed());
    }
    if let Err(error) = close_retry(&mut retired_prompt).await {
        result = additional_failure(result, error);
    }
    if let Err(error) = cleanup {
        result = additional_failure(result, error);
    }
    result
}

pub(super) fn additional_failure<T>(
    result: Result<T, RunError>,
    failure: RunError,
) -> Result<T, RunError> {
    match result {
        Ok(_) => Err(failure),
        Err(error) => {
            let message = format!("{error}; additional attempt failure: {failure}");
            if error.is_cleanup_unconfirmed() || failure.is_cleanup_unconfirmed() {
                Err(maka_agent_facts::tools::ToolError::CleanupUnconfirmed(message).into())
            } else {
                Err(maka_agent_facts::tools::ToolError::Persistence(message).into())
            }
        }
    }
}

struct ReadyObservations {
    events: Vec<ModelObservation>,
    reservations: Vec<Arc<tokio::sync::OwnedSemaphorePermit>>,
    error: Option<ModelError>,
}

/// Consume only the ready valid prefix; a failed tail cannot mutate its content.
fn ready_observations(
    writer: &mut AttemptWriter,
    first: Result<maka_model::Emission, ModelError>,
    mut next_ready: impl FnMut() -> Option<Result<maka_model::Emission, ModelError>>,
) -> ReadyObservations {
    let mut observations = ReadyObservations {
        events: Vec::new(),
        reservations: Vec::new(),
        error: None,
    };
    let mut next = Some(first);
    while let Some(event) = next {
        match event.and_then(|emission| {
            let events = writer.push(emission.event, std::time::SystemTime::now())?;
            if let Some(reservation) = emission.reservation {
                observations.reservations.push(reservation);
            }
            Ok(events)
        }) {
            Ok(events) => observations.events.extend(events),
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

async fn finish(
    inner: &Arc<RunContext>,
    writer: AttemptWriter,
    finalizer: &crate::preview::Finalizer,
    result: Result<(), RunError>,
    cancellation: &CancellationToken,
    completion_tools: Option<&maka_tools::RequestTools<'_>>,
    retry: &mut Option<PreparedPrompt>,
) -> Result<AttemptOutput, RunError> {
    let item_acceptance = finalizer.item_acceptance;
    let result = result.and_then(|()| {
        let output = writer.completed()?;
        if output.binding.purpose == ModelPurpose::Summary
            && output.parts().iter().any(|record| {
                matches!(
                    record.part.as_ref(),
                    ModelPart::ToolCall { .. } | ModelPart::ToolResult { .. }
                )
            })
        {
            return Err(ModelError::Adapter("summary contains tool content".into()).into());
        }
        Ok(output)
    });
    let output = match result {
        Ok(output) => output,
        Err(error) => {
            let cut = writer.snapshot();
            drop(writer);
            inner.attempts.publish(finalizer, cut.clone());
            let publication = interruption(&cut, &error, finalizer.item_acceptance)?;
            let publication = match finalizer.prepare(publication) {
                crate::preview::PublicationSelection::New(publication)
                | crate::preview::PublicationSelection::Existing(publication) => publication,
            };
            return Err(match inner.log.append(&publication).await {
                Ok(_) => error,
                Err(seal) => seal_failure(error, seal),
            });
        }
    };
    drop(writer);
    let summary = if output.binding.purpose == ModelPurpose::Summary {
        use maka_agent_facts::context::TextSummary;
        match TextSummary::from_parts(
            output.finish_reason,
            output.parts().iter().map(|record| record.part.as_ref()),
        ) {
            Ok(summary) => Some(summary),
            Err(defect) => {
                let error: RunError = ModelError::Adapter(defect.to_string()).into();
                let cut = finalizer.snapshot();
                let publication = interruption(&cut, &error, item_acceptance)?;
                let crate::preview::PublicationSelection::New(publication) =
                    finalizer.prepare(publication)
                else {
                    return Err(crate::cleanup::unconfirmed());
                };
                if let Err(seal) = inner.log.append(&publication).await {
                    return Err(seal_failure(error, seal));
                }
                if cancellation.is_cancelled() {
                    return Err(RunError::Cancelled);
                }
                return Ok(AttemptOutput::Summary {
                    step_id: output.binding.step_id.clone(),
                    summary: Err(defect),
                });
            }
        }
    } else {
        None
    };
    use maka_agent_facts::event::{EventWrite, RuntimeEvent};
    let step_id = &output.binding.step_id;
    let incomplete = output.binding.purpose == ModelPurpose::Main
        && output.finish_reason == maka_agent_facts::model::ModelFinishReason::Length;
    let cancelled = cancellation.is_cancelled();
    let defer_completion = completion_tools.is_some()
        && output.binding.purpose == ModelPurpose::Main
        && !item_acceptance
        && !incomplete
        && !cancelled
        && output.parts().iter().any(|record| matches!(record.part.as_ref(), ModelPart::ToolCall { call } if !call.provider_executed));
    let completion = EventWrite::plain(RuntimeEvent::new(
        output.binding.invocation.clone(),
        Fact::ModelCompleted {
            step_id: step_id.clone(),
            output: output.completion(),
        },
    ))?;
    let crate::preview::PublicationSelection::New(completion) = finalizer.prepare(completion)
    else {
        return Err(crate::cleanup::unconfirmed());
    };
    let mut writes = vec![completion.clone()];
    if incomplete && !item_acceptance {
        for record in output.parts() {
            if let ModelPart::ToolCall { call } = record.part.as_ref()
                && !call.provider_executed
            {
                writes.push(EventWrite::plain(RuntimeEvent::new(
                    output.binding.invocation.clone(),
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
    }
    if !defer_completion {
        inner.log.append_batch(&writes).await?;
    }
    if incomplete {
        return Err(RunError::ModelIncomplete);
    }
    if cancellation.is_cancelled() {
        if defer_completion {
            inner.log.append_batch(&writes).await?;
        }
        return Err(RunError::Cancelled);
    }
    drop(writes);
    if let Some(summary) = summary {
        return Ok(AttemptOutput::Summary {
            step_id: step_id.clone(),
            summary: Ok(summary),
        });
    }
    let response = MainResponse {
        local_call_ids: output.local_call_ids(),
        response_id: output.response_id.clone(),
    };
    if let Some(tools) = completion_tools {
        if let Err(error) = close_retry(retry).await {
            return Err(preserve_completion(inner, &completion, error).await);
        }
        use futures_util::{FutureExt, StreamExt, stream::FuturesUnordered};
        let mut step = tools.clone().into_step(step_id);
        let tool_cancellation = cancellation.child_token();
        let mut running = FuturesUnordered::new();
        for record in output.parts() {
            if let ModelPart::ToolCall { call } = record.part.as_ref()
                && !call.provider_executed
            {
                let future = step.dispatch(
                    call.clone(),
                    Some(completion.clone()),
                    tool_cancellation.clone(),
                );
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
        }
        drop(output);
        let mut cleanup = Ok(());
        while let Some(result) = running.next().await {
            if let Err(error) = tool_result(result) {
                tool_cancellation.cancel();
                if cleanup.is_ok() {
                    cleanup = Err(error);
                }
            }
        }
        if let Err(error) = cleanup {
            return Err(preserve_completion(inner, &completion, error).await);
        }
    } else {
        drop(output);
    }
    Ok(AttemptOutput::Main(response))
}

fn interruption(
    cut: &maka_agent_facts::model::assembly::AttemptCut,
    error: &RunError,
    item_acceptance: bool,
) -> Result<maka_agent_facts::event::EventWrite, RunError> {
    let status = match error {
        RunError::Cancelled | RunError::Model(ModelError::Cancelled) => {
            ModelInterruption::Cancelled
        }
        RunError::Model(ModelError::TimedOut) => ModelInterruption::TimedOut,
        RunError::Model(ModelError::Provider(failure))
            if failure.replay_safe() || (item_acceptance && failure.retained_output_safe()) =>
        {
            ModelInterruption::RetryableFailure
        }
        RunError::Model(ModelError::Provider(failure))
            if failure.reason() == maka_model::ProviderFailureReason::TimedOut =>
        {
            ModelInterruption::TimedOut
        }
        _ => ModelInterruption::Failed,
    };
    Ok(maka_agent_facts::event::EventWrite::plain(
        maka_agent_facts::event::RuntimeEvent::new(
            cut.binding.invocation.clone(),
            Fact::ModelInterrupted {
                step_id: cut.binding.step_id.clone(),
                status,
                diagnostic: Some(error.to_string().chars().take(1024).collect()),
                model_failure: match error {
                    RunError::Model(error) => error.failure_cause(),
                    _ => None,
                },
                partial: cut.partial(),
            },
        ),
    )?)
}

fn seal_failure(error: RunError, seal: impl std::fmt::Display) -> RunError {
    let message = format!("{error}; model attempt could not be sealed: {seal}");
    if error.is_cleanup_unconfirmed() {
        maka_agent_facts::tools::ToolError::CleanupUnconfirmed(message).into()
    } else {
        maka_agent_facts::tools::ToolError::Persistence(message).into()
    }
}

async fn seal_finalizer(
    inner: &RunContext,
    finalizer: &crate::preview::Finalizer,
    error: RunError,
) -> RunError {
    let cut = finalizer.snapshot();
    let publication = match finalizer.publication() {
        Some(publication) => Ok(publication),
        None => interruption(&cut, &error, finalizer.item_acceptance),
    };
    match publication {
        Ok(publication) => {
            let publication = match finalizer.prepare(publication) {
                crate::preview::PublicationSelection::New(publication)
                | crate::preview::PublicationSelection::Existing(publication) => publication,
            };
            match inner.log.append(&publication).await {
                Ok(_) => error,
                Err(seal) => seal_failure(error, seal),
            }
        }
        Err(seal) => seal_failure(error, seal),
    }
}

pub(super) async fn seal_unfinished_attempts<T>(
    inner: &RunContext,
    result: Result<T, RunError>,
) -> Result<T, RunError> {
    let unfinished = inner.attempts.unfinished();
    if unfinished.is_empty() {
        return result;
    }
    let mut error = result
        .err()
        .unwrap_or_else(|| RunError::Internal("model attempt returned without sealing".into()));
    for finalizer in unfinished {
        let cut = finalizer.snapshot();
        error = seal_finalizer(inner, &finalizer, error).await;
        inner.attempts.remove(&cut.binding.step_id);
    }
    Err(error)
}

#[cfg(test)]
mod tests {
    use super::ready_observations;
    use maka_agent_facts::context::ModelPurpose;
    use maka_agent_facts::event::Invocation;
    use maka_agent_facts::model::assembly::{AttemptBinding, AttemptWriter};
    use maka_agent_facts::model::recorded::CompletionPart;
    use maka_agent_facts::model::{ModelEvent, ModelFinishReason, ModelPart, TextKind};
    use serde_json::json;

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

    fn writer() -> AttemptWriter {
        AttemptWriter::new(
            AttemptBinding {
                invocation: Invocation {
                    session_id: "session".into(),
                    turn_id: "turn".into(),
                    run_id: "run".into(),
                    invocation_id: "invocation".into(),
                },
                step_id: "step".into(),
                purpose: ModelPurpose::Main,
            },
            true,
        )
        .unwrap()
    }

    fn started(id: &str) -> ModelEvent {
        ModelEvent::PartStarted {
            id: id.into(),
            text_kind: TextKind::Text,
            provider_options: None,
        }
    }

    fn delta(id: &str, text: &str, provider_options: Option<serde_json::Value>) -> ModelEvent {
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

    #[tokio::test]
    async fn consumed_inputs_retain_reservations_until_the_publication_batch_settles() {
        use std::sync::Arc;
        let budget = Arc::new(tokio::sync::Semaphore::new(2));
        let mut writer = writer();
        writer
            .push(started("text"), std::time::SystemTime::now())
            .unwrap();
        let first = maka_model::Emission {
            event: delta("text", "one", None),
            reservation: Some(Arc::new(budget.clone().acquire_owned().await.unwrap())),
        };
        let second = maka_model::Emission {
            event: delta("text", " two", None),
            reservation: Some(Arc::new(budget.clone().acquire_owned().await.unwrap())),
        };
        let mut second = Some(Ok(second));
        let batch = ready_observations(&mut writer, Ok(first), || second.take());
        assert_eq!(
            budget.available_permits(),
            0,
            "publication batch owns both consumed inputs"
        );
        let partial = writer.partial().unwrap();
        let CompletionPart::Own(record) = &partial.parts[0] else {
            panic!("unrecorded text is owned");
        };
        let ModelPart::Text { text, .. } = record.part.as_ref() else {
            panic!("text part");
        };
        assert_eq!(text.chunks().collect::<String>(), "one two");
        drop(batch);
        assert_eq!(budget.available_permits(), 2);
    }

    #[test]
    fn ready_metadata_preserves_original_response_and_final_part_options() {
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
                model: Some("model".into()),
                timestamp: Some("timestamp".into()),
            },
            delta(
                "text",
                " four",
                Some(json!({"provider":{"signature":"changed"}})),
            ),
            closed("text"),
            ModelEvent::Finished {
                reason: ModelFinishReason::Stop,
                usage: Default::default(),
                provider_options: None,
            },
        ];
        let mut writer = writer();
        let mut ready = original.into_iter().map(|event| Ok(event.into()));
        let batch = ready_observations(&mut writer, ready.next().unwrap(), || ready.next());
        assert!(batch.error.is_none());
        let completed = writer.completed().unwrap();
        let ModelPart::Text {
            text,
            provider_options,
            ..
        } = completed.parts()[0].part.as_ref()
        else {
            panic!("text part");
        };
        assert_eq!(text.chunks().collect::<String>(), "one two three four");
        assert_eq!(
            provider_options.as_deref(),
            Some(&json!({"provider":{"signature":"changed"}}))
        );
        assert_eq!(completed.response_id.as_deref(), Some("response"));
        assert_eq!(completed.model.as_deref(), Some("model"));
        assert_eq!(completed.timestamp.as_deref(), Some("timestamp"));
        assert!(batch.events.iter().any(|event| matches!(event, maka_agent_facts::model::recorded::ModelObservation::ResponseMetadata { id: Some(id), .. } if id == "response")));
    }

    #[test]
    fn ready_observations_keep_valid_prefix_before_invalid_tail() {
        let mut ready = [
            delta("text", "saved", None),
            delta("text", " prefix", None),
            closed("text"),
            closed("unknown"),
            started("must-not-be-read"),
        ]
        .into_iter();
        let mut writer = writer();
        let batch = ready_observations(&mut writer, Ok(started("text").into()), || {
            ready.next().map(|event| Ok(event.into()))
        });
        assert!(batch.error.is_some());
        assert!(
            writer.completed().is_err(),
            "invalid tail cannot produce successful completion"
        );
        let partial = writer.snapshot().partial().unwrap();
        let CompletionPart::Own(record) = &partial.parts[0] else {
            panic!("unrecorded valid prefix is owned");
        };
        assert_eq!(record.ordinal, 0);
        assert_eq!(record.provider_part_id.as_deref(), Some("text"));
        let ModelPart::Text { text, .. } = record.part.as_ref() else {
            panic!("text part");
        };
        assert_eq!(text.chunks().collect::<String>(), "saved prefix");
        assert!(batch.events.iter().any(|event| matches!(event, maka_agent_facts::model::recorded::ModelObservation::Part(part) if part.ordinal == 0)));
        assert_eq!(ready.next(), Some(started("must-not-be-read")));
    }
}
