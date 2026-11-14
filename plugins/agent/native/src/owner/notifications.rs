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

//! Background follow-ups use the original Agent admission gate and durable queue.
use super::*;
use maka_agent_facts::durable::{ExecutionIdentity, FactId, UnixMillis};
use maka_agent_facts::message::MessageOrigin;
use maka_agent_state::{
    ContentBlob,
    queue::{
        MessageResolution, Placement as QueuePlacement, PreparedRequest, QueueCommand, QueueEdit,
        RequestId,
    },
};

/// Captured policy for background execution.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct BackgroundApproval {
    pub(super) target: ScheduledTarget,
    pub(super) model: ModelSelection,
    pub(super) accepted_model: crate::model::AcceptedModel,
    pub(super) thinking_level: Option<ThinkingLevel>,
    pub(super) language: Language,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) sandbox_ceiling: Option<maka_sandbox::Sandbox>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub(super) enum NotificationBackend {
    Model {
        model: ModelSelection,
        thinking_level: Option<ThinkingLevel>,
    },
    Executor {
        selection: maka_agent_facts::executor::Selection,
    },
}
impl NotificationBackend {
    pub(super) fn preference(&self) -> BackendPreference {
        match self {
            Self::Model {
                model,
                thinking_level,
            } => BackendPreference::Model {
                connection_id: model.connection_id.clone(),
                model_id: model.model_id.clone(),
                thinking_level: *thinking_level,
            },
            Self::Executor { selection } => BackendPreference::Executor {
                selection: selection.clone(),
            },
        }
    }
}

pub(crate) struct ReturnRoute {
    pub(super) backend: NotificationBackend,
    model: Option<crate::model::AcceptedModel>,
    pub(crate) workspace: Workspace,
    pub(crate) binding: maka_sandbox::workspace::BindingStamp,
}
impl ReturnRoute {
    pub(crate) fn new(
        model: crate::model::AcceptedModel,
        workspace: Workspace,
        binding: maka_sandbox::workspace::BindingStamp,
    ) -> Self {
        let backend = NotificationBackend::Model {
            model: ModelSelection {
                connection_id: model.binding.connection_id.clone(),
                model_id: model.binding.model.clone(),
            },
            thinking_level: model.thinking_level,
        };
        Self {
            backend,
            model: Some(model),
            workspace,
            binding,
        }
    }
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

    pub(crate) async fn return_route(
        &self,
        source: &ExecutionIdentity,
    ) -> Result<ReturnRoute, String> {
        let view = self
            .session_run(&source.session_id, source.run_id)
            .await?
            .ok_or("notification_source_inactive")?;
        let session = self.session(&source.session_id).await?;
        if view.spec.turn_id != source.turn_id
            || view.stopped
            || view.terminal.is_some()
            || session.configuration.permission_basis() != view.spec.permission_basis
        {
            return Err("notification_source_changed".into());
        }
        use maka_agent_facts::durable::BackendSpec;
        let workspace = session.configuration.workspace;
        let binding = view.spec.permission_basis.binding;
        match &view.spec.backend {
            BackendSpec::Model { descriptor, .. } => {
                let bytes = self
                    .durable
                    .content(source.run_id, descriptor.clone())
                    .await
                    .map_err(|error| error.to_string())?;
                let model = crate::model::AcceptedModel::from_backend(&view.spec.backend, &bytes)
                    .map_err(public_error)?;
                Ok(ReturnRoute::new(model, workspace, binding))
            }
            BackendSpec::Executor { selection, .. } if selection.executor == "external" => {
                Ok(ReturnRoute {
                    backend: NotificationBackend::Executor {
                        selection: selection.clone(),
                    },
                    model: None,
                    workspace,
                    binding,
                })
            }
            _ => Err("notification_backend_unavailable".into()),
        }
    }

    pub(super) async fn resolve_notification_route(
        &self,
        backend: NotificationBackend,
        session: &str,
        workspace: Workspace,
        binding: maka_sandbox::workspace::BindingStamp,
    ) -> Result<ReturnRoute, String> {
        match backend {
            NotificationBackend::Model {
                model,
                thinking_level,
            } => {
                let (model, _) = crate::model::Source::select(
                    self.configuration.clone(),
                    self.catalog.clone(),
                    self.credentials.clone(),
                    model,
                    thinking_level,
                    session.to_owned(),
                    self.revision.clone(),
                )
                .await
                .map_err(public_error)?;
                Ok(ReturnRoute::new(model.accepted, workspace, binding))
            }
            backend @ NotificationBackend::Executor { .. } => Ok(ReturnRoute {
                backend,
                model: None,
                workspace,
                binding,
            }),
        }
    }

    pub(crate) async fn prepare_notification(
        &self,
        source: &ExecutionIdentity,
        route: &ReturnRoute,
        identity: &str,
        render: impl FnOnce(Language) -> String,
        origin: MessageOrigin,
    ) -> Result<Option<PreparedRequest>, String> {
        let placement = if matches!(origin, MessageOrigin::SessionCompletion { .. }) {
            QueuePlacement::Completion {
                caller: source.run_id,
            }
        } else {
            QueuePlacement::Followup
        };
        self.prepare_notification_checked(
            &source.session_id,
            route,
            identity,
            render,
            origin,
            placement,
            None,
        )
        .await
    }
    pub(super) async fn prepare_notification_checked(
        &self,
        session_id: &str,
        route: &ReturnRoute,
        identity: &str,
        render: impl FnOnce(Language) -> String,
        origin: MessageOrigin,
        placement: QueuePlacement,
        boundary: Option<&ScheduledTarget>,
    ) -> Result<Option<PreparedRequest>, String> {
        if let Some(original) = self
            .durable
            .queue()
            .entry(session_id.to_owned(), RequestId(identity.into()))
            .await
            .map_err(|e| e.to_string())?
        {
            return Ok(Some(original.request));
        }
        if self.stop.is_cancelled() {
            return Err("agent_closed".into());
        }
        let session = self.session(session_id).await?;
        if session.archived
            || session.configuration.workspace != route.workspace
            || session.configuration.binding != route.binding
        {
            return Ok(None);
        }
        // A current native scope owns preparation. The stored route only selects data;
        // current Session/workspace gates and the issuer determine actual authority.
        let native = self
            .services
            .request(
                maka_capabilities::call::Identity::Native,
                self.stop.child_token(),
            )
            .map_err(|e| e.to_string())?;
        let capture = self
            .capture_current_run(
                session_id,
                Some(route.backend.preference()),
                identity.to_owned(),
                native.scope(),
            )
            .await;
        let cleanup = native.finish().await;
        let mut basis = match (capture, cleanup) {
            (Ok(basis), Ok(())) => basis,
            (Err(error), Ok(())) => return Err(error.into()),
            (result, Err(cleanup)) => {
                return Err(format!(
                    "{}; background preparation cleanup: {cleanup}",
                    result.err().map(String::from).unwrap_or_default()
                ));
            }
        };
        if let Some(model) = &route.model {
            let current = basis
                .model
                .as_ref()
                .ok_or("notification_model_unavailable")?;
            if !model.same_execution_route(current) {
                return Err("notification_route_changed".into());
            }
            basis.model = Some(model.clone());
        }
        let message: MessageInput = render(basis.language).into();
        let source = RootSourceMessage {
            message: DeliveredMessage {
                origin: Some(origin),
                message_id: format!("m_{identity}"),
                submitted_content_digest: message.content_digest().map_err(|e| e.to_string())?,
                content: message.clone(),
            },
            unprepared_content: message,
            submitted_placement: Placement::CurrentTurn,
            disposition: MessageDisposition::TurnStarted,
            submitted_intent: None,
        };
        self.enqueue_background_checked(
            session_id,
            source,
            &basis,
            identity,
            Default::default(),
            placement,
            false,
            boundary,
        )
        .await
        .map(Some)
    }

    /// Original requests are observed, never re-frozen from a stored execution grant.
    pub(crate) async fn admit_notification(
        &self,
        request: &PreparedRequest,
    ) -> Result<bool, String> {
        if request.spec.owner != self.run_owner() || !self.owns(&request.spec.session_id) {
            return Err("agent_queue_owner_invalid".into());
        }
        let original = self
            .durable
            .queue()
            .entry(request.spec.session_id.clone(), request.id.clone())
            .await
            .map_err(|e| e.to_string())?
            .ok_or("agent_notification_missing")?;
        // Queue edits may replace content while preserving the admitted identity.
        if original.request.message_id != request.message_id
            || original.request.spec.owner != request.spec.owner
            || original.request.spec.turn_id != request.spec.turn_id
        {
            return Err("agent_message_identity_changed".into());
        }
        Ok(!matches!(
            self.durable
                .queue()
                .resolve_message(request.spec.session_id.clone(), request.message_id.clone())
                .await
                .map_err(|e| e.to_string())?,
            MessageResolution::Missing
        ))
    }

    pub(super) async fn enqueue_background(
        &self,
        session: &str,
        source: RootSourceMessage,
        basis: &CapturedRun,
        key: &str,
        required_tools: BTreeSet<String>,
        placement: QueuePlacement,
        steer: bool,
    ) -> Result<PreparedRequest, String> {
        self.enqueue_background_checked(
            session,
            source,
            basis,
            key,
            required_tools,
            placement,
            steer,
            None,
        )
        .await
    }
    async fn enqueue_background_checked(
        &self,
        session: &str,
        source: RootSourceMessage,
        basis: &CapturedRun,
        key: &str,
        required_tools: BTreeSet<String>,
        mut placement: QueuePlacement,
        steer: bool,
        boundary: Option<&ScheduledTarget>,
    ) -> Result<PreparedRequest, String> {
        let _ordered = self.runs.ordered(session).await;
        let queue = self.durable.queue();
        if let Some(original) = queue
            .entry(session.to_owned(), RequestId(key.into()))
            .await
            .map_err(|e| e.to_string())?
        {
            return Ok(original.request);
        }
        self.validate_background(basis).await?;
        let current = self.session(session).await?;
        basis.validate_background_target(&current)?;
        if let Some(boundary) = boundary {
            discovery::check_target(&current, boundary)?;
        }
        let native = self
            .services
            .request(
                maka_capabilities::call::Identity::Native,
                self.stop.child_token(),
            )
            .map_err(|e| e.to_string())?;
        let native = match &basis.background_sandbox_ceiling {
            Some(ceiling) => native.with_sandbox_floor(ceiling)?,
            None => native,
        };
        let frozen = self
            .freeze_background_request(session, source, basis, required_tools, key, native.scope())
            .await;
        let cleanup = native.finish().await;
        let (request, contents): (PreparedRequest, Vec<ContentBlob>) = match (frozen, cleanup) {
            (Ok(frozen), Ok(())) => frozen,
            (Err(error), Ok(())) => return Err(error),
            (result, Err(cleanup)) => {
                return Err(format!(
                    "{}; background request cleanup: {cleanup}",
                    result.err().unwrap_or_default()
                ));
            }
        };
        if steer {
            let control = self.runs.state().await.controls.get(session).cloned();
            if let Some(control) = control
                && control.basis.model.is_some()
                && let Some(view) = self.session_run(session, control.execution.run_id).await?
                && !view.stopped
                && view.terminal.is_none()
                && view.spec.permission_basis == request.spec.permission_basis
                && view.spec.workspace == request.spec.workspace
                && request
                    .spec
                    .permission_ceiling
                    .sandbox
                    .contains(&view.spec.permission_ceiling.sandbox)
                    .map_err(|error| error.to_string())?
                && request
                    .spec
                    .network_approval_ceiling()
                    .contains(view.spec.network_approval_ceiling())
                && view
                    .spec
                    .permission_ceiling
                    .approval
                    .is_subset_of(request.spec.permission_ceiling.approval)
            {
                placement = QueuePlacement::Steering {
                    run: view.run,
                    expected_head: maka_agent_state::Head::from(&view),
                };
            }
        }
        let current = queue
            .read(session.to_owned())
            .await
            .map_err(|e| e.to_string())?;
        let digest = Sha256::digest(format!("background-enqueue/{session}/{key}").as_bytes());
        let id = FactId::try_from(Uuid::from_bytes(
            digest[..16].try_into().expect("SHA-256 prefix"),
        ))
        .map_err(str::to_owned)?;
        queue
            .execute(
                session.to_owned(),
                QueueCommand {
                    id,
                    at: UnixMillis(0),
                    expected_revision: current.revision,
                    edit: QueueEdit::Enqueue {
                        request: Box::new(request.clone()),
                        placement,
                    },
                },
                contents,
            )
            .await
            .map_err(|e| e.to_string())?;
        self.wake_notify.notify_one();
        Ok(request)
    }
}
