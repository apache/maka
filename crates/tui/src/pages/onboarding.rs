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

mod input;
mod view;
pub(crate) use view::{draw_field, sheet};

use crate::{
    app::{Action, App, ConnectionState},
    editor::Editor,
};
use maka_client::{Client, RequestFailure};
use maka_protocol::configuration::{ModelInfo, onboarding::*};
use std::collections::BTreeSet;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    Open,
    Close,
    Provider(usize),
    /// Focuses a setup field.
    Field(usize),
    Verify,
    Toggle(String),
    Save,
    Back,
}
impl Command {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Open => "onboard-title",
            Self::Close => "session-cancel",
            Self::Provider(_) => "onboard-provider",
            Self::Field(_) => "onboard-title",
            Self::Verify => "onboard-verify",
            Self::Toggle(_) => "onboard-models",
            Self::Save => "onboard-save",
            Self::Back => "onboard-back",
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ticket {
    generation: u64,
    root: String,
    epoch: String,
    save: bool,
}
pub struct Request {
    pub ticket: Ticket,
    input: OnboardingInput,
    models: Vec<String>,
}
pub enum ResultValue {
    Verified(OnboardingVerifyResult),
    Saved(OnboardingSaveResult),
}
pub async fn execute(client: &Client, request: Request) -> Result<ResultValue, RequestFailure> {
    if request.ticket.save {
        client
            .onboard_connection(request.input, request.models)
            .await
            .map(ResultValue::Saved)
    } else {
        client
            .verify_connection(request.input)
            .await
            .map(ResultValue::Verified)
    }
}
#[derive(Default)]
pub struct Onboarding {
    pub dialog: Option<Form>,
    pending: Option<Ticket>,
    sequence: u64,
}
impl Onboarding {
    pub fn invalidate_geometry(&mut self) {
        if let Some(form) = &mut self.dialog {
            form.visible = false;
            for field in &mut form.fields {
                field.invalidate_geometry();
            }
        }
    }
}
pub struct Form {
    ticket: Ticket,
    provider: usize,
    providers: Vec<maka_protocol::model_provider::Entry>,
    default_slug: String,
    fields: [Editor; 3],
    models: Option<Vec<ModelInfo>>,
    selected: BTreeSet<String>,
    pub visible: bool,
    blocked: bool,
    error: Option<&'static str>,
}
impl Form {
    fn input(&self) -> OnboardingInput {
        let provider = &self.providers[self.provider];
        let name = self.fields[0].text().trim();
        let slug = self.fields[2].text().trim();
        OnboardingInput {
            target: maka_protocol::oauth::Target::Create {
                provider: provider.identity.clone(),
                configuration: serde_json::from_str(self.fields[1].text())
                    .expect("reviewed configuration"),
                name: if name.is_empty() {
                    provider.descriptor.label.clone()
                } else {
                    name.into()
                },
                slug: if slug.is_empty() {
                    self.default_slug.clone()
                } else {
                    slug.into()
                },
            },
        }
    }
}
impl App {
    pub fn onboarding_enabled(&self, c: &Command) -> bool {
        let connected = matches!(self.connection, ConnectionState::Connected { .. });
        if *c == Command::Open {
            return connected
                && self.onboarding.pending.is_none()
                && self.onboarding.dialog.is_none()
                && self.management.dialog.is_none()
                && !self.interactions.visible
                && self.queue.edit.is_none();
        }
        if self.onboarding.dialog.is_some() && *c == Command::Close {
            return !self.onboarding.pending.as_ref().is_some_and(|p| p.save);
        }
        self.onboarding.pending.is_none() && self.onboarding_offered(c)
    }
    /// Whether the form offers `c`, before a request in flight is
    /// considered: its control (and the focus on it) stays while the service
    /// is asked, and using it then does nothing.
    pub(super) fn onboarding_offered(&self, c: &Command) -> bool {
        let Some(form) = &self.onboarding.dialog else {
            return false;
        };
        if *c == Command::Close {
            return !self.onboarding.pending.as_ref().is_some_and(|p| p.save);
        }
        let identity = matches!(&self.connection,ConnectionState::Connected{root_id,epoch} if *root_id==form.ticket.root && *epoch==form.ticket.epoch);
        if !form.visible || form.blocked || !identity || form.providers.is_empty() {
            return false;
        }
        match c {
            Command::Verify => {
                form.models.is_none()
                    && form.fields.iter().all(|field| field.error.is_none())
                    && serde_json::from_str::<serde_json::Value>(form.fields[1].text()).is_ok_and(
                        |value| {
                            maka_protocol::configuration::validation::provider_configuration(&value)
                                .is_ok()
                        },
                    )
                    && (form.fields[2].text().trim().is_empty()
                        || maka_protocol::configuration::validation::slug(
                            form.fields[2].text().trim(),
                        )
                        .is_ok())
            }
            Command::Save => form.models.is_some() && !form.selected.is_empty(),
            Command::Toggle(id) => form
                .models
                .as_ref()
                .is_some_and(|m| m.iter().any(|m| m.id == *id)),
            Command::Back => form.models.is_some(),
            Command::Field(index) => form.models.is_none() && *index < 3,
            Command::Provider(index) => form.models.is_none() && *index < form.providers.len(),
            _ => false,
        }
    }
    pub fn onboarding_action(&mut self, c: Command) -> Option<Action> {
        match c {
            Command::Open => {
                let ConnectionState::Connected { root_id, epoch } = &self.connection else {
                    return None;
                };
                self.onboarding.sequence += 1;
                self.onboarding.dialog = Some(Form {
                    ticket: Ticket {
                        generation: self.onboarding.sequence,
                        root: root_id.clone(),
                        epoch: epoch.clone(),
                        save: false,
                    },
                    provider: 0,
                    providers: Vec::new(),
                    default_slug: format!("connection-{}", uuid::Uuid::new_v4().simple()),
                    fields: [
                        Editor::bounded(128, "onboard-field-invalid"),
                        Editor::bounded(64 * 1024, "onboard-field-invalid"),
                        Editor::bounded(64, "onboard-field-invalid"),
                    ],
                    models: None,
                    selected: BTreeSet::new(),
                    visible: false,
                    blocked: false,
                    error: None,
                });
                self.onboarding_catalog_loaded();
                self.hover = None;
            }
            Command::Close => self.onboarding.dialog = None,
            Command::Verify | Command::Save => return Some(Action::Onboard(c)),
            _ => {
                let Some(f) = &mut self.onboarding.dialog else {
                    return None;
                };
                f.error = None;
                match c {
                    Command::Provider(index) => {
                        if index == f.provider {
                            return None;
                        }
                        f.provider = index;
                        f.fields[1] = Editor::bounded(64 * 1024, "onboard-field-invalid");
                        f.fields[1].insert(
                            &f.providers[f.provider]
                                .descriptor
                                .configuration_defaults
                                .to_string(),
                        );
                    }
                    Command::Field(index) => self.layer.focus_path(&view::row_path(index)),
                    Command::Toggle(id) => {
                        if !f.selected.contains(&id) && f.selected.len() >= 512 {
                            f.error = Some("onboard-model-limit");
                            return None;
                        }
                        if !f.selected.remove(&id) {
                            f.selected.insert(id.clone());
                        }
                    }
                    Command::Back => {
                        f.models = None;
                        f.selected.clear();
                    }
                    _ => {}
                }
            }
        }
        None
    }
    pub fn onboarding_catalog_loaded(&mut self) {
        let Some(form) = &mut self.onboarding.dialog else {
            return;
        };
        if !form.providers.is_empty() || form.blocked {
            return;
        }
        form.providers = self
            .providers
            .entries()
            .iter()
            .filter(|provider| provider.descriptor.anonymous)
            .cloned()
            .collect();
        if let Some(provider) = form.providers.first() {
            form.fields[1].insert(&provider.descriptor.configuration_defaults.to_string());
        }
    }
    pub fn onboarding_request(&mut self, save: bool) -> Option<Request> {
        if !self.onboarding_enabled(&if save { Command::Save } else { Command::Verify }) {
            return None;
        }
        let f = self.onboarding.dialog.as_mut()?;
        let mut ticket = f.ticket.clone();
        ticket.save = save;
        let request = Request {
            ticket: ticket.clone(),
            input: f.input(),
            models: f
                .models
                .iter()
                .flatten()
                .filter(|m| f.selected.contains(&m.id))
                .map(|m| m.id.clone())
                .collect(),
        };
        f.error = None;
        self.onboarding.pending = Some(ticket);
        Some(request)
    }
    pub fn onboarding_completed(
        &mut self,
        ticket: Ticket,
        result: Result<ResultValue, RequestFailure>,
    ) {
        if self.onboarding.pending.as_ref() != Some(&ticket) {
            return;
        }
        self.onboarding.pending = None;
        let identity = matches!(&self.connection,ConnectionState::Connected{root_id,epoch} if *root_id==ticket.root && *epoch==ticket.epoch);
        if !identity {
            return;
        }
        let Some(f) = self
            .onboarding
            .dialog
            .as_mut()
            .filter(|f| f.ticket.generation == ticket.generation)
        else {
            return;
        };
        match result {
            Ok(ResultValue::Verified(OnboardingVerifyResult::Verified { models })) => {
                f.models = Some(models);
                f.selected.clear();
                f.error = None;
            }
            Ok(ResultValue::Saved(OnboardingSaveResult::Saved { .. })) => {
                self.onboarding.dialog = None;
                self.models_catalog_changed();
                self.connections.refresh();
                self.chat.context.refresh();
            }
            Ok(ResultValue::Verified(OnboardingVerifyResult::Rejected { reason }))
            | Ok(ResultValue::Saved(OnboardingSaveResult::Rejected { reason })) => {
                f.error = Some(match reason {
                    OnboardingRejection::CredentialNotConfigured => {
                        "onboard-authentication-required"
                    }
                    OnboardingRejection::BaseUrlNotConfigured => "onboard-configuration-required",
                    OnboardingRejection::ProviderUnsupported => "onboard-unsupported",
                    OnboardingRejection::ModelUnavailable => "onboard-models-changed",
                    OnboardingRejection::CatalogFull => "onboard-catalog-full",
                    OnboardingRejection::Superseded => "onboard-conflict",
                    _ => "onboard-request-failed",
                });
            }
            Ok(ResultValue::Verified(OnboardingVerifyResult::Failed { error_class }))
            | Ok(ResultValue::Saved(OnboardingSaveResult::Failed { error_class })) => {
                use maka_protocol::configuration::ConnectionEffectFailureClass as E;
                f.error = Some(match error_class {
                    E::Auth => "onboard-auth-failed",
                    E::InvalidResponse => "onboard-response-failed",
                    _ => "onboard-network-failed",
                });
            }
            Err(RequestFailure::Unknown(_)) if ticket.save => {
                f.blocked = true;
                f.error = Some("onboard-unknown");
            }
            Err(RequestFailure::Rejected(maka_client::ClientError::Rejected(error)))
                if ticket.save
                    && error.code == maka_protocol::OperationErrorCode::CommitOutcomeUnknown =>
            {
                f.blocked = true;
                f.error = Some("onboard-unknown");
            }
            Err(_) => f.error = Some("onboard-request-failed"),
        }
    }
    pub fn abandon_onboarding(&mut self) {
        let uncertain = self.onboarding.pending.take().is_some_and(|p| p.save);
        if let Some(f) = &mut self.onboarding.dialog {
            f.blocked = true;
            f.error = Some(if uncertain {
                "onboard-unknown"
            } else {
                "onboard-disconnected"
            });
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
    use serde_json::json;

    #[test]
    fn anonymous_onboarding_isolates_async_steps_and_never_replays_unknown_saves() {
        let mut app = App::new(
            "/unused".into(),
            I18n::new(LocalePreference::Explicit(Locale::En), Locale::En),
        );
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "epoch".into(),
        };
        app.apply(Action::Onboard(Command::Open));
        let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
        terminal.draw(|f| crate::view::draw(f, &mut app)).unwrap();
        assert!(app.onboarding.dialog.is_some());
        assert!(app.onboarding_enabled(&Command::Close));
        assert!(!app.onboarding_enabled(&Command::Verify));
        assert!(app.onboarding_request(false).is_none());
        app.providers = crate::providers::fixtures::catalog();
        app.onboarding_catalog_loaded();
        terminal.draw(|f| crate::view::draw(f, &mut app)).unwrap();
        for (index, text) in [
            "Private fixture",
            r#"{"baseUrl":"http://127.0.0.1/v1"}"#,
            "fixture-connection",
        ]
        .into_iter()
        .enumerate()
        {
            app.apply(Action::Onboard(Command::Field(index)));
            app.input(Event::Key(KeyEvent::new(
                KeyCode::Char('a'),
                KeyModifiers::CONTROL,
            )));
            app.input(Event::Paste(text.into()));
        }
        app.providers.refresh();
        app.onboarding_catalog_loaded();
        app.providers = crate::providers::fixtures::catalog();
        app.onboarding_catalog_loaded();
        assert_eq!(
            app.onboarding.dialog.as_ref().unwrap().fields[1].text(),
            r#"{"baseUrl":"http://127.0.0.1/v1"}"#,
            "catalog refresh cannot replace an active form's provider or configuration"
        );
        for locale in Locale::ALL {
            app.i18n = I18n::new(LocalePreference::Explicit(locale), locale);
            for (width, height) in [(80, 24), (44, 22), (20, 8)] {
                let mut screen = Terminal::new(TestBackend::new(width, height)).unwrap();
                screen.draw(|f| crate::view::draw(f, &mut app)).unwrap();
                let text = screen
                    .backend()
                    .buffer()
                    .content
                    .iter()
                    .map(|c| c.symbol())
                    .collect::<String>();
                assert_eq!(app.onboarding_enabled(&Command::Verify), width >= 44);
                if width >= 44 {
                    assert!(text.contains("fixture-connection"));
                    assert!(
                        screen
                            .backend()
                            .buffer()
                            .content
                            .iter()
                            .rev()
                            .take(width as usize)
                            .all(|c| c.symbol() == " "),
                        "modal hides unrelated background footer hints"
                    );
                }
            }
        }
        terminal.draw(|f| crate::view::draw(f, &mut app)).unwrap();
        let request = app.onboarding_request(false).unwrap();
        let maka_protocol::oauth::Target::Create {
            provider,
            configuration,
            slug,
            ..
        } = &request.input.target
        else {
            panic!()
        };
        assert_eq!(
            *provider,
            crate::providers::fixtures::entry("openai-compatible", false).identity
        );
        assert_eq!(*configuration, json!({"baseUrl":"http://127.0.0.1/v1"}));
        assert_eq!(slug, "fixture-connection");
        app.input(Event::Paste("ignored while verifying".into()));
        assert!(!app.onboarding_enabled(&Command::Verify));
        app.input(Event::Mouse(MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 0,
            row: 0,
            modifiers: KeyModifiers::NONE,
        }));
        assert!(app.onboarding.dialog.is_none());
        assert!(
            !app.onboarding_enabled(&Command::Open),
            "closed verification occupies its slot until completion"
        );
        let model: ModelInfo = serde_json::from_value(json!({"id":"model"})).unwrap();
        app.onboarding_completed(
            request.ticket,
            Ok(ResultValue::Verified(OnboardingVerifyResult::Verified {
                models: vec![model.clone()],
            })),
        );
        assert!(
            app.onboarding.dialog.is_none(),
            "closed reply cannot reopen the modal"
        );
        app.apply(Action::Onboard(Command::Open));
        terminal.draw(|f| crate::view::draw(f, &mut app)).unwrap();
        for (index, text) in [
            (1, r#"{"baseUrl":"http://127.0.0.1/v1"}"#),
            (2, "new-connection"),
        ] {
            app.apply(Action::Onboard(Command::Field(index)));
            app.input(Event::Key(KeyEvent::new(
                KeyCode::Char('a'),
                KeyModifiers::CONTROL,
            )));
            app.input(Event::Paste(text.into()));
        }
        let request = app.onboarding_request(false).unwrap();
        app.onboarding_completed(
            request.ticket,
            Ok(ResultValue::Verified(OnboardingVerifyResult::Verified {
                models: vec![
                    model,
                    ModelInfo {
                        id: "z-model".into(),
                        ..Default::default()
                    },
                ],
            })),
        );
        terminal.draw(|f| crate::view::draw(f, &mut app)).unwrap();
        app.input(Event::Key(KeyEvent::new(KeyCode::End, KeyModifiers::NONE)));
        assert_eq!(app.layer.focused_path(), Some("list/rows/1"));
        app.input(Event::Mouse(MouseEvent {
            kind: MouseEventKind::ScrollUp,
            column: 0,
            row: 0,
            modifiers: KeyModifiers::NONE,
        }));
        assert_eq!(
            app.layer.focused_path(),
            Some("list/rows/1"),
            "wheel outside the modal cannot move its model list"
        );
        app.input(Event::Key(KeyEvent::new(KeyCode::Home, KeyModifiers::NONE)));
        assert!(
            !app.onboarding_enabled(&Command::Save),
            "no silent enable-all default"
        );
        let hit = app.layer.rect("list/rows/0").unwrap();
        app.input(Event::Mouse(MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: hit.x,
            row: hit.y,
            modifiers: KeyModifiers::NONE,
        }));
        assert!(app.onboarding_enabled(&Command::Save));
        terminal.draw(|f| crate::view::draw(f, &mut app)).unwrap();
        let save_y = app.layer.rect("footer/save").unwrap().y;
        assert!(
            save_y - hit.y < 10,
            "small model inventories keep a compact dialog"
        );
        app.apply(Action::Onboard(Command::Back));
        assert!(
            !app.onboarding_enabled(&Command::Save),
            "editing invalidates discovery"
        );
        let request = app.onboarding_request(false).unwrap();
        let model = serde_json::from_value(json!({"id":"model"})).unwrap();
        app.onboarding_completed(
            request.ticket,
            Ok(ResultValue::Verified(OnboardingVerifyResult::Verified {
                models: vec![model],
            })),
        );
        terminal.draw(|f| crate::view::draw(f, &mut app)).unwrap();
        app.input(Event::Key(KeyEvent::new(
            KeyCode::Char(' '),
            KeyModifiers::NONE,
        )));
        let save = app.onboarding_request(true).unwrap();
        assert_eq!(save.models, ["model"]);
        assert!(
            !app.onboarding_enabled(&Command::Close),
            "closing cannot masquerade as cancelling a save"
        );
        app.onboarding_completed(
            save.ticket,
            Err(RequestFailure::Rejected(
                maka_client::ClientError::Rejected(maka_protocol::OperationError {
                    code: maka_protocol::OperationErrorCode::CommitOutcomeUnknown,
                    message: "must not display new-secret".into(),
                }),
            )),
        );
        assert!(!app.onboarding_enabled(&Command::Save) && !app.onboarding_enabled(&Command::Back));
        terminal.draw(|f| crate::view::draw(f, &mut app)).unwrap();
        assert!(
            !terminal
                .backend()
                .buffer()
                .content
                .iter()
                .map(|c| c.symbol())
                .collect::<String>()
                .contains("new-secret")
        );
        app.abandon_onboarding();
        assert!(app.onboarding.dialog.as_ref().unwrap().blocked);
    }

    #[test]
    fn a_chooser_open_over_a_field_takes_the_click() {
        let mut app = App::new(
            "/unused".into(),
            I18n::new(LocalePreference::Explicit(Locale::En), Locale::En),
        );
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "epoch".into(),
        };
        app.providers = crate::providers::fixtures::catalog();
        app.apply(Action::Onboard(Command::Open));
        let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
        terminal.draw(|f| crate::view::draw(f, &mut app)).unwrap();
        app.layer.focus_path("form/provider");
        app.input(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::NONE,
        )));
        terminal.draw(|f| crate::view::draw(f, &mut app)).unwrap();
        assert!(app.layer.captures());
        // The chooser's first row lies over the configuration field.
        let owner = app.layer.rect("form/provider").unwrap();
        for kind in [
            MouseEventKind::Down(MouseButton::Left),
            MouseEventKind::Up(MouseButton::Left),
        ] {
            app.input(Event::Mouse(MouseEvent {
                kind,
                column: owner.right() - 3,
                row: owner.y + 2,
                modifiers: KeyModifiers::NONE,
            }));
        }
        assert!(!app.layer.captures(), "the choice was made");
        assert_eq!(app.layer.focused_path(), Some("form/provider"));
    }
}
