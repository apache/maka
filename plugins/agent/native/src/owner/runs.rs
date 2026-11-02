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

use super::Runs;
use std::{
    collections::BTreeMap,
    ops::{Deref, DerefMut},
    sync::{Arc, Mutex as MapMutex, Weak},
};
use tokio::sync::{
    Mutex, MutexGuard, OwnedMutexGuard, OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock,
    TryLockError,
};

/// Lifecycle and control mutations exclude submissions. Submissions to distinct
/// Sessions share that lifecycle boundary, but never their per-Session ordering.
#[derive(Default)]
pub(super) struct Registry {
    activity: Arc<RwLock<()>>,
    state: Arc<Mutex<Runs>>,
    sessions: MapMutex<BTreeMap<String, Weak<Gate>>>,
}

impl Registry {
    pub(super) async fn state(&self) -> MutexGuard<'_, Runs> {
        self.state.lock().await
    }

    pub(super) async fn lock(&self) -> Exclusive {
        let activity = self.activity.clone().write_owned().await;
        let state = self.state.clone().lock_owned().await;
        Exclusive {
            state,
            _activity: activity,
        }
    }

    pub(super) fn try_lock_owned(self: Arc<Self>) -> Result<Exclusive, TryLockError> {
        let activity = self.activity.clone().try_write_owned()?;
        let state = self.state.clone().try_lock_owned()?;
        Ok(Exclusive {
            state,
            _activity: activity,
        })
    }

    pub(super) async fn session(self: &Arc<Self>, id: &str) -> Session {
        // Waiting for one Session must not retain a global lifecycle reader:
        // an unrelated control writer must still be able to enter.
        let ordered = self.ordered(id).await;
        let activity = self.activity.clone().read_owned().await;
        Session {
            ordered,
            _activity: activity,
        }
    }

    /// Queue workers are already retained by Owner.workers. Their Session order
    /// does not block lifecycle work for unrelated Sessions.
    pub(super) async fn ordered(self: &Arc<Self>, id: &str) -> Ordered {
        let gate = self.gate(id);
        let session = gate.session.clone().lock_owned().await;
        Ordered {
            _session: session,
            gate,
        }
    }

    pub(super) fn try_ordered(self: &Arc<Self>, id: &str) -> Result<Ordered, TryLockError> {
        let gate = self.gate(id);
        let session = gate.session.clone().try_lock_owned()?;
        Ok(Ordered {
            _session: session,
            gate,
        })
    }
    fn gate(self: &Arc<Self>, id: &str) -> Arc<Gate> {
        let mut sessions = self.sessions.lock().unwrap();
        let gate = sessions.get(id).and_then(Weak::upgrade).unwrap_or_else(|| {
            Arc::new(Gate {
                registry: self.clone(),
                id: id.to_owned(),
                session: Arc::new(Mutex::new(())),
            })
        });
        sessions.insert(id.to_owned(), Arc::downgrade(&gate));
        gate
    }
}

pub(super) struct Exclusive {
    state: OwnedMutexGuard<Runs>,
    _activity: OwnedRwLockWriteGuard<()>,
}
impl Deref for Exclusive {
    type Target = Runs;
    fn deref(&self) -> &Runs {
        &self.state
    }
}
impl DerefMut for Exclusive {
    fn deref_mut(&mut self) -> &mut Runs {
        &mut self.state
    }
}

pub(super) struct Session {
    ordered: Ordered,
    _activity: OwnedRwLockReadGuard<()>,
}
impl Session {
    pub(super) async fn state(&self) -> MutexGuard<'_, Runs> {
        self.ordered.state().await
    }
}

pub(super) struct Ordered {
    // Release the ordering mutex before dropping the last shared gate owner.
    _session: OwnedMutexGuard<()>,
    gate: Arc<Gate>,
}
impl Ordered {
    pub(super) async fn state(&self) -> MutexGuard<'_, Runs> {
        self.gate.registry.state.lock().await
    }
}

struct Gate {
    registry: Arc<Registry>,
    id: String,
    session: Arc<Mutex<()>>,
}
impl Drop for Gate {
    fn drop(&mut self) {
        let mut sessions = self.registry.sessions.lock().unwrap();
        if sessions
            .get(&self.id)
            .is_some_and(|gate| std::ptr::eq(gate.as_ptr(), self))
        {
            sessions.remove(&self.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::poll;

    #[tokio::test]
    async fn independent_sessions_progress_and_close_waits_for_earlier_same_session_work() {
        let registry = Arc::new(Registry::default());
        let first = registry.session("a").await;
        let mut same = Box::pin(registry.session("a"));
        assert!(poll!(same.as_mut()).is_pending());
        let other = registry.session("b").await;
        assert!(registry.clone().try_lock_owned().is_err());

        let mut closing = Box::pin(registry.lock());
        assert!(poll!(closing.as_mut()).is_pending());
        let mut later = Box::pin(registry.session("c"));
        assert!(poll!(later.as_mut()).is_pending());
        drop(first);
        assert!(poll!(same.as_mut()).is_pending());
        drop(other);
        let mut close = closing.await;
        close.closing = true;
        assert!(poll!(later.as_mut()).is_pending());
        drop(close);
        let same = same.await;
        assert!(same.state().await.closing);
        drop(same);
        let later = later.await;
        assert!(later.state().await.closing);
        drop(later);
        assert!(registry.sessions.lock().unwrap().is_empty());
        assert!(registry.try_lock_owned().unwrap().closing);
    }

    #[tokio::test]
    async fn dropped_waiting_futures_and_finished_sessions_release_their_ordering_gates() {
        let registry = Arc::new(Registry::default());
        let first = registry.session("a").await;
        let mut cancelled = Box::pin(registry.session("a"));
        assert!(poll!(cancelled.as_mut()).is_pending());
        drop(cancelled);
        assert_eq!(registry.sessions.lock().unwrap().len(), 1);
        drop(first);
        assert!(registry.sessions.lock().unwrap().is_empty());

        let exclusive = registry.clone().try_lock_owned().unwrap();
        let mut cancelled = Box::pin(registry.session("b"));
        assert!(poll!(cancelled.as_mut()).is_pending());
        drop(cancelled);
        drop(exclusive);
        assert!(registry.sessions.lock().unwrap().is_empty());

        for index in 0..10_000 {
            drop(registry.session(&format!("finished-{index}")).await);
        }
        assert!(registry.sessions.lock().unwrap().is_empty());
        assert!(registry.try_lock_owned().is_ok());
    }
}
