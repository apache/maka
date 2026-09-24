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

mod identity;
mod input;
pub mod saved;
mod view;
pub(super) use input::sheet_input;
pub(super) use view::{draw, sheet};

use super::{Command as Manage, Entity, Kind, Target};
use crate::{
    app::{Action, App, ConnectionState},
    navigation::Route,
};
use maka_client::{Client, OAuthPresentation, OAuthPresentationService, RequestFailure};
use maka_protocol::oauth::{
    ConnectionIdentity, EnrollmentProjection, LoginProjection, LoginRecovery, LoginStart, Phase,
    Target as LoginTarget,
};
use std::time::{Duration, Instant};

#[derive(Clone)]
struct Choice {
    provider: maka_protocol::model_provider::Entry,
    method: usize,
}
impl Choice {
    fn label(&self) -> String {
        format!(
            "{} · {}",
            self.provider.descriptor.label,
            self.authentication().label
        )
    }
    fn authentication(&self) -> &maka_protocol::model_provider::Method {
        &self.provider.descriptor.authentication[self.method]
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command {
    Provider(usize),
    Identity,
    Field(usize),
    Begin,
    Cancel,
    Check,
    New,
    CopyLink,
    CopyCode,
}
impl Command {
    pub fn label(self) -> &'static str {
        match self {
            Self::Provider(_) => "onboard-provider",
            Self::Identity => "oauth-identity",
            Self::Field(0) => "oauth-name",
            Self::Field(1) => "oauth-slug",
            Self::Field(2) => "oauth-configuration",
            Self::Field(_) => "oauth-authentication-input",
            Self::Begin => "oauth-begin",
            Self::Cancel => "oauth-cancel",
            Self::Check => "oauth-check",
            Self::New => "oauth-new",
            Self::CopyLink => "oauth-copy-link",
            Self::CopyCode => "oauth-copy-code",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Operation {
    Publish,
    Enrollment,
    Start,
    Query,
    Cancel,
}

#[derive(Clone, PartialEq)]
pub struct Request {
    sequence: u64,
    root: String,
    epoch: String,
    call: Call,
}

#[derive(Clone, PartialEq)]
enum Call {
    Publish,
    Enrollment(maka_protocol::model_provider::Identity),
    Start(Box<LoginStart>),
    Query(Observation),
    Cancel(Observation),
}

#[derive(Clone, Debug, PartialEq)]
struct Observation {
    attempt: LoginRecovery,
    connection: Option<ConnectionIdentity>,
}

impl std::fmt::Debug for Request {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Request")
            .field("sequence", &self.sequence)
            .field("root", &self.root)
            .field("epoch", &self.epoch)
            .field("operation", &self.operation())
            .finish_non_exhaustive()
    }
}
impl Request {
    fn operation(&self) -> Operation {
        match &self.call {
            Call::Publish => Operation::Publish,
            Call::Enrollment(_) => Operation::Enrollment,
            Call::Start(_) => Operation::Start,
            Call::Query(_) => Operation::Query,
            Call::Cancel(_) => Operation::Cancel,
        }
    }
    pub fn needs_checkpoint(&self) -> bool {
        matches!(self.call, Call::Start(_))
    }
}

pub enum Output {
    Published(OAuthPresentationService),
    Enrollment(EnrollmentProjection),
    Login(LoginProjection),
}

pub async fn execute(client: &Client, request: &Request) -> Result<Output, RequestFailure> {
    match &request.call {
        Call::Publish => client
            .publish_oauth_presentation()
            .await
            .map(Output::Published),
        Call::Enrollment(provider) => client
            .oauth_enrollment(provider.clone())
            .await
            .map(Output::Enrollment),
        Call::Start(input) => client.start_oauth_login(input).await.map(Output::Login),
        Call::Query(input) => client
            .query_oauth_login(&input.attempt, input.connection.as_ref())
            .await
            .map(Output::Login),
        Call::Cancel(input) => client
            .cancel_oauth_login(&input.attempt, input.connection.as_ref())
            .await
            .map(Output::Login),
    }
}

#[derive(Default)]
pub struct State {
    root: String,
    provider: usize,
    choices: Vec<Choice>,
    existing: Option<maka_protocol::configuration::ConnectionCredentialTarget>,
    connection_label: String,
    ready: bool,
    enrollment: Option<bool>,
    attempt: Option<LoginRecovery>,
    prepared: Option<LoginStart>,
    projection: Option<LoginProjection>,
    recovered_connection: Option<ConnectionIdentity>,
    awaiting_checkpoint: bool,
    presentation: Option<OAuthPresentation>,
    display: Option<(String, Option<String>)>,
    pending: Option<Request>,
    requested: Option<Operation>,
    sequence: u64,
    next_poll: Option<Instant>,
    error: Option<&'static str>,
    copy_note: Option<&'static str>,
    not_found: bool,
    identity: identity::Identity,
    /// Counts fresh starts, so a new sign-in opens its sheet anew.
    generation: u64,
}

impl State {
    fn terminal(&self) -> bool {
        self.projection.as_ref().is_some_and(|projection| {
            matches!(
                projection.phase,
                Phase::Authenticated | Phase::Cancelled | Phase::Failed { .. }
            )
        })
    }

    pub fn abandon(&mut self) {
        self.prepared = None;
        self.identity.clear_authentication();
        self.awaiting_checkpoint = false;
        self.pending = None;
        self.requested = None;
        self.next_poll = None;
        self.ready = false;
        self.presentation = None;
        self.display = None;
        if self.attempt.is_some() && !self.terminal() {
            self.error = Some("oauth-unknown");
        }
    }

    fn reset(&mut self) {
        self.attempt = None;
        self.prepared = None;
        self.projection = None;
        self.recovered_connection = None;
        self.awaiting_checkpoint = false;
        self.presentation = None;
        self.display = None;
        self.next_poll = None;
        self.error = None;
        self.copy_note = None;
        self.not_found = false;
        self.enrollment = None;
        self.identity = identity::Identity::default();
        self.generation += 1;
    }

    fn status(&self) -> &'static str {
        if let Some(error) = self.error {
            return error;
        }
        if self.attempt.is_none() && self.pending.is_some() {
            return "oauth-preparing";
        }
        if self.customizable()
            && let Some(error) = self.identity.error()
        {
            return error;
        }
        if let Some(note) = self.copy_note {
            return note;
        }
        if let Some(projection) = &self.projection {
            return match projection.phase {
                Phase::AwaitingAuthorization => "oauth-awaiting",
                Phase::Exchanging => "oauth-exchanging",
                Phase::Committing => "oauth-committing",
                Phase::Authenticated => "oauth-authenticated",
                Phase::Cancelled => "oauth-cancelled",
                Phase::Failed { failure } => match failure {
                    maka_protocol::oauth::Failure::CredentialChanged
                    | maka_protocol::oauth::Failure::ConnectionChanged => "oauth-changed",
                    maka_protocol::oauth::Failure::SlugTaken => "oauth-slug-taken",
                    maka_protocol::oauth::Failure::CapabilityUnavailable => {
                        "oauth-presentation-failed"
                    }
                    _ => "oauth-failed",
                },
            };
        }
        if self.attempt.is_some() {
            "oauth-starting"
        } else if self.enrollment == Some(false) {
            "oauth-disabled"
        } else if self.pending.is_some() {
            "oauth-preparing"
        } else {
            "oauth-note"
        }
    }
}

impl State {
    fn refresh_choices(&mut self, catalog: &crate::providers::Providers) {
        self.choices = catalog
            .entries()
            .iter()
            .filter(|provider| {
                self.existing
                    .as_ref()
                    .is_none_or(|existing| existing.provider == provider.identity)
            })
            .flat_map(|provider| {
                (0..provider.descriptor.authentication.len()).map(|method| Choice {
                    provider: provider.clone(),
                    method,
                })
            })
            .collect();
        self.provider = 0;
        if let Some(choice) = self.choices.first() {
            self.identity.configure(choice, self.existing.as_ref());
            self.identity.expanded = !choice.authentication().interactive;
        }
    }

    fn fields(&self) -> impl Iterator<Item = usize> + '_ {
        (0..4).filter(|index| {
            (*index >= 2 || self.existing.is_none())
                && (*index != 3 || self.identity.authentication_field().is_some())
        })
    }
    fn provider_name(&self) -> String {
        self.choices
            .get(self.provider)
            .map(Choice::label)
            .unwrap_or_else(|| {
                self.attempt
                    .as_ref()
                    .map(|attempt| match &attempt.target {
                        LoginTarget::Create { provider, .. } => provider.name.clone(),
                        LoginTarget::Existing { expected, .. } => expected.provider.name.clone(),
                    })
                    .unwrap_or_default()
            })
    }
}

impl App {
    pub fn oauth_catalog_loaded(&mut self) {
        let state = &mut self.management.oauth;
        if state.choices.is_empty() && state.attempt.is_none() {
            state.refresh_choices(&self.providers);
            self.hits.clear();
        }
    }

    pub fn oauth_commands(&self) -> Vec<(Action, &'static str)> {
        // Account setup belongs with workspace/settings/connection management;
        // do not displace conversation and recovery controls in a chat palette.
        // An existing attempt remains reachable from every route when hidden.
        if self.management.oauth.attempt.is_none()
            && !matches!(
                self.navigation.current(),
                Route::Workspace | Route::Settings | Route::Connections
            )
        {
            return vec![];
        }
        let ConnectionState::Connected { root_id, epoch } = &self.connection else {
            return vec![];
        };
        let mut commands = vec![(
            Action::Manage(Manage::Open(
                Target {
                    root: root_id.clone(),
                    epoch: epoch.clone(),
                    name: String::new(),
                    entity: Entity::Oauth,
                },
                Kind::Oauth,
            )),
            if self.management.oauth.attempt.is_some() {
                "oauth-resume"
            } else {
                "oauth-title"
            },
        )];
        if self.navigation.current() == Route::Connections
            && (self.management.oauth.attempt.is_none() || self.management.oauth.terminal())
            && let Some(row) = self
                .connections
                .rows
                .iter()
                .find(|row| Some(&row.id) == self.connections.selected.as_ref())
            && self
                .providers
                .find(&row.provider)
                .is_some_and(|provider| !provider.descriptor.authentication.is_empty())
        {
            commands.push((
                Action::Manage(Manage::Open(
                    Target {
                        root: root_id.clone(),
                        epoch: epoch.clone(),
                        name: row.name.clone(),
                        entity: Entity::Connection(row.clone()),
                    },
                    Kind::Oauth,
                )),
                "oauth-reauth",
            ));
        }
        commands
    }

    pub(super) fn oauth_open(&mut self, target: &Target) {
        let state = &mut self.management.oauth;
        if state.attempt.is_none()
            || state.terminal() && matches!(target.entity, Entity::Connection(_))
        {
            state.reset();
            state.root = target.root.clone();
            state.existing = if let Entity::Connection(row) = &target.entity {
                state.connection_label = format!("{} · {}", row.name, row.slug);
                Some(maka_protocol::configuration::ConnectionCredentialTarget {
                    connection_id: row.id.clone(),
                    revision: row.revision,
                    slug: row.slug.clone(),
                    provider: row.provider.clone(),
                    configuration: row.configuration.clone(),
                })
            } else {
                state.connection_label.clear();
                None
            };
            state.refresh_choices(&self.providers);
        }
    }

    pub(super) fn oauth_enabled(&self, command: Command) -> bool {
        let Some(dialog) = self
            .management
            .dialog
            .as_ref()
            .filter(|dialog| dialog.kind == Kind::Oauth && dialog.visible)
        else {
            return false;
        };
        let state = &self.management.oauth;
        if !matches!(&self.connection, ConnectionState::Connected {root_id, ..} if *root_id == state.root)
            || dialog.target.root != state.root
        {
            return false;
        }
        match command {
            Command::CopyLink => state.display.is_some(),
            Command::CopyCode => state
                .display
                .as_ref()
                .is_some_and(|(_, code)| code.is_some()),
            // Editing the details races nothing: a started attempt has
            // already taken them, and then they are not customizable.
            Command::Identity => state.customizable(),
            Command::Field(index) => {
                state.customizable()
                    && state.identity.expanded
                    && state.fields().any(|field| field == index)
            }
            // Only an asked, unsent operation blocks the next one. A request
            // in flight (a poll, an availability check) disables nothing the
            // user may be focused on: asking again queues behind it, and an
            // availability answer is kept only for the provider it was for.
            _ if state.requested.is_some() => false,
            Command::Provider(index) => index < state.choices.len() && state.attempt.is_none(),
            Command::Cancel => state.attempt.is_some() && !state.terminal(),
            Command::Check => !state.terminal(),
            _ if state.pending.is_some() => false,
            Command::Begin => {
                state.attempt.is_none()
                    && state.ready
                    && state.enrollment == Some(true)
                    && (!state.customizable() || state.identity.error().is_none())
            }
            Command::New => state.terminal() || state.not_found,
        }
    }

    pub(super) fn oauth_action(&mut self, command: Command) -> Option<Action> {
        let state = &mut self.management.oauth;
        state.copy_note = None;
        match command {
            Command::Provider(index) => {
                if state.provider == index {
                    return None;
                }
                state.provider = index;
                state
                    .identity
                    .configure(&state.choices[index], state.existing.as_ref());
                state.identity.expanded = !state.choices[index].authentication().interactive;
                state.identity.invalidate_geometry();
                state.enrollment = None;
                state.error = None;
            }
            Command::Identity => {
                state.identity.expanded = !state.identity.expanded;
                state.identity.invalidate_geometry();
            }
            Command::Field(_) => {}
            Command::Begin => {
                let choice = state.choices.get(state.provider)?;
                let start = state.identity.start(choice, state.existing.as_ref()).ok()?;
                state.connection_label = match &start.target {
                    LoginTarget::Create { name, slug, .. } => format!("{name} · {slug}"),
                    LoginTarget::Existing { expected, .. } => expected.slug.clone(),
                };
                state.attempt = Some(start.recovery());
                state.prepared = Some(start);
                state.identity.clear_authentication();
                state.error = None;
                state.requested = Some(Operation::Start);
            }
            Command::Cancel => {
                state.error = None;
                state.display = None;
                state.presentation = None;
                state.requested = Some(Operation::Cancel);
            }
            Command::Check => {
                state.error = None;
                state.requested = state.attempt.as_ref().map(|_| Operation::Query);
            }
            Command::New => {
                state.reset();
                state.refresh_choices(&self.providers);
            }
            Command::CopyLink | Command::CopyCode => {
                return Some(Action::Manage(Manage::Oauth(command)));
            }
        }
        None
    }

    pub fn oauth_request(&mut self) -> Option<Request> {
        if self.closing {
            return None;
        }
        let ConnectionState::Connected { root_id, epoch } = &self.connection else {
            return None;
        };
        let visible = self
            .management
            .dialog
            .as_ref()
            .is_some_and(|dialog| dialog.kind == Kind::Oauth);
        let state = &mut self.management.oauth;
        if state.pending.is_some() || state.root != *root_id {
            return None;
        }
        let operation = if let Some(requested) = state.requested.take() {
            requested
        } else if state.next_poll.is_some_and(|time| time <= Instant::now()) {
            Operation::Query
        } else if visible && state.attempt.is_none() && state.error.is_none() {
            if !state.ready {
                Operation::Publish
            } else if state.enrollment.is_none() {
                Operation::Enrollment
            } else {
                return None;
            }
        } else {
            return None;
        };
        state.sequence += 1;
        state.next_poll = None;
        let request = Request {
            sequence: state.sequence,
            root: root_id.clone(),
            epoch: epoch.clone(),
            call: match operation {
                Operation::Publish => Call::Publish,
                Operation::Enrollment => {
                    Call::Enrollment(state.choices.get(state.provider)?.provider.identity.clone())
                }
                Operation::Start => Call::Start(Box::new(state.prepared.take()?)),
                Operation::Query | Operation::Cancel => {
                    let observation = Observation {
                        attempt: state.attempt.clone()?,
                        connection: state
                            .projection
                            .as_ref()
                            .map(|projection| projection.connection.clone())
                            .or_else(|| state.recovered_connection.clone()),
                    };
                    if operation == Operation::Query {
                        Call::Query(observation)
                    } else {
                        Call::Cancel(observation)
                    }
                }
            },
        };
        state.awaiting_checkpoint = request.needs_checkpoint();
        state.pending = Some(request.clone());
        Some(request)
    }

    pub fn oauth_wait(&self) -> Option<Duration> {
        self.management
            .oauth
            .next_poll
            .map(|time| time.saturating_duration_since(Instant::now()))
    }

    pub fn oauth_completed(
        &mut self,
        request: Request,
        result: Result<Output, RequestFailure>,
    ) -> Option<OAuthPresentationService> {
        let state = &mut self.management.oauth;
        if state.pending.as_ref() != Some(&request)
            || !matches!(&self.connection, ConnectionState::Connected {root_id, epoch} if *root_id == request.root && *epoch == request.epoch)
        {
            return None;
        }
        state.pending = None;
        state.awaiting_checkpoint = false;
        let mut service = None;
        match result {
            Ok(Output::Published(published)) => {
                state.ready = true;
                service = Some(published);
            }
            // The choice changed while asking: the current one is asked next.
            Ok(Output::Enrollment(enrollment)) => {
                if matches!(&request.call, Call::Enrollment(provider)
                    if state.choices.get(state.provider).is_some_and(|choice| choice.provider.identity == *provider))
                {
                    state.enrollment = Some(enrollment.enabled);
                }
            }
            Ok(Output::Login(projection)) => {
                state.recovered_connection = None;
                state.awaiting_checkpoint = false;
                state.error = None;
                state.copy_note = None;
                state.not_found = false;
                state.projection = Some(projection);
                if state.terminal() {
                    state.presentation = None;
                    state.display = None;
                    self.connections.refresh();
                } else {
                    state.next_poll = Some(Instant::now() + Duration::from_secs(2));
                }
            }
            Err(error) => {
                state.not_found = request.operation() == Operation::Query
                    && matches!(&error, RequestFailure::Rejected(maka_client::ClientError::Rejected(error))
                        if error.code == maka_protocol::OperationErrorCode::NotFound);
                if state.not_found {
                    state.display = None;
                    state.presentation = None;
                }
                if request.operation() == Operation::Start
                    && !matches!(error, RequestFailure::Unknown(_))
                {
                    state.attempt = None;
                }
                state.error = Some(if state.not_found {
                    "oauth-not-found"
                } else if state.attempt.is_some() && matches!(error, RequestFailure::Unknown(_)) {
                    "oauth-unknown"
                } else {
                    "oauth-request-failed"
                });
            }
        }
        service
    }

    pub fn oauth_presentation(&mut self, request: OAuthPresentation) {
        let state = &mut self.management.oauth;
        if request.is_cancelled()
            || state.attempt.is_none()
            || state.terminal()
            || !matches!(&self.connection, ConnectionState::Connected {root_id, ..} if *root_id == state.root)
        {
            return;
        }
        state.display = Some((request.url.clone(), request.state_hint.clone()));
        state.presentation = Some(request);
    }

    pub fn oauth_after_draw(&mut self) {
        if self
            .management
            .dialog
            .as_ref()
            .is_some_and(|dialog| dialog.kind == Kind::Oauth && dialog.visible)
            && let Some(request) = self.management.oauth.presentation.take()
            && !request.acknowledge_presented()
        {
            self.management.oauth.display = None;
        }
    }

    pub fn oauth_before_draw(&mut self) {
        if self
            .management
            .oauth
            .presentation
            .as_ref()
            .is_some_and(OAuthPresentation::is_cancelled)
        {
            self.management.oauth.presentation = None;
            self.management.oauth.display = None;
        }
    }

    pub fn oauth_service_closed(&mut self) {
        self.management.oauth.ready = false;
        self.management.oauth.display = None;
        self.management.oauth.presentation = None;
    }

    pub fn oauth_copy(&mut self, command: Command) {
        let text = self
            .management
            .oauth
            .display
            .as_ref()
            .and_then(|(url, code)| match command {
                Command::CopyLink => Some(url.as_str()),
                Command::CopyCode => code.as_deref(),
                _ => None,
            });
        if let Some(text) = text {
            let key = if crate::terminal::copy(&mut std::io::stdout(), text).is_ok() {
                "chat-copy-requested"
            } else {
                "chat-copy-failed"
            };
            self.management.oauth.copy_note = Some(key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::{I18n, Locale, LocalePreference};
    use crossterm::event::{
        Event, KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
    };
    use ratatui::{Terminal, backend::TestBackend};

    fn app() -> App {
        let mut app = App::new(
            "/unused".into(),
            I18n::new(LocalePreference::Explicit(Locale::En), Locale::En),
        );
        app.providers = crate::providers::fixtures::catalog();
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "epoch".into(),
        };
        let action = app.oauth_commands()[0].0.clone();
        app.apply(action);
        app
    }

    fn render(app: &mut App, width: u16, height: u16) -> String {
        let mut screen = Terminal::new(TestBackend::new(width, height)).unwrap();
        app.oauth_before_draw();
        screen.draw(|frame| crate::view::draw(frame, app)).unwrap();
        app.oauth_after_draw();
        screen
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect()
    }

    fn login(app: &App, phase: Phase) -> LoginProjection {
        let attempt = app.management.oauth.attempt.as_ref().unwrap();
        let (provider, slug) = match &attempt.target {
            LoginTarget::Create { provider, slug, .. } => (provider, slug),
            LoginTarget::Existing { expected, .. } => (&expected.provider, &expected.slug),
        };
        LoginProjection {
            attempt_id: attempt.attempt_id.clone(),
            connection: ConnectionIdentity {
                connection_id: "connection".into(),
                provider: provider.clone(),
                slug: slug.clone(),
            },
            phase,
        }
    }

    fn act(app: &mut App, command: Command) {
        assert!(app.oauth_enabled(command), "{command:?}");
        app.apply(Action::Manage(Manage::Oauth(command)));
    }

    #[test]
    fn oauth_modal_preserves_attempt_on_hide_cancel_race_and_unknown_without_invisible_actions() {
        let mut app = app();
        app.management.oauth.choices.clear();
        app.providers = Default::default();
        render(&mut app, 80, 24);
        assert!(!app.oauth_enabled(Command::Begin));
        app.providers = crate::providers::fixtures::catalog();
        app.oauth_catalog_loaded();
        assert!(!app.management.oauth.choices.is_empty());
        // Client publication/admission is covered by the wire test below. Here
        // the already-published service is a fixed prerequisite for UI states.
        app.management.oauth.ready = true;
        let enrollment = app.oauth_request().unwrap();
        assert_eq!(enrollment.operation(), Operation::Enrollment);
        app.oauth_completed(
            enrollment,
            Ok(Output::Enrollment(EnrollmentProjection {
                provider: crate::providers::fixtures::entry("openai-codex", true).identity,
                enabled: false,
            })),
        );
        render(&mut app, 80, 24);
        assert!(!app.oauth_enabled(Command::Begin));
        act(&mut app, Command::Provider(2));
        let enrollment = app.oauth_request().unwrap();
        // Choosing again while asking keeps only the answer for the choice.
        render(&mut app, 80, 24);
        act(&mut app, Command::Provider(1));
        app.oauth_completed(
            enrollment,
            Ok(Output::Enrollment(EnrollmentProjection {
                provider: crate::providers::fixtures::entry("xai-oauth", true).identity,
                enabled: true,
            })),
        );
        assert_eq!(app.management.oauth.enrollment, None);
        act(&mut app, Command::Provider(2));
        let enrollment = app.oauth_request().unwrap();
        assert!(
            matches!(&enrollment.call, Call::Enrollment(provider) if provider == &crate::providers::fixtures::entry("xai-oauth", true).identity)
        );
        app.oauth_completed(
            enrollment,
            Ok(Output::Enrollment(EnrollmentProjection {
                provider: crate::providers::fixtures::entry("xai-oauth", true).identity,
                enabled: true,
            })),
        );
        for locale in Locale::ALL {
            app.i18n = I18n::new(LocalePreference::Explicit(locale), Locale::En);
            for (width, height) in [(44, 20), (80, 24), (120, 40)] {
                render(&mut app, width, height);
                assert!(app.oauth_enabled(Command::Begin));
                assert_eq!(app.layer.focused_path(), Some("footer/close"));
                assert!(
                    app.layer
                        .rect("footer/begin")
                        .is_some_and(|rect| !rect.is_empty()),
                    "{locale:?} {width}x{height}"
                );
            }
        }
        render(&mut app, 25, 8);
        assert!(!app.oauth_enabled(Command::Begin));
        assert!(!app.management_enabled(&Manage::Save));
        app.input(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::NONE,
        )));
        assert!(app.management.oauth.attempt.is_none());
        render(&mut app, 80, 24);
        act(&mut app, Command::Begin);
        let started = app.oauth_request().unwrap();
        let Call::Start(start) = &started.call else {
            panic!()
        };
        let identity = start.recovery();
        let projection = login(&app, Phase::AwaitingAuthorization);
        app.oauth_completed(started, Ok(Output::Login(projection)));
        app.management.oauth.display = Some((
            "https://login.example/device".into(),
            Some("CODE-1234".into()),
        ));
        render(&mut app, 80, 24);
        let cancel = "footer/cancel";
        app.layer.focus_path(cancel);
        render(&mut app, 80, 24);
        app.management.oauth.next_poll = Some(Instant::now());
        let query = app.oauth_request().unwrap();
        assert_eq!(query.operation(), Operation::Query);
        render(&mut app, 80, 24);
        assert_eq!(app.layer.focused_path(), Some(cancel), "a poll in flight");
        let projection = login(&app, Phase::AwaitingAuthorization);
        app.oauth_completed(query, Ok(Output::Login(projection)));
        render(&mut app, 80, 24);
        assert_eq!(
            app.layer.focused_path(),
            Some(cancel),
            "polling must not steal focus"
        );
        let route = app.navigation.current();
        app.input(Event::Mouse(MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 0,
            row: 0,
            modifiers: KeyModifiers::NONE,
        }));
        assert!(app.management.dialog.is_none());
        assert_eq!(app.navigation.current(), route);
        assert_eq!(app.management.oauth.attempt.as_ref(), Some(&identity));
        assert_eq!(
            app.management.oauth.requested, None,
            "outside click is not cancellation"
        );
        app.apply(app.oauth_commands()[0].0.clone());
        render(&mut app, 80, 24);
        act(&mut app, Command::Cancel);
        let cancelled = app.oauth_request().unwrap();
        assert_eq!(cancelled.operation(), Operation::Cancel);
        assert!(
            matches!(&cancelled.call, Call::Cancel(observation) if observation.attempt == identity)
        );
        assert!(app.management.oauth.display.is_none());
        let projection = login(&app, Phase::Committing);
        app.oauth_completed(cancelled, Ok(Output::Login(projection)));
        assert!(
            !app.management.oauth.terminal(),
            "a cancellation request is not its outcome"
        );
        render(&mut app, 80, 24);
        act(&mut app, Command::Check);
        let query = app.oauth_request().unwrap();
        app.apply(Action::Manage(Manage::Close));
        let projection = login(&app, Phase::Authenticated);
        app.oauth_completed(query, Ok(Output::Login(projection)));
        assert!(
            app.management.dialog.is_none(),
            "late authentication must not reopen the modal"
        );
        assert!(app.management.oauth.terminal());
        assert!(app.oauth_wait().is_none());
        assert!(
            app.management.oauth.checkpoint().is_none(),
            "confirmed terminal results retire the recovery basis"
        );

        app.apply(app.oauth_commands()[0].0.clone());
        render(&mut app, 80, 24);
        act(&mut app, Command::New);
        let enrollment = app.oauth_request().unwrap();
        assert_eq!(enrollment.operation(), Operation::Enrollment);
        app.oauth_completed(
            enrollment,
            Ok(Output::Enrollment(EnrollmentProjection {
                provider: crate::providers::fixtures::entry("xai-oauth", true).identity,
                enabled: true,
            })),
        );
        render(&mut app, 80, 24);
        act(&mut app, Command::Begin);
        let unknown = app.oauth_request().unwrap();
        let Call::Start(start) = &unknown.call else {
            panic!()
        };
        let original = start.recovery();
        app.oauth_completed(
            unknown.clone(),
            Err(RequestFailure::Unknown(maka_client::ClientError::Timeout)),
        );
        app.management.oauth.abandon();
        app.providers = crate::providers::fixtures::catalog();
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "new-epoch".into(),
        };
        render(&mut app, 80, 24);
        assert!(!app.oauth_enabled(Command::Begin));
        assert!(
            app.oauth_request().is_none(),
            "unknown start must not automatically replay"
        );
        act(&mut app, Command::Check);
        let query = app.oauth_request().unwrap();
        assert_eq!(query.operation(), Operation::Query);
        assert!(matches!(&query.call, Call::Query(observation) if observation.attempt == original));
        assert_eq!(query.epoch, "new-epoch");
        let old = login(&app, Phase::Authenticated);
        app.oauth_completed(unknown, Ok(Output::Login(old)));
        assert_eq!(
            app.management.oauth.pending.as_ref(),
            Some(&query),
            "old epoch result must not settle recovery"
        );
        app.oauth_completed(
            query,
            Err(RequestFailure::Rejected(
                maka_client::ClientError::Rejected(maka_protocol::OperationError {
                    code: maka_protocol::OperationErrorCode::NotFound,
                    message: "absent".into(),
                }),
            )),
        );
        render(&mut app, 80, 24);
        assert!(app.oauth_enabled(Command::New));
        assert!(!app.oauth_enabled(Command::Begin));
        assert!(
            app.oauth_request().is_none(),
            "NotFound requires an explicit new choice"
        );
    }

    type Reader = tokio::io::BufReader<tokio::io::ReadHalf<tokio::io::DuplexStream>>;
    type Writer = tokio::io::WriteHalf<tokio::io::DuplexStream>;

    async fn read(reader: &mut Reader) -> serde_json::Value {
        use tokio::io::AsyncBufReadExt;
        let mut line = String::new();
        assert!(
            tokio::time::timeout(Duration::from_secs(2), reader.read_line(&mut line))
                .await
                .unwrap()
                .unwrap()
                > 0
        );
        serde_json::from_str(&line).unwrap()
    }

    async fn write(writer: &mut Writer, value: serde_json::Value) {
        use tokio::io::AsyncWriteExt;
        writer
            .write_all(format!("{value}\n").as_bytes())
            .await
            .unwrap();
    }

    async fn rpc(
        app: &mut App,
        client: &Client,
        reader: &mut Reader,
        writer: &mut Writer,
        operation: &str,
        result: impl FnOnce(&serde_json::Value) -> serde_json::Value,
    ) -> Option<OAuthPresentationService> {
        let request = app.oauth_request().unwrap();
        let task = tokio::spawn({
            let client = client.clone();
            let request = request.clone();
            async move { execute(&client, &request).await }
        });
        let frame = read(reader).await;
        assert_eq!(frame["operation"], operation);
        write(writer, serde_json::json!({"requestId":frame["requestId"],"operation":frame["operation"],"ok":true,"result":result(&frame)})).await;
        app.oauth_completed(request, task.await.unwrap())
    }

    #[tokio::test]
    async fn oauth_wire_only_acknowledges_a_visible_render_and_completion_never_reopens_hidden_ui()
    {
        use serde_json::json;
        const ROOT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let (local, remote) = tokio::io::duplex(64 * 1024);
        let (reader, mut writer) = tokio::io::split(remote);
        let mut reader = tokio::io::BufReader::new(reader);
        let connecting = tokio::spawn(Client::connect(
            local,
            ROOT,
            "epoch",
            maka_client::Operations,
        ));
        read(&mut reader).await;
        write(&mut writer, json!({"kind":"accepted","rootId":ROOT,"hostEpoch":"epoch","connectionId":"test",
            "selectedProtocol":maka_protocol::PROTOCOL_VERSION,"compatibilityEpoch":maka_protocol::COMPATIBILITY_EPOCH,
            "compositionId":maka_protocol::COMPOSITION_ID,"compositionRevision":"test","state":"ready"})).await;
        let (client, _notices) = connecting.await.unwrap().unwrap();
        let mut app = App::new(
            "/unused".into(),
            I18n::new(LocalePreference::Explicit(Locale::En), Locale::En),
        );
        app.providers = crate::providers::fixtures::catalog();
        app.connection = ConnectionState::Connected {
            root_id: ROOT.into(),
            epoch: "epoch".into(),
        };
        app.apply(app.oauth_commands()[0].0.clone());
        let mut service = rpc(
            &mut app,
            &client,
            &mut reader,
            &mut writer,
            "client.capability.replace",
            |frame| json!({"registrationId":frame["input"]["registrationId"],"revision":1}),
        )
        .await
        .unwrap();
        rpc(
            &mut app,
            &client,
            &mut reader,
            &mut writer,
            "oauth.enrollment.query",
            |frame| json!({"provider":frame["input"]["provider"],"enabled":true}),
        )
        .await;
        render(&mut app, 80, 24);
        act(&mut app, Command::Begin);
        rpc(&mut app, &client, &mut reader, &mut writer, "oauth.login.start", |frame|
            json!({"attemptId":frame["input"]["attemptId"],"connection":{"connectionId":"connection","slug":frame["input"]["target"]["slug"],"provider":frame["input"]["target"]["provider"]},"phase":"awaiting_authorization"})).await;
        write(&mut writer, json!({"kind":"client.capability.service_call","registrationId":service.registration_id,
            "invocationId":"presentation","serviceId":"oauth_presentation","version":"1","method":"open_external",
            "input":{"url":"https://login.example/device","stateHint":"CODE-1234"}})).await;
        assert_eq!(
            read(&mut reader).await["kind"],
            "client.capability.accepted"
        );
        write(
            &mut writer,
            json!({"kind":"client.capability.admitted","invocationId":"presentation"}),
        )
        .await;
        app.oauth_presentation(
            tokio::time::timeout(Duration::from_secs(2), service.recv())
                .await
                .unwrap()
                .unwrap(),
        );
        render(&mut app, 25, 8);
        assert!(
            app.management.oauth.presentation.is_some(),
            "an invisible code cannot be acknowledged"
        );
        let text = render(&mut app, 80, 24);
        assert!(text.contains("CODE-1234"));
        assert!(text.contains("https://login.example/device"));
        assert!(app.management.oauth.presentation.is_none());
        let presented = read(&mut reader).await;
        maka_protocol::capability::decode_client_frame(&presented).unwrap();
        assert_eq!(
            presented,
            json!({"kind":"client.capability.result","invocationId":"presentation","result":{"content":[],"structuredContent":{"kind":"presented"}}})
        );
        assert!(
            !app.management.oauth.terminal(),
            "presentation must not claim authentication"
        );
        write(
            &mut writer,
            json!({"kind":"client.capability.release","invocationId":"presentation"}),
        )
        .await;
        let attempt = app
            .management
            .oauth
            .attempt
            .as_ref()
            .unwrap()
            .attempt_id
            .clone();
        let authenticated = serde_json::to_value(login(&app, Phase::Authenticated)).unwrap();
        app.apply(Action::Manage(Manage::Close));
        app.management.oauth.next_poll = Some(Instant::now());
        rpc(
            &mut app,
            &client,
            &mut reader,
            &mut writer,
            "oauth.login.query",
            |frame| {
                assert_eq!(frame["input"], json!({"attemptId":attempt}));
                authenticated
            },
        )
        .await;
        assert!(app.management.oauth.terminal());
        assert!(app.management.dialog.is_none());
        assert!(app.management.oauth.display.is_none());
        assert!(app.oauth_wait().is_none());
        client.disconnect();
    }
}
