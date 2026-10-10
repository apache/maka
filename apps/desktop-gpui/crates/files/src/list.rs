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

//! The selected task's files as the Host lists them, kept fresh while the
//! Files face shows.
//!
//! The Host has no Session domain for Artifacts, so, as Desktop's
//! `ArtifactPane` does, the list is polled: every [`POLL_INTERVAL`] while
//! the face shows and the window is active, a `get` of the newest known id
//! answers the list's revision in a few hundred bytes, and only a revision
//! that moved reads the list again. The poll keeps running after a turn
//! ends because a subagent's writeback commits after the terminal event
//! (Desktop, `artifact-pane.tsx`). The list is also read when the face
//! shows, when a turn settles, and when a tool result says a subagent
//! wrote files back.

use std::rc::Rc;
use std::time::Duration;

use gpui_kit::{Context, Entity, EventEmitter, SharedString, Subscription, Task};
use host_protocol::ArtifactProjection;
use workspace::{HostSession, HostSessionEvent};

use crate::policy::is_user_visible;
use crate::read::{self, ReadFailure};

/// How often the list's revision is asked for while the face shows
/// (Desktop's 2 s).
pub const POLL_INTERVAL: Duration = Duration::from_secs(2);
/// The id a `get` names while the list is empty: any id answers the
/// revision.
const EMPTY_PROBE: &str = "none";

/// Where reading the list stands.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ListLoad {
    /// No task, or not read yet.
    Idle,
    /// The first read of this task's list is under way.
    Loading,
    Loaded,
    /// The last read failed; files already listed stay.
    Failed(ReadFailure),
}

/// Emitted by [`ArtifactList`].
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ArtifactListEvent {
    /// The files a person sees changed.
    Changed,
}

/// The selected task's files and what keeps them current.
///
/// Behavior owner for reading and polling. It notifies only when the
/// visible files or the read's state change, so a poll that finds nothing
/// new draws nothing.
pub struct ArtifactList {
    host: Entity<HostSession>,
    session_id: Option<SharedString>,
    /// Every Artifact of the task, in the Host's order (newest first).
    artifacts: Vec<ArtifactProjection>,
    /// The ones a person sees, in the same order.
    visible: Rc<[ArtifactProjection]>,
    revision: Option<String>,
    /// Incremented whenever the visible files change.
    version: u64,
    load: ListLoad,
    shown: bool,
    window_active: bool,
    /// Incremented for every task change; an answer for another is dropped.
    generation: u64,
    listing: bool,
    /// Another read was asked for while one was under way.
    list_again: bool,
    /// Reads of the list, for tests.
    reads: usize,
    _list: Option<Task<()>>,
    _poll: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<ArtifactListEvent> for ArtifactList {}

impl std::fmt::Debug for ArtifactList {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ArtifactList")
            .field("session_id", &self.session_id)
            .field("visible", &self.visible.len())
            .field("load", &self.load)
            .finish_non_exhaustive()
    }
}

impl ArtifactList {
    pub fn new(host: Entity<HostSession>, cx: &mut Context<Self>) -> Self {
        let subscriptions = vec![cx.subscribe(&host, |this, _, event: &HostSessionEvent, cx| {
            // A new connection may reach a Host whose list moved on.
            if matches!(event, HostSessionEvent::Connected { .. }) {
                this.refresh(cx);
            }
        })];
        Self {
            host,
            session_id: None,
            artifacts: Vec::new(),
            visible: Rc::from(Vec::new()),
            revision: None,
            version: 0,
            load: ListLoad::Idle,
            shown: false,
            window_active: false,
            generation: 0,
            listing: false,
            list_again: false,
            reads: 0,
            _list: None,
            _poll: None,
            _subscriptions: subscriptions,
        }
    }

    /// The window's Host connection.
    pub fn host(&self) -> &Entity<HostSession> {
        &self.host
    }

    /// The files a person sees, newest first.
    pub fn visible(&self) -> &Rc<[ArtifactProjection]> {
        &self.visible
    }

    /// Moves whenever [`Self::visible`] changes.
    pub fn version(&self) -> u64 {
        self.version
    }

    pub fn load(&self) -> &ListLoad {
        &self.load
    }

    pub fn session_id(&self) -> Option<&SharedString> {
        self.session_id.as_ref()
    }

    /// How many times the list was read.
    pub fn reads(&self) -> usize {
        self.reads
    }

    /// Whether the revision is being polled.
    pub fn is_polling(&self) -> bool {
        self._poll.is_some()
    }

    /// Follows task `session_id`: another task's list is dropped and the
    /// new one read while the face shows.
    pub fn set_session(&mut self, session_id: Option<SharedString>, cx: &mut Context<Self>) {
        if self.session_id == session_id {
            return;
        }
        self.session_id = session_id;
        self.generation += 1;
        self.artifacts.clear();
        self.visible = Rc::from(Vec::new());
        self.version += 1;
        self.revision = None;
        self.load = ListLoad::Idle;
        self.listing = false;
        self.list_again = false;
        self._list = None;
        cx.emit(ArtifactListEvent::Changed);
        self.sync_polling(cx);
        if self.shown {
            self.list(cx);
        }
        cx.notify();
    }

    /// Whether the Files face shows: it reads the list as it appears and
    /// polls while it stays.
    pub fn set_shown(&mut self, shown: bool, cx: &mut Context<Self>) {
        if self.shown == shown {
            return;
        }
        self.shown = shown;
        self.sync_polling(cx);
        if shown {
            self.list(cx);
        }
    }

    /// Whether the window is active: polling pauses while it is not.
    pub fn set_window_active(&mut self, active: bool, cx: &mut Context<Self>) {
        if self.window_active == active {
            return;
        }
        self.window_active = active;
        self.sync_polling(cx);
        if active && self.shown {
            self.list(cx);
        }
    }

    /// Reads the list again while the face shows (a turn settled, a
    /// subagent wrote files back, a delete).
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        if self.shown {
            self.list(cx);
        }
    }

    /// Reads the list now, whatever shows: the face's Retry.
    pub fn retry(&mut self, cx: &mut Context<Self>) {
        self.list(cx);
    }

    fn sync_polling(&mut self, cx: &mut Context<Self>) {
        let wanted = self.shown && self.window_active && self.session_id.is_some();
        if !wanted {
            self._poll = None;
            return;
        }
        if self._poll.is_some() {
            return;
        }
        self._poll = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(POLL_INTERVAL).await;
                let Ok(probe) = this.update(cx, |this, cx| this.probe(cx)) else {
                    return;
                };
                let Some((requester, session, artifact, generation)) = probe else {
                    continue;
                };
                // A failed poll says nothing: the next one tries again, and
                // a read of the list says what failed.
                if let Ok(revision) = read::revision(&requester, &session, &artifact).await {
                    let moved = this.update(cx, |this, cx| {
                        let current = generation == this.generation;
                        if current && this.revision.as_deref() != Some(revision.as_str()) {
                            this.list(cx);
                        }
                    });
                    if moved.is_err() {
                        return;
                    }
                }
            }
        }));
    }

    /// What a poll asks: the newest known id (the probe while empty),
    /// unless a read of the list is under way.
    fn probe(
        &self,
        cx: &mut Context<Self>,
    ) -> Option<(workspace::HostRequester, String, String, u64)> {
        if self.listing {
            return None;
        }
        let session = self.session_id.as_ref()?.to_string();
        let artifact = self
            .artifacts
            .first()
            .map_or_else(|| EMPTY_PROBE.to_owned(), |artifact| artifact.id.clone());
        Some((self.host.read(cx).requester(), session, artifact, self.generation))
    }

    fn list(&mut self, cx: &mut Context<Self>) {
        let Some(session) = self.session_id.clone() else {
            return;
        };
        if self.listing {
            self.list_again = true;
            return;
        }
        self.listing = true;
        self.reads += 1;
        if matches!(self.load, ListLoad::Idle) {
            self.load = ListLoad::Loading;
            cx.notify();
        }
        let requester = self.host.read(cx).requester();
        let generation = self.generation;
        self._list = Some(cx.spawn(async move |this, cx| {
            let result = read::list(&requester, &session).await;
            this.update(cx, |this, cx| this.finish_list(generation, result, cx)).ok();
        }));
    }

    fn finish_list(
        &mut self,
        generation: u64,
        result: Result<read::Listing, ReadFailure>,
        cx: &mut Context<Self>,
    ) {
        if generation != self.generation {
            return;
        }
        self.listing = false;
        self._list = None;
        match result {
            Ok(listing) => {
                self.revision = Some(listing.revision);
                if listing.artifacts != self.artifacts {
                    self.artifacts = listing.artifacts;
                    let visible: Vec<ArtifactProjection> = self
                        .artifacts
                        .iter()
                        .filter(|artifact| is_user_visible(artifact))
                        .cloned()
                        .collect();
                    if *visible != *self.visible {
                        self.visible = visible.into();
                        self.version += 1;
                        cx.emit(ArtifactListEvent::Changed);
                        cx.notify();
                    }
                }
                if self.load != ListLoad::Loaded {
                    self.load = ListLoad::Loaded;
                    cx.notify();
                }
            }
            Err(failure) => {
                log::warn!("files: listing the task's files failed: {failure:?}");
                let failed = ListLoad::Failed(failure);
                if self.load != failed {
                    self.load = failed;
                    cx.notify();
                }
            }
        }
        if std::mem::take(&mut self.list_again) {
            self.list(cx);
        }
    }
}
