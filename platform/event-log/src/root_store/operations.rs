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
    OperationCleanup, OperationObservation, OperationOutcome, OperationResult, RecoveryContract,
    RecoveryRef,
};
use maka_plugin_core::{
    composition::InstanceId,
    deployment::DeploymentRef,
    package::{Implementation, PackageRef},
    plan::InstanceEntry,
};

#[derive(Clone)]
pub struct OperationStore {
    reference: RecoveryRef,
    log: Weak<EventLog>,
    closed: Arc<AtomicBool>,
    gates: Arc<gates::Gates>,
}
/// Provider fact authority over one Root/deployment and direct namespace.
/// Native ownership follows package id + implementation across bundle revisions;
/// JavaScript remains bound to its complete immutable package.
#[derive(Clone)]
pub struct ProviderJournal {
    deployment: uuid::Uuid,
    namespace: InstanceId,
    package: PackageRef,
    implementation: Implementation,
    log: Weak<EventLog>,
}

/// Only authoritative facts for the exact original operation. This is never an
/// Execution, DispatchClaim, replay permit, or proof the handler did not start.
#[derive(Clone)]
pub struct RecoveredOperation {
    reference: RecoveryRef,
    log: Weak<EventLog>,
}
impl ProviderJournal {
    pub fn deployment(&self) -> uuid::Uuid {
        self.deployment
    }
    pub fn namespace(&self) -> &InstanceId {
        &self.namespace
    }
    pub fn package(&self) -> &PackageRef {
        &self.package
    }

    pub async fn operation(
        &self,
        reference: &RecoveryRef,
    ) -> Result<RecoveredOperation, StoreError> {
        reference
            .validate()
            .map_err(|error| StoreError::InvalidTransition(error.to_string()))?;
        if reference.source.deployment != self.deployment || reference.namespace != self.namespace {
            return Err(StoreError::InvalidTransition(
                "foreign provider operation journal".into(),
            ));
        }
        let owner = self.log.upgrade().ok_or(StoreError::ConnectionClosed)?;
        let log = owner.scoped(owner.clone());
        // Inspect the original source, never current bindings. This authorizes
        // original provider facts, not execution or interpretation of old code.
        let loaded = log
            .load_application_at(&reference.source)
            .await?
            .ok_or_else(|| {
                StoreError::InvalidTransition("original provider source is missing".into())
            })?;
        let instance = loaded
            .plan()
            .instances()
            .get(&self.namespace)
            .filter(|instance| !instance.disabled && instance.package.id == self.package.id)
            .ok_or_else(|| {
                StoreError::InvalidTransition(
                    "original provider package or namespace differs".into(),
                )
            })?;
        let Some(InstanceEntry::Host(entry)) = &instance.entry else {
            return Err(StoreError::InvalidTransition(
                "original provider requires a Host entry".into(),
            ));
        };
        let same_provider = match (&self.implementation, &entry.implementation) {
            (
                Implementation::Native {
                    implementation: issuer,
                },
                Implementation::Native {
                    implementation: original,
                },
            ) => issuer == original,
            (Implementation::JavaScript { .. }, Implementation::JavaScript { .. }) => {
                instance.package == self.package && self.implementation == entry.implementation
            }
            _ => false,
        };
        if !same_provider {
            return Err(StoreError::InvalidTransition(
                "original provider implementation differs".into(),
            ));
        }
        let declared = entry.exports.get(&reference.export).ok_or_else(|| {
            StoreError::InvalidTransition("original provider export is missing".into())
        })?;
        let contract = RecoveryContract::for_method(&declared.contract, &reference.method)
            .map_err(|error| StoreError::InvalidTransition(error.to_string()))?;
        if contract != reference.contract {
            return Err(StoreError::EventConflict);
        }
        log.operation_observation(reference).await?.ok_or_else(|| {
            StoreError::InvalidTransition("original provider operation is not recorded".into())
        })?;
        Ok(RecoveredOperation {
            reference: reference.clone(),
            log: self.log.clone(),
        })
    }
}

impl RecoveredOperation {
    pub fn reference(&self) -> &RecoveryRef {
        &self.reference
    }

    pub async fn observation(&self) -> Result<OperationObservation, StoreError> {
        let owner = self.log.upgrade().ok_or(StoreError::ConnectionClosed)?;
        owner
            .scoped(owner.clone())
            .operation_observation(&self.reference)
            .await?
            .ok_or_else(|| {
                StoreError::InvalidTransition("original provider operation is not recorded".into())
            })
    }

    /// Original provider's actual handler return, including an explicit error.
    /// Reopening a Root, observing a child effect, or NotRecorded is not evidence.
    /// The provider must reconcile the original job/receipt protocol and schema;
    /// unsupported versions block rather than replay through a newer handler.
    pub async fn record_returned(
        &self,
        result: OperationResult,
    ) -> Result<OperationObservation, StoreError> {
        let owner = self.log.upgrade().ok_or(StoreError::ConnectionClosed)?;
        owner
            .scoped(owner.clone())
            .record_provider_returned(&self.reference, result)
            .await
    }

    /// The provider supplies actual physical cleanup evidence. Current-Root
    /// custody (including an expired weak tombstone) can never be bypassed here.
    pub async fn record_cleanup(
        &self,
        cleanup: OperationCleanup,
    ) -> Result<OperationObservation, StoreError> {
        let owner = self.log.upgrade().ok_or(StoreError::ConnectionClosed)?;
        owner
            .scoped(owner.clone())
            .record_provider_cleanup(&self.reference, cleanup)
            .await
    }
}

/// One admitted provider attempt, retaining original dispatch and Session work.
/// The physical worker must finish provider cleanup before settling this handle.
/// A physical child of the original dispatch and selected Session work.
pub struct OperationWork {
    work: Arc<crate::applications::operations::DispatchWork>,
    lease: Option<SessionWorkLease>,
}
impl OperationWork {
    /// Call only after the owned native worker has confirmed physical cleanup.
    pub fn finish_after_cleanup(mut self) {
        self.work.finish();
        self.lease.take().expect("live operation work").finish();
    }
}
impl Drop for OperationWork {
    fn drop(&mut self) {
        if self.lease.is_some() {
            self.work.quarantine();
        }
    }
}

impl RootStore {
    /// Trusted native Root authority explicitly selects a provider, never a guest
    /// read reference. Resolve its declarations from the exact committed source.
    pub async fn provider_journal(
        &self,
        source: DeploymentRef,
        namespace: InstanceId,
    ) -> Result<ProviderJournal, StoreError> {
        self.require_open()?;
        namespace
            .validate()
            .map_err(|error| StoreError::InvalidTransition(error.to_string()))?;
        let loaded = self
            .log
            .load_application_at(&source)
            .await?
            .ok_or_else(|| {
                StoreError::InvalidTransition("original provider source is missing".into())
            })?;
        let instance = loaded
            .plan()
            .instances()
            .get(&namespace)
            .filter(|instance| !instance.disabled)
            .ok_or_else(|| {
                StoreError::InvalidTransition(
                    "provider namespace is not executable in the original source".into(),
                )
            })?;
        let Some(InstanceEntry::Host(entry)) = &instance.entry else {
            return Err(StoreError::InvalidTransition(
                "provider namespace requires an original Host entry".into(),
            ));
        };
        let package = instance.package.clone();
        let implementation = entry.implementation.clone();
        self.require_open()?;
        Ok(ProviderJournal {
            deployment: source.deployment,
            namespace,
            package,
            implementation,
            log: Arc::downgrade(&self.log),
        })
    }

    pub fn operation(&self, reference: &RecoveryRef) -> Result<OperationStore, StoreError> {
        self.require_open()?;
        self.log.operation_domain(reference)?;
        Ok(OperationStore {
            reference: reference.clone(),
            log: Arc::downgrade(&self.log),
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
        self.log.upgrade().ok_or(StoreError::ConnectionClosed)
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
    pub fn start_operation(&self, claim: &DispatchClaim) -> Result<(), StoreError> {
        self.check(claim.reference())?;
        self.owner()?.start_operation(claim)
    }
    pub async fn prevent_operation_before_start(
        &self,
        claim: &DispatchClaim,
    ) -> Result<OperationObservation, StoreError> {
        self.check(claim.reference())?;
        let owner = self.log.upgrade().ok_or(StoreError::ConnectionClosed)?;
        owner
            .scoped(owner.clone())
            .prevent_operation_before_start(claim)
            .await
    }
    pub async fn record_operation_outcome(
        &self,
        claim: &DispatchClaim,
        outcome: OperationOutcome,
    ) -> Result<OperationObservation, StoreError> {
        self.check(claim.reference())?;
        // Accepted work may settle after admission closes, without a new grant.
        let owner = self.log.upgrade().ok_or(StoreError::ConnectionClosed)?;
        owner
            .scoped(owner.clone())
            .record_operation_outcome(claim, outcome)
            .await
    }
    pub async fn record_operation_cleanup(
        &self,
        claim: &DispatchClaim,
        cleanup: OperationCleanup,
    ) -> Result<OperationObservation, StoreError> {
        self.check(claim.reference())?;
        let owner = self.log.upgrade().ok_or(StoreError::ConnectionClosed)?;
        owner
            .scoped(owner.clone())
            .record_operation_cleanup(claim, cleanup)
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

struct PendingWork(Option<SessionWorkLease>);
impl Drop for PendingWork {
    fn drop(&mut self) {
        if let Some(lease) = self.0.take() {
            lease.finish();
        }
    }
}
impl OperationStore {
    pub async fn acquire_work(
        &self,
        dispatch: &crate::applications::operations::OperationDispatchScope,
        lease: SessionWorkLease,
    ) -> Result<OperationWork, StoreError> {
        let mut pending = PendingWork(Some(lease));
        self.check(dispatch.reference())?;
        let session = pending.0.as_ref().expect("prepared work").store();
        let owner = self.log.upgrade().ok_or(StoreError::ConnectionClosed)?;
        let selected = session.owner()?;
        if !std::ptr::eq(
            owner
                .root_owner
                .as_deref()
                .ok_or(StoreError::ConnectionClosed)?,
            selected
                .root_owner
                .as_deref()
                .ok_or(StoreError::ConnectionClosed)?,
        ) {
            return Err(StoreError::InvalidTransition("foreign Session work".into()));
        }
        session.work_lifetime()?;
        session.scoped().await?.retain_session(session.id()).await?;
        let work = dispatch.acquire(&owner, &self.reference)?;
        Ok(OperationWork {
            work,
            lease: pending.0.take(),
        })
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
