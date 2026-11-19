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
enum Notice<'a> {
    Finished {
        terminal: Terminal,
        result: RunResult,
    },
    Unavailable,
    Attention {
        run: RunId,
        reason: &'a NotificationAttention,
    },
}
impl Notice<'_> {
    fn identity(&self, task: &Completion) -> String {
        let mut key = format!("session-completion/{}/{}", task.session_id, task.message_id);
        if let Self::Attention { run, reason } = self {
            let cause = match reason {
                NotificationAttention::Interaction { request } => format!("interaction/{request}"),
                NotificationAttention::Authority { blocker } => format!("authority/{blocker}"),
            };
            key.push_str(&format!("/{run}/{cause}"));
        }
        hex::encode(Sha256::digest(key.as_bytes()))[..32].to_owned()
    }

    fn message(&self, task: &Completion, language: Language) -> String {
        let session_read = format!(
            "SessionRead({})",
            serde_json::json!({"sessionId": task.session_id})
        );
        let read_uri = format!(
            "Read({})",
            serde_json::json!({"path": format!("maka://session/{}", task.session_id)})
        );
        let (status, inline_result) = match self {
            Self::Finished { terminal, result } => (
                match terminal {
                    Terminal::Completed => "completed",
                    Terminal::Failed => "failed",
                    Terminal::Cancelled => "cancelled",
                },
                result.inline(),
            ),
            Self::Unavailable => ("unavailable", String::new()),
            Self::Attention { reason, .. } => {
                let status_only = format!(
                    "SessionRead({})",
                    serde_json::json!({"sessionId": task.session_id, "view": "status_only"})
                );
                let instruction = match reason {
                    NotificationAttention::Interaction { request } => {
                        let respond = format!(
                            "SessionRespond({})",
                            serde_json::json!({"sessionId": task.session_id, "requestId": request})
                        );
                        format!("{status_only} / {respond}")
                    }
                    NotificationAttention::Authority { blocker } => {
                        format!("{status_only} (blocker: {blocker})")
                    }
                };
                return match language {
                    Language::ZhCn => format!(
                        "你派发的任务（messageId: {}）需要介入，尚未结束。用 {instruction} 查看待处理的提问或审批并在权限内处理，需要人工决策时转告用户；不要重复派发。任务结束后仍会通知你。",
                        task.message_id
                    ),
                    Language::ZhTw => format!(
                        "你派發的任務（messageId: {}）需要介入，尚未結束。用 {instruction} 查看待處理的提問或審批並在權限內處理，需要人工決策時轉告使用者；不要重複派發。任務結束後仍會通知你。",
                        task.message_id
                    ),
                    _ => format!(
                        "Your delegated task (messageId: {}) needs attention and has not finished. Inspect {instruction} within your existing authority; ask the user if human action is required. Do not redispatch the task. You will still be notified when it ends.",
                        task.message_id
                    ),
                };
            }
        };
        match language {
            Language::ZhCn => format!(
                "你派发的任务（messageId: {}）已结束，状态：{status}。如需完整记录可调用 {read_uri} 或 {session_read}。{inline_result}",
                task.message_id
            ),
            Language::ZhTw => format!(
                "你派發的任務（messageId: {}）已結束，狀態：{status}。如需完整記錄可呼叫 {read_uri} 或 {session_read}。{inline_result}",
                task.message_id
            ),
            _ => format!(
                "Your delegated task (messageId: {}) ended with status {status}. For full context or tool outputs, call {read_uri} or {session_read}.{inline_result}",
                task.message_id
            ),
        }
    }
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
        let recovery_diagnostic = if collect_failures {
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
            for record in page.into_iter().rev() {
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
                        reply = Some(text.to_string());
                        break 'scan;
                    }
                    Fact::ExternalTaskObserved {
                        task,
                        output: Output::OutputDelta { message_id, text },
                        ..
                    } => match &mut external_reply {
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
                    },
                    Fact::RunTerminated {
                        terminal: Terminal::Failed,
                        diagnostic,
                    } if collect_failures && !external_has_content => {
                        if let Some(diag) = recovery_diagnostic.clone().or(diagnostic) {
                            push_failure(&mut failures, diag);
                        }
                    }
                    Fact::ModelInterrupted { diagnostic, .. }
                        if collect_failures && !external_has_content =>
                    {
                        push_failure(&mut failures, diagnostic);
                    }
                    Fact::ExternalTaskClosed {
                        outcome: Terminal::Failed,
                        diagnostic: Some(diagnostic),
                        ..
                    } if collect_failures && !external_has_content => {
                        push_failure(&mut failures, diagnostic);
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
        loop {
            let entries = self
                .store
                .message_completions(&self.prefix, after.as_deref())
                .await
                .map_err(|e| e.to_string())?;
            if entries.is_empty() {
                return Ok(());
            }
            let mut pending = Vec::with_capacity(entries.len());
            let mut runs = BTreeSet::new();
            for entry in entries {
                after = Some(entry.key.clone());
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
                        pending.push((entry, request, resolution));
                    }
                    Err(error) => tracing::warn!(%error, "Session completion delivery deferred"),
                }
            }
            let states = self
                .durable
                .notification_states(self.run_owner(), runs)
                .await
                .map_err(|error| error.to_string())?;
            for (entry, request, resolution) in pending {
                // One invalid route must not prevent unrelated callers from receiving results.
                if let Err(error) = self
                    .deliver_completion(entry, request, resolution, &states, now)
                    .await
                {
                    tracing::warn!(%error, "Session completion delivery deferred");
                }
            }
        }
    }
    async fn deliver_completion(
        self: &Arc<Self>,
        entry: Completion,
        request: CompletionRequest,
        resolution: MessageResolution,
        states: &BTreeMap<RunId, NotificationState>,
        now: u64,
    ) -> Result<(), String> {
        let _goal = self.goals.gate.lock().await;
        let parent = match self.session(&request.source.session_id).await {
            Ok(parent) => Some(parent),
            Err(error) if error == "agent_session_unavailable" => None,
            Err(error) => return Err(error),
        };
        let Some(_) = parent.filter(|p| {
            !p.archived
                && p.configuration.workspace == request.workspace
                && p.configuration.binding == request.binding
        }) else {
            return self.retire_completion(&entry).await;
        };
        let Some(source) = states
            .get(&request.source.run_id)
            .filter(|state| state.session_id == request.source.session_id)
        else {
            return self.retire_completion(&entry).await;
        };
        // After a user Stop the result waits in the queue for the user's next
        // message; any other Stop withdraws it.
        let placement = if !source.stopped {
            QueuePlacement::Completion {
                caller: request.source.run_id,
            }
        } else if self
            .durable
            .queue()
            .stopped_by_user(request.source.run_id)
            .await
            .map_err(|error| error.to_string())?
        {
            QueuePlacement::Followup
        } else {
            return self.retire_completion(&entry).await;
        };
        let notification: maka_agent_state::queue::PreparedRequest = if let Some(notification) =
            entry.notification
        {
            serde_json::from_value(notification).map_err(|e| e.to_string())?
        } else {
            let notice = if self
                .store
                .get_session::<StoredSessionConfiguration>(&entry.session_id)
                .await
                .map_err(|e| e.to_string())?
                .is_none()
            {
                Notice::Unavailable
            } else {
                match resolution {
                    MessageResolution::Cancelled => Notice::Finished {
                        terminal: Terminal::Cancelled,
                        result: RunResult::default(),
                    },
                    MessageResolution::Delivered { run, .. } => {
                        let state = states
                            .get(&run)
                            .filter(|state| state.session_id == entry.session_id)
                            .ok_or("agent_completion_run_missing")?;
                        match (&state.terminal, &state.attention) {
                            (Some(terminal), _) => {
                                // The worker may have handed off since the batch read its resolution.
                                let latest = self
                                    .durable
                                    .queue()
                                    .resolve_message(
                                        entry.session_id.clone(),
                                        entry.message_id.clone(),
                                    )
                                    .await
                                    .map_err(|error| error.to_string())?;
                                if !matches!(latest, MessageResolution::Delivered { run: current, .. } if current == run)
                                {
                                    return Ok(());
                                }
                                Notice::Finished {
                                    terminal: terminal.clone(),
                                    result: self.run_result(&entry.session_id, run, terminal).await,
                                }
                            }
                            (None, Some(reason)) if !state.stopped => {
                                Notice::Attention { run, reason }
                            }
                            _ => return Ok(()),
                        }
                    }
                    _ => return Ok(()),
                }
            };
            let identity = notice.identity(&entry);
            let attention = matches!(notice, Notice::Attention { .. });
            if attention
                && let Some(notified_at) = self
                    .durable
                    .queue()
                    .entry_enqueued_at(
                        entry.recipient.clone(),
                        maka_agent_state::queue::RequestId(identity.clone()),
                    )
                    .await
                    .map_err(|error| error.to_string())?
            {
                if let Notice::Attention {
                    reason: NotificationAttention::Interaction { request },
                    ..
                } = &notice
                {
                    self.close_unanswered(&entry.session_id, request, notified_at, now)
                        .await?;
                }
                return Ok(());
            }
            let route = self
                .resolve_notification_route(
                    request.backend,
                    &request.source.session_id,
                    request.workspace,
                    request.binding,
                )
                .await?;
            let Some(notification) = self
                .prepare_notification_checked(
                    &request.source.session_id,
                    &route,
                    &identity,
                    |language| notice.message(&entry, language),
                    MessageOrigin::SessionCompletion {
                        session_id: entry.session_id.clone(),
                        message_id: entry.message_id.clone(),
                    },
                    placement,
                    None,
                    UnixMillis(now as i64),
                )
                .await
                .map_err(String::from)?
            else {
                return Ok(());
            };
            if attention {
                // Admission identity is the durable deduplication record; keep the completion watch.
                self.admit_notification(&notification).await?;
                return Ok(());
            }
            self.store
                .settle_message_completion(
                    &self.prefix,
                    &entry.key,
                    Some(serde_json::to_value(&notification).map_err(|e| e.to_string())?),
                )
                .await
                .map_err(|e| e.to_string())?;
            notification
        };
        if self.admit_notification(&notification).await? {
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
