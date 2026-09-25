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

//! Plugin terminal apps. The Host publishes terminal views; the shell keeps
//! the directory of them and the instances it has open, each named by a
//! [`Key`] rather than a registration of the moment. Every placement (a page,
//! a session's panel or status, a settings category, a slot in another view)
//! is an instance with the same lifecycle: reads, drafts, confirmed writes,
//! consent and recovery from a write whose outcome is unknown.

mod consent;
mod drafts;
mod instance;
pub(crate) mod io;
mod key;
pub(crate) mod page;
pub(crate) mod panels;
mod region;
mod saved;
mod tree;
pub(crate) use consent::{confirm as confirm_sheet, sheet as consent_sheet};
pub use instance::{Command, Instance};
pub use io::{Output, execute};
pub use key::Key;
pub use saved::Checkpoint;
pub use tree::Intent;
pub(crate) use tree::Well;

use crate::{
    app::{Action, App, ConnectionState},
    navigation::Route,
    ui,
};
use instance::Notice;
use maka_plugins::terminal_ui::{
    Context, Placement,
    view::{Control, Reply, Request as Input},
};
use maka_protocol::plugin::TerminalViewProjection;
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Message {
    /// Every view the Host publishes, in one place.
    Directory,
    /// Read the directory again.
    Reload,
    /// Visit a page, opening it if it is not open.
    Open(Key),
    /// Show what belongs with a status line: its panel, else its page.
    Reveal(Key),
    Instance(Key, Command),
}
impl Message {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Directory | Self::Open(_) | Self::Reveal(_) => "route-extensions",
            Self::Reload => "extensions-refresh",
            Self::Instance(_, command) => command.label(),
        }
    }
}

#[derive(Clone)]
pub struct Request {
    generation: u64,
    replaying: bool,
    root: String,
    epoch: String,
    /// The instance this request serves; none for the directory.
    key: Option<Key>,
    pub(super) work: Work,
}
impl Request {
    pub fn needs_checkpoint(&self) -> bool {
        matches!(
            self.work,
            Work::Call {
                input: Input::Submit { .. },
                ..
            } | Work::Authorize { .. }
        )
    }
}
#[derive(Clone)]
pub(super) enum Work {
    Directory(Option<String>),
    Rebind {
        entry: Box<TerminalViewProjection>,
        input: Input,
    },
    Call {
        entry: Box<TerminalViewProjection>,
        input: Input,
    },
    Authorize {
        entry: Box<TerminalViewProjection>,
        input: Input,
        proposal: maka_plugins::authorization::Request,
    },
}

/// The directory is read in pages of this size, up to this many entries.
const PAGE: usize = 16;
const ENTRIES: usize = 256;
/// Clean instances beyond this many are closed, least recently used first.
const INSTANCES: usize = 32;

#[derive(Default)]
pub struct Apps {
    /// Plugins localize their own text; every request names the language.
    locale: String,
    pub(super) directory: Vec<TerminalViewProjection>,
    /// Entries of a directory read still in progress.
    loading: Option<Vec<TerminalViewProjection>>,
    pub(super) loaded: bool,
    listing: bool,
    /// The directory page to read next, when a read is due.
    due: Option<Option<String>>,
    listed: u64,
    /// A change arrived while a listing was in progress.
    stale: bool,
    pub(super) failed: bool,
    pub(super) instances: BTreeMap<Key, Instance>,
    /// Least recently used first.
    recent: Vec<Key>,
    consent: Option<(Key, consent::Consent)>,
    confirming: Option<(Key, String)>,
    /// Focus and scroll of the directory page.
    pub surface: ui::Surface<Message>,
    /// The session inspector: its surface, fields, and whether the last
    /// frame had room to show it.
    pub inspector: ui::Surface<Message>,
    pub(super) inspector_wells: Vec<tree::Well>,
    pub inspector_visible: bool,
    /// Where the last frame drew the inspector, for the pointer.
    pub(super) inspector_area: Option<ratatui::layout::Rect>,
    /// Where the settings page drew plugin panes' fields.
    pub(super) settings_wells: Vec<tree::Well>,
    /// The status line above a session's composer.
    pub status: ui::Surface<Message>,
}

impl Apps {
    pub fn new(locale: &str) -> Self {
        Self {
            locale: locale.into(),
            ..Self::default()
        }
    }
    pub fn instance(&self, key: &Key) -> Option<&Instance> {
        self.instances.get(key)
    }
    pub fn consent_visible(&self) -> bool {
        self.consent.is_some()
    }
    /// The confirmation sheet shows only while its action still asks for it.
    pub fn confirm_visible(&self) -> bool {
        self.confirmation().is_some()
    }
    fn confirmation(&self) -> Option<(&Key, &maka_plugins::terminal_ui::view::Action)> {
        let (key, id) = self.confirming.as_ref()?;
        let action = self.instances.get(key)?.view.as_ref()?.action(id)?;
        action.confirm.as_ref()?;
        Some((key, action))
    }
    /// The Host's views changed: list them again, after any listing in progress.
    pub fn reload(&mut self) {
        if self.listing() {
            self.stale = true;
        } else {
            self.due = Some(None);
        }
    }
    /// What dismissing the app sheet on top asks: cancelling it.
    pub(crate) fn dismissal(&self) -> Action {
        let (key, command) = match (&self.consent, &self.confirming) {
            (Some((key, _)), _) => (key, Command::DismissConsent),
            (None, Some((key, _))) => (key, Command::CancelConfirm),
            (None, None) => return Action::Apps(Message::Reload),
        };
        Action::Apps(Message::Instance(key.clone(), command))
    }
    /// The entry serving `key`, if the directory has one.
    pub(super) fn entry(&self, key: &Key) -> Option<&TerminalViewProjection> {
        self.directory.iter().find(|entry| key.serves(entry))
    }
    /// Pages the sidebar offers: application views placed as pages.
    pub fn pages(&self) -> Vec<&TerminalViewProjection> {
        let mut pages: Vec<_> = self
            .directory
            .iter()
            .filter(|entry| {
                entry.descriptor.placement == Placement::Page
                    && entry.descriptor.context == Context::Application
            })
            .collect();
        pages.sort_by(|left, right| {
            (left.descriptor.order, &left.descriptor.title.fallback)
                .cmp(&(right.descriptor.order, &right.descriptor.title.fallback))
        });
        pages
    }
    /// Opens an instance for `key`, or returns the one already open.
    pub(crate) fn open(&mut self, key: &Key) -> &mut Instance {
        self.recent.retain(|recent| recent != key);
        self.recent.push(key.clone());
        if !self.instances.contains_key(key) {
            let entry = self.entry(key).cloned();
            let mut instance = Instance::new(entry, Value::Null);
            instance.read(&self.locale);
            self.instances.insert(key.clone(), instance);
            self.prune();
        }
        self.instances.get_mut(key).unwrap()
    }
    /// Keys of the views filling one slot of `host`'s view, whether open or not.
    fn filling(&self, host: &Key, name: &str, wire: &str) -> Vec<(Key, TerminalViewProjection)> {
        if host.depth() >= key::NESTING {
            return vec![];
        }
        self.directory
            .iter()
            .filter(|entry| {
                matches!(&entry.descriptor.placement, Placement::Slot { name: slot } if slot == name)
                    // A view never fills a slot of itself or of what holds it.
                    && !host.contains(entry)
            })
            .filter_map(|entry| {
                let session = match entry.descriptor.context {
                    Context::Application => None,
                    Context::Session => Some(host.session.clone()?),
                };
                let key = Key {
                    package: entry.package_id.clone(),
                    method: entry.method.clone(),
                    session,
                    within: Some(Box::new((host.clone(), wire.to_owned()))),
                };
                Some((key, entry.clone()))
            })
            .collect()
    }
    /// The open views filling one slot, in the directory's order.
    pub(super) fn fillers(&self, host: &Key, name: &str, wire: &str) -> Vec<Key> {
        self.filling(host, name, wire)
            .into_iter()
            .map(|(key, _)| key)
            .filter(|key| self.instances.contains_key(key))
            .collect()
    }
    /// Opens the views filling `host`'s slots, starts over any whose slot's
    /// context changed, and closes clean ones whose slot is gone.
    fn fill(&mut self, host: &Key) {
        let Some(view) = self
            .instances
            .get(host)
            .and_then(|instance| instance.view.as_ref())
        else {
            return;
        };
        let wanted: Vec<_> = tree::slots(view)
            .into_iter()
            .flat_map(|(wire, name, context)| {
                self.filling(host, &name, &wire)
                    .into_iter()
                    .map(move |(key, entry)| (key, entry, context.clone()))
            })
            .collect();
        let locale = self.locale.clone();
        for (key, entry, context) in &wanted {
            match self.instances.get_mut(key) {
                Some(instance) if instance.origin != *context && !instance.keeps() => {
                    instance.restart(context.clone(), &locale)
                }
                Some(_) => {}
                None => {
                    let mut instance = Instance::new(Some(entry.clone()), context.clone());
                    instance.read(&locale);
                    self.instances.insert(key.clone(), instance);
                    self.recent.push(key.clone());
                }
            }
        }
        self.instances.retain(|key, instance| {
            key.within.as_ref().is_none_or(|within| &within.0 != host)
                || wanted.iter().any(|(wanted, ..)| wanted == key)
                || instance.keeps()
        });
    }
    /// Closes clean instances beyond the limit, least recently used first.
    fn prune(&mut self) {
        while self.instances.len() > INSTANCES {
            let Some(index) = self.recent.iter().position(|key| {
                self.instances
                    .get(key)
                    .is_some_and(|instance| !instance.keeps() && instance.idle())
            }) else {
                return;
            };
            let key = self.recent.remove(index);
            self.instances.remove(&key);
        }
    }
    pub fn invalidate_geometry(&mut self) {
        if let Some((_, consent)) = &mut self.consent {
            consent.rendered = false;
        }
        for instance in self.instances.values_mut() {
            instance.invalidate_geometry();
        }
    }
    pub fn disconnect(&mut self) {
        self.consent = None;
        self.confirming = None;
        self.listing = false;
        self.loaded = false;
        self.loading = None;
        self.due = None;
        self.listed += 1;
        for instance in self.instances.values_mut() {
            instance.disconnect();
        }
    }
    /// The directory is complete: bind instances to the entries now serving them.
    fn bind(&mut self) {
        let locale = self.locale.clone();
        for (key, instance) in &mut self.instances {
            let entry = self.directory.iter().find(|entry| key.serves(entry));
            let changed = instance.live.is_some()
                && instance.live.as_ref() != entry.map(|entry| &entry.target);
            if changed {
                instance.disconnect();
                if self
                    .consent
                    .as_ref()
                    .is_some_and(|(holder, _)| holder == key)
                {
                    self.consent = None;
                }
                if self
                    .confirming
                    .as_ref()
                    .is_some_and(|(holder, _)| holder == key)
                {
                    self.confirming = None;
                }
            }
            let Some(entry) = entry else {
                if instance.view.is_some() && !instance.keeps() {
                    instance.message = Some(Notice::Local("extensions-unavailable"));
                }
                continue;
            };
            match &instance.entry {
                None => {
                    instance.entry = Some(entry.clone());
                    instance.live = Some(entry.target.clone());
                    instance.read(&locale);
                }
                // A fresh registration of the same entry serves a clean view;
                // a kept one resumes only on an explicit request.
                Some(current)
                    if current.target.entry_id == entry.target.entry_id || !instance.keeps() =>
                {
                    let fresh = instance.live.is_none() || current.target != entry.target;
                    instance.live = Some(entry.target.clone());
                    if !instance.keeps() && instance.idle() {
                        instance.entry = Some(entry.clone());
                        if fresh || instance.stale {
                            instance.read(&locale);
                        }
                    }
                }
                _ => instance.message = Some(Notice::Local("extensions-unavailable")),
            }
        }
        // New entries may fill slots of views already open.
        let hosts: Vec<_> = self
            .instances
            .iter()
            .filter(|(_, instance)| instance.view.is_some())
            .map(|(key, _)| key.clone())
            .collect();
        for host in hosts {
            self.fill(&host);
        }
    }
}

impl App {
    pub fn apps_requests(&mut self) -> Vec<Request> {
        let ConnectionState::Connected { root_id, epoch } = &self.connection else {
            return vec![];
        };
        let (root, epoch) = (root_id.clone(), epoch.clone());
        // A page restored or reached through history opens on arrival, and
        // a session opens the views it shows.
        if let Route::App(key) = self.navigation.current() {
            self.apps.open(&key);
        }
        if self.apps.loaded {
            self.open_session_views();
            if self.navigation.current() == Route::Settings {
                let keys: Vec<_> = self
                    .apps
                    .settings_views()
                    .into_iter()
                    .map(|(key, _)| key)
                    .collect();
                for key in keys {
                    self.apps.open(&key);
                }
            }
        }
        let apps = &mut self.apps;
        let mut requests = vec![];
        if !apps.loaded && !apps.listing && apps.loading.is_none() && apps.due.is_none() {
            apps.due = Some(None);
        }
        if !apps.listing
            && let Some(cursor) = apps.due.take()
        {
            apps.listing = true;
            apps.listed += 1;
            requests.push(Request {
                generation: apps.listed,
                replaying: false,
                root: root.clone(),
                epoch: epoch.clone(),
                key: None,
                work: Work::Directory(cursor),
            });
        }
        // A confirmation belongs to the view the reader actually reviewed.
        // Defer live reads until it closes; submitting still uses that view's
        // revision, fields and recovery identity. Retirement cancels the sheet.
        if apps.confirmation().is_none() {
            apps.confirming = None;
        }
        for (key, instance) in &mut apps.instances {
            if apps
                .confirming
                .as_ref()
                .is_some_and(|(holder, _)| holder == key)
            {
                if matches!(
                    instance.pending,
                    Some(Work::Call {
                        input: Input::Read { .. },
                        ..
                    })
                ) {
                    instance.pending = None;
                    instance.stale = true;
                }
                continue;
            }
            if instance.busy {
                continue;
            }
            let Some(work) = instance.pending.take() else {
                continue;
            };
            let replaying = instance.unresolved.is_some();
            instance.generation += 1;
            instance.busy = true;
            instance.reading = matches!(
                work,
                Work::Call {
                    input: Input::Read { .. },
                    ..
                }
            );
            instance.writing = matches!(
                work,
                Work::Call {
                    input: Input::Submit { .. },
                    ..
                } | Work::Authorize { .. }
            );
            if instance.writing {
                let (input, proposal) = match &work {
                    Work::Call { input, .. } => (input.clone(), None),
                    Work::Authorize {
                        input, proposal, ..
                    } => (input.clone(), Some(proposal.clone())),
                    _ => unreachable!(),
                };
                let recovery = match &input {
                    Input::Submit { action, .. } => instance
                        .view
                        .as_ref()
                        .and_then(|view| view.action(action))
                        .and_then(|action| action.recovery.clone()),
                    _ => None,
                };
                instance.unresolved = Some(saved::Pending {
                    input,
                    proposal,
                    recovery,
                    withheld: false,
                });
                instance.saving = true;
                instance.unrecorded = false;
            }
            instance.message = None;
            requests.push(Request {
                generation: instance.generation,
                replaying,
                root: root.clone(),
                epoch: epoch.clone(),
                key: Some(key.clone()),
                work,
            });
        }
        requests
    }
    pub fn apps_complete(&mut self, request: Request, result: Result<Output, io::Failure>) {
        if !matches!(&self.connection,
            ConnectionState::Connected { root_id, epoch } if *root_id == request.root && *epoch == request.epoch)
        {
            return;
        }
        let Some(key) = request.key.clone() else {
            return self.directory_complete(request, result);
        };
        let visible = self.app_visible(&key);
        let locale = self.apps.locale.clone();
        let Some(instance) = self.apps.instances.get_mut(&key) else {
            return;
        };
        if request.generation != instance.generation {
            return;
        }
        instance.busy = false;
        instance.reading = false;
        instance.saving = false;
        instance.writing = false;
        let recovering = matches!(
            request.work,
            Work::Rebind {
                input: Input::Recover { .. },
                ..
            }
        );
        let reloading = matches!(
            request.work,
            Work::Rebind {
                input: Input::Read { .. },
                ..
            }
        );
        let result = match result {
            Ok(Output::Rebound {
                entry,
                reply: Reply::View { view },
            }) if reloading => {
                instance.reload_draft(*entry, view);
                return;
            }
            Ok(Output::Rebound { entry, reply }) if recovering || reloading => {
                instance.entry = Some(*entry);
                Ok(Output::Reply(reply))
            }
            Ok(Output::Rebound { .. }) | Ok(Output::Directory(_)) => {
                Err(io::Failure { unknown: false })
            }
            result => result,
        };
        // A rejected recovery read says nothing about the original write.
        if !recovering
            && !request.replaying
            && request.needs_checkpoint()
            && matches!(
                &result,
                Ok(Output::Reply(
                    Reply::Consent { .. } | Reply::Conflict | Reply::Rejected { .. }
                )) | Err(io::Failure { unknown: false })
            )
        {
            instance.unresolved = None;
        }
        match result {
            Ok(Output::Rebound { .. }) | Ok(Output::Directory(_)) => unreachable!(),
            Ok(Output::Reply(Reply::Unrecorded)) => {
                instance.blocked = true;
                instance.unrecorded = recovering;
                instance.message = Some(Notice::Local("extensions-unrecorded"));
            }
            Ok(Output::Reply(Reply::View { view })) => {
                instance.install(view);
                if instance.stale {
                    instance.read(&locale);
                }
                self.apps.fill(&key);
            }
            Ok(Output::Reply(Reply::Consent { request: proposal })) => {
                // A retry needing consent does not settle an earlier lost write.
                instance.blocked = request.replaying;
                // Preparing consent authorizes nothing. A view no longer on
                // screen drops the proposal, keeping its form, rather than
                // opening a late modal over another place.
                if !visible {
                    return;
                }
                if let Work::Call {
                    entry,
                    input: input @ Input::Submit { grant: None, .. },
                } = request.work
                {
                    self.apps.consent = Some((
                        key,
                        consent::Consent {
                            entry,
                            input,
                            proposal,
                            rendered: false,
                        },
                    ));
                } else {
                    instance.blocked = true;
                    instance.message = Some(Notice::Local("extensions-failed"));
                }
            }
            Ok(Output::Reply(Reply::Applied { route })) => {
                instance.unresolved = None;
                instance.unrecorded = false;
                instance.blocked = false;
                instance.applied = match &request.work {
                    Work::Call {
                        input:
                            Input::Submit {
                                route: source,
                                action,
                                ..
                            },
                        ..
                    } if source == &route => Some(action.clone()),
                    _ => None,
                };
                // A write that lands elsewhere (a created item) opens there,
                // with Back leading to where the app starts, not to the form.
                if instance.route != route {
                    instance.history.clear();
                    if route != instance.origin {
                        let title = instance.entry.as_ref().map_or_else(String::new, |entry| {
                            entry.descriptor.title.resolve(&locale).to_owned()
                        });
                        instance.history.push_back((instance.origin.clone(), title));
                    }
                    instance.arrive();
                }
                instance.route = route;
                instance.view = None;
                instance.drafts.clear();
                instance.editors.clear();
                instance.read(&locale);
            }
            Ok(Output::Reply(Reply::Conflict)) => {
                instance.blocked = true;
                instance.message = Some(Notice::Local("extensions-conflict"));
            }
            Ok(Output::Reply(Reply::Rejected { message })) => {
                instance.blocked = recovering || reloading || request.replaying;
                instance.message = Some(Notice::Remote(message));
            }
            Err(failure) => {
                instance.blocked = true;
                instance.message = Some(Notice::Local(if failure.unknown {
                    "extensions-unknown"
                } else {
                    "extensions-failed"
                }));
            }
        }
    }
    fn directory_complete(&mut self, request: Request, result: Result<Output, io::Failure>) {
        let apps = &mut self.apps;
        if request.generation != apps.listed {
            return;
        }
        apps.listing = false;
        let page = match result {
            Ok(Output::Directory(page)) => page,
            _ => {
                apps.loading = None;
                apps.failed = true;
                apps.loaded = true;
                return;
            }
        };
        let mut loading = apps.loading.take().unwrap_or_default();
        loading.extend(page.items);
        match page.next_cursor {
            Some(cursor) if loading.len() < ENTRIES => {
                apps.loading = Some(loading);
                apps.due = Some(Some(cursor));
            }
            _ => {
                loading.truncate(ENTRIES);
                apps.directory = loading;
                apps.loaded = true;
                apps.failed = false;
                apps.bind();
                if std::mem::take(&mut apps.stale) {
                    apps.due = Some(None);
                }
            }
        }
    }
    /// Whether an instance is on screen now, so a modal it asks for belongs here.
    pub(crate) fn app_visible(&self, key: &Key) -> bool {
        if let Some(within) = &key.within {
            return self.app_visible(&within.0);
        }
        let placement = self
            .apps
            .instances
            .get(key)
            .and_then(|instance| instance.entry.as_ref())
            .map_or(Placement::Page, |entry| entry.descriptor.placement.clone());
        let current = self.navigation.current();
        let in_session = matches!(&current, Route::Session(id) if key.session.as_ref() == Some(id));
        match placement {
            Placement::Page => current == Route::App(key.clone()),
            Placement::Panel => in_session && self.inspector_shown(),
            Placement::Status => in_session,
            Placement::Settings => {
                current == Route::Settings
                    && (self.settings.single || self.settings.pane.as_ref() == Some(key))
            }
            Placement::Slot { .. } => false,
        }
    }
    /// The language changed: open, untouched views read themselves again.
    pub(crate) fn apps_relocalize(&mut self) {
        let locale = self.i18n.locale().id().to_owned();
        self.apps.locale = locale.clone();
        for instance in self.apps.instances.values_mut() {
            if instance.entry.is_some() && instance.view.is_some() && !instance.keeps() {
                if instance.idle() {
                    instance.read(&locale);
                } else {
                    instance.stale = true;
                }
            }
        }
    }
    /// Approval needs the terms on screen; the sheet layer reports that.
    pub(crate) fn consent_presented(&mut self, shown: bool) {
        if let Some((_, consent)) = &mut self.apps.consent {
            consent.rendered = shown;
        }
    }
    pub fn apps_enabled(&self, message: &Message) -> bool {
        let Message::Instance(key, command) = message else {
            return self.apps_offered(message);
        };
        let Some(instance) = self.apps.instances.get(key) else {
            return false;
        };
        match command {
            Command::DismissConsent | Command::CancelConfirm => self.apps_offered(message),
            // A background refresh never stands in the reader's way.
            Command::View(_) | Command::Back | Command::Refresh | Command::Discard => {
                (instance.idle() || instance.refreshing()) && self.apps_offered(message)
            }
            _ => instance.idle() && self.apps_offered(message),
        }
    }
    /// Whether a command is offered, apart from a request in flight: what
    /// controls show, so focus stays put while one completes.
    pub(crate) fn apps_offered(&self, message: &Message) -> bool {
        let connected = matches!(self.connection, ConnectionState::Connected { .. });
        let apps = &self.apps;
        let (key, command) = match message {
            Message::Directory => return connected,
            Message::Reload => return connected && !apps.listing,
            Message::Reveal(key) => return apps.instances.contains_key(key),
            Message::Open(key) => {
                return connected
                    && key.within.is_none()
                    && (apps.instances.contains_key(key)
                        || apps.entry(key).is_some_and(|entry| {
                            Key::of(entry, key.session.as_deref()).as_ref() == Some(key)
                        }));
            }
            Message::Instance(key, command) => (key, command),
        };
        let Some(instance) = apps.instances.get(key) else {
            return false;
        };
        if let Some((holder, consent)) = &apps.consent {
            return match command {
                Command::DismissConsent => true,
                Command::ApproveConsent => {
                    holder == key
                        && consent.rendered
                        && (!instance.blocked || instance.unresolved.is_some())
                        && self.app_visible(key)
                        && connected
                        && instance.live.is_some()
                }
                _ => false,
            };
        }
        if let Some((holder, action)) = apps.confirmation() {
            return match command {
                Command::CancelConfirm => true,
                Command::Confirm => {
                    holder == key
                        && connected
                        && self.app_visible(key)
                        && instance.offered(&Intent::Submit(action.id.clone()))
                }
                _ => false,
            };
        }
        if !connected || !self.app_visible(key) {
            return false;
        }
        if instance.live.is_none()
            && apps.loaded
            && !matches!(
                command,
                Command::Discard | Command::ConfirmDiscard | Command::CancelDiscard
            )
        {
            return false;
        }
        match command {
            Command::ResumeDraft => {
                instance.blocked
                    && instance.view.is_some()
                    && instance.unresolved.is_none()
                    && instance.review.is_none()
            }
            Command::ApplyDraft => {
                instance
                    .review
                    .as_ref()
                    .is_some_and(|review| review.resolved())
                    && instance.unresolved.is_none()
            }
            Command::CancelDraft => instance.review.is_some(),
            Command::DraftChoice(index, _) => instance
                .review
                .as_ref()
                .is_some_and(|review| *index < review.conflicts.len()),
            Command::Reconcile => {
                !instance.confirm_discard
                    && instance
                        .unresolved
                        .as_ref()
                        .is_some_and(|pending| pending.recovery.is_some())
            }
            Command::Retry => {
                !instance.confirm_discard
                    && instance.unrecorded
                    && instance
                        .unresolved
                        .as_ref()
                        .is_some_and(|pending| pending.recovery.is_some() && !pending.withheld)
            }
            Command::ConfirmDiscard | Command::CancelDiscard => instance.confirm_discard,
            Command::Discard => instance.dirty() || instance.blocked,
            Command::Back => {
                !instance.history.is_empty()
                    && !instance.dirty()
                    && instance.unresolved.is_none()
                    && !instance.blocked
            }
            Command::Refresh => instance.entry.is_some() && !instance.dirty() && !instance.blocked,
            Command::View(Intent::Commit(field)) => {
                instance.offered(&Intent::Commit(field.clone()))
                    && instance
                        .default_action(field)
                        .is_some_and(|id| instance.offered(&Intent::Submit(id)))
            }
            Command::View(intent) => instance.offered(intent),
            Command::Confirm
            | Command::CancelConfirm
            | Command::ApproveConsent
            | Command::DismissConsent => false,
        }
    }
    pub fn apps_action(&mut self, message: Message) -> Option<Action> {
        if !self.apps_enabled(&message) {
            return None;
        }
        let locale = self.apps.locale.clone();
        let (key, command) = match message {
            Message::Directory => {
                if self.apps.loaded && !self.apps.listing {
                    self.apps.due = Some(None);
                }
                return self.apply(Action::Visit(Route::Extensions));
            }
            Message::Reload => {
                self.apps.due = Some(None);
                return None;
            }
            Message::Reveal(key) => return self.reveal(&key),
            Message::Open(key) => {
                self.apps.open(&key);
                return self.apply(Action::Visit(Route::App(key)));
            }
            Message::Instance(key, command) => (key, command),
        };
        let apps = &mut self.apps;
        let replacement = matches!(command, Command::Discard | Command::ConfirmDiscard)
            .then(|| apps.entry(&key).cloned())
            .flatten();
        let instance = apps.instances.get_mut(&key)?;
        instance.applied = None;
        if matches!(
            command,
            Command::View(_) | Command::Back | Command::Refresh | Command::Discard
        ) {
            instance.overtake();
        }
        match command {
            Command::ResumeDraft => {
                instance.pending = Some(Work::Rebind {
                    entry: Box::new(instance.entry.clone()?),
                    input: Input::Read {
                        route: instance.route.clone(),
                        locale,
                    },
                });
            }
            Command::ApplyDraft => {
                instance.accept_draft();
                apps.fill(&key);
            }
            Command::CancelDraft => {
                instance.review = None;
                instance.message = Some(Notice::Local("extensions-restored"));
            }
            Command::DraftChoice(index, mine) => {
                instance.review.as_mut()?.conflicts[index].mine = Some(mine);
            }
            Command::Reconcile => {
                instance.unrecorded = false;
                instance.pending = Some(Work::Rebind {
                    entry: Box::new(instance.entry.clone()?),
                    input: Input::Recover {
                        route: instance.unresolved.as_ref()?.recovery.clone()?,
                        locale,
                    },
                });
            }
            Command::Retry => {
                instance.unrecorded = false;
                let pending = instance.unresolved.as_ref()?;
                let entry = Box::new(instance.entry.clone()?);
                instance.pending = Some(match &pending.proposal {
                    Some(proposal) => Work::Authorize {
                        entry,
                        input: pending.input.clone(),
                        proposal: proposal.clone(),
                    },
                    None => Work::Call {
                        entry,
                        input: pending.input.clone(),
                    },
                });
            }
            Command::Discard if instance.unresolved.is_some() => {
                instance.confirm_discard = true;
                instance.message = Some(Notice::Local("extensions-forget-confirm"));
            }
            Command::CancelDiscard => {
                instance.confirm_discard = false;
                instance.message = Some(Notice::Local("extensions-unknown"));
            }
            Command::ApproveConsent => {
                let (_, consent) = apps.consent.take()?;
                instance.pending = Some(Work::Authorize {
                    entry: consent.entry,
                    input: consent.input,
                    proposal: consent.proposal,
                });
            }
            Command::DismissConsent => apps.consent = None,
            Command::Confirm => {
                if let Some((_, id)) = apps.confirming.take() {
                    instance.submit(&id, &locale);
                }
            }
            Command::CancelConfirm => {
                apps.confirming = None;
                if instance.stale && instance.idle() && !instance.keeps() {
                    instance.read(&locale);
                }
            }
            Command::View(Intent::Navigate(route)) => instance.navigate(route, &locale),
            Command::View(Intent::Open(session)) => {
                return self.apply(Action::Visit(Route::Session(session)));
            }
            Command::View(Intent::Submit(id)) => {
                if asks(instance, &id) {
                    apps.confirming = Some((key, id));
                } else {
                    instance.submit(&id, &locale);
                }
            }
            Command::View(Intent::Commit(field)) => {
                let id = instance.default_action(&field)?;
                if asks(instance, &id) {
                    apps.confirming = Some((key, id));
                } else {
                    instance.submit(&id, &locale);
                }
            }
            Command::View(Intent::Toggle(field)) => {
                if let Some(Value::Bool(value)) = instance.drafts.get_mut(&field) {
                    *value = !*value;
                }
            }
            Command::View(Intent::Pick(field, value)) => {
                let valid = instance
                    .view
                    .as_ref()
                    .and_then(|view| view.field(&field))
                    .is_some_and(|field| {
                        matches!(&field.control, Control::Choice { options, .. }
                            if options.iter().any(|option| option.value == value))
                    });
                if valid {
                    instance.drafts.insert(field, Value::String(value));
                }
            }
            Command::Back => {
                let (route, _) = instance.history.pop_back()?;
                instance.route = route;
                instance.arrive();
                instance.read(&locale);
            }
            Command::Discard | Command::ConfirmDiscard => {
                instance.review = None;
                instance.unresolved = None;
                instance.unrecorded = false;
                instance.confirm_discard = false;
                instance.message = None;
                instance.generation += 1;
                instance.blocked = false;
                instance.busy = false;
                instance.view = None;
                instance.drafts.clear();
                instance.editors.clear();
                instance.history.clear();
                instance.route = instance.origin.clone();
                instance.live = replacement.as_ref().map(|entry| entry.target.clone());
                instance.entry = replacement;
                instance.arrive();
                instance.read(&locale);
            }
            Command::Refresh => instance.read(&locale),
        }
        None
    }
}

impl App {
    /// The changes streams the views on screen declared.
    pub fn apps_watches(&self) -> std::collections::BTreeSet<io::Watch> {
        self.apps
            .instances
            .iter()
            .filter(|(key, instance)| instance.live.is_some() && self.app_visible(key))
            .filter_map(|(key, instance)| {
                let entry = instance.entry.as_ref()?;
                Some(io::Watch {
                    package: entry.package_id.clone(),
                    method: entry.descriptor.changes.clone()?,
                    session: key.session.clone(),
                    activation: instance.live.as_ref()?.activation.clone(),
                })
            })
            .collect()
    }
    /// A session changed (a turn settled, its metadata moved): its views,
    /// and application views that may track sessions, read again when on
    /// screen and following no changes stream of their own.
    pub fn apps_session_changed(&mut self, session: &str) {
        let locale = self.apps.locale.clone();
        let visible: Vec<_> = self
            .apps
            .instances
            .keys()
            .filter(|key| {
                key.session.as_deref().is_none_or(|own| own == session) && self.app_visible(key)
            })
            .cloned()
            .collect();
        for key in visible {
            let Some(instance) = self.apps.instances.get_mut(&key) else {
                continue;
            };
            let follows = instance
                .entry
                .as_ref()
                .is_some_and(|entry| entry.descriptor.changes.is_some());
            if follows {
                continue;
            }
            if instance.idle() && !instance.keeps() && instance.view.is_some() {
                instance.read(&locale);
            } else {
                instance.stale = true;
            }
        }
    }
    /// A changes stream said its views are stale: those on screen and
    /// untouched read again; the rest read once they can.
    pub fn apps_changed(&mut self, watch: &io::Watch) {
        let locale = self.apps.locale.clone();
        for (key, instance) in &mut self.apps.instances {
            let Some(entry) = &instance.entry else {
                continue;
            };
            if instance
                .live
                .as_ref()
                .is_none_or(|target| target.activation != watch.activation)
                || entry.package_id != watch.package
                || entry.descriptor.changes.as_deref() != Some(watch.method.as_str())
                || key.session != watch.session
            {
                continue;
            }
            if instance.idle() && !instance.keeps() && instance.view.is_some() {
                instance.read(&locale);
            } else {
                instance.stale = true;
            }
        }
    }
}

impl Apps {
    /// Application views placed in Settings, with their titles.
    pub(crate) fn settings_views(&self) -> Vec<(Key, String)> {
        let mut views: Vec<_> = self
            .directory
            .iter()
            .filter(|entry| {
                entry.descriptor.placement == Placement::Settings
                    && entry.descriptor.context == Context::Application
            })
            .collect();
        views.sort_by(|left, right| {
            (left.descriptor.order, &left.descriptor.title.fallback)
                .cmp(&(right.descriptor.order, &right.descriptor.title.fallback))
        });
        views
            .into_iter()
            .filter_map(|entry| {
                let title = entry.descriptor.title.resolve(&self.locale).to_owned();
                Some((Key::of(entry, None)?, title))
            })
            .collect()
    }
}

/// Settings panes' fields, painted over the settings surface.
pub(crate) fn paint_settings(
    frame: &mut ratatui::Frame<'_>,
    app: &mut App,
    wells: Vec<Well>,
    focused: Option<&str>,
    colors: crate::theme::Palette,
) {
    let surface = std::mem::take(&mut app.settings.surface);
    region::paint(frame, &mut app.apps, &surface, &wells, focused, colors);
    app.settings.surface = surface;
    app.apps.settings_wells = wells;
}

impl App {
    /// A settings pane's fields take their events before the settings surface.
    pub(crate) fn settings_field_input(&mut self, event: &crossterm::event::Event) -> Option<bool> {
        let keyboard = self.focus == crate::app::Focus::Page;
        let mut surface = std::mem::take(&mut self.settings.surface);
        let wells = std::mem::take(&mut self.apps.settings_wells);
        let outcome = region::input(&mut self.apps, &mut surface, &wells, event, keyboard);
        self.settings.surface = surface;
        self.apps.settings_wells = wells;
        outcome
    }
}

impl App {
    /// Palette commands: every page that can open from here, then the
    /// commands of the app on screen.
    pub(crate) fn apps_commands(&self) -> Vec<(Action, crate::pages::commands::Label)> {
        use crate::pages::commands::Label;
        let route = self.navigation.current();
        let session = match &route {
            Route::Session(id) => Some(id.as_str()),
            _ => None,
        };
        let locale = self.i18n.locale().id();
        let mut commands = vec![];
        for entry in &self.apps.directory {
            if entry.descriptor.placement != Placement::Page {
                continue;
            }
            let Some(key) = Key::of(entry, session) else {
                continue;
            };
            let message = Message::Open(key);
            if self.apps_offered(&message) {
                let title = entry.descriptor.title.resolve(locale).to_owned();
                commands.push((Action::Apps(message), Label::Text(title)));
            }
        }
        if let Route::App(key) = route
            && let Some(instance) = self.apps.instances.get(&key)
        {
            let standing = if instance.dirty() || instance.blocked {
                Command::Discard
            } else {
                Command::Refresh
            };
            for command in std::iter::once(Command::Back)
                .chain(instance.remedies())
                .chain(std::iter::once(standing))
            {
                let message = Message::Instance(key.clone(), command);
                if self.apps_offered(&message) {
                    let label = message.label();
                    commands.push((Action::Apps(message), Label::Key(label)));
                }
            }
        }
        commands
    }
}

fn asks(instance: &Instance, id: &str) -> bool {
    instance
        .view
        .as_ref()
        .and_then(|view| view.action(id))
        .is_some_and(|action| action.confirm.is_some())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::{
        app::Focus,
        i18n::{I18n, LocalePreference},
    };
    use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent};
    use maka_plugins::terminal_ui::view::View;
    use maka_plugins::{
        composition::Scope,
        remote::Target,
        terminal_ui::{
            Descriptor, Text, VERSION,
            view::{Action as ViewAction, Role, Tone, build::*},
        },
    };
    use ratatui::{Terminal, backend::TestBackend};
    use serde_json::json;

    pub(crate) const TOGGLE: &str = "app/body/frame/content/root/enabled";
    pub(crate) const NAME: &str = "app/body/frame/content/root/name";

    pub(crate) fn key() -> Key {
        Key::of(&projection(), Some("session")).unwrap()
    }
    pub(crate) fn command(command: Command) -> Message {
        Message::Instance(key(), command)
    }
    pub(crate) fn instance(app: &App) -> &Instance {
        &app.apps.instances[&key()]
    }
    pub(crate) fn instance_mut(app: &mut App) -> &mut Instance {
        app.apps.instances.get_mut(&key()).unwrap()
    }
    /// The one instance request an action queued. Directory reads are
    /// answered on the spot with the fixture's single entry.
    pub(crate) fn next(app: &mut App) -> Option<Request> {
        loop {
            let (listings, mut requests): (Vec<_>, Vec<_>) = app
                .apps_requests()
                .into_iter()
                .partition(|request| request.key.is_none());
            if listings.is_empty() {
                assert!(requests.len() <= 1, "one request at a time here");
                return requests.pop();
            }
            for listing in listings {
                app.apps_complete(
                    listing,
                    Ok(Output::Directory(maka_protocol::plugin::Page {
                        items: vec![projection()],
                        next_cursor: None,
                    })),
                );
            }
            if let Some(request) = requests.pop() {
                return Some(request);
            }
        }
    }
    fn projection() -> TerminalViewProjection {
        TerminalViewProjection {
            package_id: "example.notes".into(),
            scope_id: Scope::Profile,
            method: "preferences".into(),
            target: Target {
                entry_id: "notes".into(),
                activation: uuid::Uuid::new_v4().to_string(),
                registration: uuid::Uuid::new_v4(),
            },
            descriptor: Descriptor::new(Text::localized("Notes", "笔记", "筆記"), Context::Session),
        }
    }
    pub(crate) fn form() -> View {
        View {
            version: VERSION,
            title: "Notebook".into(),
            revision: "one".into(),
            fields: vec![toggle("enabled", true), line("name", "My notes", 128)],
            actions: vec![ViewAction {
                fields: vec!["enabled".into(), "name".into()],
                ..action("save", "Save")
            }],
            root: column(
                "root",
                vec![
                    text("body", "A plugin-owned form.", Tone::Normal),
                    input("enabled", "enabled", "Enabled"),
                    input("name", "name", "Name"),
                    button("save", "save", Role::Primary),
                ],
            ),
        }
    }
    pub(crate) fn save() -> Message {
        command(Command::View(Intent::Submit("save".into())))
    }
    pub(crate) fn draw(app: &mut App, width: u16, height: u16) -> String {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal
            .draw(|frame| crate::view::draw(frame, app))
            .unwrap();
        terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect()
    }
    pub(crate) fn click(app: &mut App, path: &str) {
        let rect = match app.navigation.current() {
            Route::App(key) => app.apps.instances[&key].surface.rect(path),
            _ => app.apps.surface.rect(path),
        }
        .unwrap();
        for kind in [
            crossterm::event::MouseEventKind::Down(MouseButton::Left),
            crossterm::event::MouseEventKind::Up(MouseButton::Left),
        ] {
            app.input(Event::Mouse(MouseEvent {
                kind,
                column: rect.x + rect.width / 2,
                row: rect.y,
                modifiers: KeyModifiers::NONE,
            }));
        }
    }
    pub(crate) fn app() -> App {
        let mut app = App::new(
            "/test".into(),
            I18n::new(
                LocalePreference::Explicit(crate::i18n::Locale::En),
                crate::i18n::Locale::En,
            ),
        );
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "epoch".into(),
        };
        app.apply(Action::Visit(Route::Session("session".into())));
        assert!(next(&mut app).is_none());
        assert_eq!(app.apps.directory.len(), 1);
        app.apps_action(Message::Open(key()));
        assert_eq!(app.navigation.current(), Route::App(key()));
        let request = next(&mut app).unwrap();
        assert!(matches!(
            &request.work,
            Work::Call { input: Input::Read { locale, .. }, .. } if locale == "en"
        ));
        assert_eq!(
            request.key.as_ref().unwrap().session.as_deref(),
            Some("session")
        );
        app.apps_complete(request, Ok(Output::Reply(Reply::View { view: form() })));
        app.focus = Focus::Page;
        app
    }
    #[test]
    fn contributed_form_supports_mouse_keyboard_and_retains_conflicting_drafts_without_rebinding() {
        let mut app = app();
        let screen = draw(&mut app, 90, 26);
        // A view at its first route has no Back of its own.
        assert!(
            screen.contains("Notebook")
                && screen.contains("Refresh")
                && !screen.contains("‹ Plugin")
        );
        click(&mut app, TOGGLE);
        assert_eq!(instance(&app).drafts["enabled"], json!(false));
        draw(&mut app, 90, 26);
        assert!(!app.apps_enabled(&command(Command::Refresh)));
        app.input(Event::Key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE)));
        assert_eq!(instance(&app).surface.focused(), Some(NAME));
        app.input(Event::Key(KeyEvent::new(
            KeyCode::Char('a'),
            KeyModifiers::CONTROL,
        )));
        app.input(Event::Paste("Renamed".into()));
        assert_eq!(instance(&app).drafts["name"], json!("Renamed"));
        instance_mut(&mut app).view.as_mut().unwrap().actions[0]
            .fields
            .pop();
        assert!(
            !app.apps_enabled(&save()),
            "saving a subset must not discard other drafts"
        );
        instance_mut(&mut app).view.as_mut().unwrap().actions[0]
            .fields
            .push("name".into());
        // Return in the one-line field submits the primary button's action.
        draw(&mut app, 90, 26);
        app.input(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::NONE,
        )));
        let request = next(&mut app).unwrap();
        let Work::Call {
            entry,
            input: Input::Submit {
                fields, revision, ..
            },
        } = &request.work
        else {
            panic!("submit");
        };
        assert_eq!(entry.target, instance(&app).entry.as_ref().unwrap().target);
        assert_eq!(fields["enabled"], json!(false));
        assert_eq!(fields["name"], json!("Renamed"));
        assert_eq!(revision, "one");
        app.apps_complete(request.clone(), Ok(Output::Reply(Reply::Conflict)));
        assert_eq!(instance(&app).drafts["name"], json!("Renamed"));
        assert!(!app.apps_enabled(&save()));
        assert!(next(&mut app).is_none(), "no automatic refresh or retry");
        assert!(draw(&mut app, 44, 18).contains("draft"));
        app.apps_action(command(Command::Discard));
        let fresh = next(&mut app).unwrap();
        app.apps_complete(request, Ok(Output::Reply(Reply::View { view: form() })));
        assert!(
            instance(&app).view.is_none(),
            "late old result cannot replace new directory"
        );
        app.apps_complete(
            fresh,
            Ok(Output::Directory(maka_protocol::plugin::Page {
                items: vec![projection()],
                next_cursor: None,
            })),
        );
        assert_eq!(app.apps.directory.len(), 1);
    }

    #[test]
    fn plugin_lists_and_tabs_share_keyboard_groups_without_submitting_or_trapping_fields() {
        let mut app = app();
        let mut view = form();
        let items = (0..64)
            .map(|index| {
                link(
                    format!("item-{index}"),
                    format!("Item {index}"),
                    json!(index),
                )
                .current(index == 40)
                .into()
            })
            .collect();
        view.root = column(
            "root",
            vec![
                tabs(
                    "tabs",
                    "all",
                    vec![
                        ("all".into(), "All".into(), json!("all")),
                        ("mine".into(), "Mine".into(), json!("mine")),
                    ],
                ),
                scroll("list", 5, column("items", items)),
                column(
                    "mixed",
                    vec![
                        link("other", "Other", json!("other")).into(),
                        scroll("note", 3, text("text", "Read this first.", Tone::Normal)),
                    ],
                ),
                input("enabled", "enabled", "Enabled"),
                input("name", "name", "Name"),
                button("save", "save", Role::Primary),
            ],
        );
        view.validate().unwrap();
        instance_mut(&mut app).view = Some(view);
        let root = "app/body/frame/content/root";
        for (width, height) in [(100, 32), (44, 24)] {
            instance_mut(&mut app)
                .surface
                .focus(format!("{root}/tabs/tabs/all"));
            draw(&mut app, width, height);
            for (code, target) in [
                (KeyCode::Right, "tabs/tabs/mine"),
                (KeyCode::Tab, "list/items/item-40"),
                (KeyCode::Tab, "mixed/other"),
                (KeyCode::Tab, "mixed/note"),
                (KeyCode::Tab, "enabled"),
                (KeyCode::Tab, "name"),
                (KeyCode::BackTab, "enabled"),
                (KeyCode::BackTab, "mixed/note"),
                (KeyCode::BackTab, "mixed/other"),
                (KeyCode::BackTab, "list/items/item-40"),
                (KeyCode::BackTab, "tabs/tabs/mine"),
            ] {
                app.input(Event::Key(KeyEvent::new(code, KeyModifiers::NONE)));
                draw(&mut app, width, height);
                let path = format!("{root}/{target}");
                assert_eq!(instance(&app).surface.focused(), Some(path.as_str()));
                assert!(!instance(&app).surface.rect(&path).unwrap().is_empty());
                assert!(
                    next(&mut app).is_none(),
                    "focus does not execute plugin code"
                );
            }
        }
    }

    #[test]
    fn a_rich_view_navigates_routes_picks_choices_and_confirms_destructive_actions() {
        let mut app = app();
        let mut view = form();
        view.fields.push(maka_plugins::terminal_ui::view::Field {
            id: "mode".into(),
            enabled: true,
            control: Control::Choice {
                value: "fast".into(),
                options: vec![
                    maka_plugins::terminal_ui::view::Choice {
                        value: "fast".into(),
                        label: "Fast".into(),
                    },
                    maka_plugins::terminal_ui::view::Choice {
                        value: "careful".into(),
                        label: "Careful".into(),
                    },
                ],
            },
        });
        view.actions.push(ViewAction {
            confirm: Some(maka_plugins::terminal_ui::view::Confirm {
                title: "Delete notebook?".into(),
                message: "Its pages go too.".into(),
                destructive: true,
            }),
            ..action("delete", "Delete")
        });
        view.root = column(
            "root",
            vec![
                tabs(
                    "tabs",
                    "all",
                    vec![
                        ("all".into(), "All".into(), json!({"tab":"all"})),
                        ("mine".into(), "Mine".into(), json!({"tab":"mine"})),
                    ],
                ),
                split(
                    "split",
                    40,
                    link("page", "First page", json!({"page":1}))
                        .detail("Opened today")
                        .meta("2 min")
                        .into(),
                    markdown("notes", "# Heading\n\n- **bold** item\n- `code`"),
                ),
                input("mode", "mode", "Mode"),
                progress("progress", 3, 4, "Synced"),
                button("delete", "delete", Role::Destructive),
            ],
        );
        view.validate().unwrap();
        app.apps_action(command(Command::Refresh));
        let request = next(&mut app).unwrap();
        app.apps_complete(request, Ok(Output::Reply(Reply::View { view })));
        let screen = draw(&mut app, 100, 30);
        for expected in [
            "All",
            "Mine",
            "First page",
            "2 min",
            "Heading",
            "• bold item",
            "75%",
        ] {
            assert!(screen.contains(expected), "{expected}: {screen}");
        }
        assert!(screen.contains("Fast ▾"));
        // The chooser opens over the page and picks a declared option only.
        click(&mut app, "app/body/frame/content/root/mode");
        assert!(instance(&app).surface.captures());
        app.input(Event::Key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE)));
        app.input(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::NONE,
        )));
        assert_eq!(instance(&app).drafts["mode"], json!("careful"));
        app.apps_action(command(Command::View(Intent::Pick(
            "mode".into(),
            "absent".into(),
        ))));
        assert_eq!(instance(&app).drafts["mode"], json!("careful"));
        // Leaving with a changed field is not offered; Discard is.
        assert!(!app.apps_enabled(&command(Command::View(Intent::Navigate(json!({"page":1}))))));
        instance_mut(&mut app)
            .drafts
            .insert("mode".into(), json!("fast"));
        // A destructive action asks first, in the shell's own sheet.
        draw(&mut app, 100, 30);
        click(&mut app, "app/body/frame/content/root/delete/button");
        assert!(next(&mut app).is_none());
        assert!(app.apps.confirm_visible());
        let screen = draw(&mut app, 100, 30);
        assert!(screen.contains("Delete notebook?") && screen.contains("Its pages go too."));
        app.input(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::NONE,
        )));
        assert!(!app.apps.confirm_visible(), "Enter defaults to cancel");
        assert!(next(&mut app).is_none());
        app.apps_action(save_like("delete"));
        app.apps_action(command(Command::Confirm));
        assert!(matches!(
            next(&mut app).unwrap().work,
            Work::Call { input: Input::Submit { ref action, .. }, .. } if action == "delete"
        ));

        // Items read another route; Back returns, naming where it goes.
        let mut app = self::app();
        instance_mut(&mut app).view.as_mut().unwrap().root = column(
            "root",
            vec![link("page", "First page", json!({"page":1})).into()],
        );
        draw(&mut app, 90, 26);
        click(&mut app, "app/body/frame/content/root/page");
        let request = next(&mut app).unwrap();
        assert!(matches!(
            &request.work,
            Work::Call { input: Input::Read { route, .. }, .. } if route == &json!({"page":1})
        ));
        let mut detail = form();
        detail.title = "First page".into();
        app.apps_complete(request, Ok(Output::Reply(Reply::View { view: detail })));
        let screen = draw(&mut app, 90, 26);
        assert!(screen.contains("‹ Notebook") && screen.contains("First page"));
        app.input(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        assert!(matches!(
            next(&mut app).unwrap().work,
            Work::Call {
                input: Input::Read {
                    route: Value::Null,
                    ..
                },
                ..
            }
        ));
    }

    fn save_like(action: &str) -> Message {
        command(Command::View(Intent::Submit(action.into())))
    }

    #[test]
    fn confirmation_keeps_its_reviewed_revision_fields_and_recovery_across_live_updates() {
        for approve in [false, true] {
            let mut app = app();
            let view = instance_mut(&mut app).view.as_mut().unwrap();
            view.actions[0].confirm = Some(maka_plugins::terminal_ui::view::Confirm {
                title: "Save these values?".into(),
                message: "Review the current notebook.".into(),
                destructive: false,
            });
            view.actions[0].recovery = Some(json!({"decision":"original"}));
            // Opening a confirmation overtakes a background read already in flight.
            instance_mut(&mut app).read("en");
            let old = next(&mut app).unwrap();
            app.apps_action(save());
            assert!(app.apps.confirm_visible());
            let mut replacement = form();
            replacement.revision = "later".into();
            app.apps_complete(old, Ok(Output::Reply(Reply::View { view: replacement })));
            app.apps_session_changed("session");
            assert!(
                next(&mut app).is_none(),
                "updates wait for the decision sheet"
            );
            assert_eq!(instance(&app).view.as_ref().unwrap().revision, "one");
            app.apps_action(command(if approve {
                Command::Confirm
            } else {
                Command::CancelConfirm
            }));
            let request = next(&mut app).unwrap();
            if approve {
                assert!(
                    matches!(request.work, Work::Call { input: Input::Submit { ref revision, ref fields, .. }, .. }
                    if revision == "one" && fields["name"] == "My notes")
                );
                assert_eq!(
                    instance(&app).unresolved.as_ref().unwrap().recovery,
                    Some(json!({"decision":"original"}))
                );
            } else {
                assert!(
                    matches!(
                        request.work,
                        Work::Call {
                            input: Input::Read { .. },
                            ..
                        }
                    ),
                    "cancelling catches up with the deferred updates without writing"
                );
            }
        }
    }

    #[test]
    fn consent_requires_visible_explicit_confirmation_and_never_steals_another_page() {
        use maka_plugins::authorization::{Capability, Request as Proposal, Target};
        let proposal = Proposal {
            operation_id: uuid::Uuid::new_v4(),
            title: "Untrusted title".into(),
            target: Target::Profile,
            capabilities: [Capability::Notifications].into(),
        };
        let mut app = app();
        instance_mut(&mut app)
            .drafts
            .insert("name".into(), json!("Draft"));
        let editor = instance_mut(&mut app).editors.get_mut("name").unwrap();
        editor.clear_if_unchanged("My notes");
        editor.insert("Draft");
        let prepare = |app: &mut App| {
            app.apps_action(save());
            let request = next(app).unwrap();
            app.apps_complete(
                request,
                Ok(Output::Reply(Reply::Consent {
                    request: proposal.clone(),
                })),
            );
        };
        prepare(&mut app);
        assert!(next(&mut app).is_none());
        assert!(!app.apps_enabled(&command(Command::ApproveConsent)));
        let screen = draw(&mut app, 90, 28);
        assert!(screen.contains("Send notifications"));
        assert!(!screen.contains("Untrusted title"));
        app.input(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::NONE,
        )));
        assert!(!app.apps.consent_visible(), "Enter defaults to cancel");
        assert_eq!(instance(&app).drafts["name"], json!("Draft"));
        assert!(next(&mut app).is_none());

        prepare(&mut app);
        draw(&mut app, 90, 28);
        app.input(Event::Mouse(crossterm::event::MouseEvent {
            kind: crossterm::event::MouseEventKind::Down(MouseButton::Left),
            column: 0,
            row: 0,
            modifiers: KeyModifiers::NONE,
        }));
        assert!(!app.apps.consent_visible());
        assert_eq!(app.navigation.current(), Route::App(key()));
        assert!(next(&mut app).is_none());

        prepare(&mut app);
        draw(&mut app, 30, 10);
        app.apps_action(command(Command::ApproveConsent));
        assert!(
            app.apps.consent_visible(),
            "hidden terms cannot be approved"
        );
        draw(&mut app, 90, 28);
        app.input(Event::Key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE)));
        app.input(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::NONE,
        )));
        let request = next(&mut app).unwrap();
        let Work::Authorize {
            entry,
            input,
            proposal: actual,
        } = &request.work
        else {
            panic!("explicit approval")
        };
        assert_eq!(entry.target, instance(&app).entry.as_ref().unwrap().target);
        assert_eq!(actual, &proposal);
        let Input::Submit { fields, grant, .. } = input else {
            panic!("submit")
        };
        assert_eq!(fields["name"], json!("Draft"));
        assert!(grant.is_none());
        let saved = app.apps.checkpoints("root").pop().unwrap();
        saved.validate("root").unwrap();
        let mut restored = Apps::new("en");
        restored.restore(vec![saved]).unwrap();
        assert!(restored.instances[&key()].pending.is_none());
        assert!(
            restored.consent.is_none(),
            "restoring explicit consent is not another approval"
        );
        assert_eq!(
            restored.instances[&key()]
                .unresolved
                .as_ref()
                .unwrap()
                .proposal
                .as_ref(),
            Some(&proposal)
        );
        app.apps_complete(request, Err(io::Failure { unknown: true }));
        assert!(!app.apps_enabled(&save()));
        assert!(next(&mut app).is_none());

        let mut app = self::app();
        app.apps_action(save());
        let request = next(&mut app).unwrap();
        app.apply(Action::Visit(Route::Workspace));
        app.apps_complete(
            request,
            Ok(Output::Reply(Reply::Consent { request: proposal })),
        );
        assert!(!app.apps.consent_visible());
        assert!(next(&mut app).is_none());
    }

    #[test]
    fn retirement_revokes_the_open_view_and_preserves_drafts_for_explicit_recovery() {
        for dirty in [false, true] {
            let mut app = app();
            instance_mut(&mut app)
                .entry
                .as_mut()
                .unwrap()
                .descriptor
                .changes = Some("changes".into());
            if dirty {
                app.apps_action(command(Command::View(Intent::Toggle("enabled".into()))));
            }
            assert_eq!(app.apps_watches().len(), 1);
            app.apps.directory.clear();
            app.apps.bind();
            app.apps_action(save());
            assert!(
                app.apps_requests().is_empty(),
                "retired controls cannot submit"
            );
            assert!(
                app.apps_watches().is_empty(),
                "retired subscriptions must close"
            );
            assert!(!app.apps_enabled(&save()));
            assert_eq!(instance(&app).drafts["enabled"], json!(!dirty));
            if dirty {
                assert_eq!(app.apps.checkpoints("root").len(), 1);
                assert!(!app.apps_enabled(&command(Command::ResumeDraft)));
            } else {
                assert!(draw(&mut app, 100, 30).contains("This app is no longer available."));
            }
            let replacement = projection();
            app.apps.directory.push(replacement.clone());
            app.apps.bind();
            if dirty {
                assert!(
                    app.apps_requests().is_empty(),
                    "replacement must not discard a draft"
                );
                assert!(!app.apps_enabled(&save()));
                assert!(app.apps_enabled(&command(Command::ResumeDraft)));
                assert_eq!(instance(&app).drafts["enabled"], json!(false));
            } else {
                let request = next(&mut app).unwrap();
                assert!(
                    matches!(&request.work, Work::Call { entry, input: Input::Read { .. } }
                    if entry.target == replacement.target)
                );
                app.apps_complete(request, Ok(Output::Reply(Reply::View { view: form() })));
                assert!(app.apps_enabled(&save()));
                assert!(!draw(&mut app, 100, 30).contains("This app is no longer available."));
            }
        }
        let mut app = app();
        app.apps_action(command(Command::View(Intent::Toggle("enabled".into()))));
        let mut replacement = projection();
        replacement.target.entry_id = "another-owner".into();
        app.apps.directory = vec![replacement.clone()];
        app.apps.bind();
        assert!(!app.apps_enabled(&command(Command::ResumeDraft)));
        assert_eq!(app.apps.checkpoints("root").len(), 1);
        app.apps_action(command(Command::Discard));
        let request = next(&mut app).unwrap();
        assert!(
            matches!(&request.work, Work::Call { entry, input: Input::Read { .. } }
            if entry.target == replacement.target)
        );
    }

    #[test]
    fn disconnect_revokes_controls_preserves_drafts_and_tiny_layout_has_no_stale_clicks() {
        let mut app = app();
        draw(&mut app, 80, 24);
        app.apps_action(command(Command::View(Intent::Toggle("enabled".into()))));
        app.apps_action(save());
        let request = next(&mut app).unwrap();
        app.apps.disconnect();
        app.apps_complete(
            request,
            Ok(Output::Reply(Reply::Applied { route: Value::Null })),
        );
        assert_eq!(instance(&app).drafts["enabled"], json!(false));
        assert!(matches!(
            instance(&app).message,
            Some(Notice::Local("extensions-unknown"))
        ));
        assert!(!app.apps_enabled(&save()));
        draw(&mut app, 25, 8);
        assert!(instance(&app).surface.rect(TOGGLE).is_none());
        assert!(next(&mut app).is_none());
    }

    #[test]
    fn saved_unknown_submission_queries_first_and_retries_only_the_original_idempotent_intent() {
        let mut app = app();
        let recovery = json!({"operation":"one"});
        instance_mut(&mut app).view.as_mut().unwrap().actions[0].recovery = Some(recovery.clone());
        app.apps_action(command(Command::View(Intent::Toggle("enabled".into()))));
        app.apps_action(save());
        let original = next(&mut app).unwrap();
        assert!(original.needs_checkpoint());
        let frozen = instance(&app).unresolved.as_ref().unwrap().input.clone();
        let saved = serde_json::to_value(app.apps.checkpoints("root").pop().unwrap()).unwrap();
        for (pointer, value) in [
            ("/root", json!("other")),
            ("/pending/input/revision", json!("different")),
            ("/pending/input/fields/enabled", json!(true)),
            ("/pending/recovery", json!({"operation":"other"})),
            ("/cursors/name/cursor", json!(999)),
            ("/drafts/name", json!("x".repeat(129))),
            ("/entry/target/activation", json!("not-an-activation")),
        ] {
            let mut invalid = saved.clone();
            *invalid.pointer_mut(pointer).unwrap() = value;
            assert!(
                serde_json::from_value::<Checkpoint>(invalid)
                    .unwrap()
                    .validate("root")
                    .is_err(),
                "{pointer}"
            );
        }
        app.apps.disconnect();
        assert!(!app.apps_after_checkpoint(&original, &Ok(())));
        app.apps = Apps::new("en");
        app.apps
            .restore(vec![serde_json::from_value(saved).unwrap()])
            .unwrap();
        assert!(next(&mut app).is_none());
        assert!(!app.apps_enabled(&command(Command::Retry)));
        assert!(!app.apps_enabled(&command(Command::Back)));
        assert!(!app.apps_enabled(&save()));
        app.apply(Action::Visit(Route::Workspace));
        app.apps_action(Message::Open(key()));
        assert_eq!(app.navigation.current(), Route::App(key()));
        app.apps_action(command(Command::Reconcile));
        let query = next(&mut app).unwrap();
        assert!(
            matches!(&query.work, Work::Rebind { input: Input::Recover { route, .. }, .. } if route == &recovery)
        );
        assert!(!query.needs_checkpoint());
        app.apps_complete(query, Err(io::Failure { unknown: false }));
        assert!(instance(&app).unresolved.is_some());
        assert!(!app.apps_enabled(&command(Command::Retry)));
        app.apps_action(command(Command::Reconcile));
        let query = next(&mut app).unwrap();
        let mut entry = instance(&app).entry.clone().unwrap();
        entry.target.registration = uuid::Uuid::new_v4();
        app.apps_complete(
            query,
            Ok(Output::Rebound {
                entry: Box::new(entry.clone()),
                reply: Reply::Unrecorded,
            }),
        );
        assert!(draw(&mut app, 58, 24).contains("Retry original submission"));
        app.apps_action(command(Command::Retry));
        let retry = next(&mut app).unwrap();
        assert!(retry.needs_checkpoint());
        assert!(
            matches!(&retry.work, Work::Call { entry: actual, input } if actual.target == entry.target && input == &frozen)
        );
        assert!(!app.apps_after_checkpoint(&original, &Ok(())));
        assert!(app.apps_after_checkpoint(&retry, &Ok(())));
        assert!(!app.apps_after_checkpoint(&retry, &Ok(())));
        // A rejection of this retry cannot settle the earlier uncertain attempt.
        app.apps_complete(retry, Err(io::Failure { unknown: false }));
        assert!(instance(&app).unresolved.is_some());
        assert!(!app.apps_enabled(&save()));
        app.apps_action(command(Command::Discard));
        assert!(instance(&app).unresolved.is_some());
        assert!(next(&mut app).is_none());
        assert!(draw(&mut app, 90, 24).contains("does not cancel"));
        app.apps_action(command(Command::CancelDiscard));
        app.apps_action(command(Command::Reconcile));
        let query = next(&mut app).unwrap();
        app.apps_complete(
            query,
            Ok(Output::Rebound {
                entry: Box::new(entry),
                reply: Reply::Applied {
                    route: json!({"task":"original"}),
                },
            }),
        );
        assert!(instance(&app).unresolved.is_none());
        assert!(
            matches!(next(&mut app).unwrap().work, Work::Call { input: Input::Read { route, .. }, .. } if route == json!({"task":"original"}))
        );
    }

    fn board() -> TerminalViewProjection {
        TerminalViewProjection {
            package_id: "example.board".into(),
            method: "board".into(),
            descriptor: Descriptor::new(Text::plain("Board"), Context::Application).icon("▦", "B"),
            ..projection()
        }
    }
    fn list(app: &mut App, pages: Vec<(Vec<TerminalViewProjection>, Option<&str>)>) {
        for (items, next_cursor) in pages {
            let listing = app
                .apps_requests()
                .into_iter()
                .find(|request| request.key.is_none())
                .expect("a directory read");
            app.apps_complete(
                listing,
                Ok(Output::Directory(maka_protocol::plugin::Page {
                    items,
                    next_cursor: next_cursor.map(str::to_owned),
                })),
            );
        }
    }

    #[test]
    fn pages_are_places_that_keep_their_own_state_and_follow_the_directory() {
        let mut app = app();
        // Registrations are stable across listings unless an entry restarts.
        let (notes, board) = (instance(&app).entry.clone().unwrap(), board());
        // A change announced mid-listing lists again once that listing ends.
        app.apps.reload();
        app.apps.reload();
        list(
            &mut app,
            vec![
                (vec![notes.clone()], Some("page-2")),
                (vec![board.clone()], None),
            ],
        );
        assert_eq!(app.apps.directory.len(), 2);
        let page = Key::of(&board, None).unwrap();
        // Application pages are pinned in the sidebar; session pages are not.
        let screen = draw(&mut app, 100, 40);
        assert!(
            screen.contains("▦  Board") && !screen.contains("Notes"),
            "{screen}"
        );
        assert!(app.commands().contains(&(
            Action::Apps(Message::Open(page.clone())),
            crate::pages::commands::Label::Text("Board".into())
        )));
        // A draft stays with its page while another page is visited.
        app.apps_action(command(Command::View(Intent::Toggle("enabled".into()))));
        app.apps_action(Message::Open(page.clone()));
        assert_eq!(app.navigation.current(), Route::App(page.clone()));
        let read = app
            .apps_requests()
            .into_iter()
            .find(|request| request.key.as_ref() == Some(&page))
            .unwrap();
        let mut view = form();
        view.title = "Board".into();
        app.apps_complete(read, Ok(Output::Reply(Reply::View { view })));
        app.apply(Action::Back);
        assert_eq!(app.navigation.current(), Route::App(key()));
        assert_eq!(instance(&app).drafts["enabled"], json!(false));
        // A reconnect reads clean pages again; a page with a draft waits.
        app.apps.disconnect();
        assert!(instance(&app).blocked && !app.apps.instances[&page].blocked);
        list(&mut app, vec![(vec![notes, board], None)]);
        let requests = app.apps_requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].key.as_ref(), Some(&page));
    }

    #[test]
    fn a_session_shows_its_panels_beside_it_and_one_status_line_above_the_composer() {
        use maka_plugins::terminal_ui::view::build::*;
        let placed = |method: &str, placement: Placement| TerminalViewProjection {
            package_id: "example.goal".into(),
            method: method.into(),
            descriptor: Descriptor::new(Text::plain("Goal"), Context::Session)
                .placement(placement)
                .icon("◎", "G"),
            ..projection()
        };
        let (panel, status) = (
            placed("panel", Placement::Panel),
            placed("status", Placement::Status),
        );
        let mut app = App::new(
            "/test".into(),
            I18n::new(
                LocalePreference::Explicit(crate::i18n::Locale::En),
                crate::i18n::Locale::En,
            ),
        );
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "epoch".into(),
        };
        app.apply(Action::Visit(Route::Session("session".into())));
        app.chrome.inspector = true;
        draw(&mut app, 170, 40);
        list(&mut app, vec![(vec![panel.clone(), status.clone()], None)]);
        let reads = app.apps_requests();
        assert_eq!(
            reads.len(),
            2,
            "the status line and the panel open with the session"
        );
        for read in reads {
            let key = read.key.clone().unwrap();
            let view = View {
                version: maka_plugins::terminal_ui::VERSION,
                title: "Goal".into(),
                revision: "r1".into(),
                fields: vec![],
                actions: vec![action("pause", "Pause")],
                root: if key.method == "panel" {
                    column(
                        "root",
                        vec![
                            heading("objective", "Ship the inspector"),
                            progress("progress", 3, 5, "Criteria"),
                            button("pause", "pause", Role::Normal),
                        ],
                    )
                } else {
                    row(
                        "root",
                        vec![
                            text("objective", "Ship the inspector", Tone::Normal),
                            text("count", "3/5", Tone::Muted),
                        ],
                    )
                },
            };
            app.apps_complete(read, Ok(Output::Reply(Reply::View { view })));
        }
        let screen = draw(&mut app, 170, 40);
        assert!(
            screen.contains("Criteria") && screen.contains("60%"),
            "{screen}"
        );
        assert!(screen.contains("◎ Ship the inspector") && screen.contains("3/5"));
        // A panel's actions work while it is on screen.
        let panel = Key::of(&panel, Some("session")).unwrap();
        let pause = Message::Instance(panel.clone(), Command::View(Intent::Submit("pause".into())));
        assert!(app.apps_enabled(&pause));
        // The status icon reveals its panel and gives it the keyboard.
        let icon = app
            .apps
            .status
            .rect(&format!(
                "status/{}/icon",
                Key::of(&status, Some("session")).unwrap().node()
            ))
            .unwrap();
        app.input(Event::Mouse(MouseEvent {
            kind: crossterm::event::MouseEventKind::Down(MouseButton::Left),
            column: icon.x,
            row: icon.y,
            modifiers: KeyModifiers::NONE,
        }));
        assert_eq!(app.focus, Focus::Inspector);
        // Put away, the panels leave the conversation its full width, and
        // their actions stop with them.
        app.apply(Action::ToggleInspector);
        let screen = draw(&mut app, 170, 40);
        assert!(!screen.contains("Criteria") && screen.contains("3/5"));
        assert!(!app.apps_enabled(&pause));
        // Too narrow for both, the conversation keeps the room.
        app.apply(Action::ToggleInspector);
        assert!(!draw(&mut app, 100, 40).contains("Criteria"));
    }

    #[test]
    fn a_plugin_settings_pane_is_a_category_that_edits_in_place() {
        let web = TerminalViewProjection {
            package_id: "example.web".into(),
            method: "settings".into(),
            descriptor: Descriptor::new(Text::plain("Web search"), Context::Application)
                .placement(Placement::Settings),
            ..projection()
        };
        let mut app = App::new(
            "/test".into(),
            I18n::new(
                LocalePreference::Explicit(crate::i18n::Locale::En),
                crate::i18n::Locale::En,
            ),
        );
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "epoch".into(),
        };
        app.apply(Action::Visit(Route::Settings));
        list(&mut app, vec![(vec![web.clone()], None)]);
        let key = Key::of(&web, None).unwrap();
        let read = app
            .apps_requests()
            .pop()
            .expect("settings panes open with Settings");
        let mut view = form();
        view.title = "Web search".into();
        app.apps_complete(read, Ok(Output::Reply(Reply::View { view })));
        let screen = draw(&mut app, 110, 30);
        assert!(screen.contains("Web search"), "{screen}");
        // Choosing the category shows the pane; its fields edit in place.
        app.apply(Action::Settings(crate::pages::settings::Message::Pane(
            key.clone(),
        )));
        let screen = draw(&mut app, 110, 30);
        assert!(screen.contains("A plugin-owned form.") && screen.contains("Enabled"));
        let toggle = app
            .settings
            .surface
            .rect(&format!(
                "settings/pane/frame/rows/{}/content/root/enabled",
                key.node()
            ))
            .unwrap();
        app.input(Event::Mouse(MouseEvent {
            kind: crossterm::event::MouseEventKind::Down(MouseButton::Left),
            column: toggle.x + 1,
            row: toggle.y,
            modifiers: KeyModifiers::NONE,
        }));
        assert_eq!(app.apps.instances[&key].drafts["enabled"], json!(false));
        let save = Message::Instance(key.clone(), Command::View(Intent::Submit("save".into())));
        assert!(app.apps_enabled(&save));
        // A built-in category puts the pane away, and its actions with it.
        app.apply(Action::Settings(crate::pages::settings::Message::Category(
            crate::pages::settings::Category::Interface,
        )));
        assert!(!app.apps_enabled(&save));
        // Narrow, every category is a section of one list, the pane included.
        let screen = draw(&mut app, 50, 40);
        assert!(screen.contains("Web search") && screen.contains("A plugin-owned"));
    }

    #[test]
    fn views_compose_through_slots_that_follow_their_context_and_never_hold_themselves() {
        use maka_plugins::terminal_ui::view::build::*;
        let host = TerminalViewProjection {
            package_id: "example.board".into(),
            method: "board".into(),
            descriptor: Descriptor::new(Text::plain("Board"), Context::Application),
            ..projection()
        };
        let filler = TerminalViewProjection {
            package_id: "example.goal".into(),
            method: "card".into(),
            descriptor: Descriptor::new(Text::plain("Goal"), Context::Application).placement(
                Placement::Slot {
                    name: "board.card".into(),
                },
            ),
            ..projection()
        };
        let mut app = App::new(
            "/test".into(),
            I18n::new(
                LocalePreference::Explicit(crate::i18n::Locale::En),
                crate::i18n::Locale::En,
            ),
        );
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "epoch".into(),
        };
        app.apply(Action::Visit(Route::Workspace));
        list(&mut app, vec![(vec![host.clone(), filler.clone()], None)]);
        let board = Key::of(&host, None).unwrap();
        app.apps_action(Message::Open(board.clone()));
        let view = |card: u64| View {
            version: maka_plugins::terminal_ui::VERSION,
            title: "Board".into(),
            revision: format!("r{card}"),
            fields: vec![],
            actions: vec![],
            root: column(
                "root",
                vec![
                    heading("title", "Launch"),
                    slot("card", "board.card", json!({"card": card})),
                ],
            ),
        };
        let read = app.apps_requests().pop().unwrap();
        app.apps_complete(read, Ok(Output::Reply(Reply::View { view: view(1) })));
        // The slot opens its filler at the slot's context.
        let reads = app.apps_requests();
        assert_eq!(reads.len(), 1);
        let card = reads[0].key.clone().unwrap();
        assert_eq!(card.within.as_ref().unwrap().0, board);
        assert!(matches!(
            &reads[0].work,
            Work::Call { input: Input::Read { route, .. }, .. } if route == &json!({"card": 1})
        ));
        let mut goal = form();
        goal.title = "Goal".into();
        // A filler declaring the same slot is never filled by its host again.
        goal.root = column(
            "root",
            vec![
                text("body", "Ship the board", Tone::Normal),
                input("enabled", "enabled", "Enabled"),
                slot("nested", "board.card", json!(null)),
            ],
        );
        app.apps_complete(
            reads.into_iter().next().unwrap(),
            Ok(Output::Reply(Reply::View { view: goal })),
        );
        assert!(app.apps_requests().is_empty(), "no view fills itself");
        let screen = draw(&mut app, 110, 30);
        assert!(
            screen.contains("Launch") && screen.contains("│ Goal"),
            "{screen}"
        );
        assert!(screen.contains("│ Ship the board"));
        // Its fields work where it is shown, as its own instance.
        let path = format!(
            "app/body/frame/content/root/card/{}/body/content/root/enabled",
            card.node()
        );
        click(&mut app, &path);
        assert_eq!(app.apps.instances[&card].drafts["enabled"], json!(false));
        // A new context starts a clean filler over at the slot's new place.
        app.apps
            .instances
            .get_mut(&card)
            .unwrap()
            .drafts
            .insert("enabled".into(), json!(true));
        app.apps_action(Message::Instance(board.clone(), Command::Refresh));
        let read = app.apps_requests().pop().unwrap();
        app.apps_complete(read, Ok(Output::Reply(Reply::View { view: view(2) })));
        assert!(matches!(
            &app.apps_requests().pop().unwrap().work,
            Work::Call { input: Input::Read { route, .. }, .. } if route == &json!({"card": 2})
        ));
    }

    #[test]
    fn a_changes_stream_refreshes_untouched_views_on_screen_and_leaves_drafts_alone() {
        let mut app = app();
        let mut entry = instance(&app).entry.clone().unwrap();
        entry.descriptor = entry.descriptor.changes("notes-changed");
        instance_mut(&mut app).entry = Some(entry);
        let watch = io::Watch {
            package: "example.notes".into(),
            method: "notes-changed".into(),
            session: Some("session".into()),
            activation: instance(&app)
                .entry
                .as_ref()
                .unwrap()
                .target
                .activation
                .clone(),
        };
        assert_eq!(app.apps_watches(), [watch.clone()].into());
        app.apps_changed(&io::Watch {
            activation: uuid::Uuid::new_v4().to_string(),
            ..watch.clone()
        });
        assert!(
            next(&mut app).is_none(),
            "late changes cannot refresh a replacement"
        );
        app.apps_changed(&watch);
        let read = next(&mut app).expect("an untouched view reads again");
        app.apps_complete(read, Ok(Output::Reply(Reply::View { view: form() })));
        // A draft is never replaced under the reader; the read waits.
        app.apps_action(command(Command::View(Intent::Toggle("enabled".into()))));
        app.apps_changed(&watch);
        assert!(next(&mut app).is_none());
        assert!(instance(&app).stale);
        // Off screen, the stream closes.
        app.apply(Action::Visit(Route::Workspace));
        assert!(app.apps_watches().is_empty());
    }

    #[test]
    fn keys_typed_into_a_view_never_reach_the_checkpoint_and_cannot_be_resent() {
        use maka_plugins::terminal_ui::view::build::*;
        let mut app = app();
        {
            let instance = instance_mut(&mut app);
            let view = instance.view.as_mut().unwrap();
            view.fields.push(maka_plugins::terminal_ui::view::Field {
                id: "key".into(),
                enabled: true,
                control: Control::Text {
                    value: String::new(),
                    max_bytes: 256,
                    multiline: false,
                    placeholder: String::new(),
                    secret: true,
                },
            });
            view.actions[0].fields.push("key".into());
            view.actions[0].recovery = Some(json!({"operation":"one"}));
            view.root = column(
                "root",
                vec![
                    input("key", "key", "API key"),
                    button("save", "save", Role::Primary),
                ],
            );
            let view = view.clone();
            instance.install(view);
        }
        instance_mut(&mut app)
            .drafts
            .insert("key".into(), json!("sk-very-secret"));
        app.apps_action(save());
        let submission = next(&mut app).unwrap();
        assert!(submission.needs_checkpoint());
        let saved = serde_json::to_string(&app.apps.checkpoints("root")).unwrap();
        assert!(!saved.contains("sk-very-secret"), "{saved}");
        let checkpoint = app.apps.checkpoints("root").pop().unwrap();
        checkpoint.validate("root").unwrap();
        let mut restored = Apps::new("en");
        restored.restore(vec![checkpoint]).unwrap();
        let instance = restored.instances.get_mut(&key()).unwrap();
        assert!(instance.unresolved.as_ref().unwrap().withheld);
        instance.unrecorded = true;
        assert!(
            !instance.remedies().contains(&Command::Retry),
            "a submission missing its key can be checked, never resent"
        );
    }

    #[test]
    fn a_view_opens_a_session_it_names_without_losing_its_draft() {
        use maka_plugins::terminal_ui::view::{Node, Target};
        let mut app = app();
        {
            let instance = instance_mut(&mut app);
            let view = instance.view.as_mut().unwrap();
            view.root = Node::Column {
                key: "root".into(),
                gap: 0,
                children: vec![Node::Item {
                    key: "worker".into(),
                    title: "Open the worker".into(),
                    detail: String::new(),
                    meta: String::new(),
                    tone: Tone::Normal,
                    current: false,
                    target: Target::Session {
                        session: "worker".into(),
                    },
                }],
            };
            view.validate().unwrap();
        }
        instance_mut(&mut app)
            .drafts
            .insert("enabled".into(), json!(false));
        draw(&mut app, 90, 26);
        click(&mut app, "app/body/frame/content/root/worker");
        assert_eq!(app.navigation.current(), Route::Session("worker".into()));
        assert_eq!(instance(&app).drafts["enabled"], json!(false));
    }
}
