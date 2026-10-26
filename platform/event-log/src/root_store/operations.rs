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

//! Bound original operation journals; receipts never grant execution.
use super::*;
use crate::applications::operations::{
    Dispatch, DispatchClaim, DispatchLifetime, PreparedOperation,
};
use maka_plugin_core::operation::{
    OperationCleanup, OperationObservation, OperationOutcome, RecoveryRef,
};

#[derive(Clone)]
pub struct OperationStore {
    reference: RecoveryRef,
    partition: Weak<EventLog>,
    closed: Arc<AtomicBool>,
    gates: Arc<gates::Gates>,
}
/// One admitted provider attempt, retaining original dispatch and Session work.
/// The physical worker must finish provider cleanup before settling this handle.
pub struct OperationAuxiliary {
    log: EventLog,
    id: uuid::Uuid,
    work: Arc<crate::applications::operations::DispatchWork>,
    lease: Option<SessionExecutionLease>,
}
impl Drop for OperationAuxiliary {
    fn drop(&mut self) {
        if self.lease.is_some() {
            // Lost provider custody can never become a confirmed parent cleanup.
            self.work.quarantine();
        }
    }
}
// Admission has not dispatched a provider; settlement is called only after its
// physical cleanup. In both phases SQL uncertainty affects facts, not cleanup.
struct AuxiliaryCompletion {
    work: Option<Arc<crate::applications::operations::DispatchWork>>,
    lease: Option<SessionExecutionLease>,
}
impl Drop for AuxiliaryCompletion {
    fn drop(&mut self) {
        if let Some(work) = self.work.take() {
            work.finish();
        }
        if let Some(lease) = self.lease.take() {
            lease.finish();
        }
    }
}
impl OperationAuxiliary {
    pub fn id(&self) -> uuid::Uuid {
        self.id
    }
    pub async fn observe(
        &self,
        usage: maka_agent_facts::model::ModelUsage,
    ) -> Result<(), StoreError> {
        self.log.observe_auxiliary_model(self.id, usage).await
    }
    /// The physical worker has confirmed cleanup, but accounting persistence
    /// failed. Preserve its pending journal for recovery; invent no outcome.
    pub fn release_after_cleanup(mut self) {
        drop(AuxiliaryCompletion {
            work: Some(self.work.clone()),
            lease: self.lease.take(),
        });
    }
    pub async fn settle(mut self, outcome: crate::usage::Outcome) -> Result<(), StoreError> {
        let completion = AuxiliaryCompletion {
            work: Some(self.work.clone()),
            lease: self.lease.take(),
        };
        let result = self.log.settle_auxiliary_model(self.id, outcome).await;
        drop(completion);
        result
    }
}

impl RootStore {
    pub fn operation(&self, reference: &RecoveryRef) -> Result<OperationStore, StoreError> {
        self.require_open()?;
        self.control.operation_domain(reference)?;
        let identity = serde_json::to_string(&(
            reference.source.deployment,
            &reference.namespace,
            reference.operation,
        ))?;
        let partition = partition_for(b"application-operation-v1", &identity);
        Ok(OperationStore {
            reference: reference.clone(),
            partition: Arc::downgrade(&self.partitions[partition]),
            closed: self.closed.clone(),
            gates: self.gates.clone(),
        })
    }
}
impl OperationStore {
    pub fn reference(&self) -> &RecoveryRef {
        &self.reference
    }
    fn owner(&self) -> Result<Arc<EventLog>, StoreError> {
        if self.closed.load(Ordering::Acquire) || self.gates.is_closing() {
            return Err(StoreError::ConnectionClosed);
        }
        self.partition.upgrade().ok_or(StoreError::ConnectionClosed)
    }
    fn check(&self, reference: &RecoveryRef) -> Result<(), StoreError> {
        if reference == &self.reference {
            Ok(())
        } else {
            Err(StoreError::EventConflict)
        }
    }
    fn admission(&self) -> Result<(Arc<EventLog>, Arc<OperationLifetime>), StoreError> {
        let owner = self.owner()?;
        self.gates.start_work()?;
        let lifetime = Arc::new(OperationLifetime {
            gates: self.gates.clone(),
            state: std::sync::atomic::AtomicU8::new(0),
            _owner: owner.clone(),
        });
        Ok((owner, lifetime))
    }
    pub async fn dispatch_operation(
        &self,
        request: crate::applications::operations::OperationRequest,
    ) -> Result<Dispatch, StoreError> {
        self.check(&request.reference()?)?;
        let (owner, lifetime) = self.admission()?;
        owner
            .scoped(lifetime.clone())
            .dispatch_operation_with_lifetime(request, Some(lifetime))
            .await
    }
    pub async fn dispatch_prepared_operation(
        &self,
        prepared: PreparedOperation,
    ) -> Result<Dispatch, StoreError> {
        self.check(prepared.reference())?;
        let (owner, lifetime) = self.admission()?;
        owner
            .scoped(lifetime.clone())
            .dispatch_prepared_with_lifetime(prepared, Some(lifetime))
            .await
    }
    pub async fn finish_operation(
        &self,
        claim: &DispatchClaim,
        outcome: OperationOutcome,
        cleanup: OperationCleanup,
    ) -> Result<OperationObservation, StoreError> {
        self.check(claim.reference())?;
        // Original accepted work may settle while Root admission is closed.
        let owner = self
            .partition
            .upgrade()
            .ok_or(StoreError::ConnectionClosed)?;
        owner
            .scoped(owner.clone())
            .finish_operation(claim, outcome, cleanup)
            .await
    }
    pub async fn operation_observation(&self) -> Result<Option<OperationObservation>, StoreError> {
        let owner = self.owner()?;
        owner
            .scoped(owner.clone())
            .operation_observation(&self.reference)
            .await
    }
}

impl OperationStore {
    pub async fn begin_auxiliary_operation_model(
        &self,
        dispatch: &crate::applications::operations::OperationDispatchScope,
        lease: SessionExecutionLease,
        binding: maka_agent_facts::execution::ModelBinding,
        language: maka_agent_facts::language::Language,
        quote: Option<maka_agent_facts::pricing::Quote>,
    ) -> Result<OperationAuxiliary, StoreError> {
        let mut completion = AuxiliaryCompletion {
            work: None,
            lease: Some(lease),
        };
        let (log, id, work) = self
            .admit_auxiliary_operation_model(
                dispatch,
                completion.lease.as_ref().expect("prepared Session lease"),
                binding,
                language,
                quote,
            )
            .await?;
        Ok(OperationAuxiliary {
            log,
            id,
            work,
            lease: completion.lease.take(),
        })
    }

    async fn admit_auxiliary_operation_model(
        &self,
        dispatch: &crate::applications::operations::OperationDispatchScope,
        lease: &SessionExecutionLease,
        binding: maka_agent_facts::execution::ModelBinding,
        language: maka_agent_facts::language::Language,
        quote: Option<maka_agent_facts::pricing::Quote>,
    ) -> Result<
        (
            EventLog,
            uuid::Uuid,
            Arc<crate::applications::operations::DispatchWork>,
        ),
        StoreError,
    > {
        self.check(dispatch.reference())?;
        let session = lease.store();
        if !Arc::ptr_eq(&self.gates, &session.gates) {
            return Err(StoreError::InvalidTransition(
                "foreign Session execution lease".into(),
            ));
        }
        let pins = session
            .execution
            .as_ref()
            .ok_or(StoreError::ConnectionClosed)?
            .custody()?;
        // Accepted work retains access during Root draining. Its Session lease
        // is registered in the original Root's lifetime and retirement gates.
        let owner = self
            .partition
            .upgrade()
            .ok_or(StoreError::ConnectionClosed)?;
        let work = dispatch.acquire(&owner, &self.reference)?;
        let mut completion = AuxiliaryCompletion {
            work: Some(work.clone()),
            lease: None,
        };
        // Mark accepted use in the original Session transaction before entering
        // the independent source journal. Work pins prevent physical retirement.
        session.scoped().await?.retain_session(session.id()).await?;
        let log = owner.scoped(Arc::new((owner.clone(), pins, work.clone())));
        let id = log
            .begin_bound_auxiliary_operation_model(
                self.reference.clone(),
                binding,
                session.id().to_owned(),
                language,
                quote,
            )
            .await?;
        drop(completion.work.take());
        Ok((log, id, work))
    }
}

#[cfg(test)]
mod tests;

// Root lifetime covers the actual first dispatch through its durable settlement,
// including the gap after the provider has drained but before the receipt write.
struct OperationLifetime {
    gates: Arc<gates::Gates>,
    state: std::sync::atomic::AtomicU8,
    _owner: Arc<EventLog>,
}
impl DispatchLifetime for OperationLifetime {
    fn finish(&self) {
        if self
            .state
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            self.gates.finish_work();
        }
    }
    fn abandon(self: Arc<Self>) {
        if self
            .state
            .compare_exchange(0, 2, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            let gates = self.gates.clone();
            gates.retain_unconfirmed(self);
        }
    }
}
impl Drop for OperationLifetime {
    fn drop(&mut self) {
        // No first claim was issued (rejected/duplicate admission).
        if self.state.load(Ordering::Acquire) == 0 {
            self.gates.finish_work();
        }
    }
}
