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

//! Active gates only: completed Sessions and old workspace selections retain no
//! in-memory entry. Acquire gates before enqueueing SQL, never on a SQL owner.
use crate::StoreError;
use std::{
    collections::{BTreeSet, HashMap},
    sync::{Arc, Mutex, Weak},
};
use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(super) enum Key {
    Creation(String),
    CheckpointLoad(String),
    // Session gates precede binding gates for operations that need both.
    Session(String),
    Work(String),
    Binding(uuid::Uuid),
    // A profile revoke must linearize before or after a native dispatch T1.
    ComputerApp(String),
}

pub(super) struct Gates {
    owner: Weak<crate::root::RootOwner>,
    pub(super) workspaces: super::workspace_fence::Registry,
    entries: Mutex<HashMap<Key, Weak<Registration>>>,
    stop: CancellationToken,
    lifetime: Mutex<Lifetime>,
    changed: tokio::sync::Notify,
}
#[derive(Default)]
struct Lifetime {
    active: usize,
    recovering: bool,
    unconfirmed: Vec<Arc<RetainedEntry>>,
}
struct RetainedEntry {
    _custody: crate::connection::custody::Custody,
}

pub(super) struct RetainedSettlement {
    gates: Arc<Gates>,
    entry: Arc<RetainedEntry>,
}
impl RetainedSettlement {
    pub(super) fn confirm_cleanup(self) {
        let retained = {
            let mut lifetime = self.gates.lifetime.lock().unwrap();
            let index = lifetime
                .unconfirmed
                .iter()
                .position(|entry| Arc::ptr_eq(entry, &self.entry))
                .expect("original retained owner can only settle once");
            lifetime.unconfirmed.swap_remove(index)
        };
        // Custody destruction may finish work and re-enter the gates registry.
        drop(retained);
        drop(self.entry);
        self.gates.changed.notify_waiters();
    }
}

struct Registration {
    key: Key,
    registry: Weak<Gates>,
    lock: Arc<RwLock<()>>,
}
struct ReadPin {
    _guard: OwnedRwLockReadGuard<()>,
    _registration: Arc<Registration>,
}
struct WritePin {
    _guard: OwnedRwLockWriteGuard<()>,
    _registration: Arc<Registration>,
}

#[derive(Clone)]
pub(super) struct SharedPins {
    _pins: Arc<Vec<ReadPin>>,
}
pub(super) struct ExclusivePins {
    _pins: Vec<WritePin>,
}

impl Gates {
    pub(super) fn new(owner: &Arc<crate::root::RootOwner>) -> Arc<Self> {
        Arc::new(Self {
            owner: Arc::downgrade(owner),
            workspaces: super::workspace_fence::Registry::default(),
            entries: Mutex::new(HashMap::new()),
            stop: CancellationToken::new(),
            lifetime: Mutex::new(Lifetime::default()),
            changed: tokio::sync::Notify::new(),
        })
    }
    pub(super) fn cancellation(&self) -> CancellationToken {
        self.stop.clone()
    }
    pub(super) fn close(&self) {
        {
            let _lifetime = self.lifetime.lock().unwrap();
            self.stop.cancel();
        }
        self.changed.notify_waiters();
    }
    pub(super) fn start_work(&self) -> Result<(), StoreError> {
        let mut lifetime = self.lifetime.lock().unwrap();
        if self.stop.is_cancelled() {
            return Err(StoreError::ConnectionClosed);
        }
        if lifetime.recovering {
            return Err(StoreError::SessionBusy);
        }
        lifetime.active = lifetime
            .active
            .checked_add(1)
            .ok_or_else(|| StoreError::InvalidTransition("active work count exhausted".into()))?;
        Ok(())
    }
    pub(super) fn recovery(
        self: &Arc<Self>,
    ) -> Result<(RecoveryPin, tokio::sync::oneshot::Receiver<()>), StoreError> {
        let mut lifetime = self.lifetime.lock().unwrap();
        if self.stop.is_cancelled() {
            return Err(StoreError::ConnectionClosed);
        }
        if lifetime.recovering || lifetime.active != 0 {
            return Err(StoreError::SessionBusy);
        }
        lifetime.recovering = true;
        let (released, receipt) = tokio::sync::oneshot::channel();
        Ok((
            RecoveryPin {
                gates: self.clone(),
                released: Some(released),
            },
            receipt,
        ))
    }
    pub(super) fn finish_work(&self) {
        let mut lifetime = self.lifetime.lock().unwrap();
        lifetime.active -= 1;
        self.changed.notify_waiters();
    }
    pub(super) fn retain_unconfirmed(&self, custody: crate::connection::custody::Custody) {
        self.lifetime
            .lock()
            .unwrap()
            .unconfirmed
            .push(Arc::new(RetainedEntry { _custody: custody }));
        self.changed.notify_waiters();
    }
    pub(super) fn retain_with_settlement(
        self: &Arc<Self>,
        custody: crate::connection::custody::Custody,
    ) -> RetainedSettlement {
        let entry = Arc::new(RetainedEntry { _custody: custody });
        self.lifetime
            .lock()
            .unwrap()
            .unconfirmed
            .push(entry.clone());
        self.changed.notify_waiters();
        RetainedSettlement {
            gates: self.clone(),
            entry,
        }
    }
    pub(super) fn is_closing(&self) -> bool {
        self.stop.is_cancelled()
    }
    pub(super) fn shutdown_ready(&self) -> Option<bool> {
        let lifetime = self.lifetime.lock().unwrap();
        (self.stop.is_cancelled() && (lifetime.active == 0 || !lifetime.unconfirmed.is_empty()))
            .then_some(!lifetime.unconfirmed.is_empty())
    }
    /// Called only by the Root lifecycle owner, never a SQL actor.
    pub(super) async fn wait_for_shutdown(&self) -> bool {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            {
                let lifetime = self.lifetime.lock().unwrap();
                if self.stop.is_cancelled()
                    && (lifetime.active == 0 || !lifetime.unconfirmed.is_empty())
                {
                    return !lifetime.unconfirmed.is_empty();
                }
            }
            changed.await;
        }
    }
    /// A failed shutdown receipt is final, but its original owner may still
    /// receive actual late cleanup evidence before closing its original SQL.
    pub(super) async fn wait_for_settlement(&self) {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            {
                let lifetime = self.lifetime.lock().unwrap();
                if lifetime.active == 0 && lifetime.unconfirmed.is_empty() {
                    return;
                }
            }
            changed.await;
        }
    }
    fn registration(self: &Arc<Self>, key: Key) -> Arc<Registration> {
        let mut entries = self.entries.lock().unwrap();
        if let Some(registration) = entries.get(&key).and_then(Weak::upgrade) {
            return registration;
        }
        let registration = Arc::new(Registration {
            key: key.clone(),
            registry: Arc::downgrade(self),
            lock: Arc::new(RwLock::new(())),
        });
        entries.insert(key, Arc::downgrade(&registration));
        registration
    }
    pub(super) async fn read(
        self: &Arc<Self>,
        keys: impl IntoIterator<Item = Key>,
    ) -> Result<SharedPins, StoreError> {
        let mut pins = Vec::new();
        for key in keys.into_iter().collect::<BTreeSet<_>>() {
            let registration = self.registration(key);
            let guard = tokio::select! {
                biased;
                () = self.stop.cancelled() => return Err(StoreError::ConnectionClosed),
                guard = registration.lock.clone().read_owned() => guard,
            };
            pins.push(ReadPin {
                _guard: guard,
                _registration: registration,
            });
        }
        if self.stop.is_cancelled() {
            return Err(StoreError::ConnectionClosed);
        }
        Ok(SharedPins {
            _pins: Arc::new(pins),
        })
    }
    pub(super) fn try_write(
        self: &Arc<Self>,
        keys: impl IntoIterator<Item = Key>,
    ) -> Result<Option<ExclusivePins>, StoreError> {
        if self.stop.is_cancelled() {
            return Err(StoreError::ConnectionClosed);
        }
        let mut pins = Vec::new();
        for key in keys.into_iter().collect::<BTreeSet<_>>() {
            let registration = self.registration(key);
            let Ok(guard) = registration.lock.clone().try_write_owned() else {
                return Ok(None);
            };
            pins.push(WritePin {
                _guard: guard,
                _registration: registration,
            });
        }
        Ok(Some(ExclusivePins { _pins: pins }))
    }
    pub(super) async fn write(
        self: &Arc<Self>,
        keys: impl IntoIterator<Item = Key>,
    ) -> Result<ExclusivePins, StoreError> {
        let mut pins = Vec::new();
        for key in keys.into_iter().collect::<BTreeSet<_>>() {
            let registration = self.registration(key);
            let guard = tokio::select! {
                biased;
                () = self.stop.cancelled() => return Err(StoreError::ConnectionClosed),
                guard = registration.lock.clone().write_owned() => guard,
            };
            pins.push(WritePin {
                _guard: guard,
                _registration: registration,
            });
        }
        if self.stop.is_cancelled() {
            return Err(StoreError::ConnectionClosed);
        }
        Ok(ExclusivePins { _pins: pins })
    }
}
impl SharedPins {}
impl ExclusivePins {}
impl Drop for Registration {
    fn drop(&mut self) {
        if let Some(registry) = self.registry.upgrade() {
            let mut entries = registry.entries.lock().unwrap();
            if entries
                .get(&self.key)
                .is_some_and(|entry| std::ptr::eq(entry.as_ptr(), self))
            {
                entries.remove(&self.key);
            }
        }
    }
}

pub(super) struct RecoveryPin {
    gates: Arc<Gates>,
    released: Option<tokio::sync::oneshot::Sender<()>>,
}
impl Drop for RecoveryPin {
    fn drop(&mut self) {
        self.gates.lifetime.lock().unwrap().recovering = false;
        self.gates.changed.notify_waiters();
        if let Some(released) = self.released.take() {
            let _ = released.send(());
        }
        if let Some(owner) = self.gates.owner.upgrade() {
            owner.capability_source_changed();
        }
    }
}
