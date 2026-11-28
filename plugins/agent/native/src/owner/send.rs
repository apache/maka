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
use crate::executor::ActiveDelivery;
use maka_agent_facts::durable::{BackendSpec, ExecutionIdentity, UnixMillis};
use maka_agent_state::queue::{
    Followup, Placement as QueuePlacement, PreparedEnqueue, QueueCommand, QueueEdit,
};
use maka_event_log::{
    StoreError,
    root_store::completions::RegisterCompletion,
    writeback::{Prepared, Statement},
};

/// An inert Root statement and its exact reply. Host commits both together.
pub(crate) enum NativeMutation<T> {
    Returned(T),
    Commit {
        value: T,
        change: maka_event_log::root_store::DataChange,
    },
    Computed {
        change: maka_event_log::root_store::DataChange,
    },
}
impl<T> NativeMutation<T> {
    pub(crate) fn map_fixed<U>(self, f: impl FnOnce(T) -> U) -> Result<NativeMutation<U>, String> {
        match self {
            Self::Returned(value) => Ok(NativeMutation::Returned(f(value))),
            Self::Commit { value, change } => Ok(NativeMutation::Commit {
                value: f(value),
                change,
            }),
            Self::Computed { .. } => Err("agent_computed_mutation_requires_typed_statement".into()),
        }
    }
}
impl<T: serde::Serialize> NativeMutation<T> {
    pub(crate) fn complete(
        self,
        context: &maka_host_runtime::application::Context,
    ) -> Result<maka_host_runtime::application::HandlerValue, String> {
        match self {
            Self::Returned(value) => Ok(maka_host_runtime::application::HandlerValue::Json(
                serde_json::to_value(value).map_err(|e| e.to_string())?,
            )),
            Self::Commit { value, change } => context.complete_change(
                serde_json::to_value(value).map_err(|e| e.to_string())?,
                change,
            ),
            Self::Computed { change } => context.complete_result(change),
        }
    }
}
pub(super) enum PreparedSend {
    Returned(SendResult),
    Ready {
        value: SendResult,
        statement: Box<PreparedAgentSend>,
    },
}

pub(super) struct PreparedAgentSend {
    pub queue: PreparedEnqueue,
    pub completion: Option<RegisterCompletion>,
    pub order: Option<Arc<runs::Ordered>>,
}

impl PreparedAgentSend {
    fn validate_workspace(&self, connection: &rusqlite::Connection) -> Result<(), StoreError> {
        let QueueEdit::Enqueue { request, .. } = &self.queue.command.edit else {
            return Ok(());
        };
        // A send can be prepared before the rebind and settle after it.
        let current =
            maka_event_log::workspace_bindings::permission_basis(connection, &self.queue.session)?;
        if current.as_ref() != Some(&request.spec.permission_basis) {
            return Err(StoreError::InvalidTransition(
                "agent_session_workspace_changed".into(),
            ));
        }
        Ok(())
    }

    pub(super) fn execute_for_room(
        self,
        connection: &rusqlite::Connection,
    ) -> Result<Prepared<maka_agent_state::queue::QueueCommit>, StoreError> {
        self.validate_workspace(connection)?;
        let mut queued = self.queue.execute_for_room(connection)?;
        if let Some(completion) = self.completion {
            let registered = completion.execute(connection)?;
            queued.changed |= registered.changed;
            queued.notification = queued.notification.combine(registered.notification);
        }
        Ok(queued)
    }
}

impl Statement for PreparedAgentSend {
    type Value = maka_agent_state::queue::QueueCommit;
    type Output = maka_agent_state::queue::QueueCommit;

    fn retain(&self) -> Vec<Arc<dyn std::marker::Send + Sync>> {
        let mut retained = self.queue.retain();
        if let Some(order) = &self.order {
            retained.push(order.clone());
        }
        retained
    }

    fn execute(
        self,
        connection: &rusqlite::Connection,
    ) -> Result<Prepared<Self::Value>, StoreError> {
        self.validate_workspace(connection)?;
        let mut queued = self.queue.execute(connection)?;
        if let Some(completion) = self.completion {
            let registered = completion.execute(connection)?;
            queued.changed |= registered.changed;
            queued.notification = queued.notification.combine(registered.notification);
        }
        Ok(queued)
    }

    fn committed(value: Self::Value) -> Self::Output {
        value
    }

    fn isolated_rejection(error: &StoreError) -> bool {
        PreparedEnqueue::isolated_rejection(error)
    }
}

#[derive(Debug)]
pub(super) enum CaptureError {
    ModelUnavailable,
    AuthenticationRequired,
    WorkspaceUnavailable,
    RouteChanged,
    Other(String),
}
impl From<String> for CaptureError {
    fn from(error: String) -> Self {
        match error.as_str() {
            "agent_workspace_unavailable" => Self::WorkspaceUnavailable,
            _ => Self::Other(error),
        }
    }
}
impl From<&str> for CaptureError {
    fn from(error: &str) -> Self {
        Self::from(error.to_owned())
    }
}
impl From<CaptureError> for String {
    fn from(error: CaptureError) -> Self {
        match error {
            CaptureError::ModelUnavailable => "agent_model_unavailable".into(),
            CaptureError::AuthenticationRequired => "agent_authentication_required".into(),
            CaptureError::WorkspaceUnavailable => "agent_workspace_unavailable".into(),
            CaptureError::RouteChanged => "notification_route_changed".into(),
            CaptureError::Other(error) => error,
        }
    }
}

pub(super) fn finish_capture(
    capture: Result<CapturedRun, CaptureError>,
    cleanup: Result<(), String>,
) -> Result<CapturedRun, CaptureError> {
    match cleanup {
        Ok(()) => capture,
        Err(cleanup) => Err(CaptureError::Other(format!(
            "{}; background preparation cleanup: {cleanup}",
            capture.err().map(String::from).unwrap_or_default()
        ))),
    }
}

pub(super) enum PinCapture {
    Excluded,
    Queued,
    NewRun,
}

impl Owner {
    pub(super) async fn capture_current_run(
        &self,
        id: &str,
        selection: Option<BackendPreference>,
        fingerprint: String,
        pins: PinCapture,
        parent: &maka_capabilities::call::Scope,
    ) -> Result<CapturedRun, CaptureError> {
        self.require_execution(id).await?;
        if parent.cancellation.is_cancelled() || self.stop.is_cancelled() {
            return Err("agent_closed".into());
        }
        if self
            .rooms()?
            .exists(id)
            .await
            .map_err(|error| error.to_string())?
        {
            return Err("agent_room_has_no_backend".into());
        }
        if self.settings.bot {
            self.bot.load().await.map_err(|error| error.to_string())?;
        }
        let session = self.mutable_session(id).await?;
        if session.archived {
            return Err("agent_session_configuration_changed".into());
        }
        workspace::validate(
            &self.workspace_roots,
            &session.configuration.workspace,
            &self.managed_worktrees,
        )
        .await?;
        let mut selection = selection.or_else(|| session.configuration.backend.clone());
        if session.configuration.applied_preset.is_none() {
            selection = self.use_bot_model(parent, selection).await?;
        }
        let selection = selection.ok_or(CaptureError::ModelUnavailable)?;
        let (model, executor) = match selection {
            BackendPreference::Model {
                connection_id,
                model_id,
                service_tier,
                thinking_level,
            } => {
                let source = crate::model::Source::select(
                    self.configuration.clone(),
                    self.catalog.clone(),
                    self.credentials.clone(),
                    ModelSelection {
                        connection_id,
                        model_id,
                        service_tier,
                    },
                    thinking_level,
                    id.to_owned(),
                    self.revision.clone(),
                )
                .await
                .map_err(|error| match error {
                    RunError::ModelUnavailable => CaptureError::ModelUnavailable,
                    RunError::AuthenticationRequired => CaptureError::AuthenticationRequired,
                    error => CaptureError::Other(public_error(error)),
                })?;
                (Some(source.accepted), None)
            }
            BackendPreference::Executor { selection } => {
                if self.store.checkpoint_execution().is_some() {
                    return Err("execution_grant_requires_native_model_backend".into());
                }
                let backend = self.executors.select(selection)?;
                (None, Some(backend.accepted))
            }
        };
        let external = executor.is_some();
        let host_bridge = executor
            .as_ref()
            .is_some_and(|executor| executor.selection.executor == "external");
        let snapshot = self
            .configuration
            .runtime_policy()
            .await
            .map_err(|_| "agent_preferences_unavailable")?;
        let language = self.resolve_language(&snapshot);
        let mcp_floor = self
            .capture_sandbox(&session.configuration, parent.sandbox_floor())
            .await?;
        let read_only_discovery =
            self.scheduler.investigation_profile(id) == Some(DiscoveryWorkerTools::ReadOnly);
        let selected_catalog = if read_only_discovery || (external && !host_bridge) {
            self.mcp_projects.base.clone()
        } else {
            match self
                .mcp_projects
                .prepare(&session.configuration.workspace, &mcp_floor)
                .await?
            {
                crate::mcp::Prepared::Ready(catalog) => catalog,
                crate::mcp::Prepared::Startup(proposal) => {
                    self.mcp_projects.start(*proposal, &mcp_floor).await?
                }
            }
        };
        let selected_catalog = if read_only_discovery {
            selected_catalog
        } else {
            self.mcp_projects.with_client(id, selected_catalog)?
        };
        if external && !host_bridge && selected_catalog.revision.is_some() {
            return Err("agent_executor_cannot_use_session_mcp".into());
        }
        let allowed_tools = self.admitted_tools(id, &session.configuration.tools);
        let behavior = self.bot_behavior(
            id,
            self.capture_behavior(
                (!host_bridge).then_some(&session.configuration.workspace),
                &snapshot,
                language,
                session.configuration.applied_preset.as_ref(),
            )
            .await?,
            &snapshot,
            language,
            allowed_tools.as_deref(),
        );
        let user_run = !external
            && !matches!(pins, PinCapture::Excluded)
            && matches!(
                parent.identity,
                maka_capabilities::call::Identity::Native
                    | maka_capabilities::call::Identity::Remote { .. }
            );
        let memory_admission =
            self.memory_admission(id, &session.configuration, user_run, &snapshot);
        let memory = if matches!(pins, PinCapture::NewRun)
            && memory_admission == maka_agent_facts::memory::MemoryAdmission::Enabled
        {
            self.capture_pinned(id, &session.configuration, snapshot.revision)
                .await?
        } else {
            None
        };
        let basis = CapturedRun {
            memory_admission,
            memory,
            mcp_revision: selected_catalog.revision.clone(),
            client_mcp: selected_catalog.client_mcp,
            mcp_catalog: Some(selected_catalog.clone()),
            language,
            compaction_prompt: Some(self.effective_compaction_prompt(
                session.configuration.compaction_prompt.as_deref(),
                &snapshot,
                language,
            )),
            collaboration_mode: session.configuration.collaboration_mode,
            background_kind: BackgroundKind::Interactive,
            tool_discovery: (!external || host_bridge)
                && !read_only_discovery
                && self.settings.tool_discovery,
            allowed_tools,
            background: None,
            background_sandbox_ceiling: None,
            internal_bindings: if external && !host_bridge {
                Arc::default()
            } else {
                selected_catalog.bindings.clone()
            },
            behavior,
            model,
            executor,
            workspace: session.configuration.workspace.clone(),
            binding: session.configuration.binding,
            fingerprint,
        };
        Ok(basis)
    }

    pub async fn send(
        self: &Arc<Self>,
        input: Send,
        operation: &maka_plugin_core::operation::RecoveryRef,
        parent: &maka_capabilities::call::Scope,
    ) -> Result<NativeMutation<SendResult>, String> {
        if input.quotes.len() > 16 || input.quotes.iter().any(|q| q.text.trim().is_empty()) {
            return Err("agent_message_invalid".into());
        }
        if self
            .rooms()?
            .exists(&input.session_id)
            .await
            .map_err(|error| error.to_string())?
        {
            return self.send_room(input, operation, parent).await;
        }
        if !input.mentions.is_empty() || input.reply_to.is_some() {
            return Err("agent_room_message_required".into());
        }
        let key = self.send_key(operation, &input.session_id);
        match self
            .prepare_user_send(input, &key, operation, parent)
            .await?
        {
            PreparedSend::Returned(value) => Ok(NativeMutation::Returned(value)),
            PreparedSend::Ready { value, statement } => Ok(NativeMutation::Commit {
                value,
                change: self.message_writer(parent)?.prepare(*statement),
            }),
        }
    }

    pub(super) async fn prepare_user_send(
        self: &Arc<Self>,
        mut input: Send,
        key: &str,
        operation: &maka_plugin_core::operation::RecoveryRef,
        parent: &maka_capabilities::call::Scope,
    ) -> Result<PreparedSend, String> {
        let mut message: MessageInput = std::mem::take(&mut input.message).into();
        message.quotes = (!input.quotes.is_empty()).then(|| std::mem::take(&mut input.quotes));
        message.attachments = self
            .attachment_refs(
                &input.session_id,
                std::mem::take(&mut input.attachments),
                parent,
            )
            .await?;
        let origin = parent
            .identity
            .agent()
            .map(|execution| MessageOrigin::Session {
                execution: execution.clone(),
            });
        self.prepare_agent_send(input, message, origin, key, operation, parent)
            .await
    }

    pub(super) fn send_key(
        &self,
        operation: &maka_plugin_core::operation::RecoveryRef,
        target: &str,
    ) -> String {
        let target = hex::encode(Sha256::digest(target.as_bytes()));
        format!("{}_{}", self.operation_id(operation), &target[..16])
    }

    pub(super) async fn prepare_agent_send(
        self: &Arc<Self>,
        input: Send,
        unprepared: MessageInput,
        origin: Option<MessageOrigin>,
        key: &str,
        operation: &maka_plugin_core::operation::RecoveryRef,
        parent: &maka_capabilities::call::Scope,
    ) -> Result<PreparedSend, String> {
        self.require_execution(&input.session_id).await?;
        if !self.may_control(parent, &input.session_id).await? {
            return Ok(PreparedSend::Returned(SendResult::NotYourWorker {
                session_id: input.session_id,
            }));
        }
        let completion_request = self
            .completion_request(parent, &input.session_id, input.on_complete)
            .await?;
        let Send {
            session_id: id,
            message: _,
            quotes: _,
            backend,
            attachments: _,
            delivery,
            expected_run_id,
            on_complete: _,
            mentions: _,
            reply_to: _,
        } = input;
        let delivery = delivery.unwrap_or(SendDelivery::Steer);
        if !unprepared.has_content() {
            return Err("agent_message_invalid".into());
        }
        let admission = self.runs.session(&id).await;
        if admission.state().await.closing || self.stop.is_cancelled() {
            return Err("agent_closed".into());
        }
        let latest = self.latest_session_run(&id).await?;
        let handoff = match (&latest, delivery) {
            (Some(view), SendDelivery::Steer) => self
                .durable
                .queue()
                .interrupt_handoff(view)
                .await
                .map_err(|error| error.to_string())?,
            _ => None,
        };
        if let Some(expected) = expected_run_id
            && handoff.is_none_or(|h| h.interrupted() != expected)
        {
            let view = self
                .session_run(&id, expected)
                .await?
                .ok_or("agent_execution_unavailable")?;
            if view.stopped || view.terminal.is_some() {
                return Ok(PreparedSend::Returned(SendResult::Rejected {
                    session_id: id,
                    reason: SendRejection::TurnStopped,
                    skills: None,
                }));
            }
        }
        if latest.as_ref().is_some_and(|view| view.blocks_followup()) {
            return Ok(PreparedSend::Returned(SendResult::Rejected {
                session_id: id,
                reason: SendRejection::OriginalOperationUnsettled,
                skills: None,
            }));
        }
        let mut after_stop = None;
        let active = if handoff.is_some() {
            latest
        } else if latest.as_ref().is_some_and(|view| view.stopped) {
            if admission.state().await.busy(&id) {
                return Err("agent_admission_failed".into());
            }
            after_stop = Some(
                self.store
                    .try_session_work_fence(&id)
                    .await
                    .map_err(|_| "agent_admission_failed")?
                    .ok_or("agent_admission_failed")?,
            );
            None
        } else {
            latest.filter(|view| view.terminal.is_none())
        };
        let active_delivery = match (&active, delivery, handoff) {
            (Some(view), SendDelivery::Steer, None) => self.active_delivery(view).await?,
            _ => ActiveDelivery::Queue,
        };
        let mut backend = backend;
        let followup = active.as_ref().map(|view| {
            if handoff.is_some() || matches!(active_delivery, ActiveDelivery::InterruptResume) {
                if let BackendSpec::Executor { selection, .. } = &view.spec.backend {
                    backend.get_or_insert_with(|| BackendPreference::Executor {
                        selection: selection.clone(),
                    });
                }
                if let Some(handoff) = handoff {
                    return Followup::Resume(handoff);
                }
                Followup::Interrupt {
                    run: view.run,
                    stop: self.control_id(operation, &format!("{key}:steering_interrupt")),
                }
            } else {
                Followup::Queued(view.run)
            }
        });
        let pins = if origin.is_some() {
            PinCapture::Excluded
        } else if active.is_some() {
            PinCapture::Queued
        } else {
            PinCapture::NewRun
        };
        let user_message = origin.is_none()
            && matches!(
                parent.identity,
                maka_capabilities::call::Identity::Native
                    | maka_capabilities::call::Identity::Remote { .. }
            );
        let mut basis = match self
            .capture_current_run(&id, backend, operation.fingerprint.clone(), pins, parent)
            .await
        {
            Ok(basis) => basis,
            Err(error @ (CaptureError::ModelUnavailable | CaptureError::WorkspaceUnavailable)) => {
                return Ok(PreparedSend::Returned(SendResult::Rejected {
                    session_id: id,
                    reason: match error {
                        CaptureError::WorkspaceUnavailable => SendRejection::WorkspaceUnavailable,
                        _ => SendRejection::ModelUnavailable,
                    },
                    skills: None,
                }));
            }
            Err(error) => return Err(error.into()),
        };
        // A queued spec records the submitter's eligibility. Mutable session
        // settings and the projection are selected when it starts a Run.
        let queued_eligibility = if user_message {
            maka_agent_facts::memory::MemoryAdmission::Disabled
        } else {
            maka_agent_facts::memory::MemoryAdmission::Excluded
        };
        if let (Some(view), ActiveDelivery::Steer) = (&active, active_delivery) {
            basis.memory_admission = queued_eligibility;
            let execution = ExecutionIdentity {
                session_id: id.clone(),
                turn_id: view.spec.turn_id.clone(),
                run_id: view.run,
            };
            return self
                .steer_message(
                    unprepared,
                    origin,
                    key,
                    &execution,
                    &basis,
                    operation,
                    parent,
                    completion_request,
                )
                .await;
        }
        // Check known fixed inputs for immediate feedback. The queue carries only
        // eligibility; the scheduler freezes the projection for the actual Run.
        self.check_pinned_model(&id, &basis)?;
        basis.memory = None;
        basis.memory_admission = queued_eligibility;
        let (message, required_tools) = match self
            .prepare_skills(
                unprepared.clone(),
                basis.language,
                Some(basis.workspace.clone()),
                parent,
                self.skill_tool_names(
                    &id,
                    &basis,
                    basis.model.as_ref().and_then(|m| m.editing_tools),
                )?,
            )
            .await?
        {
            skills::Input::Ready {
                message,
                required_tools,
            } => (message, required_tools),
            skills::Input::Rejected { reason, skills } => {
                return Ok(PreparedSend::Returned(SendResult::Rejected {
                    session_id: id,
                    reason,
                    skills,
                }));
            }
        };
        let source = RootSourceMessage {
            message: DeliveredMessage {
                origin,
                message_id: format!("m_{key}"),
                submitted_content_digest: unprepared.content_digest().map_err(|e| e.to_string())?,
                content: message,
            },
            unprepared_content: unprepared,
            submitted_placement: if active.is_some() {
                Placement::NextTurn
            } else {
                Placement::CurrentTurn
            },
            disposition: if active.is_some() {
                MessageDisposition::Followup
            } else {
                MessageDisposition::TurnStarted
            },
            submitted_intent: None,
        };
        let message_id = source.message.message_id.clone();
        let (request, contents) = self
            .freeze_request(&id, source, &basis, required_tools, key, operation, parent)
            .await?;
        let revision = self
            .durable
            .queue()
            .revision(id.clone())
            .await
            .map_err(|e| e.to_string())?;
        let command = QueueCommand {
            id: self.control_id(operation, &format!("{key}:send")),
            at: UnixMillis(now().try_into().map_err(|_| "invalid clock")?),
            expected_revision: revision,
            edit: QueueEdit::Enqueue {
                request: Box::new(request),
                placement: QueuePlacement::Followup,
            },
        };
        let completion = completion_request
            .as_ref()
            .map(|_| CompletionRegistration::Registered);
        let completion_statement = completion_request
            .map(|request| self.completion_statement(&id, &message_id, request))
            .transpose()?;
        // Keep the scheduler and notification producers behind the steering receipt.
        let order = matches!(
            followup,
            Some(Followup::Interrupt { .. } | Followup::Resume(_))
        )
        .then(|| Arc::new(admission.into_ordered()));
        let statement = PreparedAgentSend {
            queue: PreparedEnqueue {
                session: id.clone(),
                command,
                contents,
                followup,
                work_fence: after_stop.map(Arc::new),
            },
            completion: completion_statement,
            order,
        };
        Ok(PreparedSend::Ready {
            value: SendResult::Queued {
                completion,
                session_id: id,
                message_id,
                revision: revision
                    .checked_add(1)
                    .ok_or("agent_queue_revision_exhausted")?,
            },
            statement: Box::new(statement),
        })
    }
}
