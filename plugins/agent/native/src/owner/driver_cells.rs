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

use super::{
    Owner, RunAccess,
    driver::{LocalCompletion, PreparedTool},
    now,
};
use asyncband::completion::{self, Completion};
use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use maka_agent_engine::{
    RunError,
    cleanup::Evidence,
    ports::{CellObservation, CellPorts},
};
use maka_agent_facts::{
    artifact::{PublishedArtifact, ToolReturn},
    cells::{
        CellChild, CellEvent, CellId, CellInterruption, CellOwner, CellReturnedResult, CellStatus,
        CellView, CellVmBinding, StoredCellReturn,
    },
    durable::{
        BlockerId, BlockerKind, ContentRef, ExecutionIdentity, Fact, FactId, SCHEMA_VERSION,
        ToolKey, UnixMillis,
    },
    event::ProjectionArtifactWrite,
    tool_call::{RejectionKind, ToolCallIdentity, ToolOrigin, ToolSettlement},
    tool_output::{ToolOutput, ToolSuccess},
    tools::{EffectCustody, ToolCallContext, ToolError, ToolFuture},
};
use maka_agent_state::fold::RunView;
use maka_agent_state::{Change, ContentBlob, Head, cells::CellsStore, fold::tool_key};
use maka_capabilities::call::Identity;
use maka_host_runtime::application::NativeRequest;
use maka_plugin_core::operation::{OperationCleanup, OperationReply, Receipt};
use maka_tools::{
    CellChange, CellContent, CellFuture, CellPersistence, CodeCells, CodeExecutor, ToolCatalog,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    panic::AssertUnwindSafe,
    sync::{Arc, Mutex},
    time::SystemTime,
};
use tokio::sync::oneshot;
use tokio_util::{sync::CancellationToken, task::TaskTracker};
use uuid::Uuid;

/// One physical Run's actual handles. This is not a serialized CellOwner or a recovery grant.
#[derive(Clone)]
pub(super) struct RunCells {
    owner: Arc<Owner>,
    access: Arc<RunAccess>,
    cells: CellsStore,
    state: maka_agent_state::Store,
    pub(super) coordinator: CodeCells,
    executor: CodeExecutor,
    closures: Arc<Mutex<BTreeMap<CellId, PendingVmPublication>>>,
    publications: Arc<Mutex<BTreeMap<FactId, Arc<OriginalPublication>>>>,
    owned: Arc<Mutex<BTreeSet<CellId>>>,
    effects: Arc<Mutex<BTreeMap<(CellId, Uuid), EffectCustody>>>,
    readers: Arc<Mutex<Vec<Arc<NativeRequest>>>>,
    workers: TaskTracker,
    cleanup: Evidence,
}
struct OriginalPublication {
    changes: Vec<Change>,
    contents: Vec<ContentBlob>,
    artifacts: Vec<ProjectionArtifactWrite>,
    admission: bool,
    local: Option<LocalCompletion>,
    settling: tokio::sync::Mutex<PublicationState>,
}
#[derive(Clone)]
enum PublicationOutcome {
    Published { sequence: u64 },
    BusinessFailed { sequence: u64, message: String },
}
impl PublicationOutcome {
    fn sequence(&self) -> u64 {
        match self {
            Self::Published { sequence } | Self::BusinessFailed { sequence, .. } => *sequence,
        }
    }
}
enum PublicationState {
    Pending {
        attempted: bool,
    },
    Rejected {
        publication: Arc<OriginalPublication>,
        message: String,
    },
    Settled(PublicationOutcome),
}
struct PendingVmPublication {
    original: Arc<VmPublication>,
    result: Completion<Result<(), ToolError>>,
}
struct VmPublication {
    cell: CellId,
    owner: CellOwner,
    vm: Option<CellVmBinding>,
    proof: maka_code_runtime::RuntimeVmGoneProof,
    id: FactId,
    at: UnixMillis,
    batch: Mutex<Option<(Change, ContentBlob)>>,
}
impl RunCells {
    #[cfg(test)]
    pub(super) fn retain_vm_for_test(&self, cell: CellId) {
        self.owned.lock().unwrap().insert(cell);
    }

    pub(super) fn new(
        owner: Arc<Owner>,
        access: Arc<RunAccess>,
        executor: CodeExecutor,
        workers: TaskTracker,
        cleanup: Evidence,
    ) -> Result<Arc<Self>, ToolError> {
        owner
            .store
            .session_for_work(access.custody().as_ref(), &access.execution().session_id)
            .map_err(persistence)?;
        if access.spec().owner != owner.run_owner() {
            return Err(persistence(
                "Cell Run owner differs from the actual Native owner",
            ));
        }
        let data = owner
            .store
            .data_writer_for_work(access.custody().as_ref(), &access.execution().session_id)
            .map_err(persistence)?;
        let state = owner
            .durable
            .with_data_writer(data.clone())
            .map_err(persistence)?;
        let cells = CellsStore::new(data);
        let reader = cells.reader(
            access.execution().session_id.clone(),
            tokio::runtime::Handle::current(),
        );
        let coordinator =
            CodeCells::new(executor.clone(), maka_code_runtime::CellStore::new(reader));
        Ok(Arc::new(Self {
            owner,
            access,
            cells,
            state,
            coordinator,
            executor,
            closures: Arc::default(),
            publications: Arc::default(),
            owned: Arc::default(),
            effects: Arc::default(),
            readers: Arc::default(),
            workers,
            cleanup,
        }))
    }
    pub(super) fn physical_changes(
        &self,
    ) -> (
        tokio::sync::watch::Receiver<()>,
        tokio::sync::watch::Receiver<()>,
        tokio::sync::watch::Receiver<()>,
    ) {
        let (javascript, python) = self.executor.physical_changes();
        (javascript, python, self.coordinator.physical_changes())
    }
    pub(super) fn has_original_workers(&self) -> bool {
        !self.workers.is_empty()
    }
    pub(super) async fn original_cleanup_confirmed(&self) -> Result<bool, RunError> {
        // Shutdown joins the original coordinator tasks; its historical error is not positive or negative cleanup truth.
        let _shutdown = self.coordinator.shutdown().await;
        if !self.coordinator.is_idle() || !self.workers.is_empty() {
            return Ok(false);
        }
        let publications: Vec<_> = self
            .publications
            .lock()
            .map_err(|e| RunError::Tool(persistence(e)))?
            .values()
            .cloned()
            .collect();
        for original in publications {
            if original.admission {
                let _settling = original.settling.lock().await;
                // This caller has ended. A barrier-confirmed absent T1 must not be revived as fresh permission.
                self.observe_original(&original.changes)
                    .await
                    .map_err(RunError::Tool)?;
                self.release_publication(&original)
                    .map_err(RunError::Tool)?;
            } else {
                self.settle_publication(&original)
                    .await
                    .map_err(RunError::Tool)?;
            }
        }
        let closures: Vec<_> = self
            .closures
            .lock()
            .map_err(|e| RunError::Tool(persistence(e)))?
            .values()
            .map(|entry| entry.original.clone())
            .collect();
        for original in closures {
            self.publish_vm_gone(&original)
                .await
                .map_err(RunError::Tool)?;
            self.executor.release_binding(original.proof.binding());
            self.closures
                .lock()
                .map_err(|e| RunError::Tool(persistence(e)))?
                .remove(&original.cell);
        }
        self.finish_readers().await.map_err(RunError::Tool)?;
        let owned: Vec<_> = self
            .owned
            .lock()
            .map_err(|error| RunError::Tool(persistence(error)))?
            .iter()
            .copied()
            .collect();
        for cell in owned {
            let Some(current) = self
                .cells
                .read(&self.access.execution().session_id, cell)
                .await
                .map_err(|error| RunError::Tool(persistence(error)))?
            else {
                // Actual VM creation is after Started ACK. Only the original writer can prove this attempt never started.
                let original = self
                    .state
                    .publication(
                        self.access.execution().run_id,
                        vec![cell.started_fact_id()],
                        None,
                    )
                    .await
                    .map_err(|error| RunError::Tool(persistence(error)))?;
                if !original.facts.is_empty() {
                    return Err(RunError::InvalidInput(
                        "Original Cell projection is unavailable".into(),
                    ));
                }
                self.owned
                    .lock()
                    .map_err(|error| RunError::Tool(persistence(error)))?
                    .remove(&cell);
                continue;
            };
            if current.owner.run() != Some(self.access.execution().run_id) {
                return Err(RunError::InvalidInput(
                    "Cell cleanup differs from its original Run".into(),
                ));
            }
            for (operation, child) in &current.children {
                if child.admitted && !child.physical_cleanup_confirmed() {
                    self.recover_child(cell, *operation, child)
                        .await
                        .map_err(RunError::Tool)?;
                }
            }
            let current = self
                .cells
                .read(&self.access.execution().session_id, cell)
                .await
                .map_err(|error| RunError::Tool(persistence(error)))?
                .ok_or_else(|| {
                    RunError::InvalidInput("Original Cell cleanup projection is unavailable".into())
                })?;
            if !self
                .observe_vm_closure(&current)
                .await
                .map_err(RunError::Tool)?
            {
                return Ok(false);
            }
            let closed = self
                .cells
                .read(&self.access.execution().session_id, cell)
                .await
                .map_err(|error| RunError::Tool(persistence(error)))?
                .ok_or_else(|| {
                    RunError::InvalidInput("Original Cell closure projection is unavailable".into())
                })?;
            if !closed.physical_cleanup_confirmed() {
                return Ok(false);
            }
            for operation in closed.children.keys() {
                self.release_child_if_confirmed(cell, *operation)
                    .await
                    .map_err(RunError::Tool)?;
            }
            self.owned
                .lock()
                .map_err(|error| RunError::Tool(persistence(error)))?
                .remove(&cell);
        }
        let publications = self
            .publications
            .lock()
            .map_err(|error| RunError::Tool(persistence(error)))?
            .is_empty();
        let closures = self
            .closures
            .lock()
            .map_err(|error| RunError::Tool(persistence(error)))?
            .is_empty();
        let effects = self
            .effects
            .lock()
            .map_err(|error| RunError::Tool(persistence(error)))?
            .is_empty();
        let readers = self
            .readers
            .lock()
            .map_err(|error| RunError::Tool(persistence(error)))?
            .is_empty();
        Ok(publications && closures && effects && readers)
    }
    pub(super) async fn prepare(
        self: &Arc<Self>,
        parent: ToolCallContext,
        name: &str,
        input: &Value,
        catalog: ToolCatalog,
        cancellation: CancellationToken,
        steering: CancellationToken,
    ) -> Result<
        (
            maka_agent_facts::tools::PreparedEffect,
            super::driver::DispatchSource,
        ),
        maka_agent_facts::tool_call::ToolRejection,
    > {
        let port = NativeCellPort::new(self.clone(), parent)
            .await
            .map_err(
                |error| maka_agent_facts::tool_call::ToolRejection::PreparationFailed {
                    message: error.to_string(),
                },
            )?;
        let effect =
            self.coordinator
                .prepare(name, input, catalog, port.clone(), cancellation, steering)?;
        let source = if name == "wait" {
            super::driver::DispatchSource::CellWait(OwnedCellWait { port })
        } else {
            super::driver::DispatchSource::Ordinary
        };
        Ok((effect, source))
    }
    pub(super) async fn prepare_external(
        self: &Arc<Self>,
        context: ToolCallContext,
        name: &str,
        input: &Value,
        catalog: ToolCatalog,
        cancellation: CancellationToken,
    ) -> Result<maka_agent_facts::tools::PreparedEffect, maka_agent_facts::tool_call::ToolRejection>
    {
        let port = NativeCellPort::new(self.clone(), context)
            .await
            .map_err(
                |error| maka_agent_facts::tool_call::ToolRejection::PreparationFailed {
                    message: error.to_string(),
                },
            )?;
        self.coordinator.prepare(
            name,
            input,
            catalog,
            port,
            cancellation,
            CancellationToken::new(),
        )
    }
    fn now(&self) -> UnixMillis {
        UnixMillis(now().try_into().expect("Unix milliseconds"))
    }
    fn check_work(&self) -> Result<(), ToolError> {
        self.owner
            .store
            .session_for_work(
                self.access.custody().as_ref(),
                &self.access.execution().session_id,
            )
            .map_err(persistence)?;
        Ok(())
    }
    fn retain_publication(
        &self,
        changes: Vec<Change>,
        contents: Vec<ContentBlob>,
        artifacts: Vec<ProjectionArtifactWrite>,
        admission: bool,
        local: Option<LocalCompletion>,
    ) -> Result<Arc<OriginalPublication>, ToolError> {
        let key = changes
            .first()
            .ok_or_else(|| persistence("Empty original Cell publication"))?
            .id;
        let mut pending = self.publications.lock().map_err(persistence)?;
        if let Some(original) = pending.get(&key) {
            if original.admission != admission
                || original.changes.len() != changes.len()
                || original
                    .changes
                    .iter()
                    .zip(&changes)
                    .any(|(a, b)| a.id != b.id || a.at != b.at || a.fact != b.fact)
            {
                return Err(persistence("Original Cell publication identity conflicts"));
            }
            return Ok(original.clone());
        }
        let original = Arc::new(OriginalPublication {
            changes,
            contents,
            artifacts,
            admission,
            local,
            settling: tokio::sync::Mutex::new(PublicationState::Pending {
                attempted: admission,
            }),
        });
        pending.insert(key, original.clone());
        Ok(original)
    }
    fn release_publication(&self, original: &OriginalPublication) -> Result<(), ToolError> {
        self.publications
            .lock()
            .map_err(persistence)?
            .remove(&original.changes[0].id);
        Ok(())
    }
    async fn publish(
        &self,
        changes: Vec<Change>,
        contents: Vec<ContentBlob>,
        artifacts: Vec<ProjectionArtifactWrite>,
    ) -> Result<u64, ToolError> {
        let original = self.retain_publication(changes, contents, artifacts, false, None)?;
        match self.settle_publication(&original).await? {
            PublicationOutcome::Published { sequence } => Ok(sequence),
            PublicationOutcome::BusinessFailed { message, .. } => Err(ToolError::Failed(message)),
        }
    }
    async fn settle_publication(
        &self,
        original: &OriginalPublication,
    ) -> Result<PublicationOutcome, ToolError> {
        let mut settling = original.settling.lock().await;
        loop {
            match &*settling {
                PublicationState::Settled(outcome) => {
                    let outcome = outcome.clone();
                    self.release_publication(original)?;
                    return Ok(outcome);
                }
                PublicationState::Rejected {
                    publication,
                    message,
                } => {
                    let sequence = Box::pin(self.settle_publication(publication))
                        .await?
                        .sequence();
                    let outcome = PublicationOutcome::BusinessFailed {
                        sequence,
                        message: message.clone(),
                    };
                    *settling = PublicationState::Settled(outcome.clone());
                    self.release_publication(original)?;
                    return Ok(outcome);
                }
                PublicationState::Pending { attempted: true } => {
                    if let Some(sequence) = self.observe_original(&original.changes).await? {
                        let outcome = PublicationOutcome::Published { sequence };
                        *settling = PublicationState::Settled(outcome.clone());
                        self.release_publication(original)?;
                        return Ok(outcome);
                    }
                }
                PublicationState::Pending { attempted: false } => {}
            }
            if original.admission {
                return Err(persistence(
                    "An ended Cell observer cannot re-admit original work",
                ));
            }
            // A previous attempt is retried only after its original FIFO proved no commit.
            *settling = PublicationState::Pending { attempted: true };
            let committed = match &original.local {
                Some(local) => {
                    local
                        .publish(
                            &self.state,
                            &self.access,
                            &original.changes[0],
                            &original.contents,
                            &original.artifacts,
                        )
                        .await
                }
                None => {
                    self.state
                        .observe_artifacts(
                            self.access.execution().run_id,
                            original.changes.clone(),
                            original.contents.clone(),
                            original.artifacts.clone(),
                        )
                        .await
                }
            };
            match committed {
                Ok(commit) => {
                    let outcome = PublicationOutcome::Published {
                        sequence: commit.head.revision,
                    };
                    *settling = PublicationState::Settled(outcome.clone());
                    self.release_publication(original)?;
                    return Ok(outcome);
                }
                Err(error)
                    if matches!(
                        error.underlying(),
                        maka_event_log::StoreError::CommitUnknown(_)
                            | maka_event_log::StoreError::OperationUnknown
                    ) => {}
                Err(error)
                    if original
                        .local
                        .as_ref()
                        .is_some_and(|local| local.rejected(&error)) =>
                {
                    let Fact::Cell {
                        event:
                            CellEvent::LocalChildReturned {
                                cell, operation, ..
                            },
                    } = &original.changes[0].fact
                    else {
                        return Err(persistence(
                            "Local business publication has no original Cell child",
                        ));
                    };
                    let message = error.to_string();
                    let result = ContentBlob::json(&ToolReturn {
                        schema_version: SCHEMA_VERSION,
                        artifacts: vec![],
                        body: CellReturnedResult {
                            output: ToolOutput::Text(message.clone()),
                            projection: Some(
                                maka_agent_facts::tool_output::DurableToolProjection::Text {
                                    text: message.clone(),
                                },
                            ),
                            is_error: true,
                        },
                    })
                    .map_err(persistence)?;
                    let failure = Change::new(
                        Fact::Cell {
                            event: CellEvent::LocalChildReturned {
                                cell: *cell,
                                operation: *operation,
                                result: result.reference().clone(),
                                is_error: true,
                                settlement: ToolSettlement::Failed,
                            },
                        },
                        UnixMillis(now().try_into().expect("Unix milliseconds")),
                    );
                    let publication =
                        self.retain_publication(vec![failure], vec![result], vec![], false, None)?;
                    *settling = PublicationState::Rejected {
                        publication,
                        message,
                    };
                }
                Err(error) => return Err(persistence(error)),
            }
        }
    }
    async fn observe_original(&self, changes: &[Change]) -> Result<Option<u64>, ToolError> {
        let observed = self
            .state
            .publication(
                self.access.execution().run_id,
                changes.iter().map(|change| change.id).collect(),
                None,
            )
            .await
            .map_err(persistence)?;
        if observed.facts.is_empty() {
            return Ok(None);
        }
        if observed.facts.len() != changes.len() {
            return Err(persistence(maka_event_log::StoreError::EventConflict));
        }
        let mut revision = 0;
        for (change, recorded) in changes.iter().zip(&observed.facts) {
            if recorded.run != self.access.execution().run_id
                || recorded.id != change.id
                || recorded.schema_version != SCHEMA_VERSION
                || recorded.at != change.at
                || recorded.fact != change.fact
            {
                return Err(persistence(maka_event_log::StoreError::EventConflict));
            }
            revision = revision.max(recorded.revision);
        }
        Ok(Some(revision))
    }
    async fn record_reply(
        &self,
        cell: CellId,
        operation: Uuid,
        reply: OperationReply,
    ) -> Result<(), ToolError> {
        let current = self
            .cells
            .read(&self.access.execution().session_id, cell)
            .await
            .map_err(persistence)?
            .ok_or_else(|| persistence("Cell not recorded"))?;
        let child = current
            .children
            .get(&operation)
            .ok_or_else(|| persistence("Cell child not recorded"))?;
        let (reply, material) = maka_agent_state::operation::prepare_reply(reply)
            .await
            .map_err(persistence)?;
        if child.reference.as_ref() == Some(&reply.reference)
            && child.reply.as_ref() == Some(&reply)
        {
            return Ok(());
        }
        let at = self.now();
        let mut changes = Vec::new();
        if child.reference.is_none() {
            changes.push(Change::new(
                Fact::Cell {
                    event: CellEvent::ChildBound {
                        cell,
                        operation,
                        reference: reply.reference.clone(),
                    },
                },
                at,
            ));
        }
        changes.push(Change::new(
            Fact::Cell {
                event: CellEvent::ChildObserved {
                    cell,
                    operation,
                    reply,
                },
            },
            at,
        ));
        self.publish(changes, material.into_iter().collect(), vec![])
            .await?;
        Ok(())
    }
    /// Observation always uses the actual current scope. A historical operation
    /// UUID selects an original CallerIntent, never permission for fresh dispatch.
    async fn finish_readers(&self) -> Result<(), ToolError> {
        let readers = self.readers.lock().map_err(persistence)?.clone();
        for reader in readers {
            reader
                .finish()
                .await
                .map_err(ToolError::CleanupUnconfirmed)?;
            self.readers
                .lock()
                .map_err(persistence)?
                .retain(|original| !Arc::ptr_eq(original, &reader));
        }
        Ok(())
    }
    async fn release_child_if_confirmed(
        &self,
        cell: CellId,
        operation: Uuid,
    ) -> Result<(), ToolError> {
        let current = self
            .cells
            .read(&self.access.execution().session_id, cell)
            .await
            .map_err(persistence)?
            .ok_or_else(|| persistence("Original Cell effect projection is unavailable"))?;
        let child = current
            .children
            .get(&operation)
            .ok_or_else(|| persistence("Original Cell child disappeared"))?;
        if child.physical_cleanup_confirmed() {
            let custody = self
                .effects
                .lock()
                .map_err(persistence)?
                .remove(&(cell, operation));
            drop(custody);
        }
        Ok(())
    }
    async fn recover_child(
        &self,
        cell: CellId,
        operation: Uuid,
        child: &CellChild,
    ) -> Result<Option<OperationReply>, ToolError> {
        self.finish_readers().await?;
        self.check_work()?;
        let execution = self.access.execution();
        let view = self
            .state
            .frontier(execution.run_id)
            .await
            .map_err(persistence)?;
        if view.run != execution.run_id
            || view.spec != *self.access.spec()
            || view.spec.session_id != execution.session_id
            || view.spec.turn_id != execution.turn_id
            || view.spec.owner != self.owner.run_owner()
        {
            return Err(ToolError::OutcomeUnknown(
                "Cell recovery differs from the original actual Run".into(),
            ));
        }
        let canonical = self
            .cells
            .read(&execution.session_id, cell)
            .await
            .map_err(persistence)?
            .ok_or_else(|| ToolError::OutcomeUnknown("Original Cell is unavailable".into()))?;
        if canonical.id != cell
            || canonical.owner.run() != Some(execution.run_id)
            || canonical.owner.cell_id() != Some(cell)
        {
            return Err(ToolError::OutcomeUnknown(
                "Cell owner belongs to another original Run".into(),
            ));
        }
        let original = canonical.children.get(&operation).ok_or_else(|| {
            ToolError::OutcomeUnknown("Original admitted Cell child is unavailable".into())
        })?;
        if !original.admitted
            || original.rejected.is_some()
            || !child.admitted
            || child.rejected.is_some()
            || original.name != child.name
            || original.semantics != child.semantics
            || original.input != child.input
            || original.resources != child.resources
            || child
                .reference
                .as_ref()
                .is_some_and(|reference| original.reference.as_ref() != Some(reference))
        {
            return Err(ToolError::OutcomeUnknown(
                "Cell recovery differs from its canonical child".into(),
            ));
        }
        let child = original;
        let bytes = self
            .state
            .content(execution.run_id, self.access.spec().tool_selection.clone())
            .await
            .map_err(persistence)?;
        let selection: crate::tools::SelectionSnapshot =
            serde_json::from_slice(&bytes).map_err(persistence)?;
        let selected = selection
            .selected_service(&self.owner.services, &self.owner.tool_basis, &child.name)
            .map_err(ToolError::OutcomeUnknown)?
            .ok_or_else(|| {
                ToolError::OutcomeUnknown(
                    "Cell child has no original selected native service".into(),
                )
            })?;
        let operation_id = child_operation(cell, operation);
        let request = Arc::new(
            selected
                .1
                .request_with_work(
                    Identity::Agent {
                        execution: execution.clone(),
                        operation_id: Some(operation_id.clone()),
                    },
                    self.owner.stop.child_token(),
                    self.access.custody().clone(),
                )
                .map_err(ToolError::Failed)?,
        );
        self.readers
            .lock()
            .map_err(persistence)?
            .push(request.clone());
        let result = async {
            let id = crate::tools::operation_uuid(execution, &operation_id);
            let intent = request
                .lookup_intent(id)
                .map_err(persistence)?
                .await
                .map_err(persistence)?
                .ok_or_else(|| {
                    ToolError::OutcomeUnknown("Original Cell CallerIntent is unavailable".into())
                })?;
            if intent.reference.operation != id
                || child
                    .reference
                    .as_ref()
                    .is_some_and(|reference| reference != &intent.reference)
                || child
                    .reply
                    .as_ref()
                    .is_some_and(|reply| reply.reference != intent.reference)
            {
                return Err(ToolError::OutcomeUnknown(
                    "Cell CallerIntent differs from its canonical child reference".into(),
                ));
            }
            selection
                .validate_recovery_service(
                    &self.owner.services,
                    &self.owner.tool_basis,
                    &intent,
                    execution,
                    &operation_id,
                    &selected,
                )
                .map_err(ToolError::OutcomeUnknown)?;
            let reference = intent.reference;
            let receipt = match request
                .recover(reference.clone())
                .map_err(persistence)?
                .await
                .map_err(persistence)?
            {
                Some(observation) => Receipt::Recorded {
                    outcome: observation.outcome,
                    cleanup: observation.cleanup,
                },
                None if child.reply.is_some() => return Ok(None),
                None => Receipt::NotRecorded,
            };
            Ok(Some(OperationReply { reference, receipt }))
        }
        .await;
        let cleanup = request.finish().await;
        if cleanup.is_ok() {
            self.readers
                .lock()
                .map_err(persistence)?
                .retain(|original| !Arc::ptr_eq(original, &request));
        }
        if let Ok(Some(reply)) = &result {
            self.record_reply(cell, operation, reply.clone()).await?;
        }
        if let Err(error) = cleanup {
            return Err(ToolError::CleanupUnconfirmed(format!(
                "Cell observation cleanup: {error}; original observation: {}",
                result
                    .as_ref()
                    .err()
                    .map_or("recorded".into(), ToString::to_string)
            )));
        }
        result
    }
    async fn child_result(&self, cell: CellId, child: &CellChild) -> Result<ToolOutput, ToolError> {
        if child
            .local_result
            .as_ref()
            .is_some_and(|result| result.settlement == ToolSettlement::Unknown)
        {
            return Err(ToolError::OutcomeUnknown(
                "Original local Cell result remains unknown".into(),
            ));
        }
        if let Some(rejected) = &child.rejected {
            return Err(ToolError::Failed(rejected.diagnostic.clone()));
        }
        if let Some(result) = child
            .provider_result
            .as_ref()
            .or(child.local_result.as_ref())
        {
            let bytes = self
                .cells
                .content(
                    &self.access.execution().session_id,
                    cell,
                    result.result.clone(),
                )
                .await
                .map_err(persistence)?;
            let returned: ToolReturn<StoredCellReturn> =
                tokio::task::spawn_blocking(move || serde_json::from_slice(&bytes))
                    .await
                    .map_err(persistence)?
                    .map_err(persistence)?;
            returned.validate().map_err(persistence)?;
            if child.provider_result.is_none() {
                let StoredCellReturn::Inline(body) = returned.body else {
                    return Err(persistence(
                        "local Cell return cannot contain a Host operation",
                    ));
                };
                return output(body.output, body.is_error);
            }
            if child.reply.is_none() {
                return Err(persistence("Cell Host result lost original receipt"));
            }
        }
        if let Some(reply) = &child.reply {
            let reply = self
                .cells
                .operation_reply(&self.access.execution().session_id, cell, reply.clone())
                .await
                .map_err(persistence)?;
            return operation_output(reply);
        }
        Err(ToolError::OutcomeUnknown(
            "Original Cell child has no recorded outcome; it will not be resent".into(),
        ))
    }
    async fn quarantine(&self, cell: CellId) -> Result<(), ToolError> {
        let current = self
            .cells
            .read(&self.access.execution().session_id, cell)
            .await
            .map_err(persistence)?;
        // No new Cell/child was admitted when preparation failed before Started.
        let Some(current) = current else {
            return Ok(());
        };
        if current.owner.run() != Some(self.access.execution().run_id) {
            return Err(persistence("Cell quarantine belongs to another actual Run"));
        }
        let identity = |kind: &str| -> Uuid {
            let digest = Sha256::digest(
                serde_json::to_vec(&(
                    "maka.cell-quarantine.v1",
                    kind,
                    self.access.execution().run_id,
                    cell,
                ))
                .expect("Cell quarantine identity"),
            );
            Uuid::from_bytes(digest[..16].try_into().expect("SHA256 prefix"))
        };
        let blocker = BlockerId::try_from(identity("blocker")).map_err(persistence)?;
        let id = FactId::try_from(identity("fact")).map_err(persistence)?;
        let fact = Fact::Blocked {
            blocker,
            reason: BlockerKind::CodeCellRecoveryUnavailable {
                cell: cell.to_string(),
            },
        };
        let change = Change {
            id,
            at: self.now(),
            fact,
        };
        loop {
            // A risk decision never permits this old script to resume; nor may
            // its late observer reintroduce a second blocker for the same Cell.
            if let Some(original) = self
                .state
                .fact(self.access.execution().run_id, id)
                .await
                .map_err(persistence)?
            {
                if original.fact != change.fact {
                    return Err(persistence("Cell quarantine identity conflict"));
                }
                return Ok(());
            }
            let view = self.access.fresh().await.map_err(persistence)?;
            if view.terminal.is_some() {
                return Ok(());
            }
            match self
                .state
                .append(
                    self.access.claim(),
                    Head::from(&view),
                    vec![change.clone()],
                    vec![],
                )
                .await
            {
                Ok(_) => return Ok(()),
                Err(error)
                    if matches!(
                        error.underlying(),
                        maka_event_log::StoreError::RevisionConflict { .. }
                    ) =>
                {
                    continue;
                }
                Err(error)
                    if matches!(
                        error.underlying(),
                        maka_event_log::StoreError::CommitUnknown(_)
                            | maka_event_log::StoreError::OperationUnknown
                    ) =>
                {
                    let original =
                        self.retain_publication(vec![change.clone()], vec![], vec![], true, None)?;
                    match self.observe_original(&original.changes).await? {
                        Some(_) => {
                            self.release_publication(&original)?;
                            return Ok(());
                        }
                        None => {
                            self.release_publication(&original)?;
                            continue;
                        }
                    }
                }
                Err(error) => return Err(persistence(error)),
            }
        }
    }
    fn pending_vm_publication(
        &self,
        cell: CellId,
    ) -> Result<Option<Completion<Result<(), ToolError>>>, ToolError> {
        Ok(self
            .closures
            .lock()
            .map_err(persistence)?
            .get(&cell)
            .map(|pending| pending.result.clone()))
    }
    async fn record_vm_gone(
        &self,
        cell: &CellView,
        binding: &maka_code_runtime::VmBinding,
        proof: maka_code_runtime::RuntimeVmGoneProof,
    ) -> Result<(), ToolError> {
        if proof.binding().runtime != binding.runtime
            || proof.binding().version != binding.version
            || proof.binding().descriptor != binding.descriptor
        {
            return Err(persistence(
                "VM closure proof differs from the original binding",
            ));
        }
        let result = {
            let mut pending = self.closures.lock().map_err(persistence)?;
            match pending.entry(cell.id) {
                std::collections::btree_map::Entry::Occupied(entry) => {
                    if entry.get().original.vm != cell.vm {
                        return Err(persistence("Pending VM closure binding changed"));
                    }
                    entry.get().result.clone()
                }
                std::collections::btree_map::Entry::Vacant(entry) => {
                    let original = Arc::new(VmPublication {
                        cell: cell.id,
                        owner: cell.owner.clone(),
                        vm: cell.vm.clone(),
                        proof,
                        id: FactId::new(),
                        at: self.now(),
                        batch: Mutex::new(None),
                    });
                    let (complete, result) = completion::new();
                    entry.insert(PendingVmPublication {
                        original: original.clone(),
                        result: result.clone(),
                    });
                    let run = self.clone();
                    self.workers.spawn(async move {
                        let outcome = AssertUnwindSafe(run.publish_vm_gone(&original))
                            .catch_unwind()
                            .await
                            .unwrap_or_else(|_| {
                                Err(ToolError::CleanupUnconfirmed("Original VM publication worker panicked".into()))
                            });
                        if outcome.is_ok() {
                            run.executor.release_binding(original.proof.binding());
                            match run.closures.lock() {
                                Ok(mut pending) => { pending.remove(&original.cell); }
                                Err(error) => tracing::error!(%error, cell = %original.cell, "Confirmed VM publication bookkeeping is poisoned"),
                            }
                        } else if let Err(error) = &outcome {
                            run.cleanup.observe_tool(error);
                        }
                        let _ = complete.complete(outcome);
                    });
                    result
                }
            }
        };
        result
            .wait()
            .await
            .map_err(|_| {
                ToolError::CleanupUnconfirmed("Original VM publication worker disappeared".into())
            })?
            .clone()
    }
    async fn publish_vm_gone(&self, original: &VmPublication) -> Result<(), ToolError> {
        let current = self
            .cells
            .read(&self.access.execution().session_id, original.cell)
            .await
            .map_err(persistence)?
            .ok_or_else(|| persistence("Original Cell disappeared"))?;
        if current.owner != original.owner || current.vm != original.vm {
            return Err(persistence(
                "Original VM descriptor changed before closure publication",
            ));
        }
        let retained = original.batch.lock().map_err(persistence)?.clone();
        if let Some((change, blob)) = retained {
            if self
                .observe_original(std::slice::from_ref(&change))
                .await?
                .is_none()
            {
                self.publish(vec![change], vec![blob], vec![]).await?;
            }
            return Ok(());
        }
        let mut snapshot: Option<CellView> = None;
        loop {
            let current = self
                .state
                .original_driver_frontier(self.access.claim())
                .await
                .map_err(persistence)?;
            let cell = self
                .cells
                .read(&self.access.execution().session_id, original.cell)
                .await
                .map_err(persistence)?
                .ok_or_else(|| persistence("Original Cell disappeared"))?;
            if cell.vm != original.vm || cell.owner != original.owner {
                return Err(persistence(
                    "Original VM descriptor changed before closure publication",
                ));
            }
            if !matches!(cell.status, CellStatus::Running) {
                return Ok(());
            }
            if snapshot
                .as_ref()
                .is_none_or(|prior| prior.children != cell.children)
            {
                let witness = match original.proof.process() {
                    Some(process) => format!("process is confirmed gone: {:?}", process.identity()),
                    None => "original VM was dropped and its actual worker thread joined".into(),
                };
                let report = CellInterruption {
                    cell: cell.id,
                    diagnostic: format!(
                        "Original VM closure confirmed; runtime={} version={}: {witness}",
                        original.proof.binding().runtime,
                        original.proof.binding().version
                    ),
                    children: cell.children.clone(),
                    prior_output: None,
                };
                let blob = tokio::task::spawn_blocking(move || ContentBlob::json(&report))
                    .await
                    .map_err(persistence)?
                    .map_err(persistence)?;
                let change = Change {
                    id: original.id,
                    at: original.at,
                    fact: Fact::Cell {
                        event: CellEvent::Interrupted {
                            cell: cell.id,
                            report: blob.reference().clone(),
                        },
                    },
                };
                *original.batch.lock().map_err(persistence)? = Some((change, blob));
                snapshot = Some(cell);
            }
            let (change, blob) = original
                .batch
                .lock()
                .map_err(persistence)?
                .as_ref()
                .ok_or_else(|| persistence("Original VM publication was not prepared"))?
                .clone();
            match self
                .state
                .append(
                    self.access.claim(),
                    Head::from(&current),
                    vec![change.clone()],
                    vec![blob],
                )
                .await
            {
                Ok(_) => return Ok(()),
                // This rejection proves no write. Only its not-yet-admitted
                // child snapshot may advance; the original identity/time stay.
                Err(error)
                    if matches!(
                        error.underlying(),
                        maka_event_log::StoreError::RevisionConflict { .. }
                    ) =>
                {
                    continue;
                }
                Err(error)
                    if matches!(
                        error.underlying(),
                        maka_event_log::StoreError::CommitUnknown(_)
                            | maka_event_log::StoreError::OperationUnknown
                    ) =>
                {
                    match self.observe_original(std::slice::from_ref(&change)).await? {
                        Some(_) => return Ok(()),
                        None => continue,
                    }
                }
                Err(error) => return Err(persistence(error)),
            }
        }
    }
    async fn observe_vm_closure(&self, canonical: &CellView) -> Result<bool, ToolError> {
        if canonical.owner.run() != Some(self.access.execution().run_id) {
            return Err(persistence("Original VM observer belongs to another Run"));
        }
        if self.coordinator.has_live(canonical.id) {
            return Ok(false);
        }
        if !matches!(canonical.status, CellStatus::Running) {
            return Ok(canonical.vm_uncertainty.is_none());
        }
        if let Some(pending) = self.pending_vm_publication(canonical.id)? {
            pending
                .wait()
                .await
                .map_err(|_| {
                    ToolError::CleanupUnconfirmed(
                        "Original VM publication worker disappeared".into(),
                    )
                })?
                .clone()?;
            return Ok(true);
        }
        let Some(vm) = &canonical.vm else {
            return Ok(false);
        };
        let bytes = self
            .cells
            .content(
                &self.access.execution().session_id,
                canonical.id,
                vm.descriptor.clone(),
            )
            .await
            .map_err(persistence)?;
        let descriptor: Value = match tokio::task::spawn_blocking(move || {
            serde_json::from_slice(&bytes)
        })
        .await
        .map_err(persistence)?
        {
            Ok(value) => value,
            Err(error) => {
                tracing::warn!(cell=%canonical.id,%error,"Original Cell VM descriptor cannot be decoded");
                return Ok(false);
            }
        };
        let binding = maka_code_runtime::VmBinding {
            runtime: vm.runtime.clone(),
            version: vm.version,
            descriptor,
        };
        match self.executor.observe_binding(&binding).await {
            maka_code_runtime::RuntimeVmObservation::Gone(proof) => {
                self.record_vm_gone(canonical, &binding, proof).await?;
                Ok(true)
            }
            maka_code_runtime::RuntimeVmObservation::Alive => Ok(false),
            maka_code_runtime::RuntimeVmObservation::Unobservable { diagnostic } => {
                tracing::warn!(cell=%canonical.id,%diagnostic,"Original Cell VM lifetime is unobservable");
                Ok(false)
            }
        }
    }
    async fn read_current(&self, cell: CellId) -> Result<Option<CellView>, ToolError> {
        self.check_work()?;
        let Some(view) = self
            .cells
            .read(&self.access.execution().session_id, cell)
            .await
            .map_err(persistence)?
        else {
            return Ok(None);
        };
        if self.coordinator.has_live(cell) {
            return Ok(Some(view));
        }
        if view.owner.run() == Some(self.access.execution().run_id) {
            for (operation, child) in &view.children {
                if needs_observation(child) {
                    self.recover_child(cell, *operation, child).await?;
                }
            }
            return self
                .cells
                .read(&self.access.execution().session_id, cell)
                .await
                .map_err(persistence);
        }
        Ok(Some(view))
    }
}

#[derive(Clone)]
pub(super) struct NativeCellPort {
    run: Arc<RunCells>,
    parent: ToolCallContext,
    owner: CellOwner,
    admission_closed: CancellationToken,
    observed_cell: Arc<std::sync::OnceLock<CellId>>,
}

pub(super) struct OwnedCellWait {
    port: Arc<NativeCellPort>,
}
impl OwnedCellWait {
    pub(super) async fn settlement(
        &self,
        access: &Arc<RunAccess>,
        key: &ToolKey,
        cells_cleanup_confirmed: bool,
    ) -> Result<Option<ToolSettlement>, RunError> {
        if !Arc::ptr_eq(access, &self.port.run.access)
            || self.port.parent.execution != *access.execution()
            || self
                .port
                .parent
                .custody
                .as_ref()
                .is_none_or(|custody| !Arc::ptr_eq(custody, access.custody()))
            || self.port.parent.call.tool_call_id != key.call
            || !matches!(&self.port.owner, CellOwner::Agent { link, .. }
                if link.run == access.execution().run_id && link.attempt == key.attempt)
            || self.port.parent.operation_id != format!("{}:{}", key.attempt, key.call)
        {
            return Err(RunError::InvalidInput(
                "Cell wait source differs from its original control".into(),
            ));
        }
        if !cells_cleanup_confirmed {
            return Ok(None);
        }
        self.port.run.check_work().map_err(RunError::Tool)?;
        let view = self
            .port
            .run
            .state
            .frontier(access.execution().run_id)
            .await?;
        if view.run != access.execution().run_id
            || view.spec != *access.spec()
            || view.spec.session_id != access.execution().session_id
            || view.spec.turn_id != access.execution().turn_id
            || view.attempts.get(&key.attempt).is_none_or(|attempt| {
                !matches!(&self.port.owner,
                    CellOwner::Agent { link, .. } if attempt.step == link.step)
            })
        {
            return Err(RunError::InvalidInput(
                "Cell wait observation differs from its original Run".into(),
            ));
        }
        let tool = view
            .tools
            .get(&tool_key(key))
            .ok_or_else(|| RunError::InvalidInput("Original Cell wait is unavailable".into()))?;
        if tool.key != *key
            || tool.call.id != key.call
            || !tool.admitted
            || tool.original.is_some()
            || tool.call.provider_executed
        {
            return Err(RunError::InvalidInput(
                "Cell wait has a different original admission".into(),
            ));
        }
        let Some(cell) = self.port.observed_cell.get().copied() else {
            // This actual prepared wait has returned, and never entered its port.
            // Wait cannot create a VM; no claim is made about any other Cell.
            return Ok(Some(ToolSettlement::Failed));
        };
        let canonical = self
            .port
            .run
            .cells
            .read(&access.execution().session_id, cell)
            .await?;
        Ok(Some(match canonical {
            Some(cell)
                if !matches!(cell.status, CellStatus::Running)
                    && cell.children.values().all(CellChild::known)
                    && !cell.blocks_effect_admission() =>
            {
                ToolSettlement::Failed
            }
            // Source physical closure does not resolve logical Cell uncertainty.
            _ => ToolSettlement::Unknown,
        }))
    }
}
#[cfg(test)]
impl RunCells {
    pub(super) async fn prepare_wait_read_failure(
        self: &Arc<Self>,
        parent: ToolCallContext,
        input: &Value,
        catalog: ToolCatalog,
        cancellation: CancellationToken,
    ) -> Result<
        (
            maka_agent_facts::tools::PreparedEffect,
            super::driver::DispatchSource,
        ),
        ToolError,
    > {
        let port = NativeCellPort::new(self.clone(), parent).await?;
        let observer = Arc::new(FailFirstCellRead {
            port: port.clone(),
            failed: std::sync::atomic::AtomicBool::new(false),
        });
        let effect = self
            .coordinator
            .prepare(
                "wait",
                input,
                catalog,
                observer,
                cancellation,
                CancellationToken::new(),
            )
            .map_err(|error| ToolError::Failed(error.to_string()))?;
        Ok((
            effect,
            super::driver::DispatchSource::CellWait(OwnedCellWait { port }),
        ))
    }
}

#[cfg(test)]
struct FailFirstCellRead {
    port: Arc<NativeCellPort>,
    failed: std::sync::atomic::AtomicBool,
}

#[cfg(test)]
impl CellPersistence for FailFirstCellRead {
    fn owner(&self) -> CellOwner {
        self.port.owner()
    }
    fn now(&self) -> UnixMillis {
        self.port.now()
    }
    fn append(&self, changes: Vec<CellChange>, contents: Vec<CellContent>) -> CellFuture<'_, ()> {
        self.port.append(changes, contents)
    }
    fn read(&self, cell: CellId) -> CellFuture<'_, Option<CellView>> {
        Box::pin(async move {
            let original = self.port.read(cell).await?;
            if !self.failed.swap(true, std::sync::atomic::Ordering::SeqCst) {
                return Err(ToolError::Persistence(
                    "native-wait-original-read-once".into(),
                ));
            }
            Ok(original)
        })
    }
    fn content(&self, cell: CellId, reference: ContentRef) -> CellFuture<'_, Vec<u8>> {
        self.port.content(cell, reference)
    }
    fn invoke(
        &self,
        cell: CellId,
        operation: Uuid,
        name: String,
        input: Value,
        catalog: ToolCatalog,
        cancellation: CancellationToken,
    ) -> ToolFuture<ToolOutput> {
        self.port
            .invoke(cell, operation, name, input, catalog, cancellation)
    }
}

impl NativeCellPort {
    async fn new(run: Arc<RunCells>, parent: ToolCallContext) -> Result<Arc<Self>, ToolError> {
        run.access.check_context(&parent).await?;
        let view = run.access.fresh().await.map_err(persistence)?;
        let owner = match &parent.call.origin {
            ToolOrigin::Provider { link } => {
                let key = ToolKey {
                    attempt: link.attempt,
                    call: parent.call.tool_call_id.clone(),
                };
                if link.run != view.run
                    || parent.operation_id != format!("{}:{}", key.attempt, key.call)
                    || view
                        .attempts
                        .get(&link.attempt)
                        .is_none_or(|attempt| attempt.step != link.step)
                    || !view.tools.contains_key(&tool_key(&key))
                {
                    return Err(ToolError::Failed(
                        "Cell parent differs from its provider call".into(),
                    ));
                }
                CellOwner::Agent {
                    link: *link,
                    call: key.call,
                }
            }
            ToolOrigin::External {
                task, operation, ..
            } => {
                let key = maka_agent_facts::external_effects::ExternalEffectKey {
                    task: *task,
                    operation: *operation,
                };
                let original = run
                    .state
                    .external_effect_descriptor(view.run, key)
                    .await
                    .map_err(persistence)?;
                if original.origin != parent.call.origin
                    || original.operation_id != parent.operation_id
                {
                    return Err(ToolError::Failed(
                        "Cell parent differs from its external call".into(),
                    ));
                }
                CellOwner::External { run: view.run, key }
            }
            _ => return Err(ToolError::Failed("Cell parent is unavailable".into())),
        };
        Ok(Arc::new(Self {
            run,
            parent,
            owner,
            admission_closed: CancellationToken::new(),
            observed_cell: Arc::default(),
        }))
    }
    fn cell_owner(&self) -> CellOwner {
        self.owner.clone()
    }

    async fn original_cell(&self, cell: CellId) -> Result<CellView, ToolError> {
        self.run.check_work()?;
        let view = self
            .run
            .cells
            .read(&self.run.access.execution().session_id, cell)
            .await
            .map_err(persistence)?
            .ok_or_else(|| persistence("Cell not recorded"))?;
        if view.owner != self.cell_owner() {
            return Err(persistence(
                "Cell belongs to a different original provider call",
            ));
        }
        Ok(view)
    }
    async fn commit(
        &self,
        changes: Vec<CellChange>,
        contents: Vec<CellContent>,
    ) -> Result<u64, ToolError> {
        self.run.check_work()?;
        let mut started = BTreeSet::new();
        for change in &changes {
            match &change.event {
                CellEvent::Started { cell, owner, .. } => {
                    if *owner != self.cell_owner() {
                        return Err(persistence(
                            "CellStarted owner differs from the actual provider call",
                        ));
                    }
                    started.insert(*cell);
                }
                event if !started.contains(&event.cell()) => {
                    self.original_cell(event.cell()).await?;
                }
                _ => {}
            }
        }
        let admission = changes.iter().any(|change| change.event.is_admission());
        if changes.iter().any(|change| {
            matches!(
                change.event,
                CellEvent::ResultAccepted { .. }
                    | CellEvent::FinalNotificationQueued { .. }
                    | CellEvent::SessionValuePublished { .. }
                    | CellEvent::LoadedToolsPublished { .. }
                    | CellEvent::NotificationConsumed { .. }
            )
        }) {
            return Err(persistence(
                "Cell worker cannot publish session acceptance or consume notifications",
            ));
        }
        let contents = tokio::task::spawn_blocking(move || {
            contents
                .into_iter()
                .map(|content| {
                    let blob = ContentBlob::new(content.bytes);
                    if blob.reference() != &content.reference {
                        return Err(persistence("Cell immutable content differs"));
                    }
                    Ok(blob)
                })
                .collect::<Result<Vec<_>, ToolError>>()
        })
        .await
        .map_err(persistence)??;
        let changes: Vec<_> = changes
            .into_iter()
            .map(|change| Change {
                id: change.id,
                at: change.at,
                fact: Fact::Cell {
                    event: change.event,
                },
            })
            .collect();
        if !admission {
            return self.run.publish(changes, contents, vec![]).await;
        }
        for change in &changes {
            if let Fact::Cell {
                event: CellEvent::Started { cell, .. },
            } = &change.fact
            {
                self.run.owned.lock().map_err(persistence)?.insert(*cell);
            }
        }
        loop {
            let view = self.run.access.fresh().await.map_err(persistence)?;
            if self.admission_closed.is_cancelled()
                || !self.run.cleanup.confirmed()
                || view.stopped
                || view.terminal.is_some()
            {
                return Err(ToolError::Failed("Cell admission is stopped".into()));
            }
            view.check_effect_admission().map_err(|error| {
                ToolError::Failed(format!("Cell admission is quarantined: {error}"))
            })?;
            match self
                .run
                .state
                .append(
                    self.run.access.claim(),
                    Head::from(&view),
                    changes.clone(),
                    contents.clone(),
                )
                .await
            {
                Ok(commit) => return Ok(commit.head.revision),
                Err(error)
                    if matches!(
                        error.underlying(),
                        maka_event_log::StoreError::RevisionConflict { .. }
                    ) =>
                {
                    continue;
                }
                Err(error)
                    if matches!(
                        error.underlying(),
                        maka_event_log::StoreError::CommitUnknown(_)
                            | maka_event_log::StoreError::OperationUnknown
                    ) =>
                {
                    let original = self.run.retain_publication(
                        changes.clone(),
                        contents.clone(),
                        vec![],
                        true,
                        None,
                    )?;
                    match self.run.observe_original(&original.changes).await? {
                        Some(revision) => {
                            self.run.release_publication(&original)?;
                            return Ok(revision);
                        }
                        None => {
                            self.run.release_publication(&original)?;
                            continue;
                        }
                    }
                }
                Err(error) => return Err(persistence(error)),
            }
        }
    }

    fn change(&self, event: CellEvent) -> CellChange {
        CellChange::new(event, self.now())
    }
    fn child_context(&self, cell: CellId, operation: Uuid) -> ToolCallContext {
        ToolCallContext {
            execution: self.run.access.execution().clone(),
            operation_id: child_operation(cell, operation),
            call: ToolCallIdentity {
                tool_call_id: operation.to_string(),
                origin: ToolOrigin::CodeCell {
                    cell,
                    owner: self.cell_owner(),
                    parent_operation_id: self.parent.operation_id.clone(),
                    parent_tool_call_id: self.parent.call.tool_call_id.clone(),
                },
            },
            custody: Some(self.run.access.custody().clone()),
        }
    }

    async fn invoke_child(
        &self,
        cell: CellId,
        operation: Uuid,
        name: String,
        input: Value,
        catalog: ToolCatalog,
        cancellation: CancellationToken,
    ) -> Result<ToolOutput, ToolError> {
        let view = self.original_cell(cell).await?;
        if let Some(child) = view.children.get(&operation) {
            if child.name != name {
                return Err(persistence("Cell child operation identity reused"));
            }
            let bytes = self
                .run
                .cells
                .content(
                    &self.run.access.execution().session_id,
                    cell,
                    child.input.clone(),
                )
                .await
                .map_err(persistence)?;
            if serde_json::from_slice::<Value>(&bytes).map_err(persistence)? != input {
                return Err(persistence("Cell child original input changed"));
            }
            if needs_observation(child) {
                self.run.recover_child(cell, operation, child).await?;
            }
            let current = self.original_cell(cell).await?;
            return self
                .run
                .child_result(cell, &current.children[&operation])
                .await;
        }
        if self.admission_closed.is_cancelled()
            || cancellation.is_cancelled()
            || !self.run.cleanup.confirmed()
            || !matches!(view.status, CellStatus::Running)
        {
            return Err(ToolError::Failed("Cell child admission is closed".into()));
        }
        self.run
            .access
            .check_tool(&self.child_context(cell, operation), &name)
            .await?;
        let (input, content) = tokio::task::spawn_blocking(move || {
            CellContent::json(&input).map(|content| (input, content))
        })
        .await
        .map_err(persistence)??;
        let semantics = catalog
            .semantics(&name)
            .map_err(|error| ToolError::Failed(error.to_string()))?;
        self.commit(
            vec![self.change(CellEvent::ChildPrepared {
                cell,
                operation,
                name: name.clone(),
                semantics,
                input: content.reference.clone(),
                resources: vec![],
            })],
            vec![content],
        )
        .await?;
        let prepared = match PreparedTool::prepare(
            &self.run.owner,
            &self.run.access,
            &catalog,
            name,
            input,
            self.child_context(cell, operation),
            cancellation.clone(),
            semantics,
        )
        .await
        {
            Ok(prepared) => prepared,
            Err(error) => {
                self.commit(
                    vec![self.change(CellEvent::ChildRejected {
                        cell,
                        operation,
                        diagnostic: error.to_string(),
                        reason: error.kind(),
                    })],
                    vec![],
                )
                .await?;
                return Err(ToolError::Failed(error.to_string()));
            }
        };
        let current = self.original_cell(cell).await?;
        if current.finish_requested() {
            let diagnostic = "Cell finish outcome prevents fresh child admission";
            self.commit(
                vec![self.change(CellEvent::ChildRejected {
                    cell,
                    operation,
                    reason: RejectionKind::PolicyDenied,
                    diagnostic: diagnostic.into(),
                })],
                vec![],
            )
            .await?;
            return Err(ToolError::Failed(diagnostic.into()));
        }
        let child = &current.children[&operation];
        if let Some(approval) = prepared.approval_id()
            && !child.approvals.contains_key(&approval)
        {
            return Err(persistence(
                "Prepared Cell approval differs from its original established interaction",
            ));
        }
        let display = prepared.display(match self.run.access.spec().language {
            maka_agent_facts::language::Language::En => "en",
            maka_agent_facts::language::Language::ZhCn => "zh-CN",
            maka_agent_facts::language::Language::ZhTw => "zh-TW",
        });
        let mut admitted = vec![self.change(CellEvent::ChildDisplayRecorded {
            cell,
            operation,
            display,
        })];
        for (approval, consumed) in &child.approvals {
            if !consumed {
                admitted.push(self.change(CellEvent::ChildApprovalConsumed {
                    cell,
                    operation,
                    approval: *approval,
                }));
            }
        }
        admitted.push(self.change(CellEvent::ChildAdmitted { cell, operation }));
        let sequence = match self.commit(admitted, vec![]).await {
            Ok(sequence) => sequence,
            Err(error @ ToolError::Failed(_)) => {
                self.commit(
                    vec![self.change(CellEvent::ChildRejected {
                        cell,
                        operation,
                        reason: RejectionKind::PolicyDenied,
                        diagnostic: error.to_string(),
                    })],
                    vec![],
                )
                .await?;
                return Err(error);
            }
            Err(error) => return Err(error),
        };
        let PreparedTool { effect, local, .. } = prepared;
        let running = match effect.begin(sequence, cancellation) {
            Ok(running) => running,
            Err(error) => return self.persist_return(cell, operation, Err(error), None).await,
        };
        let (custody, future) = running.execute();
        self.run.owned.lock().map_err(persistence)?.insert(cell);
        self.run
            .effects
            .lock()
            .map_err(persistence)?
            .insert((cell, operation), custody);
        let result = AssertUnwindSafe(future)
            .catch_unwind()
            .await
            .unwrap_or_else(|_| {
                Err(ToolError::OutcomeUnknown(
                    "Cell child worker panicked".into(),
                ))
            });
        let result = AssertUnwindSafe(self.persist_return(cell, operation, result, local))
            .catch_unwind()
            .await
            .unwrap_or_else(|_| {
                Err(ToolError::OutcomeUnknown(
                    "Cell publication panicked".into(),
                ))
            });
        let result = self.fence_uncertain(cell, result).await;
        self.run.release_child_if_confirmed(cell, operation).await?;
        result
    }
    async fn fence_uncertain(
        &self,
        cell: CellId,
        result: Result<ToolOutput, ToolError>,
    ) -> Result<ToolOutput, ToolError> {
        if let Err(error) = &result
            && uncertain(error)
        {
            self.admission_closed.cancel();
            self.run.cleanup.observe_tool(error);
            if let Err(failure) = self.run.quarantine(cell).await {
                let failure = ToolError::CleanupUnconfirmed(format!(
                    "Original Cell remains quarantined locally; canonical quarantine could not be confirmed: {failure}; original: {error}"
                ));
                self.run.cleanup.observe_tool(&failure);
                return Err(failure);
            }
        }
        result
    }

    async fn persist_return(
        &self,
        cell: CellId,
        operation: Uuid,
        result: Result<ToolSuccess, ToolError>,
        local: Option<LocalCompletion>,
    ) -> Result<ToolOutput, ToolError> {
        let local = if result.is_ok() { local } else { None };
        let mut local_error = None;
        let (success, settlement) = match result {
            Ok(success) => (success, ToolSettlement::Returned),
            Err(
                error @ (ToolError::OperationUnknown { .. }
                | ToolError::OperationCleanupUnconfirmed { .. }),
            ) => {
                let (ToolError::OperationUnknown { observation, .. }
                | ToolError::OperationCleanupUnconfirmed { observation, .. }) = &error
                else {
                    unreachable!()
                };
                self.run
                    .record_reply(cell, operation, *observation.clone())
                    .await?;
                return Err(error);
            }
            Err(
                error @ (ToolError::OutcomeUnknown(_)
                | ToolError::CleanupUnconfirmed(_)
                | ToolError::Persistence(_)),
            ) => return Err(error),
            Err(error) => {
                let value =
                    ToolSuccess::from(ToolOutput::Text(error.to_string())).reporting_error(true);
                local_error = Some(error);
                (value, ToolSettlement::Failed)
            }
        };
        let execution = self.run.access.execution().clone();
        let PreparedChildReturn {
            blob,
            value,
            is_error,
            observed,
            material,
            artifacts,
        } = tokio::task::spawn_blocking(move || {
            prepare_child_return(success, &execution, cell, operation)
        })
        .await
        .map_err(persistence)??;
        let mut changes = Vec::new();
        let event = if let Some(reply) = observed {
            let current = self.original_cell(cell).await?;
            let child = current
                .children
                .get(&operation)
                .ok_or_else(|| persistence("Cell child not recorded"))?;
            if child.reference.is_none() {
                changes.push(Change::new(
                    Fact::Cell {
                        event: CellEvent::ChildBound {
                            cell,
                            operation,
                            reference: reply.reference.clone(),
                        },
                    },
                    self.now(),
                ));
            }
            changes.push(Change::new(
                Fact::Cell {
                    event: CellEvent::ChildObserved {
                        cell,
                        operation,
                        reply,
                    },
                },
                self.now(),
            ));
            CellEvent::ChildResultRecorded {
                cell,
                operation,
                result: blob.reference().clone(),
                is_error,
            }
        } else {
            CellEvent::LocalChildReturned {
                cell,
                operation,
                result: blob.reference().clone(),
                is_error,
                settlement,
            }
        };
        changes.push(Change::new(Fact::Cell { event }, self.now()));
        let contents = std::iter::once(blob).chain(material).collect();
        if let Some(local) = local {
            let original =
                self.run
                    .retain_publication(changes, contents, artifacts, false, Some(local))?;
            if let PublicationOutcome::BusinessFailed { message, .. } =
                self.run.settle_publication(&original).await?
            {
                return Err(ToolError::Failed(message));
            }
        } else {
            self.run.publish(changes, contents, artifacts).await?;
        }
        if let Some(error) = local_error {
            return Err(error);
        }
        match value {
            ToolOutput::Operation(reply) => operation_output(*reply),
            value => output(value, is_error),
        }
    }
}
pub(super) struct PreparedChildReturn {
    pub(super) blob: ContentBlob,
    value: ToolOutput,
    pub(super) is_error: bool,
    pub(super) observed: Option<maka_agent_facts::operation::RecordedOperationReply>,
    pub(super) material: Option<ContentBlob>,
    artifacts: Vec<maka_agent_facts::event::ProjectionArtifactWrite>,
}

pub(super) fn prepare_child_return(
    success: ToolSuccess,
    execution: &ExecutionIdentity,
    cell: CellId,
    operation: Uuid,
) -> Result<PreparedChildReturn, ToolError> {
    use maka_agent_facts::tool_output::{OperationProjection, StoredOperationReturn};
    let normalized = success
        .into_durable(
            &child_operation(cell, operation),
            SystemTime::now(),
            execution,
        )
        .map_err(persistence)?;
    let artifacts = normalized
        .artifacts
        .iter()
        .map(|artifact| {
            let evidence = artifact.evidence();
            PublishedArtifact {
                artifact: artifact.artifact().clone(),
                payload: ContentRef {
                    digest: evidence.digest,
                    bytes: evidence.bytes,
                },
            }
        })
        .collect();
    let is_error = normalized.is_error;
    let (blob, value, observed, material) = match normalized.output {
        ToolOutput::Operation(reply) => {
            let (recorded, material) =
                maka_agent_state::operation::record_reply((*reply).clone()).map_err(persistence)?;
            let blob = ContentBlob::json(&ToolReturn {
                schema_version: SCHEMA_VERSION,
                artifacts,
                body: StoredOperationReturn {
                    operation: recorded.clone(),
                    projection: OperationProjection::record(&reply, normalized.projection)
                        .map_err(persistence)?,
                    is_error,
                    loaded_tools: Default::default(),
                },
            })
            .map_err(persistence)?;
            (blob, ToolOutput::Operation(reply), Some(recorded), material)
        }
        output => {
            let returned = ToolReturn {
                schema_version: SCHEMA_VERSION,
                artifacts,
                body: CellReturnedResult {
                    output,
                    projection: Some(normalized.projection),
                    is_error,
                },
            };
            let blob = ContentBlob::json(&returned).map_err(persistence)?;
            (blob, returned.body.output, None, None)
        }
    };
    Ok(PreparedChildReturn {
        blob,
        value,
        is_error,
        observed,
        material,
        artifacts: normalized.artifacts,
    })
}

impl CellPersistence for NativeCellPort {
    fn owner(&self) -> CellOwner {
        self.cell_owner()
    }
    fn now(&self) -> UnixMillis {
        UnixMillis(now().try_into().expect("Unix milliseconds"))
    }
    fn append(&self, changes: Vec<CellChange>, contents: Vec<CellContent>) -> CellFuture<'_, ()> {
        Box::pin(async move { self.commit(changes, contents).await.map(|_| ()) })
    }
    fn read(&self, cell: CellId) -> CellFuture<'_, Option<CellView>> {
        Box::pin(async move {
            self.run.check_work()?;
            if self.observed_cell.get_or_init(|| cell) != &cell {
                return Err(persistence(
                    "Cell control changed its original observation target",
                ));
            }
            self.run.read_current(cell).await
        })
    }
    fn content(&self, cell: CellId, reference: ContentRef) -> CellFuture<'_, Vec<u8>> {
        Box::pin(async move {
            self.run.check_work()?;
            self.run
                .cells
                .content(&self.run.access.execution().session_id, cell, reference)
                .await
                .map_err(persistence)
        })
    }
    fn invoke(
        &self,
        cell: CellId,
        operation: Uuid,
        name: String,
        input: Value,
        catalog: ToolCatalog,
        cancellation: CancellationToken,
    ) -> ToolFuture<ToolOutput> {
        let port = self.clone();
        Box::pin(async move {
            let (send, receive) = oneshot::channel();
            let workers = port.run.workers.clone();
            workers.spawn(async move {
                let result = AssertUnwindSafe(port.invoke_child(
                    cell,
                    operation,
                    name,
                    input,
                    catalog,
                    cancellation,
                ))
                .catch_unwind()
                .await
                .unwrap_or_else(|_| {
                    Err(ToolError::OutcomeUnknown(
                        "Cell child worker panicked".into(),
                    ))
                });
                let result = port.fence_uncertain(cell, result).await;
                let _ = send.send(result);
            });
            receive.await.map_err(|_| {
                ToolError::OutcomeUnknown("Original Cell worker observation closed".into())
            })?
        })
    }
}
fn child_operation(cell: CellId, operation: Uuid) -> String {
    format!("cell:{cell}:{operation}")
}
fn persistence(error: impl std::fmt::Display) -> ToolError {
    ToolError::Persistence(error.to_string())
}
fn output(output: ToolOutput, is_error: bool) -> Result<ToolOutput, ToolError> {
    if is_error {
        return Err(ToolError::Failed(
            output
                .into_code_value()
                .map_err(ToolError::Failed)?
                .to_string(),
        ));
    }
    Ok(output)
}
fn operation_output(reply: OperationReply) -> Result<ToolOutput, ToolError> {
    use maka_plugin_core::operation::OperationOutcome;
    if !matches!(
        &reply.receipt,
        Receipt::Recorded {
            outcome: OperationOutcome::Returned { .. } | OperationOutcome::NotExecuted { .. },
            ..
        }
    ) {
        return Err(ToolError::OperationUnknown {
            message: "Original Cell child outcome remains unknown".into(),
            observation: Box::new(reply),
        });
    }
    if !matches!(
        &reply.receipt,
        Receipt::Recorded {
            cleanup: OperationCleanup::Confirmed,
            ..
        }
    ) {
        return Err(ToolError::OperationCleanupUnconfirmed {
            message: "Original Cell child cleanup is not confirmed".into(),
            observation: Box::new(reply),
        });
    }
    Ok(ToolOutput::Operation(Box::new(reply)))
}

fn needs_observation(child: &CellChild) -> bool {
    child.admitted
        && child
            .local_result
            .as_ref()
            .is_none_or(|result| result.settlement == ToolSettlement::Unknown)
        && child.rejected.is_none()
        && (!child.known()
            || !matches!(
                child.reply.as_ref().map(|reply| &reply.receipt),
                Some(Receipt::Recorded {
                    cleanup: OperationCleanup::Confirmed,
                    ..
                })
            ))
}

fn uncertain(error: &ToolError) -> bool {
    matches!(
        error,
        ToolError::OutcomeUnknown(_)
            | ToolError::OperationUnknown { .. }
            | ToolError::Persistence(_)
            | ToolError::CleanupUnconfirmed(_)
            | ToolError::OperationCleanupUnconfirmed { .. }
    )
}

impl CellPorts for RunCells {
    fn observe_original_cell<'a>(
        &'a self,
        view: &'a RunView,
        cell: &'a CellView,
    ) -> BoxFuture<'a, Result<CellObservation, RunError>> {
        Box::pin(async move {
            if view.run != self.access.execution().run_id || cell.owner.run() != Some(view.run) {
                return Err(RunError::InvalidInput(
                    "Cell observer differs from its actual Run".into(),
                ));
            }
            let mut physical = self.coordinator.physical_changes();
            loop {
                physical.borrow_and_update();
                if !self.coordinator.has_live(cell.id) {
                    break;
                }
                if !self.coordinator.is_cancelled() {
                    return Ok(CellObservation::Live);
                }
                tokio::select! {
                    _ = self.owner.stop.cancelled() => {
                        return Err(RunError::Tool(ToolError::Failed("Original Cell observation stopped".into())));
                    }
                    changed = physical.changed() => {
                        changed.map_err(|error| RunError::Tool(persistence(error)))?;
                    }
                }
            }
            let canonical = self
                .read_current(cell.id)
                .await
                .map_err(RunError::Tool)?
                .ok_or_else(|| RunError::InvalidInput("Original Cell is unavailable".into()))?;
            if self
                .observe_vm_closure(&canonical)
                .await
                .map_err(RunError::Tool)?
            {
                Ok(CellObservation::Recorded)
            } else {
                Err(RunError::from(BlockerKind::CodeCellRecoveryUnavailable {
                    cell: cell.id.to_string(),
                }))
            }
        })
    }
}
