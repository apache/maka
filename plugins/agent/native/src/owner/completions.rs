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
    model: ModelSelection,
    thinking_level: Option<ThinkingLevel>,
    workspace: Workspace,
    binding: maka_sandbox::workspace::BindingStamp,
}
enum Notice<'a> {
    Finished(Terminal),
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
        let work = format!(
            "SessionWork({})",
            serde_json::json!({
                "sessionId": task.session_id,
                "target": {"kind": "message", "messageId": task.message_id}
            })
        );
        let status = match self {
            Self::Finished(Terminal::Completed) => "completed",
            Self::Finished(Terminal::Failed) => "failed",
            Self::Finished(Terminal::Cancelled) => "cancelled",
            Self::Unavailable => "unavailable",
            Self::Attention { reason, .. } => {
                let instruction = match reason {
                    NotificationAttention::Interaction { request } => format!(
                        "SessionInteraction({})",
                        serde_json::json!({"sessionId": task.session_id, "requestId": request})
                    ),
                    NotificationAttention::Authority { .. } => work,
                };
                return match language {
                    Language::ZhCn => format!(
                        "你派发的任务需要介入，尚未结束。使用 {instruction} 查看原因，在现有权限内处理，需要人工操作时转告用户；不要重复派发任务。任务结束后仍会通知你。"
                    ),
                    Language::ZhTw => format!(
                        "你派發的任務需要介入，尚未結束。使用 {instruction} 查看原因，在現有權限內處理，需要人工操作時轉告使用者；不要重複派發任務。任務結束後仍會通知你。"
                    ),
                    _ => format!(
                        "Your delegated task needs attention and has not finished. Inspect {instruction} and handle it within your existing authority; ask the user if human action is required. Do not redispatch the task. You will still be notified when it ends."
                    ),
                };
            }
        };
        match language {
            Language::ZhCn => format!(
                "你派发的任务已结束，状态：{status}。使用 {work} 读取实际结果，再继续处理。"
            ),
            Language::ZhTw => format!(
                "你派發的任務已結束，狀態：{status}。使用 {work} 讀取實際結果，再繼續處理。"
            ),
            _ => format!(
                "Your delegated task ended with status {status}. Read the actual result using {work}, then continue."
            ),
        }
    }
}

impl Owner {
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
        let model = route.binding_model();
        Ok(Some(CompletionRequest {
            source: source.clone(),
            model: ModelSelection {
                connection_id: model.connection_id.clone(),
                model_id: model.model.clone(),
            },
            thinking_level: route.thinking_level(),
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
                    MessageResolution::Cancelled => Notice::Finished(Terminal::Cancelled),
                    MessageResolution::Delivered { run, .. } => {
                        let state = states
                            .get(&run)
                            .filter(|state| state.session_id == entry.session_id)
                            .ok_or("agent_completion_run_missing")?;
                        match (&state.terminal, &state.attention) {
                            (Some(terminal), _) => Notice::Finished(terminal.clone()),
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
            let (model, _) = crate::model::Source::select(
                self.configuration.clone(),
                self.catalog.clone(),
                self.credentials.clone(),
                request.model,
                request.thinking_level,
                request.source.session_id.clone(),
                self.revision.clone(),
            )
            .await
            .map_err(public_error)?;
            let route =
                notifications::ReturnRoute::new(model.accepted, request.workspace, request.binding);
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
