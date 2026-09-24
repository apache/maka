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

mod consent;
mod drafts;
mod saved;
mod tree;
pub use saved::Checkpoint;
pub(crate) mod io;
mod view;
pub(crate) use consent::{confirm as confirm_sheet, sheet as consent_sheet};
pub use io::{Output, execute};
pub use tree::Intent;
pub use view::draw;

use crate::{
    app::{Action, App, ConnectionState, Focus},
    editor::Editor,
    navigation::Route,
    ui,
};
use maka_plugins::terminal_ui::{
    Context,
    view::{Control, Field, Reply, Request as Input, View},
};
use maka_protocol::plugin::TerminalViewProjection;
use serde_json::Value;
use std::collections::{BTreeMap, VecDeque};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    Open,
    Choose(usize),
    /// What a control of the open view asks for.
    View(Intent),
    /// Submits the action its confirmation sheet asked about.
    Confirm,
    CancelConfirm,
    ApproveConsent,
    Reconcile,
    Retry,
    ResumeDraft,
    ApplyDraft,
    CancelDraft,
    DraftChoice(usize, bool),
    DismissConsent,
    Back,
    Refresh,
    Discard,
    ConfirmDiscard,
    CancelDiscard,
    Next,
}
impl Command {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Open | Self::Choose(_) => "route-extensions",
            Self::Back => "extensions-back",
            Self::Refresh => "extensions-refresh",
            Self::Discard => "extensions-discard",
            Self::ConfirmDiscard => "extensions-forget",
            Self::CancelDiscard
            | Self::CancelDraft
            | Self::DismissConsent
            | Self::CancelConfirm => "session-cancel",
            Self::Next => "sessions-next",
            Self::View(_) => "extensions-open",
            Self::Confirm => "extensions-save",
            Self::ApproveConsent => "extensions-authorize",
            Self::Reconcile => "extensions-reconcile",
            Self::Retry => "extensions-retry",
            Self::ResumeDraft => "extensions-resume-draft",
            Self::ApplyDraft => "extensions-continue-editing",
            Self::DraftChoice(_, true) => "extensions-use-draft",
            Self::DraftChoice(_, false) => "extensions-use-current",
        }
    }
}

#[derive(Clone)]
pub struct Request {
    generation: u64,
    replaying: bool,
    root: String,
    epoch: String,
    session: Option<String>,
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
    Rebind {
        entry: Box<TerminalViewProjection>,
        input: Input,
    },
    Directory(Option<String>),
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
pub(super) enum Message {
    Local(&'static str),
    Remote(String),
}

#[derive(Default)]
pub struct State {
    generation: u64,
    session: Option<String>,
    /// Plugins localize their own text; every request names the language.
    locale: String,
    pub(super) directory: Vec<TerminalViewProjection>,
    next: Option<String>,
    loaded: bool,
    /// The directory entry whose view is open.
    pub(super) entry: Option<TerminalViewProjection>,
    pub(super) view: Option<View>,
    route: Value,
    /// Routes Back returns to, each with the title it showed.
    history: VecDeque<(Value, String)>,
    pub(super) drafts: BTreeMap<String, Value>,
    pub(super) editors: BTreeMap<String, Editor>,
    pending: Option<Work>,
    unresolved: Option<saved::Pending>,
    saving: bool,
    unrecorded: bool,
    confirm_discard: bool,
    /// An action waiting on its confirmation sheet.
    confirming: Option<String>,
    review: Option<drafts::Review>,
    consent: Option<consent::Consent>,
    pub(super) busy: bool,
    writing: bool,
    pub(super) blocked: bool,
    pub(super) applied: Option<String>,
    pub(super) message: Option<Message>,
    pub surface: ui::Surface<Command>,
    /// Where the last frame put each text field.
    pub(super) wells: Vec<tree::Well>,
}
impl State {
    pub fn new(locale: &str) -> Self {
        Self {
            locale: locale.into(),
            ..Self::default()
        }
    }
    pub fn consent_visible(&self) -> bool {
        self.consent.is_some()
    }
    /// The confirmation sheet shows only while its action still asks for it.
    pub fn confirm_visible(&self) -> bool {
        self.confirmation().is_some()
    }
    fn confirmation(&self) -> Option<(&maka_plugins::terminal_ui::view::Action, &str)> {
        let id = self.confirming.as_deref()?;
        let action = self.view.as_ref()?.action(id)?;
        action.confirm.as_ref()?;
        Some((action, id))
    }
    fn dirty_field(&self, field: &Field) -> bool {
        self.drafts.get(&field.id) != Some(&drafts::value(&field.control))
    }
    fn dirty(&self) -> bool {
        self.view
            .as_ref()
            .is_some_and(|view| view.fields.iter().any(|field| self.dirty_field(field)))
    }
    pub fn invalidate_geometry(&mut self) {
        if let Some(consent) = &mut self.consent {
            consent.rendered = false;
        }
        for editor in self.editors.values_mut() {
            editor.invalidate_geometry();
        }
    }
    pub fn disconnect(&mut self) {
        self.saving = false;
        self.unrecorded = false;
        self.confirm_discard = false;
        self.confirming = None;
        self.review = None;
        self.consent = None;
        self.generation += 1;
        self.pending = None;
        self.busy = false;
        self.blocked = self.entry.is_some();
        self.loaded = false;
        self.directory.clear();
        self.next = None;
        // Retain drafts, but revoke every operation on the old registration.
        self.message = self.blocked.then_some(Message::Local(
            if self.writing || self.unresolved.is_some() {
                "extensions-unknown"
            } else if self.view.is_some() {
                "extensions-restored"
            } else {
                "extensions-disconnected"
            },
        ));
        self.writing = false;
    }
    fn read(&mut self) {
        self.pending = self.entry.clone().map(|entry| Work::Call {
            entry: Box::new(entry),
            input: Input::Read {
                route: self.route.clone(),
                locale: self.locale.clone(),
            },
        });
    }
    /// Another place: a fresh surface starts at its top, focus on its first control.
    fn arrive(&mut self) {
        self.surface = ui::Surface::default();
        self.surface.start_at("extensions/body/");
        self.wells.clear();
    }
    fn install(&mut self, view: View) {
        self.drafts.clear();
        self.editors.clear();
        for field in &view.fields {
            if let Control::Text {
                value, max_bytes, ..
            } = &field.control
            {
                let mut editor = Editor::bounded(*max_bytes, "extensions-field-limit");
                editor.insert(value);
                editor.clear_history();
                self.editors.insert(field.id.clone(), editor);
            }
            self.drafts
                .insert(field.id.clone(), drafts::value(&field.control));
        }
        self.view = Some(view);
        self.blocked = false;
    }
    /// Whether the open view offers this control at all. Requests in flight
    /// are gated when a command runs, never by disabling what has focus.
    fn offered(&self, intent: &Intent) -> bool {
        let Some(view) = &self.view else {
            return false;
        };
        if self.blocked || self.review.is_some() {
            return false;
        }
        match intent {
            // Leaving would drop the drafts; they are saved or discarded first.
            Intent::Navigate(_) => !self.dirty(),
            Intent::Submit(id) => view.action(id).is_some_and(|action| {
                action.enabled
                    && view
                        .fields
                        .iter()
                        .all(|field| !self.dirty_field(field) || action.fields.contains(&field.id))
            }),
            Intent::Toggle(id) | Intent::Pick(id, _) | Intent::Commit(id) => {
                view.field(id).is_some_and(|field| field.enabled)
            }
        }
    }
    /// What Return in a one-line field submits: the primary button that
    /// sends the field, else the only action that does.
    fn default_action(&self, field: &str) -> Option<String> {
        let view = self.view.as_ref()?;
        let sends = |id: &str| {
            view.action(id)
                .is_some_and(|action| action.fields.iter().any(|item| item == field))
        };
        if let Some(id) = tree::primary_actions(view).into_iter().find(|id| sends(id)) {
            return Some(id.to_owned());
        }
        let mut senders = view.actions.iter().filter(|action| sends(&action.id));
        let only = senders.next()?;
        senders.next().is_none().then(|| only.id.clone())
    }
    fn navigate(&mut self, route: Value) {
        if self.history.len() == 64 {
            self.history.pop_front();
        }
        let title = self
            .view
            .as_ref()
            .map_or_else(String::new, |view| view.title.clone());
        self.history
            .push_back((std::mem::replace(&mut self.route, route), title));
        self.arrive();
        self.read();
    }
    fn submit(&mut self, id: &str) {
        let Some(view) = &self.view else {
            return;
        };
        let Some(action) = view.action(id) else {
            return;
        };
        let fields = action
            .fields
            .iter()
            .filter_map(|id| self.drafts.get(id).map(|value| (id.clone(), value.clone())))
            .collect();
        match view.submission(self.route.clone(), id, fields, self.locale.clone()) {
            Ok(input) => {
                self.pending = self.entry.clone().map(|entry| Work::Call {
                    entry: Box::new(entry),
                    input,
                })
            }
            Err(_) => self.message = Some(Message::Local("extensions-invalid-fields")),
        }
    }
    fn directory(&mut self) {
        self.view = None;
        self.entry = None;
        self.directory.clear();
        self.next = None;
        self.loaded = false;
        self.drafts.clear();
        self.editors.clear();
        self.history.clear();
        self.arrive();
        self.pending = Some(Work::Directory(None));
    }
    /// Recovery and draft commands, shown beside the message that explains them.
    fn remedies(&self) -> Vec<Command> {
        if self.review.is_some() {
            return vec![Command::CancelDraft, Command::ApplyDraft];
        }
        if self.confirm_discard {
            return vec![Command::CancelDiscard, Command::ConfirmDiscard];
        }
        let mut commands = vec![];
        if self
            .unresolved
            .as_ref()
            .is_some_and(|pending| pending.recovery.is_some())
        {
            commands.push(Command::Reconcile);
            if self.unrecorded {
                commands.push(Command::Retry);
            }
        }
        if self.blocked && self.unresolved.is_none() && self.view.is_some() {
            commands.push(Command::ResumeDraft);
        }
        commands
    }
    /// What the page's title bar names: the open view, else its entry.
    pub fn title(&self, locale: &str) -> Option<String> {
        self.view
            .as_ref()
            .map(|view| view.title.clone())
            .or_else(|| {
                self.entry
                    .as_ref()
                    .map(|entry| entry.descriptor.title.resolve(locale).to_owned())
            })
    }
}

impl App {
    /// Every command the page offers now, for the palette.
    pub fn extensions_actions(&self) -> Vec<Action> {
        let state = &self.extensions;
        let mut commands = state.remedies();
        if state.review.is_none() && !state.confirm_discard {
            if state.entry.is_some() {
                commands.insert(0, Command::Back);
            }
            commands.push(if state.dirty() || state.blocked {
                Command::Discard
            } else {
                Command::Refresh
            });
            if state.entry.is_none() && state.next.is_some() {
                commands.push(Command::Next);
            }
        }
        commands.into_iter().map(Action::Extension).collect()
    }
    pub fn extensions_request(&mut self) -> Option<Request> {
        let ConnectionState::Connected { root_id, epoch } = &self.connection else {
            return None;
        };
        if self.extensions.busy {
            return None;
        }
        if self.navigation.current() == Route::Extensions
            && !self.extensions.loaded
            && !self.extensions.blocked
            && self.extensions.entry.is_none()
            && self.extensions.pending.is_none()
        {
            // Restoring navigation is a fresh read, not restoring an old registration.
            if self.extensions.session.is_none()
                && let Route::Session(id) = self.navigation.destination(false)
                && self.tabs.contains(&id)
            {
                self.extensions.session = Some(id);
            }
            self.extensions.pending = Some(Work::Directory(None));
        }
        let work = self.extensions.pending.take()?;
        let replaying = self.extensions.unresolved.is_some();
        self.extensions.generation += 1;
        self.extensions.busy = true;
        self.extensions.writing = matches!(
            work,
            Work::Call {
                input: Input::Submit { .. },
                ..
            } | Work::Authorize { .. }
        );
        if self.extensions.writing {
            let (input, proposal) = match &work {
                Work::Call { input, .. } => (input.clone(), None),
                Work::Authorize {
                    input, proposal, ..
                } => (input.clone(), Some(proposal.clone())),
                _ => unreachable!(),
            };
            let recovery = match &input {
                Input::Submit { action, .. } => self
                    .extensions
                    .view
                    .as_ref()
                    .and_then(|view| view.action(action))
                    .and_then(|action| action.recovery.clone()),
                _ => None,
            };
            self.extensions.unresolved = Some(saved::Pending {
                input,
                proposal,
                recovery,
            });
            self.extensions.saving = true;
            self.extensions.unrecorded = false;
        }
        self.extensions.message = None;
        Some(Request {
            generation: self.extensions.generation,
            replaying,
            root: root_id.clone(),
            epoch: epoch.clone(),
            session: self.extensions.session.clone(),
            work,
        })
    }
    pub fn extensions_complete(&mut self, request: Request, result: Result<Output, io::Failure>) {
        if request.generation != self.extensions.generation
            || !matches!(&self.connection,
            ConnectionState::Connected { root_id, epoch } if *root_id == request.root && *epoch == request.epoch)
        {
            return;
        }
        let state = &mut self.extensions;
        state.busy = false;
        state.saving = false;
        state.writing = false;
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
                state.reload_draft(*entry, view);
                return;
            }
            Ok(Output::Rebound { entry, reply }) if recovering || reloading => {
                state.entry = Some(*entry);
                Ok(Output::Reply(reply))
            }
            Ok(Output::Rebound { .. }) => Err(io::Failure { unknown: false }),
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
            state.unresolved = None;
        }
        match result {
            Ok(Output::Rebound { .. }) => unreachable!(),
            Ok(Output::Reply(Reply::Unrecorded)) => {
                state.blocked = true;
                state.unrecorded = recovering;
                state.message = Some(Message::Local("extensions-unrecorded"));
            }
            Ok(Output::Directory(page)) => {
                state.loaded = true;
                state.directory = page.items;
                state.next = page.next_cursor;
                state.view = None;
                state.entry = None;
                state.blocked = false;
            }
            Ok(Output::Reply(Reply::View { view })) => state.install(view),
            Ok(Output::Reply(Reply::Consent { request: proposal })) => {
                // A retry needing consent does not settle an earlier lost write.
                state.blocked = request.replaying;
                // Preparing consent does not authorize anything. Leaving the page
                // cancels presentation, without discarding the form or opening a
                // delayed modal over another destination.
                if self.navigation.current() != Route::Extensions {
                    return;
                }
                if let Work::Call {
                    entry,
                    input: input @ Input::Submit { grant: None, .. },
                } = request.work
                {
                    state.consent = Some(consent::Consent {
                        entry,
                        input,
                        proposal,
                        rendered: false,
                    });
                } else {
                    state.blocked = true;
                    state.message = Some(Message::Local("extensions-failed"));
                }
            }
            Ok(Output::Reply(Reply::Applied { route })) => {
                state.unresolved = None;
                state.unrecorded = false;
                state.blocked = false;
                state.applied = match &request.work {
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
                if state.route != route {
                    state.history.clear();
                    state.arrive();
                }
                state.route = route;
                state.view = None;
                state.drafts.clear();
                state.editors.clear();
                state.read();
            }
            Ok(Output::Reply(Reply::Conflict)) => {
                state.blocked = true;
                state.message = Some(Message::Local("extensions-conflict"));
            }
            Ok(Output::Reply(Reply::Rejected { message })) => {
                state.blocked = recovering || reloading || request.replaying;
                state.message = Some(Message::Remote(message));
            }
            Err(failure) => {
                state.blocked = true;
                state.message = Some(Message::Local(if failure.unknown {
                    "extensions-unknown"
                } else {
                    "extensions-failed"
                }));
            }
        }
    }
    /// Approval needs the terms on screen; the sheet layer reports that.
    pub(crate) fn consent_presented(&mut self, shown: bool) {
        if let Some(consent) = &mut self.extensions.consent {
            consent.rendered = shown;
        }
    }
    /// The language changed: an open, untouched view reads itself again.
    pub(crate) fn extensions_relocalize(&mut self) {
        let state = &mut self.extensions;
        state.locale = self.i18n.locale().id().into();
        if state.entry.is_some()
            && state.view.is_some()
            && !state.dirty()
            && !state.blocked
            && state.unresolved.is_none()
            && state.pending.is_none()
        {
            state.read();
        }
    }
    pub fn extensions_enabled(&self, command: &Command) -> bool {
        let state = &self.extensions;
        let idle = !state.busy && state.pending.is_none();
        match command {
            Command::DismissConsent | Command::CancelConfirm => self.extensions_offered(command),
            Command::Open => !state.busy && self.extensions_offered(command),
            _ => idle && self.extensions_offered(command),
        }
    }
    /// Whether the page offers a command, apart from a request in flight:
    /// what its controls show, so focus stays put while one completes.
    pub(crate) fn extensions_offered(&self, command: &Command) -> bool {
        let state = &self.extensions;
        let connected = matches!(self.connection, ConnectionState::Connected { .. });
        let here = self.navigation.current() == Route::Extensions;
        if let Some(consent) = &state.consent {
            return match command {
                Command::DismissConsent => true,
                Command::ApproveConsent => {
                    consent.rendered
                        && (!state.blocked || state.unresolved.is_some())
                        && here
                        && connected
                }
                _ => false,
            };
        }
        if let Some((_, id)) = state.confirmation() {
            return match command {
                Command::CancelConfirm => true,
                Command::Confirm => {
                    connected && here && state.offered(&Intent::Submit(id.to_owned()))
                }
                _ => false,
            };
        }
        if *command == Command::Open {
            return connected;
        }
        if !connected || !here {
            return false;
        }
        match command {
            Command::ResumeDraft => {
                state.blocked
                    && state.view.is_some()
                    && state.unresolved.is_none()
                    && state.review.is_none()
            }
            Command::ApplyDraft => {
                state
                    .review
                    .as_ref()
                    .is_some_and(|review| review.resolved())
                    && state.unresolved.is_none()
            }
            Command::CancelDraft => state.review.is_some(),
            Command::DraftChoice(index, _) => state
                .review
                .as_ref()
                .is_some_and(|review| *index < review.conflicts.len()),
            Command::Reconcile => {
                !state.confirm_discard
                    && state
                        .unresolved
                        .as_ref()
                        .is_some_and(|pending| pending.recovery.is_some())
            }
            Command::Retry => {
                !state.confirm_discard
                    && state.unrecorded
                    && state
                        .unresolved
                        .as_ref()
                        .is_some_and(|pending| pending.recovery.is_some())
            }
            Command::ConfirmDiscard | Command::CancelDiscard => state.confirm_discard,
            Command::Discard => state.dirty() || state.blocked,
            Command::Back => {
                state.entry.is_some()
                    && !state.dirty()
                    && state.unresolved.is_none()
                    && !state.blocked
            }
            Command::Refresh => !state.dirty() && !state.blocked,
            Command::Next => state.entry.is_none() && state.next.is_some() && !state.blocked,
            Command::Choose(index) => {
                !state.blocked
                    && state.directory.get(*index).is_some_and(|entry| {
                        entry.descriptor.context == Context::Application || state.session.is_some()
                    })
            }
            Command::View(Intent::Commit(field)) => {
                state.offered(&Intent::Commit(field.clone()))
                    && state
                        .default_action(field)
                        .is_some_and(|id| state.offered(&Intent::Submit(id)))
            }
            Command::View(intent) => state.offered(intent),
            Command::Open
            | Command::Confirm
            | Command::CancelConfirm
            | Command::ApproveConsent
            | Command::DismissConsent => false,
        }
    }
    pub fn extensions_action(&mut self, command: Command) {
        if !self.extensions_enabled(&command) {
            return;
        }
        if command == Command::Open {
            if self.extensions.dirty()
                || self.extensions.blocked
                || self.extensions.unresolved.is_some()
            {
                self.apply(Action::Visit(Route::Extensions));
                return;
            }
            let session = match self.navigation.current() {
                Route::Session(id) => Some(id),
                _ => None,
            };
            let generation = self.extensions.generation + 1;
            self.extensions = State {
                session,
                generation,
                locale: self.i18n.locale().id().into(),
                pending: Some(Work::Directory(None)),
                ..State::default()
            };
            self.apply(Action::Visit(Route::Extensions));
            return;
        }
        let state = &mut self.extensions;
        state.applied = None;
        match command {
            Command::ResumeDraft => {
                state.pending = Some(Work::Rebind {
                    entry: Box::new(state.entry.clone().unwrap()),
                    input: Input::Read {
                        route: state.route.clone(),
                        locale: state.locale.clone(),
                    },
                });
            }
            Command::ApplyDraft => state.accept_draft(),
            Command::CancelDraft => {
                state.review = None;
                state.message = Some(Message::Local("extensions-restored"));
            }
            Command::DraftChoice(index, mine) => {
                state.review.as_mut().unwrap().conflicts[index].mine = Some(mine);
            }
            Command::Reconcile => {
                state.unrecorded = false;
                state.pending = Some(Work::Rebind {
                    entry: Box::new(state.entry.clone().unwrap()),
                    input: Input::Recover {
                        route: state.unresolved.as_ref().unwrap().recovery.clone().unwrap(),
                        locale: state.locale.clone(),
                    },
                });
            }
            Command::Retry => {
                state.unrecorded = false;
                let pending = state.unresolved.as_ref().unwrap();
                let entry = Box::new(state.entry.clone().unwrap());
                state.pending = Some(match &pending.proposal {
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
            Command::Discard if state.unresolved.is_some() => {
                state.confirm_discard = true;
                state.message = Some(Message::Local("extensions-forget-confirm"));
            }
            Command::CancelDiscard => {
                state.confirm_discard = false;
                state.message = Some(Message::Local("extensions-unknown"));
            }
            Command::ApproveConsent => {
                let consent = state.consent.take().unwrap();
                state.pending = Some(Work::Authorize {
                    entry: consent.entry,
                    input: consent.input,
                    proposal: consent.proposal,
                });
            }
            Command::DismissConsent => state.consent = None,
            Command::Confirm => {
                if let Some(id) = state.confirming.take() {
                    state.submit(&id);
                }
            }
            Command::CancelConfirm => state.confirming = None,
            Command::Choose(index) => {
                state.entry = Some(state.directory[index].clone());
                state.route = Value::Null;
                state.history.clear();
                state.arrive();
                state.read();
            }
            Command::View(Intent::Navigate(route)) => state.navigate(route),
            Command::View(Intent::Submit(id)) => state.submit_or_confirm(id),
            Command::View(Intent::Commit(field)) => {
                if let Some(id) = state.default_action(&field) {
                    state.submit_or_confirm(id);
                }
            }
            Command::View(Intent::Toggle(field)) => {
                if let Some(Value::Bool(value)) = state.drafts.get_mut(&field) {
                    *value = !*value;
                }
            }
            Command::View(Intent::Pick(field, value)) => {
                let valid = state
                    .view
                    .as_ref()
                    .and_then(|view| view.field(&field))
                    .is_some_and(|field| {
                        matches!(&field.control, Control::Choice { options, .. }
                            if options.iter().any(|option| option.value == value))
                    });
                if valid {
                    state.drafts.insert(field, Value::String(value));
                }
            }
            Command::Back => match state.history.pop_back() {
                Some((route, _)) => {
                    state.route = route;
                    state.arrive();
                    state.read();
                }
                None => state.directory(),
            },
            Command::Discard | Command::ConfirmDiscard => {
                state.review = None;
                state.unresolved = None;
                state.unrecorded = false;
                state.confirm_discard = false;
                state.message = None;
                state.generation += 1;
                state.blocked = false;
                state.directory();
            }
            Command::Refresh => {
                if state.entry.is_some() {
                    state.read();
                } else {
                    state.pending = Some(Work::Directory(None));
                }
            }
            Command::Next => state.pending = Some(Work::Directory(state.next.clone())),
            Command::Open => {}
        }
    }
    /// A focused text field takes typing, pastes and its own pointer ahead
    /// of the surface; Esc steps back a level.
    pub(crate) fn extensions_owner_input(
        &mut self,
        event: &crossterm::event::Event,
    ) -> Option<(bool, Option<Action>)> {
        use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers, MouseEventKind};
        let state = &mut self.extensions;
        if state.surface.captures() {
            return None;
        }
        if let Event::Key(key) = event
            && key.kind != KeyEventKind::Release
            && key.code == KeyCode::Esc
            && key.modifiers.is_empty()
            && self.focus == Focus::Page
        {
            let command = if state.review.is_some() {
                Command::CancelDraft
            } else if state.entry.is_some() {
                Command::Back
            } else {
                return None;
            };
            self.extensions_action(command);
            return Some((true, None));
        }
        let editable = !state.busy && state.pending.is_none() && !state.blocked;
        let enabled = |state: &State, field: &str| {
            state
                .view
                .as_ref()
                .and_then(|view| view.field(field))
                .is_some_and(|field| field.enabled)
        };
        if let Event::Mouse(mouse) = event {
            let well = state.wells.iter().find(|well| {
                enabled(state, &well.field)
                    && state
                        .editors
                        .get(&well.field)
                        .is_some_and(|editor| editor.takes(mouse))
            })?;
            let (field, path) = (well.field.clone(), well.path.clone());
            let press = matches!(mouse.kind, MouseEventKind::Down(_));
            let changed = editable && state.editors.get_mut(&field)?.mouse(*mouse);
            if press {
                state.surface.focus(path);
                self.focus = Focus::Page;
            }
            return Some((changed || press, None));
        }
        if self.focus != Focus::Page {
            return None;
        }
        let focused = state.surface.focused()?;
        let well = state.wells.iter().find(|well| well.path == focused)?;
        let (field, multiline) = (well.field.clone(), well.multiline);
        if !enabled(state, &field) {
            return None;
        }
        let changed = match event {
            Event::Key(key) if key.kind != KeyEventKind::Release => {
                if key
                    .modifiers
                    .intersects(KeyModifiers::ALT | KeyModifiers::SUPER | KeyModifiers::META)
                    || key.modifiers.contains(KeyModifiers::CONTROL)
                        && !matches!(
                            key.code,
                            KeyCode::Char('a' | 'z' | 'y' | 'u' | 'k')
                                | KeyCode::Left
                                | KeyCode::Right
                                | KeyCode::Backspace
                                | KeyCode::Delete
                        )
                {
                    return None;
                }
                match key.code {
                    KeyCode::Tab | KeyCode::BackTab | KeyCode::F(_) | KeyCode::Esc => return None,
                    KeyCode::Enter | KeyCode::Up | KeyCode::Down if !multiline => return None,
                    _ if !editable => return Some((false, None)),
                    _ => state.editors.get_mut(&field)?.key(*key),
                }
            }
            Event::Paste(text) if editable => {
                let editor = state.editors.get_mut(&field)?;
                if multiline {
                    editor.insert(text)
                } else {
                    editor.insert(&crate::view::safe(text))
                }
            }
            Event::Paste(_) => return Some((false, None)),
            _ => return None,
        };
        if changed {
            state.applied = None;
            let text = state.editors[&field].text().to_owned();
            state.drafts.insert(field, Value::String(text));
        }
        Some((true, None))
    }
}

impl State {
    fn submit_or_confirm(&mut self, id: String) {
        let asks = self
            .view
            .as_ref()
            .and_then(|view| view.action(&id))
            .is_some_and(|action| action.confirm.is_some());
        if asks {
            self.confirming = Some(id);
        } else {
            self.submit(&id);
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::i18n::{I18n, LocalePreference};
    use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent};
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

    pub(crate) const TOGGLE: &str = "extensions/body/frame/content/root/enabled";
    pub(crate) const NAME: &str = "extensions/body/frame/content/root/name";

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
    pub(crate) fn save() -> Command {
        Command::View(Intent::Submit("save".into()))
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
        let rect = app.extensions.surface.rect(path).unwrap();
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
        app.extensions_action(Command::Open);
        let request = app.extensions_request().unwrap();
        assert_eq!(request.session.as_deref(), Some("session"));
        app.extensions_complete(
            request,
            Ok(Output::Directory(maka_protocol::plugin::Page {
                items: vec![projection()],
                next_cursor: None,
            })),
        );
        app.extensions_action(Command::Choose(0));
        let request = app.extensions_request().unwrap();
        assert!(matches!(
            &request.work,
            Work::Call { input: Input::Read { locale, .. }, .. } if locale == "en"
        ));
        app.extensions_complete(request, Ok(Output::Reply(Reply::View { view: form() })));
        app
    }
    #[test]
    fn contributed_form_supports_mouse_keyboard_and_retains_conflicting_drafts_without_rebinding() {
        let mut app = app();
        let screen = draw(&mut app, 90, 26);
        assert!(screen.contains("Notebook") && screen.contains("‹ Plugin pages"));
        click(&mut app, TOGGLE);
        assert_eq!(app.extensions.drafts["enabled"], json!(false));
        draw(&mut app, 90, 26);
        assert!(!app.extensions_enabled(&Command::Refresh));
        app.input(Event::Key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE)));
        assert_eq!(app.extensions.surface.focused(), Some(NAME));
        app.input(Event::Key(KeyEvent::new(
            KeyCode::Char('a'),
            KeyModifiers::CONTROL,
        )));
        app.input(Event::Paste("Renamed".into()));
        assert_eq!(app.extensions.drafts["name"], json!("Renamed"));
        app.extensions.view.as_mut().unwrap().actions[0]
            .fields
            .pop();
        assert!(
            !app.extensions_enabled(&save()),
            "saving a subset must not discard other drafts"
        );
        app.extensions.view.as_mut().unwrap().actions[0]
            .fields
            .push("name".into());
        // Return in the one-line field submits the primary button's action.
        draw(&mut app, 90, 26);
        app.input(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::NONE,
        )));
        let request = app.extensions_request().unwrap();
        let Work::Call {
            entry,
            input: Input::Submit {
                fields, revision, ..
            },
        } = &request.work
        else {
            panic!("submit");
        };
        assert_eq!(entry.target, app.extensions.entry.as_ref().unwrap().target);
        assert_eq!(fields["enabled"], json!(false));
        assert_eq!(fields["name"], json!("Renamed"));
        assert_eq!(revision, "one");
        app.extensions_complete(request.clone(), Ok(Output::Reply(Reply::Conflict)));
        assert_eq!(app.extensions.drafts["name"], json!("Renamed"));
        assert!(!app.extensions_enabled(&save()));
        assert!(
            app.extensions_request().is_none(),
            "no automatic refresh or retry"
        );
        assert!(draw(&mut app, 44, 18).contains("draft"));
        app.extensions_action(Command::Discard);
        let fresh = app.extensions_request().unwrap();
        app.extensions_complete(request, Ok(Output::Reply(Reply::View { view: form() })));
        assert!(
            app.extensions.view.is_none(),
            "late old result cannot replace new directory"
        );
        app.extensions_complete(
            fresh,
            Ok(Output::Directory(maka_protocol::plugin::Page {
                items: vec![projection()],
                next_cursor: None,
            })),
        );
        assert_eq!(app.extensions.directory.len(), 1);
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
        app.extensions_action(Command::Refresh);
        let request = app.extensions_request().unwrap();
        app.extensions_complete(request, Ok(Output::Reply(Reply::View { view })));
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
        click(&mut app, "extensions/body/frame/content/root/mode");
        assert!(app.extensions.surface.captures());
        app.input(Event::Key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE)));
        app.input(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::NONE,
        )));
        assert_eq!(app.extensions.drafts["mode"], json!("careful"));
        app.extensions_action(Command::View(Intent::Pick("mode".into(), "absent".into())));
        assert_eq!(app.extensions.drafts["mode"], json!("careful"));
        // Leaving with a changed field is not offered; Discard is.
        assert!(!app.extensions_enabled(&Command::View(Intent::Navigate(json!({"page":1})))));
        app.extensions.drafts.insert("mode".into(), json!("fast"));
        // A destructive action asks first, in the shell's own sheet.
        draw(&mut app, 100, 30);
        click(&mut app, "extensions/body/frame/content/root/delete/button");
        assert!(app.extensions_request().is_none());
        assert!(app.extensions.confirm_visible());
        let screen = draw(&mut app, 100, 30);
        assert!(screen.contains("Delete notebook?") && screen.contains("Its pages go too."));
        app.input(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::NONE,
        )));
        assert!(
            !app.extensions.confirm_visible(),
            "Enter defaults to cancel"
        );
        assert!(app.extensions_request().is_none());
        app.extensions_action(save_like("delete"));
        app.extensions_action(Command::Confirm);
        assert!(matches!(
            app.extensions_request().unwrap().work,
            Work::Call { input: Input::Submit { ref action, .. }, .. } if action == "delete"
        ));

        // Items read another route; Back returns, naming where it goes.
        let mut app = self::app();
        app.extensions.view.as_mut().unwrap().root = column(
            "root",
            vec![link("page", "First page", json!({"page":1})).into()],
        );
        draw(&mut app, 90, 26);
        click(&mut app, "extensions/body/frame/content/root/page");
        let request = app.extensions_request().unwrap();
        assert!(matches!(
            &request.work,
            Work::Call { input: Input::Read { route, .. }, .. } if route == &json!({"page":1})
        ));
        let mut detail = form();
        detail.title = "First page".into();
        app.extensions_complete(request, Ok(Output::Reply(Reply::View { view: detail })));
        let screen = draw(&mut app, 90, 26);
        assert!(screen.contains("‹ Notebook") && screen.contains("First page"));
        app.input(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        assert!(matches!(
            app.extensions_request().unwrap().work,
            Work::Call {
                input: Input::Read {
                    route: Value::Null,
                    ..
                },
                ..
            }
        ));
    }

    fn save_like(action: &str) -> Command {
        Command::View(Intent::Submit(action.into()))
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
        app.extensions.drafts.insert("name".into(), json!("Draft"));
        let editor = app.extensions.editors.get_mut("name").unwrap();
        editor.clear_if_unchanged("My notes");
        editor.insert("Draft");
        let prepare = |app: &mut App| {
            app.extensions_action(save());
            let request = app.extensions_request().unwrap();
            app.extensions_complete(
                request,
                Ok(Output::Reply(Reply::Consent {
                    request: proposal.clone(),
                })),
            );
        };
        prepare(&mut app);
        assert!(app.extensions_request().is_none());
        assert!(!app.extensions_enabled(&Command::ApproveConsent));
        let screen = draw(&mut app, 90, 28);
        assert!(screen.contains("Send notifications"));
        assert!(!screen.contains("Untrusted title"));
        app.input(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::NONE,
        )));
        assert!(
            !app.extensions.consent_visible(),
            "Enter defaults to cancel"
        );
        assert_eq!(app.extensions.drafts["name"], json!("Draft"));
        assert!(app.extensions_request().is_none());

        prepare(&mut app);
        draw(&mut app, 90, 28);
        app.input(Event::Mouse(crossterm::event::MouseEvent {
            kind: crossterm::event::MouseEventKind::Down(MouseButton::Left),
            column: 0,
            row: 0,
            modifiers: KeyModifiers::NONE,
        }));
        assert!(!app.extensions.consent_visible());
        assert_eq!(app.navigation.current(), Route::Extensions);
        assert!(app.extensions_request().is_none());

        prepare(&mut app);
        draw(&mut app, 30, 10);
        app.extensions_action(Command::ApproveConsent);
        assert!(
            app.extensions.consent_visible(),
            "hidden terms cannot be approved"
        );
        draw(&mut app, 90, 28);
        app.input(Event::Key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE)));
        app.input(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::NONE,
        )));
        let request = app.extensions_request().unwrap();
        let Work::Authorize {
            entry,
            input,
            proposal: actual,
        } = &request.work
        else {
            panic!("explicit approval")
        };
        assert_eq!(entry.target, app.extensions.entry.as_ref().unwrap().target);
        assert_eq!(actual, &proposal);
        let Input::Submit { fields, grant, .. } = input else {
            panic!("submit")
        };
        assert_eq!(fields["name"], json!("Draft"));
        assert!(grant.is_none());
        let saved = app.extensions.checkpoint("root").unwrap();
        saved.validate("root").unwrap();
        let mut restored = State::default();
        restored.restore(saved).unwrap();
        assert!(restored.pending.is_none());
        assert!(
            restored.consent.is_none(),
            "restoring explicit consent is not another approval"
        );
        assert_eq!(
            restored.unresolved.unwrap().proposal.as_ref(),
            Some(&proposal)
        );
        app.extensions_complete(request, Err(io::Failure { unknown: true }));
        assert!(!app.extensions_enabled(&save()));
        assert!(app.extensions_request().is_none());

        let mut app = self::app();
        app.extensions_action(save());
        let request = app.extensions_request().unwrap();
        app.apply(Action::Visit(Route::Workspace));
        app.extensions_complete(
            request,
            Ok(Output::Reply(Reply::Consent { request: proposal })),
        );
        assert!(!app.extensions.consent_visible());
        assert!(app.extensions_request().is_none());
    }

    #[test]
    fn disconnect_revokes_controls_preserves_drafts_and_tiny_layout_has_no_stale_clicks() {
        let mut app = app();
        draw(&mut app, 80, 24);
        app.extensions_action(Command::View(Intent::Toggle("enabled".into())));
        app.extensions_action(save());
        let request = app.extensions_request().unwrap();
        app.extensions.disconnect();
        app.extensions_complete(
            request,
            Ok(Output::Reply(Reply::Applied { route: Value::Null })),
        );
        assert_eq!(app.extensions.drafts["enabled"], json!(false));
        assert!(matches!(
            app.extensions.message,
            Some(Message::Local("extensions-unknown"))
        ));
        assert!(!app.extensions_enabled(&save()));
        draw(&mut app, 25, 8);
        assert!(app.extensions.surface.rect(TOGGLE).is_none());
        assert!(app.extensions_request().is_none());
    }

    #[test]
    fn saved_unknown_submission_queries_first_and_retries_only_the_original_idempotent_intent() {
        let mut app = app();
        let recovery = json!({"operation":"one"});
        app.extensions.view.as_mut().unwrap().actions[0].recovery = Some(recovery.clone());
        app.extensions_action(Command::View(Intent::Toggle("enabled".into())));
        app.extensions_action(save());
        let original = app.extensions_request().unwrap();
        assert!(original.needs_checkpoint());
        let frozen = app.extensions.unresolved.as_ref().unwrap().input.clone();
        let saved = serde_json::to_value(app.extensions.checkpoint("root").unwrap()).unwrap();
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
        app.extensions.disconnect();
        assert!(!app.extensions_after_checkpoint(&original, &Ok(())));
        app.extensions = State::new("en");
        app.extensions
            .restore(serde_json::from_value(saved).unwrap())
            .unwrap();
        assert!(app.extensions_request().is_none());
        assert!(!app.extensions_enabled(&Command::Retry));
        assert!(!app.extensions_enabled(&Command::Back));
        assert!(!app.extensions_enabled(&save()));
        app.apply(Action::Visit(Route::Workspace));
        app.extensions_action(Command::Open);
        assert_eq!(app.navigation.current(), Route::Extensions);
        app.extensions_action(Command::Reconcile);
        let query = app.extensions_request().unwrap();
        assert!(
            matches!(&query.work, Work::Rebind { input: Input::Recover { route, .. }, .. } if route == &recovery)
        );
        assert!(!query.needs_checkpoint());
        app.extensions_complete(query, Err(io::Failure { unknown: false }));
        assert!(app.extensions.unresolved.is_some());
        assert!(!app.extensions_enabled(&Command::Retry));
        app.extensions_action(Command::Reconcile);
        let query = app.extensions_request().unwrap();
        let mut entry = app.extensions.entry.clone().unwrap();
        entry.target.registration = uuid::Uuid::new_v4();
        app.extensions_complete(
            query,
            Ok(Output::Rebound {
                entry: Box::new(entry.clone()),
                reply: Reply::Unrecorded,
            }),
        );
        assert!(draw(&mut app, 58, 24).contains("Retry original submission"));
        app.extensions_action(Command::Retry);
        let retry = app.extensions_request().unwrap();
        assert!(retry.needs_checkpoint());
        assert!(
            matches!(&retry.work, Work::Call { entry: actual, input } if actual.target == entry.target && input == &frozen)
        );
        assert!(!app.extensions_after_checkpoint(&original, &Ok(())));
        assert!(app.extensions_after_checkpoint(&retry, &Ok(())));
        assert!(!app.extensions_after_checkpoint(&retry, &Ok(())));
        // A rejection of this retry cannot settle the earlier uncertain attempt.
        app.extensions_complete(retry, Err(io::Failure { unknown: false }));
        assert!(app.extensions.unresolved.is_some());
        assert!(!app.extensions_enabled(&save()));
        app.extensions_action(Command::Discard);
        assert!(app.extensions.unresolved.is_some());
        assert!(app.extensions_request().is_none());
        assert!(draw(&mut app, 90, 24).contains("does not cancel"));
        app.extensions_action(Command::CancelDiscard);
        app.extensions_action(Command::Reconcile);
        let query = app.extensions_request().unwrap();
        app.extensions_complete(
            query,
            Ok(Output::Rebound {
                entry: Box::new(entry),
                reply: Reply::Applied {
                    route: json!({"task":"original"}),
                },
            }),
        );
        assert!(app.extensions.unresolved.is_none());
        assert!(
            matches!(app.extensions_request().unwrap().work, Work::Call { input: Input::Read { route, .. }, .. } if route == json!({"task":"original"}))
        );
    }
}
