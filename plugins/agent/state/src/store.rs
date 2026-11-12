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

use crate::{fold::RunView, sql};
use maka_agent_facts::durable::*;
use maka_event_log::{
    StoreError,
    connection::Query,
    root_store::DataWriter,
    writeback::{Notification, Prepared, Statement},
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, Weak},
};

pub(crate) fn invalid(reason: impl Into<String>) -> StoreError {
    StoreError::InvalidTransition(reason.into())
}

/// A captured caller's data checks, never an authority token or a new admission.
#[derive(Clone)]
pub struct CallerFence {
    pub execution: ExecutionIdentity,
    pub expected_basis: Option<maka_sandbox::workspace::PermissionBasis>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CallerStatus {
    Current,
    Unavailable,
    AuthorizationChanged,
}
impl CallerFence {
    pub fn status(&self, connection: &Connection) -> Result<CallerStatus, StoreError> {
        if !crate::interactions::sql::active_session(connection, &self.execution.session_id)? {
            return Ok(CallerStatus::Unavailable);
        }
        let exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_runs WHERE run=?1 AND session=?2)",
            rusqlite::params![self.execution.run_id.to_string(), self.execution.session_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Ok(CallerStatus::Unavailable);
        }
        let view = sql::load(connection, self.execution.run_id, &[], false)?;
        if view.run != self.execution.run_id
            || view.spec.session_id != self.execution.session_id
            || !matches!(view.spec.origin, RunOrigin::Local)
            || view.stopped
            || view.terminal.is_some()
        {
            return Ok(CallerStatus::Unavailable);
        }
        if let Some(expected) = self.expected_basis
            && (view.spec.permission_basis != expected
                || crate::interactions::sql::current_basis(connection, &self.execution.session_id)?
                    != Some(expected))
        {
            return Ok(CallerStatus::AuthorizationChanged);
        }
        Ok(CallerStatus::Current)
    }
}

mod admission;
mod content;
pub(crate) mod fallback;
mod local;
pub use local::LocalResult;
mod metadata;
pub use metadata::{NotificationAttention, NotificationState};
mod publication;
mod quiescence;
pub use content::{ContentBlob, ImmutableContentBody};
pub use publication::PublicationRead;
pub use quiescence::{SessionObligation, SessionQuiescence, SessionQuiescenceGuard};

/// A trusted native domain's read-only check on the original Root transaction.
/// It must not start effects, re-enter the writer, or reconstruct authority from data.
pub trait AdmissionGuard: Send + Sync {
    fn validate(&self, c: &Connection, run: RunId, spec: &RunSpec) -> Result<(), StoreError>;
}

/// Prepared once before admission. Retain this original object/id if observing
/// the commit becomes uncertain; constructing another Admission is another Run.
#[derive(Clone)]
pub struct Admission {
    pub(crate) run: RunId,
    pub(crate) id: FactId,
    pub(crate) spec: RunSpec,
    pub(crate) at: UnixMillis,
    pub(crate) contents: Vec<ContentBlob>,
    pub(crate) queue: Option<crate::queue::Consume>,
    pub(crate) guard: Option<Arc<dyn AdmissionGuard>>,
}
impl Admission {
    pub fn new(spec: RunSpec, at: UnixMillis, contents: Vec<ContentBlob>) -> Self {
        Self::with_identity(RunId::new(), spec, at, contents)
    }
    pub fn with_identity(
        run: RunId,
        spec: RunSpec,
        at: UnixMillis,
        contents: Vec<ContentBlob>,
    ) -> Self {
        Self {
            run,
            id: FactId::new(),
            spec,
            at,
            contents,
            queue: None,
            guard: None,
        }
    }
    /// Inert post-admission projection, not a receipt or a reservation. Only expose
    /// it as an admitted execution after the original Root transaction commits.
    pub fn preview(&self) -> Result<RunView, StoreError> {
        let blob = ContentBlob::json(&self.spec)?;
        let mut view = RunView::admitted(self.run, self.spec.clone())?;
        view.apply(&RecordedFact {
            schema_version: SCHEMA_VERSION,
            id: self.id,
            run: self.run,
            revision: 1,
            at: self.at,
            fact: Fact::RunAdmitted {
                spec: blob.reference().clone(),
            },
        })?;
        Ok(view)
    }
    pub fn with_guard(mut self, guard: Arc<dyn AdmissionGuard>) -> Self {
        self.guard = Some(guard);
        self
    }
    pub fn with_queue(mut self, consume: crate::queue::Consume) -> Self {
        self.queue = Some(consume);
        self
    }
    pub fn run(&self) -> RunId {
        self.run
    }
    pub fn fact_id(&self) -> FactId {
        self.id
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Change {
    pub id: FactId,
    pub at: UnixMillis,
    pub fact: Fact,
}
impl Change {
    pub fn new(fact: Fact, at: UnixMillis) -> Self {
        Self {
            id: FactId::new(),
            at,
            fact,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Head {
    pub revision: u64,
    pub control_version: u64,
}
impl From<&RunView> for Head {
    fn from(view: &RunView) -> Self {
        Self {
            revision: view.revision,
            control_version: view.control_version,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Commit {
    pub head: Head,
    pub facts: Vec<RecordedFact>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReadyRun {
    pub run: RunId,
    pub admission_sequence: u64,
    pub session_id: String,
    pub purpose: DriverPurpose,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DriverPurpose {
    Business,
    LateExternalCleanup { task: ExternalTaskId },
    LateModelCleanup,
}

#[derive(Clone, Debug)]
pub struct ModelCleanupItem {
    pub owner: RunOwner,
    pub execution: ExecutionIdentity,
    pub attempt: ModelAttemptId,
    pub step: StepId,
    pub request: ContentRef,
    pub upstream: serde_json::Value,
}
#[derive(Clone, Debug)]
pub struct CleanupFrontier {
    pub run: RunId,
    pub head: Head,
    pub owner: RunOwner,
    pub session_id: String,
    pub turn_id: String,
    pub backend: ContentRef,
    pub task: ExternalTaskId,
    pub descriptor: ContentRef,
    pub binding: Option<ContentRef>,
    pub cleanup: maka_plugin_core::operation::OperationCleanup,
    pub not_before: Option<UnixMillis>,
    pub has_creation_evidence: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AnswerPage {
    pub offset: u64,
    pub high_water: u64,
    pub text: String,
    pub next: Option<u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RunObservation {
    pub view: RunView,
    pub answer: AnswerPage,
    pub pending_interactions: u64,
}

/// One domain per live native Root, explicitly shared across activations and
/// Store clones. It cannot be decoded from a RunSpec or a Root's serialized id.
#[derive(Clone)]
pub struct DriverDomain {
    inner: Arc<Domain>,
}
struct Domain {
    data: DataWriter,
    drivers: Mutex<BTreeMap<RunId, Weak<Ticket>>>,
}
struct Ticket {
    run: RunId,
    domain: Arc<Domain>,
    purpose: DriverPurpose,
    retirement: tokio_util::sync::CancellationToken,
    // Immutable publications may retain this ticket after its driver stops.
    active: std::sync::atomic::AtomicBool,
}
impl Ticket {
    fn blocks(&self, requested: DriverPurpose) -> bool {
        match requested {
            DriverPurpose::LateExternalCleanup { .. } | DriverPurpose::LateModelCleanup => true,
            DriverPurpose::Business => {
                matches!(self.purpose, DriverPurpose::Business)
                    && self.active.load(std::sync::atomic::Ordering::Acquire)
            }
        }
    }
}
impl Drop for Ticket {
    fn drop(&mut self) {
        if let Ok(mut entries) = self.domain.drivers.lock()
            && entries
                .get(&self.run)
                .is_some_and(|entry| std::ptr::eq(entry.as_ptr(), self))
        {
            entries.remove(&self.run);
        }
    }
}
#[derive(Clone)]
pub struct DriverClaim {
    ticket: Arc<Ticket>,
}
impl DriverClaim {
    pub fn deactivate(&self) {
        self.ticket
            .active
            .store(false, std::sync::atomic::Ordering::Release);
    }
    pub fn purpose(&self) -> DriverPurpose {
        self.ticket.purpose
    }
    pub fn retirement(&self) -> tokio_util::sync::CancellationToken {
        self.ticket.retirement.clone()
    }
    pub fn run(&self) -> RunId {
        self.ticket.run
    }
    pub(crate) fn with_current<T>(
        &self,
        data: &DataWriter,
        f: impl FnOnce() -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        if !data.same_root(&self.ticket.domain.data) {
            return Err(invalid("driver claim belongs to another Root owner"));
        }
        let entries = self
            .ticket
            .domain
            .drivers
            .lock()
            .map_err(|_| invalid("poisoned driver domain"))?;
        if !entries
            .get(&self.run())
            .is_some_and(|entry| Weak::ptr_eq(entry, &Arc::downgrade(&self.ticket)))
        {
            return Err(invalid("superseded driver claim"));
        }
        f()
    }
}
impl DriverDomain {
    pub fn new(data: DataWriter) -> Result<Self, StoreError> {
        if !data.same_root(&data) {
            return Err(invalid("closed driver Root"));
        }
        Ok(Self {
            inner: Arc::new(Domain {
                data,
                drivers: Mutex::new(BTreeMap::new()),
            }),
        })
    }
}
#[derive(Clone)]
pub struct Store {
    data: DataWriter,
    domain: DriverDomain,
}
impl Store {
    pub fn prepare_admission(
        &self,
        admission: Admission,
    ) -> maka_event_log::root_store::DataChange {
        self.data.prepare(Admit(admission))
    }
    pub fn with_data_writer(&self, data: DataWriter) -> Result<Self, StoreError> {
        self.validate_root(&data)?;
        Ok(Self {
            data,
            domain: self.domain.clone(),
        })
    }
    pub async fn imported_sessions(
        &self,
        owner: RunOwner,
        prefix: String,
        after: Option<String>,
        limit: u32,
    ) -> Result<crate::session_history::snapshot::ImportedSessions, StoreError> {
        self.data
            .query(crate::session_history::snapshot::ImportedSessionIds(
                owner, prefix, after, limit,
            ))
            .await
    }
    pub async fn publication_item(
        &self,
        run: RunId,
        key: maka_agent_facts::external_publication::ExternalPublicationKey,
    ) -> Result<Option<crate::external_publication::PublicationItem>, StoreError> {
        self.data
            .query(crate::external_publication::ReadItem(run, key))
            .await
    }
    pub async fn publication_for_task(
        &self,
        run: RunId,
        task: ExternalTaskId,
    ) -> Result<Option<crate::external_publication::ExternalPublication>, StoreError> {
        self.data
            .query(crate::external_publication::ReadPublication(run, task))
            .await
    }
    pub async fn compaction_fallback(
        &self,
        run: RunId,
        summary_step: StepId,
    ) -> Result<Option<StepId>, StoreError> {
        fallback::compaction_fallback(&self.data, run, summary_step).await
    }
    pub async fn compaction_progress(
        &self,
        run: RunId,
        current_main: StepId,
    ) -> Result<Option<FactId>, StoreError> {
        fallback::compaction_progress(&self.data, run, current_main).await
    }
    pub async fn ready_summary(
        &self,
        run: RunId,
        step: StepId,
        current_attempt: Option<ModelAttemptId>,
    ) -> Result<Option<ModelAttemptId>, StoreError> {
        self.data
            .query(fallback::ReadySummary(run, step, current_attempt))
            .await
    }
    pub async fn previous_proactive_summary(
        &self,
        view: &RunView,
    ) -> Result<Option<maka_agent_facts::context::SummaryOrigin>, StoreError> {
        let Some(step) = view.current_step else {
            return Ok(None);
        };
        self.data
            .query(sql::compaction::PreviousProactiveSummary(view.run, step))
            .await
    }
    pub async fn finished_or_stopped(
        &self,
        owner: RunOwner,
        runs: Vec<RunId>,
    ) -> Result<std::collections::BTreeSet<RunId>, StoreError> {
        metadata::finished_or_stopped(&self.data, owner, runs).await
    }
    pub async fn ensure_diagnostics(&self, owner: RunOwner) -> Result<(), StoreError> {
        crate::diagnostics::ensure_owner(&self.data, owner).await
    }
    pub fn diagnostics(
        &self,
        owner: RunOwner,
        session: String,
    ) -> Result<crate::diagnostics::DiagnosticsStore, StoreError> {
        crate::diagnostics::DiagnosticsStore::new(self.data.clone(), owner, session)
    }
    pub fn artifacts(&self) -> crate::artifacts::ArtifactStore {
        crate::artifacts::ArtifactStore::new(self.data.clone())
    }
    pub fn cells(&self) -> crate::cells::CellsStore {
        crate::cells::CellsStore::new(self.data.clone())
    }
    pub fn computer(&self) -> crate::computer::ComputerStore {
        crate::computer::ComputerStore::new(self.data.clone())
    }
    pub fn usage(&self) -> crate::usage::UsageStore {
        crate::usage::UsageStore::new(self.data.clone())
    }
    pub fn session_history(
        &self,
        owner: RunOwner,
        session: String,
    ) -> crate::session_history::SessionHistory {
        crate::session_history::SessionHistory::new(self.data.clone(), owner, session)
    }
    pub fn catalog(
        &self,
        owner: RunOwner,
        prefix: String,
    ) -> Result<crate::session_catalog::SessionCatalog, StoreError> {
        crate::session_catalog::SessionCatalog::new(self.data.clone(), owner, prefix)
    }
    pub fn recall(
        &self,
        owner: RunOwner,
        prefix: String,
    ) -> Result<crate::recall::RecallStore, StoreError> {
        crate::recall::RecallStore::new(self.data.clone(), owner, prefix)
    }
    pub async fn external_effect(
        &self,
        run: RunId,
        key: maka_agent_facts::external_effects::ExternalEffectKey,
    ) -> Result<Option<crate::external_effects::ExternalEffect>, StoreError> {
        self.data
            .query(crate::external_effects::ReadEffect(run, key))
            .await
    }
    pub async fn observe_artifacts(
        &self,
        run: RunId,
        changes: Vec<Change>,
        contents: Vec<ContentBlob>,
        writes: Vec<maka_agent_facts::event::ProjectionArtifactWrite>,
    ) -> Result<Commit, StoreError> {
        self.data
            .write(ObserveArtifacts(Append {
                run,
                expected: None,
                changes,
                contents,
                steering: None,
                mode: Mode::Late,
                artifacts: crate::artifacts::ArtifactBatch::new(writes),
            }))
            .await
    }
    pub fn prepare_control(
        &self,
        run: RunId,
        head: Head,
        changes: Vec<Change>,
        contents: Vec<ContentBlob>,
    ) -> maka_event_log::root_store::DataChange {
        self.data.prepare(Append {
            run,
            expected: Some(head),
            changes,
            contents,
            steering: None,
            mode: Mode::Control,
            artifacts: Default::default(),
        })
    }
    /// Stop this exact Run at its current head. The first Stop while latest also
    /// retracts pending interactive requests and reports that Session fence.
    pub fn stop_run_statement(&self, run: RunId, change: Change) -> StopRun {
        StopRun {
            run,
            change,
            retract_pending: true,
        }
    }
    pub async fn external_effect_descriptor(
        &self,
        run: RunId,
        key: maka_agent_facts::external_effects::ExternalEffectKey,
    ) -> Result<maka_agent_facts::external_effects::ExternalEffectDescriptor, StoreError> {
        self.data
            .query(crate::external_effects::ReadDescriptor(run, key))
            .await
    }
    pub fn new(data: DataWriter, domain: DriverDomain) -> Result<Self, StoreError> {
        if !data.same_root(&domain.inner.data) {
            return Err(invalid("driver domain belongs to another Root owner"));
        }
        Ok(Self { data, domain })
    }
    pub fn validate_root(&self, data: &DataWriter) -> Result<(), StoreError> {
        if self.data.same_root(data) {
            Ok(())
        } else {
            Err(invalid("Agent Store belongs to another Root owner"))
        }
    }
    pub fn interactions(&self) -> crate::interactions::InteractionsStore {
        crate::interactions::InteractionsStore::new(self.data.clone())
    }
    pub fn queue(&self) -> crate::queue::QueueStore {
        crate::queue::QueueStore::new(self.data.clone())
    }
    pub fn subscribe(&self) -> Result<tokio::sync::watch::Receiver<()>, StoreError> {
        self.data.subscribe_changes()
    }
    pub async fn driver_frontier(&self, claim: &DriverClaim) -> Result<RunView, StoreError> {
        self.read_driver(claim, DriverRead::Execute).await
    }
    /// Read original obligations after Stop through the same current physical claim.
    /// This does not authorize new admission or dispatch.
    pub async fn original_driver_frontier(
        &self,
        claim: &DriverClaim,
    ) -> Result<RunView, StoreError> {
        self.read_driver(claim, DriverRead::ObserveOriginal).await
    }
    async fn read_driver(
        &self,
        claim: &DriverClaim,
        access: DriverRead,
    ) -> Result<RunView, StoreError> {
        if !Arc::ptr_eq(&self.domain.inner, &claim.ticket.domain) {
            return Err(invalid("foreign driver claim"));
        }
        self.data
            .query(ReadDriver {
                claim: claim.clone(),
                access,
            })
            .await
    }
    pub async fn find_run(&self, run: RunId) -> Result<Option<RunView>, StoreError> {
        self.data.query(FindRun(run)).await
    }
    pub async fn fact(&self, run: RunId, id: FactId) -> Result<Option<RecordedFact>, StoreError> {
        self.data.query(ReadFact { run, id }).await
    }
    pub async fn fact_barrier(
        &self,
        run: RunId,
        id: FactId,
    ) -> Result<Option<RecordedFact>, StoreError> {
        self.data.query_barrier(ReadFact { run, id }).await
    }
    pub async fn ready_runs(
        &self,
        owner: RunOwner,
        at: UnixMillis,
        after: Option<u64>,
        limit: u32,
    ) -> Result<Vec<ReadyRun>, StoreError> {
        self.ready_runs_with_cause(owner, at, after, limit, ReadyCause::Ordinary)
            .await
    }
    pub async fn ready_runs_with_cause(
        &self,
        owner: RunOwner,
        at: UnixMillis,
        after: Option<u64>,
        limit: u32,
        cause: ReadyCause,
    ) -> Result<Vec<ReadyRun>, StoreError> {
        self.data
            .query(ReadReady {
                owner,
                at,
                after,
                limit,
                cause,
            })
            .await
    }
    pub async fn next_due_wait(&self, owner: RunOwner) -> Result<Option<UnixMillis>, StoreError> {
        self.data
            .query(ReadNextDue(owner, None, ReadyCause::Ordinary))
            .await
    }
    pub async fn next_due_after(
        &self,
        owner: RunOwner,
        at: UnixMillis,
    ) -> Result<Option<UnixMillis>, StoreError> {
        self.next_due_after_with_cause(owner, at, ReadyCause::Ordinary)
            .await
    }
    pub async fn next_due_after_with_cause(
        &self,
        owner: RunOwner,
        at: UnixMillis,
        cause: ReadyCause,
    ) -> Result<Option<UnixMillis>, StoreError> {
        self.data.query(ReadNextDue(owner, Some(at), cause)).await
    }
    pub async fn latest_run(&self, session: String) -> Result<Option<RunId>, StoreError> {
        self.data.query(ReadLatest(session)).await
    }
    pub async fn work(
        &self,
        run: RunId,
        offset: u64,
        limit: u32,
    ) -> Result<Option<RunObservation>, StoreError> {
        self.data.query(ReadWork { run, offset, limit }).await
    }
    pub async fn admit(&self, admission: Admission) -> Result<Commit, StoreError> {
        self.data.write(Admit(admission)).await
    }
    /// The actual native owner explicitly replaces its previous physical driver.
    /// Nothing in the returned projection is sufficient to construct this token.
    pub async fn claim(&self, run: RunId) -> Result<DriverClaim, StoreError> {
        let view = self.frontier(run).await?;
        if !matches!(view.spec.origin, RunOrigin::Local) || view.terminal.is_some() {
            return Err(invalid("Run is not locally claimable"));
        }
        let ticket = Arc::new(Ticket {
            run,
            domain: self.domain.inner.clone(),
            purpose: DriverPurpose::Business,
            retirement: tokio_util::sync::CancellationToken::new(),
            active: std::sync::atomic::AtomicBool::new(true),
        });
        let previous = {
            let mut entries = self
                .domain
                .inner
                .drivers
                .lock()
                .map_err(|_| invalid("poisoned driver domain"))?;
            let previous = entries.get(&run).and_then(Weak::upgrade);
            entries.insert(run, Arc::downgrade(&ticket));
            previous
        };
        if let Some(previous) = previous {
            previous.retirement.cancel();
        }
        Ok(DriverClaim { ticket })
    }
    pub async fn reserve_driver(
        &self,
        run: RunId,
        purpose: DriverPurpose,
        retirement: tokio_util::sync::CancellationToken,
    ) -> Result<Option<DriverClaim>, StoreError> {
        let current = {
            let entries = self
                .domain
                .inner
                .drivers
                .lock()
                .map_err(|_| invalid("poisoned driver domain"))?;
            entries.get(&run).and_then(Weak::upgrade)
        };
        if current.as_ref().is_some_and(|old| old.blocks(purpose)) {
            return Ok(None);
        }
        drop(current);
        match purpose {
            DriverPurpose::Business => {
                let view = self.frontier(run).await?;
                if !matches!(view.spec.origin, RunOrigin::Local) || view.terminal.is_some() {
                    return Ok(None);
                }
            }
            DriverPurpose::LateExternalCleanup { task } => {
                let view = self.data.query(ReadCleanup(run)).await?;
                if view.task != task
                    || view.cleanup == maka_plugin_core::operation::OperationCleanup::Confirmed
                {
                    return Ok(None);
                }
            }
            DriverPurpose::LateModelCleanup => {
                let view = self.frontier(run).await?;
                if !matches!(view.spec.origin, RunOrigin::Local)
                    || !matches!(view.spec.backend, BackendSpec::Model { .. })
                {
                    return Ok(None);
                }
            }
        }
        let ticket = Arc::new(Ticket {
            run,
            domain: self.domain.inner.clone(),
            purpose,
            retirement: retirement.child_token(),
            active: std::sync::atomic::AtomicBool::new(true),
        });
        let (previous, reserved) = {
            let mut entries = self
                .domain
                .inner
                .drivers
                .lock()
                .map_err(|_| invalid("poisoned driver domain"))?;
            let previous = entries.get(&run).and_then(Weak::upgrade);
            let reserved = !previous.as_ref().is_some_and(|old| old.blocks(purpose));
            if reserved {
                entries.insert(run, Arc::downgrade(&ticket));
            }
            (previous, reserved)
        };
        if !reserved {
            return Ok(None);
        }
        if let Some(previous) = previous {
            previous.retirement.cancel();
        }
        Ok(Some(DriverClaim { ticket }))
    }
    pub async fn cleanup_frontier(
        &self,
        claim: &DriverClaim,
    ) -> Result<CleanupFrontier, StoreError> {
        if !Arc::ptr_eq(&self.domain.inner, &claim.ticket.domain) {
            return Err(invalid("foreign cleanup claim"));
        }
        self.data.query(ReadClaimedCleanup(claim.clone())).await
    }
    pub async fn append(
        &self,
        claim: &DriverClaim,
        head: Head,
        changes: Vec<Change>,
        contents: Vec<ContentBlob>,
    ) -> Result<Commit, StoreError> {
        if !Arc::ptr_eq(&self.domain.inner, &claim.ticket.domain) {
            return Err(invalid("foreign driver claim"));
        }
        self.data
            .write(Append {
                run: claim.run(),
                expected: Some(head),
                changes,
                contents,
                steering: None,
                artifacts: Default::default(),
                mode: Mode::Driver(claim.clone()),
            })
            .await
    }
    pub async fn append_steering(
        &self,
        claim: &DriverClaim,
        head: Head,
        changes: Vec<Change>,
        contents: Vec<ContentBlob>,
        consume: crate::queue::Consume,
    ) -> Result<Commit, StoreError> {
        if !Arc::ptr_eq(&self.domain.inner, &claim.ticket.domain) {
            return Err(invalid("foreign driver claim"));
        }
        self.data
            .write(Append {
                run: claim.run(),
                expected: Some(head),
                changes,
                contents,
                steering: Some(consume),
                artifacts: Default::default(),
                mode: Mode::Driver(claim.clone()),
            })
            .await
    }
    /// Human/control ingress still compares the exact canonical head. This API
    /// accepts control facts only; it cannot dispatch or charge a fresh attempt.
    pub async fn control(
        &self,
        run: RunId,
        head: Head,
        changes: Vec<Change>,
        contents: Vec<ContentBlob>,
    ) -> Result<Commit, StoreError> {
        self.data
            .write(Append {
                run,
                expected: Some(head),
                changes,
                contents,
                steering: None,
                artifacts: Default::default(),
                mode: Mode::Control,
            })
            .await
    }
    /// Original admitted work can report late facts after Stop/driver replacement.
    /// Fold checks its original attempt/RecoveryRef; this creates no fresh grant.
    pub async fn observe(
        &self,
        run: RunId,
        changes: Vec<Change>,
        contents: Vec<ContentBlob>,
    ) -> Result<Commit, StoreError> {
        self.data
            .write(Append {
                run,
                expected: None,
                changes,
                contents,
                steering: None,
                artifacts: Default::default(),
                mode: Mode::Late,
            })
            .await
    }
    pub async fn frontier(&self, run: RunId) -> Result<RunView, StoreError> {
        self.data.query(ReadFrontier(run)).await
    }
    pub async fn model_items(
        &self,
        run: RunId,
        attempt: ModelAttemptId,
        after_index: Option<u64>,
        limit: u32,
    ) -> Result<Vec<RecordedFact>, StoreError> {
        self.data
            .query(ReadModelItems {
                run,
                attempt,
                after_index,
                limit,
            })
            .await
    }
    pub async fn model_reconciliation_runs(
        &self,
        owner: RunOwner,
        after: Option<u64>,
        limit: u32,
        cold_probe: bool,
    ) -> Result<Vec<ReadyRun>, StoreError> {
        self.data
            .query(ReadModelRuns(owner, after, limit, cold_probe))
            .await
    }
    pub async fn model_cleanups(
        &self,
        claim: &DriverClaim,
        after: Option<ModelAttemptId>,
        limit: u32,
        cold_probe: bool,
    ) -> Result<Vec<ModelCleanupItem>, StoreError> {
        if !Arc::ptr_eq(&self.domain.inner, &claim.ticket.domain) {
            return Err(invalid("foreign model cleanup claim"));
        }
        self.data
            .query(ReadModelCleanups(claim.clone(), after, limit, cold_probe))
            .await
    }
    pub async fn history(
        &self,
        run: RunId,
        after_revision: u64,
        limit: u32,
    ) -> Result<Vec<RecordedFact>, StoreError> {
        self.data
            .query(ReadHistory {
                run,
                after_revision,
                limit,
            })
            .await
    }
    pub async fn tool_admission_revision(
        &self,
        run: RunId,
        tool: ToolKey,
    ) -> Result<Option<u64>, StoreError> {
        self.data.query(ReadToolAdmissionRevision(run, tool)).await
    }
    pub async fn model_attempt(
        &self,
        run: RunId,
        attempt: ModelAttemptId,
    ) -> Result<crate::fold::Attempt, StoreError> {
        self.data.query(ReadModelAttempt(run, attempt)).await
    }
    pub async fn request(&self, run: RunId, step: StepId) -> Result<RequestSpec, StoreError> {
        self.data.query(ReadRequest { run, step }).await
    }
    pub async fn content(&self, run: RunId, reference: ContentRef) -> Result<Vec<u8>, StoreError> {
        self.data.query(ReadContent { run, reference }).await
    }
    pub async fn due_waits(
        &self,
        at: UnixMillis,
        after: Option<(UnixMillis, RunId, WaitId)>,
        limit: u32,
    ) -> Result<Vec<(RunId, WaitId, crate::fold::Wait)>, StoreError> {
        self.data.query(ReadDue { at, after, limit }).await
    }
    pub async fn runs(
        &self,
        session: String,
        after: Option<RunId>,
        limit: u32,
    ) -> Result<Vec<RunId>, StoreError> {
        self.data
            .query(ReadRuns {
                session,
                after,
                limit,
            })
            .await
    }
    /// Replays canonical facts into disposable indexes in the existing writer
    /// transaction. Canonical contents/pins and original receipts are untouched.
    pub async fn rebuild(&self, run: RunId) -> Result<Head, StoreError> {
        self.data.write(Rebuild(run)).await
    }
}
struct Admit(Admission);
impl Statement for Admit {
    fn retain(&self) -> Vec<Arc<dyn Send + Sync>> {
        vec![Arc::new((self.0.contents.clone(), self.0.guard.clone()))]
    }
    type Value = Commit;
    type Output = Commit;
    fn execute(self, connection: &Connection) -> Result<Prepared<Commit>, StoreError> {
        let (value, changed) = sql::admit(connection, self.0)?;
        let notification = sql::notification(connection, value.facts[0].run, changed)?;
        Ok(Prepared {
            value,
            changed,
            notification,
        })
    }
    fn committed(value: Commit) -> Commit {
        value
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(
            error,
            StoreError::InvalidTransition(_)
                | StoreError::EventConflict
                | StoreError::RevisionConflict { .. }
        )
    }
}
pub(crate) enum Mode {
    Historical,
    Driver(DriverClaim),
    Control,
    Late,
}
struct Append {
    run: RunId,
    expected: Option<Head>,
    changes: Vec<Change>,
    contents: Vec<ContentBlob>,
    steering: Option<crate::queue::Consume>,
    mode: Mode,
    artifacts: crate::artifacts::ArtifactBatch,
}
impl Statement for Append {
    fn retain(&self) -> Vec<Arc<dyn Send + Sync>> {
        vec![Arc::new(self.contents.clone())]
    }
    type Value = Commit;
    type Output = Commit;
    fn execute(self, connection: &Connection) -> Result<Prepared<Commit>, StoreError> {
        // The registry lock orders takeover with SQL admission, not async work.
        let domain = match &self.mode {
            Mode::Driver(claim) => Some(claim.ticket.domain.clone()),
            _ => None,
        };
        let entries = domain
            .as_ref()
            .map(|domain| {
                domain
                    .drivers
                    .lock()
                    .map_err(|_| invalid("poisoned driver domain"))
            })
            .transpose()?;
        if let Mode::Driver(claim) = &self.mode {
            let current = entries.as_ref().and_then(|entries| entries.get(&self.run));
            if !current.is_some_and(|entry| Weak::ptr_eq(entry, &Arc::downgrade(&claim.ticket))) {
                return Err(invalid("superseded driver claim"));
            }
        }
        let (value, changed) = sql::append(
            connection,
            self.run,
            self.expected,
            &self.changes,
            sql::AppendMaterial {
                contents: self.contents,
                artifacts: &self.artifacts,
            },
            &self.mode,
            self.steering.as_ref(),
        )?;
        let notification = sql::notification(connection, self.run, changed)?;
        Ok(Prepared {
            value,
            changed,
            notification,
        })
    }
    fn committed(value: Commit) -> Commit {
        value
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        Admit::isolated_rejection(error)
    }
}
struct ReadModelRuns(RunOwner, Option<u64>, u32, bool);
impl Query for ReadModelRuns {
    type Output = Vec<ReadyRun>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::model_reconciliation_runs(c, self.0, self.1, self.2, self.3)
    }
}
struct ReadModelCleanups(DriverClaim, Option<ModelAttemptId>, u32, bool);
impl Query for ReadModelCleanups {
    type Output = Vec<ModelCleanupItem>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        self.0.with_current(&self.0.ticket.domain.data, || {
            if self.0.purpose() != DriverPurpose::LateModelCleanup {
                return Err(invalid("not a model cleanup claim"));
            }
            sql::model_cleanups(c, self.0.run(), self.1, self.2, self.3)
        })
    }
}
struct ReadFrontier(RunId);
struct ReadCleanup(RunId);
impl Query for ReadCleanup {
    type Output = CleanupFrontier;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::cleanup_frontier(c, self.0)
    }
}
struct ReadClaimedCleanup(DriverClaim);
impl Query for ReadClaimedCleanup {
    type Output = CleanupFrontier;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        self.0.with_current(&self.0.ticket.domain.data, || {
            let view = sql::cleanup_frontier(c, self.0.run())?;
            if self.0.purpose() != (DriverPurpose::LateExternalCleanup { task: view.task }) {
                return Err(invalid("not the original cleanup claim"));
            }
            Ok(view)
        })
    }
}
impl Query for ReadFrontier {
    type Output = RunView;
    fn execute(self, c: &Connection) -> Result<RunView, StoreError> {
        sql::load(c, self.0, &[], false)
    }
}
struct ReadHistory {
    run: RunId,
    after_revision: u64,
    limit: u32,
}
impl Query for ReadHistory {
    type Output = Vec<RecordedFact>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::history(c, self.run, self.after_revision, self.limit)
    }
}
struct ReadToolAdmissionRevision(RunId, ToolKey);
impl Query for ReadToolAdmissionRevision {
    type Output = Option<u64>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::tool_admission_revision(c, self.0, self.1)
    }
}
struct ReadModelAttempt(RunId, ModelAttemptId);
impl Query for ReadModelAttempt {
    type Output = crate::fold::Attempt;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::model_attempt(c, self.0, self.1)
    }
}
struct ReadRequest {
    run: RunId,
    step: StepId,
}
impl Query for ReadRequest {
    type Output = RequestSpec;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::request(c, self.run, self.step)
    }
}
struct ReadContent {
    run: RunId,
    reference: ContentRef,
}
impl Query for ReadContent {
    type Output = Vec<u8>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::owned_content(c, self.run, &self.reference)
    }
}
struct ReadDue {
    at: UnixMillis,
    after: Option<(UnixMillis, RunId, WaitId)>,
    limit: u32,
}
impl Query for ReadDue {
    type Output = Vec<(RunId, WaitId, crate::fold::Wait)>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::due(c, self.at, self.after, self.limit)
    }
}
struct ReadRuns {
    session: String,
    after: Option<RunId>,
    limit: u32,
}
impl Query for ReadRuns {
    type Output = Vec<RunId>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::runs(c, self.session, self.after, self.limit)
    }
}
struct Rebuild(RunId);
impl Statement for Rebuild {
    type Value = Head;
    type Output = Head;
    fn execute(self, c: &Connection) -> Result<Prepared<Head>, StoreError> {
        Ok(Prepared {
            value: sql::rebuild(c, self.0)?,
            changed: true,
            notification: sql::notification(c, self.0, true)?,
        })
    }
    fn committed(value: Head) -> Head {
        value
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        Admit::isolated_rejection(error)
    }
}

struct FindRun(RunId);
impl Query for FindRun {
    type Output = Option<RunView>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        if sql::exists(c, self.0)? {
            Ok(Some(sql::load(c, self.0, &[], false)?))
        } else {
            Ok(None)
        }
    }
}
struct ReadFact {
    run: RunId,
    id: FactId,
}
impl Query for ReadFact {
    type Output = Option<RecordedFact>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::fact(c, self.run, self.id)
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadyCause {
    Ordinary,
    CapabilitySourceChanged,
}

struct ReadReady {
    cause: ReadyCause,
    owner: RunOwner,
    at: UnixMillis,
    after: Option<u64>,
    limit: u32,
}
impl Query for ReadReady {
    type Output = Vec<ReadyRun>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::ready(c, self.owner, self.at, self.after, self.limit, self.cause)
    }
}
struct ReadNextDue(RunOwner, Option<UnixMillis>, ReadyCause);
impl Query for ReadNextDue {
    type Output = Option<UnixMillis>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::next_due(c, self.0, self.1, self.2)
    }
}
struct ReadLatest(String);
impl Query for ReadLatest {
    type Output = Option<RunId>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::latest(c, self.0)
    }
}
struct ReadWork {
    run: RunId,
    offset: u64,
    limit: u32,
}
impl Query for ReadWork {
    type Output = Option<RunObservation>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::work(c, self.run, self.offset, self.limit)
    }
}

enum DriverRead {
    Execute,
    ObserveOriginal,
}
struct ReadDriver {
    claim: DriverClaim,
    access: DriverRead,
}
impl Query for ReadDriver {
    type Output = RunView;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let entries = self
            .claim
            .ticket
            .domain
            .drivers
            .lock()
            .map_err(|_| invalid("poisoned driver domain"))?;
        if !entries
            .get(&self.claim.run())
            .is_some_and(|entry| Weak::ptr_eq(entry, &Arc::downgrade(&self.claim.ticket)))
        {
            return Err(invalid("superseded driver claim"));
        }
        let view = sql::load(c, self.claim.run(), &[], false)?;
        if self.claim.purpose() != DriverPurpose::Business
            || (matches!(self.access, DriverRead::Execute) && view.stopped)
            || view.terminal.is_some()
            || !matches!(view.spec.origin, RunOrigin::Local)
        {
            return Err(invalid("Run is no longer executable"));
        }
        Ok(view)
    }
}

struct ReadModelItems {
    run: RunId,
    attempt: ModelAttemptId,
    after_index: Option<u64>,
    limit: u32,
}
impl Query for ReadModelItems {
    type Output = Vec<RecordedFact>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::model_items(c, self.run, self.attempt, self.after_index, self.limit)
    }
}

struct ObserveArtifacts(Append);
impl Statement for ObserveArtifacts {
    type Value = Commit;
    type Output = Commit;
    const PREPARE_OFF_THREAD: bool = true;
    fn retain(&self) -> Vec<Arc<dyn Send + Sync>> {
        self.0.retain()
    }
    fn prepare(mut self) -> Result<Self, StoreError> {
        self.0.artifacts = self.0.artifacts.prepare()?;
        Ok(self)
    }
    fn execute(self, c: &Connection) -> Result<Prepared<Commit>, StoreError> {
        self.0.execute(c)
    }
    fn committed(value: Commit) -> Commit {
        value
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        Admit::isolated_rejection(error)
    }
}
#[derive(Debug)]
pub enum StopOutcome {
    Inactive,
    AlreadyStopped,
    Requested { latest: bool },
}

pub struct StopRun {
    pub(crate) run: RunId,
    pub(crate) change: Change,
    pub(crate) retract_pending: bool,
}
impl Statement for StopRun {
    type Value = StopOutcome;
    type Output = StopOutcome;
    fn execute(self, c: &Connection) -> Result<Prepared<StopOutcome>, StoreError> {
        if !matches!(self.change.fact, Fact::StopRequested { .. }) {
            return Err(invalid("latest-head control accepts StopRequested only"));
        }
        let view = sql::load(c, self.run, &[], false)?;
        if view.terminal.is_some() || view.stopped {
            return Ok(Prepared {
                value: if view.stopped {
                    StopOutcome::AlreadyStopped
                } else {
                    StopOutcome::Inactive
                },
                changed: false,
                notification: Notification::NONE,
            });
        }
        let latest =
            self.retract_pending && sql::latest(c, view.spec.session_id.clone())? == Some(self.run);
        if latest {
            crate::queue::retract_interactive(c, &view.spec.session_id, &self.change)?;
        }
        let (_, changed) = sql::append(
            c,
            self.run,
            Some(Head::from(&view)),
            &[self.change],
            sql::AppendMaterial {
                contents: Vec::new(),
                artifacts: &Default::default(),
            },
            &Mode::Control,
            None,
        )?;
        Ok(Prepared {
            value: StopOutcome::Requested { latest },
            changed,
            notification: sql::notification(c, self.run, changed)?,
        })
    }
    fn committed(value: StopOutcome) -> StopOutcome {
        value
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        Admit::isolated_rejection(error)
    }
}

#[cfg(test)]
mod stop_tests;
