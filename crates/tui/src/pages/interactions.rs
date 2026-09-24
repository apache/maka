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

//! Explicit review of a pinned Host interaction; no automatic answers or retries.
mod form;
mod question;
mod summary;
mod view;
use crate::app::{App, ConnectionState};
use maka_client::RequestFailure;
use maka_protocol::interaction::{
    self, InteractionAnswer, InteractionRequest, InteractionSnapshot,
};
use serde_json::json;
pub(crate) use view::{draw_field, sheet};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command {
    Close,
    Details,
    Check,
    Deny,
    Once,
    Turn,
    Session,
    Submit,
    Question(usize),
    Option(usize),
    FreeText,
    Skip,
    Field(usize),
    Empty,
    Omit,
    FormSubmit,
    FormDecline,
    FormCancel,
}
impl Command {
    pub fn label(self) -> &'static str {
        match self {
            Self::Close => "interaction-close",
            Self::Details => "interaction-show-details",
            Self::Check => "interaction-check",
            Self::Deny => "interaction-deny",
            Self::Once => "interaction-once",
            Self::Turn => "interaction-turn",
            Self::Session => "interaction-session",
            Self::Submit => "question-submit",
            Self::Question(_) => "question-switch",
            Self::Option(_) => "question-option",
            Self::FreeText => "question-custom",
            Self::Skip => "question-skip",
            Self::Field(_) => "form-switch",
            Self::Empty => "form-empty",
            Self::Omit => "form-omit",
            Self::FormSubmit => "form-submit",
            Self::FormDecline => "form-decline",
            Self::FormCancel => "form-cancel",
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Ticket {
    pub root: String,
    pub epoch: String,
    pub snapshot: InteractionSnapshot,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Ready,
    Sending,
    Unknown,
    Checking,
    Stale,
    Resolved,
}
pub struct Review {
    ticket: Ticket,
    state: State,
    outcome: Option<InteractionSnapshot>,
    error: Option<String>,
    details: bool,
    questions: Option<question::Questions>,
    form: Option<form::Form>,
}
impl Review {
    fn locked(&self) -> bool {
        matches!(
            self.state,
            State::Sending | State::Unknown | State::Checking
        )
    }
    fn commands(&self) -> Vec<Command> {
        let mut commands = vec![Command::Close];
        match self.state {
            State::Ready => match self.ticket.snapshot.request() {
                InteractionRequest::Permissions { tool_use_id, .. } => {
                    commands.push(Command::Deny);
                    if tool_use_id.is_some() {
                        commands.push(Command::Once);
                    }
                    commands.extend([Command::Turn, Command::Session]);
                }
                InteractionRequest::ClientCapability { .. } => {
                    commands.extend([Command::Deny, Command::Session])
                }
                InteractionRequest::Question { .. } => commands.push(Command::Submit),
                InteractionRequest::Form { .. } => commands.extend([
                    Command::FormSubmit,
                    Command::FormDecline,
                    Command::FormCancel,
                ]),
            },
            State::Unknown | State::Stale => commands.push(Command::Check),
            _ => {}
        }
        if self.state != State::Ready || self.questions.is_none() && self.form.is_none() {
            commands.push(Command::Details);
        }
        commands
    }
    fn set(&mut self, state: State) {
        self.state = state;
        self.details = false;
        if let Some(questions) = &mut self.questions {
            questions.invalidate_geometry();
        }
        if let Some(form) = &mut self.form {
            form.invalidate_geometry();
        }
    }
}
#[derive(Default)]
pub struct Interactions {
    review: Option<Review>,
    pub visible: bool,
    /// The sheet is on screen; its owner's shortcuts need it.
    rendered: bool,
}
impl Interactions {
    pub(crate) fn presented(&mut self, shown: bool) {
        self.rendered = shown;
    }
    pub fn invalidate_geometry(&mut self) {
        if let Some(form) = self.review.as_mut().and_then(|review| review.form.as_mut()) {
            form.invalidate_geometry();
        }
        if let Some(questions) = self
            .review
            .as_mut()
            .and_then(|review| review.questions.as_mut())
        {
            questions.invalidate_geometry();
        }
    }
}
impl App {
    pub fn has_interaction(&self) -> bool {
        self.interactions
            .review
            .as_ref()
            .is_some_and(|review| review.locked() || review.state == State::Stale)
            || self.pending_interaction().is_some()
    }
    fn pending_interaction(&self) -> Option<&InteractionSnapshot> {
        let crate::navigation::Route::Session(id) = self.navigation.current() else {
            return None;
        };
        if self.chat.session.as_ref() != Some(&id) || self.chat.error.is_some() {
            return None;
        }
        self.chat
            .snapshot
            .as_ref()?
            .interactions
            .pending()
            .iter()
            .find(|snapshot| {
                !self.interactions.review.as_ref().is_some_and(|review| {
                    review.state == State::Resolved && review.ticket.snapshot == **snapshot
                })
            })
    }
    pub fn open_interaction(&mut self) {
        let keep = self.interactions.review.as_ref().is_some_and(|review| {
            review.locked()
                || review.state == State::Stale
                    && self.pending_interaction() != Some(&review.ticket.snapshot)
        });
        if !keep {
            let Some(snapshot) = self.pending_interaction().cloned() else {
                return;
            };
            let ConnectionState::Connected { root_id, epoch } = &self.connection else {
                return;
            };
            let ticket = Ticket {
                root: root_id.clone(),
                epoch: epoch.clone(),
                snapshot,
            };
            let preserve = self.interactions.review.as_ref().is_some_and(|review| {
                review.ticket == ticket && matches!(review.state, State::Ready | State::Stale)
            });
            if preserve {
                let review = self.interactions.review.as_mut().unwrap();
                // Returning to the same authoritative pending request can restore
                // locally edited answers after its observation was released.
                if review.state == State::Stale {
                    review.set(State::Ready);
                }
            } else {
                let questions = if let InteractionRequest::Question { questions, .. } =
                    ticket.snapshot.request()
                {
                    Some(question::Questions::new(questions.clone()))
                } else {
                    None
                };
                let form = if let InteractionRequest::Form {
                    message,
                    requester,
                    fields,
                    ..
                } = ticket.snapshot.request()
                {
                    Some(form::Form::new(
                        message.clone(),
                        requester.clone(),
                        fields.clone(),
                    ))
                } else {
                    None
                };
                self.interactions.review = Some(Review {
                    ticket,
                    state: State::Ready,
                    outcome: None,
                    error: None,
                    details: false,
                    questions,
                    form,
                });
            }
        }
        self.interactions.visible = true;
        self.palette = None;
        self.hover = None;
        self.hits.clear();
        self.invalidate_editor_geometry();
    }
    /// Called before each rendered frame/input cycle. A different run can never replace an open review.
    pub fn sync_interaction(&mut self) {
        let Some(review) = &mut self.interactions.review else {
            return;
        };
        let live = matches!(&self.connection, ConnectionState::Connected {root_id, epoch}
            if *root_id == review.ticket.root && *epoch == review.ticket.epoch)
            && self.chat.error.is_none()
            && self.chat.snapshot.as_ref().is_some_and(|snapshot| {
                snapshot
                    .interactions
                    .pending()
                    .contains(&review.ticket.snapshot)
            });
        if review.state == State::Ready && !live {
            review.set(State::Stale);
        }
    }
    pub fn abandon_interaction(&mut self) {
        if let Some(review) = &mut self.interactions.review {
            match review.state {
                State::Sending | State::Checking => review.set(State::Unknown),
                State::Ready => review.set(State::Stale),
                _ => {}
            }
        }
    }
    pub fn interaction_enabled(&self, command: Command) -> bool {
        if !self.interactions.visible {
            return false;
        }
        let Some(review) = &self.interactions.review else {
            return false;
        };
        (review.commands().contains(&command)
            || review.state == State::Ready
                && review
                    .questions
                    .as_ref()
                    .is_some_and(|questions| questions.accepts(command))
            || review.state == State::Ready
                && review
                    .form
                    .as_ref()
                    .is_some_and(|form| form.accepts(command)))
            && (command != Command::FormSubmit
                || review
                    .form
                    .as_ref()
                    .is_some_and(|form| form.result().is_some()))
            && (command != Command::Submit
                || review
                    .questions
                    .as_ref()
                    .is_some_and(|questions| questions.answers().is_some()))
            && (matches!(command, Command::Close | Command::Details)
                || matches!(&self.connection, ConnectionState::Connected {root_id,..} if *root_id == review.ticket.root))
    }
    pub fn interaction_request(
        &mut self,
        command: Command,
    ) -> Option<(Ticket, Option<InteractionAnswer>)> {
        self.sync_interaction();
        if !self.interaction_enabled(command) {
            return None;
        }
        let review = self.interactions.review.as_mut()?;
        if command == Command::Close {
            self.interactions.visible = false;
            return None;
        }
        if command == Command::Details {
            review.details = !review.details;
            return None;
        }
        if command == Command::Check {
            review.set(State::Checking);
            review.error = None;
            return Some((review.ticket.clone(), None));
        }
        if let Some(questions) = &mut review.questions
            && command != Command::Submit
        {
            questions.apply(command);
            return None;
        }
        if let Some(form) = &mut review.form
            && !matches!(
                command,
                Command::FormSubmit | Command::FormDecline | Command::FormCancel
            )
        {
            form.apply(command);
            return None;
        }
        let answer = match review.ticket.snapshot.request() {
            InteractionRequest::Permissions { request, .. } => {
                let decision = if command == Command::Deny {
                    json!({"decision":"deny"})
                } else {
                    json!({"decision":"allow", "permissions":request.permissions,
                    "scope":match command {Command::Once=>"once", Command::Turn=>"turn", _=>"session"}})
                };
                interaction::decode_answer(&json!({"kind":"permissions", "decision":decision}))
                    .ok()?
            }
            InteractionRequest::ClientCapability { .. } => InteractionAnswer::ClientCapability {
                decision: if command == Command::Deny {
                    interaction::Decision::Deny
                } else {
                    interaction::Decision::Allow
                },
            },
            InteractionRequest::Question { .. } => InteractionAnswer::Question {
                answers: review.questions.as_ref()?.answers()?,
            },
            InteractionRequest::Form { .. } => InteractionAnswer::Form {
                result: match command {
                    Command::FormSubmit => review.form.as_ref()?.result()?,
                    Command::FormDecline => maka_protocol::capability::form::FormResult::Decline,
                    Command::FormCancel => maka_protocol::capability::form::FormResult::Cancel,
                    _ => return None,
                },
            },
        };
        review.set(State::Sending);
        review.error = None;
        Some((review.ticket.clone(), Some(answer)))
    }
    pub fn interaction_completed(
        &mut self,
        ticket: Ticket,
        result: Result<InteractionSnapshot, RequestFailure>,
    ) {
        let Some(review) = &mut self.interactions.review else {
            return;
        };
        if review.ticket != ticket || !matches!(review.state, State::Sending | State::Checking) {
            return;
        }
        match result {
            Ok(snapshot) if snapshot.is_pending() => {
                review.set(State::Ready);
                review.error = None;
            }
            Ok(snapshot) => {
                review.outcome = Some(snapshot);
                review.set(State::Resolved);
                review.error = None;
            }
            Err(error) => {
                // Even a rejection may describe another client's already-committed decision.
                // Read the original record before making any further choice.
                review.error = Some(error.to_string());
                review.set(State::Unknown);
            }
        }
        self.sync_interaction();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Locale, LocalePreference, app::Action, i18n::I18n, navigation::Route};
    use crossterm::event::{
        Event, KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
    };
    fn key(code: KeyCode) -> Event {
        Event::Key(KeyEvent::new(code, KeyModifiers::NONE))
    }
    pub(super) fn fixture() -> App {
        let mut app = App::new(
            "/tmp/approval".into(),
            I18n::new(LocalePreference::Explicit(Locale::En), Locale::En),
        );
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "epoch".into(),
        };
        app.apply(Action::Visit(Route::Session("a".into())));
        app.chat.session = Some("a".into());
        app.chat.snapshot = Some(maka_protocol::subscription::decode_session_observation_snapshot(&json!({
            "schemaVersion":5,"session":{"sessionId":"a","metadataRevision":1,"status":"active","createdAt":0,"isArchived":false},
            "projectionRevision":1,"rootTurn":null,"goal":null,"queue":{"hostEpoch":"epoch","queueRevision":0,"steering":[],"followup":[]},
            "interactions":{"pending":[{
                "schemaVersion":1,"interactionId":"approval","sessionId":"a","turnId":"turn","runId":"run",
                "revision":1,"status":"pending","outcome":null,
                "request":{"kind":"permissions","toolUseId":"call","baseRevision":0,
                    "request":{"reason":"Write 中文🦀 file","command":{"command":"printf test","cwd":"/tmp"},
                        "permissions":{"filesystem":[{"path":"/tmp/approval/output","scope":"exact","access":"write"}],"network":"denied"}}}
            }]}
        })).unwrap());
        app.drafts.get_mut("a").unwrap().insert("keep draft");
        app
    }
    pub(super) fn draw(app: &mut App, width: u16, height: u16) -> String {
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(width, height)).unwrap();
        terminal
            .draw(|frame| crate::view::draw(frame, app))
            .unwrap();
        let area = terminal.backend().buffer().area;
        assert!(
            app.hits
                .iter()
                .all(|hit| hit.area.intersection(area) == hit.area)
        );
        terminal
            .backend()
            .buffer()
            .content
            .chunks(usize::from(width))
            .map(|row| {
                let mut text = String::new();
                let mut column = 0;
                while column < row.len() {
                    let symbol = row[column].symbol();
                    text.push_str(symbol);
                    column += unicode_width::UnicodeWidthStr::width(symbol).max(1);
                }
                text
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
    /// Where a command's control sits in the review sheet.
    pub(super) fn path(app: &App, command: Command) -> String {
        let form = app
            .interactions
            .review
            .as_ref()
            .and_then(|review| review.form.as_ref());
        match command {
            Command::Close => "footer/close".into(),
            Command::Details => "footer/details".into(),
            Command::Check | Command::Submit | Command::FormSubmit => "footer/primary".into(),
            Command::Deny => "decisions/deny".into(),
            Command::Once => "decisions/once".into(),
            Command::Turn => "decisions/turn".into(),
            Command::Session => "decisions/session".into(),
            Command::Question(index) => format!("tabs/{index}"),
            Command::Option(index) if form.is_some() => {
                format!("entry/choices/rows/option-{index}")
            }
            Command::Option(index) => format!("question/choices/rows/option-{index}"),
            Command::Skip => "question/choices/rows/skip".into(),
            Command::Empty => "entry/choices/rows/empty".into(),
            Command::Omit => "entry/choices/rows/omit".into(),
            Command::FreeText if form.is_some() => "entry/value/input".into(),
            Command::FreeText => "question/answer/input".into(),
            Command::Field(index) if form.is_some_and(|form| index < form.position()) => {
                "about/pager/previous".into()
            }
            Command::Field(_) => "about/pager/next".into(),
            Command::FormDecline => "outcome/responses/decline".into(),
            Command::FormCancel => "outcome/responses/cancel".into(),
        }
    }
    /// A press and release on a command's control, as drawn.
    pub(super) fn press(app: &mut App, command: Command) -> Option<Action> {
        let area = app.layer.rect(&path(app, command)).unwrap();
        let mut action = None;
        for kind in [
            MouseEventKind::Down(MouseButton::Left),
            MouseEventKind::Up(MouseButton::Left),
        ] {
            action = app
                .input(Event::Mouse(MouseEvent {
                    kind,
                    column: area.x,
                    row: area.y,
                    modifiers: KeyModifiers::NONE,
                }))
                .1
                .or(action);
        }
        action
    }
    fn click(app: &mut App, command: Command) -> Option<Action> {
        press(app, command)
    }
    #[test]
    fn review_is_modal_defaults_to_later_and_mouse_and_keys_preserve_exact_permission_scope() {
        let mut app = fixture();
        app.apply(Action::OpenInteraction);
        let text = draw(&mut app, 100, 30);
        assert!(text.contains("Write 中文🦀 file"), "{text}");
        app.input(Event::Paste("must not leak".into()));
        assert_eq!(app.drafts["a"].text(), "keep draft");
        let action = app.input(key(KeyCode::Enter)).1.unwrap();
        assert_eq!(action, Action::Interaction(Command::Close));
        assert!(app.interaction_request(Command::Close).is_none());
        assert!(!app.interactions.visible);
        for command in [
            Command::Deny,
            Command::Once,
            Command::Turn,
            Command::Session,
        ] {
            app.open_interaction();
            draw(&mut app, 100, 30);
            let selected = click(&mut app, command).unwrap();
            assert_eq!(selected, Action::Interaction(command));
            // The keyboard reaches the same decision.
            app.layer.focus_path(&path(&app, command));
            assert_eq!(app.input(key(KeyCode::Enter)).1, Some(selected));
            let (ticket, answer) = app.interaction_request(command).unwrap();
            assert!(
                app.interaction_request(command).is_none(),
                "no double submit"
            );
            let answer = answer.unwrap();
            answer
                .validate_for_request(ticket.snapshot.request())
                .unwrap();
            let value = serde_json::to_value(&answer).unwrap();
            if command == Command::Deny {
                assert_eq!(value["decision"]["decision"], "deny");
            } else {
                assert_eq!(
                    value["decision"]["scope"],
                    match command {
                        Command::Once => "once",
                        Command::Turn => "turn",
                        _ => "session",
                    }
                );
                assert_eq!(
                    value["decision"]["permissions"],
                    serde_json::to_value(ticket.snapshot.request()).unwrap()["request"]["permissions"]
                );
            }
            app.interaction_completed(
                ticket,
                Err(RequestFailure::Unknown(maka_client::ClientError::Timeout)),
            );
            let (ticket, none) = app.interaction_request(Command::Check).unwrap();
            assert!(none.is_none());
            app.interaction_completed(ticket.clone(), Ok(ticket.snapshot));
        }
        for locale in Locale::ALL {
            app.i18n.preference = LocalePreference::Explicit(locale);
            for (width, height) in [(1, 1), (29, 9), (30, 10), (80, 24), (120, 40)] {
                draw(&mut app, width, height);
            }
            assert!(app.i18n.diagnostics().is_empty());
        }
        assert_eq!(app.drafts["a"].text(), "keep draft");
        draw(&mut app, 80, 24);
        app.input(key(KeyCode::Tab));
        app.input(key(KeyCode::Tab)); // A retained Allow-once focus must not work while invisible.
        app.input(Event::Resize(29, 9));
        draw(&mut app, 29, 9);
        assert_eq!(app.input(key(KeyCode::Enter)).1, None);
        assert_eq!(
            app.input(key(KeyCode::Esc)).1,
            Some(Action::Interaction(Command::Close))
        );
    }

    #[test]
    fn disappeared_requests_and_uncertain_answers_cannot_be_rebound_or_automatically_retried() {
        let mut app = fixture();
        app.open_interaction();
        let original = app.interactions.review.as_ref().unwrap().ticket.clone();
        app.chat.snapshot.as_mut().unwrap().interactions = Default::default();
        app.sync_interaction();
        assert!(app.interaction_request(Command::Once).is_none());
        assert_eq!(app.interactions.review.as_ref().unwrap().ticket, original);
        assert_eq!(
            app.interactions.review.as_ref().unwrap().state,
            State::Stale
        );
        app.interaction_request(Command::Close);
        assert!(
            app.has_interaction(),
            "a disappeared request must remain queryable"
        );
        app.open_interaction();
        assert!(app.interactions.visible);
        let (query, answer) = app.interaction_request(Command::Check).unwrap();
        assert_eq!(query, original);
        assert!(answer.is_none());

        app = fixture();
        app.open_interaction();
        let (ticket, _) = app.interaction_request(Command::Once).unwrap();
        app.abandon_interaction();
        app.interaction_completed(ticket.clone(), Ok(ticket.snapshot.clone()));
        assert_eq!(
            app.interactions.review.as_ref().unwrap().state,
            State::Unknown
        );
        app.interaction_request(Command::Close);
        app.apply(Action::Visit(Route::Session("different".into())));
        app.open_interaction();
        assert_eq!(app.interactions.review.as_ref().unwrap().ticket, ticket);
        app.connection = ConnectionState::Connected {
            root_id: "other".into(),
            epoch: "epoch".into(),
        };
        assert!(app.interaction_request(Command::Check).is_none());
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "new-epoch".into(),
        };
        let (query, answer) = app.interaction_request(Command::Check).unwrap();
        assert_eq!(query, ticket);
        assert!(answer.is_none());
        let mut closed = serde_json::to_value(&ticket.snapshot).unwrap();
        closed["revision"] = json!(2);
        closed["status"] = json!("closed");
        closed["outcome"] = json!({"kind":"closure","reason":"host_restarted","committedAt":10});
        app.interaction_completed(query, Ok(interaction::decode_snapshot(&closed).unwrap()));
        assert_eq!(
            app.interactions.review.as_ref().unwrap().state,
            State::Resolved
        );
        assert!(app.interaction_request(Command::Once).is_none());
        assert!(draw(&mut app, 100, 30).contains("closed by Host"));
    }
}
