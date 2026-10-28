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

mod controls;

use super::*;
use futures_util::FutureExt;
use maka_agent_engine::{ModelSource, RunningInvocation};
use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::InvocationInput;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::RuntimeEvent;
use maka_event_log::{
    StoreError,
    message_admissions::PendingMessageAdmission,
    message_interrupts::{InterruptCommand, InterruptReceipt},
};

pub(super) enum PreparedRun {
    Model(Box<RunInput>),
    Executor(Box<maka_agent_engine::ExecutorInput<crate::executor::Backend>>),
}
impl Owner {
    pub fn activated(self: &Arc<Self>) {
        self.recover_removed_sessions();
        self.scheduler.bind(self);
        self.todo.bind(self);
        self.goals.bind(self);
        self.plans.bind(self);
        self.start_plans();
        self.start_goals();
        self.start_schedules();
        let owner = self.clone();
        self.workers.spawn(async move { owner.schedule().await });
    }

    // Recover the owner-scoped durable backlog without limiting active Sessions.
    async fn schedule(self: &Arc<Self>) {
        let mut runs = self.runs.lock().await;
        if runs.closing {
            return;
        }
        if let Err(error) = self.schedule_locked(&mut runs).await {
            if !(self.stop.is_cancelled()
                && matches!(
                    &error,
                    RunError::Cancelled
                        | RunError::Commit(maka_agent_facts::event::CommitError::Retired)
                        | RunError::Store(StoreError::SessionRetired)
                ))
            {
                tracing::error!(stage = "queue_schedule_failed", cause = crate::diagnostics::run_cause(&error),
                    consequence = "owner_closing", activation = %self.revision.activation, instance = ?self.data_source.namespace,
                    "Agent queue scheduling failed");
            }
            runs.closing = true;
            self.stop.cancel();
        }
    }
    pub(super) async fn schedule_locked(self: &Arc<Self>, runs: &mut Runs) -> Result<(), RunError> {
        let mut after = None;
        loop {
            if self.stop.is_cancelled() {
                return Ok(());
            }
            let sessions = self
                .store
                .pending_message_sessions(&self.prefix, after.as_deref())
                .await?;
            if sessions.is_empty() {
                return Ok(());
            }
            for session in &sessions {
                if !self.owns(session) {
                    return Err(RunError::InvalidInput("agent_queue_owner_invalid".into()));
                }
                if runs.controls.contains_key(session) || runs.quarantined.contains(session) {
                    continue;
                }
                match self.next(session).await {
                    Ok(Some((running, basis))) => {
                        self.publish(runs, &running, basis);
                        self.workers.spawn(self.clone().drive(running));
                    }
                    Ok(None) => {}
                    Err(error) => {
                        if error.is_cleanup_unconfirmed() {
                            runs.quarantined.insert(session.clone());
                        }
                        return Err(error);
                    }
                }
            }
            after = sessions.last().cloned();
        }
    }
    pub(super) fn publish(
        self: &Arc<Self>,
        runs: &mut Runs,
        running: &RunningInvocation,
        basis: MessageBasis,
    ) {
        if let Some(model) = &basis.model {
            self.title_after_message(running.invocation().clone(), model.clone());
        }
        self.goals.execution_changed();
        self.plans.execution_changed();
        runs.controls.insert(
            running.invocation().session_id.clone(),
            Control {
                compacting: false,
                invocation: running.invocation().clone(),
                basis,
                cancellation: running.cancellation(),
                failure: None,
            },
        );
    }
    pub(super) fn drive(self: Arc<Self>, mut running: RunningInvocation) -> BoxFuture<'static, ()> {
        Box::pin(async move {
            let session = running.invocation().session_id.clone();
            loop {
                let invocation = running.invocation().clone();
                let completion = std::panic::AssertUnwindSafe(running.completion())
                    .catch_unwind()
                    .await;
                let mut runs = self.runs.lock().await;
                if !matches!(completion, Ok(ref value) if value.cleanup.is_ok()) {
                    let stage = if completion.is_err() {
                        "queue_completion_panicked"
                    } else {
                        "queue_cleanup_unconfirmed"
                    };
                    tracing::error!(stage, cause = "cleanup_unconfirmed", consequence = "session_quarantined",
                        session_id = %invocation.session_id, turn_id = %invocation.turn_id,
                        run_id = %invocation.run_id, invocation_id = %invocation.invocation_id,
                        activation = %self.revision.activation, "Agent invocation cleanup is unconfirmed");
                    runs.controls
                        .get_mut(&session)
                        .expect("original worker control")
                        .failure = Some("agent_cleanup_unconfirmed");
                    runs.quarantined.insert(session.clone());
                    return;
                }
                let next = if runs.closing {
                    Ok(None)
                } else {
                    // Preparation is temporary; completion waits must not
                    // retain space for the next invocation's input state.
                    Box::pin(self.next(&session)).await
                };
                match next {
                    Ok(Some((next, basis))) => {
                        self.publish(&mut runs, &next, basis);
                        running = next;
                    }
                    Ok(None) => {
                        runs.controls.remove(&session);
                        self.goals.execution_changed();
                        self.plans.execution_changed();
                        return;
                    }
                    Err(error) => {
                        if !((self.stop.is_cancelled() || runs.closing)
                            && matches!(
                                &error,
                                RunError::Cancelled
                                    | RunError::Commit(
                                        maka_agent_facts::event::CommitError::Retired
                                    )
                                    | RunError::Store(StoreError::SessionRetired)
                            ))
                        {
                            tracing::error!(stage = "queue_advance_failed", cause = crate::diagnostics::run_cause(&error),
                                consequence = "owner_closing", session_id = %invocation.session_id,
                                turn_id = %invocation.turn_id, run_id = %invocation.run_id,
                                invocation_id = %invocation.invocation_id, activation = %self.revision.activation,
                                "Agent queue advancement failed after invocation completion");
                        }
                        runs.controls
                            .get_mut(&session)
                            .expect("original worker control")
                            .failure = Some("agent_execution_unavailable");
                        if error.is_cleanup_unconfirmed() {
                            runs.quarantined.insert(session.clone());
                        }
                        runs.closing = true;
                        self.stop.cancel();
                        return;
                    }
                }
            }
        })
    }
    async fn next(
        &self,
        session: &str,
    ) -> Result<Option<(RunningInvocation, MessageBasis)>, RunError> {
        loop {
            if self.stop.is_cancelled() {
                return Ok(None);
            }
            let queue = self
                .store
                .session(session)
                .await?
                .message_queue(session)
                .await?;
            let Some(entry) = queue
                .entries
                .iter()
                .find(|entry| entry.source.disposition == MessageDisposition::Steering)
                .or_else(|| queue.entries.first())
            else {
                return Ok(None);
            };
            if entry.execution.owner != self.prefix || !self.owns(session) {
                return Err(RunError::InvalidInput("agent_queue_owner_invalid".into()));
            }
            let invocation = if entry.source.disposition == MessageDisposition::TurnStarted {
                entry.invocation.clone()
            } else {
                let identity =
                    hex::encode(Sha256::digest(entry.source.message.message_id.as_bytes()));
                Invocation {
                    session_id: session.into(),
                    turn_id: format!("t_{identity}"),
                    run_id: format!("r_{identity}"),
                    invocation_id: format!("i_{identity}"),
                }
            };
            let prepared = self.prepare_pending(entry, invocation.clone()).await;
            if self.stop.is_cancelled() {
                return Ok(None);
            }
            let result = match prepared {
                Ok((input, basis)) => self
                    .start(input, self.stop.child_token())
                    .await
                    .map(|running| (running, basis)),
                Err(reason) => {
                    self.fail_pending(invocation, entry, reason).await?;
                    continue;
                }
            };
            match result {
                Ok(running) => return Ok(Some(running)),
                Err(error @ (RunError::InvalidInput(_) | RunError::ReconciliationRequired(_))) => {
                    self.fail_pending(invocation, entry, public_error(error))
                        .await?;
                }
                // SQL/commit uncertainty and physical cleanup failures do not
                // establish a deterministic rejection of the accepted message.
                Err(error) => return Err(error),
            }
        }
    }
    async fn prepare_pending(
        &self,
        entry: &PendingMessageAdmission,
        invocation: Invocation,
    ) -> Result<(PreparedRun, MessageBasis), String> {
        let mut basis: MessageBasis = serde_json::from_value(entry.execution.basis.clone())
            .map_err(|_| "agent_message_basis_invalid")?;
        self.validate_background(&basis).await?;
        self.validate_graph_basis(&invocation.session_id, &basis)
            .await?;
        let selected_catalog = self.mcp_projects.catalog(basis.mcp_revision.as_deref())?;
        let tools_changed = if basis.executor.is_some() {
            !basis.tools.is_empty()
                || !basis.internal_tools.is_empty()
                || !basis.internal_bindings.is_empty()
        } else {
            basis.tools != self.tool_basis
                || basis.internal_tools != selected_catalog.definitions
                || basis.internal_bindings != selected_catalog.bindings
        };
        if tools_changed {
            return Err("agent_tools_changed".into());
        }
        // Deserialization allocates independent descriptors. Only after the original
        // content checks succeed may this admitted basis share the captured catalog.
        if basis.executor.is_none() {
            basis.tools = self.tool_basis.clone();
            basis.internal_tools = selected_catalog.definitions.clone();
            basis.internal_bindings = selected_catalog.bindings.clone();
        }
        let session = self.session(&invocation.session_id).await?;
        basis.validate_background_target(&session)?;
        if (!matches!(basis.background_kind, BackgroundKind::Plan(_))
            && session.configuration.collaboration_mode != basis.collaboration_mode)
            || (basis.collaboration_mode == CollaborationMode::Plan && !self.settings.plans)
            || session.archived
            || session.configuration.workspace != basis.workspace
            || session.configuration.binding != basis.binding
            || session.configuration.tools != basis.allowed_tools
            || (basis.executor.is_some() && basis.allowed_tools.is_some())
        {
            return Err("agent_session_configuration_changed".into());
        }
        workspace::validate(
            &self.workspace_roots,
            &basis.workspace,
            &self.managed_worktrees,
        )
        .await?;
        let backend = match (&basis.model, &basis.executor) {
            (Some(model), None) => {
                let source = crate::model::Source::restore(
                    self.configuration.clone(),
                    self.credentials.clone(),
                    model.clone(),
                    invocation.session_id.clone(),
                    self.revision.clone(),
                )
                .map_err(public_error)?;
                let prepared = source.capture().await.map_err(public_error)?;
                PreparedBackend::Model(Box::new((source, prepared)))
            }
            (None, Some(executor)) => {
                PreparedBackend::Executor(Box::new(self.executors.restore(executor)?))
            }
            _ => return Err("agent_message_basis_invalid".into()),
        };
        Ok((
            self.input(invocation, backend, basis.clone(), entry.source.clone())
                .await?,
            basis,
        ))
    }
    pub(super) async fn input(
        &self,
        invocation: Invocation,
        backend: PreparedBackend,
        basis: MessageBasis,
        delivered: RootSourceMessage,
    ) -> Result<PreparedRun, String> {
        let system_prompt = match (
            basis.behavior.clone(),
            skills::prompt(&delivered.message.content)?,
        ) {
            (Some(mut behavior), Some(skills)) => {
                behavior.text.push_str("\n\n");
                behavior.text.push_str(&skills.text);
                behavior.sources.extend(skills.sources);
                Some(behavior)
            }
            (behavior, skills) => behavior.or(skills),
        };
        if let Some(prompt) = &system_prompt {
            prompt.validate().map_err(|_| "agent_prompt_invalid")?;
        }
        let session = self
            .store
            .get_session::<StoredSessionConfiguration>(&invocation.session_id)
            .await
            .map_err(|_| "agent_store_unavailable")?
            .ok_or("agent_session_unavailable")?;
        let session = resolve_session(session)?;
        let permissions = &session.configuration.permissions;
        let mut configuration = InvocationConfiguration {
            language: basis.language,
            compaction_prompt: basis.compaction_prompt.clone(),
            editing_tools: None,
            tool_discovery: basis.tool_discovery,
            cwd: basis.workspace.path.clone(),
            workspace_identity: Some(basis.workspace.identity.clone()),
            workspace_origin: WorkspaceOrigin::Selected,
            sandbox_mode: match permissions.access {
                WorkspaceAccess::ReadOnly => SandboxMode::ReadOnly,
                WorkspaceAccess::WorkspaceWrite => SandboxMode::WorkspaceWrite,
                WorkspaceAccess::DangerFullAccess => SandboxMode::DangerFullAccess,
            },
            approval_policy: if permissions.request_permissions {
                ApprovalPolicy::OnRequest
            } else {
                ApprovalPolicy::Never
            },
            boundary_revision: session.configuration.boundary_revision,
            workspace_binding: Some(session.configuration.binding),
            collaboration_mode: basis.collaboration_mode,
            orchestration_mode: if let Some(epoch) = &basis.graph {
                graph::behavior(epoch)
            } else if matches!(basis.background_kind, BackgroundKind::Plan(_)) {
                plan::EXECUTION
                    .to_owned()
                    .try_into()
                    .expect("Plan behavior")
            } else {
                BehaviorId::default()
            },
            tool_mode: ToolMode::Direct,
            code_language: Default::default(),
            model: None,
            thinking_level: None,
            system_prompt,
            tool_composition: None,
        };
        Ok(match backend {
            PreparedBackend::Model(value) => {
                let (source, prepared) = *value;
                configuration.model = Some(source.accepted.binding.clone());
                configuration.thinking_level = source.accepted.thinking_level;
                configuration.tool_mode = source.accepted.tool_mode;
                configuration.code_language = source.accepted.code_language;
                configuration.editing_tools = source.accepted.editing_tools;
                let tools =
                    self.selected_tools(&basis, basis.tool_discovery, configuration.editing_tools)?;
                let allow_prior_unknown =
                    basis.background.is_none() && delivered.message.origin.is_none();
                PreparedRun::Model(Box::new(RunInput {
                    model_source: Some(Arc::new(source)),
                    model_revision: Some(prepared.revision),
                    provider_id: prepared.provider_id,
                    invocation,
                    context: prepared.context,
                    provider: prepared.provider,
                    provider_options: prepared.options,
                    main_output_limit: prepared.main_output_limit,
                    supports_vision: prepared.supports_vision,
                    request_fingerprint: Some(basis.fingerprint),
                    configuration,
                    work: RunWork::Message {
                        message: delivered.message.content.clone(),
                        source_messages: vec![delivered],
                        tools,
                        allow_prior_unknown,
                    },
                }))
            }
            PreparedBackend::Executor(backend) => {
                let backend = *backend;
                configuration.thinking_level = backend.accepted.selection.settings.thinking_level;
                PreparedRun::Executor(Box::new(maka_agent_engine::ExecutorInput {
                    request: maka_agent_ports::executor::Request {
                        language: basis.language,
                        conversation_key: invocation.session_id.clone(),
                        invocation,
                        content: delivered.message.content.clone(),
                        cwd: configuration.cwd.clone(),
                        instructions: configuration
                            .system_prompt
                            .as_ref()
                            .map(|prompt| prompt.text.clone()),
                        settings: backend.accepted.selection.settings.clone(),
                    },
                    binding: backend,
                    configuration,
                    request_fingerprint: Some(basis.fingerprint),
                    source_messages: vec![delivered],
                }))
            }
        })
    }
    pub(super) async fn start(
        &self,
        input: PreparedRun,
        cancellation: CancellationToken,
    ) -> Result<RunningInvocation, RunError> {
        match input {
            PreparedRun::Model(input) => {
                self.engine
                    .start(
                        self.store.session(&input.invocation.session_id).await?,
                        *input,
                        cancellation,
                    )
                    .await
            }
            PreparedRun::Executor(input) => {
                self.engine
                    .start_executor(
                        self.store
                            .session(&input.request.invocation.session_id)
                            .await?,
                        *input,
                        cancellation,
                    )
                    .await
            }
        }
    }
    async fn fail_pending(
        &self,
        invocation: Invocation,
        entry: &PendingMessageAdmission,
        reason: String,
    ) -> Result<(), RunError> {
        let events = [
            Fact::InvocationOpened {
                configuration: None,
                input: InvocationInput::Message {
                    content: entry.source.message.content.clone(),
                    source_messages: vec![entry.source.clone()],
                    request_fingerprint: None,
                },
            },
            Fact::InvocationEnded {
                outcome: InvocationOutcome::Failed {
                    class: "message_preparation_failed".into(),
                    message: Some(reason),
                    model_failure: None,
                },
            },
        ]
        .into_iter()
        .map(|fact| EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| RunError::InvalidInput(error.to_string()))?;
        self.store
            .session(&invocation.session_id)
            .await?
            .append_batch(&events)
            .await?;
        Ok(())
    }
    pub async fn stop_run(
        &self,
        session: &str,
        invocation: &str,
        operation: &maka_plugin_core::operation::RecoveryRef,
    ) -> Result<bool, String> {
        self.session(session).await?;
        let runs = self.runs.lock().await;
        let Some(control) = runs
            .controls
            .get(session)
            .filter(|control| control.invocation.invocation_id == invocation)
        else {
            return Ok(false);
        };
        let command = InterruptCommand {
            host_epoch: self.revision.activation.clone(),
            session_id: session.into(),
            interrupt_id: self.operation_id(operation),
            turn_id: control.invocation.turn_id.clone(),
            run_id: control.invocation.run_id.clone(),
        };
        loop {
            let revision = self
                .store
                .session(session)
                .await
                .map_err(|error| error.to_string())?
                .message_queue_revision(session)
                .await
                .map_err(|_| "agent_queue_unavailable")?;
            match self
                .store
                .session(&command.session_id)
                .await
                .map_err(|error| error.to_string())?
                .interrupt_message_queue(&command, revision, Some(&control.invocation))
                .await
            {
                Ok(InterruptReceipt::Fenced(_)) => {
                    control.cancellation.cancel();
                    return Ok(true);
                }
                Ok(InterruptReceipt::Conflict) => return Ok(false),
                Err(StoreError::RevisionConflict { .. }) => continue,
                Err(_) => return Err("agent_queue_unavailable".into()),
            }
        }
    }
}
