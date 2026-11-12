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

use crate::{
    Engine, RunError,
    ports::*,
    reconcile::{self, Action, Live, WorkKey},
};
use futures_util::{FutureExt, StreamExt, future::BoxFuture, stream::FuturesUnordered};
use maka_agent_facts::{
    context::{CheckpointMode, SummaryOrigin},
    durable::*,
    tool_call::ToolRejection,
};
use maka_agent_state::{
    Change, Commit, ContentBlob, DriverClaim, Head, Store,
    fold::{RunView, Tool, tool_key},
};
use maka_event_log::StoreError;
use maka_plugin_core::operation::OperationOutcome;
use std::{fmt, future::poll_fn, sync::Arc, task::Poll, time::Duration};
use tokio_util::sync::CancellationToken;

mod cells;
mod cleanup;
mod compaction;
mod external;
mod preflight;
mod publication;
mod witness;
pub use witness::{
    ExternalCleanupPublication, ExternalWitness, ModelCleanupPublication, ModelWitness,
    PublicationWitness,
};

#[derive(Clone, Debug)]
pub enum DriverExit {
    /// Only this physical activation retired. The logical Run was not stopped.
    Retired {
        run: RunId,
    },
    Terminal {
        run: RunId,
        terminal: Terminal,
    },
    /// Native schedules this level from Store; notification delivery is only a hint.
    Waiting {
        run: RunId,
        due_at: Option<UnixMillis>,
    },
    Blocked {
        run: RunId,
        blockers: Vec<(BlockerId, BlockerKind)>,
        due_at: Option<UnixMillis>,
    },
}

/// Retain the original stable fact IDs after an uncertain commit. Reconciling
/// this object is not a new admission and never repeats an external effect.
#[derive(Clone)]
pub struct PendingPublication {
    run: RunId,
    claim: Option<DriverClaim>,
    head: Head,
    changes: Vec<Change>,
    contents: Vec<ContentBlob>,
    steering: Option<maka_agent_state::queue::Consume>,
}
#[derive(Debug)]
pub enum PublicationResolution {
    Committed(Commit),
    NotCommitted,
}

impl fmt::Debug for PendingPublication {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PendingPublication")
            .field("run", &self.run)
            .field(
                "facts",
                &self
                    .changes
                    .iter()
                    .map(|change| change.id)
                    .collect::<Vec<_>>(),
            )
            .finish()
    }
}
impl PendingPublication {
    pub fn run(&self) -> RunId {
        self.run
    }
    pub fn fact_ids(&self) -> impl Iterator<Item = FactId> + '_ {
        self.changes.iter().map(|change| change.id)
    }
    pub async fn reconcile(&self, store: &Store) -> Result<PublicationResolution, StoreError> {
        let original = store
            .publication(self.run, self.fact_ids().collect(), self.claim.as_ref())
            .await?;
        if self.original_recorded(&original.facts)? {
            return Ok(PublicationResolution::Committed(Commit {
                head: original.head,
                facts: original.facts,
            }));
        }
        if self.claim.is_some() && (!original.claim_current || original.head != self.head) {
            if self.steering.is_none() && self.changes.iter().all(|change| change.fact.is_late()) {
                return store
                    .observe(self.run, self.changes.clone(), self.contents.clone())
                    .await
                    .map(PublicationResolution::Committed);
            }
            return Ok(PublicationResolution::NotCommitted);
        }
        match self.submit(store).await {
            Ok(commit) => Ok(PublicationResolution::Committed(commit)),
            Err(source)
                if self.claim.is_some()
                    && matches!(
                        source.underlying(),
                        StoreError::RevisionConflict { .. } | StoreError::InvalidTransition(_)
                    ) =>
            {
                // Claim replacement has no SQL notification. Settle this race
                // with one more original-writer barrier, never a new admission.
                let current = store
                    .publication(self.run, self.fact_ids().collect(), self.claim.as_ref())
                    .await?;
                if self.original_recorded(&current.facts)? {
                    return Ok(PublicationResolution::Committed(Commit {
                        head: current.head,
                        facts: current.facts,
                    }));
                }
                if !current.claim_current {
                    if self.steering.is_none()
                        && self.changes.iter().all(|change| change.fact.is_late())
                    {
                        return store
                            .observe(self.run, self.changes.clone(), self.contents.clone())
                            .await
                            .map(PublicationResolution::Committed);
                    }
                    return Ok(PublicationResolution::NotCommitted);
                }
                Err(source)
            }
            Err(source) => Err(source),
        }
    }
    fn original_recorded(&self, facts: &[RecordedFact]) -> Result<bool, StoreError> {
        for recorded in facts {
            if recorded.run != self.run
                || recorded.schema_version != SCHEMA_VERSION
                || !self.changes.iter().any(|change| {
                    change.id == recorded.id
                        && change.at == recorded.at
                        && change.fact == recorded.fact
                })
            {
                return Err(StoreError::EventConflict);
            }
        }
        if facts.len() == self.changes.len() {
            return Ok(true);
        }
        if !facts.is_empty() {
            return Err(StoreError::EventConflict);
        }
        Ok(false)
    }
    async fn submit(&self, store: &Store) -> Result<Commit, StoreError> {
        match &self.claim {
            Some(claim) if self.steering.is_some() => {
                store
                    .append_steering(
                        claim,
                        self.head,
                        self.changes.clone(),
                        self.contents.clone(),
                        self.steering.clone().expect("steering publication"),
                    )
                    .await
            }
            Some(claim) => {
                store
                    .append(
                        claim,
                        self.head,
                        self.changes.clone(),
                        self.contents.clone(),
                    )
                    .await
            }
            None => {
                store
                    .observe(self.run, self.changes.clone(), self.contents.clone())
                    .await
            }
        }
    }
}

struct CompactionCommit {
    checkpoint: Change,
    baseline: ContentBlob,
    candidate: Option<SummaryOrigin>,
}

#[expect(
    clippy::large_enum_variant,
    reason = "Worker handoffs carry owned results inline rather than allocating a separate payload for every completion"
)]
enum Completion {
    PublicationPrepared {
        id: ExternalPublicationId,
        control: u64,
        result: Result<PreparedExternalPublication, RunError>,
    },
    PublicationValidated {
        key: maka_agent_facts::external_publication::ExternalPublicationKey,
        control: u64,
        result: Result<maka_sandbox::workspace::PermissionBasis, RunError>,
    },
    PublicationLooked {
        key: maka_agent_facts::external_publication::ExternalPublicationKey,
        result: Result<OriginalLookup, RunError>,
    },
    PublicationRecorded {
        key: maka_agent_facts::external_publication::ExternalPublicationKey,
        result: Result<FactId, RunError>,
    },
    Cell {
        cell: maka_agent_facts::cells::CellId,
        result: Result<CellObservation, RunError>,
    },
    ExternalPrepared {
        task: ExternalTaskId,
        control: u64,
        result: Result<PreparedExternal, RunError>,
    },
    ExternalConnected {
        task: ExternalTaskId,
        result: Result<ExternalConnection, RunError>,
    },
    External {
        task: ExternalTaskId,
        index: u64,
        connection: ExternalConnection,
        notice: Option<Result<FactId, RunError>>,
    },
    Prepared {
        control: u64,
        compaction: Option<Box<CompactionCommit>>,
        result: Result<PreparedStep, RunError>,
    },
    ProactiveSummaryPrepared {
        control: u64,
        result: Result<PreparedStep, RunError>,
    },
    Decided {
        key: ToolKey,
        control: u64,
        result: Result<PreparedDecision, RunError>,
    },
    Looked {
        key: ToolKey,
        control: u64,
        result: Result<OriginalLookup, RunError>,
    },
    Validated {
        key: ToolKey,
        control: u64,
        result: Result<ToolValidation, RunError>,
    },
    Dispatched {
        key: ToolKey,
        result: Result<DispatchOutcome, RunError>,
    },
    Observed {
        key: ToolKey,
        result: Result<maka_plugin_core::operation::OperationReply, RunError>,
    },
    Assessed {
        attempt: ModelAttemptId,
        basis: Head,
        result: Result<RecoveryEvidence, RunError>,
    },
    Connected {
        attempt: ModelAttemptId,
        result: Result<ModelConnection, RunError>,
    },
    ModelCancelled {
        attempt: ModelAttemptId,
        result: Result<(), RunError>,
    },
    Model {
        attempt: ModelAttemptId,
        index: u64,
        connection: ModelConnection,
        observation: Option<Result<ModelObservation, RunError>>,
    },
}
type Work = FuturesUnordered<BoxFuture<'static, Completion>>;
fn read_model(
    work: &mut Work,
    attempt: ModelAttemptId,
    index: u64,
    mut connection: ModelConnection,
) {
    work.push(
        async move {
            let observation = connection.next().await;
            Completion::Model {
                attempt,
                index,
                connection,
                observation,
            }
        }
        .boxed(),
    );
}

impl Engine {
    async fn publish(
        &self,
        claim: Option<&DriverClaim>,
        view: &RunView,
        facts: Vec<Fact>,
        contents: Vec<ContentBlob>,
        now: UnixMillis,
    ) -> Result<bool, RunError> {
        let publication = PendingPublication {
            run: view.run,
            claim: claim.cloned(),
            head: Head::from(view),
            changes: facts
                .into_iter()
                .map(|fact| Change::new(fact, now))
                .collect(),
            contents,
            steering: None,
        };
        match publication.submit(&self.store).await {
            Ok(_) => Ok(true),
            Err(StoreError::RevisionConflict { .. }) if claim.is_some() => Ok(false),
            Err(source)
                if matches!(
                    source.underlying(),
                    StoreError::CommitUnknown(_) | StoreError::OperationUnknown
                ) =>
            {
                Err(RunError::PublicationUncertain {
                    publication: Box::new(publication),
                    source,
                })
            }
            Err(error) => Err(error.into()),
        }
    }
    async fn block(
        &self,
        claim: &DriverClaim,
        view: &RunView,
        reason: BlockerKind,
        now: UnixMillis,
    ) -> Result<(), RunError> {
        if view.blockers.values().any(|blocker| {
            (blocker.reason == reason || matches!((&blocker.reason, &reason),
                (BlockerKind::CurrentAuthorityUnavailable { stage: old, .. }, BlockerKind::CurrentAuthorityUnavailable { stage: new, .. }) if old == new))
                && blocker.decision.is_none() && blocker.resolved_by.is_none()
        }) {
            return Ok(());
        }
        self.publish(
            Some(claim),
            view,
            vec![Fact::Blocked {
                blocker: BlockerId::new(),
                reason,
            }],
            vec![],
            now,
        )
        .await?;
        Ok(())
    }
    /// Drive one original logical Run using a live Native claim. Model streaming,
    /// tool preparation and original receipt observation are polled concurrently.
    /// No parked checkpoint or physical successor Run participates in recovery.
    pub async fn drive(
        &self,
        claim: DriverClaim,
        ports: Arc<dyn DriverPorts>,
        cancellation: CancellationToken,
    ) -> Result<DriverExit, RunError> {
        let run = claim.run();
        if claim.purpose() != maka_agent_state::DriverPurpose::Business {
            return Err(RunError::InvalidInput(
                "cleanup claim has no business ports".into(),
            ));
        }
        let retirement = claim.retirement();
        let mut live = Live::default();
        let mut work = Work::new();
        let mut cancellation_sent = false;
        let mut recovery_cancelled = false;
        let mut authority_checked = false;
        let mut model_level: Option<(Option<StepId>, Option<ContentRef>, reconcile::ModelLevel)> =
            None;
        let mut summary_key = None;
        let mut model_failure_key: Option<(ModelAttemptId, Option<ContentRef>, bool)> = None;
        let mut changes = self.store.subscribe()?;
        'drive: loop {
            // Subscribe/mark before the authoritative read, so a commit between
            // reading the level and waiting cannot lose its invalidation hint.
            changes.borrow_and_update();
            if retirement.is_cancelled() {
                cancellation.cancel();
            }
            let view = self.store.frontier(run).await?;
            let now = ports.now();
            if !authority_checked && view.terminal.is_none() && !cancellation.is_cancelled() {
                if self.resolve_authority(&claim, &view, now).await? {
                    continue;
                }
                authority_checked = true;
            }
            if live.stop_request != view.stop_request {
                live.stop_request = view.stop_request;
                live.observed.clear();
                live.looked_up.clear();
                live.cells_observed.clear();
                live.publication_looked_up.clear();
                live.publication_observed.clear();
            }
            if let Some(terminal) = &view.terminal {
                return Ok(DriverExit::Terminal {
                    run,
                    terminal: terminal.clone(),
                });
            }
            if let Some(publication) = view
                .external
                .as_ref()
                .and_then(|task| task.publication.as_ref())
            {
                live.publication_prepared.retain(|id| *id == publication.id);
                live.publication_looked_up.retain(|key| {
                    key.publication == publication.id && key.index >= publication.settled
                });
                live.publication_observed.retain(|key| {
                    key.publication == publication.id && key.index >= publication.settled
                });
            } else {
                live.publication_prepared.clear();
                live.publication_looked_up.clear();
                live.publication_observed.clear();
            }
            live.looked_up
                .retain(|key| view.tools.contains_key(&tool_key(key)));
            live.observed
                .retain(|key| view.tools.contains_key(&tool_key(key)));
            live.cells_observed
                .retain(|cell| view.cells.contains_key(cell));
            live.models_observed.retain(|attempt| {
                view.attempts
                    .get(attempt)
                    .is_some_and(|value| value.closed.is_none())
            });
            // Cancellation belongs to the physical activation. Only an explicit
            // Native control transaction may place the durable Stop fence.
            if recovery_cancelled && view.recovery_failure().is_none() {
                // Resume with new live ports if late evidence settled the failure
                // after this activation cancelled its workers.
                cancellation.cancel();
            }
            let retiring = cancellation.is_cancelled() && view.terminal.is_none();
            let complete_at_budget = !retiring && self.complete_at_budget(&view, now).await?;
            let fenced = view.stopped
                || view.cancelled_by_risk
                || view.spec.budget.deadline.is_some_and(|at| now >= at)
                || reconcile::budget_exhausted(&view);
            if ((fenced && !complete_at_budget) || retiring) && !cancellation_sent {
                live.cells_observed.clear();
                ports.cancel_live(run);
                cancellation_sent = true;
            }
            if !retiring
                && !view.cancelled_by_risk
                && self.resolve_recovered_cells(&claim, &view, now).await?
            {
                continue;
            }
            if retiring && work.is_empty() {
                return Ok(DriverExit::Retired { run });
            }
            for (wait, pending) in &view.waits {
                if !retiring
                    && !fenced
                    && pending.satisfied.is_none()
                    && pending.cancelled.is_none()
                    && let WaitReason::Child { run: child } = &pending.reason
                {
                    let child = self.store.frontier(*child).await?;
                    if let Some(terminal) = child.terminal {
                        let evidence = ContentBlob::json(
                            &serde_json::json!({"child":child.run,"revision":child.revision,"terminal":terminal}),
                        )?;
                        self.publish(
                            Some(&claim),
                            &view,
                            vec![Fact::WaitSatisfied {
                                wait: *wait,
                                evidence: evidence.reference().clone(),
                            }],
                            vec![evidence],
                            now,
                        )
                        .await?;
                        continue 'drive;
                    }
                }
            }
            if !fenced
                && !retiring
                && matches!(view.spec.backend, BackendSpec::Model { .. })
                && view.replans.is_empty()
                && !view
                    .blockers
                    .values()
                    .any(|b| b.decision.is_none() && b.resolved_by.is_none())
            {
                let current_summary = view.proactive_summary_attempt().map(|(id, attempt)| {
                    (
                        id,
                        attempt.closed.is_some(),
                        attempt.interrupted.is_some(),
                        attempt.cleanup == maka_plugin_core::operation::OperationCleanup::Confirmed,
                    )
                });
                let overflow = view
                    .current_attempt
                    .and_then(|id| view.attempts.get(&id))
                    .is_some_and(|attempt| {
                        matches!(
                            attempt.recovery,
                            Some(AttemptRecovery::ContextOverflow {
                                observed_output: false
                            })
                        )
                    });
                let key = (current_summary, overflow, live.rejected_summaries.len());
                let reload = summary_key != Some(key)
                    || model_level.as_ref().is_none_or(|(step, baseline, _)| {
                        *step != view.current_step || *baseline != view.baseline
                    });
                if reload {
                    let level = match self
                        .model_level(&view, &live.rejected_summaries, overflow)
                        .await
                    {
                        Ok(level) => level,
                        Err(error) => {
                            self.port_failure(&claim, &view, error, now).await?;
                            continue;
                        }
                    };
                    model_level = Some((view.current_step, view.baseline.clone(), level));
                    summary_key = Some(key);
                }
                // A canonical closure is immutable for its attempt; presence identifies
                // its one protocol body without cloning or hashing that body each loop.
                let failure_key = view.current_attempt.and_then(|id| {
                    view.attempts.get(&id).map(|attempt| {
                        (id, attempt.source_failure.clone(), attempt.closed.is_some())
                    })
                });
                if reload || model_failure_key != failure_key {
                    let level = &mut model_level.as_mut().expect("model material loaded").2;
                    if let Err(error) = self.refresh_model_failure(&view, level).await {
                        self.port_failure(&claim, &view, error, now).await?;
                        continue;
                    }
                    model_failure_key = failure_key;
                }
            }
            let mut action = if retiring {
                Action::Idle
            } else if view.recovery_failure().is_some() && !view.cancelled_by_risk {
                if view.waiting_for_authority() {
                    Action::Idle
                } else if work.is_empty()
                    && let Some(observation) = reconcile::recovery_action(&view, &live)
                {
                    observation
                } else {
                    if !cancellation_sent {
                        ports.cancel_live(run);
                        cancellation_sent = true;
                        recovery_cancelled = true;
                    }
                    if work.is_empty() || live.only_cleanup(&view) {
                        Action::Terminate(Terminal::Failed)
                    } else {
                        Action::Idle
                    }
                }
            } else {
                reconcile::next(
                    &view,
                    &live,
                    now,
                    model_level.as_ref().map(|(_, _, level)| level),
                    complete_at_budget,
                )
            };
            if matches!(action, Action::Terminate(Terminal::Completed))
                && !reconcile::budget_exhausted(&view)
                && !model_level.as_ref().is_some_and(|(_, _, level)| {
                    matches!(
                        level.input,
                        maka_agent_facts::input::RunInput::ContextCompact { .. }
                    )
                })
            {
                let queue = self
                    .store
                    .queue()
                    .steering(view.spec.session_id.clone(), run)
                    .await?;
                if !queue.entries.is_empty()
                    && let Some(attempt) = view.current_attempt
                {
                    action = Action::Prepare(Preparation::Steering { attempt });
                }
            }
            if !retiring
                && !fenced
                && !view.finish_requested()
                && let Some((attempt, summary)) = view.proactive_summary_attempt()
            {
                let active = live.work.contains(&WorkKey::Model(attempt));
                let open = summary.closed.is_none() && summary.interrupted.is_none();
                let terminating = matches!(action, Action::Terminate(_));
                if open && !active && (summary.admission.is_some() || terminating) {
                    action = Action::Interrupt(attempt, "Background summary did not finish".into());
                } else if terminating && open && active && !live.models_cancelled.contains(&attempt)
                {
                    action = Action::CancelModel(attempt);
                } else if matches!(action, Action::Terminate(Terminal::Completed))
                    && summary.admission.is_some()
                    && summary.cleanup != maka_plugin_core::operation::OperationCleanup::Confirmed
                {
                    action = reconcile::wait(&view, WaitReason::Model { attempt }, None, now);
                } else if open
                    && summary.admission.is_none()
                    && !matches!(action, Action::Terminate(_) | Action::Block(_))
                    && view.check_effect_admission().is_ok()
                {
                    action = Action::Start(attempt);
                }
            }
            let idle = matches!(action, Action::Idle);
            match action {
                action @ (Action::PrepareExternal(_)
                | Action::StartExternal(_)
                | Action::ObserveExternal(_, _)) => {
                    self.launch_external(&claim, &view, &ports, &mut live, &mut work, action)
                        .await?;
                }
                Action::ObserveCell(cell) => {
                    self.launch_cell(&claim, &view, &ports, &mut live, &mut work, cell)
                        .await?;
                }
                action @ (Action::PreparePublication(_)
                | Action::ValidatePublication(_)
                | Action::LookupPublication(_)
                | Action::ObservePublication(_, _)
                | Action::AbandonPublication(_)) => {
                    self.launch_publication(
                        &claim,
                        &view,
                        ports.clone(),
                        &mut live,
                        &mut work,
                        action,
                        now,
                    )
                    .await?;
                }
                action @ (Action::Compact(_) | Action::AdoptCandidate(_)) => {
                    let (origin, candidate) = match action {
                        Action::AdoptCandidate(origin) => (origin, Some(origin)),
                        Action::Compact(attempt) => (SummaryOrigin { run, attempt }, None),
                        _ => unreachable!(),
                    };
                    let material = match self.compaction_checkpoint(&view, origin).await {
                        Ok(Some(material)) => material,
                        Ok(None) => continue,
                        Err(RunError::CompactionFailed(diagnostic)) => {
                            self.publish(
                                Some(&claim),
                                &view,
                                termination_facts(&view, Terminal::Failed, Some(diagnostic)),
                                vec![],
                                now,
                            )
                            .await?;
                            continue;
                        }
                        Err(error) => {
                            self.port_failure(&claim, &view, error, now).await?;
                            continue;
                        }
                    };
                    let baseline = ContentBlob::json(&material)?;
                    let fact = Fact::ContextCompacted {
                        baseline: baseline.reference().clone(),
                    };
                    if material.checkpoint.mode == CheckpointMode::Standalone {
                        self.publish(Some(&claim), &view, vec![fact], vec![baseline], now)
                            .await?;
                    } else {
                        let checkpoint = Change::new(fact, now);
                        let preparation =
                            Preparation::AdoptCompaction(Box::new(CompactionAdoption {
                                origin,
                                checkpoint: checkpoint.id,
                                baseline: baseline.reference().clone(),
                                material,
                            }));
                        let compaction = Box::new(CompactionCommit {
                            checkpoint,
                            baseline,
                            candidate,
                        });
                        live.work.insert(WorkKey::Prepare);
                        let ports = ports.clone();
                        let snapshot = view.clone();
                        work.push(
                            async move {
                                Completion::Prepared {
                                    control: snapshot.control_version,
                                    compaction: Some(compaction),
                                    result: ports.prepare_step(&snapshot, preparation).await,
                                }
                            }
                            .boxed(),
                        );
                    }
                }
                Action::AcceptCellFinal(cell) => {
                    self.accept_cell_final(&claim, &view, cell, ports.now())
                        .await?;
                }
                Action::ReportCellInterruption(cell) => {
                    self.report_cell_interruption(&claim, &view, cell, ports.now())
                        .await?;
                }
                Action::Prepare(preparation) => {
                    live.work.insert(WorkKey::Prepare);
                    let ports = ports.clone();
                    let snapshot = view.clone();
                    work.push(
                        async move {
                            Completion::Prepared {
                                control: snapshot.control_version,
                                compaction: None,
                                result: ports.prepare_step(&snapshot, preparation).await,
                            }
                        }
                        .boxed(),
                    );
                }
                Action::PrepareProactiveSummary => {
                    live.work.insert(WorkKey::PrepareProactiveSummary);
                    let ports = ports.clone();
                    let snapshot = view.clone();
                    work.push(
                        async move {
                            Completion::ProactiveSummaryPrepared {
                                control: snapshot.control_version,
                                result: ports.prepare_step(&snapshot, Preparation::Summary).await,
                            }
                        }
                        .boxed(),
                    );
                }
                Action::Attempt(step) => {
                    self.publish(
                        Some(&claim),
                        &view,
                        vec![Fact::ModelAttemptPrepared {
                            attempt: ModelAttemptId::new(),
                            step,
                        }],
                        vec![],
                        now,
                    )
                    .await?;
                }
                Action::Assess(attempt) => {
                    let request = self
                        .store
                        .request(run, view.attempts[&attempt].step)
                        .await?;
                    live.work.insert(WorkKey::Assess(attempt));
                    let ports = ports.clone();
                    let snapshot = view.clone();
                    work.push(
                        async move {
                            Completion::Assessed {
                                attempt,
                                basis: Head::from(&snapshot),
                                result: ports.assess_recovery(&snapshot, attempt, request).await,
                            }
                        }
                        .boxed(),
                    );
                }
                Action::Start(attempt) => {
                    let request = self
                        .store
                        .request(run, view.attempts[&attempt].step)
                        .await?;
                    let bytes = self.store.content(run, request.request.clone()).await?;
                    let upstream = ports.model_admission(run, attempt, &request)?;
                    // This commit is the model admission's Stop/control linearization point.
                    if self
                        .publish(
                            Some(&claim),
                            &view,
                            vec![Fact::ModelAttemptAdmitted { attempt, upstream }],
                            vec![],
                            now,
                        )
                        .await?
                    {
                        live.work.insert(WorkKey::Model(attempt));
                        let ports = ports.clone();
                        let witness = ModelWitness::new(self.store.clone(), claim.clone(), attempt);
                        work.push(
                            async move {
                                Completion::Connected {
                                    attempt,
                                    result: ports
                                        .start_model(run, attempt, request, bytes, witness)
                                        .await,
                                }
                            }
                            .boxed(),
                        );
                    }
                }
                Action::ObserveModel(attempt, descriptor) => {
                    live.work.insert(WorkKey::Model(attempt));
                    live.models_observed.insert(attempt);
                    let ports = ports.clone();
                    let after = view.attempts[&attempt].observed;
                    let witness = ModelWitness::new(self.store.clone(), claim.clone(), attempt);
                    work.push(
                        async move {
                            Completion::Connected {
                                attempt,
                                result: ports
                                    .observe_model(run, attempt, descriptor, after, witness)
                                    .await,
                            }
                        }
                        .boxed(),
                    );
                }
                Action::Interrupt(attempt, diagnostic) => {
                    self.publish(
                        Some(&claim),
                        &view,
                        vec![Fact::ModelInterrupted {
                            attempt,
                            diagnostic,
                        }],
                        vec![],
                        now,
                    )
                    .await?;
                }
                Action::CancelModel(attempt) => {
                    live.models_cancelled.insert(attempt);
                    live.work.insert(WorkKey::CancelModel(attempt));
                    let ports = ports.clone();
                    work.push(
                        async move {
                            Completion::ModelCancelled {
                                attempt,
                                result: ports.cancel_model(run, attempt).await,
                            }
                        }
                        .boxed(),
                    );
                }
                Action::Decide(key) => {
                    live.work.insert(WorkKey::Tool(key.clone()));
                    let ports = ports.clone();
                    let snapshot = view.clone();
                    work.push(
                        async move {
                            let result = ports
                                .decide_tool(&snapshot, &snapshot.tools[&tool_key(&key)])
                                .await;
                            Completion::Decided {
                                key,
                                control: snapshot.control_version,
                                result,
                            }
                        }
                        .boxed(),
                    );
                }
                Action::Lookup(key) => {
                    live.looked_up.insert(key.clone());
                    live.work.insert(WorkKey::Tool(key.clone()));
                    let ports = ports.clone();
                    let control = view.control_version;
                    work.push(
                        async move {
                            let result = ports.lookup_original(run, key.clone()).await;
                            Completion::Looked {
                                key,
                                control,
                                result,
                            }
                        }
                        .boxed(),
                    );
                }
                Action::Observe(key) => {
                    live.work.insert(WorkKey::Tool(key.clone()));
                    live.observed.insert(key.clone());
                    let ports = ports.clone();
                    let reference = view.tools[&tool_key(&key)]
                        .original
                        .clone()
                        .expect("observe has original");
                    work.push(
                        async move {
                            Completion::Observed {
                                key,
                                result: ports.observe_operation(reference).await,
                            }
                        }
                        .boxed(),
                    );
                }
                Action::Reject(tool, rejection) => {
                    let display = view.tools[&tool_key(&tool)]
                        .decision
                        .as_ref()
                        .map(|decision| decision.display().clone())
                        .unwrap_or_default();
                    self.publish(
                        Some(&claim),
                        &view,
                        vec![Fact::ToolDecided {
                            tool,
                            decision: ToolDecision::Rejected { rejection, display },
                        }],
                        vec![],
                        now,
                    )
                    .await?;
                }
                Action::Accept(key, outcome) => {
                    let (facts, result) = self.tool_acceptance(&view, key, outcome).await?;
                    self.publish(Some(&claim), &view, facts, vec![result], now)
                        .await?;
                }
                Action::SelectTransport(attempt, phase) => {
                    if let Err(error) = ports
                        .validate_transport_selection(&view, attempt, phase)
                        .await
                    {
                        self.port_failure(&claim, &view, error, now).await?;
                        continue;
                    }
                    self.publish(
                        Some(&claim),
                        &view,
                        vec![Fact::ModelTransportSelected { attempt, phase }],
                        vec![],
                        now,
                    )
                    .await?;
                }
                Action::ChargeRetry(attempt, phase) => {
                    // Frozen retries alone consume the durable retry budget; reattach never does.
                    let delay = 250_i64.saturating_mul(1_i64 << view.retries_for(phase).min(8));
                    let provider_due = match &view.attempts[&attempt].recovery {
                        Some(AttemptRecovery::FrozenRetrySafe { not_before }) => *not_before,
                        _ => None,
                    };
                    let due_at =
                        UnixMillis(now.0.saturating_add(delay)).max(provider_due.unwrap_or(now));
                    self.publish(
                        Some(&claim),
                        &view,
                        vec![Fact::RetryCharged {
                            attempt,
                            phase,
                            due_at,
                            diagnostic:
                                "adapter proved frozen retry safe with no semantic progress".into(),
                        }],
                        vec![],
                        now,
                    )
                    .await?;
                }
                Action::Block(reason) => {
                    if work.is_empty()
                        && let Some(request) = view.stop_request
                        && view.stop_assessed != Some(request)
                    {
                        let mut facts = vec![];
                        if !view.blockers.values().any(|b| {
                            b.reason == reason && b.decision.is_none() && b.resolved_by.is_none()
                        }) {
                            facts.push(Fact::Blocked {
                                blocker: BlockerId::new(),
                                reason,
                            });
                        }
                        facts.push(Fact::StopAssessed { request });
                        self.publish(Some(&claim), &view, facts, vec![], now)
                            .await?;
                    } else {
                        self.block(&claim, &view, reason, now).await?;
                    }
                }
                Action::Wait(reason, due_at) => {
                    self.publish(
                        Some(&claim),
                        &view,
                        vec![Fact::WaitRegistered {
                            wait: WaitId::new(),
                            reason,
                            due_at,
                        }],
                        vec![],
                        now,
                    )
                    .await?;
                }
                Action::CancelWait(wait) => {
                    self.publish(
                        Some(&claim),
                        &view,
                        vec![Fact::WaitCancelled {
                            wait,
                            diagnostic: "Run admission fence closed".into(),
                        }],
                        vec![],
                        now,
                    )
                    .await?;
                }
                Action::Satisfy(wait) => {
                    let evidence = ContentBlob::json(
                        &serde_json::json!({"run":run,"revision":view.revision,"at":now}),
                    )?;
                    if self
                        .publish(
                            Some(&claim),
                            &view,
                            vec![Fact::WaitSatisfied {
                                wait,
                                evidence: evidence.reference().clone(),
                            }],
                            vec![evidence],
                            now,
                        )
                        .await?
                    {
                        match &view.waits[&wait].reason {
                            WaitReason::Operation { tool } => {
                                live.observed.remove(tool);
                            }
                            WaitReason::External { .. } => {
                                live.external_observed = false;
                            }
                            WaitReason::Model { attempt } => {
                                live.models_observed.remove(attempt);
                            }
                            _ => {}
                        }
                    }
                }
                Action::Terminate(terminal) => {
                    let diagnostic = view
                        .external
                        .as_ref()
                        .and_then(|task| task.closed.as_ref())
                        .filter(|closed| {
                            terminal == Terminal::Failed && closed.outcome == Terminal::Failed
                        })
                        .and_then(|closed| closed.diagnostic.clone());
                    let checkpoint =
                        if matches!(terminal, Terminal::Completed | Terminal::Cancelled) {
                            self.checkpoint_for_next_run(&view).await?
                        } else {
                            None
                        };
                    let mut facts = termination_facts(&view, terminal, diagnostic);
                    if let Some(content) = &checkpoint {
                        facts.insert(
                            0,
                            Fact::ContextCompacted {
                                baseline: content.reference().clone(),
                            },
                        );
                    }
                    self.publish(
                        Some(&claim),
                        &view,
                        facts,
                        checkpoint.into_iter().collect(),
                        now,
                    )
                    .await?;
                }
                Action::Idle => {
                    let observing_cell =
                        live.work.iter().any(|key| matches!(key, WorkKey::Cell(_)));
                    if !observing_cell && (work.is_empty() || live.only_cleanup(&view)) {
                        if retiring {
                            return Ok(DriverExit::Retired { run });
                        }
                        if let Some(request) = view.stop_request
                            && view.stop_assessed != Some(request)
                        {
                            self.publish(
                                Some(&claim),
                                &view,
                                vec![Fact::StopAssessed { request }],
                                vec![],
                                now,
                            )
                            .await?;
                            continue;
                        }
                        return Ok(exit(&view));
                    }
                }
            }
            // Poll once with the driver's waker so children can wake it even
            // while it is awaiting the next frontier read.
            let ready = poll_fn(|cx| {
                Poll::Ready(match work.poll_next_unpin(cx) {
                    Poll::Ready(completion) => completion,
                    Poll::Pending => None,
                })
            })
            .await;
            let completion = if let Some(completion) = ready {
                Some(completion)
            } else if idle && !work.is_empty() {
                let remaining = view
                    .spec
                    .budget
                    .deadline
                    .filter(|_| !fenced)
                    .map(|deadline| {
                        Duration::from_millis(deadline.0.saturating_sub(now.0).max(0) as u64)
                    });
                tokio::select! {
                    result = work.next() => result,
                    change = changes.changed() => {
                        change.map_err(|_| StoreError::ConnectionClosed)?;
                        None
                    },
                    _ = cancellation.cancelled(), if !retiring => None,
                    _ = retirement.cancelled(), if !retiring => { cancellation.cancel(); None },
                    _ = async { match remaining { Some(delay) => tokio::time::sleep(delay).await, None => std::future::pending().await } } => None,
                }
            } else {
                None
            };
            if let Some(completion) = completion {
                self.complete(
                    &claim,
                    &ports,
                    &mut live,
                    &mut work,
                    completion,
                    cancellation.is_cancelled(),
                )
                .await?;
            }
        }
    }

    async fn complete(
        &self,
        claim: &DriverClaim,
        ports: &Arc<dyn DriverPorts>,
        live: &mut Live,
        work: &mut Work,
        completion: Completion,
        cancelled: bool,
    ) -> Result<(), RunError> {
        let run = claim.run();
        let view = self.store.frontier(run).await?;
        let now = ports.now();
        let retiring = cancelled || view.terminal.is_some();
        match completion {
            completion @ (Completion::PublicationPrepared { .. }
            | Completion::PublicationValidated { .. }
            | Completion::PublicationLooked { .. }
            | Completion::PublicationRecorded { .. }) => {
                self.complete_publication(
                    claim, &view, ports, live, work, completion, now, retiring,
                )
                .await?;
            }
            Completion::Cell { cell, result } => {
                self.complete_cell(claim, &view, live, cell, result, now, retiring)
                    .await?;
            }
            completion @ (Completion::ExternalPrepared { .. }
            | Completion::ExternalConnected { .. }
            | Completion::External { .. }) => {
                self.complete_external(claim, ports, live, work, completion, retiring)
                    .await?;
            }
            Completion::Prepared {
                control,
                compaction,
                result,
            } => {
                live.work.remove(&WorkKey::Prepare);
                if retiring
                    || control != view.control_version
                    || view.stopped
                    || view.terminal.is_some()
                    || view.recovery_failure().is_some()
                    || view.finish_requested()
                {
                    return Ok(());
                }
                let prepared = match result {
                    Ok(value) => value,
                    Err(RunError::CompactionMismatch)
                        if compaction
                            .as_ref()
                            .is_some_and(|commit| commit.candidate.is_some()) =>
                    {
                        live.rejected_summaries
                            .extend(compaction.and_then(|commit| commit.candidate));
                        return Ok(());
                    }
                    Err(error @ RunError::CompactionMismatch) => {
                        self.publish(
                            Some(claim),
                            &view,
                            termination_facts(&view, Terminal::Failed, Some(error.to_string())),
                            vec![],
                            now,
                        )
                        .await?;
                        return Ok(());
                    }
                    Err(RunError::CompactionFailed(diagnostic)) => {
                        self.publish(
                            Some(claim),
                            &view,
                            termination_facts(&view, Terminal::Failed, Some(diagnostic)),
                            vec![],
                            now,
                        )
                        .await?;
                        return Ok(());
                    }
                    Err(error) => return self.port_failure(claim, &view, error, now).await,
                };
                let request = ContentBlob::json(&prepared.request)?;
                let mut contents = prepared.contents;
                contents.push(request.clone());
                let mut publication = PendingPublication {
                    run,
                    claim: Some(claim.clone()),
                    head: Head::from(&view),
                    changes: vec![Change::new(
                        Fact::StepPrepared {
                            step: prepared.request.step,
                            request: request.reference().clone(),
                            adjudications: prepared
                                .request
                                .adjudications
                                .iter()
                                .map(|basis| basis.blocker)
                                .collect(),
                        },
                        now,
                    )],
                    contents,
                    steering: prepared.steering,
                };
                if let Some(compaction) = compaction {
                    let CompactionCommit {
                        mut checkpoint,
                        baseline,
                        ..
                    } = *compaction;
                    checkpoint.at = now;
                    publication.changes.insert(0, checkpoint);
                    publication.contents.push(baseline);
                }
                for notice in prepared.notifications {
                    publication.changes.push(Change::new(
                        Fact::Cell {
                            event: maka_agent_facts::cells::CellEvent::NotificationConsumed {
                                cell: notice.cell,
                                notification: notice.id,
                                step: prepared.request.step,
                            },
                        },
                        now,
                    ));
                }
                match publication.submit(&self.store).await {
                    Ok(_) | Err(StoreError::RevisionConflict { .. }) => {}
                    Err(source)
                        if matches!(
                            source.underlying(),
                            StoreError::CommitUnknown(_) | StoreError::OperationUnknown
                        ) =>
                    {
                        return Err(RunError::PublicationUncertain {
                            publication: Box::new(publication),
                            source,
                        });
                    }
                    Err(error) => return Err(error.into()),
                }
            }
            Completion::ProactiveSummaryPrepared { control, result } => {
                live.work.remove(&WorkKey::PrepareProactiveSummary);
                if retiring
                    || control != view.control_version
                    || view.recovery_failure().is_some()
                    || reconcile::budget_exhausted(&view)
                    || view.check_effect_admission().is_err()
                {
                    return Ok(());
                }
                let prepared = match result {
                    Ok(prepared) => prepared,
                    Err(error) => {
                        tracing::warn!(%run, cause = %error, "Background summary preparation failed");
                        live.proactive_preparation_failed = true;
                        return Ok(());
                    }
                };
                let request = ContentBlob::json(&prepared.request)?;
                let mut contents = prepared.contents;
                contents.push(request.clone());
                self.publish(
                    Some(claim),
                    &view,
                    vec![Fact::ProactiveSummaryPrepared {
                        step: prepared.request.step,
                        request: request.reference().clone(),
                        attempt: ModelAttemptId::new(),
                    }],
                    contents,
                    now,
                )
                .await?;
            }
            Completion::Decided {
                key,
                control,
                result,
            } => {
                live.work.remove(&WorkKey::Tool(key.clone()));
                if retiring {
                    return Ok(());
                }
                if control != view.control_version
                    || view.stopped
                    || view.terminal.is_some()
                    || view.recovery_failure().is_some()
                    || view.finish_requested()
                    || view.model_steered(key.attempt)
                {
                    return Ok(());
                }
                let decision = match result {
                    Ok(value) => value,
                    Err(error) => return self.port_failure(claim, &view, error, now).await,
                };
                self.publish(
                    Some(claim),
                    &view,
                    vec![Fact::ToolDecided {
                        tool: key,
                        decision: decision.decision,
                    }],
                    decision.contents,
                    now,
                )
                .await?;
            }
            Completion::Looked {
                key,
                control,
                result,
            } => {
                live.work.remove(&WorkKey::Tool(key.clone()));
                if view.model_steered(key.attempt) && !view.tools[&tool_key(&key)].admitted {
                    return Ok(());
                }
                let original = match result {
                    Ok(value) => value,
                    Err(error) => {
                        if retiring {
                            tracing::warn!(cause=%error,"retired original lookup failed");
                            return Ok(());
                        }
                        return self.port_failure(claim, &view, error, now).await;
                    }
                };
                match original {
                    OriginalLookup::Found(reference) => {
                        self.publish(
                            None,
                            &view,
                            vec![Fact::ToolOriginalBound {
                                tool: key,
                                reference,
                            }],
                            vec![],
                            now,
                        )
                        .await?;
                    }
                    OriginalLookup::Blocked(reason) => {
                        if !retiring {
                            self.block(claim, &view, reason, now).await?;
                        }
                    }
                    OriginalLookup::Absent if retiring => {}
                    OriginalLookup::Absent => {
                        let tool = &view.tools[&tool_key(&key)];
                        if tool.admitted {
                            // An absent intent cannot fence an already granted old driver.
                            self.block(
                                claim,
                                &view,
                                BlockerKind::OriginalAdmissionUnknown { tool: key },
                                now,
                            )
                            .await?;
                        } else if control == view.control_version
                            && !view.stopped
                            && view.terminal.is_none()
                        {
                            live.work.insert(WorkKey::Tool(key.clone()));
                            let snapshot = view.clone();
                            let ports = ports.clone();
                            work.push(
                                async move {
                                    let result = ports
                                        .validate_tool(&snapshot, &snapshot.tools[&tool_key(&key)])
                                        .await;
                                    Completion::Validated {
                                        key,
                                        control,
                                        result,
                                    }
                                }
                                .boxed(),
                            );
                        }
                    }
                }
            }
            Completion::Validated {
                key,
                control,
                result,
            } => {
                live.work.remove(&WorkKey::Tool(key.clone()));
                if retiring {
                    return Ok(());
                }
                if control != view.control_version
                    || view.stopped
                    || view.terminal.is_some()
                    || view.recovery_failure().is_some()
                    || view.finish_requested()
                    || view.model_steered(key.attempt)
                {
                    return Ok(());
                }
                let validation = match result {
                    Ok(value) => value,
                    Err(error) => return self.port_failure(claim, &view, error, now).await,
                };
                match validation {
                    ToolValidation::Allowed => {
                        match reconcile::tool_incomplete(&view, &key) {
                            Ok(true) => return Ok(()),
                            Ok(false) => {}
                            Err(reason) => return self.block(claim, &view, *reason, now).await,
                        }
                        let mut tool = view.tools[&tool_key(&key)].clone();
                        if let Some(ToolDecision::Approved {
                            approval: Some(id),
                            display,
                            ..
                        }) = &tool.decision
                            && view.approvals.get(id).is_none_or(|grant| {
                                grant.expires_at.is_some_and(|expiry| ports.now() >= expiry)
                            })
                        {
                            self.publish(
                                Some(claim),
                                &view,
                                vec![Fact::ToolDecided {
                                    tool: key,
                                    decision: ToolDecision::Rejected {
                                        display: display.clone(),
                                        rejection: ToolRejection::PolicyDenied {
                                            message: "Approval expired before final admission"
                                                .into(),
                                        },
                                    },
                                }],
                                vec![],
                                ports.now(),
                            )
                            .await?;
                            return Ok(());
                        }
                        let mut facts = Vec::new();
                        if let Some(ToolDecision::Approved {
                            approval: Some(approval),
                            ..
                        }) = &tool.decision
                            && !view.approvals[approval].consumed
                        {
                            facts.push(Fact::ApprovalConsumed {
                                approval: *approval,
                                tool: key.clone(),
                            });
                        }
                        facts.push(Fact::ToolAdmitted { tool: key.clone() });
                        // Atomic consumption and logical admission precede the external effect.
                        let admitted = match self
                            .publish(Some(claim), &view, facts, vec![], ports.now())
                            .await
                        {
                            Err(error @ RunError::Store(StoreError::InvalidTransition(_))) => {
                                let current = self.store.frontier(run).await?;
                                let expired = current
                                    .tools
                                    .get(&tool_key(&key))
                                    .filter(|tool| !tool.admitted && tool.accepted.is_none())
                                    .and_then(|tool| match &tool.decision {
                                        Some(ToolDecision::Approved {
                                            approval: Some(id), ..
                                        }) => current.approvals.get(id),
                                        _ => None,
                                    })
                                    .is_some_and(|grant| {
                                        !grant.consumed
                                            && grant
                                                .expires_at
                                                .is_some_and(|expiry| ports.now() >= expiry)
                                    });
                                if !expired {
                                    return Err(error);
                                }
                                self.publish(
                                    Some(claim),
                                    &current,
                                    vec![Fact::ToolDecided {
                                        tool: key.clone(),
                                        decision: ToolDecision::Rejected {
                                            display: current.tools[&tool_key(&key)].decision.as_ref()
                                                .expect("expired tool has its original approved decision").display().clone(),
                                            rejection: ToolRejection::PolicyDenied {
                                                message: "Approval expired at final SQL admission"
                                                    .into(),
                                            },
                                        },
                                    }],
                                    vec![],
                                    ports.now(),
                                )
                                .await?;
                                false
                            }
                            result => result?,
                        };
                        if admitted {
                            live.looked_up.remove(&key);
                            tool.admitted = true;
                            live.work.insert(WorkKey::Tool(key.clone()));
                            let ports = ports.clone();
                            work.push(
                                async move {
                                    Completion::Dispatched {
                                        key,
                                        result: ports.dispatch_tool(run, tool).await,
                                    }
                                }
                                .boxed(),
                            );
                        }
                    }
                    ToolValidation::Denied { rejection } => {
                        let display = view.tools[&tool_key(&key)]
                            .decision
                            .as_ref()
                            .expect("validation has its original approved decision")
                            .display()
                            .clone();
                        self.publish(
                            Some(claim),
                            &view,
                            vec![Fact::ToolDecided {
                                tool: key,
                                decision: ToolDecision::Rejected { rejection, display },
                            }],
                            vec![],
                            now,
                        )
                        .await?;
                    }
                    ToolValidation::Blocked(reason) => {
                        self.block(claim, &view, reason, now).await?
                    }
                }
            }
            Completion::Dispatched { key, result } => {
                live.work.remove(&WorkKey::Tool(key.clone()));
                match result {
                    Ok(DispatchOutcome::Original(reply)) => {
                        let (reply, content) =
                            maka_agent_state::operation::prepare_reply(reply).await?;
                        self.publish(
                            None,
                            &view,
                            vec![
                                Fact::ToolOriginalBound {
                                    tool: key.clone(),
                                    reference: reply.reference.clone(),
                                },
                                Fact::OperationObserved {
                                    tool: key.clone(),
                                    reply,
                                },
                            ],
                            content.into_iter().collect(),
                            now,
                        )
                        .await?;
                        live.observed.insert(key);
                    }
                    Ok(DispatchOutcome::Recorded { fact }) => {
                        let original = self.store.fact(run, fact).await?.ok_or_else(|| {
                            RunError::Internal(
                                "tool worker acknowledged an absent original fact".into(),
                            )
                        })?;
                        let matches = match &original.fact {
                            Fact::LocalToolReturned { tool, .. }
                            | Fact::HostToolResultRecorded { tool, .. }
                            | Fact::ToolPreventedBeforeHostAdmission { tool, .. }
                            | Fact::OperationObserved { tool, .. } => tool == &key,
                            _ => false,
                        };
                        if !matches {
                            return Err(RunError::Internal(
                                "tool worker acknowledged evidence for another original operation"
                                    .into(),
                            ));
                        }
                    }
                    Ok(DispatchOutcome::Prevented { rejection }) => {
                        self.publish(
                            None,
                            &view,
                            vec![Fact::ToolPreventedBeforeHostAdmission {
                                tool: key,
                                rejection,
                            }],
                            vec![],
                            now,
                        )
                        .await?;
                    }
                    Err(
                        error @ RunError::Tool(
                            maka_agent_facts::tools::ToolError::CleanupUnconfirmed(_),
                        ),
                    ) => {
                        let recorded = if retiring {
                            Ok(())
                        } else {
                            self.block(
                                claim,
                                &view,
                                BlockerKind::ToolCleanupUnconfirmed {
                                    tool: key,
                                    diagnostic: error.to_string(),
                                },
                                now,
                            )
                            .await
                        };
                        ports.cancel_live(run);
                        recorded?;
                        return Err(error);
                    }
                    Err(RunError::Blocked(reason)) if !retiring => {
                        self.block(claim, &view, *reason, now).await?
                    }
                    Err(RunError::Blocked(_)) if retiring => {}
                    Err(error) => {
                        tracing::error!(run = %run, tool = ?key, cause = %error, "original tool admission/result is uncertain");
                        // No receipt is not a definite failure or permission to repeat an effect.
                        if !retiring {
                            self.block(
                                claim,
                                &view,
                                BlockerKind::OriginalAdmissionUnknown { tool: key },
                                now,
                            )
                            .await?;
                        }
                    }
                }
            }
            Completion::Observed { key, result } => {
                live.work.remove(&WorkKey::Tool(key.clone()));
                let result = match result {
                    Err(RunError::Tool(
                        maka_agent_facts::tools::ToolError::OperationCleanupUnconfirmed {
                            message,
                            observation,
                        },
                    )) => {
                        tracing::warn!(cause=%message, "original operation reader cleanup remains pending");
                        Ok(*observation)
                    }
                    other => other,
                };
                match result {
                    Ok(reply) => {
                        let (reply, content) =
                            maka_agent_state::operation::prepare_reply(reply).await?;
                        if view.tools.get(&tool_key(&key)).is_some_and(|tool| {
                            tool.original.as_ref() == Some(&reply.reference)
                                && tool.receipt.as_ref() == Some(&reply.receipt)
                        }) {
                            return Ok(());
                        }
                        self.publish(
                            None,
                            &view,
                            vec![Fact::OperationObserved { tool: key, reply }],
                            content.into_iter().collect(),
                            now,
                        )
                        .await?;
                    }
                    Err(RunError::Blocked(reason))
                        if !retiring
                            && matches!(
                                *reason,
                                BlockerKind::CurrentAuthorityUnavailable { .. }
                            ) =>
                    {
                        self.block(claim, &view, *reason, now).await?;
                    }
                    Err(error) => {
                        tracing::error!(cause=%error,"original operation could not be observed");
                        if !retiring {
                            let tool = &view.tools[&tool_key(&key)];
                            let reference = tool
                                .original
                                .clone()
                                .expect("original observation reference");
                            let reason = match &tool.receipt {
                                Some(maka_agent_facts::operation::RecordedReceipt::Recorded {
                                    outcome:
                                        OperationOutcome::Returned { .. }
                                        | OperationOutcome::NotExecuted { .. },
                                    cleanup,
                                }) => {
                                    if *cleanup
                                        == maka_plugin_core::operation::OperationCleanup::Confirmed
                                    {
                                        return Ok(());
                                    }
                                    BlockerKind::CleanupUnconfirmed { reference }
                                }
                                _ => BlockerKind::OperationUnknown {
                                    tool: key,
                                    reference,
                                },
                            };
                            self.block(claim, &view, reason, now).await?;
                        }
                    }
                }
            }
            Completion::Assessed {
                attempt,
                basis,
                result,
            } => {
                live.work.remove(&WorkKey::Assess(attempt));
                if retiring || Head::from(&view) != basis {
                    return Ok(());
                }
                let evidence = match result {
                    Ok(value) => value,
                    Err(error) => return self.port_failure(claim, &view, error, now).await,
                };
                self.publish(
                    Some(claim),
                    &view,
                    vec![Fact::AttemptRecoveryRecorded {
                        attempt,
                        recovery: evidence.recovery,
                    }],
                    evidence.contents,
                    now,
                )
                .await?;
            }
            Completion::ModelCancelled { attempt, result } => {
                live.work.remove(&WorkKey::CancelModel(attempt));
                match result {
                    Ok(()) => {}
                    Err(error) if error.is_cleanup_unconfirmed() => {
                        // The original admitted future still owns its source/ACK obligation.
                        tracing::warn!(%attempt, cause=%error, "original model cancellation awaits source cleanup evidence");
                    }
                    Err(error) => return Err(error),
                }
            }
            Completion::Connected { attempt, result } => match result {
                Ok(connection) => {
                    read_model(work, attempt, view.attempts[&attempt].observed, connection)
                }
                Err(error) => {
                    live.work.remove(&WorkKey::Model(attempt));
                    if retiring {
                        return Ok(());
                    }
                    if matches!(
                        view.attempts[&attempt].recovery,
                        Some(AttemptRecovery::ObserveOriginal { .. })
                    ) {
                        let reason = match error {
                            RunError::Blocked(reason) => *reason,
                            error => {
                                tracing::error!(attempt=%attempt,cause=%error,"original model read failed");
                                BlockerKind::UnsupportedProtocol {
                                    protocol: "original-model-observation-unavailable".into(),
                                    version: 1,
                                }
                            }
                        };
                        self.block(claim, &view, reason, now).await?;
                    } else if view.proactive_summary != Some(attempt)
                        && let RunError::Blocked(reason) = error
                    {
                        self.block(claim, &view, *reason, now).await?;
                    } else {
                        self.publish(
                            Some(claim),
                            &view,
                            vec![Fact::ModelInterrupted {
                                attempt,
                                diagnostic: error.to_string(),
                            }],
                            vec![],
                            now,
                        )
                        .await?;
                    }
                }
            },
            Completion::Model {
                attempt,
                index,
                connection,
                observation,
            } => match observation {
                Some(Ok(ModelObservation::Recorded { fact })) => {
                    let original = self.store.fact(run, fact).await?.ok_or_else(|| {
                        RunError::Internal(
                            "model source acknowledged an absent original fact".into(),
                        )
                    })?;
                    match original.fact {
                        Fact::ModelObserved {
                            attempt: source,
                            index: source_index,
                            ..
                        } if source == attempt => read_model(
                            work,
                            attempt,
                            source_index
                                .checked_add(1)
                                .ok_or_else(|| RunError::Internal("model index overflow".into()))?,
                            connection,
                        ),
                        Fact::AttemptRecoveryRecorded {
                            attempt: source, ..
                        } if source == attempt => read_model(work, attempt, index, connection),
                        Fact::ModelCleanupObserved {
                            attempt: source, ..
                        } if source == attempt => read_model(work, attempt, index, connection),
                        Fact::ModelFirstTokenObserved { attempt: source }
                        | Fact::ModelPrivatePartialCaptured {
                            attempt: source, ..
                        } if source == attempt => read_model(work, attempt, index, connection),
                        Fact::ModelSourceFailureCaptured {
                            attempt: source, ..
                        } if source == attempt => read_model(work, attempt, index, connection),
                        Fact::ModelClosed {
                            attempt: source, ..
                        } if source == attempt => {
                            live.work.remove(&WorkKey::Model(attempt));
                        }
                        _ => {
                            return Err(RunError::Internal(
                                "model source acknowledged another attempt's fact".into(),
                            ));
                        }
                    }
                }
                other => {
                    live.work.remove(&WorkKey::Model(attempt));
                    if retiring {
                        return Ok(());
                    }
                    let diagnostic=match other {Some(Err(error))=>error.to_string(),None=>"Original observation transport ended without an upstream completion receipt".into(),Some(Ok(_))=>unreachable!()};
                    if matches!(
                        view.attempts[&attempt].recovery,
                        Some(AttemptRecovery::ObserveOriginal { .. })
                    ) {
                        tracing::error!(attempt=%attempt,cause=%diagnostic,"original job is not observable");
                        self.block(
                            claim,
                            &view,
                            BlockerKind::UnsupportedProtocol {
                                protocol: "original-model-observation-unavailable".into(),
                                version: 1,
                            },
                            now,
                        )
                        .await?;
                    } else {
                        self.publish(
                            Some(claim),
                            &view,
                            vec![Fact::ModelInterrupted {
                                attempt,
                                diagnostic,
                            }],
                            vec![],
                            now,
                        )
                        .await?;
                    }
                }
            },
        }
        Ok(())
    }
    async fn tool_acceptance(
        &self,
        view: &RunView,
        key: ToolKey,
        outcome: AcceptedResult,
    ) -> Result<(Vec<Fact>, ContentBlob), RunError> {
        let tool = &view.tools[&tool_key(&key)];
        let result = accepted_content(view, tool, &outcome)?;
        let loaded = self.accept_tool_loading(view, tool, &outcome).await?;
        let mut acceptance = if let AcceptedResult::CellRecovered { cell } = &outcome {
            if !view.stopped
                && matches!(
                    view.cells[cell].status,
                    maka_agent_facts::cells::CellStatus::Completed {
                        accepted: false,
                        ..
                    }
                )
            {
                maka_agent_state::cells::acceptance(&view.cells[cell])?
            } else {
                vec![]
            }
        } else {
            self.accept_cell_with_tool(view, tool).await?
        };
        acceptance.push(Fact::ToolResultAccepted {
            tool: key,
            result: result.reference().clone(),
            outcome,
        });
        acceptance.extend(loaded);
        Ok((acceptance, result))
    }

    async fn port_failure(
        &self,
        claim: &DriverClaim,
        view: &RunView,
        error: RunError,
        now: UnixMillis,
    ) -> Result<(), RunError> {
        match error {
            RunError::IsolationUnavailable(diagnostic) => {
                self.block(
                    claim,
                    view,
                    BlockerKind::CurrentAuthorityUnavailable {
                        stage: AuthorityStage::BackendScope,
                        diagnostic,
                    },
                    now,
                )
                .await
            }
            RunError::Blocked(reason) => self.block(claim, view, *reason, now).await,
            error => Err(error),
        }
    }
}

pub(super) fn termination_facts(
    view: &RunView,
    terminal: Terminal,
    diagnostic: Option<String>,
) -> Vec<Fact> {
    let mut facts = Vec::new();
    if terminal == Terminal::Failed
        && let Some(reason) = view.recovery_failure()
    {
        facts.extend(
            view.waits
                .iter()
                .filter(|(_, wait)| wait.satisfied.is_none() && wait.cancelled.is_none())
                .map(|(wait, _)| Fact::WaitCancelled {
                    wait: *wait,
                    diagnostic: "Run could not reconcile the original operation".into(),
                }),
        );
        facts.push(Fact::RunTerminated {
            terminal,
            diagnostic: Some(format!("{reason:?}")),
        });
        return facts;
    }
    if terminal == Terminal::Failed && reconcile::budget_exhausted(view) {
        facts.extend(
            view.waits
                .iter()
                .filter(|(_, wait)| {
                    wait.satisfied.is_none()
                        && wait.cancelled.is_none()
                        && matches!(wait.reason, WaitReason::Child { .. })
                })
                .map(|(wait, _)| Fact::WaitCancelled {
                    wait: *wait,
                    diagnostic: "Run terminated at its token budget".into(),
                }),
        );
    }
    let diagnostic = diagnostic.or_else(|| {
        let attempt = view
            .current_attempt
            .filter(|_| terminal == Terminal::Failed)
            .and_then(|id| view.attempts.get(&id))
            .filter(|attempt| Some(attempt.step) == view.current_step)?;
        attempt
            .closed
            .as_ref()
            .filter(|closed| closed.outcome == maka_agent_facts::accounting::Outcome::Error)
            .and_then(|closed| closed.diagnostic.clone())
            .or_else(|| attempt.interrupted.clone())
    });
    facts.push(Fact::RunTerminated {
        terminal,
        diagnostic,
    });
    facts
}

impl Engine {
    async fn complete_at_budget(&self, view: &RunView, now: UnixMillis) -> Result<bool, RunError> {
        if !reconcile::budget_exhausted(view)
            || view.stopped
            || view.cancelled_by_risk
            || view.spec.budget.deadline.is_some_and(|at| now >= at)
            || !matches!(view.spec.backend, BackendSpec::Model { .. })
        {
            return Ok(false);
        }
        let Some(step) = view.current_step else {
            return Ok(false);
        };
        // Settlement reads the original request even after reopening without model ports.
        let request = self.store.request(view.run, step).await?;
        Ok(reconcile::complete_at_budget(view, &request, now))
    }

    async fn accept_tool_loading(
        &self,
        view: &RunView,
        tool: &Tool,
        outcome: &AcceptedResult,
    ) -> Result<Vec<Fact>, RunError> {
        use maka_agent_facts::artifact::ToolReturn;
        #[derive(serde::Deserialize)]
        struct ToolLoading {
            is_error: bool,
            loaded_tools: std::collections::BTreeSet<String>,
        }
        if !view.spec.tool_discovery || !matches!(outcome, AcceptedResult::Succeeded) {
            return Ok(vec![]);
        }
        let result = tool
            .local_returned
            .as_ref()
            .map(|returned| &returned.result)
            .or_else(|| tool.host_returned.as_ref().map(|returned| &returned.result));
        let Some(result) = result else {
            return Ok(vec![]);
        };
        let bytes = self.store.content(view.run, result.clone()).await?;
        let returned: ToolReturn<ToolLoading> =
            serde_json::from_slice(&bytes).map_err(|error| {
                RunError::InvalidInput(format!("original tool return is invalid: {error}"))
            })?;
        if returned.schema_version != SCHEMA_VERSION {
            return Err(RunError::from(BlockerKind::UnsupportedProtocol {
                protocol: "returned-tool-result".into(),
                version: returned.schema_version,
            }));
        }
        let ToolLoading {
            is_error,
            loaded_tools,
        } = returned.body;
        if is_error {
            return Err(StoreError::EventConflict.into());
        }
        if loaded_tools.is_empty() {
            return Ok(vec![]);
        }
        Ok(vec![Fact::ToolsLoaded {
            tool: tool.key.clone(),
            names: loaded_tools,
        }])
    }
}

fn accepted_content(
    view: &RunView,
    tool: &Tool,
    outcome: &AcceptedResult,
) -> Result<ContentBlob, RunError> {
    use maka_agent_facts::tool_output::AcceptedToolResult;
    let result =
        if let AcceptedResult::CellRecovered { cell } = outcome {
            let evidence = match &view.cells[cell].status {
                maka_agent_facts::cells::CellStatus::Completed { result, .. } => {
                    maka_agent_facts::tool_output::CellFinalEvidence::Completed {
                        result: result.clone(),
                    }
                }
                maka_agent_facts::cells::CellStatus::Interrupted { report } => {
                    maka_agent_facts::tool_output::CellFinalEvidence::Interrupted {
                        report: report.clone(),
                    }
                }
                _ => {
                    return Err(RunError::Internal(
                        "recovered Cell has no original final evidence".into(),
                    ));
                }
            };
            AcceptedToolResult::RecoveredCell {
                cell: *cell,
                evidence,
            }
        } else if let Some(original) = tool.local_returned.as_ref().filter(|local| {
            local.settlement != maka_agent_facts::tool_call::ToolSettlement::Unknown
        }) {
            AcceptedToolResult::Local {
                result: original.result.clone(),
            }
        } else if let Some(result) = &tool.provider_result {
            AcceptedToolResult::Provider {
                output: result.output.clone(),
                is_error: result.is_error,
                provider_options: result.provider_options.clone(),
            }
        } else if let Some(returned) = &tool.host_returned {
            AcceptedToolResult::Host {
                result: returned.result.clone(),
            }
        } else if let (
            Some(reference),
            Some(
                receipt @ maka_agent_facts::operation::RecordedReceipt::Recorded {
                    outcome: OperationOutcome::Returned { .. },
                    ..
                },
            ),
        ) = (&tool.original, &tool.receipt)
        {
            AcceptedToolResult::ObservedOperation {
                reply: maka_plugin_core::operation::OperationReply {
                    reference: reference.clone(),
                    receipt: receipt.clone(),
                },
            }
        } else if matches!(outcome, AcceptedResult::Rejected) {
            let mut diagnostic = tool
                .prohibited_before_host
                .as_ref()
                .or(match &tool.decision {
                    Some(ToolDecision::Rejected { rejection, .. }) => Some(rejection),
                    _ => None,
                })
                .map(ToString::to_string)
                .unwrap_or_else(|| "original provider proved non-execution".into());
            if let Some(arguments) = tool.call.input.invalid_json_diagnostic() {
                diagnostic.push('\n');
                diagnostic.push_str(&arguments);
            }
            AcceptedToolResult::Rejected { diagnostic }
        } else {
            return Err(RunError::Internal(
                "tool acceptance has no matching original typed result".into(),
            ));
        };
    Ok(ContentBlob::json(&result)?)
}

fn exit(view: &RunView) -> DriverExit {
    if let Some(terminal) = &view.terminal {
        return DriverExit::Terminal {
            run: view.run,
            terminal: terminal.clone(),
        };
    }
    let due_at = view
        .waits
        .values()
        .filter(|wait| wait.satisfied.is_none() && wait.cancelled.is_none())
        .filter_map(|wait| wait.due_at)
        .min();
    let blockers: Vec<_> = view
        .blockers
        .iter()
        .filter(|(_, blocker)| blocker.decision.is_none() && blocker.resolved_by.is_none())
        .map(|(id, blocker)| (*id, blocker.reason.clone()))
        .collect();
    if blockers.is_empty() {
        DriverExit::Waiting {
            run: view.run,
            due_at,
        }
    } else {
        DriverExit::Blocked {
            run: view.run,
            blockers,
            due_at,
        }
    }
}
