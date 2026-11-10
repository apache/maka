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

//! Commit hints are scoped to the state they invalidate. SQLite remains authoritative.
use std::{
    collections::{BTreeSet, HashMap},
    ops::{Deref, DerefMut},
    sync::{Arc, Mutex, Weak},
};
use tokio::sync::watch;

#[derive(Clone)]
pub(crate) struct CommitHub(Arc<Hub>);
struct Hub {
    all: watch::Sender<()>,
    activations: watch::Sender<()>,
    material_releases: watch::Sender<()>,
    sessions: Mutex<HashMap<String, Weak<Registration>>>,
}
struct Registration {
    session: String,
    hub: Weak<Hub>,
    sender: Mutex<Option<watch::Sender<()>>>,
}

/// Register before reading the initial SQL snapshot. The subscription pins only
/// its notification channel, never the Session's historical execution state.
#[derive(Clone)]
pub struct SessionSubscription {
    receiver: watch::Receiver<()>,
    _registration: Arc<Registration>,
    control: Option<watch::Receiver<()>>,
}
impl SessionSubscription {
    pub(crate) fn with_control(mut self, control: watch::Receiver<()>) -> Self {
        self.control = Some(control);
        self
    }

    /// A Root binding change can invalidate metadata without appending facts in
    /// this partition. Both channels are hints to re-read canonical state.
    pub async fn changed(&mut self) -> Result<(), watch::error::RecvError> {
        if let Some(control) = &mut self.control {
            tokio::select! {
                changed=self.receiver.changed()=>changed,
                changed=control.changed()=>changed,
            }
        } else {
            self.receiver.changed().await
        }
    }
}
impl Deref for SessionSubscription {
    type Target = watch::Receiver<()>;
    fn deref(&self) -> &Self::Target {
        &self.receiver
    }
}
impl DerefMut for SessionSubscription {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.receiver
    }
}

#[derive(Clone)]
pub(crate) struct CommitNotice {
    hub: CommitHub,
    sessions: Arc<[String]>,
}
impl CommitHub {
    pub(crate) fn new() -> Self {
        Self(Arc::new(Hub {
            all: watch::channel(()).0,
            activations: watch::channel(()).0,
            material_releases: watch::channel(()).0,
            sessions: Mutex::new(HashMap::new()),
        }))
    }
    pub(crate) fn subscribe(&self) -> watch::Receiver<()> {
        self.0.all.subscribe()
    }
    pub(crate) fn subscribe_activations(&self) -> watch::Receiver<()> {
        self.0.activations.subscribe()
    }
    pub(crate) fn subscribe_material_releases(&self) -> watch::Receiver<()> {
        self.0.material_releases.subscribe()
    }
    pub(crate) fn subscribe_session(&self, session: &str) -> SessionSubscription {
        let mut sessions = self.0.sessions.lock().unwrap();
        let registration = sessions
            .get(session)
            .and_then(Weak::upgrade)
            .unwrap_or_else(|| {
                let registration = Arc::new(Registration {
                    session: session.to_owned(),
                    hub: Arc::downgrade(&self.0),
                    sender: Mutex::new(Some(watch::channel(()).0)),
                });
                sessions.insert(session.to_owned(), Arc::downgrade(&registration));
                registration
            });
        let receiver = registration
            .sender
            .lock()
            .unwrap()
            .as_ref()
            .expect("live hub")
            .subscribe();
        SessionSubscription {
            receiver,
            _registration: registration,
            control: None,
        }
    }
    pub(crate) fn notice(&self) -> CommitNotice {
        self.sessions(std::iter::empty::<&str>())
    }
    pub(crate) fn session(&self, session: &str) -> CommitNotice {
        self.sessions([session])
    }
    pub(crate) fn sessions<'a>(&self, sessions: impl IntoIterator<Item = &'a str>) -> CommitNotice {
        CommitNotice {
            hub: self.clone(),
            sessions: sessions
                .into_iter()
                .map(str::to_owned)
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect(),
        }
    }
}
impl CommitNotice {
    /// Preserve statically routed owner sessions and transaction-discovered
    /// domain sessions together. Empty declarations never erase an owner route.
    pub(crate) fn with_sessions(&self, sessions: impl IntoIterator<Item = String>) -> Self {
        let mut affected = self.sessions.iter().cloned().collect::<BTreeSet<_>>();
        affected.extend(sessions);
        Self {
            hub: self.hub.clone(),
            sessions: affected.into_iter().collect(),
        }
    }
    pub(crate) fn activations(&self) {
        self.hub.0.activations.send_replace(());
    }
    /// Committed history or Artifact release may free ancestor material or pages.
    /// Ordinary facts and collection itself must not wake another full pass.
    pub(crate) fn material_released(&self) {
        self.hub.0.material_releases.send_replace(());
    }
    pub(crate) fn metadata(&self) {
        self.notify();
    }
    /// Shared workspace metadata affects only this owner's live observers. Do
    /// not enumerate durable Session membership or retain idle registrations.
    pub(crate) fn metadata_scope(&self, prefix: &str) {
        let ids: Vec<_> = self
            .hub
            .0
            .sessions
            .lock()
            .unwrap()
            .keys()
            .filter(|id| id.starts_with(prefix))
            .cloned()
            .collect();
        self.for_sessions(ids.iter().map(String::as_str)).metadata();
    }
    fn notify(&self) {
        self.hub.0.all.send_replace(());
        let recipients: Vec<_> = {
            let sessions = self.hub.0.sessions.lock().unwrap();
            self.sessions
                .iter()
                .filter_map(|id| sessions.get(id).and_then(Weak::upgrade))
                .collect()
        };
        for registration in recipients {
            if let Some(sender) = registration.sender.lock().unwrap().as_ref() {
                sender.send_replace(());
            }
        }
    }
    pub(crate) fn for_sessions<'a>(&self, sessions: impl IntoIterator<Item = &'a str>) -> Self {
        self.hub.sessions(sessions)
    }
}
impl Drop for Registration {
    fn drop(&mut self) {
        if let Some(hub) = self.hub.upgrade() {
            let mut sessions = hub.sessions.lock().unwrap();
            // A new subscriber may have replaced our dead weak entry already.
            if sessions
                .get(&self.session)
                .is_some_and(|entry| std::ptr::eq(entry.as_ptr(), self))
            {
                sessions.remove(&self.session);
            }
        }
    }
}
impl Drop for Hub {
    fn drop(&mut self) {
        for registration in self
            .sessions
            .get_mut()
            .unwrap()
            .values()
            .filter_map(Weak::upgrade)
        {
            registration.sender.lock().unwrap().take();
        }
    }
}
