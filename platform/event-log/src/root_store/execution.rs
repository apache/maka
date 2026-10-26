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
use std::sync::Mutex;

struct Guards {
    _work: gates::SharedPins,
    _binding: gates::SharedPins,
    _authority: Arc<root::RootOwner>,
    registry: Arc<gates::Gates>,
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
impl SessionStore {
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
