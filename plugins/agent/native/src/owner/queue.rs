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
use maka_agent_engine::{ActivationExit, ModelSource, RunningInvocation};
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
struct QueuePreparation {
    admission: runs::Ordered,
    cancellation: CancellationToken,
}
impl maka_agent_engine::NativeApprovalExecutor for Owner {
    fn prepare(
        &self,
        pending: maka_agent_facts::native_approval::NativeApprovalPending,
        context: maka_agent_facts::tools::ToolCallContext,
        cancellation: CancellationToken,
    ) -> BoxFuture<
        '_,
        Result<maka_agent_facts::tools::PreparedEffect, maka_agent_facts::tools::ToolError>,
    > {
        Box::pin(async move {
            let session = self
                .session(&pending.invocation.session_id)
                .await
                .map_err(maka_agent_facts::tools::ToolError::Failed)?;
            workspace::validate(
                &self.workspace_roots,
                &session.configuration.workspace,
                &self.managed_worktrees,
            )
            .await
            .map_err(maka_agent_facts::tools::ToolError::Failed)?;
            self.native_approval_executor
                .prepare(pending, context, cancellation)
                .await
        })
    }
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
        self.start_native_approval_wake();
        let owner = self.clone();
        self.workers.spawn(async move { owner.schedule().await });
    }

    fn start_native_approval_wake(self: &Arc<Self>) {
        let owner = self.clone();
        self.producers.spawn(async move {
            let mut changes = owner.store.subscribe_native_approval_changes();
            let mut controls = owner.store.subscribe_native_approval_control_changes();
            let mut reconcile = true;
            loop {
                changes.borrow_and_update();
                if reconcile {
                    controls.borrow_and_update();
                }
                if owner.stop.is_cancelled() {
                    return;
                }
                let scan = async {
                    if reconcile {
                        owner.store.reconcile_native_approval_controls().await?;
                    }
                    owner.schedule_native_approvals().await
                }
                .await;
                if let Err(error) = scan {
                    owner.queue_failed("", None, &error);
                    owner.runs.state().await.closing = true;
                    owner.stop.cancel();
                    return;
                }
                reconcile = tokio::select! {
                    _ = owner.stop.cancelled() => return,
                    changed = controls.changed() => { if changed.is_err() { return; } true },
                    changed = changes.changed() => { if changed.is_err() { return; } false },
                };
            }
        });
    }

    pub(super) async fn schedule_native_approvals(self: &Arc<Self>) -> Result<(), RunError> {
        for session in self.store.ready_native_approval_sessions().await? {
            if !self.owns(&session) {
                continue;
            }
            let mut runs = self.runs.state().await;
            if runs.closing || self.stop.is_cancelled() {
                return Ok(());
            }
            if runs.controls.contains_key(&session)
                || runs.preparing.contains_key(&session)
                || runs.quarantined.contains(&session)
            {
                continue;
            }
            let cancellation = self.stop.child_token();
            runs.preparing.insert(session.clone(), cancellation.clone());
            let owner = self.clone();
            self.workers.spawn(async move {
                let admission = tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => {
                        owner.runs.state().await.preparing.remove(&session);
                        return;
                    }
                    admission = owner.runs.ordered(&session) => admission,
                };
                let preparation = QueuePreparation {
                    admission,
                    cancellation,
                };
                match owner.advance(&session, None, Some(preparation)).await {
                    Ok(Some(running)) => owner.drive(running).await,
                    Ok(None) => {}
                    Err(error) => owner.queue_failed(&session, None, &error),
                }
            });
        }
        Ok(())
    }

    // Recover the owner-scoped durable backlog without limiting active Sessions.
    async fn schedule(self: &Arc<Self>) {
        if let Err(error) = self.schedule_pending().await {
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
            self.stop.cancel();
            self.runs.state().await.closing = true;
        }
    }
    pub(super) async fn schedule_pending(self: &Arc<Self>) -> Result<(), RunError> {
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
                // The approval wake driver owns parked invocations, including
                // sessions whose next user message survived a restart.
                if self
                    .store
                    .session(session)
                    .await?
                    .native_approval_checkpoint(session)
                    .await?
                    .is_some()
                {
                    continue;
                }
                let mut runs = self.runs.state().await;
                if runs.closing || self.stop.is_cancelled() {
                    return Ok(());
                }
                if runs.busy(session) || runs.quarantined.contains(session) {
                    continue;
                }
                let Ok(admission) = self.runs.try_ordered(session) else {
                    continue;
                };
                let cancellation = self.stop.child_token();
                runs.preparing.insert(session.clone(), cancellation.clone());
                let preparation = QueuePreparation {
                    admission,
                    cancellation,
                };
                let owner = self.clone();
                let session = session.clone();
                self.workers.spawn(async move {
                    match owner.advance(&session, None, Some(preparation)).await {
                        Ok(Some(running)) => owner.drive(running).await,
                        Ok(None) => {}
                        Err(error) => owner.queue_failed(&session, None, &error),
                    }
                });
            }
            after = sessions.last().cloned();
        }
    }
    pub(super) async fn start_pending(
        self: &Arc<Self>,
        session: &str,
        admission: runs::Ordered,
        cancellation: CancellationToken,
    ) -> Result<(), RunError> {
        let preparation = QueuePreparation {
            admission,
            cancellation,
        };
        match self.advance(session, None, Some(preparation)).await {
            Ok(Some(running)) => {
                self.workers.spawn(self.clone().drive(running));
            }
            Ok(None) => {}
            Err(error) => {
                self.queue_failed(session, None, &error);
                return Err(error);
            }
        }
        Ok(())
    }

    async fn advance(
        self: &Arc<Self>,
        session: &str,
        previous: Option<&Invocation>,
        reserved: Option<QueuePreparation>,
    ) -> Result<Option<RunningInvocation>, RunError> {
        let QueuePreparation {
            admission,
            cancellation,
        } = match reserved {
            Some(preparation) => preparation,
            None => QueuePreparation {
                admission: self.runs.ordered(session).await,
                cancellation: self.stop.child_token(),
            },
        };
        {
            let mut runs = admission.state().await;
            if runs.closing || runs.quarantined.contains(session) {
                runs.preparing.remove(session);
                if previous.is_some() {
                    runs.controls.remove(session);
                }
                return Ok(None);
            }
            match (previous, runs.controls.get(session)) {
                (None, None) => {}
                (Some(previous), Some(control)) if previous == &control.invocation => {}
                _ => {
                    runs.preparing.remove(session);
                    return Ok(None);
                }
            }
            runs.preparing.insert(session.into(), cancellation.clone());
        }
        let next = self.next(session, &cancellation).await;
        let mut runs = admission.state().await;
        runs.preparing.remove(session);
        match next {
            Ok(Some((running, basis))) => {
                // A durable start retains its original worker even if close won
                // during admission. Its inherited cancellation drives settlement.
                self.publish(&mut runs, &running, basis);
                Ok(Some(running))
            }
            Ok(None) => {
                if previous.is_some() {
                    runs.controls.remove(session);
                }
                self.goals.execution_changed();
                self.plans.execution_changed();
                Ok(None)
            }
            Err(error) => {
                if error.is_cleanup_unconfirmed() {
                    runs.quarantined.insert(session.into());
                }
                if let Some(control) = runs.controls.get_mut(session) {
                    control.failure = Some("agent_execution_unavailable");
                }
                runs.closing = true;
                self.stop.cancel();
                Err(error)
            }
        }
    }
    fn queue_failed(&self, session: &str, previous: Option<&Invocation>, error: &RunError) {
        if !(self.stop.is_cancelled()
            && matches!(
                error,
                RunError::Cancelled
                    | RunError::Commit(maka_agent_facts::event::CommitError::Retired)
                    | RunError::Store(StoreError::SessionRetired)
            ))
        {
            tracing::error!(stage = "queue_advance_failed", cause = crate::diagnostics::run_cause(error),
                consequence = "owner_closing", session_id = %session,
                turn_id = previous.map(|invocation| invocation.turn_id.as_str()),
                run_id = previous.map(|invocation| invocation.run_id.as_str()),
                invocation_id = previous.map(|invocation| invocation.invocation_id.as_str()),
                activation = %self.revision.activation, "Agent queue advancement failed");
        }
    }
    pub(super) fn publish(
        self: &Arc<Self>,
        runs: &mut Runs,
        running: &RunningInvocation,
        basis: Arc<MessageBasis>,
    ) {
        if let Some(model) = &basis.model {
            self.title_after_message(running.invocation().clone(), model.clone());
        }
        self.goals.execution_changed();
        self.plans.execution_changed();
        runs.controls.insert(
            running.invocation().session_id.clone(),
            Control {
                preview: running.preview(),
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
                if !matches!(completion, Ok(ref value) if value.cleanup.is_ok()) {
                    let mut runs = self.runs.state().await;
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
                let completion = completion.expect("confirmed physical completion");
                if let Ok(ActivationExit::Parked(_)) = completion.result {
                    let mut runs = self.runs.state().await;
                    runs.controls.remove(&session);
                    drop(runs);
                    // An answer can commit while the previous activation still owns
                    // admission. Recheck only after that worker confirms cleanup.
                    if let Err(error) = self.schedule_native_approvals().await {
                        self.queue_failed(&session, Some(&invocation), &error);
                    }
                    return;
                }
                match self.advance(&session, Some(&invocation), None).await {
                    Ok(Some(next)) => running = next,
                    Ok(None) => return,
                    Err(error) => {
                        self.queue_failed(&session, Some(&invocation), &error);
                        return;
                    }
                }
            }
        })
    }
    async fn next(
        self: &Arc<Self>,
        session: &str,
        cancellation: &CancellationToken,
    ) -> Result<Option<(RunningInvocation, Arc<MessageBasis>)>, RunError> {
        loop {
            if cancellation.is_cancelled() {
                return Ok(None);
            }
            let store = self.store.session(session).await?;
            if let Some(checkpoint) = store.native_approval_checkpoint(session).await? {
                return self
                    .prepare_native_approval_resume(checkpoint, cancellation)
                    .await;
            }
            let mut queue = store.message_queue(session).await?;
            if queue.entries.is_empty() {
                return Ok(None);
            }
            let selected = queue
                .entries
                .iter()
                .position(|entry| entry.source.disposition == MessageDisposition::Steering)
                .unwrap_or(0);
            let entry = queue.entries.swap_remove(selected);
            drop(queue);
            if let Some(running) = self.prepare_selected(session, &entry, cancellation).await? {
                return Ok(Some(running));
            }
        }
    }
    async fn prepare_native_approval_resume(
        self: &Arc<Self>,
        checkpoint: maka_event_log::native_approvals::NativeApprovalCheckpoint,
        cancellation: &CancellationToken,
    ) -> Result<Option<(RunningInvocation, Arc<MessageBasis>)>, RunError> {
        let invocation = checkpoint.checkpoint.invocation.clone();
        let basis: MessageBasis =
            serde_json::from_value(checkpoint.checkpoint.native_basis.clone()).map_err(
                |error| RunError::InvalidInput(format!("invalid native approval basis: {error}")),
            )?;
        let basis = Arc::new(basis);
        let store = self.store.session(&invocation.session_id).await?;
        let mut configuration = store
            .invocation_configuration(&invocation)
            .await?
            .ok_or_else(|| {
                RunError::ReconciliationRequired("parked invocation has no configuration".into())
            })?;
        let session = self
            .session(&invocation.session_id)
            .await
            .map_err(RunError::InvalidInput)?;
        // Execution custody is always issued against the current permission ceiling.
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
        let tool_names = self
            .tools
            .names()
            .into_iter()
            .filter(|name| {
                basis
                    .allowed_tools
                    .as_ref()
                    .is_none_or(|allowed| allowed.contains(name))
            })
            .collect();
        let owner = self.clone();
        let continuation_basis = basis.clone();
        let continuation_configuration = configuration.clone();
        let continuation = Box::pin(async move {
            let basis = continuation_basis;
            let configuration = continuation_configuration;
            workspace::validate(
                &owner.workspace_roots,
                &basis.workspace,
                &owner.managed_worktrees,
            )
            .await
            .map_err(RunError::InvalidInput)?;
            if owner.stop.is_cancelled() {
                return Err(RunError::Cancelled);
            }
            let model = basis.model.clone().ok_or_else(|| {
                RunError::InvalidInput("native approval requires model basis".into())
            })?;
            let source = crate::model::Source::restore(
                owner.configuration.clone(),
                owner.credentials.clone(),
                model,
                invocation.session_id.clone(),
                owner.revision.clone(),
            )?;
            let prepared = source.capture().await?;
            if owner.stop.is_cancelled() {
                return Err(RunError::Cancelled);
            }
            let tools = owner
                .selected_tools(
                    &basis,
                    configuration.tool_discovery,
                    configuration.editing_tools,
                )
                .map_err(RunError::InvalidInput)?;
            let settings = maka_agent_engine::RunInput {
                invocation: invocation.clone(),
                model_source: Some(Arc::new(source)),
                model_revision: Some(prepared.revision),
                provider_id: prepared.provider_id,
                context: prepared.context,
                provider: prepared.provider,
                provider_options: prepared.options,
                main_output_limit: prepared.main_output_limit,
                supports_vision: prepared.supports_vision,
                request_fingerprint: Some(basis.fingerprint.clone()),
                configuration: configuration.clone(),
                native_activation_basis: Some(basis.clone()),
                work: (),
            };
            Ok(maka_agent_engine::ResumeContinuation { settings, tools })
        });
        let input = maka_agent_engine::ResumeInput {
            configuration,
            continuation,
            tool_names,
            checkpoint,
            executor: self.clone(),
            owner_shutdown: self.stop.clone(),
            host_epoch: self.revision.activation.clone(),
        };
        match self
            .engine
            .start_resume(store, input, cancellation.clone())
            .await
        {
            Ok(running) => Ok(Some((running, basis))),
            Err(RunError::Busy) => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub(super) async fn prepare_selected(
        &self,
        session: &str,
        entry: &PendingMessageAdmission,
        cancellation: &CancellationToken,
    ) -> Result<Option<(RunningInvocation, Arc<MessageBasis>)>, RunError> {
        if entry.execution.owner != self.prefix || !self.owns(session) {
            return Err(RunError::InvalidInput("agent_queue_owner_invalid".into()));
        }
        let invocation = if entry.source.disposition == MessageDisposition::TurnStarted {
            entry.invocation.clone()
        } else {
            let identity = hex::encode(Sha256::digest(entry.source.message.message_id.as_bytes()));
            Invocation {
                session_id: session.into(),
                turn_id: format!("t_{identity}"),
                run_id: format!("r_{identity}"),
                invocation_id: format!("i_{identity}"),
            }
        };
        let attempt = async {
            let prepared = self.prepare_pending(entry, invocation.clone()).await;
            if cancellation.is_cancelled() {
                return Ok(None);
            }
            let result = match prepared {
                Ok((input, basis)) => self
                    .start(input, cancellation.clone())
                    .await
                    .map(|running| (running, basis)),
                Err(reason) => {
                    self.fail_pending(invocation, entry, reason).await?;
                    return Ok(None);
                }
            };
            match result {
                Ok(running) => Ok(Some(running)),
                Err(RunError::Cancelled) if cancellation.is_cancelled() => Ok(None),
                Err(error @ (RunError::InvalidInput(_) | RunError::ReconciliationRequired(_))) => {
                    if !cancellation.is_cancelled() {
                        self.fail_pending(invocation, entry, public_error(error))
                            .await?;
                    }
                    Ok(None)
                }
                Err(error) => Err(error),
            }
        }
        .await;
        match attempt {
            Ok(value) => Ok(value),
            Err(error @ RunError::Commit(maka_agent_facts::event::CommitError::Rejected(_))) => {
                // Stop can commit its exact source retraction before its
                // observer gets to cancel the preparing worker's token.
                let cancelled = async {
                    let store = self.store.session(session).await?;
                    store.message_cancelled(session, &entry.source.message.message_id).await
                }.await.map_err(|lookup| RunError::Internal(format!(
                    "pending admission rejected ({error}); cancellation lookup failed ({lookup})"
                )))?;
                if cancelled {
                    return Ok(None);
                }
                Err(error)
            }
            // SQL/commit uncertainty and physical cleanup failures do not
            // establish a deterministic rejection of the accepted message.
            Err(error) => Err(error),
        }
    }

    async fn prepare_pending(
        &self,
        entry: &PendingMessageAdmission,
        invocation: Invocation,
    ) -> Result<(PreparedRun, Arc<MessageBasis>), String> {
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
        let basis = Arc::new(basis);
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
        basis: Arc<MessageBasis>,
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
                    native_activation_basis: Some(basis.clone()),
                    request_fingerprint: Some(basis.fingerprint.clone()),
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
                    request_fingerprint: Some(basis.fingerprint.clone()),
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
        let physical = {
            let runs = self.runs.state().await;
            runs.controls
                .get(session)
                .filter(|control| control.invocation.invocation_id == invocation)
                .map(|control| {
                    (
                        control.invocation.clone(),
                        control.cancellation.clone(),
                        runs.preparing.get(session).cloned(),
                    )
                })
        };
        let (original, cancellation, preparing) = match physical {
            Some((original, cancellation, preparing)) => (original, Some(cancellation), preparing),
            None => {
                let store = self
                    .store
                    .session(session)
                    .await
                    .map_err(|error| error.to_string())?;
                let Some(parked) = store
                    .native_approval_checkpoint(session)
                    .await
                    .map_err(|_| "agent_execution_unavailable")?
                    .filter(|parked| parked.checkpoint.invocation.invocation_id == invocation)
                else {
                    return Ok(false);
                };
                (parked.checkpoint.invocation, None, None)
            }
        };
        let command = InterruptCommand {
            host_epoch: self.revision.activation.clone(),
            session_id: session.into(),
            interrupt_id: self.operation_id(operation),
            turn_id: original.turn_id.clone(),
            run_id: original.run_id.clone(),
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
                .interrupt_message_queue(&command, revision, Some(&original))
                .await
            {
                Ok(InterruptReceipt::Fenced(_)) => {
                    if let Some(cancellation) = &cancellation {
                        cancellation.cancel();
                    }
                    self.store
                        .session(session)
                        .await
                        .map_err(|error| error.to_string())?
                        .stop_native_approvals(&original, now())
                        .await
                        .map_err(|_| "agent_queue_unavailable")?;
                    if let Some(preparing) = preparing {
                        preparing.cancel();
                    }
                    return Ok(true);
                }
                Ok(InterruptReceipt::Conflict) => return Ok(false),
                Err(StoreError::RevisionConflict { .. }) => continue,
                Err(_) => return Err("agent_queue_unavailable".into()),
            }
        }
    }
}
