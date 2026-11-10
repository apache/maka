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
use maka_agent_facts::durable::*;
use maka_agent_facts::tools::ToolError;
use maka_agent_state::{
    Admission, ReadyCause,
    queue::{Consume, Placement as QueuePlacement},
};
use maka_plugin_core::operation::OperationCleanup;

impl Owner {
    pub fn activated(self: &Arc<Self>) {
        self.recover_removed_sessions();
        self.scheduler.bind(self);
        self.todo.bind(self);
        self.bot.bind(self);
        self.goals.bind(self);
        self.start_goals();
        self.start_schedules();
        self.start_bot_wake();
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
            if self.schedule_ready_at(at, cause).await.is_err() {
                tracing::error!(
                    stage = "ready_reconciliation_failed",
                    "Agent ready reconciliation failed"
                );
            }
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
                _ = deadline => {
                    if authority_due.is_some_and(|due| due.0 <= now() as i64) {
                        cause = ReadyCause::CapabilitySourceChanged;
                        authority_due = None;
                    }
                },
            }
        }
    }

    pub(super) async fn schedule_ready(self: &Arc<Self>) -> Result<(), String> {
        self.reconcile_model_readers(false).await?;
        self.schedule_ready_at(UnixMillis(now() as i64), ReadyCause::Ordinary)
            .await
    }
    pub(super) async fn schedule_ready_at(
        self: &Arc<Self>,
        at: UnixMillis,
        cause: ReadyCause,
    ) -> Result<(), String> {
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
                self.wake_run(entry.run).await?;
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
                if !matches!(ready.entry.placement, QueuePlacement::Followup) {
                    continue;
                }
                let goal = if matches!(ready.entry.request.spec.trigger, Trigger::Goal { .. }) {
                    match self.goals.gate.clone().try_lock_owned() {
                        Ok(goal) => Some(goal),
                        Err(_) => continue,
                    }
                } else {
                    None
                };
                let ordered = match self.runs.try_ordered(&session) {
                    Ok(ordered) => ordered,
                    Err(_) => continue,
                };
                let owner = self.clone();
                self.workers.spawn(async move {
                    if let Err(error) = owner.admit_queued(&session, ready.entry.request.id, ordered, goal).await {
                        tracing::error!(%session, %error, "Original queued admission requires reconciliation");
                    }
                });
            }
        }
        Ok(())
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
        let original = self
            .durable
            .queue()
            .entry(session.into(), request.clone())
            .await
            .map_err(|e| e.to_string())?
            .ok_or("agent_queue_request_unavailable")?;
        let busy = {
            let runs = ordered.state().await;
            runs.closing || runs.busy(session)
        };
        if busy {
            return Ok(());
        }
        if let Some(run) = self
            .durable
            .latest_run(session.into())
            .await
            .map_err(|e| e.to_string())?
            && self
                .durable
                .frontier(run)
                .await
                .map_err(|e| e.to_string())?
                .terminal
                .is_none()
        {
            return Ok(());
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
            .find(|entry| matches!(entry.placement, QueuePlacement::Followup))
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
        let mut admission =
            Admission::new(entry.request.spec.clone(), UnixMillis(now() as i64), vec![])
                .with_queue(Consume {
                    session: session.into(),
                    requests: vec![request],
                    expected_revision: queue.revision,
                });
        if let Some(guard) = guard {
            admission = admission.with_guard(guard);
        }
        let run = admission.run();
        let (lease, effects) = scope.accept(self.stop.child_token());
        let committed: Result<bool, String> = async {
            let selected = lease.store();
            let custody = selected
                .work_custody()
                .map_err(|error| error.to_string())?;
            let writer = self
                .store
                .data_writer_for_work(custody.as_ref(), session)
                .map_err(|error| error.to_string())?;
            let state = self
                .durable
                .with_data_writer(writer)
                .map_err(|error| error.to_string())?;
            let mut changed = state.subscribe().map_err(|error| error.to_string())?;
            changed.borrow_and_update();
            match state.admit(admission.clone()).await {
                Ok(_) => return Ok(true),
                Err(error) if matches!(error.underlying(), maka_event_log::StoreError::CommitUnknown(_) | maka_event_log::StoreError::OperationUnknown | maka_event_log::StoreError::EventConflict) => {}
                Err(error) if matches!(error.underlying(), maka_event_log::StoreError::RevisionConflict { .. }) => return Ok(false),
                Err(error) => return Err(error.to_string()),
            }
            loop {
                changed.borrow_and_update();
                match state.admission_recorded(&admission).await {
                    Ok(true) => return Ok(true),
                    Ok(false) => {
                        match state.admit(admission.clone()).await {
                            Ok(_) => return Ok(true),
                            Err(error) if matches!(error.underlying(), maka_event_log::StoreError::CommitUnknown(_) | maka_event_log::StoreError::OperationUnknown | maka_event_log::StoreError::EventConflict) => {},
                            Err(error) if matches!(error.underlying(), maka_event_log::StoreError::RevisionConflict { .. }) => return Ok(false),
                            Err(error) => return Err(error.to_string()),
                        }
                        match state.admission_recorded(&admission).await {
                            Ok(true) => return Ok(true),
                            Ok(false) => {},
                            Err(error) => tracing::warn!(%run, %error, "Original admission cannot be confirmed"),
                        }
                    }
                    Err(error) => tracing::warn!(%run, %error, "Original admission cannot be confirmed"),
                }
                if changed.changed().await.is_err() {
                    std::future::pending::<()>().await;
                }
            }
        }
        .await;
        if effects.settle().await.is_err() {
            lease.retain_unconfirmed(());
            return Err("agent_admission_cleanup_unconfirmed".into());
        }
        lease.finish();
        if !committed? {
            return Ok(());
        }
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
        if view.spec.owner != self.run_owner()
            || view.terminal.is_some()
            || !matches!(view.spec.origin, RunOrigin::Local)
        {
            return Ok(());
        }
        {
            let runs = self.runs.state().await;
            if runs.closing || runs.busy(&view.spec.session_id) {
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
        if runs.closing || runs.busy(&view.spec.session_id) {
            claim.deactivate();
            return Ok(());
        }
        let session = view.spec.session_id;
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
                let (cleanup, retry_ready) = owner.clone().drive_local(claim, target, token).await;
                drop(activity);
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
        claim: maka_agent_state::DriverClaim,
        session: String,
        cancellation: CancellationToken,
    ) -> (OperationCleanup, bool) {
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
                claim.deactivate();
                let mut runs = self.runs.state().await;
                if runs
                    .preparing
                    .get(&session)
                    .is_some_and(|preparing| preparing.run == run)
                {
                    runs.preparing.remove(&session);
                }
                drop(runs);
                return (OperationCleanup::Confirmed, false);
            }
        };
        let mut sources = root.capability_changes();
        sources.borrow_and_update();
        let turn = view.spec.turn_id.clone();
        let (result, cleanup) = self
            .run_with_capabilities(view, claim.clone(), cancellation)
            .await;
        claim.deactivate();
        if matches!(&cleanup, OperationCleanup::Unconfirmed) {
            tracing::error!(stage = "queue_cleanup_unconfirmed", cause = "cleanup_unconfirmed", consequence = "resources_retained", run_id = %run, session_id = %session, turn_id = %turn, activation = %self.revision.activation, "Agent original Root work remains unconfirmed");
        } else if let Err(error) = &result {
            let cause = match error {
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
                RunError::ModelUnavailable => "model_unavailable",
                RunError::IsolationUnavailable(_) => "isolation_unavailable",
                RunError::CompactionFailed(_) => "compaction_failed",
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
                !blockers.is_empty()
                    && blockers.iter().all(|(_, reason)| {
                        matches!(reason, BlockerKind::CurrentAuthorityUnavailable { .. })
                    })
            }
            Err(RunError::Blocked(BlockerKind::CurrentAuthorityUnavailable { .. })) => true,
            _ => false,
        };
        let retry = self
            .finish_local_probe(run, &session, authority_unavailable, &sources)
            .await;
        drop(root);
        (cleanup, retry)
    }
    pub(super) async fn finish_local_probe(
        &self,
        run: RunId,
        session: &str,
        authority_unavailable: bool,
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
        drop(runs);
        // The actual Root is retained by the probing caller until this check.
        let changed = sources
            .has_changed()
            .expect("live probing Root retains its source sender");
        !authority_unavailable || changed
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
}
