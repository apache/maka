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
use maka_computer_use::{
    BrowserEffectScope, BrowserHostEffects, BrowserPreparationBinding, CheckedSettlementFuture,
    HostEffectFactory, HostEffectFuture, HostUncertaintyFuture, OperationSettlement,
    SettlementFuture,
};
use maka_event_log::root_store::WorkEffectLease;
use maka_js_runtime::repl::ReplAdmission;
use maka_plugin_core::work::resources::Ticket;
use std::panic::AssertUnwindSafe;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::Notify;

type NativeSession = tokio::sync::Mutex<maka_computer_use::Session>;

/// The VM producer's admission handshake. Actual effect completion and
/// authority remain in the original admission and Root work lease.
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
            return Err(ToolError::Failed(format!(
                "Computer VM requires recovery: {error}"
            )));
        }
        if state.sealed {
            return Err(ToolError::Failed("Computer VM has retired".into()));
        }
        Ok(())
    }

    pub fn register(self: &Arc<Self>) -> Result<Receipt, ToolError> {
        let mut state = self.state.lock().unwrap();
        if let Some(error) = &state.failure {
            return Err(ToolError::Failed(format!(
                "Computer VM requires recovery: {error}"
            )));
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
    /// The original checked admission transferred custody; its Root ticket still owns work.
    pub fn action_admitted(&self) {
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

/// Original effect custody until the actual action and retained RPCs settle.
/// Drop transfers the same RPCs to tracked cleanup rather than dropping them.
pub(super) struct Operation {
    owner: Option<Arc<super::Computer>>,
    native: Option<Arc<NativeSession>>,
    root: Option<Arc<maka_event_log::RootStore>>,
    settlement: Arc<Settlement>,
    lease: Option<WorkEffectLease>,
    ticket: Option<Ticket>,
    tasks: tokio_util::task::TaskTracker,
    gate: Arc<Gate>,
}
impl Operation {
    pub fn new(
        owner: &Arc<super::Computer>,
        lease: WorkEffectLease,
        native: &Arc<NativeSession>,
        gate: &Arc<Gate>,
    ) -> Result<Self, ToolError> {
        if owner.stopping.is_cancelled() {
            lease.finish(Ok(())); // No native effect was admitted.
            return Err(ToolError::Failed("Computer Host service is closed".into()));
        }
        if let Err(error) = gate.check_open() {
            lease.finish(Ok(()));
            return Err(error);
        }
        let mut ticket = match owner.resources.reserve() {
            Ok(ticket) => ticket,
            Err(error) => {
                // The native call has not reached action admission.
                lease.finish(Ok(()));
                return Err(error.into());
            }
        };
        ticket.start();
        Ok(Self {
            owner: Some(owner.clone()),
            native: Some(native.clone()),
            root: Some(owner.store.clone()),
            settlement: Arc::new(Settlement {
                pending: Mutex::new(Some(Vec::new())),
            }),
            lease: Some(lease),
            ticket: Some(ticket),
            tasks: owner.tasks.clone(),
            gate: gate.clone(),
        })
    }

    pub fn handoff(&self) -> Arc<dyn OperationSettlement> {
        self.settlement.clone()
    }

    pub fn complete(mut self, failure: Option<ToolError>) {
        self.transfer(failure);
    }

    fn transfer(&mut self, failure: Option<ToolError>) {
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
            owner: self.owner.take(),
            pending: Some(pending.into_iter().map(Some).collect()),
            native: self.native.take(),
            root: self.root.take(),
            lease: Some(lease),
            ticket: self.ticket.take(),
            gate: self.gate.clone(),
            failure: None,
            observations: Vec::new(),
            unconfirmed: Vec::new(),
        };
        if let Some(failure) = failure {
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
                "Computer action owner disappeared before settlement".into(),
            )));
        }
    }
}

struct PendingSettlement {
    owner: Option<Arc<super::Computer>>,
    pending: Option<Vec<Option<CheckedSettlementFuture>>>,
    unconfirmed: Vec<CheckedSettlementFuture>,
    native: Option<Arc<NativeSession>>,
    root: Option<Arc<maka_event_log::RootStore>>,
    lease: Option<WorkEffectLease>,
    ticket: Option<Ticket>,
    gate: Arc<Gate>,
    failure: Option<String>,
    observations: Vec<ToolError>,
}
impl PendingSettlement {
    fn fail(&mut self, observation: ToolError) {
        let failure = observation.to_string();
        self.observations.push(observation);
        self.gate.close_admission();
        if let Some(ticket) = &self.ticket {
            ticket.record_failure(failure.clone());
        }
        self.failure.get_or_insert(failure);
    }

    fn quarantine(&mut self, failure: String) {
        let material = Arc::new(Mutex::new((
            self.owner.take(),
            self.pending.take(),
            std::mem::take(&mut self.unconfirmed),
            self.native.take(),
            self.root.take(),
            std::mem::take(&mut self.observations),
        )));
        if let Some(lease) = self.lease.take() {
            lease.retain_unconfirmed(material.clone(), failure.clone());
        }
        if let Some(ticket) = self.ticket.take() {
            ticket.unconfirmed(failure, material);
        }
    }

    fn finish(&mut self) {
        if let Some(failure) = self.failure.take() {
            // These failures have no original resolution/ACK source. Draining
            // siblings cannot prove the uncertain RPC or native action settled.
            self.quarantine(failure);
            return;
        }
        self.pending.take();
        if let Some(lease) = self.lease.take() {
            lease.finish(Ok(()));
        }
        if let Some(ticket) = self.ticket.take() {
            ticket.complete(Ok(()));
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
                    let original = self.pending.as_mut().expect("owned settlement futures")[index]
                        .take()
                        .expect("polled original settlement future");
                    if let Err(error) = result {
                        // A checked error can be an early uncertainty signal,
                        // not an RPC terminal. Preserve it without re-polling.
                        self.unconfirmed.push(original);
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
            let failure = self
                .failure
                .take()
                .expect("unconfirmed original settlement");
            self.quarantine(failure);
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
    gate: Arc<Gate>,
    owner: Arc<super::Computer>,
    native: Arc<NativeSession>,
    receipt: Receipt,
    ticket: Ticket,
}
impl HostEffects {
    fn reserve(&self) -> Result<HostAdmission, ToolError> {
        if let Some(attachment) = &self.popup {
            attachment.resource_boundary()?;
        }
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
                return Err(error.into());
            }
        };
        ticket.start();
        Ok(HostAdmission {
            gate: self.gate.clone(),
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
            gate,
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
            gate,
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
        self.popup
            .as_ref()
            .is_some_and(|attachment| attachment.resource_boundary().is_ok())
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
    gate: Arc<Gate>,
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
        self.gate.close_admission();
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
            self.gate.close_admission();
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
