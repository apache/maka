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
use crate::{
    app::{Action, App, ConnectionState},
    navigation::Route,
};
use maka_client::{Client, RequestFailure};
use maka_protocol::{
    Operation,
    session::{SessionCatalogProjection, copy},
};
use serde::{Deserialize, Serialize};
pub(crate) use view::sheet;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Basis {
    pub(super) root: String,
    pub(super) epoch: String,
    pub(super) source: String,
    pub(super) revision: u64,
    pub(super) turn: String,
    name: String,
    excerpt: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    Open(Basis),
    Resume,
    Confirm,
    Query,
    Visit,
    Close,
}
impl Command {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Open(_) => "branch-title",
            Self::Resume => "branch-resume",
            Self::Confirm => "branch-create",
            Self::Query => "branch-query",
            Self::Visit => "branch-open",
            Self::Close => "session-cancel",
        }
    }
}

/// Persist the original request, never a stale claim that the target exists.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Checkpoint {
    root: String,
    input: copy::Input,
}
impl Checkpoint {
    pub fn validate(&self, root: &str) -> Result<(), String> {
        let copy::Purpose::Branch {
            turn_id: Some(turn),
            side_conversation: false,
        } = &self.input.purpose
        else {
            return Err("Invalid saved branch purpose".into());
        };
        if self.root != root {
            return Err("Saved branch belongs to another Root".into());
        }
        copy::decode_input(
            Operation::SessionBranchCreate,
            &serde_json::json!({
                "sourceSessionId":self.input.source_session_id,
                "targetSessionId":self.input.target_session_id,
                "expectedSourceRevision":self.input.expected_source_revision,
                "sourceTurnId":turn
            }),
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}
#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum Phase {
    #[default]
    Confirm,
    Saving,
    Pending,
    Unknown,
    Ready,
    Failed,
}
#[derive(Default)]
pub struct State {
    pub visible: bool,
    rendered: bool,
    basis: Option<Basis>,
    saved: Option<Checkpoint>,
    phase: Phase,
    error: Option<&'static str>,
    pending: Option<Request>,
    requested: Option<bool>,
    sequence: u64,
}
impl State {
    pub fn checkpoint(&self) -> Option<Checkpoint> {
        self.saved.clone()
    }
    pub fn restore(&mut self, saved: Checkpoint) {
        self.saved = Some(saved);
        self.phase = Phase::Unknown;
        self.visible = false;
    }
    pub fn invalidate_geometry(&mut self) {
        self.rendered = false;
    }
    /// The sheet reports whether it is on screen; its commands need it.
    pub(crate) fn presented(&mut self, shown: bool) {
        self.rendered = shown;
    }
    pub fn disconnect(&mut self) {
        self.pending = None;
        self.requested = None;
        if self.saved.is_some() {
            self.phase = Phase::Unknown;
            self.error = None;
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    root: String,
    epoch: String,
    input: copy::Input,
    pub query: bool,
    sequence: u64,
}
pub enum Output {
    Ready(Box<SessionCatalogProjection>),
    Conflict,
    Missing,
    Removed,
}
pub async fn execute(client: &Client, request: &Request) -> Result<Output, RequestFailure> {
    if request.query {
        let result = client.query_session_copy(request.input.clone()).await?;
        if result.receipt.is_none() {
            return Ok(Output::Missing);
        }
        return Ok(
            match client.session(&request.input.target_session_id).await? {
                Some(session) => Output::Ready(session),
                None => Output::Removed,
            },
        );
    }
    Ok(match client.copy_session(request.input.clone()).await? {
        copy::Output::Committed { session } => Output::Ready(session),
        copy::Output::SourceRevisionConflict { .. } => Output::Conflict,
    })
}

impl App {
    pub fn branch_commands(&self) -> Vec<(Action, &'static str)> {
        if self.branch.saved.is_some() {
            return vec![(Action::Branch(Command::Resume), "branch-resume")];
        }
        let Some(basis) = self.branch_basis() else {
            return vec![];
        };
        vec![(Action::Branch(Command::Open(basis)), "branch-title")]
    }
    pub(super) fn branch_basis(&self) -> Option<Basis> {
        let ConnectionState::Connected { root_id, epoch } = &self.connection else {
            return None;
        };
        let Route::Session(id) = self.navigation.current() else {
            return None;
        };
        if self.chat.removed || self.chat.session.as_ref() != Some(&id) || self.chrome.details {
            return None;
        }
        // Search previews have their own transcript; use only the canonical page.
        if self.chat.view.search.is_some() {
            return None;
        }
        let (turn, text) = self.chat.presentation.branch_point(&self.chat.view)?;
        let super::sessions::Detail::Ready(item) = &self.sessions.detail else {
            return None;
        };
        if item.id != id {
            return None;
        }
        Some(Basis {
            root: root_id.clone(),
            epoch: epoch.clone(),
            source: id,
            revision: item.revision,
            turn: turn.into(),
            name: item.name.clone(),
            excerpt: text.chars().take(120).collect(),
        })
    }
    pub fn branch_enabled(&self, command: &Command) -> bool {
        let state = &self.branch;
        let connected = |root: &str, epoch: Option<&str>| {
            matches!(&self.connection,
            ConnectionState::Connected {root_id, epoch: actual} if root_id == root && epoch.is_none_or(|e| e == actual))
        };
        match command {
            Command::Open(basis) => {
                state.saved.is_none()
                    && !state.visible
                    && self.branch_basis().as_ref() == Some(basis)
            }
            Command::Resume => state.saved.is_some() && !state.visible,
            Command::Close => state.visible,
            Command::Confirm => {
                state.visible
                    && state.rendered
                    && state.phase == Phase::Confirm
                    && state
                        .basis
                        .as_ref()
                        .is_some_and(|basis| connected(&basis.root, Some(&basis.epoch)))
                    && self.tabs.entries.len() < crate::navigation::tabs::LIMIT
                    && self.drafts.len() < crate::navigation::tabs::LIMIT
            }
            Command::Query => {
                state.visible
                    && state.rendered
                    && state.phase == Phase::Unknown
                    && state.pending.is_none()
                    && state.requested.is_none()
                    && state
                        .saved
                        .as_ref()
                        .is_some_and(|saved| connected(&saved.root, None))
            }
            Command::Visit => {
                state.visible
                    && state.rendered
                    && state.phase == Phase::Ready
                    && state.saved.as_ref().is_some_and(|saved| {
                        connected(&saved.root, None)
                            && (self.tabs.contains(&saved.input.target_session_id)
                                || self.tabs.entries.len() < crate::navigation::tabs::LIMIT)
                            && (self.drafts.contains_key(&saved.input.target_session_id)
                                || self.drafts.len() < crate::navigation::tabs::LIMIT)
                    })
            }
        }
    }
    pub fn branch_action(&mut self, command: Command) -> Option<Action> {
        if !self.branch_enabled(&command) {
            return None;
        }
        let state = &mut self.branch;
        match command {
            Command::Open(basis) => {
                state.basis = Some(basis);
                state.phase = Phase::Confirm;
                state.error = None;
                state.visible = true;
                state.rendered = false;
            }
            Command::Resume => {
                state.visible = true;
                state.rendered = false;
            }
            Command::Close => {
                state.visible = false;
                state.rendered = false;
                if state.saved.is_none() {
                    state.basis = None;
                }
            }
            Command::Confirm => {
                let basis = state.basis.as_ref()?;
                state.saved = Some(Checkpoint {
                    root: basis.root.clone(),
                    input: copy::Input {
                        source_session_id: basis.source.clone(),
                        target_session_id: uuid::Uuid::new_v4().to_string(),
                        expected_source_revision: basis.revision,
                        purpose: copy::Purpose::Branch {
                            turn_id: Some(basis.turn.clone()),
                            side_conversation: false,
                        },
                    },
                });
                state.requested = Some(false);
                state.phase = Phase::Saving;
            }
            Command::Query => {
                state.requested = Some(true);
                state.error = None;
            }
            Command::Visit => {
                let target = state.saved.take()?.input.target_session_id;
                state.visible = false;
                state.basis = None;
                return self.apply(Action::Visit(Route::Session(target)));
            }
        }
        None
    }
    pub fn branch_request(&mut self) -> Option<Request> {
        let ConnectionState::Connected { root_id, epoch } = &self.connection else {
            return None;
        };
        let state = &mut self.branch;
        let saved = state.saved.as_ref()?;
        if saved.root != *root_id || state.pending.is_some() || self.closing {
            return None;
        }
        let query = state.requested.take()?;
        if !query
            && state
                .basis
                .as_ref()
                .is_none_or(|basis| basis.epoch != *epoch)
        {
            state.phase = Phase::Unknown;
            return None;
        }
        state.sequence += 1;
        let request = Request {
            root: root_id.clone(),
            epoch: epoch.clone(),
            input: saved.input.clone(),
            query,
            sequence: state.sequence,
        };
        state.pending = Some(request.clone());
        state.phase = if query { Phase::Pending } else { Phase::Saving };
        Some(request)
    }
    pub fn branch_after_checkpoint(
        &mut self,
        request: &Request,
        result: &Result<(), String>,
    ) -> bool {
        let state = &mut self.branch;
        if request.query || state.phase != Phase::Saving || state.pending.as_ref() != Some(request)
        {
            return false;
        }
        if result.is_ok()
            && !self.closing
            && matches!(&self.connection,
            ConnectionState::Connected {root_id, epoch} if *root_id == request.root && *epoch == request.epoch)
        {
            state.phase = Phase::Pending;
            return true;
        }
        state.pending = None;
        // This particular attempt has not been dispatched. A later restart may
        // still recover an older checkpoint conservatively, but this live UI
        // knows it can let the user make a fresh explicit choice.
        state.phase = Phase::Failed;
        state.saved = None;
        state.error = Some("branch-save-failed");
        false
    }
    pub fn branch_completed(&mut self, request: Request, result: Result<Output, RequestFailure>) {
        let state = &mut self.branch;
        if state.pending.as_ref() != Some(&request) {
            return;
        }
        state.pending = None;
        if !matches!(&self.connection, ConnectionState::Connected {root_id, epoch} if *root_id == request.root && *epoch == request.epoch)
        {
            state.phase = Phase::Unknown;
            return;
        }
        match result {
            Ok(Output::Ready(session)) => {
                state.phase = Phase::Ready;
                state.error = None;
                self.sessions.updated(session);
                self.inbox.refresh();
            }
            Ok(Output::Conflict | Output::Removed) => {
                state.phase = Phase::Failed;
                state.saved = None;
                state.error = Some("branch-unavailable");
            }
            Ok(Output::Missing) => {
                state.phase = Phase::Unknown;
                state.error = Some("branch-unknown");
            }
            Err(error) => {
                let uncertain = request.query
                    || matches!(&error, RequestFailure::Unknown(_))
                    || matches!(&error, RequestFailure::Rejected(maka_client::ClientError::Rejected(e))
                        if e.code == maka_protocol::OperationErrorCode::CommitOutcomeUnknown);
                state.phase = if uncertain {
                    Phase::Unknown
                } else {
                    Phase::Failed
                };
                if !uncertain {
                    state.saved = None;
                }
                state.error = Some(if uncertain {
                    "branch-unknown"
                } else {
                    "branch-unavailable"
                });
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::{Locale, LocalePreference, i18n::I18n};
    use crossterm::event::{
        Event, KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
    };
    use ratatui::{Terminal, backend::TestBackend};
    use serde_json::json;

    fn frame(app: &mut App, width: u16, height: u16) {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal.draw(|f| crate::view::draw(f, app)).unwrap();
    }
    pub(crate) fn fixture() -> (App, Basis) {
        let mut app = App::new(
            "/unused".into(),
            I18n::new(LocalePreference::Auto, Locale::En),
        );
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "epoch".into(),
        };
        app.apply(Action::Visit(Route::Session("source".into())));
        app.chat.select(&app.navigation.current());
        app.sessions.detail = super::super::sessions::Detail::Ready(Box::new(
            super::super::sessions::tests::item("source"),
        ));
        let rows = std::collections::BTreeMap::from([(
            1,
            json!({"type":"user","id":"original","turnId":"turn","text":"Selected prompt 中文"}),
        )]);
        app.chat
            .presentation
            .sync(&mut app.chat.view, &rows, &[], 0, &app.i18n, false);
        let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
        terminal
            .draw(|f| {
                app.chat.view.draw(f, f.area(), false).unwrap();
            })
            .unwrap();
        assert!(
            app.branch_commands().is_empty(),
            "implicit first-visible is not a selected boundary"
        );
        app.chat.view.enter();
        let basis = app.branch_basis().unwrap();
        (app, basis)
    }
    #[test]
    fn branch_confirmation_checkpoint_and_recovery_preserve_the_exact_target_and_draft() {
        let (mut app, basis) = fixture();
        app.drafts
            .get_mut("source")
            .unwrap()
            .insert("unsubmitted draft");
        app.apply(Action::Branch(Command::Open(basis.clone())));
        app.apply(Action::Branch(Command::Confirm));
        assert!(
            app.branch_request().is_none(),
            "must render before confirming"
        );
        frame(&mut app, 80, 24);
        app.input(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::NONE,
        )));
        assert!(!app.branch.visible, "cancel is default");
        app.apply(Action::Branch(Command::Open(basis.clone())));
        frame(&mut app, 80, 24);
        app.input(Event::Mouse(MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 0,
            row: 0,
            modifiers: KeyModifiers::NONE,
        }));
        assert!(!app.branch.visible, "outside click only dismisses");
        app.apply(Action::Branch(Command::Open(basis.clone())));
        frame(&mut app, 32, 10);
        assert!(!app.branch_enabled(&Command::Confirm));
        frame(&mut app, 80, 24);
        app.apply(Action::Branch(Command::Confirm));
        let request = app.branch_request().unwrap();
        assert!(!request.query);
        frame(&mut app, 80, 24);
        app.input(Event::Key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE)));
        assert_eq!(
            app.layer.focused_path(),
            Some("footer/close"),
            "pending dialog has only one focusable action"
        );
        let saved = serde_json::to_value(app.branch.checkpoint()).unwrap();
        let mut stale = request.clone();
        stale.sequence += 1;
        assert!(!app.branch_after_checkpoint(&stale, &Ok(())));
        assert!(app.branch_after_checkpoint(&request, &Ok(())));
        assert!(
            !app.branch_after_checkpoint(&request, &Ok(())),
            "never dispatch twice"
        );
        app.apply(Action::Branch(Command::Close));
        app.apply(Action::Visit(Route::Settings));
        app.branch_completed(
            request.clone(),
            Err(RequestFailure::Unknown(maka_client::ClientError::Protocol(
                "lost reply".into(),
            ))),
        );
        assert_eq!(app.navigation.current(), Route::Settings);
        assert_eq!(
            serde_json::to_value(app.branch.checkpoint()).unwrap(),
            saved
        );
        let mut recovered = State::default();
        recovered.restore(serde_json::from_value(saved.clone()).unwrap());
        app.branch = recovered;
        app.connection = ConnectionState::Connecting;
        assert!(
            app.branch_request().is_none(),
            "reopen neither writes nor polls"
        );
        app.apply(Action::Branch(Command::Resume));
        frame(&mut app, 80, 24);
        app.apply(Action::Branch(Command::Query));
        assert!(
            app.branch_request().is_none(),
            "restored drafts do not establish a connection"
        );
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "new-epoch".into(),
        };
        frame(&mut app, 80, 24);
        let button = app.layer.rect("footer/primary").unwrap();
        let mut source = super::super::sessions::tests::item("source");
        source.name = "A source name arriving after the dialog was opened".repeat(4);
        app.sessions.items.push(source);
        frame(&mut app, 80, 24);
        assert_eq!(
            app.layer.rect("footer/primary").unwrap(),
            button,
            "catalog arrivals cannot move the recovery action under the mouse"
        );
        app.apply(Action::Branch(Command::Query));
        let query = app.branch_request().unwrap();
        assert!(query.query);
        assert_eq!(query.input, request.input);
        assert_eq!(query.epoch, "new-epoch");
        app.branch_completed(query.clone(), Ok(Output::Missing));
        assert!(!app.branch_enabled(&Command::Confirm));
        assert_eq!(
            serde_json::to_value(app.branch.checkpoint()).unwrap(),
            saved
        );
        frame(&mut app, 80, 24);
        app.apply(Action::Branch(Command::Query));
        let retry = app.branch_request().unwrap();
        app.branch_completed(query, Ok(Output::Removed));
        assert!(
            app.branch.pending.is_some(),
            "obsolete read cannot remove the next request"
        );
        app.branch_completed(
            retry,
            Ok(Output::Ready(Box::new(
                super::super::sessions::tests::item(&request.input.target_session_id),
            ))),
        );
        assert_eq!(
            app.navigation.current(),
            Route::Settings,
            "late success does not steal the route"
        );
        frame(&mut app, 80, 24);
        app.apply(Action::Branch(Command::Visit));
        assert_eq!(
            app.navigation.current(),
            Route::Session(request.input.target_session_id)
        );
        assert_eq!(app.drafts["source"].text(), "unsubmitted draft");
        assert!(app.branch.saved.is_none());

        let (mut app, basis) = fixture();
        app.apply(Action::Branch(Command::Open(basis)));
        frame(&mut app, 80, 24);
        app.apply(Action::Branch(Command::Confirm));
        let request = app.branch_request().unwrap();
        assert!(!app.branch_after_checkpoint(&request, &Err("disk unavailable".into())));
        assert!(
            app.branch.saved.is_none(),
            "known non-dispatch permits a fresh explicit selection"
        );
        assert!(app.branch_request().is_none());
        let valid: Checkpoint = serde_json::from_value(saved.clone()).unwrap();
        valid.validate("root").unwrap();
        assert!(valid.validate("other-root").is_err());
        for (pointer, value) in [
            ("/input/targetSessionId", json!("source")),
            ("/input/expectedSourceRevision", json!(0)),
            ("/input/purpose/turnId", json!(null)),
            ("/input/purpose/sideConversation", json!(true)),
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
    }
}
