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
use maka_agent_facts::workspace::{BindingRef, PermissionBasis};
use maka_agent_facts::{event::Invocation, tools::ToolError};
use maka_capabilities::call::{Resources, Scope, Ticket};
use std::sync::{Mutex, OnceLock};
use tokio_util::sync::CancellationToken;

struct InvocationLifetime {
    invocation: Invocation,
    cancellation: CancellationToken,
    effects: Arc<Resources>,
}

struct Guards {
    _work: gates::SharedPins,
    _binding: gates::SharedPins,
    _authority: Arc<root::RootOwner>,
    registry: Arc<gates::Gates>,
    invocation: OnceLock<Arc<InvocationLifetime>>,
}
impl Drop for Guards {
    fn drop(&mut self) {
        self.registry.finish_work();
    }
}

pub(super) struct Pins {
    guards: Mutex<Option<Arc<Guards>>>,
}
impl Pins {
    fn invocation(&self, invocation: &Invocation) -> Result<Arc<InvocationLifetime>, StoreError> {
        let guards = self.guards.lock().unwrap();
        let lifetime = guards
            .as_ref()
            .ok_or(StoreError::ConnectionClosed)?
            .invocation
            .get()
            .ok_or_else(|| StoreError::InvalidTransition("execution has no bound Run".into()))?;
        if &lifetime.invocation != invocation {
            return Err(StoreError::InvalidTransition(
                "execution belongs to another Run".into(),
            ));
        }
        Ok(lifetime.clone())
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
    fn retain_unconfirmed(&self) {
        if let Some(guards) = self.guards.lock().unwrap().take() {
            // This is the same original pin and Root authority. Quarantine
            // closes admission and prevents shutdown from claiming success.
            let registry = guards.registry.clone();
            registry.retain_unconfirmed(guards);
        }
    }
}

/// Prepared admission can be cancelled before the physical worker starts.
/// Once accepted, only that worker may confirm cleanup and release its lease.
pub struct SessionExecutionScope {
    store: SessionStore,
    pins: Option<Arc<Pins>>,
}
pub struct SessionExecutionLease {
    store: SessionStore,
    pins: Option<Arc<Pins>>,
}

/// An original native journal operation which may outlive its evaluation
/// observer, but must settle before its Run can be sealed.
pub struct InvocationEffectLease {
    lease: Option<SessionExecutionLease>,
    ticket: Option<Ticket>,
    lifetime: Arc<InvocationLifetime>,
    cancellation: CancellationToken,
}
/// Completion authority retained only by the accepted Run owner. Child stores
/// can register effects, but cannot seal the group while owning a ticket.
pub struct InvocationEffects {
    lifetime: Arc<InvocationLifetime>,
}
impl InvocationEffects {
    pub fn is_idle(&self) -> bool {
        self.lifetime.effects.is_idle()
    }
    pub async fn settle(&self) -> Result<(), ToolError> {
        self.lifetime.effects.settle().await
    }
}
impl InvocationEffectLease {
    pub fn store(&self) -> SessionStore {
        self.lease.as_ref().expect("live effect lease").store()
    }
    pub fn cancellation(&self) -> CancellationToken {
        self.cancellation.clone()
    }
    /// Construct the initial scope before journal admission. A stopped Run can
    /// reject that construction without leaving an unowned effect ticket.
    pub fn into_scope(self, source: &Scope) -> Result<(Self, Scope), ToolError> {
        let scope = (|| {
            if source.identity.agent() != Some(&self.lifetime.invocation) {
                return Err(ToolError::Failed(
                    "effect scope belongs to another Run".into(),
                ));
            }
            source.for_execution(
                self.store()
                    .execution_custody()
                    .map_err(|error| ToolError::Persistence(error.to_string()))?,
                self.cancellation(),
            )
        })();
        match scope {
            Ok(scope) => Ok((self, scope)),
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
            Err(message) => self.fail(message),
        }
    }
    pub fn retain_unconfirmed(mut self, message: String) {
        self.fail(message);
    }
    fn fail(&mut self, message: String) {
        if let Some(lease) = self.lease.take() {
            lease.retain_unconfirmed();
        }
        if let Some(ticket) = self.ticket.take() {
            ticket.complete(Err(message));
        }
        self.lifetime.cancellation.cancel();
    }
}
impl Drop for InvocationEffectLease {
    fn drop(&mut self) {
        if self.ticket.is_some() {
            self.fail("original invocation effect owner disappeared".into());
        }
    }
}
impl SessionStore {
    fn invocation_lifetime(
        &self,
        invocation: &Invocation,
    ) -> Result<Arc<InvocationLifetime>, StoreError> {
        self.execution
            .as_ref()
            .ok_or_else(|| StoreError::InvalidTransition("Session has no active execution".into()))?
            .invocation(invocation)
    }
    pub(super) fn fork_invocation_effect(
        &self,
        invocation: &Invocation,
    ) -> Result<InvocationEffectLease, StoreError> {
        let lifetime = self.invocation_lifetime(invocation)?;
        let mut ticket = lifetime
            .effects
            .reserve()
            .map_err(|error| StoreError::InvalidTransition(error.to_string()))?;
        let lease = self.fork_execution()?;
        ticket.start();
        Ok(InvocationEffectLease {
            lease: Some(lease),
            ticket: Some(ticket),
            cancellation: lifetime.cancellation.child_token(),
            lifetime,
        })
    }
    pub(super) fn fork_execution(&self) -> Result<SessionExecutionLease, StoreError> {
        let pins = self
            .execution
            .as_ref()
            .ok_or_else(|| StoreError::InvalidTransition("Session has no active execution".into()))?
            .fork()?;
        let mut store = self.clone();
        store.execution = Some(pins.clone());
        Ok(SessionExecutionLease {
            store,
            pins: Some(pins),
        })
    }
}
impl SessionExecutionScope {
    /// Bind the actual Run owner before any executor or tool can obtain custody.
    pub fn accept_invocation(
        mut self,
        invocation: Invocation,
        cancellation: CancellationToken,
    ) -> Result<(SessionExecutionLease, InvocationEffects), StoreError> {
        self.store.check_session(&invocation.session_id)?;
        let lifetime = Arc::new(InvocationLifetime {
            invocation,
            cancellation,
            effects: Arc::default(),
        });
        {
            let guards = self
                .pins
                .as_ref()
                .ok_or(StoreError::ConnectionClosed)?
                .guards
                .lock()
                .unwrap();
            guards
                .as_ref()
                .ok_or(StoreError::ConnectionClosed)?
                .invocation
                .set(lifetime.clone())
                .map_err(|_| {
                    StoreError::InvalidTransition("execution Run is already bound".into())
                })?;
        }
        Ok((
            SessionExecutionLease {
                store: self.store.clone(),
                pins: self.pins.take(),
            },
            InvocationEffects { lifetime },
        ))
    }
    pub fn store(&self) -> SessionStore {
        self.store.clone()
    }
    pub fn accept(mut self) -> SessionExecutionLease {
        SessionExecutionLease {
            store: self.store.clone(),
            pins: self.pins.take(),
        }
    }
}
impl Drop for SessionExecutionScope {
    fn drop(&mut self) {
        if let Some(pins) = self.pins.take() {
            pins.release();
        }
    }
}
impl SessionExecutionLease {
    pub fn store(&self) -> SessionStore {
        self.store.clone()
    }
    pub fn finish(mut self) {
        if let Some(pins) = self.pins.take() {
            pins.release();
        }
    }
    pub fn retain_unconfirmed(mut self) {
        if let Some(pins) = self.pins.take() {
            pins.retain_unconfirmed();
        }
    }
}
impl Drop for SessionExecutionLease {
    fn drop(&mut self) {
        if let Some(pins) = self.pins.take() {
            pins.retain_unconfirmed();
        }
    }
}

impl SessionStore {
    pub async fn execution_scope(
        &self,
        expected: Option<PermissionBasis>,
    ) -> Result<SessionExecutionScope, StoreError> {
        if self.execution.is_some() {
            return Err(StoreError::InvalidTransition(
                "execution scope is already captured".into(),
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
                Box::pin(async move {
                    let raw: Option<String> =
                        sqlx::query_scalar("SELECT configuration FROM session_control WHERE id=?")
                            .bind(id)
                            .fetch_optional(connection)
                            .await?;
                    crate::workspace_bindings::attached(&serde_json::from_str(
                        &raw.ok_or(StoreError::SessionNotFound)?,
                    )?)
                })
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
        self.gates.start_work()?;
        let guards = Arc::new(Guards {
            _work: work,
            _binding: binding,
            _authority: authority,
            registry: self.gates.clone(),
            invocation: OnceLock::new(),
        });
        let id = self.id.to_string();
        let observed = owner.scoped(Arc::new((access, guards.clone())));
        observed
            .connection
            .read(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    crate::sessions::removal::require_accepting(&mut tx, &id).await?;
                    let available: bool = sqlx::query_scalar(
                        "SELECT EXISTS(SELECT 1 FROM session_control WHERE id=? AND archived=0)",
                    )
                    .bind(&id)
                    .fetch_one(&mut *tx)
                    .await?;
                    if !available {
                        return Err(StoreError::SessionRetired);
                    }
                    if crate::workspace_bindings::permission_basis(&mut tx, &id).await? != expected
                    {
                        return Err(StoreError::PermissionRevoked);
                    }
                    tx.rollback().await?;
                    Ok(())
                })
            })
            .await?;
        drop(observed);
        let pins = Arc::new(Pins {
            guards: Mutex::new(Some(guards)),
        });
        let mut store = self.clone();
        store.execution = Some(pins.clone());
        Ok(SessionExecutionScope {
            store,
            pins: Some(pins),
        })
    }
}

#[cfg(test)]
mod tests;
