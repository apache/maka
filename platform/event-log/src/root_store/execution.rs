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

use super::*;
use maka_plugin_core::work::{
    WorkCustody,
    resources::{Resources, Ticket},
};
use maka_sandbox::workspace::{BindingRef, PermissionBasis};
use rusqlite::OptionalExtension;
use std::sync::{Mutex, OnceLock};
use tokio_util::sync::CancellationToken;

pub(super) struct WorkLifetime {
    cancellation: CancellationToken,
    effects: Arc<Resources>,
    settlement: Arc<SettlementSignal>,
}

#[derive(Clone, Copy, Default)]
enum Settlement {
    #[default]
    Pending,
    Unconfirmed,
    Released,
}
#[derive(Default)]
struct SettlementSignal {
    state: Mutex<Settlement>,
    changed: tokio::sync::Notify,
}
impl SettlementSignal {
    fn unconfirmed(&self) {
        let mut state = self.state.lock().unwrap();
        if matches!(*state, Settlement::Pending) {
            *state = Settlement::Unconfirmed;
            self.changed.notify_waiters();
        }
    }
    fn released(&self) {
        *self.state.lock().unwrap() = Settlement::Released;
        self.changed.notify_waiters();
    }
}

/// Read-only observation of one original accepted work's physical custody.
/// This holds only its signal, never pins, resources, or completion authority.
#[derive(Clone)]
pub struct WorkSettlementObserver {
    signal: Arc<SettlementSignal>,
}
impl WorkSettlementObserver {
    /// Await actual release or report retained cleanup uncertainty. This does not
    /// seal, cancel, or settle resources. A later release does not erase the
    /// original failed resource or Root shutdown receipt.
    pub async fn wait(&self) -> Result<(), StoreError> {
        loop {
            let changed = self.signal.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            match *self.signal.state.lock().unwrap() {
                Settlement::Pending => {}
                Settlement::Unconfirmed => {
                    return Err(StoreError::CleanupUnconfirmed(
                        "original work custody is retained pending cleanup confirmation".into(),
                    ));
                }
                Settlement::Released => return Ok(()),
            }
            changed.await;
        }
    }
}
impl RootStore {
    pub fn observe_work_settlement(
        &self,
        custody: &dyn WorkCustody,
        session: &str,
    ) -> Result<WorkSettlementObserver, StoreError> {
        let selected = self.session_for_work(custody, session)?;
        Ok(WorkSettlementObserver {
            signal: selected.work_lifetime()?.settlement.clone(),
        })
    }
}

struct PhysicalGuards {
    _workspace: super::WorkspaceFence,
    _work: gates::SharedPins,
    _binding: gates::SharedPins,
    _authority: Arc<root::RootOwner>,
}
struct Guards {
    physical: Option<PhysicalGuards>,
    registry: Arc<gates::Gates>,
    lifetime: OnceLock<Arc<WorkLifetime>>,
}
impl Drop for Guards {
    fn drop(&mut self) {
        // Drop runs before fields: explicitly release the original physical
        // guards before notifying observers that custody has actually ended.
        drop(self.physical.take());
        self.registry.finish_work();
        if let Some(lifetime) = self.lifetime.get() {
            lifetime.settlement.released();
        }
    }
}

pub(super) struct Pins {
    guards: Mutex<Option<Arc<Guards>>>,
}
impl Pins {
    fn lifetime(&self) -> Result<Arc<WorkLifetime>, StoreError> {
        self.guards
            .lock()
            .unwrap()
            .as_ref()
            .ok_or(StoreError::ConnectionClosed)?
            .lifetime
            .get()
            .cloned()
            .ok_or_else(|| {
                StoreError::InvalidTransition("Session work has not been accepted".into())
            })
    }
    pub(super) fn active(&self) -> bool {
        self.guards.lock().unwrap().is_some()
    }
    pub(super) fn custody(&self) -> Result<crate::connection::custody::Custody, StoreError> {
        self.guards
            .lock()
            .unwrap()
            .as_ref()
            .cloned()
            .map(|guards| guards as crate::connection::custody::Custody)
            .ok_or(StoreError::ConnectionClosed)
    }
    fn fork(&self) -> Result<Arc<Self>, StoreError> {
        let guards = self
            .guards
            .lock()
            .unwrap()
            .as_ref()
            .cloned()
            .ok_or(StoreError::ConnectionClosed)?;
        Ok(Arc::new(Self {
            guards: Mutex::new(Some(guards)),
        }))
    }
    fn release(&self) {
        drop(self.guards.lock().unwrap().take());
    }
    fn retain_unconfirmed(&self, material: impl Send + Sync + 'static) {
        if let Some(guards) = self.guards.lock().unwrap().take() {
            // Keep the original pin and Root authority until physical cleanup
            // is confirmed; uncertainty must not make shutdown claim success.
            let registry = guards.registry.clone();
            if let Some(lifetime) = guards.lifetime.get() {
                lifetime.settlement.unconfirmed();
            }
            registry.retain_unconfirmed(Arc::new((material, guards)));
        }
    }
    fn retain_original_material(
        self: &Arc<Self>,
        material: impl Send + Sync + 'static,
    ) -> RetainedWorkSettlement {
        let registry = {
            let guards = self.guards.lock().unwrap();
            let guards = guards
                .as_ref()
                .expect("unconfirmed resource retains its original guards");
            if let Some(lifetime) = guards.lifetime.get() {
                lifetime.settlement.unconfirmed();
            }
            guards.registry.clone()
        };
        RetainedWorkSettlement {
            settlement: registry
                .retain_with_settlement(Arc::new((material, RetainedPins(self.clone())))),
        }
    }
}

struct RetainedPins(Arc<Pins>);
impl Drop for RetainedPins {
    fn drop(&mut self) {
        self.0.release();
    }
}

/// Confirmation authority for one original retained work owner. It cannot grant
/// I/O or name another owner; dropping it leaves the original custody retained.
/// Existing accepted writers keep their original pins until confirmation.
#[must_use = "retain this token until the original cleanup and durable obligations are confirmed"]
pub struct RetainedWorkSettlement {
    settlement: gates::RetainedSettlement,
}
impl RetainedWorkSettlement {
    /// Call only after the original physical resources and their required
    /// canonical/Host receipt acknowledgements have actually settled.
    pub fn confirm_cleanup(self) {
        self.settlement.confirm_cleanup();
    }
}

/// Prepared admission can be cancelled before the physical worker starts.
/// Once accepted, only that worker may confirm cleanup and release its lease.
pub struct SessionWorkScope {
    store: SessionStore,
    pins: Option<Arc<Pins>>,
}
pub struct SessionWorkLease {
    store: SessionStore,
    pins: Option<Arc<Pins>>,
}

/// Original accepted resource work which may outlive its observer. The group
/// owner must settle these effects before acknowledging physical cleanup.
pub struct WorkEffectLease {
    lease: Option<SessionWorkLease>,
    ticket: Option<Ticket>,
    lifetime: Arc<WorkLifetime>,
    cancellation: CancellationToken,
}
/// Completion authority retained only by the accepted work owner. Child stores
/// can register effects, but cannot seal the group while owning a ticket.
pub struct WorkEffects {
    lifetime: Arc<WorkLifetime>,
}
impl WorkEffects {
    pub fn is_idle(&self) -> bool {
        self.lifetime.effects.is_idle()
    }
    /// Ticket count only; an empty group does not prove physical cleanup.
    pub fn has_pending(&self) -> bool {
        self.lifetime.effects.has_pending()
    }
    /// Fence new effects immediately, preserving any original failure receipt.
    /// The returned level concerns tickets, not resource or journal proof.
    pub fn seal(&self) -> Result<bool, StoreError> {
        self.lifetime
            .effects
            .seal()
            .map_err(|error| StoreError::CleanupUnconfirmed(error.to_string()))
    }
    pub async fn settle(&self) -> Result<(), StoreError> {
        self.lifetime
            .effects
            .settle()
            .await
            .map_err(|error| StoreError::CleanupUnconfirmed(error.to_string()))
    }
}
impl WorkEffectLease {
    pub fn store(&self) -> SessionStore {
        self.lease.as_ref().expect("live effect lease").store()
    }
    pub fn cancellation(&self) -> CancellationToken {
        self.cancellation.clone()
    }
    /// Validate the actual parent token before any native resource is dispatched.
    /// A rejected, not-yet-used ticket settles normally rather than quarantining.
    pub fn for_parent(self, parent: Option<&dyn WorkCustody>) -> Result<Self, StoreError> {
        let result = parent
            .ok_or_else(|| {
                StoreError::InvalidTransition("effect scope has no actual work custody".into())
            })
            .and_then(|parent| self.store().require_work_custody(parent));
        match result {
            Ok(()) => Ok(self),
            Err(error) => {
                self.finish(Ok(()));
                Err(error)
            }
        }
    }
    /// Only the original owner calls this after the journal's physical outcome
    /// has committed. The receipt describes physical settlement, not the tool's
    /// business result: a missing receipt quarantines the original admission.
    pub fn finish(mut self, result: Result<(), String>) {
        match result {
            Ok(()) => {
                self.lease.take().expect("live effect lease").finish();
                self.ticket
                    .take()
                    .expect("live effect ticket")
                    .complete(Ok(()));
            }
            Err(message) => self.fail((), message),
        }
    }
    /// Permanently retain actual material when no original cleanup owner can
    /// produce a later confirmation. This does not mint a settlement token.
    pub fn retain_unconfirmed(mut self, material: impl Send + Sync + 'static, message: String) {
        self.fail(material, message);
    }
    pub fn retain_original_material(
        mut self,
        material: impl Send + Sync + 'static,
        message: String,
    ) -> RetainedWorkSettlement {
        let settlement = self
            .lease
            .take()
            .expect("live effect lease")
            .retain_original_material(material);
        self.ticket
            .take()
            .expect("live effect ticket")
            .complete(Err(message));
        self.lifetime.cancellation.cancel();
        settlement
    }
    fn fail(&mut self, material: impl Send + Sync + 'static, message: String) {
        if let Some(mut lease) = self.lease.take() {
            if let Some(pins) = lease.pins.take() {
                pins.retain_unconfirmed(material);
            }
        }
        if let Some(ticket) = self.ticket.take() {
            ticket.complete(Err(message));
        }
        self.lifetime.cancellation.cancel();
    }
}
impl Drop for WorkEffectLease {
    fn drop(&mut self) {
        if self.ticket.is_some() {
            self.fail((), "original work effect owner disappeared".into());
        }
    }
}
impl SessionStore {
    pub(super) fn capture_source_log(&self) -> Result<(EventLog, SessionStore), StoreError> {
        let mut lease = self.fork_work()?;
        let captured = (|| {
            let owner = lease.store.owner()?;
            let custody = lease
                .store
                .work
                .as_ref()
                .ok_or(StoreError::ConnectionClosed)?
                .custody()?;
            Ok((
                owner.scoped(custody).bind_session(self.id.clone()),
                lease.store.clone(),
            ))
        })();
        if captured.is_ok() {
            drop(lease.pins.take());
        } else {
            lease.finish();
        }
        captured
    }

    pub(crate) fn source_work_effect(&self) -> Result<Option<WorkEffectLease>, StoreError> {
        self.work
            .as_ref()
            .ok_or(StoreError::ConnectionClosed)?
            .lifetime()?;
        self.fork_effect().map(Some)
    }

    pub(crate) fn source_work_lease(&self) -> Result<SessionWorkLease, StoreError> {
        self.fork_work()
    }

    pub(super) fn work_lifetime(&self) -> Result<Arc<WorkLifetime>, StoreError> {
        self.work
            .as_ref()
            .ok_or_else(|| StoreError::InvalidTransition("Session has no active work".into()))?
            .lifetime()
    }
    pub fn fork_effect(&self) -> Result<WorkEffectLease, StoreError> {
        let lifetime = self.work_lifetime()?;
        let mut ticket = lifetime
            .effects
            .reserve()
            .map_err(|error| StoreError::InvalidTransition(error.to_string()))?;
        let lease = self.fork_work()?;
        ticket.start();
        Ok(WorkEffectLease {
            lease: Some(lease),
            ticket: Some(ticket),
            cancellation: lifetime.cancellation.child_token(),
            lifetime,
        })
    }
    pub(super) fn fork_work(&self) -> Result<SessionWorkLease, StoreError> {
        self.work_lifetime()?;
        let pins = self
            .work
            .as_ref()
            .ok_or_else(|| StoreError::InvalidTransition("Session has no active work".into()))?
            .fork()?;
        let mut store = self.clone();
        store.work = Some(pins.clone());
        Ok(SessionWorkLease {
            store,
            pins: Some(pins),
        })
    }
}
impl SessionWorkScope {
    pub fn accept(mut self, cancellation: CancellationToken) -> (SessionWorkLease, WorkEffects) {
        let lifetime = Arc::new(WorkLifetime {
            cancellation,
            effects: Arc::default(),
            settlement: Arc::default(),
        });
        {
            let guards = self
                .pins
                .as_ref()
                .expect("unaccepted work scope owns pins")
                .guards
                .lock()
                .unwrap();
            guards
                .as_ref()
                .expect("unaccepted work scope is active")
                .lifetime
                .set(lifetime.clone())
                .unwrap_or_else(|_| panic!("unique work scope accepts once"));
        }
        (
            SessionWorkLease {
                store: self.store.clone(),
                pins: self.pins.take(),
            },
            WorkEffects { lifetime },
        )
    }
    pub fn store(&self) -> SessionStore {
        self.store.clone()
    }
}
impl Drop for SessionWorkScope {
    fn drop(&mut self) {
        if let Some(pins) = self.pins.take() {
            pins.release();
        }
    }
}
impl SessionWorkLease {
    pub fn store(&self) -> SessionStore {
        self.store.clone()
    }
    pub fn finish(mut self) {
        if let Some(pins) = self.pins.take() {
            pins.release();
        }
    }
    pub fn retain_unconfirmed(mut self, material: impl Send + Sync + 'static) {
        if let Some(pins) = self.pins.take() {
            pins.retain_unconfirmed(material);
        }
    }
    /// Retain the actual unsettled owner with this lease's original guards.
    pub fn retain_original_material(
        mut self,
        material: impl Send + Sync + 'static,
    ) -> RetainedWorkSettlement {
        self.pins
            .take()
            .expect("live original resource lease")
            .retain_original_material(material)
    }
}
impl Drop for SessionWorkLease {
    fn drop(&mut self) {
        if let Some(pins) = self.pins.take() {
            pins.retain_unconfirmed(());
        }
    }
}

impl SessionStore {
    pub async fn work_scope(
        &self,
        expected: Option<PermissionBasis>,
    ) -> Result<SessionWorkScope, StoreError> {
        self.work_scope_with_workspace(expected, None).await
    }
    pub async fn work_scope_in(
        &self,
        expected: Option<PermissionBasis>,
        workspace: &super::RootWorkspace,
    ) -> Result<SessionWorkScope, StoreError> {
        self.work_scope_with_workspace(expected, Some(workspace))
            .await
    }
    async fn work_scope_with_workspace(
        &self,
        expected: Option<PermissionBasis>,
        workspace: Option<&super::RootWorkspace>,
    ) -> Result<SessionWorkScope, StoreError> {
        if self.work.is_some() {
            return Err(StoreError::InvalidTransition(
                "work scope is already captured".into(),
            ));
        }
        if let Some(basis) = expected {
            basis
                .validate()
                .map_err(|reason| StoreError::InvalidTransition(reason.into()))?;
        }
        let owner = self.owner()?;
        let access = self
            .gates
            .read([gates::Key::Session(self.id.to_string())])
            .await?;
        let work = self
            .gates
            .read([gates::Key::Work(self.id.to_string())])
            .await?;
        let id = self.id.to_string();
        let reference: Option<BindingRef> = owner
            .connection
            .read(move |connection| {
                let raw: Option<String> = connection
                    .query_row(
                        "SELECT configuration FROM session_control WHERE id=?",
                        rusqlite::params![id],
                        |row| row.get(0),
                    )
                    .optional()?;
                crate::workspace_bindings::attached(&serde_json::from_str(
                    &raw.ok_or(StoreError::SessionNotFound)?,
                )?)
            })
            .await?;
        let binding = self
            .gates
            .read(
                reference
                    .iter()
                    .map(|reference| gates::Key::Binding(reference.id)),
            )
            .await?;
        let authority = owner.owned_root()?;
        let workspace = self.workspace_work_pin(workspace).await?;
        self.gates.start_work()?;
        let guards = Arc::new(Guards {
            physical: Some(PhysicalGuards {
                _workspace: workspace,
                _work: work,
                _binding: binding,
                _authority: authority,
            }),
            registry: self.gates.clone(),
            lifetime: OnceLock::new(),
        });
        let id = self.id.to_string();
        let observed = owner.scoped(Arc::new((access, guards.clone())));
        observed
            .connection
            .read(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                crate::sessions::removal::require_accepting(&tx, &id)?;
                let available: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM session_control WHERE id=? AND archived=0)",
                    rusqlite::params![&id],
                    |row| row.get(0),
                )?;
                if !available {
                    return Err(StoreError::SessionRetired);
                }
                if crate::workspace_bindings::permission_basis(&tx, &id)? != expected {
                    return Err(StoreError::PermissionRevoked);
                }
                tx.rollback()?;
                Ok(())
            })
            .await?;
        drop(observed);
        let pins = Arc::new(Pins {
            guards: Mutex::new(Some(guards)),
        });
        let mut store = self.clone();
        store.work = Some(pins.clone());
        Ok(SessionWorkScope {
            store,
            pins: Some(pins),
        })
    }
}
