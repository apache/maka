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

//! WorkHub follow-ups use the original Agent admission gate and durable queue.
use super::*;
use maka_agent_facts::message::MessageOrigin;
use maka_event_log::message_admissions::{PendingExecution, PendingMessageAdmission};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ReturnRoute {
    model: crate::model::AcceptedModel,
    pub(crate) workspace: Workspace,
    pub(crate) binding: maka_agent_facts::workspace::BindingStamp,
}
impl Owner {
    pub(crate) fn background<F, Fut>(&self, task: F)
    where
        F: FnOnce(CancellationToken) -> Fut,
        Fut: std::future::Future<Output = ()> + std::marker::Send + 'static,
    {
        self.producers.spawn(task(self.stop.child_token()));
    }

    pub(crate) async fn producer(&self) -> Option<tokio::sync::MutexGuard<'_, ()>> {
        let guard = self.producer_gate.lock().await;
        (!self.stop.is_cancelled()).then_some(guard)
    }

    pub(crate) async fn return_route(&self, source: &Invocation) -> Result<ReturnRoute, String> {
        let runs = self.runs.lock().await;
        let control = runs
            .controls
            .get(&source.session_id)
            .ok_or("workhub_source_inactive")?;
        if control.invocation != *source || control.failure.is_some() {
            return Err("workhub_source_changed".into());
        }
        Ok(ReturnRoute {
            model: control
                .basis
                .model
                .clone()
                .ok_or("workhub_model_unavailable")?,
            workspace: control.basis.workspace.clone(),
            binding: control.basis.binding,
        })
    }

    pub(crate) async fn prepare_notification(
        &self,
        source: &Invocation,
        route: &ReturnRoute,
        identity: &str,
        render: impl FnOnce(Language) -> String,
        origin: MessageOrigin,
    ) -> Result<Option<PendingMessageAdmission>, String> {
        let runs = self.runs.lock().await;
        if runs.closing || self.stop.is_cancelled() {
            return Err("agent_closed".into());
        }
        if runs.busy(&source.session_id) {
            return Ok(None);
        }
        let session = match self.session(&source.session_id).await {
            Ok(session) => session,
            Err(error) if error == "agent_session_unavailable" => return Ok(None),
            Err(error) => return Err(error),
        };
        if session.archived
            || session.configuration.workspace != route.workspace
            || session.configuration.binding != route.binding
        {
            return Ok(None);
        }
        if workspace::validate(
            &self.workspace_roots,
            &route.workspace,
            &self.managed_worktrees,
        )
        .await
        .is_err()
        {
            return Ok(None);
        }
        let snapshot = self
            .configuration
            .runtime_policy()
            .await
            .map_err(|_| "agent_preferences_unavailable")?;
        let language = self.resolve_language(&snapshot);
        let text = render(language);
        drop(runs);
        let mcp_revision = self.mcp_projects.capture(&route.workspace).await?;
        let runs = self.runs.lock().await;
        if runs.closing || self.stop.is_cancelled() {
            return Err("agent_closed".into());
        }
        let current = self.session(&source.session_id).await?;
        if runs.busy(&source.session_id)
            || current.configuration != session.configuration
            || current.archived
        {
            return Ok(None);
        }

        let selected_catalog = self.mcp_projects.catalog(mcp_revision.as_deref())?;
        let mut basis = MessageBasis {
            mcp_revision,
            language,
            compaction_prompt: Some(self.effective_compaction_prompt(
                session.configuration.compaction_prompt.as_deref(),
                &snapshot,
                language,
            )),
            graph: None,
            collaboration_mode: session.configuration.collaboration_mode,
            background_kind: BackgroundKind::Schedule,
            tool_discovery: self.settings.tool_discovery,
            allowed_tools: session.configuration.tools.clone(),
            background: None,
            model: Some(route.model.clone()),
            executor: None,
            workspace: route.workspace.clone(),
            binding: session.configuration.binding,
            fingerprint: hex::encode(Sha256::digest(text.as_bytes())),
            tools: self.tool_basis.clone(),
            internal_tools: selected_catalog.definitions.clone(),
            internal_bindings: selected_catalog.bindings.clone(),
            behavior: self.bot_behavior(
                &source.session_id,
                self.capture_behavior(&route.workspace, &snapshot, language)
                    .await?,
                &snapshot,
                language,
            ),
        };
        self.prepare_plan_behavior(&source.session_id, &mut basis)
            .await?;
        self.prepare_graph_behavior(&source.session_id, &mut basis, false)
            .await?;
        let message: MessageInput = text.into();
        let delivered = RootSourceMessage {
            message: DeliveredMessage {
                origin: Some(origin),
                message_id: format!("m_{identity}"),
                submitted_content_digest: message
                    .content_digest()
                    .map_err(|_| "agent_message_invalid")?,
                content: message.clone(),
            },
            unprepared_content: message,
            submitted_placement: Placement::CurrentTurn,
            disposition: MessageDisposition::TurnStarted,
            submitted_intent: None,
        };
        Ok(Some(PendingMessageAdmission {
            execution: PendingExecution {
                owner: self.prefix.clone(),
                basis: serde_json::to_value(basis).map_err(|_| "agent_message_basis_invalid")?,
            },
            invocation: Invocation {
                session_id: source.session_id.clone(),
                turn_id: format!("t_{identity}"),
                run_id: format!("r_{identity}"),
                invocation_id: format!("i_{identity}"),
            },
            steering_invocation: None,
            source: delivered,
            required_tools: Default::default(),
            admitted_at: now(),
        }))
    }

    /// Reopening a frozen notification consults original acceptance, delivery and
    /// cancellation. SQL uncertainty never creates a replacement message identity.
    pub(crate) async fn admit_notification(
        self: &Arc<Self>,
        admission: &PendingMessageAdmission,
    ) -> Result<bool, String> {
        let session = &admission.invocation.session_id;
        let message = &admission.source.message.message_id;
        if admission.execution.owner != self.prefix || !self.owns(session) {
            return Err("agent_queue_owner_invalid".into());
        }
        let ordered = self.runs.ordered(session).await;
        if self
            .store
            .session(session)
            .await
            .map_err(|error| error.to_string())?
            .root_message(session, message)
            .await
            .map_err(|_| "agent_queue_unavailable")?
            .is_some()
            || self
                .store
                .session(session)
                .await
                .map_err(|error| error.to_string())?
                .message_cancelled(session, message)
                .await
                .map_err(|_| "agent_queue_unavailable")?
        {
            return Ok(true);
        }
        let original = self
            .store
            .session(session)
            .await
            .map_err(|error| error.to_string())?
            .message_admission(session, message)
            .await
            .map_err(|_| "agent_queue_unavailable")?;
        if let Some(original) = &original
            && original != admission
        {
            return Err("agent_message_identity_changed".into());
        }
        let cancellation = self.stop.child_token();
        {
            let mut runs = ordered.state().await;
            if runs.closing || self.stop.is_cancelled() {
                return if original.is_some() {
                    Ok(true)
                } else {
                    Err("agent_closed".into())
                };
            }
            if runs.busy(session) {
                return Ok(original.is_some());
            }
            runs.preparing.insert(session.clone(), cancellation.clone());
        }
        let accepted = async {
            if original.is_some() {
                return Ok(true);
            }
            let current = match self.session(session).await {
                Ok(session) => session,
                Err(error) if error == "agent_session_unavailable" => return Ok(false),
                Err(error) => return Err(error),
            };
            let basis: MessageBasis = serde_json::from_value(admission.execution.basis.clone())
                .map_err(|_| "agent_message_basis_invalid")?;
            self.validate_background(&basis).await?;
            basis.validate_background_target(&current)?;
            if current.archived
                || current.configuration.workspace != basis.workspace
                || current.configuration.binding != basis.binding
            {
                return Ok(false);
            }
            self.store
                .session(&admission.invocation.session_id)
                .await
                .map_err(|error| error.to_string())?
                .admit_message(admission.clone())
                .await
                .map_err(|_| "agent_admission_unknown")?;
            Ok(true)
        }
        .await;
        match accepted {
            Ok(true) => {}
            result => {
                ordered.state().await.preparing.remove(session);
                return result;
            }
        }
        self.start_pending(session, ordered, cancellation)
            .await
            .map_err(public_error)?;
        Ok(true)
    }
}
