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
use futures_util::{FutureExt, StreamExt, future::BoxFuture, stream::FuturesUnordered};
use maka_agent_facts::durable::*;
use maka_agent_facts::tools::ToolError;
use maka_agent_state::{
    Admission, ContentBlob, ReadyCause,
    queue::{Consume, QueueCommand, QueueEdit},
};
use maka_plugin_core::operation::OperationCleanup;

type AdmissionWaits = FuturesUnordered<BoxFuture<'static, ()>>;
type AdmissionGuards = (runs::Ordered, Option<tokio::sync::OwnedMutexGuard<()>>);

impl Owner {
    pub fn activated(self: &Arc<Self>) {
        if self.store.checkpoint_execution().is_none() {
            self.recover_removed_sessions();
        }
        self.scheduler.bind(self);
        self.todo.bind(self);
        self.recall
            .authority
            .set(Arc::downgrade(self))
            .expect("Recall bound once");
        self.bot.bind(self);
        self.goals.bind(self);
        // Managed execution owns one ordinary Session, not Root-wide producers.
        if self.store.checkpoint_execution().is_none() {
            self.start_goals();
            self.start_schedules();
            self.start_bot_wake();
            self.start_completion_notifications();
        }
        let owner = self.clone();
        self.producers.spawn(async move { owner.schedule().await });
    }

    /// The SQL levels choose runnable work. Notices only invalidate that read.
    async fn schedule(self: Arc<Self>) {
        let mut changes = match self.durable.subscribe() {
            Ok(changes) => changes,
            Err(error) => {
                tracing::error!(%error, "Agent ready subscription failed");
                return;
            }
        };
        let root = match self.store.owned_root() {
            Ok(root) => root,
            Err(_) => return,
        };
        if let Some(execution) = self.store.checkpoint_execution()
            && let Err(error) = execution.check().await
        {
            tracing::error!(%error, "Execution authority refused queue recovery");
            return;
        }
        if let Err(error) = self
            .durable
            .queue()
            .recover_undelivered_steering(
                self.run_owner(),
                self.store
                    .checkpoint_execution()
                    .map(|e| e.grant().binding.source.session.clone()),
                UnixMillis(now() as i64),
            )
            .await
        {
            tracing::error!(%error, "Failed to recover undelivered steering");
        }
        let mut sources = root.capability_changes();
        let mut cause = ReadyCause::CapabilitySourceChanged;
        let mut cold_probe = true;
        let mut authority_due: Option<UnixMillis> = None;
        loop {
            changes.borrow_and_update();
            if self.stop.is_cancelled() {
                return;
            }
            let at = UnixMillis(now() as i64);
            promote_authority_due(at, &mut authority_due, &mut cause);
            match self.reconcile_model_readers(cold_probe).await {
                Ok(()) => cold_probe = false,
                Err(_) => tracing::error!(
                    stage = "model_cleanup_reconciliation_failed",
                    "Agent model cleanup reconciliation failed"
                ),
            }
            let mut admission_waits = match self.schedule_ready_at(at, cause).await {
                Ok(waits) => waits,
                Err(error) => {
                    tracing::error!(
                        stage = "ready_reconciliation_failed",
                        %error,
                        "Agent ready reconciliation failed"
                    );
                    AdmissionWaits::new()
                }
            };
            if cause == ReadyCause::CapabilitySourceChanged {
                match self
                    .durable
                    .next_due_after_with_cause(self.run_owner(), at, cause)
                    .await
                {
                    Ok(due) => authority_due = due,
                    Err(_) => tracing::error!(
                        stage = "authority_due_read_failed",
                        "Agent source-driven due read failed"
                    ),
                }
            }
            let ordinary_due = match self.durable.next_due_after(self.run_owner(), at).await {
                Ok(due) => due,
                Err(_) => {
                    tracing::error!(stage = "due_read_failed", "Agent due read failed");
                    None
                }
            };
            let due = ordinary_due.into_iter().chain(authority_due).min();
            let deadline = async {
                match due {
                    Some(due) => {
                        tokio::time::sleep(Duration::from_millis(
                            due.0.saturating_sub(now() as i64).max(0) as u64,
                        ))
                        .await
                    }
                    None => std::future::pending::<()>().await,
                }
            };
            cause = ReadyCause::Ordinary;
            tokio::select! {
                biased;
                _ = self.stop.cancelled() => return,
                changed = sources.changed() => {
                    if changed.is_err() { return; }
                    cause = ReadyCause::CapabilitySourceChanged;
                },
                changed = changes.changed() => if changed.is_err() { return; },
                _ = self.wake_notify.notified() => {},
                _ = admission_waits.next(), if !admission_waits.is_empty() => {},
                _ = deadline => {
                    if authority_due.is_some_and(|due| due.0 <= now() as i64) {
                        cause = ReadyCause::CapabilitySourceChanged;
                        authority_due = None;
                    }
                },
            }
        }
    }

    pub(super) async fn schedule_ready_at(
        self: &Arc<Self>,
        at: UnixMillis,
        cause: ReadyCause,
    ) -> Result<AdmissionWaits, String> {
        if let Some(execution) = self.store.checkpoint_execution() {
            execution.check().await.map_err(|e| e.to_string())?;
        }
        let waits = AdmissionWaits::new();
        let mut sessions = BTreeSet::new();
        let mut after = None;
        loop {
            let page = self
                .durable
                .ready_runs_with_cause(self.run_owner(), at, after, 64, cause)
                .await
                .map_err(|e| e.to_string())?;
            if page.is_empty() {
                break;
            }
            for entry in page {
                after = Some(entry.admission_sequence);
                if !self.execution_contains_session(&entry.session_id) {
                    continue;
                }
                if let maka_agent_state::DriverPurpose::LateExternalCleanup { task } = entry.purpose
                {
                    if let Err(error) = self.wake_cleanup(entry.run, entry.session_id, task).await {
                        tracing::error!(run = %entry.run, %error, "Original cleanup source could not be scheduled");
                    }
                    continue;
                }
                {
                    let runs = self.runs.state().await;
                    if runs
                        .preparing
                        .get(&entry.session_id)
                        .is_some_and(|preparing| preparing.run == entry.run)
                        || runs
                            .controls
                            .get(&entry.session_id)
                            .is_some_and(|control| control.execution.run_id == entry.run)
                    {
                        continue;
                    }
                }
                // One unreadable Run must not stop admission for every other session.
                if let Err(error) = self.wake_run(entry.run).await {
                    tracing::error!(run = %entry.run, %error, "Agent Run could not be scheduled");
                }
            }
        }
        let mut after = None;
        loop {
            let page = self
                .durable
                .queue()
                .ready(self.run_owner(), after.clone(), 64)
                .await
                .map_err(|e| e.to_string())?;
            if page.is_empty() {
                break;
            }
            for ready in page {
                after = Some(ready.cursor);
                let session = ready.entry.request.spec.session_id.clone();
                if !self.execution_contains_session(&session) {
                    continue;
                }
                if !ready.entry.placement.is_followup() {
                    continue;
                }
                if !sessions.insert(session.clone()) || self.runs.state().await.busy(&session) {
                    continue;
                }
                let (ordered, goal) = match self.queue_admission(
                    &session,
                    matches!(ready.entry.request.spec.trigger, Trigger::Goal { .. }),
                ) {
                    Ok(guards) => guards,
                    Err(wait) => {
                        waits.push(wait);
                        continue;
                    }
                };
                let owner = self.clone();
                self.workers.spawn(async move {
                    if let Err(error) = owner.admit_queued(&session, ready.entry.request.id, ordered, goal).await {
                        tracing::error!(%session, %error, "Original queued admission requires reconciliation");
                    }
                });
            }
        }
        // A queue write can wake us before its admission locks are released.
        // Retry on unlock even if there are no further durable changes.
        Ok(waits)
    }

    pub(super) fn queue_admission(
        &self,
        session: &str,
        is_goal: bool,
    ) -> Result<AdmissionGuards, BoxFuture<'static, ()>> {
        let goal = if is_goal {
            match self.goals.gate.clone().try_lock_owned() {
                Ok(goal) => Some(goal),
                Err(_) => {
                    let gate = self.goals.gate.clone();
                    return Err(async move { drop(gate.lock_owned().await) }.boxed());
                }
            }
        } else {
            None
        };
        match self.runs.try_ordered(session) {
            Ok(ordered) => Ok((ordered, goal)),
            Err(_) => {
                let runs = self.runs.clone();
                let session = session.to_owned();
                Err(async move { drop(runs.ordered(&session).await) }.boxed())
            }
        }
    }

    async fn admit_queued(
        self: &Arc<Self>,
        session: &str,
        request: maka_agent_state::queue::RequestId,
        ordered: runs::Ordered,
        goal: Option<tokio::sync::OwnedMutexGuard<()>>,
    ) -> Result<(), String> {
        if self.stop.is_cancelled() {
            return Ok(());
        }
        self.require_execution(session).await?;
        let original = self
            .durable
            .queue()
            .entry(session.into(), request.clone())
            .await
            .map_err(|e| e.to_string())?
            .ok_or("agent_queue_request_unavailable")?;
        self.require_execution_spec(&original.request.spec).await?;
        let busy = {
            let runs = ordered.state().await;
            runs.closing || runs.busy(session)
        };
        if busy {
            return Ok(());
        }
        let previous = self
            .durable
            .latest_run(session.into())
            .await
            .map_err(|e| e.to_string())?;
        if let Some(run) = previous {
            let latest = self
                .durable
                .frontier(run)
                .await
                .map_err(|e| e.to_string())?;
            if latest.terminal.is_none() || latest.blocks_followup() {
                return Ok(());
            }
        }
        if let Trigger::Goal { goal_id } = &original.request.spec.trigger {
            if goal.is_none() {
                return Err("agent_goal_admission_source_changed".into());
            }
            self.check_goal_background(session, *goal_id).await?;
        }
        let queue = self
            .durable
            .queue()
            .read(session.into())
            .await
            .map_err(|e| e.to_string())?;
        let Some(entry) = queue
            .entries
            .iter()
            .find(|entry| entry.placement.is_followup())
        else {
            return Ok(());
        };
        if entry.request.id != request {
            return Ok(());
        }
        let current = self.mutable_session(session).await?;
        if current.archived {
            return Err("agent_session_configuration_changed".into());
        }
        // This is a current Root capability check, not acceptance of the saved permission basis.
        let scope = self
            .current_work_scope(session, &current.configuration)
            .await
            .map_err(|e| e.to_string())?;
        let basis = match &entry.request.spec.budget_basis {
            Some(reference) => Some(
                self.durable
                    .queue()
                    .content(session.into(), request.clone(), reference.clone())
                    .await
                    .map_err(|error| error.to_string())?,
            ),
            None => None,
        };
        let guard =
            self.restore_budget_guard(&entry.request.spec, basis, &entry.request.message_id)?;
        let at = UnixMillis(now() as i64);
        let mut queued = entry.request.clone();
        let replacement = match &mut queued.spec.backend {
            BackendSpec::Executor {
                selection,
                descriptor,
            } if selection.executor == "external"
                && selection.settings.runtime.as_deref() == Some("antigravity")
                && queued.spec.budget_basis.is_none()
                && matches!(&queued.spec.trigger, Trigger::Message { .. }) =>
            {
                let accepted = self.executors.select(selection.clone())?.accepted;
                let current = ContentBlob::json(&accepted).map_err(|error| error.to_string())?;
                if current.reference() == descriptor {
                    None
                } else {
                    *descriptor = current.reference().clone();
                    Some(current)
                }
            }
            _ => None,
        };
        let mut replacements: Vec<_> = replacement.into_iter().collect();
        if previous.is_none()
            && matches!(queued.spec.trigger, Trigger::Message { .. })
            && let Some(seed) = current.configuration.dossier_seed.as_deref()
        {
            self.seed_dossier_input(session, &mut queued, seed, &mut replacements)
                .await?;
        }
        let (lease, effects) = scope.accept(self.stop.child_token());
        let committed: Result<Option<RunId>, String> = async {
            let selected = lease.store();
            let custody = selected.work_custody().map_err(|error| error.to_string())?;
            let writer = self
                .store
                .data_writer_for_work(custody.as_ref(), session)
                .map_err(|error| error.to_string())?;
            let state = self
                .durable
                .with_data_writer(writer.clone())
                .map_err(|error| error.to_string())?;
            // Preserve submission identity when freezing the first thread context or refreshing an executor.
            let expected_revision = if !replacements.is_empty() {
                let update = state
                    .queue()
                    .execute(
                        session.into(),
                        QueueCommand {
                            id: FactId::new(),
                            at,
                            expected_revision: queue.revision,
                            edit: QueueEdit::Update {
                                request: Box::new(queued.clone()),
                            },
                        },
                        replacements,
                    )
                    .await;
                match update {
                    Ok(commit) => commit.revision,
                    Err(error)
                        if matches!(
                            error.underlying(),
                            maka_event_log::StoreError::RevisionConflict { .. }
                        ) =>
                    {
                        return Ok(None);
                    }
                    Err(error) => return Err(error.to_string()),
                }
            } else {
                queue.revision
            };
            let mut contents = Vec::new();
            let mut guard = guard;
            use maka_agent_facts::memory::MemoryAdmission;
            if queued.spec.budget_basis.is_none()
                && matches!(
                    queued.spec.memory_admission,
                    MemoryAdmission::Enabled | MemoryAdmission::Disabled
                )
            {
                let policy = self
                    .configuration
                    .runtime_policy()
                    .await
                    .map_err(|error| error.to_string())?;
                let eligible = matches!(queued.spec.backend, BackendSpec::Model { .. })
                    && queued.spec.workspace == current.configuration.workspace.path
                    && queued.spec.permission_basis == current.configuration.permission_basis();
                let kind =
                    self.memory_admission(session, &current.configuration, eligible, &policy);
                queued.spec.memory_admission = kind;
                queued.spec.memory_projection = None;
                if kind == MemoryAdmission::Enabled {
                    let capture = self
                        .pin_capture(session, &current.configuration, policy.revision)
                        .await?;
                    let memory = writer
                        .query(capture.clone())
                        .await
                        .map_err(|error| error.to_string())?;
                    if let Some(memory) = memory {
                        let blob = ContentBlob::json(&memory).map_err(|error| error.to_string())?;
                        queued.spec.memory_projection = Some(blob.reference().clone());
                        contents.push(blob);
                    }
                    guard = Some(Arc::new(capture));
                    if self
                        .configuration
                        .runtime_policy()
                        .await
                        .map_err(|error| error.to_string())?
                        .revision
                        != policy.revision
                    {
                        self.wake_notify.notify_one();
                        return Ok(None);
                    }
                }
            }
            let mut admission = Admission::new(queued.spec, at, contents).with_queue(Consume {
                session: session.into(),
                requests: vec![request],
                expected_revision,
            });
            if let Some(guard) = guard {
                admission = admission.with_guard(guard);
            }
            let run = admission.run();
            for retry in [false, true] {
                let error = match state.admit(admission.clone()).await {
                    Ok(_) => return Ok(Some(run)),
                    Err(error)
                        if matches!(
                            error.underlying(),
                            maka_event_log::StoreError::RevisionConflict { .. }
                        ) =>
                    {
                        self.wake_notify.notify_one();
                        return Ok(None);
                    }
                    Err(error) => error,
                };
                if !matches!(
                    error.underlying(),
                    maka_event_log::StoreError::CommitUnknown(_)
                        | maka_event_log::StoreError::OperationUnknown
                ) {
                    return Err(error.to_string());
                }
                // The FIFO read settles the original SQL write. The queue cut
                // is consumed atomically with admission, before any tools run.
                if state
                    .admission_recorded(&admission)
                    .await
                    .map_err(|error| error.to_string())?
                {
                    return Ok(Some(run));
                }
                if retry {
                    return Err(error.to_string());
                }
            }
            unreachable!("admission retries once after the original write is proven absent")
        }
        .await;
        if effects.settle().await.is_err() {
            lease.retain_unconfirmed(());
            return Err("agent_admission_cleanup_unconfirmed".into());
        }
        lease.finish();
        let Some(run) = committed? else {
            return Ok(());
        };
        drop(ordered);
        drop(goal);
        self.wake_run(run).await
    }

    pub(super) async fn wake_run(self: &Arc<Self>, run: RunId) -> Result<(), String> {
        let view = self
            .durable
            .frontier(run)
            .await
            .map_err(|e| e.to_string())?;
        if view.spec.owner != self.run_owner() || !matches!(view.spec.origin, RunOrigin::Local) {
            return Ok(());
        }
        if !self.execution_contains_session(&view.spec.session_id) {
            return Ok(());
        }
        self.require_execution_spec(&view.spec).await?;
        {
            let mut runs = self.runs.state().await;
            if view.terminal.is_some() {
                if runs
                    .failed_frontiers
                    .get(&view.spec.session_id)
                    .is_some_and(|(failed_run, _)| *failed_run == run)
                {
                    runs.failed_frontiers.remove(&view.spec.session_id);
                }
                return Ok(());
            }
            if !runs.can_probe(&view.spec.session_id, run, view.revision) {
                return Ok(());
            }
        }
        let cancellation = self.stop.child_token();
        let Some(claim) = self
            .durable
            .reserve_driver(
                run,
                maka_agent_state::DriverPurpose::Business,
                cancellation.clone(),
            )
            .await
            .map_err(|error| error.to_string())?
        else {
            return Ok(());
        };
        let mut runs = self.runs.state().await;
        if !runs.can_probe(&view.spec.session_id, run, view.revision) {
            claim.deactivate();
            return Ok(());
        }
        let revision = view.revision;
        let session = view.spec.session_id;
        runs.failed_frontiers.remove(&session);
        let owner = self.clone();
        let token = cancellation.clone();
        let target = session.clone();
        let job = self.workers.spawn(async move {
            let activity = super::cleanup_driver::DriverActivity(claim.clone());
            let ordered = tokio::select! {
                biased;
                _ = token.cancelled() => None,
                ordered = owner.runs.ordered(&target) => Some(ordered),
            };
            let admitted = if let Some(ordered) = ordered {
                let state = ordered.state().await;
                let current = !state.closing
                    && !token.is_cancelled()
                    && state
                        .preparing
                        .get(&target)
                        .is_some_and(|preparing| preparing.run == run);
                drop(state);
                drop(ordered);
                current
            } else {
                false
            };
            if admitted {
                let (cleanup, retry_ready) = owner
                    .clone()
                    .drive_local(claim, activity, target, revision, token)
                    .await;
                owner.physical_availability_changed_after(retry_ready);
                return cleanup;
            }
            let mut state = owner.runs.state().await;
            if state
                .preparing
                .get(&target)
                .is_some_and(|preparing| preparing.run == run)
            {
                state.preparing.remove(&target);
            }
            drop(state);
            drop(claim);
            drop(activity);
            owner.physical_availability_changed();
            OperationCleanup::Confirmed
        });
        let completion = async move {
            match job.await {
                Ok(cleanup) => cleanup,
                Err(_) => OperationCleanup::Unconfirmed,
            }
        }
        .boxed()
        .shared();
        runs.preparing.insert(
            session,
            PreparingRun {
                run,
                cancellation,
                completion,
            },
        );
        drop(runs);
        Ok(())
    }

    async fn drive_local(
        self: Arc<Self>,
        mut claim: maka_agent_state::DriverClaim,
        activity: super::cleanup_driver::DriverActivity,
        session: String,
        scheduled_revision: u64,
        cancellation: CancellationToken,
    ) -> (OperationCleanup, bool) {
        let mut activity = Some(activity);
        let run = claim.run();
        let initial = async {
            let root = self
                .store
                .owned_root()
                .map_err(|error| ("root_source_read_failed", RunError::from(error)))?;
            let view = self
                .durable
                .frontier(run)
                .await
                .map_err(|error| ("run_frontier_read_failed", RunError::from(error)))?;
            Ok::<_, (&'static str, RunError)>((root, view))
        }
        .await;
        let (root, view) = match initial {
            Ok(current) => current,
            Err((stage, error)) => {
                tracing::error!(%run, %error, stage, "Agent Run capability probe could not start");
                drop(activity.take());
                let mut runs = self.runs.state().await;
                if runs
                    .preparing
                    .get(&session)
                    .is_some_and(|preparing| preparing.run == run)
                {
                    runs.preparing.remove(&session);
                }
                runs.failed_frontiers
                    .insert(session, (run, scheduled_revision));
                drop(runs);
                return (OperationCleanup::Confirmed, false);
            }
        };
        let mut sources = root.capability_changes();
        sources.borrow_and_update();
        let turn = view.spec.turn_id.clone();
        let mut revision = view.revision;
        let mut view = Some(view);
        let mut retries = 0;
        let mut taken_over = false;
        let (result, cleanup) = loop {
            let current = view
                .take()
                .expect("driver view is read before each attempt");
            let (result, cleanup) = self
                .run_with_capabilities(current, claim.clone(), cancellation.clone())
                .await;
            drop(activity.take());
            let transient = matches!(cleanup, OperationCleanup::Confirmed)
                && result.as_ref().is_err_and(transient_driver_error);
            if !transient || retries == DRIVER_RETRY_DELAYS.len() {
                break (result, cleanup);
            }
            let cancelled = tokio::select! {
                biased;
                _ = cancellation.cancelled() => true,
                _ = tokio::time::sleep(DRIVER_RETRY_DELAYS[retries]) => false,
            };
            if cancelled {
                break (Err(RunError::Cancelled), cleanup);
            }
            retries += 1;
            let retried = async {
                let fresh = self
                    .durable
                    .reserve_driver(
                        run,
                        maka_agent_state::DriverPurpose::Business,
                        cancellation.clone(),
                    )
                    .await?;
                Ok::<_, maka_event_log::StoreError>(match fresh {
                    Some(fresh) => Some((fresh, self.durable.frontier(run).await?)),
                    None => None,
                })
            }
            .await;
            match retried {
                Ok(Some((fresh, current))) => {
                    activity = Some(super::cleanup_driver::DriverActivity(fresh.clone()));
                    claim = fresh;
                    revision = current.revision;
                    view = Some(current);
                }
                Ok(None) => {
                    taken_over = true;
                    break (Ok(maka_agent_engine::DriverExit::Retired { run }), cleanup);
                }
                Err(error) => break (Err(error.into()), cleanup),
            }
        };
        let result = match result {
            Err(error)
                if !taken_over
                    && matches!(cleanup, OperationCleanup::Confirmed)
                    && !self.stop.is_cancelled()
                    && !cancellation.is_cancelled()
                    && fails_run(&error) =>
            {
                let diagnostic = format!("Maka could not continue this turn: {error}");
                match Engine::new(self.durable.clone())
                    .fail_after_driver_error(&claim, diagnostic, UnixMillis(now() as i64))
                    .await
                {
                    Ok(exit) => {
                        tracing::error!(%run, %error, "Agent Run failed after a driver error");
                        Ok(exit)
                    }
                    Err(failure) => {
                        tracing::error!(%run, %error, %failure, "Agent Run failure could not be recorded");
                        Err(error)
                    }
                }
            }
            result => result,
        };
        if matches!(&cleanup, OperationCleanup::Unconfirmed) {
            tracing::error!(stage = "queue_cleanup_unconfirmed", cause = "cleanup_unconfirmed", consequence = "resources_retained", run_id = %run, session_id = %session, turn_id = %turn, activation = %self.revision.activation, outcome = ?result, "Agent original Root work remains unconfirmed");
        } else if let Err(error) = &result {
            let cause = match error {
                RunError::Store(error)
                    if matches!(
                        error.underlying(),
                        maka_event_log::StoreError::EventConflict
                    ) =>
                {
                    "store_event_conflict"
                }
                RunError::Store(error)
                    if matches!(error.underlying(), maka_event_log::StoreError::Sqlite(_)) =>
                {
                    "store_sqlite"
                }
                RunError::Store(_)
                | RunError::Commit(_)
                | RunError::PublicationUncertain { .. } => "store_unavailable",
                RunError::Internal(_) => "worker_failed",
                _ => "execution_failed",
            };
            let error_variant = match error {
                RunError::Blocked(_) => "blocked",
                RunError::PublicationUncertain { .. } => "publication_uncertain",
                RunError::Busy => "busy",
                RunError::ContinuationChanged => "continuation_changed",
                RunError::ReconciliationRequired(_) => "reconciliation_required",
                RunError::InvalidInput(_) => "invalid_input",
                RunError::FrozenMemoryDenied(_) => "frozen_memory_denied",
                RunError::ModelUnavailable => "model_unavailable",
                RunError::AuthenticationRequired => "authentication_required",
                RunError::IsolationUnavailable(_) => "isolation_unavailable",
                RunError::CompactionFailed(_) | RunError::CompactionMismatch => "compaction_failed",
                RunError::Cancelled => "cancelled",
                RunError::ModelIncomplete => "model_incomplete",
                RunError::Commit(_) => "commit",
                RunError::Store(_) => "store",
                RunError::Model(_) => "model",
                RunError::Tool(_) => "tool",
                RunError::CleanupUnconfirmed => "cleanup_unconfirmed",
                RunError::Internal(_) => "internal",
                RunError::Json(_) => "json",
                RunError::Preparation(_) => "preparation",
                RunError::InvalidImage(_) => "invalid_image",
                RunError::PreparationCleanup(_) => "preparation_cleanup",
            };
            let tool_error_variant = match error {
                RunError::Tool(error) => match error {
                    ToolError::Failed(_) => "failed",
                    ToolError::Native(_) => "native",
                    ToolError::Io { .. } => "io",
                    ToolError::Persistence(_) => "persistence",
                    ToolError::OutcomeUnknown(_) => "outcome_unknown",
                    ToolError::OperationUnknown { .. } => "operation_unknown",
                    ToolError::OperationCleanupUnconfirmed { .. } => {
                        "operation_cleanup_unconfirmed"
                    }
                    ToolError::CleanupUnconfirmed(_) => "cleanup_unconfirmed",
                },
                _ => "none",
            };
            tracing::error!(stage = "queue_advance_failed", cause, error_variant, tool_error_variant, consequence = "operation_failed", run_id = %run, session_id = %session, turn_id = %turn, activation = %self.revision.activation, "Agent driver operation failed after physical settlement");
        }
        let authority_unavailable = match &result {
            Ok(maka_agent_engine::DriverExit::Blocked { blockers, .. }) => {
                blockers.iter().any(|(_, reason)| {
                    matches!(reason, BlockerKind::CurrentAuthorityUnavailable { .. })
                })
            }
            Err(RunError::Blocked(reason)) => matches!(
                reason.as_ref(),
                BlockerKind::CurrentAuthorityUnavailable { .. }
            ),
            _ => false,
        };
        let retry = self
            .finish_local_probe(
                run,
                &session,
                authority_unavailable,
                (result.is_err() && !authority_unavailable).then_some(revision),
                &sources,
            )
            .await;
        drop(root);
        (cleanup, retry)
    }
    pub(super) async fn finish_local_probe(
        &self,
        run: RunId,
        session: &str,
        authority_unavailable: bool,
        failed_revision: Option<u64>,
        sources: &tokio::sync::watch::Receiver<()>,
    ) -> bool {
        let mut runs = self.runs.state().await;
        if runs
            .preparing
            .get(session)
            .is_some_and(|preparing| preparing.run == run)
        {
            runs.preparing.remove(session);
        }
        if runs
            .controls
            .get(session)
            .is_some_and(|control| control.execution.run_id == run)
        {
            runs.controls.remove(session);
        }
        if let Some(revision) = failed_revision {
            runs.failed_frontiers
                .insert(session.into(), (run, revision));
        }
        drop(runs);
        // The actual Root is retained by the probing caller until this check.
        let changed = sources
            .has_changed()
            .expect("live probing Root retains its source sender");
        !authority_unavailable || changed
    }
}

const DRIVER_RETRY_DELAYS: [Duration; 3] = [
    Duration::from_secs(1),
    Duration::from_secs(4),
    Duration::from_secs(16),
];

fn transient_driver_error(error: &RunError) -> bool {
    use maka_event_log::StoreError;
    let RunError::Store(error) = error else {
        return false;
    };
    match error.underlying() {
        StoreError::WriterBusy | StoreError::CommitUnknown(_) | StoreError::OperationUnknown => {
            true
        }
        StoreError::Sqlite(rusqlite::Error::SqliteFailure(failure, _)) => matches!(
            failure.code,
            rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
        ),
        _ => false,
    }
}

/// Whether a driver error leaves a Run that no driver will advance again.
fn fails_run(error: &RunError) -> bool {
    !error.is_cleanup_unconfirmed()
        && !matches!(error, RunError::Cancelled)
        && !matches!(error, RunError::Blocked(reason)
            if matches!(reason.as_ref(), BlockerKind::CurrentAuthorityUnavailable { .. }))
}

impl Runs {
    fn can_probe(&self, session: &str, run: RunId, revision: u64) -> bool {
        !self.closing
            && !self.busy(session)
            && self.failed_frontiers.get(session) != Some(&(run, revision))
    }
}

fn promote_authority_due(at: UnixMillis, due: &mut Option<UnixMillis>, cause: &mut ReadyCause) {
    if due.is_some_and(|due| due <= at) {
        *due = None;
        *cause = ReadyCause::CapabilitySourceChanged;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_authority_due_is_promoted_even_when_root_changes_always_win_select() {
        let mut due = Some(UnixMillis(10));
        for tick in 9..=11 {
            let mut cause = ReadyCause::Ordinary;
            promote_authority_due(UnixMillis(tick), &mut due, &mut cause);
            assert_eq!(
                cause,
                if tick == 10 {
                    ReadyCause::CapabilitySourceChanged
                } else {
                    ReadyCause::Ordinary
                }
            );
        }
        assert!(due.is_none());
    }

    #[test]
    fn failed_probe_waits_for_new_run_evidence_without_blocking_other_runs() {
        let run = RunId::new();
        let mut runs = Runs::default();
        assert!(runs.can_probe("conversation", run, 7));
        runs.failed_frontiers
            .insert("conversation".into(), (run, 7));

        assert!(!runs.can_probe("conversation", run, 7));
        assert!(runs.can_probe("conversation", run, 8));
        assert!(runs.can_probe("conversation", RunId::new(), 7));
        assert!(runs.can_probe("another conversation", RunId::new(), 7));
    }

    #[test]
    fn transient_driver_error_matches_only_retryable_store_errors() {
        use maka_event_log::StoreError;
        assert!(transient_driver_error(&RunError::Store(
            StoreError::WriterBusy
        )));
        assert!(transient_driver_error(&RunError::Store(
            StoreError::OperationUnknown
        )));
        assert!(transient_driver_error(&RunError::Store(
            StoreError::Sqlite(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY),
                None,
            ))
        )));
        assert!(transient_driver_error(&RunError::Store(
            StoreError::Sqlite(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_LOCKED),
                None,
            ))
        )));
        assert!(!transient_driver_error(&RunError::Busy));
        assert!(!transient_driver_error(&RunError::Store(
            StoreError::EventConflict
        )));
        assert!(!transient_driver_error(&RunError::Internal("boom".into())));
    }

    #[test]
    fn fails_run_excludes_cancelled_unconfirmed_cleanup_and_authority_wait() {
        assert!(!fails_run(&RunError::Cancelled));
        assert!(!fails_run(&RunError::CleanupUnconfirmed));
        assert!(!fails_run(&RunError::Blocked(Box::new(
            BlockerKind::CurrentAuthorityUnavailable {
                stage: maka_agent_facts::durable::AuthorityStage::BackendScope,
                diagnostic: "reloading".into(),
            }
        ))));
        assert!(fails_run(&RunError::Internal("driver failed".into())));
        assert!(fails_run(&RunError::Store(
            maka_event_log::StoreError::WriterBusy
        )));
    }
}
