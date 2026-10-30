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

use futures_util::FutureExt;
use maka_agent_facts::tools::ToolError;
use maka_capabilities::call::Ticket;
use maka_computer_use::{
    BrowserEffectScope, BrowserHostEffects, BrowserPreparationBinding, CheckedSettlementFuture,
    HostEffectFactory, HostEffectFuture, HostUncertaintyFuture, OperationSettlement,
    SettlementFuture,
};
use maka_event_log::root_store::InvocationEffectLease;
use maka_js_runtime::repl::ReplAdmission;
use std::panic::AssertUnwindSafe;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::Notify;

type NativeSession = tokio::sync::Mutex<maka_computer_use::Session>;

/// The VM producer's admission handshake. Actual effect completion and
/// authority remain in the original journal and invocation execution lease.
#[derive(Default)]
pub(super) struct Gate {
    state: Mutex<State>,
    changed: Notify,
}

#[derive(Default)]
struct State {
    sealed: bool,
    pending: usize,
    failure: Option<ToolError>,
}

#[derive(Clone)]
pub(super) struct Receipt(Arc<Pending>);

struct Pending {
    gate: Arc<Gate>,
    acknowledged: AtomicBool,
}

impl Gate {
    pub fn check_open(&self) -> Result<(), ToolError> {
        let state = self.state.lock().unwrap();
        if let Some(error) = &state.failure {
            return Err(error.clone());
        }
        if state.sealed {
            return Err(ToolError::Failed("Computer VM has retired".into()));
        }
        Ok(())
    }

    pub fn register(self: &Arc<Self>) -> Result<Receipt, ToolError> {
        let mut state = self.state.lock().unwrap();
        if let Some(error) = &state.failure {
            return Err(error.clone());
        }
        if state.sealed {
            return Err(ToolError::Failed("Computer VM has retired".into()));
        }
        state.pending = state.pending.checked_add(1).ok_or_else(|| {
            ToolError::CleanupUnconfirmed("Computer admission count overflow".into())
        })?;
        Ok(Receipt(Arc::new(Pending {
            gate: self.clone(),
            acknowledged: AtomicBool::new(false),
        })))
    }

    pub async fn seal(&self) -> Result<(), ToolError> {
        self.close_admission();
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            {
                let mut state = self.state.lock().unwrap();
                state.sealed = true;
                if state.pending == 0 {
                    return state.failure.clone().map_or(Ok(()), Err);
                }
            }
            changed.await;
        }
    }

    pub fn close_admission(&self) {
        self.state.lock().unwrap().sealed = true;
        self.changed.notify_waiters();
    }

    pub(super) async fn wait_closed(&self) {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            {
                let state = self.state.lock().unwrap();
                if state.sealed || state.failure.is_some() {
                    return;
                }
            }
            changed.await;
        }
    }

    fn resolve(&self, failure: Option<ToolError>) {
        let mut state = self.state.lock().unwrap();
        if let Some(error) = failure {
            state.failure.get_or_insert(error);
        }
        state.pending = state.pending.checked_sub(1).expect("registered admission");
        drop(state);
        self.changed.notify_waiters();
    }
}

impl ReplAdmission for Gate {
    fn seal(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), ToolError>> + Send + '_>>
    {
        Box::pin(Gate::seal(self))
    }
}

impl Receipt {
    /// The original Agent journal committed T1; its Run ticket still owns work.
    pub fn agent_dispatched(&self) {
        self.acknowledge();
    }

    /// The complete call returned, including a refusal which cannot dispatch later.
    pub fn complete_call(&self) {
        self.acknowledge();
    }

    /// An attached Host service transferred its unpolled effect to an existing
    /// resource ticket and worker. This is not an Agent ToolDispatched fact.
    fn host_transferred(&self) {
        self.acknowledge();
    }

    fn acknowledge(&self) {
        if !self.0.acknowledged.swap(true, Ordering::AcqRel) {
            self.0.gate.resolve(None);
        }
    }

    pub fn fail(&self, error: ToolError) {
        if !self.0.acknowledged.swap(true, Ordering::AcqRel) {
            self.0.gate.resolve(Some(error));
        }
    }
}

/// A native call can return a confirmed result before its exact RPC replies.
/// This slot carries only those owned futures, never another grant or Run.
struct Settlement {
    pending: Mutex<Option<Vec<CheckedSettlementFuture>>>,
}
impl OperationSettlement for Settlement {
    fn retain(&self, pending: SettlementFuture) -> Result<(), (ToolError, SettlementFuture)> {
        let mut slot = self.pending.lock().unwrap();
        match slot.as_mut() {
            Some(retained) => {
                // Keep the original box in place if polling it unwinds.
                retained.push(Box::pin(pending.map(|()| Ok(()))));
                Ok(())
            }
            None => Err((
                ToolError::Failed("Computer call settlement is closed".into()),
                pending,
            )),
        }
    }
    fn retain_checked(
        &self,
        pending: CheckedSettlementFuture,
    ) -> Result<(), (ToolError, CheckedSettlementFuture)> {
        let mut slot = self.pending.lock().expect("settlement state lock poisoned");
        match slot.as_mut() {
            Some(retained) => {
                retained.push(pending);
                Ok(())
            }
            None => Err((
                ToolError::Failed("Computer call settlement is closed".into()),
                pending,
            )),
        }
    }
}

/// Original effect custody while the journal is still committing its outcome.
/// Drop transfers the same RPCs to tracked cleanup rather than dropping them.
pub(super) struct Operation {
    native: Option<Arc<NativeSession>>,
    root: Option<Arc<maka_event_log::RootStore>>,
    settlement: Arc<Settlement>,
    lease: Option<InvocationEffectLease>,
    ticket: Option<Ticket>,
    tasks: tokio_util::task::TaskTracker,
    stopping: tokio_util::sync::CancellationToken,
}
impl Operation {
    pub fn new(
        owner: &Arc<super::Computer>,
        lease: InvocationEffectLease,
        native: &Arc<NativeSession>,
    ) -> Result<Self, ToolError> {
        if owner.stopping.is_cancelled() {
            lease.finish(Ok(())); // No journal dispatch or native effect was admitted.
            return Err(ToolError::Failed("Computer Host service is closed".into()));
        }
        let mut ticket = match owner.resources.reserve() {
            Ok(ticket) => ticket,
            Err(error) => {
                // The native call has not reached journal admission.
                lease.finish(Ok(()));
                return Err(error);
            }
        };
        ticket.start();
        Ok(Self {
            native: Some(native.clone()),
            root: Some(owner.store.clone()),
            settlement: Arc::new(Settlement {
                pending: Mutex::new(Some(Vec::new())),
            }),
            lease: Some(lease),
            ticket: Some(ticket),
            tasks: owner.tasks.clone(),
            stopping: owner.stopping.clone(),
        })
    }

    pub fn handoff(&self) -> Arc<dyn OperationSettlement> {
        self.settlement.clone()
    }

    pub fn complete(mut self, journal_failure: Option<ToolError>) {
        self.transfer(journal_failure);
    }

    fn transfer(&mut self, journal_failure: Option<ToolError>) {
        let Some(lease) = self.lease.take() else {
            return;
        };
        let pending = self
            .settlement
            .pending
            .lock()
            .unwrap()
            .take()
            .expect("original settlement owner");
        let mut custody = PendingSettlement {
            pending: Some(pending.into_iter().map(Some).collect()),
            native: self.native.take(),
            root: self.root.take(),
            lease: Some(lease),
            ticket: self.ticket.take(),
            stopping: self.stopping.clone(),
            failure: None,
            observations: Vec::new(),
        };
        if let Some(failure) = journal_failure {
            custody.fail(failure);
        }
        if custody.pending.as_ref().unwrap().is_empty() {
            custody.finish();
        } else {
            self.tasks.spawn(custody.run());
        }
    }
}
impl Drop for Operation {
    fn drop(&mut self) {
        if self.lease.is_some() {
            self.transfer(Some(ToolError::CleanupUnconfirmed(
                "Computer journal owner disappeared before settlement".into(),
            )));
        }
    }
}

struct PendingSettlement {
    pending: Option<Vec<Option<CheckedSettlementFuture>>>,
    native: Option<Arc<NativeSession>>,
    root: Option<Arc<maka_event_log::RootStore>>,
    lease: Option<InvocationEffectLease>,
    ticket: Option<Ticket>,
    stopping: tokio_util::sync::CancellationToken,
    failure: Option<String>,
    observations: Vec<ToolError>,
}
impl PendingSettlement {
    fn fail(&mut self, observation: ToolError) {
        let failure = observation.to_string();
        self.observations.push(observation);
        self.stopping.cancel();
        if let Some(lease) = self.lease.take() {
            lease.retain_unconfirmed(failure.clone());
        }
        if let Some(ticket) = &self.ticket {
            ticket.record_failure(failure.clone());
        }
        self.failure.get_or_insert(failure);
    }

    fn finish(&mut self) {
        // Only a failure-free terminal set releases the original invocation.
        // An empty list never overrides existing uncertainty: on failure the
        // actual native owner and typed observations remain unconfirmed.
        self.pending.take();
        if let Some(lease) = self.lease.take() {
            lease.finish(Ok(()));
        }
        if let Some(ticket) = self.ticket.take() {
            match self.failure.take() {
                Some(failure) => ticket.unconfirmed(
                    failure,
                    (
                        self.native.take(),
                        self.root.take(),
                        std::mem::take(&mut self.observations),
                    ),
                ),
                None => ticket.complete(Ok(())),
            }
        }
    }

    async fn run(mut self) {
        loop {
            let pending = self.pending.as_mut().expect("owned settlement futures");
            if pending.iter().all(Option::is_none) {
                break;
            }
            // Poll every original retained RPC on each wake. A later failure
            // must fence admission while an earlier RPC is still pending.
            let result = AssertUnwindSafe(std::future::poll_fn(|context| {
                for (index, slot) in pending.iter_mut().enumerate() {
                    if let Some(future) = slot
                        && let std::task::Poll::Ready(result) = future.as_mut().poll(context)
                    {
                        return std::task::Poll::Ready((index, result));
                    }
                }
                std::task::Poll::Pending
            }))
            .catch_unwind()
            .await;
            match result {
                Ok((index, result)) => {
                    // Drop only the actual terminal box; it is never re-polled
                    // or retained as evidence that another RPC has drained.
                    self.pending.as_mut().expect("owned settlement futures")[index].take();
                    if let Err(error) = result {
                        self.fail(error);
                    }
                }
                Err(_) => {
                    self.fail(ToolError::CleanupUnconfirmed(
                        "Computer RPC settlement worker panicked".into(),
                    ));
                    return; // Drop retains the original nonterminal boxes.
                }
            }
        }
        self.finish();
    }
}
impl Drop for PendingSettlement {
    fn drop(&mut self) {
        if self.pending.is_some() {
            self.fail(ToolError::CleanupUnconfirmed(
                "Computer RPC settlement owner disappeared".into(),
            ));
            if let Some(ticket) = self.ticket.take() {
                ticket.unconfirmed(
                    self.failure.take().unwrap(),
                    (
                        self.pending.take().unwrap(),
                        self.native.take(),
                        self.root.take(),
                        std::mem::take(&mut self.observations),
                    ),
                );
            }
        }
    }
}

#[derive(Clone)]
struct HostEffects {
    owner: std::sync::Weak<super::Computer>,
    native: std::sync::Weak<NativeSession>,
    gate: Arc<Gate>,
    popup: Option<Arc<super::browser_access::Attachment>>,
}
#[cfg(test)]
pub(super) fn host_effects(
    owner: &Arc<super::Computer>,
    gate: Arc<Gate>,
    native: &Arc<NativeSession>,
) -> Arc<dyn BrowserHostEffects> {
    Arc::new(HostEffects {
        owner: Arc::downgrade(owner),
        native: Arc::downgrade(native),
        gate,
        popup: None,
    })
}
pub(super) fn host_effects_with_lease_children(
    owner: &Arc<super::Computer>,
    gate: Arc<Gate>,
    native: &Arc<NativeSession>,
    popup: Arc<super::browser_access::Attachment>,
) -> Arc<dyn BrowserHostEffects> {
    Arc::new(HostEffects {
        owner: Arc::downgrade(owner),
        native: Arc::downgrade(native),
        gate,
        popup: Some(popup),
    })
}
// Constructed only after HostEffects::reserve starts the actual ticket.
// This scope carries no Agent operation ID, Run, site permission, or new store.
struct AttachedEffectScope {
    attachment: Arc<super::browser_access::Attachment>,
    gate: Arc<Gate>,
    active: tokio_util::sync::CancellationToken,
}
impl BrowserEffectScope for AttachedEffectScope {
    fn check_session_preparation(
        &self,
        binding: BrowserPreparationBinding,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> maka_computer_use::AuthorizationFuture {
        let attachment = self.attachment.clone();
        let gate = self.gate.clone();
        let active = self.active.clone();
        Box::pin(async move {
            if active.is_cancelled() {
                return Err(ToolError::Failed(
                    "Browser service effect has finished".into(),
                ));
            }
            gate.check_open()?;
            attachment
                .effect_preparation_current(&binding, &cancellation)
                .await?;
            if active.is_cancelled() {
                return Err(ToolError::Failed(
                    "Browser service effect has finished".into(),
                ));
            }
            gate.check_open()
        })
    }
}

struct HostAdmission {
    owner: Arc<super::Computer>,
    native: Arc<NativeSession>,
    receipt: Receipt,
    ticket: Ticket,
}
impl HostEffects {
    fn reserve(&self) -> Result<HostAdmission, ToolError> {
        let owner = self
            .owner
            .upgrade()
            .ok_or_else(|| ToolError::Failed("Computer Host service is closed".into()))?;
        if owner.stopping.is_cancelled() {
            return Err(ToolError::Failed("Computer Host service is closed".into()));
        }
        let native = self.native.upgrade().ok_or_else(|| {
            ToolError::Failed("Computer native epoch custody is unavailable".into())
        })?;
        let receipt = self.gate.register()?;
        let mut ticket = match owner.resources.reserve() {
            Ok(ticket) => ticket,
            Err(error) => {
                receipt.complete_call();
                return Err(error);
            }
        };
        ticket.start();
        Ok(HostAdmission {
            owner,
            native,
            receipt,
            ticket,
        })
    }

    fn launch(
        admitted: HostAdmission,
        unpolled: HostEffectFuture,
        uncertainty: Option<HostUncertaintyFuture>,
        completed: Option<tokio::sync::oneshot::Sender<Result<(), ToolError>>>,
        preparation_active: Option<tokio_util::sync::CancellationToken>,
    ) {
        let HostAdmission {
            owner,
            native,
            receipt,
            ticket,
        } = admitted;
        let custody = HostCustody {
            pending: Some(unpolled),
            native: Some(native),
            uncertainty,
            failure: None,
            observations: Vec::new(),
            ticket: Some(ticket),
            stopping: owner.stopping.clone(),
            root: Some(owner.store.clone()),
            completed,
            preparation_active,
        };
        owner.tasks.spawn(custody.run());
        receipt.host_transferred();
    }

    fn admit_scoped(
        &self,
        factory: HostEffectFactory,
        uncertainty: Option<HostUncertaintyFuture>,
    ) -> Result<(), ToolError> {
        let attachment = self.popup.clone().ok_or_else(|| {
            ToolError::Failed("Browser service preparation authority is unavailable".into())
        })?;
        let admitted = self.reserve()?;
        let active = tokio_util::sync::CancellationToken::new();
        let scope: Arc<dyn BrowserEffectScope> = Arc::new(AttachedEffectScope {
            attachment,
            gate: self.gate.clone(),
            active: active.clone(),
        });
        let lifetime = active.clone();
        let work: HostEffectFuture = Box::pin(async move {
            let _lifetime = lifetime.drop_guard();
            factory(scope).await
        });
        Self::launch(admitted, work, uncertainty, None, Some(active));
        Ok(())
    }

    fn admit(
        &self,
        unpolled: HostEffectFuture,
        uncertainty: Option<HostUncertaintyFuture>,
    ) -> Result<(), ToolError> {
        let admitted = self.reserve()?;
        Self::launch(admitted, unpolled, uncertainty, None, None);
        Ok(())
    }
}
impl BrowserHostEffects for HostEffects {
    fn spawn_scoped_guarded(
        &self,
        factory: HostEffectFactory,
        _rejected: Box<dyn FnOnce(ToolError) + Send>,
    ) -> Result<(), ToolError> {
        self.admit_scoped(factory, None)
    }

    fn spawn_scoped_custodied(
        &self,
        factory: HostEffectFactory,
        uncertainty: HostUncertaintyFuture,
        _rejected: Box<dyn FnOnce(ToolError) + Send>,
    ) -> Result<(), ToolError> {
        self.admit_scoped(factory, Some(uncertainty))
    }

    fn supports_lease_children(&self) -> bool {
        self.popup.is_some()
            && self.owner.upgrade().is_some_and(|owner| {
                owner.popup_provenance.is_some()
                    && (owner.configuration.browser_preparation.popup
                        || !owner
                            .configuration
                            .browser_preparation
                            .request_headers
                            .is_empty())
            })
            && self.native.upgrade().is_some()
    }

    fn adopt_lease_child(
        &self,
        request: maka_computer_use::BrowserLeaseChildRequest,
    ) -> HostEffectFuture {
        let effects = self.clone();
        Box::pin(async move {
            let attachment = effects.popup.clone().ok_or_else(|| {
                ToolError::Failed("Host lease-child authorization is unavailable".into())
            })?;
            let owner = effects
                .owner
                .upgrade()
                .ok_or_else(|| ToolError::Failed("Computer Host service is closed".into()))?;
            if !owner.configuration.browser_preparation.popup
                && owner
                    .configuration
                    .browser_preparation
                    .request_headers
                    .is_empty()
            {
                return Err(ToolError::Failed(
                    "Maka popup adoption is disabled by Host preparation policy".into(),
                ));
            }
            let admitted = effects.reserve()?;
            let (completed, result) = tokio::sync::oneshot::channel();
            let owner = admitted.owner.clone();
            let native = admitted.native.clone();
            let gate = effects.gate.clone();
            let work = Box::pin(super::browser_popup::run(
                owner,
                native,
                attachment,
                gate,
                request,
                Arc::new(effects),
            ));
            Self::launch(admitted, work, None, Some(completed), None);
            result.await.map_err(|_| {
                ToolError::CleanupUnconfirmed(
                    "Host lease-child service lost its terminal observation; do not replay".into(),
                )
            })?
        })
    }

    fn spawn(&self, unpolled: HostEffectFuture) -> Result<(), ToolError> {
        self.admit(unpolled, None)
    }
    fn spawn_custodied(
        &self,
        unpolled: HostEffectFuture,
        uncertainty: HostUncertaintyFuture,
        _rejected: Box<dyn FnOnce(ToolError) + Send>,
    ) -> Result<(), ToolError> {
        // Admission is synchronous. A refusal returns before either future is
        // polled; the caller still owns its normal rejection cleanup.
        self.admit(unpolled, Some(uncertainty))
    }
}
struct HostServiceSettlement(HostEffects);
// Retaining existing work mints no AttachedEffectScope. Its original issuing
// effect retains its own preparation lifetime, independent of these drains.
impl OperationSettlement for HostServiceSettlement {
    fn retain(&self, pending: SettlementFuture) -> Result<(), (ToolError, SettlementFuture)> {
        let admitted = match self.0.reserve() {
            Ok(admitted) => admitted,
            Err(error) => return Err((error, pending)),
        };
        HostEffects::launch(
            admitted,
            Box::pin(pending.map(|()| Ok(()))),
            None,
            None,
            None,
        );
        Ok(())
    }
    fn retain_checked(
        &self,
        pending: CheckedSettlementFuture,
    ) -> Result<(), (ToolError, CheckedSettlementFuture)> {
        let admitted = match self.0.reserve() {
            Ok(admitted) => admitted,
            Err(error) => return Err((error, pending)),
        };
        HostEffects::launch(admitted, pending, None, None, None);
        Ok(())
    }
}
pub(super) fn host_service_settlement(
    owner: &Arc<super::Computer>,
    native: &Arc<NativeSession>,
    gate: Arc<Gate>,
) -> Arc<dyn OperationSettlement> {
    Arc::new(HostServiceSettlement(HostEffects {
        owner: Arc::downgrade(owner),
        native: Arc::downgrade(native),
        gate,
        popup: None,
    }))
}

struct HostCustody {
    pending: Option<HostEffectFuture>,
    native: Option<Arc<NativeSession>>,
    uncertainty: Option<HostUncertaintyFuture>,
    failure: Option<String>,
    observations: Vec<ToolError>,
    ticket: Option<Ticket>,
    stopping: tokio_util::sync::CancellationToken,
    root: Option<Arc<maka_event_log::RootStore>>,
    completed: Option<tokio::sync::oneshot::Sender<Result<(), ToolError>>>,
    preparation_active: Option<tokio_util::sync::CancellationToken>,
}
enum HostObservation {
    Completed(Result<(), ToolError>),
    Uncertain(ToolError),
}
fn outcome_unconfirmed(error: &ToolError) -> bool {
    matches!(
        error,
        ToolError::Persistence(_)
            | ToolError::CleanupUnconfirmed(_)
            | ToolError::OutcomeUnknown(_)
            | ToolError::OperationUnknown { .. }
            | ToolError::OperationCleanupUnconfirmed { .. }
    )
}
impl HostCustody {
    fn publish(&mut self, result: Result<(), ToolError>) {
        if let Some(completed) = self.completed.take() {
            let _ = completed.send(result);
        }
    }

    fn fail(&mut self, observation: ToolError) {
        if let Some(active) = &self.preparation_active {
            active.cancel();
        }
        let error = observation.to_string();
        self.observations.push(observation);
        self.stopping.cancel();
        if let Some(ticket) = &self.ticket {
            ticket.record_failure(error.clone());
        }
        self.failure.get_or_insert(error);
    }
    async fn run(mut self) {
        loop {
            let result = {
                let pending = self.pending.as_mut().expect("owned Host effect future");
                let uncertainty = self.uncertainty.as_mut();
                AssertUnwindSafe(async {
                    match uncertainty {
                        Some(uncertainty) => tokio::select! { biased;
                            error = uncertainty.as_mut() => HostObservation::Uncertain(error),
                            result = pending.as_mut() => HostObservation::Completed(result),
                        },
                        None => HostObservation::Completed(pending.as_mut().await),
                    }
                })
                .catch_unwind()
                .await
            };
            match result {
                Ok(HostObservation::Uncertain(error)) => {
                    self.uncertainty.take();
                    self.fail(error);
                    // Keep polling the same admitted future and its original
                    // started ticket. Uncertainty is not physical settlement.
                }
                Ok(HostObservation::Completed(result)) => {
                    if let Err(error) = &result
                        && outcome_unconfirmed(error)
                    {
                        self.fail(error.clone());
                        // A terminal error must never be re-polled as a drain.
                        // Keep actual independent native Session/Driver/controller
                        // custody; neither this box nor an empty list is proof.
                        self.pending.take();
                        self.uncertainty.take();
                        self.ticket
                            .take()
                            .expect("owned Host effect ticket")
                            .unconfirmed(
                                error.to_string(),
                                (
                                    self.native.take(),
                                    self.root.take(),
                                    std::mem::take(&mut self.observations),
                                ),
                            );
                        self.publish(Err(error.clone()));
                        return;
                    }
                    self.pending.take();
                    self.uncertainty.take();
                    self.ticket
                        .take()
                        .expect("owned Host effect ticket")
                        .complete(self.failure.take().map_or(Ok(()), Err));
                    self.publish(result);
                    return;
                }
                Err(_) => return, // Drop retains the original opaque futures.
            }
        }
    }
}
impl Drop for HostCustody {
    fn drop(&mut self) {
        if let Some(active) = self.preparation_active.take() {
            active.cancel();
        }
        if let Some(pending) = self.pending.take() {
            self.stopping.cancel();
            if let Some(ticket) = self.ticket.take() {
                ticket.unconfirmed(
                    "Computer Host-service effect owner disappeared".into(),
                    (
                        pending,
                        self.uncertainty.take(),
                        self.native.take(),
                        self.root.take(),
                        std::mem::take(&mut self.observations),
                    ),
                );
            }
        }
    }
}

impl Drop for Pending {
    fn drop(&mut self) {
        if !self.acknowledged.load(Ordering::Acquire) {
            self.gate.resolve(Some(ToolError::CleanupUnconfirmed(
                "Computer admission owner disappeared before dispatch was confirmed".into(),
            )));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::poll;
    use maka_agent_facts::{
        event::{
            CommitError, CommitFuture, EventSink, EventWrite, Fact, Invocation, InvocationInput,
            RuntimeEvent, ToolOutcome,
        },
        tool_call::ToolCallIdentity,
        tools::{PreparedEffect, ToolJournal},
    };
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    use tokio_util::sync::CancellationToken;

    struct Fixture {
        directory: tempfile::TempDir,
        owner: Arc<super::super::Computer>,
        store: Arc<maka_event_log::SessionStore>,
        invocation: Invocation,
        parent: maka_event_log::root_store::SessionExecutionLease,
        effects: maka_event_log::root_store::InvocationEffects,
        native: Arc<NativeSession>,
    }
    impl Fixture {
        async fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let root_owner = maka_event_log::root::RootOwner::create(
                &directory.path().join("root"),
                &maka_event_log::root::RootNamespaces {
                    ownership: directory.path().join("ownership"),
                    control: directory.path().join("control"),
                },
            )
            .unwrap();
            let root = Arc::new(
                maka_event_log::RootStore::open(Arc::new(root_owner))
                    .await
                    .unwrap(),
            );
            let session = root
                .create_session("session", "fixture", &json!({}), 1)
                .await
                .unwrap();
            let prepared = session.execution_scope(None).await.unwrap();
            let store = Arc::new(prepared.store());
            let invocation = Invocation {
                session_id: "session".into(),
                turn_id: "turn".into(),
                run_id: "run".into(),
                invocation_id: "invocation".into(),
            };
            let (parent, effects) = prepared
                .accept_invocation(invocation.clone(), CancellationToken::new())
                .unwrap();
            store
                .append(
                    &EventWrite::plain(RuntimeEvent::new(
                        invocation.clone(),
                        Fact::InvocationOpened {
                            configuration: None,
                            input: InvocationInput::Code {
                                source: "fixture".into(),
                            },
                        },
                    ))
                    .unwrap(),
                )
                .await
                .unwrap();
            let tasks = tokio_util::task::TaskTracker::new();
            let owner = Arc::new(super::super::Computer {
                store: root,
                configuration: Default::default(),
                sessions: super::super::sessions::Sessions::with_audio(false, tasks.clone()),
                resources: Arc::default(),
                stopping: CancellationToken::new(),
                tasks,
                popup_provenance: None,
                origin: maka_agent_facts::tool_call::ToolOrigin::HostSdk {
                    package_id: "fixture".into(),
                    entry_id: "fixture".into(),
                    activation: "fixture".into(),
                    parent: None,
                },
            });
            let native_owner = maka_computer_use::SessionOwner::new(owner.sessions.driver.clone());
            let native = Arc::new(tokio::sync::Mutex::new(native_owner.new_epoch().unwrap()));
            Self {
                directory,
                native,
                owner,
                store,
                invocation,
                parent,
                effects,
            }
        }
        fn lease(&self) -> InvocationEffectLease {
            self.owner
                .store
                .fork_invocation_effect(
                    self.store.clone().execution_custody().unwrap().as_ref(),
                    &self.invocation,
                )
                .unwrap()
        }
        async fn facts(&self) -> Vec<Fact> {
            let through = self
                .store
                .observe_session::<serde_json::Value>("session")
                .await
                .unwrap()
                .unwrap()
                .through_sequence;
            self.store
                .session_events("session", 0, through, 32, 1024 * 1024)
                .await
                .unwrap()
                .events
                .into_iter()
                .map(|stored| stored.event.fact.clone())
                .collect()
        }
        async fn close(self, unconfirmed: bool) {
            self.owner.tasks.close();
            self.owner.tasks.wait().await;
            self.owner.sessions.close().await.unwrap();
            if unconfirmed {
                self.parent.retain_unconfirmed();
            } else {
                self.parent.finish();
            }
            assert_eq!(self.owner.store.shutdown().await.is_err(), unconfirmed);
            if unconfirmed {
                let _ = self.directory.keep();
            }
        }
    }

    struct FailOutcome(Arc<maka_event_log::SessionStore>);
    impl EventSink for FailOutcome {
        fn commit(self: Arc<Self>, write: EventWrite) -> CommitFuture {
            Box::pin(async move {
                self.commit_with_prefix(&[], write)
                    .await
                    .map(|receipt| receipt.last_sequence)
            })
        }

        fn commit_with_prefix(
            self: Arc<Self>,
            prefix: &[EventWrite],
            last: EventWrite,
        ) -> maka_agent_facts::event::PrefixCommitFuture {
            let mut events = prefix.to_vec();
            events.push(last);
            Box::pin(async move {
                if matches!(
                    &events.last().expect("last event is present").event().fact,
                    Fact::ToolSettled { .. }
                ) {
                    Err(CommitError::OutcomeUnknown(
                        "fixture T2 commit was not observed".into(),
                    ))
                } else {
                    self.0
                        .append_batch(&events)
                        .await
                        .map(maka_agent_facts::event::PrefixReceipt::from_sequences)
                }
            })
        }
    }

    struct DropWitness(Arc<AtomicBool>);
    impl Drop for DropWitness {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn durable_closed_result_retains_same_run_until_original_rpc_is_ready() {
        let fixture = Fixture::new().await;
        let operation = Operation::new(&fixture.owner, fixture.lease(), &fixture.native).unwrap();
        let handoff = operation.handoff();
        let release = CancellationToken::new();
        let _release_on_failure = release.clone().drop_guard();
        let started = CancellationToken::new();
        let sent = Arc::new(AtomicUsize::new(0));
        let effect_sent = sent.clone();
        let pending_release = release.clone();
        let pending_started = started.clone();
        let pending = Box::pin(async move {
            pending_started.cancel();
            pending_release.cancelled().await;
            // This is the same RPC's late rejection after exact Closed. Its
            // Ready state settles transport custody without reversing Closed.
            let _late_reply: Result<(), ToolError> =
                Err(ToolError::Failed("late RPC rejection".into()));
        });
        let result = ToolJournal::new(fixture.store.clone(), fixture.invocation.clone())
            .invoke_prepared_output(
                "dialog".into(),
                ToolCallIdentity::standalone("call".into()),
                "fixture_dialog".into(),
                json!({}),
                None,
                CancellationToken::new(),
                PreparedEffect::new(move |_| {
                    Box::pin(async move {
                        effect_sent.fetch_add(1, AtomicOrdering::SeqCst);
                        if let Err((error, pending)) = handoff.retain(pending) {
                            pending.await;
                            return Err(error);
                        }
                        Ok(json!({"closed":true}).into())
                    })
                }),
            )
            .await
            .unwrap();
        assert_eq!(result.into_json(), json!({"closed":true}));
        operation.complete(None);
        started.cancelled().await;
        let facts = fixture.facts().await;
        assert_eq!(
            facts
                .iter()
                .filter(|fact| matches!(fact, Fact::ToolDispatched { .. }))
                .count(),
            1
        );
        assert!(facts.iter().any(|fact| matches!(
            fact,
            Fact::ToolSettled {
                outcome: ToolOutcome::Succeeded { .. },
                ..
            }
        )));
        let mut run = Box::pin(fixture.effects.settle());
        let mut resources = Box::pin(fixture.owner.resources.settle());
        assert!(poll!(&mut run).is_pending());
        assert!(poll!(&mut resources).is_pending());
        release.cancel();
        run.await.unwrap();
        resources.await.unwrap();
        assert_eq!(sent.load(AtomicOrdering::SeqCst), 1);
        fixture.close(false).await;
    }

    #[tokio::test]
    async fn journal_failure_or_lost_owner_keeps_same_rpc_and_quarantines_original_authority() {
        for lost_owner in [false, true] {
            let fixture = Fixture::new().await;
            let operation =
                Operation::new(&fixture.owner, fixture.lease(), &fixture.native).unwrap();
            let handoff = operation.handoff();
            let release = CancellationToken::new();
            let _release_on_failure = release.clone().drop_guard();
            let dropped = Arc::new(AtomicBool::new(false));
            let witness = DropWitness(dropped.clone());
            let pending_release = release.clone();
            let pending = Box::pin(async move {
                let _witness = witness;
                pending_release.cancelled().await;
            });
            let sink: Arc<dyn EventSink> = if lost_owner {
                fixture.store.clone()
            } else {
                Arc::new(FailOutcome(fixture.store.clone()))
            };
            let result = ToolJournal::new(sink, fixture.invocation.clone())
                .invoke_prepared_output(
                    "dialog".into(),
                    ToolCallIdentity::standalone("call".into()),
                    "fixture_dialog".into(),
                    json!({}),
                    None,
                    CancellationToken::new(),
                    PreparedEffect::new(move |_| {
                        Box::pin(async move {
                            if let Err((error, pending)) = handoff.retain(pending) {
                                pending.await;
                                return Err(error);
                            }
                            Ok(json!({"closed":true}).into())
                        })
                    }),
                )
                .await;
            if lost_owner {
                assert!(result.is_ok());
                drop(operation);
            } else {
                assert!(matches!(result, Err(ToolError::Persistence(_))));
                operation.complete(result.as_ref().err().cloned());
            }
            assert!(fixture.owner.stopping.is_cancelled());
            assert!(!dropped.load(Ordering::SeqCst));
            let mut resources = Box::pin(fixture.owner.resources.settle());
            assert!(poll!(&mut resources).is_pending());
            release.cancel();
            assert!(resources.await.is_err());
            assert!(fixture.effects.settle().await.is_err());
            assert!(dropped.load(Ordering::SeqCst));
            fixture.close(true).await;
        }
    }

    #[tokio::test]
    async fn lost_physical_worker_retains_rpc_without_a_computer_resource_cycle() {
        let fixture = Fixture::new().await;
        let mut ticket = fixture.owner.resources.reserve().unwrap();
        ticket.start();
        let dropped = Arc::new(AtomicBool::new(false));
        let witness = DropWitness(dropped.clone());
        let custody = PendingSettlement {
            native: Some(fixture.native.clone()),
            root: Some(fixture.owner.store.clone()),
            pending: Some(vec![Some(Box::pin(async move {
                let _witness = witness;
                std::future::pending::<()>().await;
                Ok(())
            }))]),
            lease: Some(fixture.lease()),
            ticket: Some(ticket),
            stopping: fixture.owner.stopping.clone(),
            failure: None,
            observations: Vec::new(),
        };
        drop(custody);
        assert!(!dropped.load(Ordering::SeqCst));
        assert!(fixture.owner.resources.settle().await.is_err());
        assert!(fixture.effects.settle().await.is_err());
        let resources = fixture.owner.resources.clone();
        fixture.close(true).await;
        assert!(!dropped.load(Ordering::SeqCst));
        drop(resources);
        assert!(dropped.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn automatic_host_effect_transfers_resource_custody_without_agent_dispatch() {
        let fixture = Fixture::new().await;
        let gate = Arc::new(Gate::default());
        let host = host_effects(&fixture.owner, gate.clone(), &fixture.native);
        let release = CancellationToken::new();
        let _release_on_failure = release.clone().drop_guard();
        let started = CancellationToken::new();
        let sent = Arc::new(AtomicUsize::new(0));
        let effect_sent = sent.clone();
        let effect_started = started.clone();
        let pending_release = release.clone();
        host.spawn(Box::pin(async move {
            effect_sent.fetch_add(1, AtomicOrdering::SeqCst);
            effect_started.cancel();
            pending_release.cancelled().await;
            Ok(())
        }))
        .unwrap();
        assert!(!fixture.owner.resources.is_idle());
        gate.seal().await.unwrap(); // Resource transfer, not RPC completion.
        started.cancelled().await;
        fixture.effects.settle().await.unwrap(); // No fake Run effect ticket.
        let rejected_sent = sent.clone();
        assert!(
            host.spawn(Box::pin(async move {
                rejected_sent.fetch_add(1, AtomicOrdering::SeqCst);
                Ok(())
            }))
            .is_err()
        );
        assert_eq!(sent.load(AtomicOrdering::SeqCst), 1);
        assert!(
            !fixture
                .facts()
                .await
                .iter()
                .any(|fact| matches!(fact, Fact::ToolDispatched { .. }))
        );
        let mut resources = Box::pin(fixture.owner.resources.settle());
        assert!(poll!(&mut resources).is_pending());
        release.cancel();
        resources.await.unwrap();
        assert_eq!(sent.load(AtomicOrdering::SeqCst), 1);
        fixture.close(false).await;
    }

    #[tokio::test]
    async fn panicking_host_service_settlement_retains_the_original_rpc_box() {
        struct Panicking {
            polled: CancellationToken,
            _witness: DropWitness,
        }
        impl std::future::Future for Panicking {
            type Output = ();
            fn poll(
                self: std::pin::Pin<&mut Self>,
                _: &mut std::task::Context<'_>,
            ) -> std::task::Poll<()> {
                self.polled.cancel();
                panic!("fixture Host-service RPC poll panicked");
            }
        }
        let fixture = Fixture::new().await;
        let gate = Arc::new(Gate::default());
        let handoff = host_service_settlement(&fixture.owner, &fixture.native, gate.clone());
        let polled = CancellationToken::new();
        let dropped = Arc::new(AtomicBool::new(false));
        assert!(
            handoff
                .retain(Box::pin(Panicking {
                    polled: polled.clone(),
                    _witness: DropWitness(dropped.clone()),
                }))
                .is_ok()
        );
        gate.seal().await.unwrap();
        polled.cancelled().await;
        assert!(fixture.owner.resources.settle().await.is_err());
        assert!(fixture.owner.stopping.is_cancelled());
        assert!(!dropped.load(Ordering::SeqCst));
        fixture.effects.settle().await.unwrap();
        assert!(
            !fixture
                .facts()
                .await
                .iter()
                .any(|fact| matches!(fact, Fact::ToolDispatched { .. }))
        );
        let resources = fixture.owner.resources.clone();
        fixture.close(true).await;
        assert!(!dropped.load(Ordering::SeqCst));
        drop(resources);
        assert!(dropped.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn panicking_rpc_poll_preserves_its_box_and_the_committed_closed_result() {
        struct Panicking {
            polled: CancellationToken,
            _witness: DropWitness,
        }
        impl std::future::Future for Panicking {
            type Output = ();
            fn poll(
                self: std::pin::Pin<&mut Self>,
                _: &mut std::task::Context<'_>,
            ) -> std::task::Poll<()> {
                self.polled.cancel();
                panic!("fixture RPC poll panicked");
            }
        }
        let fixture = Fixture::new().await;
        let operation = Operation::new(&fixture.owner, fixture.lease(), &fixture.native).unwrap();
        let handoff = operation.handoff();
        let polled = CancellationToken::new();
        let dropped = Arc::new(AtomicBool::new(false));
        let pending = Box::pin(Panicking {
            polled: polled.clone(),
            _witness: DropWitness(dropped.clone()),
        });
        ToolJournal::new(fixture.store.clone(), fixture.invocation.clone())
            .invoke_prepared_output(
                "dialog".into(),
                ToolCallIdentity::standalone("call".into()),
                "fixture_dialog".into(),
                json!({}),
                None,
                CancellationToken::new(),
                PreparedEffect::new(move |_| {
                    Box::pin(async move {
                        if let Err((error, pending)) = handoff.retain(pending) {
                            pending.await;
                            return Err(error);
                        }
                        Ok(json!({"closed":true}).into())
                    })
                }),
            )
            .await
            .unwrap();
        operation.complete(None);
        polled.cancelled().await;
        assert!(fixture.owner.resources.settle().await.is_err());
        assert!(fixture.effects.settle().await.is_err());
        assert!(!dropped.load(Ordering::SeqCst));
        assert!(fixture.facts().await.iter().any(|fact| matches!(
            fact,
            Fact::ToolSettled {
                outcome: ToolOutcome::Succeeded { .. },
                ..
            }
        )));
        let resources = fixture.owner.resources.clone();
        fixture.close(true).await;
        assert!(!dropped.load(Ordering::SeqCst));
        drop(resources);
        assert!(dropped.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn sealed_vm_waits_for_original_admission_and_refuses_new_calls() {
        let gate = Arc::new(Gate::default());
        let first = gate.register().unwrap();
        let second = gate.register().unwrap();
        let second_observer = second.clone();
        let mut sealing = Box::pin(gate.seal());
        assert!(poll!(&mut sealing).is_pending());
        assert!(gate.register().is_err());
        first.acknowledge();
        drop(first);
        assert!(poll!(&mut sealing).is_pending());
        second_observer.acknowledge();
        second.acknowledge();
        drop(second);
        assert!(sealing.await.is_ok());
        drop(second_observer);
    }

    #[tokio::test]
    async fn lost_admission_reports_failure_after_other_preparations_settle() {
        let gate = Arc::new(Gate::default());
        let lost = gate.register().unwrap();
        let live = gate.register().unwrap();
        let mut sealing = Box::pin(gate.seal());
        assert!(poll!(&mut sealing).is_pending());
        drop(lost);
        assert!(poll!(&mut sealing).is_pending());
        live.acknowledge();
        assert!(matches!(
            sealing.await,
            Err(ToolError::CleanupUnconfirmed(_))
        ));
    }

    #[tokio::test]
    async fn unresolved_commit_failure_cannot_be_acknowledged_by_another_observer() {
        let gate = Arc::new(Gate::default());
        let receipt = gate.register().unwrap();
        let other = receipt.clone();
        receipt.fail(ToolError::Persistence("inner T1 commit uncertain".into()));
        other.acknowledge();
        assert!(matches!(gate.seal().await, Err(ToolError::Persistence(_))));
    }

    #[tokio::test]
    async fn real_custodied_host_effect_admits_the_original_ticket_before_polling() {
        let fixture = Fixture::new().await;
        let gate = Arc::new(Gate::default());
        let host = host_effects(&fixture.owner, gate.clone(), &fixture.native);
        let resources = Arc::downgrade(&fixture.owner.resources);
        let started = CancellationToken::new();
        let release = CancellationToken::new();
        let _release_on_failure = release.clone().drop_guard();
        let effect_started = started.clone();
        let effect_release = release.clone();
        host.spawn_custodied(
            Box::pin(async move {
                assert!(
                    !resources.upgrade().unwrap().is_idle(),
                    "real Host ticket must precede first poll"
                );
                effect_started.cancel();
                effect_release.cancelled().await;
                Ok(())
            }),
            Box::pin(std::future::pending::<ToolError>()),
            Box::new(|_| panic!("synchronous Host admission must not reject later")),
        )
        .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), started.cancelled())
            .await
            .expect("admitted Host future was not polled");
        gate.seal().await.unwrap();
        let mut resources = Box::pin(fixture.owner.resources.settle());
        assert!(
            poll!(&mut resources).is_pending(),
            "admission ACK is not the worker's settlement"
        );
        assert!(
            !fixture
                .facts()
                .await
                .iter()
                .any(|fact| matches!(fact, Fact::ToolDispatched { .. })),
            "automatic Host custody must not fabricate Agent T1"
        );
        release.cancel();
        resources.await.unwrap();
        fixture.effects.settle().await.unwrap();
        fixture.close(false).await;
    }

    #[tokio::test]
    async fn real_uncertainty_signal_fences_admission_but_drains_the_same_host_future() {
        let fixture = Fixture::new().await;
        let host = host_effects(&fixture.owner, Arc::default(), &fixture.native);
        let started = CancellationToken::new();
        let uncertain = CancellationToken::new();
        let release = CancellationToken::new();
        let _release_on_failure = release.clone().drop_guard();
        let calls = Arc::new(AtomicUsize::new(0));
        let dropped = Arc::new(AtomicBool::new(false));
        let pending_calls = calls.clone();
        let pending_started = started.clone();
        let pending_release = release.clone();
        let signal = uncertain.clone();
        let witness = DropWitness(dropped.clone());
        host.spawn_custodied(
            Box::pin(async move {
                let _witness = witness;
                pending_calls.fetch_add(1, AtomicOrdering::SeqCst);
                pending_started.cancel();
                pending_release.cancelled().await;
                Ok(())
            }),
            Box::pin(async move {
                signal.cancelled().await;
                ToolError::OutcomeUnknown("actual remote effect observation was lost".into())
            }),
            Box::new(|_| panic!("accepted effect cannot be rejected as unadmitted")),
        )
        .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), started.cancelled())
            .await
            .expect("admitted Host future was not polled");
        uncertain.cancel();
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            fixture.owner.stopping.cancelled(),
        )
        .await
        .expect("actual uncertainty was not recorded");
        let rejected_calls = calls.clone();
        assert!(
            host.spawn(Box::pin(async move {
                rejected_calls.fetch_add(1, AtomicOrdering::SeqCst);
                Ok(())
            }))
            .is_err(),
            "real owner uncertainty must fence new admission before polling"
        );
        assert_eq!(calls.load(AtomicOrdering::SeqCst), 1);
        assert!(
            matches!(
                Operation::new(&fixture.owner, fixture.lease(), &fixture.native),
                Err(ToolError::Failed(_))
            ),
            "uncertain real owner must refuse a fresh operation before native or journal dispatch"
        );
        assert!(
            !dropped.load(Ordering::SeqCst),
            "uncertainty cannot discard the original future"
        );
        let mut resources = Box::pin(fixture.owner.resources.settle());
        assert!(
            poll!(&mut resources).is_pending(),
            "same started ticket must wait for the late terminal reply"
        );
        release.cancel();
        assert!(
            resources.await.is_err(),
            "late success cannot erase sticky uncertainty"
        );
        assert!(dropped.load(Ordering::SeqCst));
        assert_eq!(
            calls.load(AtomicOrdering::SeqCst),
            1,
            "no replacement request was dispatched"
        );
        fixture.effects.settle().await.unwrap();
        fixture.close(false).await;
    }

    #[tokio::test]
    async fn ready_unknown_parks_the_actual_native_controller_without_repolling_completed_future() {
        struct ReadyUnknown(Arc<AtomicUsize>);
        impl std::future::Future for ReadyUnknown {
            type Output = Result<(), ToolError>;
            fn poll(
                self: std::pin::Pin<&mut Self>,
                _: &mut std::task::Context<'_>,
            ) -> std::task::Poll<Self::Output> {
                self.0.fetch_add(1, AtomicOrdering::SeqCst);
                std::task::Poll::Ready(Err(ToolError::OutcomeUnknown(
                    "native RPC replied while Chrome effect remains unknown".into(),
                )))
            }
        }
        let fixture = Fixture::new().await;
        let native_owner =
            maka_computer_use::SessionOwner::new(fixture.owner.sessions.driver.clone());
        let actual_native = Arc::new(tokio::sync::Mutex::new(native_owner.new_epoch().unwrap()));
        let original_native = Arc::downgrade(&actual_native);
        let host = host_effects(&fixture.owner, Arc::default(), &actual_native);
        let polls = Arc::new(AtomicUsize::new(0));
        host.spawn_custodied(
            Box::pin(ReadyUnknown(polls.clone())),
            Box::pin(std::future::pending::<ToolError>()),
            Box::new(|_| panic!("Host admission should succeed")),
        )
        .unwrap();
        drop(actual_native);
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            fixture.owner.stopping.cancelled(),
        )
        .await
        .unwrap();
        assert!(matches!(fixture.owner.resources.settle().await,
            Err(ToolError::CleanupUnconfirmed(message)) if message.contains("native RPC replied while Chrome effect remains unknown")));
        assert_eq!(
            polls.load(AtomicOrdering::SeqCst),
            1,
            "a Ready error cannot be polled again as physical drain"
        );
        assert!(
            original_native.upgrade().is_some(),
            "real independent native Session/Driver/controller custody was lost"
        );
        drop(host);
        fixture.effects.settle().await.unwrap();
        let resources = fixture.owner.resources.clone();
        fixture.close(false).await;
        assert!(
            original_native.upgrade().is_some(),
            "the failed resource ticket must own actual native custody independently of Computer"
        );
        drop(resources);
        assert!(
            original_native.upgrade().is_none(),
            "retained native custody must not introduce a Computer/resources cycle"
        );
    }

    #[tokio::test]
    async fn checked_rpc_uncertainty_quarantines_the_original_invocation_before_other_rpc_drains() {
        let fixture = Fixture::new().await;
        let operation = Operation::new(&fixture.owner, fixture.lease(), &fixture.native).unwrap();
        let handoff = operation.handoff();
        let fail_first = CancellationToken::new();
        let release_last = CancellationToken::new();
        let _release_on_failure = release_last.clone().drop_guard();
        let fail = fail_first.clone();
        let release = release_last.clone();
        let dropped = Arc::new(AtomicBool::new(false));
        let witness = DropWitness(dropped.clone());
        let first: CheckedSettlementFuture = Box::pin(async move {
            fail.cancelled().await;
            Err(ToolError::OutcomeUnknown(
                "required original RPC custody is unknown".into(),
            ))
        });
        let last: CheckedSettlementFuture = Box::pin(async move {
            let _witness = witness;
            release.cancelled().await;
            Ok(())
        });
        ToolJournal::new(fixture.store.clone(), fixture.invocation.clone())
            .invoke_prepared_output(
                "checked-operation".into(),
                ToolCallIdentity::standalone("checked-call".into()),
                "fixture_checked_settlement".into(),
                json!({}),
                None,
                CancellationToken::new(),
                PreparedEffect::new(move |_| {
                    Box::pin(async move {
                        if let Err((error, pending)) = handoff.retain_checked(first) {
                            pending.await?;
                            return Err(error);
                        }
                        if let Err((error, pending)) = handoff.retain_checked(last) {
                            pending.await?;
                            return Err(error);
                        }
                        Ok(json!({"confirmedObservation":true}).into())
                    })
                }),
            )
            .await
            .unwrap();
        operation.complete(None);
        fail_first.cancel();
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            fixture.owner.stopping.cancelled(),
        )
        .await
        .expect("actual uncertainty was not recorded");
        assert!(
            fixture.effects.settle().await.is_err(),
            "the real original invocation must retain unconfirmed custody"
        );
        assert!(
            !dropped.load(Ordering::SeqCst),
            "sibling required RPC remains the original owned future"
        );
        let mut resources = Box::pin(fixture.owner.resources.settle());
        assert!(
            poll!(&mut resources).is_pending(),
            "checked failure must not discard another original request"
        );
        release_last.cancel();
        assert!(resources.await.is_err());
        assert!(dropped.load(Ordering::SeqCst));
        fixture.close(true).await;
    }

    #[tokio::test]
    async fn later_checked_uncertainty_is_observed_while_the_first_original_rpc_is_still_pending() {
        let fixture = Fixture::new().await;
        let operation = Operation::new(&fixture.owner, fixture.lease(), &fixture.native).unwrap();
        let handoff = operation.handoff();
        let fail_first = CancellationToken::new();
        let release_last = CancellationToken::new();
        let _release_on_failure = release_last.clone().drop_guard();
        let fail = fail_first.clone();
        let release = release_last.clone();
        let dropped = Arc::new(AtomicBool::new(false));
        let witness = DropWitness(dropped.clone());
        let first: CheckedSettlementFuture = Box::pin(async move {
            fail.cancelled().await;
            Err(ToolError::OutcomeUnknown(
                "required original RPC custody is unknown".into(),
            ))
        });
        let last: CheckedSettlementFuture = Box::pin(async move {
            let _witness = witness;
            release.cancelled().await;
            Ok(())
        });
        ToolJournal::new(fixture.store.clone(), fixture.invocation.clone())
            .invoke_prepared_output(
                "checked-operation".into(),
                ToolCallIdentity::standalone("checked-call".into()),
                "fixture_checked_settlement".into(),
                json!({}),
                None,
                CancellationToken::new(),
                PreparedEffect::new(move |_| {
                    Box::pin(async move {
                        if let Err((error, pending)) = handoff.retain_checked(last) {
                            pending.await?;
                            return Err(error);
                        }
                        if let Err((error, pending)) = handoff.retain_checked(first) {
                            pending.await?;
                            return Err(error);
                        }
                        Ok(json!({"confirmedObservation":true}).into())
                    })
                }),
            )
            .await
            .unwrap();
        operation.complete(None);
        fail_first.cancel();
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            fixture.owner.stopping.cancelled(),
        )
        .await
        .expect("later checked error was blocked by the earlier pending RPC");
        assert!(
            fixture.effects.settle().await.is_err(),
            "the real original invocation must retain unconfirmed custody"
        );
        assert!(
            !dropped.load(Ordering::SeqCst),
            "sibling required RPC remains the original owned future"
        );
        let mut resources = Box::pin(fixture.owner.resources.settle());
        assert!(
            poll!(&mut resources).is_pending(),
            "checked failure must not discard another original request"
        );
        release_last.cancel();
        assert!(resources.await.is_err());
        assert!(dropped.load(Ordering::SeqCst));
        fixture.close(true).await;
    }

    #[tokio::test]
    async fn closed_checked_handoff_returns_the_original_unpolled_future() {
        let fixture = Fixture::new().await;
        let operation = Operation::new(&fixture.owner, fixture.lease(), &fixture.native).unwrap();
        let handoff = operation.handoff();
        operation.complete(None);
        let calls = Arc::new(AtomicUsize::new(0));
        let dropped = Arc::new(AtomicBool::new(false));
        let future_calls = calls.clone();
        let witness = DropWitness(dropped.clone());
        let pending: CheckedSettlementFuture = Box::pin(async move {
            let _witness = witness;
            future_calls.fetch_add(1, AtomicOrdering::SeqCst);
            Ok(())
        });
        let pending = match handoff.retain_checked(pending) {
            Err((ToolError::Failed(_), pending)) => pending,
            _ => panic!("closed actual settlement must return its input future"),
        };
        assert_eq!(calls.load(AtomicOrdering::SeqCst), 0);
        assert!(!dropped.load(Ordering::SeqCst));
        pending.await.unwrap();
        assert_eq!(calls.load(AtomicOrdering::SeqCst), 1);
        assert!(dropped.load(Ordering::SeqCst));
        fixture.effects.settle().await.unwrap();
        fixture.owner.resources.settle().await.unwrap();
        fixture.close(false).await;
    }
}
