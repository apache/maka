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
pub(crate) use view::sheet;

use crate::{
    app::{Action, App, ConnectionState},
    navigation::Route,
};
use maka_client::{Client, RequestFailure};
use maka_protocol::turn::{
    TurnResumePlan, TurnResumeQueryInput, TurnResumeStartInput, TurnResumeStartResult,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    root: String,
    epoch: String,
    session: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    Open(Target),
    Reopen,
    Query,
    Start,
    Retry,
    Close,
}
impl Command {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Open(_) | Self::Reopen => "resume-title",
            Self::Query => "resume-refresh",
            Self::Start => "resume-start",
            Self::Retry => "resume-retry",
            Self::Close => "session-cancel",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Checkpoint {
    root: String,
    input: TurnResumeStartInput,
}
impl Checkpoint {
    pub fn validate(&self, root: &str) -> Result<(), String> {
        if self.root != root {
            return Err("Resume checkpoint belongs to another Root".into());
        }
        maka_protocol::turn::decode_turn_resume_start_input(
            &serde_json::to_value(&self.input).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Work {
    Query,
    Start(TurnResumeStartInput),
}
#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    target: Target,
    work: Work,
    sequence: u64,
}
impl Request {
    pub fn needs_checkpoint(&self) -> bool {
        matches!(self.work, Work::Start(_))
    }
}
pub enum Output {
    Plan(TurnResumePlan),
    Started(TurnResumeStartResult),
}
pub async fn execute(client: &Client, request: &Request) -> Result<Output, RequestFailure> {
    match &request.work {
        Work::Query => client
            .query_resume(TurnResumeQueryInput {
                session_id: request.target.session.clone(),
                source_run_id: None,
                expected_runtime_event_high_water: None,
            })
            .await
            .map(Output::Plan),
        Work::Start(input) => client
            .start_resume(input.clone())
            .await
            .map(Output::Started),
    }
}

#[derive(Default)]
pub struct State {
    pub visible: bool,
    rendered: bool,
    target: Option<Target>,
    plan: Option<TurnResumePlan>,
    saved: Option<Checkpoint>,
    pending: Option<Request>,
    requested: Option<Work>,
    saving: bool,
    error: Option<String>,
    sequence: u64,
}
impl State {
    pub fn checkpoint(&self) -> Option<Checkpoint> {
        self.saved.clone()
    }
    pub fn restore(&mut self, saved: Checkpoint) {
        self.saved = Some(saved);
    }
    pub fn disconnect(&mut self) {
        self.pending = None;
        self.requested = None;
        self.saving = false;
        self.plan = None;
        self.rendered = false;
    }
    pub fn invalidate_geometry(&mut self) {
        self.rendered = false;
    }
    /// The sheet reports whether it is on screen; its commands need it.
    pub(crate) fn presented(&mut self, shown: bool) {
        self.rendered = shown;
    }
}
impl App {
    fn resume_target(&self) -> Option<Target> {
        let ConnectionState::Connected { root_id, epoch } = &self.connection else {
            return None;
        };
        let Route::Session(session) = self.navigation.current() else {
            return None;
        };
        if self.chat.removed || self.session_is_managed(&session) {
            return None;
        }
        Some(Target {
            root: root_id.clone(),
            epoch: epoch.clone(),
            session,
        })
    }
    pub fn resume_commands(&self) -> Vec<(Action, &'static str)> {
        if self.resume.saved.is_some() {
            return vec![(Action::Resume(Command::Reopen), "resume-title")];
        }
        self.resume_target()
            .map(|target| vec![(Action::Resume(Command::Open(target)), "resume-title")])
            .unwrap_or_default()
    }
    pub fn resume_enabled(&self, command: &Command) -> bool {
        let idle = self.resume.pending.is_none() && self.resume.requested.is_none();
        self.resume_offered(command)
            && (idle || matches!(command, Command::Open(_) | Command::Reopen | Command::Close))
    }
    /// Whether the dialog offers `command`, before a request in flight is
    /// considered: its button (and the focus on it) stays while the Host is
    /// asked, and pressing it then does nothing.
    fn resume_offered(&self, command: &Command) -> bool {
        let state = &self.resume;
        let connected = matches!((&self.connection, &state.target),
            (ConnectionState::Connected { root_id, epoch }, Some(target)) if *root_id == target.root && *epoch == target.epoch);
        match command {
            Command::Open(target) => !state.visible && state.saved.is_none() && state.pending.is_none()
                && self.resume_target().as_ref() == Some(target),
            Command::Reopen => !state.visible && state.saved.as_ref().is_some_and(|saved|
                matches!(&self.connection, ConnectionState::Connected { root_id, .. } if *root_id == saved.root)),
            Command::Close => state.visible,
            Command::Query => state.visible && state.rendered && connected && state.saved.is_none(),
            Command::Start => state.visible && state.rendered && connected && state.saved.is_none()
                && matches!(state.plan, Some(TurnResumePlan::Ready { .. })),
            Command::Retry => state.visible && state.rendered && connected && state.saved.is_some(),
        }
    }
    pub fn resume_action(&mut self, command: Command) -> Option<Action> {
        if !self.resume_enabled(&command) {
            return None;
        }
        let state = &mut self.resume;
        match command {
            Command::Open(target) => {
                state.target = Some(target);
                state.visible = true;
                state.rendered = false;
                state.plan = None;
                state.error = None;
                state.requested = Some(Work::Query);
            }
            Command::Reopen => {
                let saved = state.saved.as_ref()?;
                let ConnectionState::Connected { epoch, .. } = &self.connection else {
                    return None;
                };
                state.target = Some(Target {
                    root: saved.root.clone(),
                    epoch: epoch.clone(),
                    session: saved.input.session_id.clone(),
                });
                state.visible = true;
                state.rendered = false;
                state.plan = None;
                state.error = Some(self.i18n.text("resume-unresolved"));
            }
            Command::Close => {
                state.visible = false;
                state.rendered = false;
            }
            Command::Query => {
                state.requested = Some(Work::Query);
                state.error = None;
            }
            Command::Start => {
                let Some(TurnResumePlan::Ready {
                    session_id,
                    source_run_id,
                    source_runtime_event_high_water,
                    ..
                }) = &state.plan
                else {
                    return None;
                };
                let target = state.target.as_ref()?;
                if session_id != &target.session {
                    return None;
                }
                let input = TurnResumeStartInput {
                    session_id: session_id.clone(),
                    turn_id: Uuid::new_v4().to_string(),
                    source_run_id: source_run_id.clone(),
                    source_runtime_event_high_water: *source_runtime_event_high_water,
                };
                state.saved = Some(Checkpoint {
                    root: target.root.clone(),
                    input: input.clone(),
                });
                state.requested = Some(Work::Start(input));
                state.error = None;
            }
            Command::Retry => {
                state.requested = Some(Work::Start(state.saved.as_ref()?.input.clone()));
                state.error = None;
            }
        }
        None
    }
    pub fn resume_request(&mut self) -> Option<Request> {
        let state = &mut self.resume;
        if self.closing || state.pending.is_some() {
            return None;
        }
        let target = state.target.as_ref()?;
        if !matches!(&self.connection, ConnectionState::Connected { root_id, epoch } if *root_id == target.root && *epoch == target.epoch)
        {
            return None;
        }
        let work = state.requested.take()?;
        state.sequence += 1;
        let request = Request {
            target: target.clone(),
            work,
            sequence: state.sequence,
        };
        state.saving = request.needs_checkpoint();
        state.pending = Some(request.clone());
        Some(request)
    }
    pub fn resume_after_checkpoint(
        &mut self,
        request: &Request,
        result: &Result<(), String>,
    ) -> bool {
        let state = &mut self.resume;
        if !state.saving || state.pending.as_ref() != Some(request) {
            return false;
        }
        state.saving = false;
        if result.is_ok()
            && !self.closing
            && matches!(&self.connection,
            ConnectionState::Connected { root_id, epoch } if *root_id == request.target.root && *epoch == request.target.epoch)
        {
            return true;
        }
        state.pending = None;
        state.error = Some(self.i18n.text("resume-save-failed"));
        false
    }
    pub fn resume_completed(&mut self, request: Request, result: Result<Output, RequestFailure>) {
        let state = &mut self.resume;
        if state.pending.as_ref() != Some(&request) {
            return;
        }
        state.pending = None;
        if !matches!(&self.connection, ConnectionState::Connected { root_id, epoch }
            if *root_id == request.target.root && *epoch == request.target.epoch)
        {
            return;
        }
        match result {
            Ok(Output::Plan(plan)) if matches!(request.work, Work::Query) => {
                state.plan = Some(plan);
                state.error = None;
            }
            Ok(Output::Started(TurnResumeStartResult::Started { .. }))
                if request.needs_checkpoint() =>
            {
                state.saved = None;
                state.plan = None;
                state.visible = false;
                state.error = None;
                self.sessions.refresh_detail();
            }
            Ok(Output::Started(TurnResumeStartResult::Parked { plan }))
                if request.needs_checkpoint() =>
            {
                state.saved = None;
                state.plan = Some(plan);
                state.error = None;
            }
            Err(error) => {
                state.error = Some(error.to_string());
            }
            _ => {
                state.error = Some(self.i18n.text("resume-invalid-result"));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::{I18n, Locale, LocalePreference};
    use ratatui::{Terminal, backend::TestBackend};

    fn app() -> App {
        let mut app = App::new(
            "/unused".into(),
            I18n::new(LocalePreference::Explicit(Locale::En), Locale::En),
        );
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "epoch".into(),
        };
        app.apply(Action::Visit(Route::Session("session".into())));
        app
    }

    fn draw(app: &mut App, width: u16, height: u16) {
        Terminal::new(TestBackend::new(width, height))
            .unwrap()
            .draw(|frame| crate::view::draw(frame, app))
            .unwrap();
    }

    fn ready(app: &mut App) {
        let command = app.resume_commands()[0].0.clone();
        app.apply(command);
        let query = app.resume_request().unwrap();
        app.resume_completed(
            query,
            Ok(Output::Plan(TurnResumePlan::Ready {
                session_id: "session".into(),
                source_run_id: "run".into(),
                source_turn_id: "turn".into(),
                source_runtime_event_high_water: 12,
            })),
        );
        draw(app, 100, 35);
    }

    #[test]
    fn resume_persists_identity_before_dispatch_and_retries_same_turn_after_reconnect() {
        let mut app = app();
        ready(&mut app);
        app.apply(Action::Resume(Command::Start));
        let first = app.resume_request().unwrap();
        let saved = app.resume.checkpoint().unwrap();
        assert!(first.needs_checkpoint());
        assert!(saved.validate("root").is_ok());
        assert!(saved.validate("other").is_err());
        assert!(!app.resume_after_checkpoint(&first, &Err("disk full".into())));
        assert!(app.resume.checkpoint().is_some());
        draw(&mut app, 100, 35);
        app.apply(Action::Resume(Command::Retry));
        let retry = app.resume_request().unwrap();
        assert_eq!(retry.work, first.work);
        assert!(app.resume_after_checkpoint(&retry, &Ok(())));
        assert!(!app.resume_after_checkpoint(&retry, &Ok(())));

        app.resume.disconnect();
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "new".into(),
        };
        app.resume_completed(
            retry,
            Ok(Output::Plan(TurnResumePlan::Parked {
                session_id: "session".into(),
                reason: maka_protocol::turn::TurnResumeParkReason::SafetyCheckFailed,
            })),
        );
        assert_eq!(app.resume.checkpoint().unwrap().input, saved.input);

        let mut reopened = State::default();
        reopened.restore(saved);
        assert!(!reopened.visible);
        assert!(reopened.requested.is_none());
        app.resume = reopened;
        app.apply(Action::Resume(Command::Reopen));
        draw(&mut app, 100, 35);
        app.apply(Action::Resume(Command::Retry));
        let after_restart = app.resume_request().unwrap();
        assert_eq!(after_restart.work, first.work);
        assert_ne!(after_restart.target.epoch, first.target.epoch);
    }

    #[test]
    fn parked_plan_and_small_terminal_never_start_a_turn() {
        let mut app = app();
        ready(&mut app);
        let (handled, action) = app.input(crossterm::event::Event::Key(
            crossterm::event::KeyEvent::new(
                crossterm::event::KeyCode::Enter,
                crossterm::event::KeyModifiers::NONE,
            ),
        ));
        assert!(handled);
        assert!(action.is_none());
        assert!(!app.resume.visible, "Enter initially closes the dialog");
        assert!(app.resume_request().is_none());
        app.apply(app.resume_commands()[0].0.clone());
        let query = app.resume_request().unwrap();
        app.resume_completed(
            query,
            Ok(Output::Plan(TurnResumePlan::Ready {
                session_id: "session".into(),
                source_run_id: "run".into(),
                source_turn_id: "turn".into(),
                source_runtime_event_high_water: 12,
            })),
        );
        draw(&mut app, 30, 8);
        assert!(!app.resume_enabled(&Command::Start));
        draw(&mut app, 100, 35);
        app.layer.focus_path("footer/check");
        app.apply(Action::Resume(Command::Query));
        let query = app.resume_request().unwrap();
        draw(&mut app, 100, 35);
        assert_eq!(
            app.layer.focused_path(),
            Some("footer/check"),
            "asking keeps the focus"
        );
        app.resume_completed(
            query,
            Ok(Output::Plan(TurnResumePlan::Parked {
                session_id: "session".into(),
                reason: maka_protocol::turn::TurnResumeParkReason::SafetyCheckFailed,
            })),
        );
        draw(&mut app, 100, 35);
        assert!(!app.resume_enabled(&Command::Start));
        assert!(app.resume_request().is_none());
    }
}
