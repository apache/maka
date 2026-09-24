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

//! One open view: its route and history, the view it last read, the
//! drafts over that view, and the write it may be waiting to settle.

use super::{Intent, Message, Work, drafts, saved, tree};
use crate::{editor::Editor, ui};
use maka_plugins::terminal_ui::view::{Control, Field, Request as Input, View};
use maka_protocol::plugin::TerminalViewProjection;
use serde_json::Value;
use std::collections::{BTreeMap, VecDeque};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    /// What a control of the view asks for.
    View(Intent),
    /// Submits the action its confirmation sheet asked about.
    Confirm,
    CancelConfirm,
    ApproveConsent,
    DismissConsent,
    Reconcile,
    Retry,
    ResumeDraft,
    ApplyDraft,
    CancelDraft,
    DraftChoice(usize, bool),
    Back,
    Refresh,
    Discard,
    ConfirmDiscard,
    CancelDiscard,
}
impl Command {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Back => "extensions-back",
            Self::Refresh => "extensions-refresh",
            Self::Discard => "extensions-discard",
            Self::ConfirmDiscard => "extensions-forget",
            Self::CancelDiscard
            | Self::CancelDraft
            | Self::DismissConsent
            | Self::CancelConfirm => "session-cancel",
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

pub(crate) enum Notice {
    Local(&'static str),
    Remote(String),
}

#[derive(Default)]
pub struct Instance {
    pub(super) generation: u64,
    /// The binding this instance reads through; none until the directory
    /// names the entry that serves its key.
    pub(super) entry: Option<TerminalViewProjection>,
    /// Where the view starts: null for a page, a slot's context for a filler.
    pub(super) origin: Value,
    pub(super) route: Value,
    /// Routes Back returns to, each with the title it showed.
    pub(super) history: VecDeque<(Value, String)>,
    pub(super) view: Option<View>,
    pub(super) drafts: BTreeMap<String, Value>,
    pub(super) editors: BTreeMap<String, Editor>,
    pub(super) pending: Option<Work>,
    pub(super) unresolved: Option<saved::Pending>,
    pub(super) saving: bool,
    pub(super) unrecorded: bool,
    pub(super) confirm_discard: bool,
    pub(super) review: Option<drafts::Review>,
    pub(super) busy: bool,
    pub(super) writing: bool,
    pub(super) blocked: bool,
    /// A change arrived while the view could not be read again.
    pub(super) stale: bool,
    pub(super) applied: Option<String>,
    pub(super) message: Option<Notice>,
    /// Focus and scroll of the page this instance fills, when it has one.
    pub surface: ui::Surface<Message>,
    /// Where the last frame put each text field of the page.
    pub(super) wells: Vec<tree::Well>,
}

impl Instance {
    pub(super) fn new(entry: Option<TerminalViewProjection>, origin: Value) -> Self {
        let mut instance = Self {
            entry,
            route: origin.clone(),
            origin,
            ..Self::default()
        };
        instance.arrive();
        instance
    }
    fn dirty_field(&self, field: &Field) -> bool {
        self.drafts.get(&field.id) != Some(&drafts::value(&field.control))
    }
    pub(super) fn dirty(&self) -> bool {
        self.view
            .as_ref()
            .is_some_and(|view| view.fields.iter().any(|field| self.dirty_field(field)))
    }
    /// Nothing here may be lost: a draft, a blocked form or an open write.
    pub(super) fn keeps(&self) -> bool {
        self.dirty() || self.blocked || self.unresolved.is_some() || self.writing
    }
    pub(super) fn idle(&self) -> bool {
        !self.busy && self.pending.is_none()
    }
    pub(super) fn read(&mut self, locale: &str) {
        self.stale = false;
        self.pending = self.entry.clone().map(|entry| Work::Call {
            entry: Box::new(entry),
            input: Input::Read {
                route: self.route.clone(),
                locale: locale.into(),
            },
        });
    }
    /// Another place: a fresh surface starts at its top, focus on its content.
    pub(super) fn arrive(&mut self) {
        self.surface = ui::Surface::default();
        self.surface.start_at(super::page::BODY);
        self.wells.clear();
    }
    pub(super) fn install(&mut self, view: View) {
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
    /// Whether the view offers this control at all. Requests in flight are
    /// gated when a command runs, never by disabling what has focus.
    pub(super) fn offered(&self, intent: &Intent) -> bool {
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
    pub(super) fn default_action(&self, field: &str) -> Option<String> {
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
    pub(super) fn navigate(&mut self, route: Value, locale: &str) {
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
        self.read(locale);
    }
    pub(super) fn submit(&mut self, id: &str, locale: &str) {
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
        match view.submission(self.route.clone(), id, fields, locale.into()) {
            Ok(input) => {
                self.pending = self.entry.clone().map(|entry| Work::Call {
                    entry: Box::new(entry),
                    input,
                })
            }
            Err(_) => self.message = Some(Notice::Local("extensions-invalid-fields")),
        }
    }
    /// Recovery and draft commands, shown beside the message that explains them.
    pub(super) fn remedies(&self) -> Vec<Command> {
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
    /// What a title bar names: the view, else the entry that serves it.
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
    /// Revokes every operation on the old registration but keeps drafts.
    pub(super) fn disconnect(&mut self) {
        self.saving = false;
        self.unrecorded = false;
        self.confirm_discard = false;
        self.review = None;
        self.generation += 1;
        self.pending = None;
        self.busy = false;
        self.blocked = self.view.is_some() && self.keeps();
        // A clean view reads again once the directory names a live binding.
        self.stale = self.view.is_some() && !self.blocked;
        self.message = self.blocked.then_some(Notice::Local(
            if self.writing || self.unresolved.is_some() {
                "extensions-unknown"
            } else {
                "extensions-restored"
            },
        ));
        self.writing = false;
    }
    pub fn invalidate_geometry(&mut self) {
        for editor in self.editors.values_mut() {
            editor.invalidate_geometry();
        }
    }
}
