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
use maka_agent_facts::durable::{BackendSpec, ExecutionIdentity, UnixMillis};
use maka_agent_state::queue::{Followup, Placement as QueuePlacement, QueueCommand, QueueEdit};

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
#[derive(Debug)]
pub(super) enum CaptureError {
    ModelUnavailable,
    Other(String),
}
impl From<String> for CaptureError {
    fn from(error: String) -> Self {
        Self::Other(error)
    }
}
impl From<&str> for CaptureError {
    fn from(error: &str) -> Self {
        Self::Other(error.into())
    }
}
impl From<CaptureError> for String {
    fn from(error: CaptureError) -> Self {
        match error {
            CaptureError::ModelUnavailable => "agent_model_unavailable".into(),
            CaptureError::Other(error) => error,
        }
    }
}

impl Owner {
    pub(super) async fn capture_current_run(
        &self,
        id: &str,
        selection: Option<BackendPreference>,
        fingerprint: String,
        parent: &maka_capabilities::call::Scope,
    ) -> Result<CapturedRun, CaptureError> {
        if parent.cancellation.is_cancelled() || self.stop.is_cancelled() {
            return Err("agent_closed".into());
        }
        if self.settings.bot {
            self.bot.load().await.map_err(|error| error.to_string())?;
        }
        let session = self.mutable_session(id).await?;
        if session.archived {
            return Err("agent_session_configuration_changed".into());
        }
        let mut selection = selection.or_else(|| session.configuration.backend.clone());
        if session.configuration.applied_preset.is_none() {
            selection = self.use_bot_model(parent, selection).await?;
        }
        let selection = selection.ok_or(CaptureError::ModelUnavailable)?;
        let (model, executor) = match selection {
            BackendPreference::Model {
                connection_id,
                model_id,
                thinking_level,
            } => {
                let (source, _) = crate::model::Source::select(
                    self.configuration.clone(),
                    self.catalog.clone(),
                    self.credentials.clone(),
                    ModelSelection {
                        connection_id,
                        model_id,
                    },
                    thinking_level,
                    id.to_owned(),
                    self.revision.clone(),
                )
                .await
                .map_err(|error| match error {
                    RunError::ModelUnavailable => CaptureError::ModelUnavailable,
                    error => CaptureError::Other(public_error(error)),
                })?;
                (Some(source.accepted), None)
            }
            BackendPreference::Executor { selection } => {
                workspace::validate(
                    &self.workspace_roots,
                    &session.configuration.workspace,
                    &self.managed_worktrees,
                )
                .await?;
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
        let legacy_discovery = self.scheduler.investigation.read().unwrap().as_deref() == Some(id)
            && super::discovery::legacy_tools(session.configuration.tools.as_deref());
        let selected_catalog = if external || legacy_discovery {
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
        let selected_catalog = if legacy_discovery {
            selected_catalog
        } else {
            self.mcp_projects.with_client(id, selected_catalog)?
        };
        if external && !host_bridge && selected_catalog.revision.is_some() {
            return Err("agent_executor_cannot_use_session_mcp".into());
        }
        let allowed_tools = self.admitted_tools(id, &session.configuration.tools);
        let preset_management = !external
            && [
                "SubagentPresetList",
                "SubagentPresetRead",
                "SubagentPresetCreate",
                "SubagentPresetUpdate",
                "SubagentPresetDelete",
            ]
            .iter()
            .all(|name| {
                self.tools.contains(name)
                    && allowed_tools
                        .as_ref()
                        .is_none_or(|held| held.iter().any(|held| held == name))
            });
        let behavior = self.bot_behavior(
            id,
            self.capture_behavior(
                (!host_bridge).then_some(&session.configuration.workspace),
                &snapshot,
                language,
                session.configuration.applied_preset.as_ref(),
                preset_management,
            )
            .await?,
            &snapshot,
            language,
            allowed_tools.as_deref(),
        );
        let basis = CapturedRun {
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
            tool_discovery: !external && !legacy_discovery && self.settings.tool_discovery,
            allowed_tools,
            background: None,
            internal_tools: if external && !host_bridge {
                Arc::default()
            } else {
                selected_catalog.definitions.clone()
            },
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
        let completion_request = self
            .completion_request(parent, &input.session_id, input.on_complete)
            .await?;
        let Send {
            session_id: id,
            message: text,
            quotes,
            backend,
            attachments,
            delivery,
            expected_run_id,
            on_complete: _,
        } = input;
        if quotes.len() > 16
            || quotes.iter().any(|q| q.text.trim().is_empty())
            || (text.trim().is_empty() && attachments.is_empty() && quotes.is_empty())
        {
            return Err("agent_message_invalid".into());
        }
        let admission = self.runs.session(&id).await;
        if admission.state().await.closing || self.stop.is_cancelled() {
            return Err("agent_closed".into());
        }
        if let Some(expected) = expected_run_id {
            let view = self
                .session_run(&id, expected)
                .await?
                .ok_or("agent_execution_unavailable")?;
            if view.stopped || view.terminal.is_some() {
                return Ok(NativeMutation::Returned(SendResult::Rejected {
                    session_id: id,
                    reason: SendRejection::TurnStopped,
                    skills: None,
                }));
            }
        }
        let latest = match self
            .durable
            .latest_run(id.clone())
            .await
            .map_err(|error| error.to_string())?
        {
            Some(run) => self.session_run(&id, run).await?,
            None => None,
        };
        if latest.as_ref().is_some_and(|view| view.blocks_followup()) {
            return Ok(NativeMutation::Returned(SendResult::Rejected {
                session_id: id,
                reason: SendRejection::OriginalOperationUnsettled,
                skills: None,
            }));
        }
        let mut after_stop = None;
        let active = if latest.as_ref().is_some_and(|view| view.stopped) {
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
        let interrupt = if let (Some(view), SendDelivery::Steer) = (&active, delivery)
            && let BackendSpec::Executor {
                selection,
                descriptor,
            } = &view.spec.backend
            && selection.settings.runtime.as_deref() == Some("antigravity")
        {
            let executor: crate::executor::Accepted = self
                .run_content(view.run, descriptor)
                .await
                .map_err(public_error)?;
            if &executor.selection != selection {
                return Err("agent_executor_descriptor_changed".into());
            }
            matches!(
                self.executors.active_delivery(&executor),
                crate::executor::ActiveDelivery::InterruptResume
            )
            .then_some(selection)
        } else {
            None
        };
        let followup = active.as_ref().map(|view| {
            if interrupt.is_some() {
                Followup::Interrupt {
                    run: view.run,
                    stop: self.control_id(operation, "steering_interrupt"),
                }
            } else {
                Followup::Queued(view.run)
            }
        });
        let backend = backend.or_else(|| {
            interrupt.map(|selection| BackendPreference::Executor {
                selection: selection.clone(),
            })
        });
        let basis = match self
            .capture_current_run(&id, backend, operation.fingerprint.clone(), parent)
            .await
        {
            Ok(basis) => basis,
            Err(CaptureError::ModelUnavailable) => {
                return Ok(NativeMutation::Returned(SendResult::Rejected {
                    session_id: id,
                    reason: SendRejection::ModelUnavailable,
                    skills: None,
                }));
            }
            Err(CaptureError::Other(error)) => return Err(error),
        };
        let mut message: MessageInput = text.into();
        message.quotes = (!quotes.is_empty()).then_some(quotes);
        if let (Some(view), SendDelivery::Steer) = (&active, delivery)
            && interrupt.is_none()
        {
            let execution = ExecutionIdentity {
                session_id: id.clone(),
                turn_id: view.spec.turn_id.clone(),
                run_id: view.run,
            };
            return self
                .steer_message(
                    message,
                    attachments,
                    &execution,
                    &basis,
                    operation,
                    parent,
                    completion_request,
                )
                .await;
        }
        let mut unprepared = message;
        unprepared.attachments = self.attachment_refs(&id, attachments, parent).await?;
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
                return Ok(NativeMutation::Returned(SendResult::Rejected {
                    session_id: id,
                    reason,
                    skills,
                }));
            }
        };
        let source = RootSourceMessage {
            message: DeliveredMessage {
                origin: match &parent.identity {
                    maka_capabilities::call::Identity::Agent { execution, .. } => {
                        Some(MessageOrigin::Session {
                            execution: execution.clone(),
                        })
                    }
                    _ => None,
                },
                message_id: format!("m_{}", self.operation_id(operation)),
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
            .freeze_request(&id, source, &basis, required_tools, operation, parent)
            .await?;
        let queue = self
            .durable
            .queue()
            .read(id.clone())
            .await
            .map_err(|e| e.to_string())?;
        let command = QueueCommand {
            id: self.control_id(operation, "send"),
            at: UnixMillis(now().try_into().map_err(|_| "invalid clock")?),
            expected_revision: queue.revision,
            edit: QueueEdit::Enqueue {
                request: Box::new(request),
                placement: QueuePlacement::Followup,
            },
        };
        let writer = self.durable.queue();
        let completion = completion_request
            .as_ref()
            .map(|_| CompletionRegistration::Registered);
        let change = if let Some(request) = completion_request {
            writer.prepare_with(
                id.clone(),
                command,
                contents,
                followup,
                after_stop,
                self.completion_statement(&id, &message_id, request)?,
            )
        } else if let Some(fence) = after_stop {
            writer.prepare_after_stop(id.clone(), command, contents, fence)
        } else if let Some(original) = followup {
            writer.prepare_followup(id.clone(), command, contents, original)
        } else {
            writer.prepare(id.clone(), command, contents)
        };
        Ok(NativeMutation::Commit {
            value: SendResult::Queued {
                completion,
                session_id: id,
                message_id,
                revision: queue
                    .revision
                    .checked_add(1)
                    .ok_or("agent_queue_revision_exhausted")?,
            },
            change,
        })
    }
}
