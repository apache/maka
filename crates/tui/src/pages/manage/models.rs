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

mod catalog;
mod view;
use super::{Command as Manage, Target};
use crate::app::{Action, App};
use maka_protocol::configuration::ConnectionCatalogQueryInput;
use maka_protocol::session::ThinkingLevel;
use serde_json::Value;
pub(super) use view::sheet;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Choice {
    pub connection_id: String,
    pub slug: String,
    pub model: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    Select(Choice),
    ClearDefault,
    Refresh,
    Previous,
    Next,
    /// None follows the model's own default.
    Thinking(Option<ThinkingLevel>),
}
impl Command {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Select(_) => "session-model-change",
            Self::ClearDefault => "default-model-none",
            Self::Refresh => "command-refresh",
            Self::Previous => "sessions-previous",
            Self::Next => "sessions-next",
            Self::Thinking(_) => "session-thinking",
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    generation: u64,
    target: Target,
    pub query: ConnectionCatalogQueryInput,
}
pub(super) struct Models {
    generation: u64,
    pub catalog: catalog::Catalog,
    pub for_default: bool,
    pub clear_default: bool,
    pub thinking: Option<ThinkingLevel>,
}
impl Models {
    pub fn new(generation: u64, for_default: bool) -> Self {
        let mut catalog = catalog::Catalog::default();
        catalog.refresh();
        Self {
            generation,
            catalog,
            for_default,
            clear_default: false,
            thinking: None,
        }
    }
    pub fn selection(&self) -> Option<&catalog::Row> {
        self.catalog.selection()
    }
    pub fn can_submit(&self) -> bool {
        self.selection().is_some()
            || (self.for_default && self.clear_default && self.catalog.revision().is_some())
    }
    fn has_thinking(&self) -> bool {
        !self.for_default
            && self
                .selection()
                .is_some_and(|row| !row.thinking_levels.is_empty())
    }
    pub fn thinking_level(&self) -> Option<ThinkingLevel> {
        self.thinking.filter(|level| {
            !self.for_default
                && self
                    .selection()
                    .is_some_and(|row| row.thinking_levels.contains(level))
        })
    }
    fn refresh(&mut self) {
        if self.for_default {
            self.clear_default = false;
            self.catalog.selected = None;
        }
        self.catalog.refresh();
    }
}

impl App {
    pub fn default_model_action(&self) -> Option<Action> {
        let crate::app::ConnectionState::Connected { root_id, epoch } = &self.connection else {
            return None;
        };
        Some(Action::Manage(Manage::Open(
            Target {
                root: root_id.clone(),
                epoch: epoch.clone(),
                name: self.i18n.text("default-model-title"),
                entity: super::Entity::Defaults,
            },
            super::Kind::Model,
        )))
    }
    pub fn models_catalog_changed(&mut self) {
        if let Some(models) = self
            .management
            .dialog
            .as_mut()
            .and_then(|d| d.models.as_mut())
        {
            models.refresh();
        }
    }
    pub fn model_action(&self) -> Option<Action> {
        self.management_commands().into_iter().find_map(|(a, _)| {
            matches!(a, Action::Manage(Manage::Open(_, super::Kind::Model))).then_some(a)
        })
    }
    pub(super) fn models_enabled(&self, command: &Command) -> bool {
        let Some(dialog) = &self.management.dialog else {
            return false;
        };
        let Some(models) = &dialog.models else {
            return false;
        };
        if !dialog.visible
            || dialog.blocked
            || self.management.pending.is_some()
            || !self.management_identity(&dialog.target)
        {
            return false;
        }
        match command {
            Command::ClearDefault => models.for_default && models.catalog.revision().is_some(),
            Command::Select(choice) => models.catalog.rows.iter().any(|r| r.choice == *choice),
            Command::Refresh => !models.catalog.loading,
            Command::Previous => models.catalog.can_previous(),
            Command::Next => models.catalog.can_next(),
            Command::Thinking(level) => {
                models.has_thinking()
                    && level.is_none_or(|level| {
                        models
                            .selection()
                            .is_some_and(|row| row.thinking_levels.contains(&level))
                    })
            }
        }
    }
    pub(super) fn models_action(&mut self, command: Command) -> Option<Action> {
        let dialog = self.management.dialog.as_mut()?;
        let models = dialog.models.as_mut()?;
        match command {
            Command::Select(choice) => {
                models.clear_default = false;
                models.catalog.selected = Some(choice);
            }
            Command::ClearDefault => {
                models.clear_default = true;
                models.catalog.selected = None;
            }
            Command::Refresh => models.refresh(),
            Command::Previous => models.catalog.change_page(false),
            Command::Next => models.catalog.change_page(true),
            Command::Thinking(level) => models.thinking = level,
        }
        dialog.error = None;
        None
    }
    pub fn models_request(&mut self) -> Option<Request> {
        if self.management.models_pending.is_some() || self.management.pending.is_some() {
            return None;
        }
        let dialog = self.management.dialog.as_ref()?;
        if dialog.blocked || !self.management_identity(&dialog.target) {
            return None;
        }
        let dialog = self.management.dialog.as_mut()?;
        let models = dialog.models.as_mut()?;
        let request = Request {
            generation: models.generation,
            target: dialog.target.clone(),
            query: models.catalog.query()?,
        };
        self.management.models_pending = Some(request.clone());
        Some(request)
    }
    pub fn models_completed(&mut self, request: Request, result: Result<Value, String>) {
        if self.management.models_pending.as_ref() != Some(&request) {
            return;
        }
        self.management.models_pending = None;
        if !self.management_identity(&request.target) {
            return;
        }
        let Some(dialog) = self
            .management
            .dialog
            .as_mut()
            .filter(|d| d.target == request.target && !d.blocked)
        else {
            return;
        };
        let Some(models) = dialog
            .models
            .as_mut()
            .filter(|m| m.generation == request.generation)
        else {
            return;
        };
        if models.for_default
            && result
                .as_ref()
                .is_ok_and(|page| page["kind"] == "revision_changed")
        {
            models.clear_default = false;
            models.catalog.selected = None;
        }
        models.catalog.complete(result);
    }
}

pub(crate) fn thinking_key(level: Option<ThinkingLevel>) -> &'static str {
    match level {
        None => "thinking-default",
        Some(ThinkingLevel::Off) => "thinking-off",
        Some(ThinkingLevel::Minimal) => "thinking-minimal",
        Some(ThinkingLevel::Low) => "thinking-low",
        Some(ThinkingLevel::Medium) => "thinking-medium",
        Some(ThinkingLevel::High) => "thinking-high",
        Some(ThinkingLevel::Xhigh) => "thinking-xhigh",
        Some(ThinkingLevel::Max) => "thinking-max",
        Some(ThinkingLevel::Ultra) => "thinking-ultra",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        app::ConnectionState,
        i18n::{I18n, Locale, LocalePreference},
        pages::manage::{Entity, Kind},
    };
    use crossterm::event::{Event, KeyCode, KeyModifiers, MouseButton, MouseEventKind};
    use ratatui::{Terminal, backend::TestBackend};
    use serde_json::json;

    fn page(model: &str) -> Value {
        json!({"kind":"page","revision":7,"nextCursor":null,"items":[
            {"kind":"connection","connectionIndex":0,"connectionId":"connection","slug":"fixture","name":"Fixture","enabled":true},
            {"kind":"enabled_model_id","connectionIndex":0,"modelId":model},
            {"kind":"catalog_entry","connectionIndex":0,"entry":{"id":model,"canUseAsChatDefault":true}}
        ]})
    }
    /// Cells of each screen row; a wide glyph covers its neighbour.
    fn lines(terminal: &Terminal<TestBackend>) -> Vec<String> {
        let buffer = terminal.backend().buffer();
        (0..buffer.area.height)
            .map(|y| {
                let (mut line, mut x) = (String::new(), 0);
                while x < buffer.area.width {
                    let symbol = buffer[(x, y)].symbol();
                    line.push_str(symbol);
                    x += (unicode_width::UnicodeWidthStr::width(symbol) as u16).max(1);
                }
                line
            })
            .collect()
    }
    /// The first place `text` is drawn.
    fn locate(terminal: &Terminal<TestBackend>, text: &str) -> (u16, u16) {
        lines(terminal)
            .iter()
            .enumerate()
            .find_map(|(y, line)| {
                line.find(text).map(|byte| {
                    (
                        unicode_width::UnicodeWidthStr::width(&line[..byte]) as u16,
                        y as u16,
                    )
                })
            })
            .unwrap_or_else(|| panic!("{text:?} is not on screen"))
    }
    /// A list row whose text inside the sheet is exactly `name`.
    fn row(terminal: &Terminal<TestBackend>, name: &str) -> (u16, u16) {
        lines(terminal)
            .iter()
            .enumerate()
            .find_map(|(y, line)| {
                let inside = line.split('│').nth(1)?;
                (inside.trim() == name).then(|| {
                    let byte = line.find(name).unwrap();
                    (
                        unicode_width::UnicodeWidthStr::width(&line[..byte]) as u16,
                        y as u16,
                    )
                })
            })
            .unwrap_or_else(|| panic!("no row {name:?}"))
    }
    fn click(app: &mut App, (x, y): (u16, u16)) {
        app.input(Event::Mouse(crossterm::event::MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: x,
            row: y,
            modifiers: KeyModifiers::NONE,
        }));
    }
    fn key(app: &mut App, code: KeyCode) {
        app.input(Event::Key(crossterm::event::KeyEvent::new(
            code,
            KeyModifiers::NONE,
        )));
    }
    fn level(app: &App) -> Option<ThinkingLevel> {
        app.management
            .dialog
            .as_ref()
            .unwrap()
            .models
            .as_ref()
            .unwrap()
            .thinking_level()
    }
    #[test]
    fn thinking_uses_current_catalog_levels_and_rechecks_before_submission() {
        for locale in Locale::ALL {
            let mut app = App::new(
                "/unused".into(),
                I18n::new(LocalePreference::Explicit(locale), locale),
            );
            app.connection = ConnectionState::Connected {
                root_id: "root".into(),
                epoch: "epoch".into(),
            };
            let target = Target {
                root: "root".into(),
                epoch: "epoch".into(),
                name: "Session".into(),
                entity: Entity::Session {
                    id: "session".into(),
                    revision: 7,
                    workspace: "/work".into(),
                    project_bound: false,
                },
            };
            app.apply(Action::Manage(Manage::Open(target, Kind::Model)));
            let mut data = page("model");
            data["items"][2]["entry"]["thinkingLevels"] = json!(["low", "high"]);
            let request = app.models_request().unwrap();
            app.models_completed(request, Ok(data.clone()));
            let models = app
                .management
                .dialog
                .as_mut()
                .unwrap()
                .models
                .as_mut()
                .unwrap();
            models.thinking = Some(ThinkingLevel::Low);
            let choice = models.catalog.rows[0].choice.clone();
            let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
            terminal.draw(|f| crate::view::draw(f, &mut app)).unwrap();
            app.apply(Action::Manage(Manage::Models(Command::Select(choice))));
            let label = app.i18n.text("session-thinking");
            let high = app.i18n.text("thinking-high");
            for (width, height) in [(48, 22), (80, 24), (120, 40)] {
                let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
                terminal.draw(|f| crate::view::draw(f, &mut app)).unwrap();
                // The level is a chooser of what this model supports.
                click(&mut app, locate(&terminal, &label));
                terminal.draw(|f| crate::view::draw(f, &mut app)).unwrap();
                click(&mut app, locate(&terminal, &high));
                assert_eq!(level(&app), Some(ThinkingLevel::High));
                terminal.draw(|f| crate::view::draw(f, &mut app)).unwrap();
                // The keyboard opens it on the current level and moves from there.
                key(&mut app, KeyCode::Enter);
                key(&mut app, KeyCode::Up);
                key(&mut app, KeyCode::Enter);
                assert_eq!(level(&app), Some(ThinkingLevel::Low));
                terminal.draw(|f| crate::view::draw(f, &mut app)).unwrap();
                key(&mut app, KeyCode::Enter);
                key(&mut app, KeyCode::Up);
                key(&mut app, KeyCode::Enter);
                assert_eq!(level(&app), None, "the model's own default");
                terminal.draw(|f| crate::view::draw(f, &mut app)).unwrap();
                key(&mut app, KeyCode::Enter);
                key(&mut app, KeyCode::Down);
                key(&mut app, KeyCode::Enter);
                assert_eq!(level(&app), Some(ThinkingLevel::Low));
            }
            // A catalog update withdraws the old levels and must not submit an obsolete one.
            app.models_catalog_changed();
            assert!(!app.models_enabled(&Command::Thinking(Some(ThinkingLevel::Low))));
            assert!(!app.management_enabled(&Manage::Save));
            data["items"][2]["entry"]["thinkingLevels"] = json!(["high"]);
            let request = app.models_request().unwrap();
            app.models_completed(request, Ok(data));
            let models = app
                .management
                .dialog
                .as_ref()
                .unwrap()
                .models
                .as_ref()
                .unwrap();
            assert_eq!(models.thinking, Some(ThinkingLevel::Low));
            assert_eq!(models.thinking_level(), None);
            let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
            terminal.draw(|f| crate::view::draw(f, &mut app)).unwrap();
            assert!(
                lines(&terminal)
                    .iter()
                    .any(|line| line.contains(&app.i18n.text("thinking-default"))),
                "an unsupported level shows the model's default, not the stale choice"
            );
            let ticket = app.management_request().unwrap();
            assert_eq!(ticket.thinking_level, None);
            assert_eq!(ticket.model.unwrap().model, "model");
        }
        let mut defaults = Models::new(1, true);
        defaults.catalog.query().unwrap();
        let mut data = page("model");
        data["items"][2]["entry"]["thinkingLevels"] = json!(["high"]);
        defaults.catalog.complete(Ok(data));
        defaults.catalog.selected = defaults.catalog.rows.first().map(|row| row.choice.clone());
        defaults.thinking = Some(ThinkingLevel::High);
        assert!(!defaults.has_thinking());
        assert_eq!(defaults.thinking_level(), None);
    }
    #[test]
    fn default_model_requires_explicit_fresh_intent_and_preserves_unknown_write_guard() {
        let mut app = App::new(
            "/unused".into(),
            I18n::new(LocalePreference::Explicit(Locale::En), Locale::En),
        );
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "epoch".into(),
        };
        app.apply(app.default_model_action().unwrap());
        let request = app.models_request().unwrap();
        app.models_completed(request, Ok(page("model")));
        let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
        terminal.draw(|f| crate::view::draw(f, &mut app)).unwrap();
        assert!(
            !app.management_enabled(&Manage::Save),
            "neither no-default nor first row is implicit"
        );
        app.apply(Action::Manage(Manage::Models(Command::ClearDefault)));
        for locale in Locale::ALL {
            app.i18n = I18n::new(LocalePreference::Explicit(locale), Locale::En);
            for (width, height) in [(80, 24), (42, 17), (20, 8)] {
                let mut screen = Terminal::new(TestBackend::new(width, height)).unwrap();
                screen.draw(|f| crate::view::draw(f, &mut app)).unwrap();
                assert_eq!(app.management_enabled(&Manage::Save), width >= 42);
            }
        }
        terminal.draw(|f| crate::view::draw(f, &mut app)).unwrap();
        app.models_catalog_changed();
        let request = app.models_request().unwrap();
        app.models_completed(request, Ok(page("model")));
        assert!(
            !app.management_enabled(&Manage::Save),
            "configuration notification withdraws clear intent"
        );
        terminal.draw(|f| crate::view::draw(f, &mut app)).unwrap();
        key(&mut app, KeyCode::Down);
        assert!(app.management_enabled(&Manage::Save));
        app.models_catalog_changed();
        let request = app.models_request().unwrap();
        app.models_completed(request, Ok(page("model")));
        assert!(
            !app.management_enabled(&Manage::Save),
            "same model identity cannot silently retain old default intent"
        );
        terminal.draw(|f| crate::view::draw(f, &mut app)).unwrap();
        let none = app.i18n.text("default-model-none");
        click(&mut app, locate(&terminal, &none));
        let ticket = app.management_request().unwrap();
        assert!(ticket.target.is_default_model());
        assert_eq!(ticket.catalog_revision, Some(7));
        assert!(ticket.model.is_none());
        app.management_completed(
            ticket,
            Err(maka_client::RequestFailure::Unknown(
                maka_client::ClientError::Timeout,
            )),
        );
        app.models_catalog_changed();
        assert!(app.models_request().is_none());
        assert!(!app.management_enabled(&Manage::Save));
        app.apply(Action::Manage(Manage::Close));
        app.apply(app.default_model_action().unwrap());
        assert!(
            app.models_request().is_some(),
            "reopening requires an authoritative read"
        );
    }
    #[test]
    fn model_dialog_binds_generation_target_and_fresh_mouse_intent() {
        let mut app = App::new(
            "/unused".into(),
            I18n::new(LocalePreference::Explicit(Locale::En), Locale::En),
        );
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "epoch".into(),
        };
        let target = Target {
            root: "root".into(),
            epoch: "epoch".into(),
            name: "Session".into(),
            entity: Entity::Session {
                id: "session".into(),
                revision: 7,
                workspace: "/work".into(),
                project_bound: false,
            },
        };
        let open = Action::Manage(Manage::Open(target.clone(), Kind::Model));
        app.apply(open.clone());
        let old = app.models_request().unwrap();
        app.apply(Action::Manage(Manage::Close));
        let mut observed = crate::pages::sessions::tests::item("session");
        observed.revision = 7;
        app.sessions.detail = crate::pages::sessions::Detail::Ready(Box::new(observed.clone()));
        observed.revision = 8;
        app.sessions.items = vec![observed];
        app.apply(open);
        let target = app.management.dialog.as_ref().unwrap().target.clone();
        assert!(matches!(target.entity, Entity::Session { revision: 8, .. }));
        app.sessions.items[0].revision = 9; // An open review keeps its captured basis.
        assert!(app.models_request().is_none());
        app.models_completed(old, Ok(page("old")));
        let request = app.models_request().unwrap();
        app.models_completed(request, Ok(page("model")));
        let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
        terminal.draw(|f| crate::view::draw(f, &mut app)).unwrap();
        assert!(
            app.management_request().is_none(),
            "no implicit first choice"
        );
        app.models_catalog_changed();
        let request = app.models_request().unwrap();
        terminal.draw(|f| crate::view::draw(f, &mut app)).unwrap();
        let choice = Choice {
            connection_id: "connection".into(),
            slug: "fixture".into(),
            model: "model".into(),
        };
        click(&mut app, row(&terminal, "model"));
        assert_eq!(
            app.management
                .dialog
                .as_ref()
                .unwrap()
                .models
                .as_ref()
                .unwrap()
                .catalog
                .selected,
            Some(choice)
        );
        assert!(!app.management_enabled(&Manage::Save));
        app.models_completed(request, Ok(page("model")));
        assert!(
            app.management_enabled(&Manage::Save),
            "local click survives refresh of the same identity"
        );
        for locale in Locale::ALL {
            app.i18n = I18n::new(LocalePreference::Explicit(locale), Locale::En);
            for (width, height) in [(80, 24), (42, 17), (20, 8)] {
                let mut screen = Terminal::new(TestBackend::new(width, height)).unwrap();
                screen.draw(|f| crate::view::draw(f, &mut app)).unwrap();
                assert_eq!(app.management_enabled(&Manage::Save), width >= 42);
            }
        }
        terminal.draw(|f| crate::view::draw(f, &mut app)).unwrap();
        app.models_catalog_changed();
        let request = app.models_request().unwrap();
        app.models_completed(request, Ok(page("replacement")));
        assert!(
            !app.management_enabled(&Manage::Save),
            "removed choice cannot silently select its neighbour"
        );
        terminal.draw(|f| crate::view::draw(f, &mut app)).unwrap();
        key(&mut app, KeyCode::Down);
        let ticket = app.management_request().unwrap();
        assert_eq!(ticket.target, target);
        assert_eq!(ticket.model.as_ref().unwrap().model, "replacement");
        assert!(app.management_request().is_none());
        app.management_completed(
            ticket,
            Err(maka_client::RequestFailure::Unknown(
                maka_client::ClientError::Timeout,
            )),
        );
        app.models_catalog_changed();
        assert!(app.models_request().is_none());
        assert!(
            !app.management_enabled(&Manage::Save),
            "unknown writes never become replayable after refresh"
        );
    }
}
