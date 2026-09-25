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
pub use view::draw;

use crate::{
    app::{Action, App, ConnectionState, Focus},
    navigation::Route,
};
use maka_protocol::configuration::{
    ConnectionCatalogCursor as Cursor, ConnectionCatalogQueryInput as Query,
};
use serde_json::Value;
use std::{collections::VecDeque, sync::Arc};

const PAGE_SIZE: usize = 16;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    Select(String),
    Open(String),
    Refresh,
    Next,
    Previous,
}
impl Command {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Select(_) => "connection-select",
            Self::Open(_) => "connection-rename",
            Self::Refresh => "command-refresh",
            Self::Next => "sessions-next",
            Self::Previous => "sessions-previous",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub provider: maka_protocol::model_provider::Identity,
    pub configuration: Value,
    pub enabled: bool,
    pub enabled_models: u64,
    pub model_ids: Vec<String>,
    pub revision: u64,
    pub default_model: Option<String>,
}

/// A bounded overview, not a second model inventory or credential store.
#[derive(Default)]
pub struct Connections {
    pub surface: crate::ui::Surface<Action>,
    pub rows: Vec<Arc<Row>>,
    pub selected: Option<String>,
    pub loading: bool,
    pub error: bool,
    loaded: bool,
    requested: bool,
    restart: bool,
    revision: Option<u64>,
    start: u64,
    scan: u64,
    assembling: Vec<Arc<Row>>,
    partial: Option<Row>,
    next: Option<u64>,
    previous: VecDeque<u64>,
}
impl Connections {
    pub fn model_query(&self, id: &str) -> Option<Query> {
        self.ready().then_some(())?;
        let index = self.rows.iter().position(|row| row.id == id)?;
        Some(Query::Continue {
            revision: self.revision?,
            cursor: Cursor::Connection {
                connection_index: self.start as usize + index,
            },
        })
    }
    pub fn refresh(&mut self) {
        self.restart = true;
        self.requested = true;
    }
    pub fn ready(&self) -> bool {
        self.loaded && !self.loading && !self.requested && !self.error
    }
    pub fn can_next(&self) -> bool {
        self.ready() && self.next.is_some()
    }
    pub fn can_previous(&self) -> bool {
        self.ready() && !self.previous.is_empty()
    }
    fn change_page(&mut self, forward: bool) {
        let start = if forward {
            let Some(next) = self.next else { return };
            if self.previous.len() == 128 {
                self.previous.pop_front();
            }
            self.previous.push_back(self.start);
            next
        } else {
            let Some(previous) = self.previous.pop_back() else {
                return;
            };
            previous
        };
        self.start = start;
        self.scan = start;
        self.assembling.clear();
        self.partial = None;
        self.requested = true;
    }
    pub fn query(&mut self) -> Option<Query> {
        if self.loading || !self.requested {
            return None;
        }
        if std::mem::take(&mut self.restart) {
            self.start = 0;
            self.scan = 0;
            self.revision = None;
            self.next = None;
            self.previous.clear();
            self.assembling.clear();
            self.partial = None;
        }
        self.loading = true;
        self.requested = false;
        self.error = false;
        Some(match self.revision {
            Some(revision) => Query::Continue {
                revision,
                cursor: self.partial.as_ref().map_or(
                    Cursor::Connection {
                        connection_index: self.scan as usize,
                    },
                    |row| Cursor::EnabledModelId {
                        connection_index: self.scan as usize,
                        item_index: row.model_ids.len(),
                    },
                ),
            },
            None => Query::Start,
        })
    }
    pub fn complete(&mut self, result: Result<Value, String>) {
        self.loading = false;
        if self.restart {
            return; // Notification invalidated the in-flight read.
        }
        let Ok(page) = result else {
            self.error = true;
            self.assembling.clear();
            self.partial = None;
            return;
        };
        if page["kind"] == "revision_changed" {
            self.refresh();
            return;
        }
        self.revision = page["revision"].as_u64();
        let count = page["connectionCount"].as_u64().expect("checked count");
        for item in page["items"].as_array().expect("checked page") {
            if item["kind"] == "enabled_model_id" {
                let Some(row) = self.partial.as_mut().filter(|row| {
                    item["connectionIndex"] == self.scan && item["itemIndex"] == row.model_ids.len()
                }) else {
                    self.error = true;
                    self.assembling.clear();
                    self.partial = None;
                    return;
                };
                let id = item["modelId"].as_str().unwrap();
                if row.model_ids.iter().any(|model| model == id) {
                    self.error = true;
                    self.assembling.clear();
                    self.partial = None;
                    return;
                }
                row.model_ids.push(id.into());
                self.finish_row();
                if self.assembling.len() == PAGE_SIZE {
                    break;
                }
                continue;
            }
            if item["kind"] != "connection" {
                continue;
            }
            // Index continuity matters when skipping inventory: never silently omit a connection.
            if item["connectionIndex"] != self.scan || self.partial.is_some() {
                self.error = true;
                self.assembling.clear();
                self.partial = None;
                return;
            }
            let id = item["connectionId"].as_str().unwrap();
            self.partial = Some(Row {
                id: id.into(),
                name: item["name"].as_str().unwrap().into(),
                slug: item["slug"].as_str().unwrap().into(),
                provider: serde_json::from_value(item["provider"].clone())
                    .expect("validated provider identity"),
                configuration: item["configuration"].clone(),
                enabled: item["enabled"].as_bool().unwrap(),
                enabled_models: item["enabledModelIdCount"].as_u64().unwrap(),
                model_ids: vec![],
                revision: item["revision"].as_u64().unwrap(),
                default_model: (page["defaultTarget"]["connectionId"] == id)
                    .then(|| page["defaultTarget"]["modelId"].as_str().unwrap().into()),
            });
            self.finish_row();
            if self.assembling.len() == PAGE_SIZE {
                break;
            }
        }
        // The existing typed cursor supports seeking a known connection header
        // within this revision. Do not fetch/store all its discovery models.
        self.next = (self.scan < count).then_some(self.scan);
        if self.assembling.len() < PAGE_SIZE && self.next.is_some() {
            self.requested = true;
            return;
        }
        self.rows = std::mem::take(&mut self.assembling);
        if !self.loaded {
            self.selected = self.rows.first().map(|row| row.id.clone());
        } else if !self
            .rows
            .iter()
            .any(|row| Some(&row.id) == self.selected.as_ref())
        {
            self.selected = None;
        }
        self.loaded = true;
    }
    fn finish_row(&mut self) {
        if self
            .partial
            .as_ref()
            .is_some_and(|row| row.model_ids.len() as u64 == row.enabled_models)
        {
            self.assembling.push(Arc::new(self.partial.take().unwrap()));
            self.scan += 1;
        }
    }
}

impl App {
    pub fn connection_actions(&self) -> Vec<Action> {
        let mut actions = vec![Action::Onboard(super::onboarding::Command::Open)];
        actions.extend(self.default_model_action());
        if let Some(action) = self.rename_connection_action() {
            actions.push(action);
        }
        if self.connections.error {
            actions.push(Action::Connection(Command::Refresh));
        }
        if self.connections.can_previous() || self.connections.can_next() {
            actions.extend([Command::Previous, Command::Next].map(Action::Connection));
        }
        actions
    }
    pub fn connection_enabled(&self, command: &Command) -> bool {
        if self.navigation.current() != Route::Connections
            || !matches!(self.connection, ConnectionState::Connected { .. })
        {
            return false;
        }
        match command {
            Command::Select(id) | Command::Open(id) => {
                self.connections.rows.iter().any(|row| row.id == *id)
            }
            Command::Refresh => !self.connections.loading,
            Command::Next => self.connections.can_next(),
            Command::Previous => self.connections.can_previous(),
        }
    }
    pub fn connection_action(&mut self, command: Command) -> Option<Action> {
        match command {
            Command::Open(id) => {
                self.connections.selected = Some(id);
                let action = self.rename_connection_action()?;
                return self.apply(action);
            }
            Command::Select(id) => {
                self.connections.selected = Some(id);
                self.focus = Focus::List;
            }
            Command::Refresh => {
                self.connections.refresh();
                self.providers.refresh();
            }
            Command::Next => self.connections.change_page(true),
            Command::Previous => self.connections.change_page(false),
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Locale, LocalePreference, i18n::I18n};
    use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
    use serde_json::json;

    fn page(revision: u64, start: u64, end: u64, count: u64) -> Value {
        json!({"kind":"page","revision":revision,"connectionCount":count,
            "defaultTarget":{"connectionId":"id-0","modelId":"main"},
            "items":(start..end).flat_map(|index| [json!({
                "kind":"connection","connectionIndex":index,"connectionId":format!("id-{index}"),
                "slug":format!("slug-{index}"),"name":"Same name","provider":crate::providers::fixtures::entry("openai-compatible", false).identity,"configuration":{"baseUrl":"http://127.0.0.1/v1"},
                "enabled":index != 1,"enabledModelIdCount":1,"revision":1
            }), json!({"kind":"enabled_model_id","connectionIndex":index,"itemIndex":0,"modelId":"main"})]).collect::<Vec<_>>(),
            "nextCursor":{"part":"model","connectionIndex":end.saturating_sub(1),"itemIndex":0}
        })
    }

    #[test]
    fn connection_overview_skips_inventory_bounds_pages_and_preserves_nested_navigation() {
        let mut app = App::new(
            "/unused".into(),
            I18n::new(LocalePreference::Explicit(Locale::En), Locale::En),
        );
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "epoch".into(),
        };
        app.apply(Action::Visit(Route::Settings));
        app.apply(Action::Visit(Route::Connections));
        assert_eq!(app.focus, Focus::List);
        assert_eq!(
            app.navigation.current().section(),
            Route::Settings,
            "a nested page highlights its sidebar entry, not another one"
        );
        assert_eq!(app.connections.query(), Some(Query::Start));
        assert!(app.connections.query().is_none(), "one read at a time");
        let mut partial = page(7, 0, 1, 18);
        partial["items"][0]["enabledModelIdCount"] = json!(2);
        app.connections.complete(Ok(partial));
        assert_eq!(
            app.connections.query(),
            Some(Query::Continue {
                revision: 7,
                cursor: Cursor::EnabledModelId {
                    connection_index: 0,
                    item_index: 1
                }
            })
        );
        let mut remainder = page(7, 0, 0, 18);
        remainder["items"] = json!([{"kind":"enabled_model_id","connectionIndex":0,"itemIndex":1,"modelId":"second"}]);
        app.connections.complete(Ok(remainder));
        assert!(!app.connections.ready());
        assert_eq!(
            app.connections.query(),
            Some(Query::Continue {
                revision: 7,
                cursor: Cursor::Connection {
                    connection_index: 1
                }
            }),
            "skip all model payloads of the first connection"
        );
        app.connections.complete(Ok(page(7, 1, 18, 18)));
        assert_eq!(app.connections.rows.len(), PAGE_SIZE);
        assert_eq!(app.connections.rows[0].model_ids, ["main", "second"]);
        assert_eq!(
            app.connections.rows[0].default_model.as_deref(),
            Some("main")
        );
        assert!(!app.connections.rows[1].enabled);
        app.apply(Action::Connection(Command::Select("id-7".into())));
        app.apply(Action::Connection(Command::Next));
        assert_eq!(
            app.connections.query(),
            Some(Query::Continue {
                revision: 7,
                cursor: Cursor::Connection {
                    connection_index: 16
                }
            })
        );
        app.connections.complete(Ok(page(7, 16, 18, 18)));
        assert_eq!(app.connections.rows.len(), 2);
        assert!(
            app.connections.selected.is_none(),
            "never substitute a similarly named neighbour"
        );
        assert!(!app.connections.can_next());
        app.apply(Action::Connection(Command::Previous));
        assert_eq!(
            app.connections.query(),
            Some(Query::Continue {
                revision: 7,
                cursor: Cursor::Connection {
                    connection_index: 0
                }
            })
        );
        app.connections.refresh(); // Notification supersedes this in-flight read.
        app.connections.complete(Ok(page(7, 0, 16, 18)));
        assert_eq!(app.connections.query(), Some(Query::Start));
        app.connections.complete(Ok(page(8, 0, 2, 2)));
        assert!(!app.connections.can_previous());
        app.connections.refresh();
        app.connections.query().unwrap();
        app.connections
            .complete(Err("sensitive provider error".into()));
        assert!(
            app.connections.error && app.connections.query().is_none(),
            "no automatic retry loop"
        );
        app.apply(Action::Connection(Command::Refresh));
        app.connections.query().unwrap();
        app.connections.complete(Ok(page(8, 0, 2, 2)));
        app.apply(Action::Connection(Command::Select("id-1".into())));
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(80, 24)).unwrap();
        for locale in Locale::ALL {
            app.i18n = I18n::new(LocalePreference::Explicit(locale), Locale::En);
            for (width, height) in [(80, 24), (45, 15), (29, 9)] {
                terminal.backend_mut().resize(width, height);
                terminal
                    .resize(ratatui::layout::Rect::new(0, 0, width, height))
                    .unwrap();
                terminal
                    .draw(|frame| crate::view::draw(frame, &mut app))
                    .unwrap();
                assert!(app.i18n.diagnostics().is_empty());
                if width == 45 {
                    let screen = terminal
                        .backend()
                        .buffer()
                        .content
                        .iter()
                        .map(|cell| cell.symbol())
                        .collect::<String>();
                    assert!(
                        screen.contains("main"),
                        "default model has priority over technical identifiers"
                    );
                    // A CJK glyph occupies two cells; the trailing cell is blank.
                    let compact =
                        |s: &str| s.chars().filter(|c| !c.is_whitespace()).collect::<String>();
                    assert!(
                        compact(&screen).contains(&compact(
                            &app.i18n.format("connection-models", &[("count", "1")])
                        )),
                        "enabled count remains visible in a narrow directory: {screen}"
                    );
                }
                assert!(
                    !terminal
                        .backend()
                        .buffer()
                        .content
                        .iter()
                        .map(|c| c.symbol())
                        .collect::<String>()
                        .contains("sensitive")
                );
            }
        }
        // Scrolling reads the directory without selecting another connection.
        app.connections.refresh();
        assert_eq!(app.connections.query(), Some(Query::Start));
        app.connections.complete(Ok(page(9, 0, 16, 16)));
        app.apply(Action::Connection(Command::Select("id-0".into())));
        app.connections
            .surface
            .focus("connections/rows/id-0".into());
        terminal.backend_mut().resize(60, 15);
        terminal
            .resize(ratatui::layout::Rect::new(0, 0, 60, 15))
            .unwrap();
        terminal
            .draw(|frame| crate::view::draw(frame, &mut app))
            .unwrap();
        let first = app
            .connections
            .surface
            .rect("connections/rows/id-0")
            .unwrap();
        app.input(Event::Mouse(crossterm::event::MouseEvent {
            kind: crossterm::event::MouseEventKind::ScrollDown,
            column: first.x,
            row: first.y,
            modifiers: KeyModifiers::NONE,
        }));
        terminal
            .draw(|frame| crate::view::draw(frame, &mut app))
            .unwrap();
        assert_eq!(app.connections.selected.as_deref(), Some("id-0"));
        assert!(
            app.connections
                .surface
                .rect("connections/rows/id-0")
                .unwrap()
                .is_empty()
        );
        app.input(Event::Key(KeyEvent::new(KeyCode::End, KeyModifiers::NONE)));
        terminal
            .draw(|frame| crate::view::draw(frame, &mut app))
            .unwrap();
        assert_eq!(app.connections.selected.as_deref(), Some("id-15"));
        assert!(
            !app.connections
                .surface
                .rect("connections/rows/id-15")
                .unwrap()
                .is_empty()
        );
        app.connections.rows.retain(|row| row.id != "id-15");
        assert!(
            app.input(Event::Key(KeyEvent::new(
                KeyCode::Enter,
                KeyModifiers::NONE
            )))
            .1
            .is_none(),
            "stale geometry cannot open the connection that disappeared"
        );
        assert!(app.management.dialog.is_none());
        app.input(Event::Resize(60, 15));
        assert!(
            app.input(Event::Key(KeyEvent::new(
                KeyCode::Enter,
                KeyModifiers::NONE
            )))
            .1
            .is_none(),
            "before the next frame, Enter cannot fall through to the toolbar"
        );
        terminal
            .draw(|frame| crate::view::draw(frame, &mut app))
            .unwrap();
        app.input(Event::Key(KeyEvent::new(KeyCode::Home, KeyModifiers::NONE)));
        terminal
            .draw(|frame| crate::view::draw(frame, &mut app))
            .unwrap();
        app.input(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::NONE,
        )));
        assert_eq!(
            app.navigation.current(),
            Route::Connections,
            "a connection ID must not become a session ID"
        );
        app.apply(Action::Manage(super::super::manage::Command::Close));
        app.apply(Action::Back);
        assert_eq!(app.navigation.current(), Route::Settings);
        app.apply(Action::Forward);
        assert_eq!(app.navigation.current(), Route::Connections);
        assert_eq!(app.navigation.current().section(), Route::Settings);
        assert_eq!(
            app.connections.query(),
            Some(Query::Start),
            "returning re-reads authoritative configuration"
        );
        app.connections
            .complete(Ok(json!({"kind":"revision_changed"})));
        assert_eq!(app.connections.query(), Some(Query::Start));
        app.connections.complete(Ok(page(9, 0, 2, 2)));
        app.apply(Action::Connect);
        assert!(
            app.connections.rows.is_empty(),
            "another Host cannot inherit old summaries"
        );
    }
}
