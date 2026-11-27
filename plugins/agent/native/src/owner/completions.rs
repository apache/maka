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
use super::*;
use maka_agent_facts::{
    durable::{RunId, Terminal, UnixMillis},
    message::MessageOrigin,
};
use maka_agent_state::{
    NotificationAttention, NotificationState,
    queue::{MessageResolution, Placement as QueuePlacement},
};
use maka_event_log::root_store::completions::{Completion, RegisterCompletion};

/// The longest a delegated task waits for its caller to answer a question or approval.
const UNANSWERED_LIMIT: Duration = Duration::from_secs(30 * 60);

#[derive(Serialize, Deserialize)]
pub(super) struct CompletionRequest {
    source: maka_agent_facts::durable::ExecutionIdentity,
    #[serde(flatten)]
    backend: notifications::NotificationBackend,
    workspace: Workspace,
    binding: maka_sandbox::workspace::BindingStamp,
}
/// What the recipient of a finished run needs to decide its next step: the last
/// thing the worker said, and why the run failed when it did.
#[derive(Default)]
pub(super) struct RunResult {
    pub reply: Option<String>,
    pub failure: Option<String>,
}
impl RunResult {
    pub(super) fn inline(&self) -> String {
        let block = |tag: &str, body: &Option<String>| {
            body.as_deref()
                .map(|body| format!("\n\n<{tag}>\n{body}\n</{tag}>"))
                .unwrap_or_default()
        };
        block("worker_result", &self.reply) + block("failure_reason", &self.failure).as_str()
    }
}
fn excerpt(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut out: String = trimmed.chars().take(1600).collect();
    if trimmed.chars().count() > 1600 {
        out.push_str("\n… [truncated]");
    }
    Some(out)
}
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
enum NoticeBucket {
    Unavailable,
    CancelledMessage(String),
    FinishedRun(RunId),
    AttentionRun { run: RunId, cause: AttentionCause },
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
enum AttentionCause {
    Interaction(String),
    Authority(String),
}

impl From<&NotificationAttention> for AttentionCause {
    fn from(reason: &NotificationAttention) -> Self {
        match reason {
            NotificationAttention::Interaction { request } => Self::Interaction(request.clone()),
            NotificationAttention::Authority { blocker } => Self::Authority(blocker.to_string()),
        }
    }
}

enum Notice {
    Finished {
        /// `Some` once the watched message ran; `None` only if cancelled before starting a Run.
        run: Option<RunId>,
        terminal: Terminal,
    },
    Unavailable,
    Attention {
        run: RunId,
        cause: AttentionCause,
    },
}

impl Notice {
    /// Scoped per worker Run (rather than per `SessionSend` message) once a message has
    /// landed in a Run, so steering an active worker never fans out duplicate notifications.
    fn identity(&self, session_id: &str, message_id: &str) -> String {
        let key = match self {
            Self::Finished { run: Some(run), .. } => {
                format!("session-completion/{session_id}/{run}")
            }
            Self::Finished { run: None, .. } => {
                format!("session-completion/{session_id}/{message_id}")
            }
            Self::Unavailable => format!("session-completion/{session_id}/unavailable"),
            Self::Attention { run, cause } => {
                let cause = match cause {
                    AttentionCause::Interaction(request) => format!("interaction/{request}"),
                    AttentionCause::Authority(blocker) => format!("authority/{blocker}"),
                };
                format!("session-completion/{session_id}/{run}/{cause}")
            }
        };
        hex::encode(Sha256::digest(key.as_bytes()))[..32].to_owned()
    }

    fn message(
        &self,
        session_id: &str,
        message_id: &str,
        result: &RunResult,
        language: Language,
    ) -> String {
        let session_read = format!(
            "SessionRead({})",
            serde_json::json!({"sessionId": session_id})
        );
        let read_uri = format!(
            "Read({})",
            serde_json::json!({"path": format!("maka://session/{session_id}")})
        );
        let (status, inline_result) = match self {
            Self::Finished { terminal, .. } => (
                match terminal {
                    Terminal::Completed => "completed",
                    Terminal::Failed => "failed",
                    Terminal::Cancelled => "cancelled",
                },
                result.inline(),
            ),
            Self::Unavailable => ("unavailable", String::new()),
            Self::Attention { cause, .. } => {
                let status_only = format!(
                    "SessionRead({})",
                    serde_json::json!({"sessionId": session_id, "view": "status_only"})
                );
                let instruction = match cause {
                    AttentionCause::Interaction(request) => {
                        let respond = format!(
                            "SessionRespond({})",
                            serde_json::json!({"sessionId": session_id, "requestId": request})
                        );
                        format!("{status_only} / {respond}")
                    }
                    AttentionCause::Authority(blocker) => {
                        format!("{status_only} (blocker: {blocker})")
                    }
                };
                return maka_agent_facts::i18n::driver::delegated_task_needs_attention(
                    language,
                    &instruction,
                    message_id,
                );
            }
        };
        maka_agent_facts::i18n::driver::delegated_task_ended(
            language,
            &inline_result,
            message_id,
            &read_uri,
            &session_read,
            status,
        )
    }
}

struct EligibleWatch {
    entry: Completion,
    request: CompletionRequest,
    resolution: MessageResolution,
    placement: QueuePlacement,
    caller_live: bool,
}

/// Deterministic rescue identity derived from the retracted notice and the caller Run
/// whose Stop retracted it, so all surviving watches converge on one rescue notification
/// even across a crash mid-settlement.
fn rescue_identity(retracted_identity: &str, stopped_caller: RunId) -> String {
    let key = format!("session-completion-rescue/{retracted_identity}/{stopped_caller}");
    hex::encode(Sha256::digest(key.as_bytes()))[..32].to_owned()
}

enum ExistingDelivery {
    Absent,
    Reusable {
        request: maka_agent_state::queue::PreparedRequest,
        /// `Some(caller)` while pending on a live caller Run that can still be stopped and
        /// retract the notice; watches owned by other callers must remain until it settles.
        pending_live_caller: Option<RunId>,
        enqueued_at: Option<UnixMillis>,
    },
    RetractedByOtherCaller(RunId),
}

impl Owner {
    /// The result of a finished run: its last non-empty assistant message, and for
    /// a failed run the failures recorded after that message. Reads directly from
    /// the target run's canonical facts so later runs or tool bursts cannot roll it
    /// off a session-wide tail page.
    pub(super) async fn run_result(
        &self,
        session_id: &str,
        run: RunId,
        terminal: &Terminal,
        model_read: bool,
    ) -> RunResult {
        use maka_agent_facts::{
            context::ModelPurpose,
            durable::{ExternalTaskId, Fact, StepId},
            executor::Output,
            model::{ModelPart, TextKind},
        };
        let Ok(Some(view)) = self.session_run(session_id, run).await else {
            return RunResult::default();
        };
        let collect_failures = *terminal == Terminal::Failed;
        let history = self
            .durable
            .session_history(view.spec.owner.clone(), session_id.to_owned());
        let recovery_diagnostic =
            if collect_failures && model_read && view.recovery_failure().is_some() {
                match history.model_recovery_diagnostic(run).await {
                    Ok(reason) => reason,
                    Err(_) => return RunResult::default(),
                }
            } else if collect_failures {
                view.recovery_failure_diagnostic()
            } else {
                None
            };
        let mut reply: Option<String> = None;
        let mut external_reply: Option<(ExternalTaskId, String, Vec<String>)> = None;
        let mut external_has_content = false;
        let mut failures: Vec<String> = Vec::new();
        let mut step_purposes: std::collections::HashMap<StepId, ModelPurpose> =
            std::collections::HashMap::new();

        let push_failure = |failures: &mut Vec<String>, text: String| {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return;
            }
            if failures.last().is_some_and(|prev| prev == trimmed) {
                return;
            }
            failures.push(trimmed.to_owned());
        };

        let mut end = view.revision;
        'scan: while end > 0 {
            let start = end.saturating_sub(64);
            let Ok(page) = self.durable.history(run, start, (end - start) as u32).await else {
                break;
            };
            let spans = if model_read {
                let ids = page.iter().map(|record| record.id).collect();
                let Ok(spans) = history.fact_body_restrictions(ids).await else {
                    return RunResult::default();
                };
                spans
            } else {
                Default::default()
            };
            for (index, record) in page.into_iter().enumerate().rev() {
                let visible = |mut text: String| {
                    if let Some(spans) = spans.get(&index) {
                        maka_agent_state::memory::recall::mask(&mut text, 0, spans);
                    }
                    text
                };
                match record.fact {
                    Fact::ModelObserved {
                        attempt,
                        part:
                            ModelPart::Text {
                                text_kind: TextKind::Text,
                                text,
                                ..
                            },
                        ..
                    } => {
                        if external_reply.is_some() {
                            if external_has_content {
                                break 'scan;
                            }
                            external_reply = None;
                        }
                        if text.chunks().all(|chunk| chunk.trim().is_empty()) {
                            continue;
                        }
                        if let Some(step) = view.attempts.get(&attempt).map(|a| a.step) {
                            let purpose = match step_purposes.get(&step).copied() {
                                Some(purpose) => Some(purpose),
                                None => match self.durable.request(run, step).await {
                                    Ok(request) => {
                                        let p = request.accounting.purpose;
                                        step_purposes.insert(step, p);
                                        Some(p)
                                    }
                                    Err(_) => None,
                                },
                            };
                            if purpose == Some(ModelPurpose::Summary) {
                                continue;
                            }
                        }
                        reply = Some(visible(text.to_string()));
                        break 'scan;
                    }
                    Fact::ExternalTaskObserved {
                        task,
                        output: Output::OutputDelta { message_id, text },
                        ..
                    } => {
                        let text = visible(text);
                        match &mut external_reply {
                            Some((current_task, current_id, chunks))
                                if *current_task == task && *current_id == message_id =>
                            {
                                if !text.trim().is_empty() {
                                    external_has_content = true;
                                }
                                chunks.push(text);
                            }
                            Some(_) => {
                                if external_has_content {
                                    break 'scan;
                                }
                                external_has_content = !text.trim().is_empty();
                                external_reply = Some((task, message_id, vec![text]));
                            }
                            None => {
                                external_has_content = !text.trim().is_empty();
                                external_reply = Some((task, message_id, vec![text]));
                            }
                        }
                    }
                    Fact::RunTerminated {
                        terminal: Terminal::Failed,
                        diagnostic,
                    } if collect_failures && !external_has_content => {
                        if let Some(diag) = recovery_diagnostic
                            .clone()
                            .or_else(|| diagnostic.map(visible))
                        {
                            push_failure(&mut failures, diag);
                        }
                    }
                    Fact::ModelInterrupted { diagnostic, .. }
                        if collect_failures && !external_has_content =>
                    {
                        push_failure(&mut failures, visible(diagnostic));
                    }
                    Fact::ExternalTaskClosed {
                        outcome: Terminal::Failed,
                        diagnostic: Some(diagnostic),
                        ..
                    } if collect_failures && !external_has_content => {
                        push_failure(&mut failures, visible(diagnostic));
                    }
                    _ => {}
                }
            }
            end = start;
        }

        if reply.is_none()
            && let Some((_, _, mut chunks)) = external_reply
            && external_has_content
        {
            chunks.reverse();
            reply = Some(chunks.concat());
        }

        if collect_failures
            && failures.is_empty()
            && let Some(diag) = recovery_diagnostic
        {
            push_failure(&mut failures, diag);
        }

        failures.reverse();
        let mut deduped: Vec<String> = Vec::with_capacity(failures.len());
        for item in failures {
            if deduped.last().is_none_or(|prev| prev != &item) {
                deduped.push(item);
            }
        }

        RunResult {
            reply: reply.as_deref().and_then(excerpt),
            failure: excerpt(&deduped.join("\n")),
        }
    }

    pub(super) async fn completion_request(
        &self,
        scope: &maka_capabilities::call::Scope,
        target: &str,
        option: Option<OnComplete>,
    ) -> Result<Option<CompletionRequest>, String> {
        if option.is_none() {
            return Ok(None);
        }
        let source = scope
            .identity
            .agent()
            .ok_or("agent_completion_requires_agent_caller")?;
        if source.session_id == target {
            return Err("agent_completion_requires_other_session".into());
        }
        let route = self.return_route(source).await?;
        Ok(Some(CompletionRequest {
            source: source.clone(),
            backend: route.backend,
            workspace: route.workspace,
            binding: route.binding,
        }))
    }
    pub(super) fn completion_statement(
        &self,
        session: &str,
        message: &str,
        request: CompletionRequest,
    ) -> Result<RegisterCompletion, String> {
        Ok(RegisterCompletion {
            owner: self.prefix.clone(),
            session: session.into(),
            message: message.into(),
            recipient: request.source.session_id.clone(),
            request: serde_json::to_value(request).map_err(|e| e.to_string())?,
        })
    }
    pub(super) async fn retire_caller_completions(&self, recipient: &str) -> Result<(), String> {
        let mut after = None;
        loop {
            let entries = self
                .store
                .message_completions(&self.prefix, after.as_deref())
                .await
                .map_err(|error| error.to_string())?;
            if entries.is_empty() {
                return Ok(());
            }
            for entry in entries {
                after = Some(entry.key.clone());
                if entry.recipient == recipient {
                    self.retire_completion(&entry).await?;
                }
            }
        }
    }
    pub(super) fn start_completion_notifications(self: &Arc<Self>) {
        let owner = self.clone();
        self.background(move |stop| async move {
            let mut changes = owner.store.subscribe_changes();
            loop {
                if stop.is_cancelled() {
                    return;
                }
                let Some(producer) = owner.producer().await else {
                    return;
                };
                if let Err(error) = owner.deliver_completions().await {
                    tracing::warn!(%error, "Session completion notification deferred");
                }
                drop(producer);
                tokio::select! {
                    () = stop.cancelled() => return,
                    () = tokio::time::sleep(Duration::from_secs(2)) => {},
                    result = changes.changed() => if result.is_err() { return; },
                }
                tokio::select! {
                    () = stop.cancelled() => return,
                    () = tokio::time::sleep(Duration::from_millis(250)) => {},
                }
                changes.borrow_and_update();
            }
        });
    }
    pub(super) async fn deliver_completions(self: &Arc<Self>) -> Result<(), String> {
        self.deliver_completions_at(now()).await
    }
    /// `now` decides which unanswered requests have passed the limit.
    pub(super) async fn deliver_completions_at(self: &Arc<Self>, now: u64) -> Result<(), String> {
        let mut after = None;
        let mut carry: Vec<Completion> = Vec::new();
        loop {
            let entries = self
                .store
                .message_completions(&self.prefix, after.as_deref())
                .await
                .map_err(|e| e.to_string())?;
            let eof = entries.is_empty();
            if let Some(last) = entries.last() {
                after = Some(last.key.clone());
            }
            carry.extend(entries);
            if carry.is_empty() {
                return Ok(());
            }
            // Watches for the same (worker, recipient) are contiguous in key order; hold the
            // trailing pair until the next page confirms it is complete so pagination never
            // splits a steered Run's watches across batches.
            let split = if eof {
                carry.len()
            } else {
                let last_pair = (
                    carry.last().unwrap().session_id.as_str(),
                    carry.last().unwrap().recipient.as_str(),
                );
                carry
                    .iter()
                    .rposition(|e| (e.session_id.as_str(), e.recipient.as_str()) != last_pair)
                    .map_or(0, |idx| idx + 1)
            };
            if split == 0 {
                continue;
            }
            let batch: Vec<Completion> = carry.drain(..split).collect();
            self.deliver_completion_batch(batch, now).await?;
            if eof {
                return Ok(());
            }
        }
    }

    async fn deliver_completion_batch(
        self: &Arc<Self>,
        entries: Vec<Completion>,
        now: u64,
    ) -> Result<(), String> {
        let mut groups: BTreeMap<
            (String, String),
            Vec<(Completion, CompletionRequest, MessageResolution)>,
        > = BTreeMap::new();
        let mut runs = BTreeSet::new();
        for entry in entries {
            let prepare = async {
                let request = CompletionRequest::deserialize(&entry.request)
                    .map_err(|error| error.to_string())?;
                let resolution = self
                    .durable
                    .queue()
                    .resolve_message(entry.session_id.clone(), entry.message_id.clone())
                    .await
                    .map_err(|error| error.to_string())?;
                Ok::<_, String>((request, resolution))
            }
            .await;
            match prepare {
                Ok((request, resolution)) => {
                    runs.insert(request.source.run_id);
                    if let MessageResolution::Delivered { run, .. } = &resolution {
                        runs.insert(*run);
                    }
                    groups
                        .entry((entry.session_id.clone(), entry.recipient.clone()))
                        .or_default()
                        .push((entry, request, resolution));
                }
                Err(error) => tracing::warn!(%error, "Session completion delivery deferred"),
            }
        }
        let states = self
            .durable
            .notification_states(self.run_owner(), runs)
            .await
            .map_err(|error| error.to_string())?;
        for ((worker_session, recipient), pair_entries) in groups {
            // One invalid route must not prevent unrelated callers from receiving results.
            if let Err(error) = self
                .deliver_pair_completions(&worker_session, &recipient, pair_entries, &states, now)
                .await
            {
                tracing::warn!(%error, "Session completion delivery deferred");
            }
        }
        Ok(())
    }

    async fn deliver_pair_completions(
        self: &Arc<Self>,
        worker_session: &str,
        recipient: &str,
        entries: Vec<(Completion, CompletionRequest, MessageResolution)>,
        states: &BTreeMap<RunId, NotificationState>,
        now: u64,
    ) -> Result<(), String> {
        let _goal = self.goals.gate.lock().await;
        let parent = match self.session(recipient).await {
            Ok(parent) => Some(parent),
            Err(error) if error == "agent_session_unavailable" => None,
            Err(error) => return Err(error),
        };
        // When the recipient session is in a user-Stop hold, every completion must enter as a
        // Followup so the queue transitions it to Held instead of waking the session via an older
        // completed caller turn.
        let holding = self
            .durable
            .queue()
            .is_holding(recipient.to_owned())
            .await
            .map_err(|error| error.to_string())?;
        let mut eligible = Vec::with_capacity(entries.len());
        let mut frozen_groups: BTreeMap<
            String,
            (maka_agent_state::queue::PreparedRequest, Vec<EligibleWatch>),
        > = BTreeMap::new();
        for (entry, request, resolution) in entries {
            let Some(_) = parent.as_ref().filter(|p| {
                !p.archived
                    && p.configuration.workspace == request.workspace
                    && p.configuration.binding == request.binding
            }) else {
                self.retire_completion(&entry).await?;
                continue;
            };
            let Some(source) = states
                .get(&request.source.run_id)
                .filter(|state| state.session_id == request.source.session_id)
            else {
                self.retire_completion(&entry).await?;
                continue;
            };
            // After a user Stop the result stays with the Session; any other Stop withdraws it.
            let (placement, caller_live) = if source.stopped {
                if self
                    .durable
                    .queue()
                    .stopped_by_user(request.source.run_id)
                    .await
                    .map_err(|error| error.to_string())?
                {
                    (QueuePlacement::Followup, false)
                } else {
                    self.retire_completion(&entry).await?;
                    continue;
                }
            } else if holding {
                (QueuePlacement::Followup, false)
            } else {
                (
                    QueuePlacement::Completion {
                        caller: request.source.run_id,
                    },
                    source.terminal.is_none(),
                )
            };
            let frozen = entry
                .notification
                .as_ref()
                .map(|value| {
                    serde_json::from_value::<maka_agent_state::queue::PreparedRequest>(
                        value.clone(),
                    )
                })
                .transpose()
                .map_err(|e| e.to_string())?;
            let watch = EligibleWatch {
                entry,
                request,
                resolution,
                placement,
                caller_live,
            };
            if let Some(notification) = frozen {
                frozen_groups
                    .entry(notification.id.0.clone())
                    .or_insert_with(|| (notification, Vec::new()))
                    .1
                    .push(watch);
            } else {
                eligible.push(watch);
            }
        }
        for (_, (frozen, watches)) in frozen_groups {
            if let Err(error) = self
                .deliver_frozen_bucket(worker_session, recipient, frozen, watches, states, now)
                .await
            {
                tracing::warn!(%error, "Session completion delivery deferred");
            }
        }
        if eligible.is_empty() {
            return Ok(());
        }
        let worker_exists = self
            .store
            .get_session::<StoredSessionConfiguration>(worker_session)
            .await
            .map_err(|e| e.to_string())?
            .is_some();
        let mut buckets: BTreeMap<NoticeBucket, (Notice, Vec<EligibleWatch>)> = BTreeMap::new();
        for watch in eligible {
            let classified = if !worker_exists {
                Some((NoticeBucket::Unavailable, Notice::Unavailable))
            } else {
                match watch.resolution {
                    MessageResolution::Cancelled => Some((
                        NoticeBucket::CancelledMessage(watch.entry.message_id.clone()),
                        Notice::Finished {
                            run: None,
                            terminal: Terminal::Cancelled,
                        },
                    )),
                    MessageResolution::Delivered { run, .. } => {
                        let state = states
                            .get(&run)
                            .filter(|state| state.session_id == worker_session)
                            .ok_or("agent_completion_run_missing")?;
                        match (&state.terminal, &state.attention) {
                            (Some(terminal), _) => {
                                // The worker may have handed off since the batch read its resolution.
                                let latest = self
                                    .durable
                                    .queue()
                                    .resolve_message(
                                        watch.entry.session_id.clone(),
                                        watch.entry.message_id.clone(),
                                    )
                                    .await
                                    .map_err(|error| error.to_string())?;
                                if !matches!(latest, MessageResolution::Delivered { run: current, .. } if current == run)
                                {
                                    None
                                } else {
                                    Some((
                                        NoticeBucket::FinishedRun(run),
                                        Notice::Finished {
                                            run: Some(run),
                                            terminal: terminal.clone(),
                                        },
                                    ))
                                }
                            }
                            (None, Some(reason)) if !state.stopped => {
                                let cause = AttentionCause::from(reason);
                                Some((
                                    NoticeBucket::AttentionRun {
                                        run,
                                        cause: cause.clone(),
                                    },
                                    Notice::Attention { run, cause },
                                ))
                            }
                            _ => None,
                        }
                    }
                    _ => None,
                }
            };
            if let Some((bucket_key, notice)) = classified {
                buckets
                    .entry(bucket_key)
                    .or_insert_with(|| (notice, Vec::new()))
                    .1
                    .push(watch);
            }
        }
        for (_, (notice, watches)) in buckets {
            if let Err(error) = self
                .deliver_notice_bucket(worker_session, recipient, &notice, watches, states, now)
                .await
            {
                tracing::warn!(%error, "Session completion delivery deferred");
            }
        }
        Ok(())
    }

    async fn deliver_notice_bucket(
        self: &Arc<Self>,
        worker_session: &str,
        recipient: &str,
        notice: &Notice,
        watches: Vec<EligibleWatch>,
        states: &BTreeMap<RunId, NotificationState>,
        now: u64,
    ) -> Result<(), String> {
        let display_message_id = watches
            .iter()
            .find(|w| {
                matches!(
                    w.resolution,
                    MessageResolution::Delivered { shared: false, .. }
                )
            })
            .unwrap_or(&watches[0])
            .entry
            .message_id
            .clone();
        let mut watches = watches;
        let mut identity = notice.identity(worker_session, &display_message_id);
        let mut seen_stopped = BTreeSet::new();
        let (notification, pending_live_caller) = loop {
            match self
                .inspect_existing_delivery(recipient, &identity, &watches, states)
                .await?
            {
                ExistingDelivery::Reusable {
                    request,
                    pending_live_caller,
                    enqueued_at,
                } => {
                    if let Notice::Attention { cause, .. } = notice {
                        if let (AttentionCause::Interaction(id), Some(notified_at)) =
                            (cause, enqueued_at)
                        {
                            self.close_unanswered(worker_session, id, notified_at, now)
                                .await?;
                        }
                        return Ok(());
                    }
                    break (request, pending_live_caller);
                }
                ExistingDelivery::RetractedByOtherCaller(stopped_caller)
                    if seen_stopped.insert(stopped_caller) =>
                {
                    watches.retain(|w| w.request.source.run_id != stopped_caller);
                    identity = rescue_identity(&identity, stopped_caller);
                }
                ExistingDelivery::Absent | ExistingDelivery::RetractedByOtherCaller(_) => {
                    let result = match notice {
                        Notice::Finished {
                            run: Some(run),
                            terminal,
                        } => self.run_result(worker_session, *run, terminal, true).await,
                        _ => RunResult::default(),
                    };
                    let origin = MessageOrigin::SessionCompletion {
                        session_id: worker_session.to_owned(),
                        message_id: display_message_id.clone(),
                    };
                    let Some(delivered) = self
                        .enqueue_candidates(
                            recipient,
                            &identity,
                            &watches,
                            origin,
                            |language| {
                                notice.message(
                                    worker_session,
                                    &display_message_id,
                                    &result,
                                    language,
                                )
                            },
                            now,
                        )
                        .await?
                    else {
                        return Ok(());
                    };
                    if matches!(notice, Notice::Attention { .. }) {
                        // Admission identity is the durable deduplication record; keep the completion watches.
                        self.admit_notification(&delivered.0).await?;
                        return Ok(());
                    }
                    break delivered;
                }
            }
        };
        for watch in &watches {
            if pending_live_caller.is_some_and(|live| live != watch.request.source.run_id) {
                // Freeze the admitted notice onto the waiting watch so deleting the finished
                // worker cannot reclassify it as Unavailable while the live caller still holds it.
                self.freeze_watch(&watch.entry, &notification).await?;
                continue;
            }
            self.settle_watch(&watch.entry, &notification, true).await?;
        }
        Ok(())
    }

    async fn deliver_frozen_bucket(
        self: &Arc<Self>,
        worker_session: &str,
        recipient: &str,
        frozen: maka_agent_state::queue::PreparedRequest,
        mut watches: Vec<EligibleWatch>,
        states: &BTreeMap<RunId, NotificationState>,
        now: u64,
    ) -> Result<(), String> {
        let mut identity = frozen.id.0.clone();
        let mut seen_stopped = BTreeSet::new();
        let (notification, pending_live_caller) = loop {
            match self
                .inspect_existing_delivery(recipient, &identity, &watches, states)
                .await?
            {
                ExistingDelivery::Reusable {
                    request,
                    pending_live_caller,
                    ..
                } => {
                    let chosen = if identity == frozen.id.0 {
                        frozen.clone()
                    } else {
                        request
                    };
                    break (chosen, pending_live_caller);
                }
                ExistingDelivery::RetractedByOtherCaller(stopped_caller)
                    if seen_stopped.insert(stopped_caller) =>
                {
                    watches.retain(|w| w.request.source.run_id != stopped_caller);
                    identity = rescue_identity(&identity, stopped_caller);
                }
                ExistingDelivery::Absent | ExistingDelivery::RetractedByOtherCaller(_) => {
                    if identity == frozen.id.0 {
                        // Original frozen notification was never admitted; preserve existing behavior.
                        break (frozen.clone(), None);
                    }
                    let source_bytes = self
                        .durable
                        .queue()
                        .content(
                            recipient.to_owned(),
                            frozen.id.clone(),
                            frozen.source.clone(),
                        )
                        .await
                        .map_err(|error| error.to_string())?;
                    let source_msg: maka_agent_facts::message::RootSourceMessage =
                        serde_json::from_slice(&source_bytes).map_err(|e| e.to_string())?;
                    let origin = source_msg.message.origin.unwrap_or_else(|| {
                        MessageOrigin::SessionCompletion {
                            session_id: worker_session.to_owned(),
                            message_id: watches[0].entry.message_id.clone(),
                        }
                    });
                    let rendered = source_msg.unprepared_content.text;
                    let Some(delivered) = self
                        .enqueue_candidates(
                            recipient,
                            &identity,
                            &watches,
                            origin,
                            |_| rendered.clone(),
                            now,
                        )
                        .await?
                    else {
                        return Ok(());
                    };
                    break delivered;
                }
            }
        };
        for watch in &watches {
            if pending_live_caller.is_some_and(|live| live != watch.request.source.run_id) {
                continue;
            }
            self.settle_watch(&watch.entry, &notification, false)
                .await?;
        }
        Ok(())
    }

    async fn enqueue_candidates(
        self: &Arc<Self>,
        recipient: &str,
        identity: &str,
        watches: &[EligibleWatch],
        origin: MessageOrigin,
        render: impl Fn(Language) -> String,
        now: u64,
    ) -> Result<Option<(maka_agent_state::queue::PreparedRequest, Option<RunId>)>, String> {
        let mut last_error: Option<String> = None;
        for idx in Self::ordered_candidate_indices(watches) {
            let candidate = &watches[idx];
            let route = match self
                .resolve_notification_route(
                    candidate.request.backend.clone(),
                    &candidate.request.source.session_id,
                    candidate.request.workspace.clone(),
                    candidate.request.binding,
                )
                .await
            {
                Ok(route) => route,
                Err(error) => {
                    last_error = Some(error);
                    continue;
                }
            };
            match self
                .prepare_notification_checked(
                    recipient,
                    &route,
                    identity,
                    &render,
                    origin.clone(),
                    candidate.placement.clone(),
                    None,
                    UnixMillis(now as i64),
                )
                .await
                .map_err(String::from)
            {
                Ok(Some(notification)) => {
                    let pending_live_caller =
                        matches!(candidate.placement, QueuePlacement::Completion { .. })
                            .then_some(candidate.request.source.run_id)
                            .filter(|_| candidate.caller_live);
                    return Ok(Some((notification, pending_live_caller)));
                }
                Ok(None) => return Ok(None),
                Err(error) => last_error = Some(error),
            }
        }
        match last_error {
            Some(error) => Err(error),
            None => Ok(None),
        }
    }

    /// Delivery candidate priority:
    /// 1. Currently live caller (receives notice immediately as steering rather than waiting)
    /// 2. Primary non-steered watch
    /// 3. Deterministic key order
    fn ordered_candidate_indices(watches: &[EligibleWatch]) -> Vec<usize> {
        let mut indices: Vec<usize> = (0..watches.len()).collect();
        indices.sort_by(|&a, &b| {
            let rank = |w: &EligibleWatch| {
                let shared = matches!(
                    w.resolution,
                    MessageResolution::Delivered { shared: true, .. }
                );
                (!w.caller_live, shared)
            };
            rank(&watches[a])
                .cmp(&rank(&watches[b]))
                .then_with(|| watches[a].entry.key.cmp(&watches[b].entry.key))
        });
        indices
    }

    async fn inspect_existing_delivery(
        &self,
        recipient: &str,
        identity: &str,
        watches: &[EligibleWatch],
        states: &BTreeMap<RunId, NotificationState>,
    ) -> Result<ExistingDelivery, String> {
        let request_id = maka_agent_state::queue::RequestId(identity.to_owned());
        let Some(existing) = self
            .durable
            .queue()
            .entry(recipient.to_owned(), request_id.clone())
            .await
            .map_err(|error| error.to_string())?
        else {
            return Ok(ExistingDelivery::Absent);
        };
        let enqueued_at = self
            .durable
            .queue()
            .entry_enqueued_at(recipient.to_owned(), request_id.clone())
            .await
            .map_err(|error| error.to_string())?;
        let resolution = self
            .durable
            .queue()
            .resolve_message(recipient.to_owned(), existing.request.message_id.clone())
            .await
            .map_err(|error| error.to_string())?;
        match resolution {
            MessageResolution::Missing => Ok(ExistingDelivery::Absent),
            MessageResolution::Delivered { .. } => Ok(ExistingDelivery::Reusable {
                request: existing.request,
                pending_live_caller: None,
                enqueued_at,
            }),
            MessageResolution::Pending => {
                let pending_live_caller = match existing.placement {
                    QueuePlacement::Completion { caller }
                        if self
                            .caller_state(recipient, caller, states)
                            .await?
                            .is_some_and(|(stopped, live)| !stopped && live) =>
                    {
                        Some(caller)
                    }
                    _ => None,
                };
                Ok(ExistingDelivery::Reusable {
                    request: existing.request,
                    pending_live_caller,
                    enqueued_at,
                })
            }
            MessageResolution::Cancelled => {
                // Only rescue when CallerStopped retracted the shared notice; an explicit
                // user queue Retract/RetractAll settles all watches sharing that notice.
                if let QueuePlacement::Completion { caller } = existing.placement
                    && watches.iter().any(|w| w.request.source.run_id != caller)
                    && self
                        .caller_state(recipient, caller, states)
                        .await?
                        .is_some_and(|(stopped, _)| stopped)
                    && self
                        .durable
                        .queue()
                        .cancelled_by_caller_stop(recipient.to_owned(), request_id, caller)
                        .await
                        .map_err(|error| error.to_string())?
                {
                    Ok(ExistingDelivery::RetractedByOtherCaller(caller))
                } else {
                    Ok(ExistingDelivery::Reusable {
                        request: existing.request,
                        pending_live_caller: None,
                        enqueued_at,
                    })
                }
            }
        }
    }

    /// Returns `Some((stopped, live))` for `caller` if it still exists on `recipient`.
    async fn caller_state(
        &self,
        recipient: &str,
        caller: RunId,
        states: &BTreeMap<RunId, NotificationState>,
    ) -> Result<Option<(bool, bool)>, String> {
        if let Some(state) = states.get(&caller).filter(|s| s.session_id == recipient) {
            return Ok(Some((state.stopped, state.terminal.is_none())));
        }
        Ok(self
            .session_run(recipient, caller)
            .await?
            .map(|view| (view.stopped, view.terminal.is_none())))
    }

    async fn freeze_watch(
        &self,
        entry: &Completion,
        notification: &maka_agent_state::queue::PreparedRequest,
    ) -> Result<(), String> {
        self.store
            .settle_message_completion(
                &self.prefix,
                &entry.key,
                Some(serde_json::to_value(notification).map_err(|e| e.to_string())?),
            )
            .await
            .map_err(|e| e.to_string())
    }

    async fn settle_watch(
        &self,
        entry: &Completion,
        notification: &maka_agent_state::queue::PreparedRequest,
        freeze_first: bool,
    ) -> Result<(), String> {
        if freeze_first {
            self.freeze_watch(entry, notification).await?;
        }
        if self.admit_notification(notification).await? {
            self.mark_bot_completion(&entry.session_id, &entry.message_id, &entry.recipient)
                .await?;
            self.store
                .settle_message_completion(&self.prefix, &entry.key, None)
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    /// The caller was told about this question or approval. If no one answers it
    /// within the limit, the delegated task gets "no one answered" and continues.
    /// The limit counts from when the caller's attention notice was durably
    /// enqueued, so queued parallel interactions and restart delays get the full window.
    async fn close_unanswered(
        &self,
        session: &str,
        request: &str,
        notified_at: UnixMillis,
        now: u64,
    ) -> Result<(), String> {
        let notified_at = u64::try_from(notified_at.0).unwrap_or(0);
        if now.saturating_sub(notified_at) < UNANSWERED_LIMIT.as_millis() as u64 {
            return Ok(());
        }
        let interactions = self.durable.interactions();
        let Some(record) = interactions
            .read(session, request)
            .await
            .map_err(|error| error.to_string())?
        else {
            return Ok(());
        };
        if record.outcome.is_some() {
            return Ok(());
        }
        interactions
            .commit_outcome(
                session,
                request,
                maka_agent_facts::interaction::InteractionOutcome::Closure {
                    reason: maka_agent_facts::interaction::ClosureReason::TimedOut,
                    committed_at: now,
                },
            )
            .await
            .map_err(|error| error.to_string())?;
        Ok(())
    }
    async fn retire_completion(&self, entry: &Completion) -> Result<(), String> {
        if self.bot.is(&entry.recipient)
            && let Some(notification) = &entry.notification
            && self
                .store
                .get_session::<StoredSessionConfiguration>(&entry.recipient)
                .await
                .map_err(|error| error.to_string())?
                .is_some()
        {
            let notification: maka_agent_state::queue::PreparedRequest =
                serde_json::from_value(notification.clone()).map_err(|e| e.to_string())?;
            if !matches!(
                self.durable
                    .queue()
                    .resolve_message(entry.recipient.clone(), notification.message_id)
                    .await
                    .map_err(|e| e.to_string())?,
                maka_agent_state::queue::MessageResolution::Missing
            ) {
                self.mark_bot_completion(&entry.session_id, &entry.message_id, &entry.recipient)
                    .await?;
            }
        }
        self.store
            .settle_message_completion(&self.prefix, &entry.key, None)
            .await
            .map_err(|error| error.to_string())
    }

    async fn mark_bot_completion(
        &self,
        worker: &str,
        message: &str,
        recipient: &str,
    ) -> Result<(), String> {
        if self.bot.is(recipient)
            && self
                .store
                .get_session::<StoredSessionConfiguration>(worker)
                .await
                .map_err(|e| e.to_string())?
                .is_some()
            && let maka_agent_state::queue::MessageResolution::Delivered { run, .. } = self
                .durable
                .queue()
                .resolve_message(worker.into(), message.into())
                .await
                .map_err(|e| e.to_string())?
            && self
                .durable
                .latest_run(worker.into())
                .await
                .map_err(|e| e.to_string())?
                == Some(run)
        {
            self.bot
                .mark_completion(worker, run)
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}
