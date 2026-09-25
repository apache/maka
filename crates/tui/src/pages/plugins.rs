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

//! Local-owner plugin package and composition management. Payloads stay in memory.
mod actions;
mod confirm;
mod details;
mod drafts;
mod forms;
pub mod io;
mod query;
mod saved;
mod summary;
#[cfg(test)]
mod tests;
mod view;

use crate::{
    app::{Action, App, ConnectionState},
    editor::Editor,
    navigation::Route,
    ui,
};
pub(crate) use confirm::sheet;
pub use io::{Output, Request, execute};
use maka_plugins::composition::Scope;
use maka_protocol::plugin::{EntryProjection, PackagePreview, PackageProjection, Receipt, Status};
pub use saved::Checkpoint;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use uuid::Uuid;
pub(crate) use view::draw;

const LIMIT: usize = 16;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EntryKey {
    pub scope: Scope,
    pub id: String,
}
impl EntryKey {
    fn of(entry: &EntryProjection) -> Self {
        Self {
            scope: entry.root_id.clone(),
            id: entry.id.clone(),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "place",
    content = "target",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum Place {
    #[default]
    Overview,
    Package(String),
    Entry(EntryKey),
    Install,
    New(String),
    Configure(EntryKey),
    Services(EntryKey),
}
impl Place {
    pub fn valid(&self) -> bool {
        match self {
            Self::Overview | Self::Install => true,
            Self::Package(id) | Self::New(id) => maka_plugins::identifier(id).is_ok(),
            Self::Entry(key) | Self::Configure(key) | Self::Services(key) => {
                maka_plugins::identifier(&key.id).is_ok()
            }
        }
    }
    fn entry(&self) -> Option<&EntryKey> {
        match self {
            Self::Entry(key) | Self::Configure(key) | Self::Services(key) => Some(key),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Change {
    Install,
    Restart,
    Uninstall,
    Enable,
    Disable,
    Remove,
    Configure,
    Services,
    Create,
}
impl Change {
    fn label(self) -> &'static str {
        match self {
            Self::Install => "plugins-install",
            Self::Restart => "plugins-restart",
            Self::Uninstall => "plugins-uninstall",
            Self::Enable => "plugins-enable",
            Self::Disable => "plugins-disable",
            Self::Remove => "plugins-remove-instance",
            Self::Configure | Self::Services => "plugins-save",
            Self::Create => "plugins-create",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    Visit(Place),
    Refresh,
    Preview,
    Field(usize),
    Scope(Scope),
    Details,
    ConfirmationDetails(Uuid),
    Review(Uuid, Change),
    Confirm(Uuid),
    Cancel,
    Rebase(Uuid),
    ConfirmRebase(Uuid),
    ConfirmExit(Uuid),
    Discard,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Binding {
    root: String,
    epoch: String,
}
#[derive(Clone, Debug)]
pub struct Snapshot {
    status: Status,
    packages: Vec<PackageProjection>,
    entries: Vec<EntryProjection>,
}
impl Snapshot {
    fn entry(&self, key: &EntryKey) -> Option<&EntryProjection> {
        self.entries.iter().find(|e| EntryKey::of(e) == *key)
    }
    fn package(&self, id: &str) -> Option<&PackageProjection> {
        self.packages.iter().find(|p| p.extension_id == id)
    }
}

enum Confirmation {
    Exit {
        token: Uuid,
        detach: bool,
    },
    Write(Request),
    Rebase {
        token: Uuid,
        place: Place,
        current: Option<Box<EntryProjection>>,
        base: u64,
        mine: [String; 3],
        dirty: [bool; 3],
        scope: Scope,
    },
}

impl Confirmation {
    fn token(&self) -> Uuid {
        match self {
            Self::Write(request) => request.token,
            Self::Exit { token, .. } | Self::Rebase { token, .. } => *token,
        }
    }
}

pub struct State {
    pub surface: ui::Surface<Command>,
    binding: Option<Binding>,
    snapshot: Option<Snapshot>,
    place: Place,
    token: Uuid,
    rendered: bool,
    pub(crate) confirmation_shown: bool,
    confirmation: Option<Confirmation>,
    confirmation_details: bool,
    pending: Option<Request>,
    queued: Option<Request>,
    dispatched: bool,
    refresh: bool,
    preview_requested: bool,
    preview: Option<PackagePreview>,
    path: Editor,
    drafts: VecDeque<(Place, drafts::Draft)>,
    focuses: VecDeque<(Place, String)>,
    unknown: Vec<saved::Pending>,
    withheld: Vec<Place>,
    details: bool,
    receipt: Option<Receipt>,
    error: Option<String>,
}
impl Default for State {
    fn default() -> Self {
        Self {
            surface: Default::default(),
            binding: None,
            snapshot: None,
            place: Place::Overview,
            token: Uuid::new_v4(),
            rendered: false,
            confirmation_shown: false,
            confirmation: None,
            confirmation_details: false,
            pending: None,
            queued: None,
            dispatched: false,
            refresh: true,
            preview_requested: false,
            preview: None,
            path: drafts::editor("", 4096),
            drafts: VecDeque::new(),
            focuses: VecDeque::new(),
            unknown: vec![],
            withheld: vec![],
            details: false,
            receipt: None,
            error: None,
        }
    }
}
impl State {
    /// A platform lifecycle notice invalidates facts, not drafts or reviewed
    /// intent. A notice during a read leaves one coalesced follow-up read due.
    pub fn changed(&mut self) {
        self.refresh = true;
    }
    /// A review freezes the displayed facts. Retire only the ordinary catalog
    /// read; its eventual reply remains owned by the runner and is ignored by
    /// the existing request token match. Read again after the Sheet is gone.
    fn defer_background_read(&mut self) {
        if self.pending.as_ref().is_some_and(Request::background_read) {
            self.pending = None;
            self.dispatched = false;
            self.refresh = true;
        }
    }
    pub(crate) fn has_unsaved(&self) -> bool {
        self.drafts
            .iter()
            .any(|(_, draft)| draft.dirty.iter().any(|dirty| *dirty))
    }
    pub(crate) fn review_exit(&mut self, detach: bool) {
        self.confirmation_details = false;
        self.confirmation = Some(Confirmation::Exit {
            token: Uuid::new_v4(),
            detach,
        });
        self.confirmation_shown = false;
    }
    pub(crate) fn begin_frame(&mut self) {
        self.rendered = false;
        self.confirmation_shown = false;
    }
    pub(crate) fn confirm_visible(&self) -> bool {
        self.confirmation.is_some()
    }
    pub fn invalidate_geometry(&mut self) {
        self.rendered = false;
        self.confirmation_shown = false;
        self.surface.invalidate();
        self.path.invalidate_geometry();
        for (_, draft) in &mut self.drafts {
            for field in &mut draft.fields {
                field.invalidate_geometry();
            }
        }
    }
    pub fn disconnect(&mut self) {
        self.token = Uuid::new_v4();
        if self.dispatched
            && let Some(request) = self.pending.take()
        {
            self.remember_unknown(&request);
        }
        self.pending = None;
        self.queued = None;
        self.dispatched = false;
        self.binding = None;
        self.snapshot = None;
        self.preview = None;
        self.confirmation = None;
        self.refresh = true;
        self.invalidate_geometry();
    }
    pub fn leave(&mut self) {
        if let Some(focus) = self.surface.focused() {
            self.focuses.retain(|(place, _)| *place != self.place);
            self.focuses.push_back((self.place.clone(), focus.into()));
            while self.focuses.len() > 64 {
                self.focuses.pop_front();
            }
        }
        self.surface.leave();
        self.invalidate_geometry();
        self.confirmation = None;
    }
    pub fn enter(&mut self, place: &Place) {
        self.place = place.clone();
        self.token = Uuid::new_v4();
        self.refresh |= self.snapshot.is_none();
        self.invalidate_geometry();
        self.ensure_draft();
        if let Some((_, focus)) = self.focuses.iter().find(|(key, _)| key == place) {
            self.surface.focus(focus.clone());
        } else {
            match place {
                Place::Install | Place::New(_) => {
                    self.surface.focus_within("plugins/scroll/body/field-0")
                }
                Place::Configure(_) => self.surface.focus_within("plugins/scroll/body/field-1"),
                Place::Services(_) => self.surface.focus_within("plugins/scroll/body/field-2"),
                _ => self
                    .surface
                    .focus("plugins/header/navigation/overview".into()),
            }
        }
    }
}
impl App {
    fn plugins_binding(&self) -> Option<Binding> {
        match &self.connection {
            ConnectionState::Connected { root_id, epoch } => Some(Binding {
                root: root_id.clone(),
                epoch: epoch.clone(),
            }),
            _ => None,
        }
    }
    pub(crate) fn plugins_enabled(&self, command: &Command) -> bool {
        let state = &self.plugins;
        match command {
            Command::Visit(place) => place.valid(),
            Command::Cancel => state.confirm_visible(),
            Command::ConfirmationDetails(token) => {
                state.confirmation_shown
                    && state
                        .confirmation
                        .as_ref()
                        .is_some_and(|confirmation| confirmation.token() == *token)
            }
            Command::ConfirmExit(token) => {
                state.confirmation_shown
                    && matches!(&state.confirmation, Some(Confirmation::Exit{token: actual, ..}) if actual == token)
            }
            Command::Confirm(token) => {
                state.confirmation_shown
                    && matches!(&state.confirmation, Some(Confirmation::Write(r)) if r.token == *token && Some(&r.binding) == self.plugins_binding().as_ref())
                    && state.pending.is_none()
                    && state.queued.is_none()
            }
            Command::ConfirmRebase(token) => {
                state.confirmation_shown
                    && matches!(&state.confirmation, Some(Confirmation::Rebase{token: actual, ..}) if actual == token)
                    && state.binding == self.plugins_binding()
            }
            _ => {
                matches!(self.navigation.current(), Route::Plugins(ref place) if *place == state.place)
                    && state.rendered
                    && self.overlay().is_none()
                    && (state.pending.is_none()
                        || (matches!(
                            command,
                            Command::Field(_)
                                | Command::Scope(_)
                                | Command::Discard
                                | Command::Details
                        ) && state
                            .pending
                            .as_ref()
                            .is_some_and(|pending| !pending.needs_checkpoint()))
                        || (matches!(
                            command,
                            Command::Review(_, _)
                                | Command::Rebase(_)
                                | Command::Preview
                                | Command::Refresh
                        ) && state.pending.as_ref().is_some_and(Request::background_read)))
                    && state.queued.is_none()
                    && state.binding.is_some()
                    && state.binding == self.plugins_binding()
                    && match command {
                        Command::Review(token, _) | Command::Rebase(token) => {
                            *token == state.token && state.unknown.len() < LIMIT
                        }
                        Command::Refresh => true,
                        _ => state.snapshot.is_some(),
                    }
            }
        }
    }
}
