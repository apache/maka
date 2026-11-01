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
    pub approvals: futures_util::stream::FuturesUnordered<maka_tools::PendingCall>,
}

pub(super) enum Outcome {
    Response(MainResponse),
    FinishedByTool,
    ParkRetry(maka_agent_facts::model_retry::RetryPlan),
}
impl From<AttemptOutput> for Outcome {
    fn from(output: AttemptOutput) -> Self {
        let AttemptOutput::Main(output) = output else {
            unreachable!("Main request returns Main attempt output");
        };
        Self::Response(output)
    }
}

pub(super) struct PromptSettings<'a> {
    pub language: Language,
    pub provider: &'a maka_model::ProviderConfig,
    pub options: &'a serde_json::Value,
    pub context_window: Option<u64>,
}
impl<'a> PromptSettings<'a> {
    fn from_input<W>(input: &'a RunInput<W>) -> Self {
        Self {
            language: input.configuration.language,
            provider: &input.provider,
            options: &input.provider_options,
            context_window: input
                .context
                .as_ref()
                .and_then(|context| context.model_context_window),
        }
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
    prompt_with_resources(
        &inner.log,
        inner.shared.preparation_resources.clone(),
        &PromptSettings::from_input(input),
        source,
        cancellation,
        continuation_base,
        current,
        prior_unknown,
        system,
        purpose,
    )
    .await
}

#[allow(clippy::too_many_arguments)] // Keep the admitted history policy explicit at each model request.
pub(super) async fn prompt_with_resources(
    log: &Arc<maka_event_log::root_store::SessionStore>,
    resources: maka_model::ModelPreparationResources,
    settings: &PromptSettings<'_>,
    source: &Arc<ContextView>,
    cancellation: &CancellationToken,
    continuation_base: Option<u64>,
    current: &str,
    prior_unknown: bool,
    system: Option<Arc<String>>,
    purpose: ModelPurpose,
) -> Result<PreparedPrompt, RunError> {
    let route = digest(settings.provider)?;
    let mut selection = source.selection.clone();
    selection.replay =
        continuation_base.map(|base| maka_event_log::context::semantic::SemanticReplay {
            base,
            current: current.to_owned(),
            route,
            model: settings.provider.model.clone(),
        });
    selection.prior_unknown = prior_unknown;
    let overlay_bytes = PreparedPrompt::overlay_plan_bytes(
        system.is_some(),
        source.baseline.is_some(),
        purpose == ModelPurpose::Summary,
    );
    let body = history::prepare_view(
        log,
        selection,
        settings.language,
        true,
        &settings.provider.kind,
        cancellation,
        resources,
        overlay_bytes,
    )
    .await?;
    let mut prompt = PreparedPrompt::from_history(body);
    let label = match settings.language {
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
    if let Err(error) = prompt.prepare_media(settings.provider, cancellation).await {
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

#[derive(Clone)]
pub(super) struct RequestSource {
    pub evidence: maka_event_log::context::SourceEvidence,
    pub effective_digest: String,
    pub checkpoint: Option<String>,
    pub capture: maka_agent_facts::event::SourceCapture,
}

impl From<&ContextView> for RequestSource {
    fn from(source: &ContextView) -> Self {
        Self {
            capture: maka_agent_facts::event::SourceCapture {
                publication_watermark: source.selection.captured_through,
                prior_unknown: source.selection.prior_unknown,
            },
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
    source.capture.prior_unknown = prior_unknown;
    drop(context);
    execute_retry_chain(
        inner,
        input,
        source,
        prompt,
        Main {
            lane,
            continuation_base,
            surface,
            tools,
            prior_unknown,
        },
        None,
        cancellation,
    )
    .await
}

pub(super) async fn execute_frozen_main(
    inner: &Arc<RunContext>,
    input: &RunSettings,
    source: RequestSource,
    prompt: PreparedPrompt,
    main: Main<'_>,
    consumption: maka_agent_facts::model_retry::ModelRetryConsumption,
    cancellation: &CancellationToken,
) -> (u64, Result<Outcome, RunError>) {
    execute_retry_chain(
        inner,
        input,
        source,
        prompt,
        main,
        Some(consumption),
        cancellation,
    )
    .await
}

pub(super) enum RetryPrompt {
    Materialized(Box<PreparedPrompt>),
    Frozen(Arc<crate::frozen_request::FrozenReplay>),
}

async fn execute_retry_chain(
    inner: &Arc<RunContext>,
    input: &RunSettings,
    mut source: RequestSource,
    prompt: PreparedPrompt,
    main: Main<'_>,
    mut consumption: Option<maka_agent_facts::model_retry::ModelRetryConsumption>,
    cancellation: &CancellationToken,
) -> (u64, Result<Outcome, RunError>) {
    let Main {
        lane,
        continuation_base,
        surface,
        tools,
        prior_unknown,
    } = main;
    let mut failures = consumption.as_ref().map_or(0, |retry| retry.plan.failures);
    let mut high_water = source.evidence.high_water;
    let mut retry = Some(RetryPrompt::Materialized(Box::new(prompt)));
    let result = async {
        loop {
            // Preserve captured capabilities. Rebuild history only when a completed
            // item advanced canonical progress, never from a shortened WS request.
            let mut progressed = false;
            let mut confirmed_failure = None;
            let prompt = match retry
                .take()
                .expect("unprogressed attempt retains its frozen input")
            {
                RetryPrompt::Materialized(prompt) => *prompt,
                RetryPrompt::Frozen(frozen) => {
                    let prompt = frozen.prepared(cancellation).await?;
                    retry = Some(RetryPrompt::Frozen(frozen));
                    prompt
                }
            };
            let result = execute_once(
                inner,
                input,
                &source,
                prompt,
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
                &mut confirmed_failure,
                consumption.take(),
            )
            .await;
            let (plan, durable, clock) = match &result {
                Err(RunError::Model(maka_model::ModelError::Provider(failure)))
                    if failure.replay_safe() || (progressed && failure.retained_output_safe()) =>
                {
                    if cancellation.is_cancelled() {
                        return Err(RunError::Cancelled);
                    }
                    if tools.finished() {
                        return Ok(Outcome::FinishedByTool);
                    }
                    if !failure.retryable() {
                        return result.map(Outcome::from);
                    }
                    let backoff = if failures >= ORDINARY_RETRIES {
                        if !lane.try_switch_fallback_transport() {
                            return result.map(Outcome::from);
                        }
                        failures = 0;
                        std::time::Duration::ZERO
                    } else {
                        let base_ms = RETRY_BASE_MS << failures;
                        failures += 1;
                        std::time::Duration::from_millis(fastrand::u64(
                            base_ms * 9 / 10..=jitter_upper(base_ms),
                        ))
                    };
                    let Some(failure_event_id) = confirmed_failure else {
                        return Err(RunError::ReconciliationRequired(
                            "retry failure has no confirmed terminal receipt".into(),
                        ));
                    };
                    let now = retry_now()?;
                    let plan = retry_plan(
                        failure_event_id,
                        failure,
                        backoff,
                        now,
                        failures,
                        lane.retry_transport_phase(),
                    )?;
                    let durable = !progressed
                        && failure.replay_safe()
                        && input.native_activation_basis.is_some()
                        && failure.retry_at_unix_ms().is_some()
                        && plan.not_before_unix_ms.saturating_sub(now)
                            > ordinary_retry_horizon_ms();
                    let clock = if failure.retry_at_unix_ms().is_some() {
                        RetryClock::ProviderDeadline
                    } else {
                        RetryClock::Monotonic
                    };
                    (plan, durable, clock)
                }
                _ => return result.map(Outcome::from),
            };
            if durable {
                return Ok(Outcome::ParkRetry(plan));
            }
            if progressed {
                // Accepted progress replaces the frozen retry prompt. Release it
                // before materializing the next canonical source.
                close_retry(&mut retry).await?;
                let context = read_source(inner, input, prior_unknown, cancellation).await?;
                high_water = context.source_evidence.high_water;
                source = RequestSource::from(context.as_ref());
                source.capture.prior_unknown = prior_unknown;
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
                retry = Some(RetryPrompt::Materialized(Box::new(prompt)));
            }
            // execute_once has drained the worker and committed ModelInterrupted.
            // A local/storage error cannot reach this wait or authorize another send.
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err(RunError::Cancelled),
                waited = wait_retry_plan(&plan, clock) => { waited?; }
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

const RETRY_BASE_MS: u64 = 200;
const ORDINARY_RETRIES: u32 = 9;

const fn jitter_upper(base_ms: u64) -> u64 {
    base_ms * 11 / 10
}
const fn ordinary_retry_horizon_ms() -> u64 {
    jitter_upper(RETRY_BASE_MS << (ORDINARY_RETRIES - 1))
}

fn retry_now() -> Result<u64, RunError> {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| RunError::InvalidInput(format!("invalid retry clock: {error}")))?;
    u64::try_from(elapsed.as_millis())
        .map_err(|error| RunError::InvalidInput(format!("retry clock overflow: {error}")))
}

fn retry_plan(
    failure_event_id: String,
    failure: &maka_model::ProviderFailure,
    backoff: std::time::Duration,
    now: u64,
    failures: u32,
    transport_phase: maka_agent_facts::model::retry_transport::RetryTransportPhase,
) -> Result<maka_agent_facts::model_retry::RetryPlan, RunError> {
    let backoff = u64::try_from(backoff.as_millis())
        .map_err(|error| RunError::InvalidInput(format!("retry backoff overflow: {error}")))?;
    let local = now
        .checked_add(backoff)
        .ok_or_else(|| RunError::InvalidInput("retry deadline overflow".into()))?;
    let not_before_unix_ms = local.max(failure.retry_at_unix_ms().unwrap_or(now));
    if not_before_unix_ms > i64::MAX as u64 {
        return Err(RunError::InvalidInput(
            "retry deadline exceeds storage range".into(),
        ));
    }
    Ok(maka_agent_facts::model_retry::RetryPlan {
        failure_event_id,
        not_before_unix_ms,
        failures,
        transport_phase,
    })
}

enum RetryClock {
    Monotonic,
    ProviderDeadline,
}

async fn wait_retry_plan(
    plan: &maka_agent_facts::model_retry::RetryPlan,
    clock: RetryClock,
) -> Result<(), RunError> {
    loop {
        let now = retry_now()?;
        let Some(remaining) = plan.not_before_unix_ms.checked_sub(now).filter(|n| *n > 0) else {
            return Ok(());
        };
        wait_retry(std::time::Duration::from_millis(remaining)).await;
        if matches!(clock, RetryClock::Monotonic) {
            return Ok(());
        }
    }
}

async fn wait_retry(delay: std::time::Duration) {
    match tokio::time::Instant::now().checked_add(delay) {
        Some(at) => tokio::time::sleep_until(at).await,
        // An unrepresentable deadline cannot authorize an earlier replay.
        None => std::future::pending::<()>().await,
    }
}

async fn close_retry(retry: &mut Option<RetryPrompt>) -> Result<(), RunError> {
    if let Some(RetryPrompt::Materialized(prompt)) = retry.take() {
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
    definitions: Vec<Arc<ToolDefinition>>,
    attempt: Attempt<'_>,
    cancellation: &CancellationToken,
    progressed: &mut bool,
    retry: &mut Option<RetryPrompt>,
    confirmed_failure: &mut Option<String>,
    consumption: Option<maka_agent_facts::model_retry::ModelRetryConsumption>,
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
        if purpose == ModelPurpose::Main {
            prompt
                .close()
                .await
                .map_err(crate::cleanup::preparation_failed)?;
        }
        return Err(RunError::Cancelled);
    }
    if let Err(error) = prepare_wire(
        input,
        &mut prompt,
        &definitions,
        surface.max_output_tokens,
        cancellation,
    )
    .await
    {
        if purpose == ModelPurpose::Main {
            prompt
                .close()
                .await
                .map_err(crate::cleanup::preparation_failed)?;
        }
        return Err(error);
    }
    let cleanup = (purpose == ModelPurpose::Main).then(|| prompt.cleanup());
    let prepared = match prepare_request(
        input,
        prompt,
        definitions,
        surface.max_output_tokens,
        purpose,
    ) {
        Ok(prepared) => prepared,
        Err(error) => {
            close_materialization(&cleanup).await?;
            return Err(error);
        }
    };
    let binding = surface.adapter.clone();
    let item_acceptance = purpose == ModelPurpose::Main && binding.supports_item_acceptance();
    let step_id = Uuid::new_v4().to_string();
    let committed: Result<_, RunError> = async {
        let composition = surface.evidence();
        let event = maka_agent_facts::event::RuntimeEvent::new(
            input.invocation.clone(),
            Fact::ModelRequested {
                source_capture: source.capture,
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
        let event_id = event.id.clone();
        let mut write =
            maka_agent_facts::event::EventWrite::plain(event)?.with_composition(composition)?;
        if let Some(consumption) = consumption {
            write = write.with_model_retry_consumption(consumption)?;
        }
        if let Some(pricing) = &inner.shared.pricing {
            write = write.with_quote(
                pricing
                    .quote(&input.provider_id, &input.provider.model)
                    .await?,
            )?;
        }
        use maka_agent_facts::event::EventSink;
        let sequence = if write.model_retry_consumption().is_some() {
            commit_retry_request(inner, &write).await?
        } else {
            inner.log.clone().commit(write).await?
        };
        surface.committed(event_id.clone());
        Ok((sequence, event_id))
    }
    .await;
    let (sequence, event_id) = match committed {
        Ok(committed) => committed,
        Err(error) => {
            drop(prepared.request);
            close_materialization(&cleanup).await?;
            return Err(error);
        }
    };
    let model_source = if purpose == ModelPurpose::Main {
        let frozen = Arc::new(crate::frozen_request::FrozenReplay::new(
            inner,
            input,
            event_id,
            binding.clone(),
        ));
        *retry = Some(RetryPrompt::Frozen(frozen.clone()));
        Some(maka_agent_ports::model::RequestSource {
            cleanup: cleanup
                .as_ref()
                .expect("Main owns its materialization")
                .clone(),
            frozen,
        })
    } else {
        None
    };
    let mut writer = match AttemptWriter::new(
        AttemptBinding {
            invocation: input.invocation.clone(),
            step_id: step_id.clone(),
            purpose,
        },
        item_acceptance,
    ) {
        Ok(writer) => writer,
        Err(error) => {
            drop(prepared.request);
            close_materialization(&cleanup).await?;
            return Err(error.into());
        }
    };
    writer.fenced(sequence);
    let finalizer = inner.attempts.register(writer.snapshot(), item_acceptance);
    let result = match inner
        .shared
        .model
        .stream_with_source(
            prepared.request,
            cancellation.clone(),
            lane,
            binding,
            model_source,
        )
        .await
    {
        Ok(stream) => {
            receive(
                inner,
                writer,
                &finalizer,
                stream,
                tools
                    .filter(|_| item_acceptance)
                    .map(|tools| tools.clone().into_step(&step_id)),
                progressed,
                cancellation,
                retry,
                tools.filter(|_| !item_acceptance),
            )
            .await
        }
        Err(error) => {
            close_materialization(&cleanup).await?;
            finish(
                inner,
                writer,
                &finalizer,
                Err(error.into()),
                cancellation,
                None,
                retry,
            )
            .await
        }
    };
    let result = match result {
        Err(error) if !finalizer.has_publication() => {
            Err(seal_finalizer(inner, &finalizer, error).await)
        }
        other => other,
    };
    if finalizer.terminal_confirmed() {
        if result.is_err() {
            *confirmed_failure = finalizer.confirmed_event_id();
        }
        inner.attempts.remove(&step_id);
    }
    result
}

async fn close_materialization(
    cleanup: &Option<Arc<dyn maka_capabilities::http::UploadCleanup>>,
) -> Result<(), RunError> {
    if let Some(cleanup) = cleanup {
        cleanup
            .close()
            .await
            .map_err(|error| crate::cleanup::preparation_failed(std::io::Error::other(error)))?;
    }
    Ok(())
}

async fn commit_retry_request(
    inner: &RunContext,
    write: &maka_agent_facts::event::EventWrite,
) -> Result<u64, RunError> {
    use maka_agent_facts::event::CommitError;
    let mut changes = inner
        .log
        .subscribe_session_commits(&write.event().invocation.session_id)?;
    let mut uncertain = false;
    loop {
        if uncertain {
            match inner.log.confirm_model_retry_request(write).await {
                Ok(Some(sequence)) => return Ok(sequence),
                Ok(None) => {}
                Err(_) => {
                    if changes.changed().await.is_err() {
                        std::future::pending::<()>().await;
                    }
                    continue;
                }
            }
        }
        match inner.log.append(write).await {
            Ok(sequence) => return Ok(sequence),
            Err(CommitError::OutcomeUnknown(_)) => uncertain = true,
            Err(error) => return Err(error.into()),
        }
    }
}

pub(super) async fn prepare_wire(
    input: &RunSettings,
    prompt: &mut PreparedPrompt,
    definitions: &[Arc<ToolDefinition>],
    max_output_tokens: Option<u64>,
    cancellation: &CancellationToken,
) -> Result<(), RunError> {
    prepare_wire_with_settings(
        &PromptSettings::from_input(input),
        prompt,
        definitions,
        max_output_tokens,
        cancellation,
    )
    .await
}

pub(super) async fn prepare_wire_with_settings(
    settings: &PromptSettings<'_>,
    prompt: &mut PreparedPrompt,
    definitions: &[Arc<ToolDefinition>],
    max_output_tokens: Option<u64>,
    cancellation: &CancellationToken,
) -> Result<(), RunError> {
    prompt
        .compile_wire(
            settings.language,
            settings.provider,
            settings.options,
            definitions,
            cancellation,
        )
        .await?;
    prompt
        .fit_image_request(
            settings.language,
            settings.provider,
            settings.options,
            definitions,
            max_output_tokens,
            cancellation,
        )
        .await?;
    Ok(())
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
    definitions: Vec<Arc<ToolDefinition>>,
    max_output_tokens: Option<u64>,
    purpose: ModelPurpose,
) -> Result<PreparedRequest, RunError> {
    prepare_request_with_settings(
        &PromptSettings::from_input(input),
        prompt,
        definitions,
        max_output_tokens,
        purpose,
    )
}

pub(super) fn prepare_request_with_settings(
    settings: &PromptSettings<'_>,
    prompt: PreparedPrompt,
    definitions: Vec<Arc<ToolDefinition>>,
    max_output_tokens: Option<u64>,
    purpose: ModelPurpose,
) -> Result<PreparedRequest, RunError> {
    let prompt = prompt.model();
    let format = match settings.provider.kind {
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
        settings.context_window,
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
        tools: &'a [Arc<ToolDefinition>],
        provider_options: &'a serde_json::Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        max_output_tokens: Option<u64>,
    }
    let route_identity = digest(settings.provider)?;
    let input_digest = digest(&Evidence {
        projection: "maka.model-history.v1",
        language: settings.language,
        prompt_root: prompt.identity(),
        wire_codec: &wire.codec,
        wire_root: &wire.identity,
        route_identity: &route_identity,
        tools: &definitions,
        provider_options: settings.options,
        max_output_tokens,
    })?;
    Ok(PreparedRequest {
        context_breakdown,
        request: ModelRequest {
            language: settings.language,
            provider: settings.provider.clone(),
            prompt,
            tools: definitions,
            provider_options: settings.options.clone(),
            max_output_tokens,
        },
        input_digest,
        route_identity,
    })
}

#[allow(clippy::too_many_arguments)]
async fn receive(
    inner: &Arc<RunContext>,
    writer: AttemptWriter,
    finalizer: &crate::preview::Finalizer,
    stream: maka_model::ModelStream,
    tools: Option<maka_tools::StepTools<'_>>,
    progressed: &mut bool,
    cancellation: &CancellationToken,
    retry: &mut Option<RetryPrompt>,
    completion_tools: Option<&maka_tools::RequestTools<'_>>,
) -> Result<AttemptOutput, RunError> {
    receive_with_confirmation(
        inner,
        writer,
        finalizer,
        stream,
        tools,
        progressed,
        cancellation,
        retry,
        completion_tools,
        |writes| async move { inner.log.append_batch(&writes).await },
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn receive_with_confirmation<F, Fut>(
    inner: &Arc<RunContext>,
    mut writer: AttemptWriter,
    finalizer: &crate::preview::Finalizer,
    mut stream: maka_model::ModelStream,
    mut tools: Option<maka_tools::StepTools<'_>>,
    progressed: &mut bool,
    cancellation: &CancellationToken,
    retry: &mut Option<RetryPrompt>,
    completion_tools: Option<&maka_tools::RequestTools<'_>>,
    confirm: F,
) -> Result<AttemptOutput, RunError>
where
    F: FnOnce(Arc<[maka_agent_facts::event::EventWrite]>) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<u64>, maka_agent_facts::event::CommitError>>,
{
    use futures_util::{FutureExt, StreamExt, stream::FuturesUnordered};
    let tool_cancellation = cancellation.child_token();
    let mut running = FuturesUnordered::new();
    let mut approvals = FuturesUnordered::new();
    let mut preparing = FuturesUnordered::new();
    let mut retired_prompt = None;
    let binding = finalizer.snapshot().binding.clone();
    let result: Result<_, RunError> = async {
        loop {
            tokio::select! {
                biased;
                result = running.next(), if !running.is_empty() => { tool_result(result.unwrap())?; }
                execution = approvals.next(), if !approvals.is_empty() => {
                    running.push(catch_tool(execution.expect("nonempty approval set")).boxed());
                }
                prepared = preparing.next(), if !preparing.is_empty() => {
                    let prepared: maka_tools::PreparedCall<'_> = prepared.expect("nonempty preparation set")?;
                    let (published, execution) = publish_while_executing(prepared, &[], &mut running, &mut preparing, &mut approvals, &tool_cancellation).await?;
                    install_call(published, &mut running, &mut approvals);
                    execution?;
                }
                event = stream.next() => {
                    let Some(event) = event else { break; };
                    let observations = ready_observations(&mut writer, event, || {
                        stream.next().now_or_never().flatten()
                    });
                    use maka_agent_facts::event::{EventWrite, RuntimeEvent};
                    let writes = observations.events.iter().map(|event| {
                        EventWrite::plain(RuntimeEvent::new(binding.invocation.clone(), Fact::ModelObserved {
                            step_id: binding.step_id.clone(), event: event.clone(),
                        }))
                    }).collect::<Result<Vec<_>, _>>()?;
                    let writes: Arc<[EventWrite]> = writes.into();
                    let latest = writer.snapshot();
                    inner.attempts.publish(finalizer, latest.clone());
                    if !writes.is_empty() {
                        finalizer.freeze_prefix(latest, writes.clone());
                    }
                    // Admit the complete batch in arrival order before polling preparation.
                    for event in &observations.events {
                        if let ModelObservation::Part(record) = event
                            && let ModelPart::ToolCall { call } = record.part.as_ref()
                            && !call.provider_executed
                            && let Some(tools) = tools.as_mut()
                        {
                            preparing.push(catch_tool(tools.prepare(call.clone(), tool_cancellation.clone())).boxed());
                        }
                    }
                    // One natural poll: a pending preparation never holds back model facts.
                    let prepared = if preparing.is_empty() {
                        None
                    } else {
                        preparing.next().now_or_never().flatten()
                    };
                    if let Some(prepared) = prepared {
                        let prepared = prepared?;
                        let (published, execution) = publish_while_executing(prepared, &writes, &mut running, &mut preparing, &mut approvals, &tool_cancellation).await?;
                        record_prefix(&mut writer, &writes, &published.prefix_sequences);
                        if !writes.is_empty() {
                            finalizer.receipt_prefix(&writes, writer.snapshot());
                        }
                        inner.attempts.publish(finalizer, writer.snapshot());
                        // The receipt authorizes completion even when the ready model tail failed.
                        install_call(published, &mut running, &mut approvals);
                        execution?;
                    } else if !writes.is_empty() {
                        let (sequences, execution) = wait_while_executing(inner.log.append_batch(&writes), &mut running, &mut preparing, &mut approvals, &tool_cancellation).await;
                        let sequences = match sequences {
                            Ok(sequences) => sequences,
                            Err(error) => return merge_execution(Err(error.into()), execution),
                        };
                        record_prefix(&mut writer, &writes, &sequences);
                        finalizer.receipt_prefix(&writes, writer.snapshot());
                        inner.attempts.publish(finalizer, writer.snapshot());
                        execution?;
                    }
                    drop(observations.reservations);
                    let accepted_item = observations.events.iter().any(|event| matches!(event, ModelObservation::Part(_)));
                    if tools.is_some() && accepted_item {
                        *progressed = true;
                        if retired_prompt.is_none() {
                            retired_prompt = retry.take();
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
    let mut result = result;
    if matches!(&result, Err(error) if !matches!(error, RunError::Model(_)) || error.is_cleanup_unconfirmed())
    {
        tool_cancellation.cancel();
    }
    let (stream_cleanup, execution) = wait_while_executing(
        stream.cancel_and_wait(),
        &mut running,
        &mut preparing,
        &mut approvals,
        &tool_cancellation,
    )
    .await;
    result = merge_execution(result, execution);
    if finalizer.prefix().is_some()
        || matches!(&result, Err(error) if !matches!(error, RunError::Model(_)) || error.is_cleanup_unconfirmed())
    {
        // An uncertain publication must never be repeated as another T1.
        preparing.clear();
    }
    let result = if stream_cleanup.is_err() {
        tool_cancellation.cancel();
        preparing.clear();
        // The original transport may still read its backing; do not close it.
        if retired_prompt.is_some() {
            assert!(
                retry.is_none(),
                "accepted progress already retired the retry prompt"
            );
            *retry = retired_prompt.take();
        }
        additional_failure(result, crate::cleanup::unconfirmed())
    } else {
        result
    };
    let (confirmed, execution) = wait_while_executing(
        confirm_prefix(finalizer, confirm),
        &mut running,
        &mut preparing,
        &mut approvals,
        &tool_cancellation,
    )
    .await;
    let confirmation = match confirmed {
        Ok(Some(cut)) => {
            inner.attempts.publish(finalizer, cut);
            Ok(())
        }
        Ok(None) => Ok(()),
        Err(error) => Err(
            maka_agent_facts::tools::ToolError::CleanupUnconfirmed(format!(
                "model prefix could not be confirmed: {error}"
            ))
            .into(),
        ),
    };
    if execution.is_err() {
        preparing.clear();
    }
    let result = merge_execution(result, execution);
    let mut result = match confirmation {
        Ok(()) => {
            let (mut finished, execution) = wait_while_executing(
                finish(
                    inner,
                    writer,
                    finalizer,
                    result,
                    cancellation,
                    completion_tools,
                    retry,
                ),
                &mut running,
                &mut preparing,
                &mut approvals,
                &tool_cancellation,
            )
            .await;
            if let Ok(AttemptOutput::Main(response)) = &mut finished {
                approvals.extend(std::mem::take(&mut response.approvals));
            }
            if execution.is_err() {
                preparing.clear();
            }
            merge_execution(finished, execution)
        }
        Err(error) => {
            drop(writer);
            match result {
                Ok(()) => Err(error),
                Err(original) => additional_failure(Err(original), error),
            }
        }
    };
    if finalizer.terminal_confirmed() {
        inner.attempts.remove(&binding.step_id);
        let (closed, execution) = wait_while_executing(
            close_retry(&mut retired_prompt),
            &mut running,
            &mut preparing,
            &mut approvals,
            &tool_cancellation,
        )
        .await;
        if execution.is_err() {
            preparing.clear();
        }
        if let Err(error) = merge_execution(closed, execution) {
            result = additional_failure(result, error);
        }
    }
    let mut cleanup = Ok(());
    if matches!(&result, Err(error) if !matches!(error, RunError::Model(_)) || error.is_cleanup_unconfirmed())
    {
        tool_cancellation.cancel();
    }
    while !preparing.is_empty() || !running.is_empty() || (result.is_err() && !approvals.is_empty())
    {
        tokio::select! {
            execution = approvals.next(), if !approvals.is_empty() => {
                running.push(catch_tool(execution.expect("nonempty approval set")).boxed());
            }
            prepared = preparing.next(), if !preparing.is_empty() => {
                let published = match prepared.expect("nonempty preparation set") {
                    Ok(prepared) => publish_while_executing(prepared, &[], &mut running, &mut preparing, &mut approvals, &tool_cancellation).await,
                    Err(error) => Err(error.into()),
                };
                match published {
                    Ok((published, execution)) => {
                        install_call(published, &mut running, &mut approvals);
                        if let Err(error) = execution {
                            tool_cancellation.cancel();
                            preparing.clear();
                            cleanup = additional_failure(cleanup, error);
                        }
                    },
                    Err(error) => {
                        tool_cancellation.cancel();
                        preparing.clear();
                        if cleanup.is_ok() { cleanup = Err(error); }
                    }
                }
            }
            result = running.next(), if !running.is_empty() => {
                if let Err(error) = tool_result(result.expect("nonempty completion set")) {
                    tool_cancellation.cancel();
                    preparing.clear();
                    if cleanup.is_ok() { cleanup = Err(error); }
                }
            }
        }
    }
    let (closed, execution) = wait_while_executing(
        close_retry(&mut retired_prompt),
        &mut running,
        &mut preparing,
        &mut approvals,
        &tool_cancellation,
    )
    .await;
    if execution.is_err() {
        preparing.clear();
    }
    if let Err(error) = merge_execution(closed, execution) {
        result = additional_failure(result, error);
    }
    if let Err(error) = cleanup {
        result = additional_failure(result, error);
    }
    if matches!(&result, Err(error) if !matches!(error, RunError::Model(_)) || error.is_cleanup_unconfirmed())
    {
        tool_cancellation.cancel();
    }
    while !running.is_empty() || (result.is_err() && !approvals.is_empty()) {
        tokio::select! {
            ready = approvals.next(), if !approvals.is_empty() => {
                running.push(catch_tool(ready.expect("nonempty approval set")).boxed());
            }
            settled = running.next(), if !running.is_empty() => {
                if let Err(error) = tool_result(settled.expect("nonempty completion set")) {
                    tool_cancellation.cancel();
                    result = additional_failure(result, error);
                }
            }
        }
    }
    if let Ok(AttemptOutput::Main(response)) = &mut result {
        response.approvals.extend(approvals);
    }
    result
}

type RunningCalls<'a> = futures_util::stream::FuturesUnordered<
    futures_util::future::BoxFuture<
        'a,
        Result<serde_json::Value, maka_agent_facts::tools::ToolError>,
    >,
>;
type PreparingCalls<'a> = futures_util::stream::FuturesUnordered<
    futures_util::future::BoxFuture<
        'a,
        Result<maka_tools::PreparedCall<'a>, maka_agent_facts::tools::ToolError>,
    >,
>;

async fn wait_while_executing<'a, F: std::future::Future>(
    future: F,
    running: &mut RunningCalls<'a>,
    preparing: &mut PreparingCalls<'a>,
    approvals: &mut futures_util::stream::FuturesUnordered<maka_tools::PendingCall>,
    cancellation: &CancellationToken,
) -> (F::Output, Result<(), RunError>) {
    use futures_util::{FutureExt, StreamExt};
    // A suspended sibling can already own a granted fair permit. Keep its
    // original future polled without abandoning the operation being awaited.
    tokio::pin!(future);
    let mut execution = Ok(());
    let mut ready = Vec::new();
    loop {
        tokio::select! {
            output = &mut future => {
                // Preparation may finish, but only the writer publishes it
                // after the original operation and its receipt have settled.
                preparing.extend(ready.into_iter().map(|prepared| futures_util::future::ready(prepared).boxed()));
                return (output, execution);
            },
            prepared = preparing.next(), if !preparing.is_empty() => {
                ready.push(prepared.expect("nonempty preparation set"));
            }
            ready = approvals.next(), if !approvals.is_empty() => {
                running.push(catch_tool(ready.expect("nonempty approval set")).boxed());
            }
            result = running.next(), if !running.is_empty() => {
                if let Err(error) = tool_result(result.expect("nonempty completion set")) {
                    cancellation.cancel();
                    execution = additional_failure(execution, error);
                }
            }
        }
    }
}

fn merge_execution<T>(
    result: Result<T, RunError>,
    execution: Result<(), RunError>,
) -> Result<T, RunError> {
    match execution {
        Ok(()) => result,
        Err(error) => additional_failure(result, error),
    }
}

async fn publish_while_executing<'a>(
    prepared: maka_tools::PreparedCall<'a>,
    prefix: &[maka_agent_facts::event::EventWrite],
    running: &mut RunningCalls<'a>,
    preparing: &mut PreparingCalls<'a>,
    approvals: &mut futures_util::stream::FuturesUnordered<maka_tools::PendingCall>,
    cancellation: &CancellationToken,
) -> Result<(maka_tools::PublishedCall, Result<(), RunError>), RunError> {
    let (published, execution) = wait_while_executing(
        catch_tool(prepared.publish(prefix)),
        running,
        preparing,
        approvals,
        cancellation,
    )
    .await;
    match published {
        Ok(published) => Ok((published, execution)),
        Err(error) => match execution {
            Ok(()) => Err(error.into()),
            Err(original) => additional_failure(Err(original), error.into()),
        },
    }
}

fn install_call<'a>(
    published: maka_tools::PublishedCall,
    running: &mut RunningCalls<'a>,
    approvals: &mut futures_util::stream::FuturesUnordered<maka_tools::PendingCall>,
) {
    use futures_util::FutureExt;
    match published.completion {
        maka_tools::CallContinuation::Executing(execution) => {
            running.push(catch_tool(execution).boxed())
        }
        maka_tools::CallContinuation::Approval(approval) => approvals.push(approval),
    }
}

pub(super) async fn catch_tool<T>(
    future: impl std::future::Future<Output = Result<T, maka_agent_facts::tools::ToolError>>,
) -> Result<T, maka_agent_facts::tools::ToolError> {
    use futures_util::FutureExt;
    std::panic::AssertUnwindSafe(future)
        .catch_unwind()
        .await
        .unwrap_or_else(|_| {
            Err(maka_agent_facts::tools::ToolError::CleanupUnconfirmed(
                "tool panicked".into(),
            ))
        })
}

fn record_prefix(
    writer: &mut AttemptWriter,
    writes: &[maka_agent_facts::event::EventWrite],
    sequences: &[u64],
) {
    for (write, &sequence) in writes.iter().zip(sequences) {
        if let Fact::ModelObserved {
            event: ModelObservation::Part(part),
            ..
        } = &write.event().fact
        {
            writer.recorded(PartReceipt {
                part: RecordedPartRef {
                    event_id: write.event().id.clone(),
                    ordinal: part.ordinal,
                },
                sequence,
            });
        } else {
            writer.fenced(sequence);
        }
    }
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

pub(super) fn tool_result(
    result: Result<serde_json::Value, maka_agent_facts::tools::ToolError>,
) -> Result<(), RunError> {
    use maka_agent_facts::tools::ToolError;
    match result {
        Ok(_)
        | Err(
            ToolError::Failed(_)
            | ToolError::Native(_)
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
    retry: &mut Option<RetryPrompt>,
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
            drop(writer);
            return Err(seal_finalizer(inner, finalizer, error).await);
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
                match inner.log.append(&publication).await {
                    Ok(sequence) => {
                        finalizer.receipt_terminal(&publication, sequence);
                        inner.attempts.remove(&output.binding.step_id);
                    }
                    Err(seal) => return Err(seal_failure(error, seal)),
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
    let step_id = output.binding.step_id.clone();
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
        let sequences = inner.log.append_batch(&writes).await?;
        finalizer.receipt_terminal(&completion, sequences[0]);
        inner.attempts.remove(&step_id);
    }
    if incomplete {
        return Err(RunError::ModelIncomplete);
    }
    if cancellation.is_cancelled() && !defer_completion {
        return Err(RunError::Cancelled);
    }
    if let Some(summary) = summary {
        return Ok(AttemptOutput::Summary {
            step_id,
            summary: Ok(summary),
        });
    }
    let mut response = MainResponse {
        local_call_ids: output.local_call_ids(),
        response_id: output.response_id.clone(),
        approvals: futures_util::stream::FuturesUnordered::new(),
    };
    if let Some(tools) = completion_tools {
        use futures_util::{FutureExt, StreamExt, stream::FuturesUnordered};
        let mut step = tools.clone().into_step(&step_id);
        let tool_cancellation = cancellation.child_token();
        let mut preparing = FuturesUnordered::new();
        let mut running = FuturesUnordered::new();
        let mut approvals = FuturesUnordered::new();
        // Admit every call in arrival order before polling any preparation.
        for record in output.parts() {
            if let ModelPart::ToolCall { call } = record.part.as_ref()
                && !call.provider_executed
            {
                preparing.push(
                    catch_tool(step.prepare(call.clone(), tool_cancellation.clone())).boxed(),
                );
            }
        }
        drop(output);
        let mut cleanup = Ok(());
        if defer_completion {
            // Only this writer owns the terminal prefix; pending siblings retain no body.
            let prepared = preparing.next().now_or_never().flatten();
            let sequence = match prepared {
                Some(Ok(prepared)) => {
                    let (published, execution) = publish_while_executing(
                        prepared,
                        &writes,
                        &mut running,
                        &mut preparing,
                        &mut approvals,
                        &tool_cancellation,
                    )
                    .await?;
                    let sequence = published.prefix_sequences[0];
                    install_call(published, &mut running, &mut approvals);
                    cleanup = merge_execution(cleanup, execution);
                    sequence
                }
                Some(Err(error)) => {
                    tool_cancellation.cancel();
                    preparing.clear();
                    let sequences = match inner.log.append_batch(&writes).await {
                        Ok(sequences) => sequences,
                        Err(flush) => return Err(seal_failure(error.into(), flush)),
                    };
                    cleanup = Err(error.into());
                    sequences[0]
                }
                None => inner.log.append_batch(&writes).await?[0],
            };
            finalizer.receipt_terminal(&completion, sequence);
            inner.attempts.remove(&step_id);
        }
        drop(writes);
        drop(completion);
        let (closed, execution) = wait_while_executing(
            close_retry(retry),
            &mut running,
            &mut preparing,
            &mut approvals,
            &tool_cancellation,
        )
        .await;
        if let Err(error) = merge_execution(closed, execution) {
            tool_cancellation.cancel();
            preparing.clear();
            cleanup = additional_failure(cleanup, error);
        }
        while !preparing.is_empty()
            || !running.is_empty()
            || (cleanup.is_err() && !approvals.is_empty())
        {
            tokio::select! {
                execution = approvals.next(), if !approvals.is_empty() => {
                    running.push(catch_tool(execution.expect("nonempty approval set")).boxed());
                }
                prepared = preparing.next(), if !preparing.is_empty() => {
                    let published = match prepared.expect("nonempty preparation set") {
                        Ok(prepared) => publish_while_executing(prepared, &[], &mut running, &mut preparing, &mut approvals, &tool_cancellation).await,
                        Err(error) => Err(error.into()),
                    };
                    match published {
                        Ok((published, execution)) => {
                            install_call(published, &mut running, &mut approvals);
                            if let Err(error) = execution {
                                tool_cancellation.cancel();
                                preparing.clear();
                                cleanup = additional_failure(cleanup, error);
                            }
                        },
                        Err(error) => {
                            tool_cancellation.cancel();
                            preparing.clear();
                            if cleanup.is_ok() { cleanup = Err(error); }
                        }
                    }
                }
                result = running.next(), if !running.is_empty() => {
                    if let Err(error) = tool_result(result.expect("nonempty completion set")) {
                        tool_cancellation.cancel();
                        preparing.clear();
                        if cleanup.is_ok() { cleanup = Err(error); }
                    }
                }
            }
        }
        cleanup?;
        response.approvals = approvals;
    } else {
        drop(output);
        drop(writes);
        drop(completion);
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
            if failure.retryable()
                && (failure.replay_safe()
                    || (item_acceptance && failure.retained_output_safe())) =>
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

async fn confirm_prefix<F, Fut>(
    finalizer: &crate::preview::Finalizer,
    append: F,
) -> Result<
    Option<Arc<maka_agent_facts::model::assembly::AttemptCut>>,
    maka_agent_facts::event::CommitError,
>
where
    F: FnOnce(Arc<[maka_agent_facts::event::EventWrite]>) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<u64>, maka_agent_facts::event::CommitError>>,
{
    let Some((cut, writes)) = finalizer.prefix() else {
        return Ok(None);
    };
    let sequences = append(writes.clone()).await?;
    let cut = Arc::new(cut.with_prefix_receipts(&writes, &sequences));
    finalizer.receipt_prefix(&writes, cut.clone());
    Ok(Some(cut))
}

async fn seal_finalizer(
    inner: &RunContext,
    finalizer: &crate::preview::Finalizer,
    error: RunError,
) -> RunError {
    seal_finalizer_with(inner, finalizer, error, |writes| async move {
        inner.log.append_batch(&writes).await
    })
    .await
}

async fn seal_finalizer_with<F, Fut>(
    inner: &RunContext,
    finalizer: &crate::preview::Finalizer,
    error: RunError,
    append: F,
) -> RunError
where
    F: FnOnce(Arc<[maka_agent_facts::event::EventWrite]>) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<u64>, maka_agent_facts::event::CommitError>>,
{
    if finalizer.terminal_confirmed() {
        return error;
    }
    match confirm_prefix(finalizer, append).await {
        Ok(Some(cut)) => inner.attempts.publish(finalizer, cut),
        Ok(None) => {}
        Err(seal) => {
            return maka_agent_facts::tools::ToolError::CleanupUnconfirmed(format!(
                "{error}; model prefix could not be confirmed: {seal}"
            ))
            .into();
        }
    }
    let Some(cut) = finalizer.unconfirmed_snapshot() else {
        return error;
    };
    let publication = match finalizer.publication() {
        Some(publication) => Ok(publication),
        None => interruption(&cut, &error, finalizer.item_acceptance),
    };
    match publication {
        Ok(publication) => {
            let publication = match finalizer.prepare(publication) {
                crate::preview::PublicationSelection::New(publication)
                | crate::preview::PublicationSelection::Existing(publication) => publication,
                crate::preview::PublicationSelection::Confirmed => return error,
                crate::preview::PublicationSelection::PrefixPending => {
                    return crate::cleanup::unconfirmed();
                }
            };
            match inner.log.append(&publication).await {
                Ok(sequence) => {
                    finalizer.receipt_terminal(&publication, sequence);
                    error
                }
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
        let binding = finalizer.binding();
        error = seal_finalizer(inner, &finalizer, error).await;
        if finalizer.terminal_confirmed() {
            inner.attempts.remove(&binding.step_id);
        }
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

#[cfg(test)]
mod publication_tests;

#[cfg(test)]
mod retry_timing_tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn retry_decision_preserves_budget_phase_and_rejects_overflow() {
        use maka_agent_facts::model::retry_transport::RetryTransportPhase;
        let failure = maka_model::ProviderFailure::new(
            maka_model::ProviderFailureReason::RateLimit,
            "wait",
            true,
            Some(18_001_000),
        );
        let plan = retry_plan(
            "terminal".into(),
            &failure,
            Duration::from_millis(200),
            1000,
            7,
            RetryTransportPhase::Fallback,
        )
        .unwrap();
        assert_eq!(plan.failure_event_id, "terminal");
        assert_eq!(plan.not_before_unix_ms, 18_001_000);
        assert_eq!(plan.failures, 7);
        assert_eq!(plan.transport_phase, RetryTransportPhase::Fallback);
        assert!(plan.not_before_unix_ms - 1000 > ordinary_retry_horizon_ms());
        assert!(
            retry_plan(
                "terminal".into(),
                &failure,
                Duration::from_millis(200),
                u64::MAX - 1,
                7,
                RetryTransportPhase::Fallback
            )
            .is_err()
        );
    }

    #[tokio::test(start_paused = true)]
    async fn ordinary_backoff_finishes_after_elapsed_time_without_waiting_for_wall_clock() {
        let failure = maka_model::ProviderFailure::new(
            maka_model::ProviderFailureReason::Network,
            "transport unavailable",
            true,
            None,
        );
        let plan = retry_plan(
            "failure".into(),
            &failure,
            Duration::from_secs(60),
            retry_now().unwrap(),
            1,
            maka_agent_facts::model::retry_transport::RetryTransportPhase::Primary,
        )
        .unwrap();
        let wait = wait_retry_plan(&plan, RetryClock::Monotonic);
        tokio::pin!(wait);
        assert!(futures_util::poll!(&mut wait).is_pending());
        tokio::time::advance(Duration::from_secs(60)).await;
        assert!(matches!(
            futures_util::poll!(&mut wait),
            std::task::Poll::Ready(Ok(()))
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn provider_deadline_still_waits_for_wall_clock_after_monotonic_wakeup() {
        let plan = maka_agent_facts::model_retry::RetryPlan {
            failure_event_id: "failure".into(),
            not_before_unix_ms: retry_now().unwrap() + 3_600_000,
            failures: 1,
            transport_phase: maka_agent_facts::model::retry_transport::RetryTransportPhase::Primary,
        };
        let wait = wait_retry_plan(&plan, RetryClock::ProviderDeadline);
        tokio::pin!(wait);
        assert!(futures_util::poll!(&mut wait).is_pending());
        tokio::time::advance(Duration::from_secs(3600)).await;
        assert!(futures_util::poll!(&mut wait).is_pending());
    }

    #[tokio::test(start_paused = true)]
    async fn provider_deadline_is_a_lower_bound_and_never_reduces_backoff() {
        let failure = maka_model::ProviderFailure::new(
            maka_model::ProviderFailureReason::RateLimit,
            "temporary throttle",
            true,
            Some(18_001_000),
        );
        let phase = maka_agent_facts::model::retry_transport::RetryTransportPhase::Primary;
        let plan = retry_plan(
            "failure".into(),
            &failure,
            Duration::from_millis(200),
            1000,
            1,
            phase,
        )
        .unwrap();
        let delay = Duration::from_millis(plan.not_before_unix_ms - 1000);
        assert_eq!(delay, Duration::from_secs(18_000));
        let sleep = wait_retry(delay);
        tokio::pin!(sleep);
        assert!(futures_util::poll!(&mut sleep).is_pending());
        tokio::time::advance(Duration::from_secs(17_999)).await;
        assert!(futures_util::poll!(&mut sleep).is_pending());
        tokio::time::advance(Duration::from_secs(1)).await;
        sleep.await;
        assert_eq!(
            retry_plan(
                "failure".into(),
                &failure,
                Duration::from_millis(200),
                18_000_999,
                1,
                phase
            )
            .unwrap()
            .not_before_unix_ms,
            18_001_199
        );
        assert_eq!(
            retry_plan(
                "failure".into(),
                &failure,
                Duration::from_millis(200),
                18_001_001,
                1,
                phase
            )
            .unwrap()
            .not_before_unix_ms,
            18_001_201
        );
    }
}
