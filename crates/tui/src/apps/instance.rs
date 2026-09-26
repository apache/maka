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

//! One immutable address: the view it last read, the
//! drafts over that view, and the write it may be waiting to settle.

use super::{Intent, Message, Work, drafts, saved, tree};
use crate::{editor::Editor, ui};
use maka_plugins::terminal_ui::view::{Control, Field, Request as Input, View};
use maka_protocol::plugin::TerminalViewProjection;
use serde_json::Value;
use std::collections::BTreeMap;

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
    /// Transient page execution lifetime, independent of per-request fences.
    pub(super) execution: uuid::Uuid,
    /// Changes only when arrive resets reading, independently of document lifetime.
    pub(super) reading_epoch: uuid::Uuid,
    /// The binding this instance reads through; none until the directory
    /// names the entry that serves its key.
    pub(super) entry: Option<TerminalViewProjection>,
    /// The directory still serves this owner. A retired entry remains only
    /// as provenance for preserved drafts and uncertain submissions.
    pub(super) live: Option<maka_plugins::remote::Target>,
    pub(super) address: super::Key,
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
    /// The request in flight is a plain read, which the reader may overtake.
    pub(super) reading: bool,
    pub(super) writing: bool,
    /// Accepted action awaiting readback; retirement never restores backend state.
    pub(super) updated: bool,
    pub(super) blocked: bool,
    /// A change arrived while the view could not be read again.
    pub(super) stale: bool,
    pub(super) applied: Option<String>,
    /// A completed result retained across navigation or pending readback.
    pub(super) result: Option<super::Key>,
    pub(super) message: Option<Notice>,
    /// Focus and scroll of the page this instance fills, when it has one.
    pub surface: ui::Surface<Message>,
    pub collections: ui::Collections,
    /// Where the last frame put each text field of the page.
    pub(super) wells: Vec<tree::Well>,
    pub(super) scopes: Vec<super::reading::Scope>,
}

impl Instance {
    pub(super) fn new(entry: Option<TerminalViewProjection>, address: super::Key) -> Self {
        let mut instance = Self {
            live: entry.as_ref().map(|entry| entry.target.clone()),
            entry,
            address,
            ..Self::default()
        };
        instance.arrive();
        instance
    }
    pub(super) fn settle_updated_fields(&mut self, input: &Input) {
        if let Input::Submit { fields, .. } = input {
            for id in fields.keys() {
                if let Some(field) = self.view.as_ref().and_then(|view| view.field(id)) {
                    self.drafts
                        .insert(id.clone(), drafts::value(&field.control));
                    if let Some(editor) = self.editors.get_mut(id)
                        && let Control::Text { value, .. } = &field.control
                    {
                        let old = editor.text().to_owned();
                        editor.clear_if_unchanged(&old);
                        editor.insert(value);
                        editor.clear_history();
                    }
                }
            }
        }
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
        self.dirty()
            || self.blocked
            || self.unresolved.is_some()
            || self.writing
            || self.result.is_some()
    }
    pub(super) fn idle(&self) -> bool {
        !self.busy && self.pending.is_none()
    }
    /// Only a read is in flight: what the reader does next overtakes it.
    pub(super) fn refreshing(&self) -> bool {
        self.busy && self.reading && self.pending.is_none()
    }
    /// Drops a read in flight so the reader's own action goes first; reads
    /// replay safely, and its late result no longer applies.
    pub(super) fn overtake(&mut self) {
        if self.refreshing() && !self.updated {
            self.generation += 1;
            self.busy = false;
            self.reading = false;
        }
    }
    /// Actual ownership retirement is independent of local edit/read arbitration.
    /// A settled Updated receipt may need a fresh read later, never a replayed write.
    pub(super) fn retire_execution(&mut self) {
        // A cached view must reopen its observation after its document retires.
        self.stale |= !self.execution.is_nil() && (self.view.is_some() || self.reading);
        if self.updated && self.dirty() {
            self.result = None;
        }
        if self.reading {
            self.generation += 1;
            self.busy = false;
            self.reading = false;
        }
        if matches!(
            self.pending,
            Some(
                Work::Call {
                    input: Input::Read { .. },
                    ..
                } | Work::Rebind {
                    input: Input::Read { .. },
                    ..
                }
            )
        ) {
            self.pending = None;
            self.stale = true;
        }
        self.execution = uuid::Uuid::nil();
    }
    pub(super) fn read(&mut self, locale: &str) {
        if self.live.is_none() {
            return;
        }
        self.stale = false;
        self.pending = self.entry.clone().map(|entry| Work::Call {
            entry: Box::new(entry),
            input: Input::Read {
                route: self.address.route.clone(),
                locale: locale.into(),
            },
        });
    }
    pub(super) fn fail_read(&mut self, notice: Notice) {
        if self.updated && self.dirty() {
            self.result = None;
        }
        self.updated = false;
        let retained = self.keeps();
        self.live = None;
        self.blocked = retained;
        self.stale = false;
        self.message = Some(notice);
    }
    /// Another place: a fresh surface starts at its top, focus on its content.
    pub(super) fn arrive(&mut self) {
        self.updated = false;
        // A clean new execution cannot inherit a retired binding's diagnostic.
        // Its initial read may be deferred while this view remains hidden.
        self.message = None;
        self.execution = uuid::Uuid::new_v4();
        self.reading_epoch = self.execution;
        // A route's controls and revision must never serve its destination.
        self.view = None;
        self.drafts.clear();
        self.editors.clear();
        self.surface = ui::Surface::default();
        self.collections = ui::Collections::default();
        self.surface.start_at(super::page::BODY);
        self.wells.clear();
        self.scopes.clear();
    }
    pub(super) fn install(&mut self, view: View) {
        self.updated = false;
        self.collections.retain(&tree::collection_paths(&view));
        self.drafts.clear();
        let mut previous = std::mem::take(&mut self.editors);
        for field in &view.fields {
            if let Control::Text {
                value, max_bytes, ..
            } = &field.control
            {
                // A refreshed revision must not discard local selection/undo
                // when the field's actual value and control are unchanged.
                let unchanged = self
                    .view
                    .as_ref()
                    .and_then(|old| old.field(&field.id))
                    .is_some_and(|old| old.control == field.control);
                let editor = previous
                    .remove(&field.id)
                    .filter(|editor| unchanged && editor.text() == value.as_str())
                    .unwrap_or_else(|| {
                        let mut editor = Editor::bounded(*max_bytes, "extensions-field-limit");
                        editor.insert(value);
                        editor.clear_history();
                        editor
                    });
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
        if self.live.is_none() || self.blocked || self.review.is_some() {
            return false;
        }
        if self.updated && matches!(intent, Intent::Submit(_) | Intent::Commit(_)) {
            return false;
        }
        match intent {
            // Every destination has its own instance; edits stay at this address.
            Intent::Navigate(_) => true,
            Intent::Select(path) => matches!(
                view.node_at(path),
                Some(maka_plugins::terminal_ui::view::Node::Collection { .. })
            ),
            Intent::Move(path) => match view.node_at(path) {
                Some(maka_plugins::terminal_ui::view::Node::Collection {
                    movement: Some(binding),
                    ..
                }) => self.offered(&Intent::Submit(binding.action.clone())),
                _ => false,
            },
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
            // A session opens beside the app; drafts stay where they are.
            Intent::Open(_) => true,
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
        match view.submission(self.address.route.clone(), id, fields, locale.into()) {
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
            if self.unrecorded
                && !self
                    .unresolved
                    .as_ref()
                    .is_some_and(|pending| pending.withheld)
            {
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
        if self.updated && self.dirty() {
            self.result = None;
        }
        self.updated = false;
        self.execution = uuid::Uuid::nil();
        self.live = None;
        self.saving = false;
        self.unrecorded = false;
        self.confirm_discard = false;
        self.review = None;
        self.generation += 1;
        self.pending = None;
        self.busy = false;
        self.reading = false;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::apps::{
        Output,
        tests::{NAME, app, click, command, draw, form, instance, instance_mut, next, save},
    };
    use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
    use maka_plugins::terminal_ui::view::Reply;
    use serde_json::json;

    #[test]
    fn unchanged_refresh_preserves_select_all_then_submits_only_the_pasted_text() {
        for select_during_read in [false, true] {
            let mut app = app();
            let mut view = form();
            let Control::Text {
                value, multiline, ..
            } = &mut view.fields[1].control
            else {
                unreachable!()
            };
            *value = "First line\nSecond line".into();
            *multiline = true;
            instance_mut(&mut app).install(view.clone());
            draw(&mut app, 110, 30);
            click(&mut app, NAME);
            let mut read = None;
            if select_during_read {
                app.apps_action(command(Command::Refresh));
                read = next(&mut app);
            }
            app.input(Event::Key(KeyEvent::new(
                KeyCode::Char('a'),
                KeyModifiers::CONTROL,
            )));
            let selected = instance(&app).editors["name"].cursor();
            assert_eq!(instance(&app).editors["name"].save().anchor, Some(0));
            assert!(!instance(&app).dirty());
            if !select_during_read {
                assert!(
                    next(&mut app).is_none(),
                    "selection does not schedule a read"
                );
                app.apps_action(command(Command::Refresh));
                read = next(&mut app);
            }
            let read = read.unwrap();
            assert_eq!(
                instance(&app).generation,
                read.generation,
                "selection does not overtake a read"
            );
            assert!(
                next(&mut app).is_none(),
                "selection never starts a replacement read"
            );
            view.revision = "refreshed".into();
            app.apps_complete(read, Ok(Output::Reply(Reply::View { view })));
            assert_eq!(instance(&app).editors["name"].cursor(), selected);
            assert!(next(&mut app).is_none());
            draw(&mut app, 110, 30);
            app.input(Event::Paste("Keep this draft".into()));
            assert_eq!(instance(&app).drafts["name"], json!("Keep this draft"));
            app.apps_action(save());
            let submit = next(&mut app).unwrap();
            assert!(
                matches!(submit.work, Work::Call { input: Input::Submit { revision, fields, .. }, .. }
                if revision == "refreshed" && fields["name"] == "Keep this draft")
            );
        }
    }

    #[test]
    fn text_edit_still_overtakes_a_read_and_submits_its_original_revision() {
        let mut app = app();
        draw(&mut app, 110, 30);
        click(&mut app, NAME);
        app.apps_action(command(Command::Refresh));
        let read = next(&mut app).unwrap();
        app.input(Event::Key(KeyEvent::new(
            KeyCode::Char('a'),
            KeyModifiers::CONTROL,
        )));
        app.input(Event::Paste("My draft".into()));
        assert_ne!(instance(&app).generation, read.generation);
        assert!(next(&mut app).is_none());
        let mut changed = form();
        changed.revision = "late revision".into();
        let Control::Text { value, .. } = &mut changed.fields[1].control else {
            unreachable!()
        };
        *value = "Remote change".into();
        app.apps_complete(read, Ok(Output::Reply(Reply::View { view: changed })));
        assert_eq!(instance(&app).drafts["name"], json!("My draft"));
        app.apps_action(save());
        let submit = next(&mut app).unwrap();
        assert!(
            matches!(submit.work, Work::Call { input: Input::Submit { revision, fields, .. }, .. }
            if revision == "one" && fields["name"] == "My draft")
        );
    }

    #[test]
    fn refreshed_changed_values_and_text_constraints_rebuild_the_editor() {
        let mut app = app();
        let mut view = form();
        instance_mut(&mut app)
            .editors
            .get_mut("name")
            .unwrap()
            .key(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::CONTROL));
        let Control::Text { value, .. } = &mut view.fields[1].control else {
            unreachable!()
        };
        *value = "Remote value".into();
        instance_mut(&mut app).install(view.clone());
        assert_eq!(instance(&app).editors["name"].text(), "Remote value");
        assert_eq!(instance(&app).editors["name"].save().anchor, None);
        instance_mut(&mut app)
            .editors
            .get_mut("name")
            .unwrap()
            .key(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::CONTROL));
        let Control::Text { max_bytes, .. } = &mut view.fields[1].control else {
            unreachable!()
        };
        *max_bytes = "Remote value".len();
        instance_mut(&mut app).install(view);
        let editor = instance_mut(&mut app).editors.get_mut("name").unwrap();
        assert_eq!(editor.save().anchor, None);
        editor.insert("!");
        assert_eq!(editor.text(), "Remote value");
        assert_eq!(editor.error, Some("extensions-field-limit"));
    }
}
