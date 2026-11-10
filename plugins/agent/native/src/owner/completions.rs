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
use maka_agent_facts::message::MessageOrigin;
use maka_event_log::root_store::completions::Completion;

#[derive(Serialize, Deserialize)]
pub(super) struct CompletionRequest {
    source: maka_agent_facts::durable::ExecutionIdentity,
    model: ModelSelection,
    thinking_level: Option<ThinkingLevel>,
    workspace: Workspace,
    binding: maka_sandbox::workspace::BindingStamp,
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
        self: &Arc<Self>,
        session: &str,
        message: &str,
        request: CompletionRequest,
    ) -> Result<CompletionStatement, String> {
        Ok(CompletionStatement {
            owner: self.clone(),
            registration: maka_event_log::root_store::completions::RegisterCompletion {
                owner: self.prefix.clone(),
                session: session.into(),
                message: message.into(),
                recipient: request.source.session_id.clone(),
                request: serde_json::to_value(request).map_err(|e| e.to_string())?,
            },
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
        let epoch = self
            .completion_epoch
            .load(std::sync::atomic::Ordering::SeqCst);
        let mut after = None;
        loop {
            let entries = self
                .store
                .message_completions(&self.prefix, after.as_deref())
                .await
                .map_err(|e| e.to_string())?;
            if entries.is_empty() {
                if self
                    .store
                    .message_completions(&self.prefix, None)
                    .await
                    .map_err(|e| e.to_string())?
                    .is_empty()
                {
                    self.completion_drained
                        .store(epoch, std::sync::atomic::Ordering::SeqCst);
                }
                return Ok(());
            }
            for entry in entries {
                after = Some(entry.key.clone());
                // One invalid route must not prevent unrelated callers from receiving results.
                if let Err(error) = self.deliver_completion(entry).await {
                    tracing::warn!(%error, "Session completion delivery deferred");
                }
            }
        }
    }
    async fn deliver_completion(self: &Arc<Self>, entry: Completion) -> Result<(), String> {
        let _goal = self.goals.gate.lock().await;
        let request: CompletionRequest =
            CompletionRequest::deserialize(&entry.request).map_err(|e| e.to_string())?;
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
        let source = self
            .session_run(&request.source.session_id, request.source.run_id)
            .await?;
        if source.is_none_or(|view| view.stopped) {
            return self.retire_completion(&entry).await;
        }
        let notification: maka_agent_state::queue::PreparedRequest = if let Some(notification) =
            entry.notification
        {
            serde_json::from_value(notification).map_err(|e| e.to_string())?
        } else {
            use maka_agent_facts::durable::Terminal;
            use maka_agent_state::queue::MessageResolution;
            let state = if self
                .store
                .get_session::<StoredSessionConfiguration>(&entry.session_id)
                .await
                .map_err(|e| e.to_string())?
                .is_none()
            {
                "unavailable"
            } else {
                match self
                    .durable
                    .queue()
                    .resolve_message(entry.session_id.clone(), entry.message_id.clone())
                    .await
                    .map_err(|e| e.to_string())?
                {
                    MessageResolution::Cancelled => "cancelled",
                    MessageResolution::Delivered { run, .. } => {
                        match self
                            .durable
                            .frontier(run)
                            .await
                            .map_err(|e| e.to_string())?
                            .terminal
                        {
                            Some(Terminal::Completed) => "completed",
                            Some(Terminal::Failed) => "failed",
                            Some(Terminal::Cancelled) => "cancelled",
                            None => return Ok(()),
                        }
                    }
                    _ => return Ok(()),
                }
            };
            if self.runs.lock().await.busy(&request.source.session_id)
                || self
                    .session_run(&request.source.session_id, request.source.run_id)
                    .await?
                    .is_some_and(|view| view.terminal.is_none())
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
            let identity = hex::encode(Sha256::digest(
                format!(
                    "session-completion/{}/{}",
                    entry.session_id, entry.message_id
                )
                .as_bytes(),
            ))[..32]
                .to_owned();
            let Some(notification) = self
                .prepare_notification(
                    &request.source,
                    &route,
                    &identity,
                    |language| {
                        let reference = format!("SessionWork({})", serde_json::json!({
                            "sessionId": entry.session_id,
                            "target": {"kind": "message", "messageId": entry.message_id}
                        }));
                        match language {
                            Language::ZhCn => format!("你派发的任务已结束，状态：{state}。使用 {reference} 读取实际结果，再继续处理。"),
                            Language::ZhTw => format!("你派發的任務已結束，狀態：{state}。使用 {reference} 讀取實際結果，再繼續處理。"),
                            _ => format!("Your delegated task ended with status {state}. Read the actual result using {reference}, then continue."),
                        }
                    },
                    MessageOrigin::SessionCompletion {
                        session_id: entry.session_id.clone(),
                        message_id: entry.message_id.clone(),
                    },
                )
                .await?
            else {
                return Ok(());
            };
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
        if self.bot.is(recipient) {
            if self
                .store
                .get_session::<StoredSessionConfiguration>(worker)
                .await
                .map_err(|e| e.to_string())?
                .is_some()
            {
                if let maka_agent_state::queue::MessageResolution::Delivered { run, .. } = self
                    .durable
                    .queue()
                    .resolve_message(worker.into(), message.into())
                    .await
                    .map_err(|e| e.to_string())?
                {
                    if self
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
                }
            }
        }
        Ok(())
    }
}

pub(super) struct CompletionStatement {
    owner: Arc<Owner>,
    registration: maka_event_log::root_store::completions::RegisterCompletion,
}
impl maka_event_log::writeback::Statement for CompletionStatement {
    type Value = Arc<Owner>;
    type Output = ();
    fn execute(
        self,
        connection: &rusqlite::Connection,
    ) -> Result<maka_event_log::writeback::Prepared<Self::Value>, maka_event_log::StoreError> {
        let registered = self.registration.execute(connection)?;
        Ok(maka_event_log::writeback::Prepared {
            value: self.owner,
            changed: registered.changed,
            notification: registered.notification,
        })
    }
    fn committed(owner: Self::Value) {
        owner
            .completion_epoch
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
    fn isolated_rejection(_: &maka_event_log::StoreError) -> bool {
        false
    }
}
