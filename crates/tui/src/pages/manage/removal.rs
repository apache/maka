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

mod view;
use super::{Command, Entity, Kind, Target, Ticket, Updated};
use crate::app::{Action, App, ConnectionState};
use maka_client::{Client, RequestFailure};
use maka_protocol::{OperationErrorCode, session::*};
pub(super) use view::sheet;

pub(super) struct State {
    generation: u64,
    requested: bool,
    pub count: Option<u64>,
    pub uncertain: bool,
    pub error: Option<&'static str>,
}
impl State {
    pub fn new(generation: u64) -> Self {
        Self {
            generation,
            requested: true,
            count: None,
            uncertain: false,
            error: None,
        }
    }
    pub fn can_save(&self) -> bool {
        self.count.is_some() && !self.uncertain && self.error.is_none() && !self.requested
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    target: Target,
    generation: u64,
    receipt_only: bool,
}
pub enum Output {
    Preview(SessionRemovePreviewResult),
    Receipt(SessionRemoveQueryResult),
}
pub async fn read(client: &Client, request: &Request) -> Result<Output, RequestFailure> {
    let Entity::Session { id, .. } = &request.target.entity else {
        unreachable!()
    };
    let receipt = client
        .query_session_removal(SessionRemoveQueryInput {
            session_id: id.clone(),
        })
        .await?;
    if request.receipt_only || matches!(receipt, SessionRemoveQueryResult::Removed { .. }) {
        return Ok(Output::Receipt(receipt));
    }
    client
        .preview_session_removal(SessionRemovePreviewInput {
            session_id: id.clone(),
        })
        .await
        .map(Output::Preview)
}

impl App {
    pub(super) fn removal_query_enabled(&self) -> bool {
        let Some(dialog) = &self.management.dialog else {
            return false;
        };
        let Some(state) = &dialog.removal else {
            return false;
        };
        dialog.visible
            && !state.requested
            && state.error.is_some()
            && state.error != Some("session-edit-conflict")
            && self.management.pending.is_none()
            && self.management.removal_pending.is_none()
            && matches!(&self.connection, ConnectionState::Connected { root_id, .. } if *root_id == dialog.target.root)
    }
    pub(super) fn request_removal_query(&mut self) {
        if let Some(state) = self
            .management
            .dialog
            .as_mut()
            .and_then(|d| d.removal.as_mut())
        {
            state.requested = true;
            state.error = None;
        }
    }
    pub fn removal_request(&mut self) -> Option<Request> {
        if self.management.pending.is_some() || self.management.removal_pending.is_some() {
            return None;
        }
        let ConnectionState::Connected { root_id, epoch } = &self.connection else {
            return None;
        };
        let dialog = self.management.dialog.as_mut()?;
        if dialog.target.root != *root_id {
            return None;
        }
        let state = dialog.removal.as_mut()?;
        if !std::mem::take(&mut state.requested) {
            return None;
        }
        let mut target = dialog.target.clone();
        // A receipt read may cross Host restarts in the same Root. It never
        // rebinds the original mutation's revision or grants permission to replay.
        let receipt_only = state.uncertain || target.epoch != *epoch;
        target.epoch = epoch.clone();
        let request = Request {
            target,
            generation: state.generation,
            receipt_only,
        };
        self.management.removal_pending = Some(request.clone());
        Some(request)
    }
    pub fn removal_read(&mut self, request: Request, result: Result<Output, RequestFailure>) {
        if self.management.removal_pending.as_ref() != Some(&request) {
            return;
        }
        self.management.removal_pending = None;
        if !self.management_identity(&request.target) {
            return;
        }
        let Some(dialog) = self.management.dialog.as_mut().filter(|d| {
            d.target.root == request.target.root
                && d.target.entity == request.target.entity
                && d.removal
                    .as_ref()
                    .is_some_and(|s| s.generation == request.generation)
        }) else {
            return;
        };
        let state = dialog.removal.as_mut().unwrap();
        match result {
            Ok(Output::Preview(preview)) => state.count = Some(preview.archivable_subtask_count),
            Ok(Output::Receipt(SessionRemoveQueryResult::Removed { session_id, .. })) => {
                self.management.dialog = None;
                self.session_removed(&session_id, false);
            }
            Ok(Output::Receipt(SessionRemoveQueryResult::Missing)) => {
                state.error = Some(if state.uncertain {
                    "session-remove-unknown"
                } else {
                    "session-edit-conflict"
                });
            }
            Err(error) => state.error = Some(failure(&error, true)),
        }
    }
    pub(super) fn removal_written(
        &mut self,
        ticket: Ticket,
        result: Result<Updated, RequestFailure>,
    ) {
        if let Ok(Updated::Removal(SessionRemoveResult::Removed { session_id, .. })) = &result {
            if self
                .management
                .dialog
                .as_ref()
                .is_some_and(|d| d.target == ticket.target && d.kind == Kind::Remove)
            {
                self.management.dialog = None;
            }
            self.session_removed(session_id, true);
            return;
        }
        let Some(dialog) = self
            .management
            .dialog
            .as_mut()
            .filter(|d| d.target == ticket.target && d.kind == Kind::Remove)
        else {
            return;
        };
        let state = dialog.removal.as_mut().unwrap();
        state.count = None;
        match result {
            Ok(Updated::Removal(SessionRemoveResult::RevisionConflict { .. })) => {
                dialog.blocked = true;
                state.error = Some("session-edit-conflict");
            }
            Err(error) => {
                state.uncertain = matches!(&error, RequestFailure::Unknown(_))
                    || matches!(&error, RequestFailure::Rejected(maka_client::ClientError::Rejected(e)) if e.code == OperationErrorCode::CommitOutcomeUnknown);
                state.error = Some(if state.uncertain {
                    "session-remove-unknown"
                } else {
                    failure(&error, false)
                });
            }
            Ok(_) => unreachable!("removal result"),
        }
    }
    pub(super) fn abandon_removal(&mut self) {
        self.management.removal_pending = None;
        if let Some(state) = self
            .management
            .dialog
            .as_mut()
            .and_then(|d| d.removal.as_mut())
        {
            state.uncertain |= self
                .management
                .pending
                .as_ref()
                .is_some_and(|t| t.kind == Kind::Remove);
            state.count = None;
            state.requested = false;
            state.error = Some(if state.uncertain {
                "session-remove-unknown"
            } else {
                "session-edit-disconnected"
            });
        }
    }
    pub fn session_removed(&mut self, id: &str, local: bool) {
        if self.management.dialog.as_ref().is_some_and(|dialog| {
            dialog.kind == Kind::Remove
                && matches!(&dialog.target.entity, Entity::Session { id: target, .. } if target == id)
        }) {
            // An authoritative retirement also invalidates an open confirmation
            // and any preview still in flight, not just the visible transcript.
            self.management.dialog = None;
        }
        self.sessions.retire(id);
        self.inbox.retire(id);
        if self.chat.session.as_deref() == Some(id) {
            self.chat.retire();
        }
        // A remote retirement must not take away what the user is typing.
        // Keep local text and uncertain submissions recoverable in the old tab.
        self.attachments.retire(id);
        let draft =
            self.attachments.has(id) || self.drafts.get(id).is_some_and(|d| !d.text().is_empty());
        let sending = self
            .sending
            .get(id)
            .is_some_and(|s| s.delivery.blocks_send());
        if local && !draft && !sending {
            self.apply(Action::CloseTab(id.into()));
        }
        self.hits.clear();
        self.hover = None;
    }
}

fn failure(error: &RequestFailure, reading: bool) -> &'static str {
    if let RequestFailure::Rejected(maka_client::ClientError::Rejected(error)) = error {
        match error.code {
            OperationErrorCode::OperationConflict => return "session-remove-unavailable",
            OperationErrorCode::SessionBusy => return "session-edit-busy",
            OperationErrorCode::NotFound => return "session-missing",
            _ => {}
        }
    }
    if reading {
        "session-remove-read-failed"
    } else {
        "session-remove-failed"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Locale, LocalePreference, i18n::I18n, navigation::Route};
    use crossterm::event::{
        Event, KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
    };
    use ratatui::{Terminal, backend::TestBackend};

    fn fixture() -> (App, Target) {
        let mut app = App::new(
            "/tmp/root".into(),
            I18n::new(LocalePreference::Explicit(Locale::En), Locale::En),
        );
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "epoch".into(),
        };
        app.apply(Action::Visit(Route::Session("A".into())));
        app.chat.select(&app.navigation.current());
        let target = Target {
            root: "root".into(),
            epoch: "epoch".into(),
            name: "要删除的会话 · remove me".into(),
            entity: Entity::Session {
                id: "A".into(),
                revision: 7,
                workspace: "/work".into(),
                project_bound: false,
            },
        };
        (app, target)
    }
    fn key(code: KeyCode) -> Event {
        Event::Key(KeyEvent::new(code, KeyModifiers::NONE))
    }
    fn preview(app: &mut App) {
        let request = app.removal_request().unwrap();
        assert!(!request.receipt_only);
        app.removal_read(
            request,
            Ok(Output::Preview(SessionRemovePreviewResult {
                archivable_subtask_count: 3,
            })),
        );
    }

    #[test]
    fn removal_requires_visible_preview_and_explicit_confirmation_in_every_locale() {
        for locale in Locale::ALL {
            let (mut app, target) = fixture();
            app.i18n = I18n::new(LocalePreference::Explicit(locale), Locale::En);
            app.apply(Action::Manage(Command::Open(target.clone(), Kind::Remove)));
            assert!(app.management_request().is_none());
            let mut screen = Terminal::new(TestBackend::new(80, 24)).unwrap();
            screen.draw(|f| crate::view::draw(f, &mut app)).unwrap();
            assert!(
                app.management_request().is_none(),
                "no write before impact read"
            );
            preview(&mut app);
            for (width, height) in [(80, 24), (44, 24), (28, 8)] {
                app.input(Event::Resize(width, height));
                assert!(app.management_request().is_none(), "old geometry is inert");
                let mut screen = Terminal::new(TestBackend::new(width, height)).unwrap();
                screen.draw(|f| crate::view::draw(f, &mut app)).unwrap();
                assert_eq!(app.management_enabled(&Command::Save), width >= 44);
                if width >= 44 {
                    let buffer = screen.backend().buffer();
                    let rows: Vec<String> = (0..height)
                        .map(|y| (0..width).map(|x| buffer[(x, y)].symbol()).collect())
                        .collect();
                    let top = rows.iter().position(|row| row.contains('╭')).unwrap();
                    let bottom = top
                        + rows[top..]
                            .iter()
                            .position(|row| row.contains('╰'))
                            .unwrap();
                    assert!(
                        bottom - top + 1 < usize::from(height) - 2,
                        "compact confirmation with breathing room"
                    );
                    let compact = |s: &str| s.split_whitespace().collect::<String>();
                    let confirm = compact(&app.i18n.text("session-remove-confirm"));
                    assert!(
                        rows[top..=bottom]
                            .iter()
                            .any(|row| compact(row).contains(&confirm)),
                        "the confirmation is inside the sheet"
                    );
                }
            }
            screen.draw(|f| crate::view::draw(f, &mut app)).unwrap();
            app.input(key(KeyCode::Enter));
            assert!(app.management.dialog.is_none(), "Enter initially cancels");
            assert!(app.management.pending.is_none());
            app.apply(Action::Manage(Command::Open(target.clone(), Kind::Remove)));
            preview(&mut app);
            screen.draw(|f| crate::view::draw(f, &mut app)).unwrap();
            app.input(Event::Mouse(MouseEvent {
                kind: MouseEventKind::Down(MouseButton::Left),
                column: 0,
                row: 0,
                modifiers: KeyModifiers::NONE,
            }));
            assert!(
                app.management.dialog.is_none(),
                "outside click cancels, never confirms"
            );
            app.apply(Action::Manage(Command::Open(target, Kind::Remove)));
            preview(&mut app);
            screen.draw(|f| crate::view::draw(f, &mut app)).unwrap();
            app.input(key(KeyCode::Tab));
            assert_eq!(
                app.input(key(KeyCode::Enter)).1,
                Some(Action::Manage(Command::Save))
            );
            let ticket = app.management_request().unwrap();
            assert!(matches!(
                ticket.target.entity,
                Entity::Session { revision: 7, .. }
            ));
            assert!(app.management_request().is_none(), "one mutation in flight");
        }
    }

    #[test]
    fn removal_reconciles_unknown_without_rearming_write_and_preserves_foreign_pages_and_drafts() {
        let (mut app, target) = fixture();
        let mut screen = Terminal::new(TestBackend::new(80, 24)).unwrap();
        app.drafts.get_mut("A").unwrap().insert("keep this draft");
        app.apply(Action::Manage(Command::Open(target.clone(), Kind::Remove)));
        let stale = app.removal_request().unwrap();
        app.apply(Action::Manage(Command::Close));
        app.apply(Action::Manage(Command::Open(target.clone(), Kind::Remove)));
        app.removal_read(
            stale,
            Ok(Output::Preview(SessionRemovePreviewResult {
                archivable_subtask_count: 0,
            })),
        );
        assert!(
            !app.management
                .dialog
                .as_ref()
                .unwrap()
                .removal
                .as_ref()
                .unwrap()
                .can_save()
        );
        preview(&mut app);
        screen.draw(|f| crate::view::draw(f, &mut app)).unwrap();
        let ticket = app.management_request().unwrap();
        app.management_completed(
            ticket,
            Err(RequestFailure::Unknown(maka_client::ClientError::Timeout)),
        );
        assert!(app.management_request().is_none());
        app.apply(Action::Manage(Command::RemovalQuery));
        let read = app.removal_request().unwrap();
        assert!(read.receipt_only);
        app.removal_read(read, Ok(Output::Receipt(SessionRemoveQueryResult::Missing)));
        assert!(
            app.management_request().is_none(),
            "missing is not non-admission"
        );
        assert!(app.removal_request().is_none(), "no polling loop");
        app.connection = ConnectionState::Disconnected;
        app.abandon_management();
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "restarted".into(),
        };
        screen.draw(|f| crate::view::draw(f, &mut app)).unwrap();
        app.apply(Action::Manage(Command::RemovalQuery));
        let read = app.removal_request().unwrap();
        assert_eq!(read.target.epoch, "restarted");
        app.removal_read(
            read,
            Ok(Output::Receipt(SessionRemoveQueryResult::Removed {
                session_id: "A".into(),
                archived_subtask_count: 3,
            })),
        );
        assert!(app.management.dialog.is_none());
        assert!(app.chat.removed);
        assert_eq!(app.navigation.current(), Route::Session("A".into()));
        assert_eq!(app.drafts["A"].text(), "keep this draft");
        assert!(!app.enabled(&Action::SendMessage));

        // A confirmed late write for another tab must not steal the current route.
        let (mut app, target) = fixture();
        app.apply(Action::Manage(Command::Open(target, Kind::Remove)));
        preview(&mut app);
        screen.draw(|f| crate::view::draw(f, &mut app)).unwrap();
        let ticket = app.management_request().unwrap();
        app.apply(Action::Manage(Command::Close));
        app.apply(Action::Visit(Route::Session("B".into())));
        app.drafts.get_mut("B").unwrap().insert("other draft");
        app.management_completed(
            ticket,
            Ok(Updated::Removal(SessionRemoveResult::Removed {
                session_id: "A".into(),
                archived_subtask_count: Some(0),
            })),
        );
        assert_eq!(app.navigation.current(), Route::Session("B".into()));
        assert!(!app.tabs.contains("A"));
        assert_eq!(app.drafts["B"].text(), "other draft");

        let (mut app, target) = fixture();
        app.apply(Action::Manage(Command::Open(target, Kind::Remove)));
        let obsolete_preview = app.removal_request().unwrap();
        app.session_removed("A", false);
        app.removal_read(
            obsolete_preview,
            Ok(Output::Preview(SessionRemovePreviewResult {
                archivable_subtask_count: 0,
            })),
        );
        assert!(
            app.management.dialog.is_none(),
            "remote removal invalidates the confirmation"
        );
        assert!(app.management_request().is_none());
        assert!(
            app.removal_request().is_none(),
            "late preview cannot resurrect confirmation"
        );
    }
}
