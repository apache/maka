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
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::InvocationOutcome;
use maka_event_log::turns::{InvocationState, TurnBoundary};

pub(super) fn project((boundary, high_water): (TurnBoundary, u64)) -> Execution {
    Execution {
        session_id: boundary.invocation.session_id,
        turn_id: boundary.invocation.turn_id,
        run_id: boundary.invocation.run_id,
        invocation_id: boundary.invocation.invocation_id,
        high_water,
        state: match boundary.state {
            InvocationState::Admitted => ExecutionState::Admitted,
            InvocationState::Running => ExecutionState::Running,
            InvocationState::WaitingForUser => ExecutionState::Waiting,
            InvocationState::Ended { outcome, .. } => match outcome {
                InvocationOutcome::HandoffPaused { .. } => ExecutionState::Paused,
                InvocationOutcome::ContextCompactFinished {
                    outcome: maka_agent_facts::context::CompactOutcome::Failed { .. },
                } => ExecutionState::Failed,
                InvocationOutcome::Completed | InvocationOutcome::ContextCompactFinished { .. } => {
                    ExecutionState::Completed
                }
                InvocationOutcome::Failed { .. } => ExecutionState::Failed,
                InvocationOutcome::Cancelled { .. } => ExecutionState::Cancelled,
            },
        },
    }
}
fn parked(reason: ResumeParkReason) -> ResumeResult {
    ResumeResult::Parked { reason }
}

enum ResumePurpose {
    Observe,
    Admit,
}

struct PreparedResume {
    run: RunInput,
    basis: Arc<MessageBasis>,
    runs: runs::Exclusive,
}
enum ResumePreparation {
    Ready(Box<PreparedResume>),
    Unavailable(ResumeParkReason),
}

impl Owner {
    pub async fn work(&self, input: WorkRead) -> Result<Work, String> {
        use maka_event_log::message_resolution::MessageExecution as Stored;
        self.session(&input.session_id).await?;
        let offset = input.cursor.as_ref().map_or(0, |cursor| cursor.offset);
        let origin = match input.target {
            WorkTarget::Message { message_id } => {
                maka_event_log::observation::WorkOrigin::Message(message_id)
            }
            WorkTarget::Invocation { invocation_id } => {
                maka_event_log::observation::WorkOrigin::Invocation(invocation_id)
            }
        };
        let observed = self
            .store
            .session(&input.session_id)
            .await
            .map_err(|error| error.to_string())?
            .work_observation(
                &input.session_id,
                origin,
                offset,
                input
                    .cursor
                    .as_ref()
                    .map(|cursor| cursor.invocation_id.as_str()),
            )
            .await
            .map_err(|_| "agent_work_unavailable")?;
        let (shared, boundary) = match observed.execution {
            Stored::Missing => return Ok(Work::Missing),
            Stored::Pending => return Ok(Work::Pending),
            Stored::Cancelled => return Ok(Work::Cancelled),
            Stored::Owned(boundary) => (false, boundary),
            Stored::Shared(boundary) => (true, boundary),
        };
        if input
            .cursor
            .as_ref()
            .is_some_and(|cursor| cursor.invocation_id != boundary.invocation.invocation_id)
        {
            return Ok(Work::Changed);
        }
        let answer = observed.answer.map(|answer| {
            let length = answer.text.len();
            AnswerPage {
                text: answer.text,
                next: (!answer.complete).then(|| AnswerCursor {
                    invocation_id: boundary.invocation.invocation_id.clone(),
                    offset: offset + length as u64,
                }),
            }
        });
        Ok(Work::Delivered {
            shared,
            execution: project((*boundary, observed.high_water)),
            answer,
            pending_interactions: observed.interactions.len() as u32,
        })
    }

    pub async fn execution(&self, input: ExecutionRead) -> Result<ExecutionResult, String> {
        self.session(&input.session_id).await?;
        let boundary = self
            .store
            .session(&input.session_id)
            .await
            .map_err(|error| error.to_string())?
            .invocation_boundary(&input.session_id, &input.invocation_id)
            .await
            .map_err(|_| "agent_execution_unavailable")?;
        Ok(match boundary {
            Some(boundary) => ExecutionResult::Found {
                execution: project(boundary),
            },
            None => ExecutionResult::Missing,
        })
    }

    pub async fn resumable(
        self: &Arc<Self>,
        input: ResumableRead,
        cancellation: &CancellationToken,
    ) -> Result<Resumable, String> {
        let runs = self.runs.lock().await;
        self.session(&input.session_id).await?;
        let store = self
            .store
            .session(&input.session_id)
            .await
            .map_err(|error| error.to_string())?;
        let Some(boundary) = store
            .latest_turn_boundary(&input.session_id)
            .await
            .map_err(|_| "agent_execution_unavailable")?
        else {
            return Ok(Resumable::Unavailable {
                reason: ResumeParkReason::SourceMissing,
            });
        };
        let source = store
            .invocation_boundary(&input.session_id, &boundary.invocation.invocation_id)
            .await
            .map_err(|_| "agent_execution_unavailable")?
            .ok_or("agent_execution_unavailable")?;
        let execution = project(source);
        let identity = Uuid::new_v4();
        let invocation = Invocation {
            session_id: input.session_id.clone(),
            turn_id: format!("t_{identity}"),
            run_id: format!("r_{identity}"),
            invocation_id: format!("i_{identity}"),
        };
        let prepared = match self
            .prepare_resume(
                Resume {
                    session_id: input.session_id,
                    source_invocation_id: execution.invocation_id.clone(),
                    source_high_water: execution.high_water,
                    model: input.model,
                    thinking_level: input.thinking_level,
                },
                invocation,
                format!(
                    "sha256:{}",
                    hex::encode(Sha256::digest(identity.as_bytes()))
                ),
                runs,
                ResumePurpose::Observe,
            )
            .await?
        {
            ResumePreparation::Ready(prepared) => prepared,
            ResumePreparation::Unavailable(reason) => return Ok(Resumable::Unavailable { reason }),
        };
        drop(prepared.runs);
        match self
            .engine
            .check_continuation(&store, &prepared.run, cancellation)
            .await
        {
            Ok(()) => Ok(Resumable::Ready { source: execution }),
            Err(
                RunError::InvalidInput(_)
                | RunError::ReconciliationRequired(_)
                | RunError::Store(
                    maka_event_log::StoreError::InvalidTransition(_)
                    | maka_event_log::StoreError::HistoryUnsettled
                    | maka_event_log::StoreError::HistoryProviderEffectUnresolved,
                ),
            ) => Ok(Resumable::Unavailable {
                reason: ResumeParkReason::SafetyCheckFailed,
            }),
            Err(error) => {
                if error.is_cleanup_unconfirmed() {
                    let mut runs = self.runs.lock().await;
                    runs.retained_cleanup.insert(execution.session_id);
                }
                Err(public_error(error))
            }
        }
    }

    pub async fn resume(
        self: &Arc<Self>,
        input: Resume,
        operation: &maka_plugin_core::operation::RecoveryRef,
    ) -> Result<ResumeResult, String> {
        use ResumeParkReason as Reason;
        let runs = self.runs.lock().await;
        self.session(&input.session_id).await?;
        let identity = self.operation_id(operation);
        // Engine receipts and application operations use different digest encodings.
        let fingerprint = format!(
            "sha256:{}",
            hex::encode(Sha256::digest(operation.fingerprint.as_bytes()))
        );
        let invocation = Invocation {
            session_id: input.session_id.clone(),
            turn_id: format!("t_{identity}"),
            run_id: format!("r_{identity}"),
            invocation_id: format!("i_{identity}"),
        };
        // Acceptance wins over today's model availability, workspace and archive
        // state. The canonical opening is the receipt; there is no resume ledger.
        if let Some((accepted, source, recorded_fingerprint)) = self
            .store
            .session(&invocation.session_id)
            .await
            .map_err(|error| error.to_string())?
            .continuation_receipt(&invocation.invocation_id)
            .await
            .map_err(|_| "agent_execution_unavailable")?
        {
            if accepted != invocation
                || recorded_fingerprint != fingerprint
                || source.invocation.session_id != input.session_id
                || source.invocation.invocation_id != input.source_invocation_id
                || source.high_water != input.source_high_water
            {
                return Err("agent_resume_conflict".into());
            }
            let boundary = self
                .store
                .session(&input.session_id)
                .await
                .map_err(|error| error.to_string())?
                .invocation_boundary(&input.session_id, &invocation.invocation_id)
                .await
                .map_err(|_| "agent_execution_unavailable")?
                .ok_or("agent_execution_unavailable")?;
            return Ok(ResumeResult::Started {
                execution: project(boundary),
            });
        }
        let PreparedResume {
            run,
            basis,
            mut runs,
        } = match self
            .prepare_resume(
                input,
                invocation.clone(),
                fingerprint,
                runs,
                ResumePurpose::Admit,
            )
            .await?
        {
            ResumePreparation::Ready(prepared) => *prepared,
            ResumePreparation::Unavailable(reason) => return Ok(parked(reason)),
        };
        let prepared = match self
            .engine
            .prepare_continuation(
                self.store
                    .session(&run.invocation.session_id)
                    .await
                    .map_err(|error| error.to_string())?,
                run,
                &self.stop,
            )
            .await
        {
            Ok(prepared) => prepared,
            Err(
                RunError::InvalidInput(_)
                | RunError::ReconciliationRequired(_)
                | RunError::Store(
                    maka_event_log::StoreError::InvalidTransition(_)
                    | maka_event_log::StoreError::HistoryUnsettled
                    | maka_event_log::StoreError::HistoryProviderEffectUnresolved,
                ),
            ) => {
                return Ok(parked(Reason::SafetyCheckFailed));
            }
            Err(error) => {
                if error.is_cleanup_unconfirmed() {
                    runs.retained_cleanup.insert(invocation.session_id.clone());
                }
                return Err(public_error(error));
            }
        };
        let running = match self
            .engine
            .start_continuation(prepared, self.stop.child_token())
            .await
        {
            Ok(running) => running,
            Err(RunError::Busy) => return Ok(parked(Reason::Busy)),
            Err(
                RunError::ContinuationChanged
                | RunError::InvalidInput(_)
                | RunError::ReconciliationRequired(_),
            ) => {
                return Ok(parked(Reason::SafetyCheckFailed));
            }
            Err(error) => {
                if error.is_cleanup_unconfirmed() {
                    runs.retained_cleanup.insert(invocation.session_id.clone());
                }
                return Err(public_error(error));
            }
        };
        runs.controls.insert(
            invocation.session_id.clone(),
            Control {
                #[cfg(test)]
                handoff: running.handoff().cloned(),
                preview: running.preview(),
                compacting: false,
                invocation: invocation.clone(),
                basis,
                cancellation: running.cancellation(),
            },
        );
        self.workers.spawn(self.clone().drive(running));
        let boundary = self
            .store
            .session(&invocation.session_id)
            .await
            .map_err(|error| error.to_string())?
            .invocation_boundary(&invocation.session_id, &invocation.invocation_id)
            .await
            .map_err(|_| "agent_execution_unavailable")?
            .ok_or("agent_execution_unavailable")?;
        Ok(ResumeResult::Started {
            execution: project(boundary),
        })
    }
    pub(super) async fn resume_goal_handoff(
        self: &Arc<Self>,
        source: &Invocation,
        basis: Arc<MessageBasis>,
    ) -> Result<(), RunError> {
        let runs = self.runs.lock().await;
        if runs.closing || self.stop.is_cancelled() {
            return Err(RunError::Cancelled);
        }
        if runs.busy(&source.session_id)
            || self
                .has_parked_invocation(&source.session_id)
                .await
                .map_err(RunError::Internal)?
        {
            return Ok(());
        }
        let session = self
            .session(&source.session_id)
            .await
            .map_err(RunError::Internal)?;
        drop(runs);
        let store = self
            .store
            .session(&source.session_id)
            .await
            .map_err(|error| RunError::Internal(error.to_string()))?;
        let prefix = store
            .run_source(&source.session_id, &source.run_id, None)
            .await
            .map_err(|error| RunError::Internal(error.to_string()))?
            .ok_or_else(|| RunError::Internal("agent_execution_unavailable".into()))?;
        if prefix.boundary.invocation != *source {
            return Err(RunError::ReconciliationRequired(
                "agent_execution_changed".into(),
            ));
        }
        let Fact::InvocationEnded {
            outcome: InvocationOutcome::HandoffPaused { pause },
        } = prefix.last.event.fact
        else {
            return Err(RunError::ReconciliationRequired(
                "agent_execution_not_paused".into(),
            ));
        };
        if store
            .continuation_for_source(&prefix.boundary)
            .await
            .map_err(|error| RunError::Internal(error.to_string()))?
            .is_some()
        {
            return Ok(());
        }
        let continuation = self
            .prepare_frozen_retry(source, basis.clone(), &self.stop)
            .await?;
        let mut runs = self.runs.lock().await;
        let current = self
            .session(&source.session_id)
            .await
            .map_err(RunError::Internal)?;
        if current.configuration != session.configuration || current.archived {
            return Err(RunError::InvalidInput(
                "agent_session_configuration_changed".into(),
            ));
        }
        if runs.closing || self.stop.is_cancelled() {
            return Err(RunError::Cancelled);
        }
        if runs.busy(&source.session_id)
            || self
                .has_parked_invocation(&source.session_id)
                .await
                .map_err(RunError::Internal)?
        {
            return Ok(());
        }
        if store
            .continuation_for_source(&prefix.boundary)
            .await
            .map_err(|error| RunError::Internal(error.to_string()))?
            .is_some()
        {
            return Ok(());
        }
        // The seal owns successor identity and settings. Engine verifies the
        // original configuration, route, tool catalog and replay before admission.
        let settings = continuation.settings;
        let run = RunInput {
            invocation: pause.intent.successor(source),
            request_fingerprint: None,
            model_source: settings.model_source,
            model_revision: settings.model_revision,
            provider_id: settings.provider_id,
            context: settings.context,
            provider: settings.provider,
            provider_options: settings.provider_options,
            main_output_limit: settings.main_output_limit,
            supports_vision: settings.supports_vision,
            native_activation_basis: settings.native_activation_basis,
            configuration: settings.configuration,
            work: RunWork::Handoff {
                source: prefix.boundary,
                pause: Box::new(pause),
                tools: continuation.tools,
            },
        };
        let running = match async {
            let prepared = self
                .engine
                .prepare_continuation(store, run, &self.stop)
                .await?;
            self.engine
                .start_continuation(prepared, self.stop.child_token())
                .await
        }
        .await
        {
            Ok(running) => running,
            Err(error) => {
                if error.is_cleanup_unconfirmed() {
                    runs.retained_cleanup.insert(source.session_id.clone());
                }
                return Err(error);
            }
        };
        self.publish(&mut runs, &running, basis);
        self.workers.spawn(self.clone().drive(running));
        Ok(())
    }

    async fn prepare_resume(
        self: &Arc<Self>,
        input: Resume,
        invocation: Invocation,
        fingerprint: String,
        mut runs: runs::Exclusive,
        purpose: ResumePurpose,
    ) -> Result<ResumePreparation, String> {
        use ResumeParkReason as Reason;
        let session = self.session(&input.session_id).await?;
        if runs.closing || self.stop.is_cancelled() {
            return Ok(ResumePreparation::Unavailable(Reason::Closed));
        }
        if session.archived {
            return Ok(ResumePreparation::Unavailable(Reason::Archived));
        }
        if runs.busy(&input.session_id)
            || self.has_parked_invocation(&input.session_id).await?
            || !self
                .store
                .session(&input.session_id)
                .await
                .map_err(|error| error.to_string())?
                .message_queue(&input.session_id)
                .await
                .map_err(|_| "agent_queue_unavailable")?
                .entries
                .is_empty()
        {
            return Ok(ResumePreparation::Unavailable(Reason::Busy));
        }
        let Some((boundary, high_water)) = self
            .store
            .session(&input.session_id)
            .await
            .map_err(|error| error.to_string())?
            .invocation_boundary(&input.session_id, &input.source_invocation_id)
            .await
            .map_err(|_| "agent_execution_unavailable")?
        else {
            return Ok(ResumePreparation::Unavailable(Reason::SourceMissing));
        };
        if high_water != input.source_high_water {
            return Ok(ResumePreparation::Unavailable(Reason::SourceChanged));
        }
        if !matches!(
            boundary.state,
            InvocationState::Ended {
                outcome: InvocationOutcome::Failed { .. } | InvocationOutcome::Cancelled { .. },
                ..
            }
        ) {
            return Ok(ResumePreparation::Unavailable(Reason::SourceNotResumable));
        }
        let prefix = match self
            .store
            .session(&input.session_id)
            .await
            .map_err(|error| error.to_string())?
            .run_source(&input.session_id, &boundary.invocation.run_id, None)
            .await
        {
            Ok(Some(prefix)) => prefix,
            Ok(None) => return Ok(ResumePreparation::Unavailable(Reason::SourceMissing)),
            Err(_) => return Err("agent_execution_unavailable".into()),
        };
        if prefix.boundary.invocation != boundary.invocation
            || prefix.boundary.high_water != input.source_high_water
            || !matches!(&prefix.last.event.fact, Fact::InvocationEnded { .. })
        {
            return Ok(ResumePreparation::Unavailable(Reason::SourceChanged));
        }
        let source_boundary = prefix.boundary;
        if self
            .store
            .session(&source_boundary.invocation.session_id)
            .await
            .map_err(|error| error.to_string())?
            .continuation_for_source(&source_boundary)
            .await
            .map_err(|_| "agent_execution_unavailable")?
            .is_some()
        {
            return Ok(ResumePreparation::Unavailable(Reason::AlreadyContinued));
        }
        let Some(mut configuration) = self
            .store
            .session(&boundary.invocation.session_id)
            .await
            .map_err(|error| error.to_string())?
            .invocation_configuration(&boundary.invocation)
            .await
            .map_err(|_| "agent_execution_unavailable")?
        else {
            return Ok(ResumePreparation::Unavailable(Reason::SourceNotResumable));
        };
        if configuration.model.is_none()
            || configuration.orchestration_mode.as_str() == plan::EXECUTION
        {
            return Ok(ResumePreparation::Unavailable(Reason::SourceNotResumable));
        }
        drop(runs);
        let workspace = &session.configuration.workspace;
        if configuration.cwd != workspace.path
            || configuration.workspace_identity.as_ref() != Some(&workspace.identity)
            || configuration.workspace_binding.map(|binding| binding.id)
                != Some(session.configuration.binding.id)
            || workspace::validate(&self.workspace_roots, workspace, &self.managed_worktrees)
                .await
                .is_err()
        {
            return Ok(ResumePreparation::Unavailable(Reason::WorkspaceChanged));
        }
        let (mut source, prepared) = crate::model::Source::select(
            self.configuration.clone(),
            self.catalog.clone(),
            self.credentials.clone(),
            input.model,
            input.thinking_level,
            input.session_id.clone(),
            self.revision.clone(),
        )
        .await
        .map_err(public_error)?;
        // A continuation retains the original tool protocol even when the
        // user selects a model whose default differs from the original Run.
        source.accepted.tool_mode = configuration.tool_mode;
        source.accepted.code_language = configuration.code_language;
        source.accepted.editing_tools = configuration.editing_tools;
        let graph = match self
            .resume_graph(&input.session_id, &configuration.orchestration_mode)
            .await
        {
            Ok(graph) => graph,
            Err(_) => return Ok(ResumePreparation::Unavailable(Reason::SourceNotResumable)),
        };
        let selected_catalog = match purpose {
            ResumePurpose::Observe => self.mcp_projects.base.clone(),
            ResumePurpose::Admit => self.mcp_projects.capture(workspace).await?,
        };
        runs = self.runs.lock().await;
        if runs.closing || self.stop.is_cancelled() {
            return Ok(ResumePreparation::Unavailable(Reason::Closed));
        }
        let current = self.session(&input.session_id).await?;
        if current.configuration != session.configuration || current.archived {
            return Ok(ResumePreparation::Unavailable(Reason::WorkspaceChanged));
        }
        if runs.busy(&input.session_id) || self.has_parked_invocation(&input.session_id).await? {
            return Ok(ResumePreparation::Unavailable(Reason::Busy));
        }
        if self
            .store
            .session(&source_boundary.invocation.session_id)
            .await
            .map_err(|error| error.to_string())?
            .continuation_for_source(&source_boundary)
            .await
            .map_err(|_| "agent_execution_unavailable")?
            .is_some()
        {
            return Ok(ResumePreparation::Unavailable(Reason::AlreadyContinued));
        }

        let basis = MessageBasis {
            mcp_revision: selected_catalog.revision.clone(),
            mcp_catalog: Some(selected_catalog.clone()),
            language: configuration.language,
            compaction_prompt: configuration.compaction_prompt.clone(),
            graph,
            collaboration_mode: configuration.collaboration_mode,
            background_kind: BackgroundKind::Schedule,
            tool_discovery: configuration.tool_discovery,
            allowed_tools: session.configuration.tools.clone(),
            background: None,
            internal_tools: selected_catalog.definitions.clone(),
            internal_bindings: selected_catalog.bindings.clone(),
            // Ordinary Agents retain their existing queue compatibility. A
            // coordinator continuation cannot silently adopt a newer behavior.
            behavior: self
                .behavior
                .as_ref()
                .and(configuration.system_prompt.clone()),
            model: Some(source.accepted.clone()),
            executor: None,
            workspace: workspace.clone(),
            binding: session.configuration.binding,
            fingerprint: fingerprint.clone(),
            tools: self.tool_basis.clone(),
        };
        configuration.model = Some(source.accepted.binding.clone());
        configuration.thinking_level = source.accepted.thinking_level;
        // The historical prompt is replayed, but this continuation is a new
        // admission under the current Session permission boundary.
        configuration.boundary_revision = session.configuration.boundary_revision;
        configuration.workspace_binding = Some(session.configuration.binding);
        configuration.sandbox_mode = match session.configuration.permissions.access {
            WorkspaceAccess::ReadOnly => SandboxMode::ReadOnly,
            WorkspaceAccess::WorkspaceWrite => SandboxMode::WorkspaceWrite,
            WorkspaceAccess::DangerFullAccess => SandboxMode::DangerFullAccess,
        };
        configuration.approval_policy = if session.configuration.permissions.request_permissions {
            ApprovalPolicy::OnRequest
        } else {
            ApprovalPolicy::Never
        };
        // Replay the original prepared prompt. Native service tools continue to
        // resolve the live Session permission boundary through their actual owner.
        let tools = self.selected_tools(
            &input.session_id,
            &basis,
            configuration.tool_discovery,
            configuration.editing_tools,
        )?;
        let basis = Arc::new(basis);
        let run = RunInput {
            native_activation_basis: Some(basis.clone()),
            invocation: invocation.clone(),
            model_source: Some(Arc::new(source)),
            model_revision: Some(prepared.revision),
            provider_id: prepared.provider_id,
            context: prepared.context,
            provider: prepared.provider,
            provider_options: prepared.options,
            main_output_limit: prepared.main_output_limit,
            supports_vision: prepared.supports_vision,
            request_fingerprint: Some(fingerprint),
            configuration,
            work: RunWork::Continuation {
                source: source_boundary,
                tools,
            },
        };
        Ok(ResumePreparation::Ready(Box::new(PreparedResume {
            run,
            basis,
            runs,
        })))
    }
}
