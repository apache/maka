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

//! The session catalog and the selected session.

mod commands;

use std::collections::HashMap;

use gpui_kit::{Context, Entity, EventEmitter, SharedString, Subscription, Task};
use host_protocol::{
    ChangeNotice, PushFrame, SessionCatalogItem, SessionCatalogQuery, SessionCatalogQueryInput,
    SessionCatalogQueryResult,
};
use workspace::{HostRequestError, HostRequester, HostSession, HostSessionEvent};

use crate::row::SessionRow;

pub use commands::TaskCommand;

/// Restarts allowed when the catalog changes between pages
/// (`MAX_STABLE_READ_ATTEMPTS` in `packages/runtime-host/src/client/catalog-reader.ts`).
const MAX_STABLE_READ_ATTEMPTS: usize = 8;

/// The catalog load, as the sidebar shows it. Rows from the last good load
/// stay visible in every state.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum LoadState {
    /// Waiting for a connection before the first load.
    Idle,
    Loading,
    Loaded,
    /// The last load failed; the message says why.
    Failed(SharedString),
}

/// Emitted by [`SessionCatalog`].
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum SessionCatalogEvent {
    /// The selected session changed (or was cleared).
    SelectionChanged(Option<SharedString>),
    /// The new task's draft opened (New task, ⌘N, a project's "+"): no
    /// task is selected, and the composer is for writing the first message.
    DraftOpened,
}

/// The sessions the Host lists (archived ones included, marked), which one
/// is selected, and the commands on one task ([`TaskCommand`]).
///
/// It reads the whole catalog in one pass (every page) whenever a connection
/// becomes ready and when the Host announces `session.catalog.changed`. A
/// change that arrives during a load schedules exactly one more load, so a
/// burst of notices costs at most two. Each load carries a generation; a
/// result from a superseded load is dropped.
///
/// No task selected is the new task's draft. New task asks for nothing:
/// it clears the selection ([`Self::open_draft`]), and a load then leaves
/// it clear. The task exists once its first message is sent, which creates
/// it; the window hands the created session here ([`Self::adopt`]), which
/// lists and selects it at once, and a load that started before the create
/// committed keeps its row rather than dropping it.
pub struct SessionCatalog {
    host: Entity<HostSession>,
    rows: Vec<SessionRow>,
    load: LoadState,
    reload_pending: bool,
    generation: u64,
    /// Sessions created in this window, each with the generation of the
    /// last load started before its create answered. A load of that
    /// generation or older may have read the catalog before the create
    /// committed (the Host serves requests concurrently), so it keeps the
    /// row when it lacks it; a later load is authoritative and ends the
    /// entry.
    created: Vec<(SharedString, u64)>,
    selected: Option<SharedString>,
    /// The draft was opened and stays open: a load selects nothing.
    draft: bool,
    /// A session to select as soon as a load lists it.
    preferred: Option<SharedString>,
    /// The command each task is waiting on; a second one is refused.
    pending: HashMap<SharedString, TaskCommand>,
    /// Why the last command failed, until another one starts.
    command_error: Option<SharedString>,
    /// The name a pending rename replaced, to restore if it fails.
    rollback: HashMap<SharedString, SharedString>,
    _subscription: Subscription,
    _load: Option<Task<()>>,
    _commands: HashMap<SharedString, Task<()>>,
}

impl EventEmitter<SessionCatalogEvent> for SessionCatalog {}

impl std::fmt::Debug for SessionCatalog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionCatalog")
            .field("rows", &self.rows.len())
            .field("load", &self.load)
            .field("selected", &self.selected)
            .field("draft", &self.draft)
            .finish_non_exhaustive()
    }
}

impl SessionCatalog {
    pub fn new(host: Entity<HostSession>, cx: &mut Context<Self>) -> Self {
        let subscription =
            cx.subscribe(&host, |this, _, event: &HostSessionEvent, cx| match event {
                HostSessionEvent::Connected { .. } => this.reload(cx),
                HostSessionEvent::Push(frame)
                    if matches!(
                        frame.as_ref(),
                        PushFrame::Change(ChangeNotice::SessionCatalogChanged { .. })
                    ) =>
                {
                    this.request_reload(cx)
                }
                _ => {}
            });
        let connected = host.read(cx).is_connected();
        let mut this = Self {
            host,
            rows: Vec::new(),
            load: LoadState::Idle,
            reload_pending: false,
            generation: 0,
            created: Vec::new(),
            selected: None,
            draft: false,
            preferred: None,
            pending: HashMap::new(),
            command_error: None,
            rollback: HashMap::new(),
            _subscription: subscription,
            _load: None,
            _commands: HashMap::new(),
        };
        if connected {
            this.reload(cx);
        }
        this
    }

    /// The Host session this catalog reads from.
    pub fn host(&self) -> &Entity<HostSession> {
        &self.host
    }

    /// The listed sessions, archived ones included, newest activity first.
    pub fn rows(&self) -> &[SessionRow] {
        &self.rows
    }

    /// The listed session `id`.
    pub fn row(&self, id: &str) -> Option<&SessionRow> {
        self.rows.iter().find(|row| row.id == id)
    }

    pub fn load_state(&self) -> &LoadState {
        &self.load
    }

    pub fn selected_id(&self) -> Option<&SharedString> {
        self.selected.as_ref()
    }

    pub fn selected_row(&self) -> Option<&SessionRow> {
        let selected = self.selected.as_ref()?;
        self.rows.iter().find(|row| &row.id == selected)
    }

    /// The position of the selected row in [`Self::rows`].
    pub fn selected_ix(&self) -> Option<usize> {
        let selected = self.selected.as_ref()?;
        self.rows.iter().position(|row| &row.id == selected)
    }

    /// Selects the session `id`, or clears the selection.
    pub fn select(&mut self, id: Option<&str>, cx: &mut Context<Self>) {
        let id = id.filter(|id| self.rows.iter().any(|row| row.id == *id));
        if id.is_some() {
            self.draft = false;
        }
        if self.selected.as_deref() == id {
            return;
        }
        self.selected = id.map(|id| SharedString::from(id.to_owned()));
        cx.emit(SessionCatalogEvent::SelectionChanged(self.selected.clone()));
        cx.notify();
    }

    /// Opens the new task's draft: clears the selection and keeps it clear
    /// until a task is chosen. Nothing is asked of the Host; the first
    /// message creates the task. Opening it again, while it shows, still
    /// tells the window ([`SessionCatalogEvent::DraftOpened`]), which moves
    /// to it.
    pub fn open_draft(&mut self, cx: &mut Context<Self>) {
        self.draft = true;
        self.preferred = None;
        if self.selected.take().is_some() {
            cx.emit(SessionCatalogEvent::SelectionChanged(None));
        }
        cx.emit(SessionCatalogEvent::DraftOpened);
        cx.notify();
    }

    /// Whether the new task's draft is open: no task is selected, by choice.
    pub fn is_draft(&self) -> bool {
        self.draft && self.selected.is_none()
    }

    /// Lists `item`, a session the draft's first message just created, at
    /// the top and selects it. The change notice that follows reloads the
    /// catalog, which then lists it too.
    pub fn adopt(&mut self, item: &SessionCatalogItem, cx: &mut Context<Self>) {
        let Some(row) = SessionRow::from_item(item) else {
            return;
        };
        let id = row.id.clone();
        self.rows.retain(|existing| existing.id != id);
        self.rows.insert(0, row);
        self.created.push((id.clone(), self.generation));
        self.select(Some(&id), cx);
        cx.notify();
    }

    /// Drops session `id`, which the draft's first message created and the
    /// Host then refused the message of, so it was deleted again. While it
    /// is selected, the draft opens again in its place.
    pub fn discard(&mut self, id: &str, cx: &mut Context<Self>) {
        self.rows.retain(|row| row.id != id);
        self.created.retain(|(created, _)| created != id);
        if self.selected.as_deref() == Some(id) {
            self.open_draft(cx);
        }
        cx.notify();
    }

    /// Selects the session `id` now if it is listed, or else as soon as a
    /// load lists it (for example to open the window on a given task).
    pub fn select_when_listed(&mut self, id: impl Into<SharedString>, cx: &mut Context<Self>) {
        let id = id.into();
        if self.rows.iter().any(|row| row.id == id) {
            self.select(Some(&id), cx);
        } else {
            self.preferred = Some(id);
        }
    }

    /// Reads the catalog again now, superseding any load in flight.
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.generation += 1;
        self.reload_pending = false;
        let generation = self.generation;
        let requester = self.host.read(cx).requester();
        self.load = LoadState::Loading;
        self._load = Some(cx.spawn(async move |this, cx| {
            let result = load_catalog(&requester).await;
            this.update(cx, |this, cx| this.finish_reload(generation, result, cx)).ok();
        }));
        cx.notify();
    }

    /// Reads the catalog again, or once more after the load in flight.
    pub fn request_reload(&mut self, cx: &mut Context<Self>) {
        if self.load == LoadState::Loading {
            self.reload_pending = true;
        } else {
            self.reload(cx);
        }
    }

    fn finish_reload(
        &mut self,
        generation: u64,
        result: Result<Vec<SessionCatalogItem>, HostRequestError>,
        cx: &mut Context<Self>,
    ) {
        if generation != self.generation {
            return;
        }
        match result {
            Ok(items) => {
                let mut rows: Vec<SessionRow> =
                    items.iter().filter_map(SessionRow::from_item).collect();
                self.created.retain(|(_, before)| generation <= *before);
                for (id, _) in &self.created {
                    if !rows.iter().any(|row| &row.id == id)
                        && let Some(row) = self.rows.iter().find(|row| &row.id == id)
                    {
                        rows.insert(0, row.clone());
                    }
                }
                self.rows = rows;
                self.load = LoadState::Loaded;
                log::debug!("session catalog: {} of {} items listed", self.rows.len(), items.len());
                let preferred =
                    self.preferred.take_if(|id| self.rows.iter().any(|row| &row.id == id));
                let selection_gone = self
                    .selected
                    .as_ref()
                    .is_some_and(|id| !self.rows.iter().any(|row| &row.id == id));
                if let Some(id) = preferred {
                    self.draft = false;
                    if self.selected.as_ref() != Some(&id) {
                        self.selected = Some(id);
                        cx.emit(SessionCatalogEvent::SelectionChanged(self.selected.clone()));
                    }
                } else if selection_gone || (self.selected.is_none() && !self.draft) {
                    // Open on the newest task not archived, like opening the
                    // most recent chat, and move to it when the selected one
                    // goes; a draft the person opened stays open.
                    let first =
                        self.rows.iter().find(|row| !row.is_archived).map(|row| row.id.clone());
                    if first != self.selected {
                        self.selected = first;
                        cx.emit(SessionCatalogEvent::SelectionChanged(self.selected.clone()));
                    }
                }
            }
            Err(error) => {
                log::warn!("session.catalog.query failed: {error}");
                self.load = LoadState::Failed(error.to_string().into());
            }
        }
        cx.notify();
        if std::mem::take(&mut self.reload_pending) {
            self.reload(cx);
        }
    }
}

/// Reads every page of `session.catalog.query`, restarting when the catalog
/// changes between pages.
async fn load_catalog(
    requester: &HostRequester,
) -> Result<Vec<SessionCatalogItem>, HostRequestError> {
    let mut attempts = 0;
    let mut items = Vec::new();
    let mut input = SessionCatalogQueryInput::ListStart;
    loop {
        match requester.request::<SessionCatalogQuery>(&input).await? {
            SessionCatalogQueryResult::Page { revision, sessions, next_cursor } => {
                items.extend(sessions);
                match next_cursor {
                    Some(cursor) => {
                        input = SessionCatalogQueryInput::ListContinue { revision, cursor }
                    }
                    None => return Ok(items),
                }
            }
            SessionCatalogQueryResult::RevisionChanged { .. } => {
                attempts += 1;
                if attempts >= MAX_STABLE_READ_ATTEMPTS {
                    return Err(HostRequestError::Transport(
                        "the session catalog kept changing while it was read".into(),
                    ));
                }
                items.clear();
                input = SessionCatalogQueryInput::ListStart;
            }
            _ => {
                return Err(HostRequestError::Transport(
                    "session.catalog.query answered with an unexpected result".into(),
                ));
            }
        }
    }
}
