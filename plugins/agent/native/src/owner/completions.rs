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
    durable::{RunId, Terminal},
    message::MessageOrigin,
};
use maka_agent_state::{NotificationAttention, NotificationState, queue::MessageResolution};
use maka_event_log::root_store::completions::{Completion, RegisterCompletion};

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
    /// The result of a finished run: its last assistant message, and for a failed
    /// run the failure recorded after that message. A stopped or completed run has
    /// no failure to report; rows it shows (an interrupted step, a retried error)
    /// are not why it ended.
    pub(super) async fn run_result(
        &self,
        session_id: &str,
        run: RunId,
        terminal: &Terminal,
    ) -> RunResult {
        let mut result = self.history_result(session_id, run).await;
        if *terminal != Terminal::Failed {
            result.failure = None;
        } else if result.failure.is_none()
            && let Ok(Some(view)) = self.session_run(session_id, run).await
            && let Some(failure) = view.recovery_failure()
        {
            result.failure = serde_json::to_value(failure)
                .ok()
                .and_then(|v| {
                    v.get("diagnostic")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .or_else(|| serde_json::to_string(failure).ok())
                .as_deref()
                .and_then(excerpt);
        }
        // The history tail no longer reaches a run that later runs have pushed out;
        // the end of its answer is the closest to what it said last.
        if result.reply.is_none() {
            result.reply = self.answer_tail(session_id, run).await;
        }
        result
    }

    /// The run's last assistant message on the history tail page, and the failure
    /// rows recorded after it.
    pub(super) async fn history_result(&self, session_id: &str, run: RunId) -> RunResult {
        use maka_agent_ports::session::history as wire;
        let mut reply: Option<(
            Option<String>,
            maka_agent_facts::history::HistoryRowAddress,
            String,
        )> = None;
        let mut failures: Vec<(maka_agent_facts::history::HistoryRowAddress, String)> = Vec::new();
        let page = match maka_capabilities::call::Issuer::default()
            .issue(maka_capabilities::call::Identity::Native, self.stop.clone())
        {
            Ok(scope) => crate::service::history_read_for_tool(
                self,
                &scope,
                crate::contract::History {
                    session_id: session_id.to_owned(),
                    through: None,
                    position: wire::Position::Tail,
                    include_thinking: false,
                    view: wire::HistoryView::Conversation,
                },
            )
            .await
            .ok(),
            Err(_) => None,
        };
        if let Some(crate::contract::HistoryPage::Ready { chunks, .. }) = page {
            for chunk in chunks {
                if chunk.run_id != Some(run)
                    || chunk.field != wire::HistoryField::Body
                    || chunk.text.trim().is_empty()
                {
                    continue;
                }
                match chunk.role {
                    wire::Role::Assistant => {
                        if let Some((id, position, text)) = &mut reply
                            && ((chunk.message_id.is_some() && *id == chunk.message_id)
                                || *position == chunk.position)
                        {
                            text.push_str(&chunk.text);
                        } else {
                            reply = Some((chunk.message_id, chunk.position, chunk.text));
                            failures.clear();
                        }
                    }
                    wire::Role::Failure => match failures.last_mut() {
                        Some((position, text)) if *position == chunk.position => {
                            text.push_str(&chunk.text);
                        }
                        Some((_, text)) if *text == chunk.text => {}
                        _ => failures.push((chunk.position, chunk.text)),
                    },
                    _ => {}
                }
            }
        }
        RunResult {
            reply: reply.and_then(|(_, _, text)| excerpt(&text)),
            failure: excerpt(
                &failures
                    .into_iter()
                    .map(|(_, text)| text)
                    .collect::<Vec<_>>()
                    .join("\n"),
            ),
        }
    }

    async fn answer_tail(&self, session_id: &str, run: RunId) -> Option<String> {
        const TAIL: u64 = 4096;
        let head = self.durable.work(run, 0, 4).await.ok().flatten()?;
        if head.view.spec.session_id != session_id {
            return None;
        }
        let start = head.answer.high_water.saturating_sub(TAIL);
        // A cut inside a UTF-8 character is refused; the next boundary is at most 3 bytes on.
        for offset in start..(start + 4).min(head.answer.high_water) {
            if let Ok(Some(work)) = self.durable.work(run, offset, TAIL as u32).await {
                let text = work.answer.text.trim();
                let kept: Vec<char> = text.chars().rev().take(1600).collect();
                if kept.is_empty() {
                    return None;
                }
                let mut tail: String = kept.into_iter().rev().collect();
                if offset > 0 || text.chars().count() > 1600 {
                    tail.insert_str(0, "[truncated] …\n");
                }
                return Some(tail);
            }
        }
        None
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
                    .deliver_completion(entry, request, resolution, &states)
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
        if source.stopped {
            return self.retire_completion(&entry).await;
        }
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
                && self
                    .durable
                    .queue()
                    .entry(
                        entry.recipient.clone(),
                        maka_agent_state::queue::RequestId(identity.clone()),
                    )
                    .await
                    .map_err(|error| error.to_string())?
                    .is_some()
            {
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
                .prepare_notification(
                    &request.source,
                    &route,
                    &identity,
                    |language| notice.message(&entry, language),
                    MessageOrigin::SessionCompletion {
                        session_id: entry.session_id.clone(),
                        message_id: entry.message_id.clone(),
                    },
                )
                .await?
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
