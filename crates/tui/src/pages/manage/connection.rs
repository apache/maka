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

use super::{Command, Entity, Kind, Target, Ticket};
use crate::{
    app::{Action, App},
    pages::connections::Row,
};
use maka_client::{Client, ClientError, RequestFailure};
use maka_protocol::configuration::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Change {
    EnabledModels,
    ModelOverrides,
    FetchModels,
    Test,
    Configuration,
    Enable,
    Disable,
    Remove,
}
impl Change {
    pub fn label(self) -> &'static str {
        match self {
            Self::EnabledModels => "connection-enabled-models",
            Self::ModelOverrides => "connection-model-overrides",
            Self::FetchModels => "connection-models-fetch",
            Self::Test => "connection-test",
            Self::Configuration => "connection-configuration",
            Self::Enable => "connection-enable",
            Self::Disable => "connection-disable",
            Self::Remove => "connection-remove",
        }
    }
    pub fn note(self) -> &'static str {
        match self {
            Self::EnabledModels => "enabled-model-default-note",
            Self::ModelOverrides => "model-profile-note",
            Self::FetchModels => "connection-models-fetch-note",
            Self::Test => "connection-test-note",
            Self::Configuration => "connection-configuration-note",
            Self::Enable => "connection-enable-note",
            Self::Disable => "connection-disable-note",
            Self::Remove => "connection-remove-note",
        }
    }
}

pub(super) fn update(row: &Row, kind: Kind, name: &str) -> UpdateCatalogConnectionInput {
    UpdateCatalogConnectionInput {
        expected: basis(row),
        changes: ConnectionCatalogEntryUpdate {
            name: if kind == Kind::Rename {
                name.into()
            } else {
                row.name.clone()
            },
            configuration: if kind == Kind::Connection(Change::Configuration) {
                serde_json::from_str(name).expect("reviewed provider configuration")
            } else {
                row.configuration.clone()
            },
            enabled: match kind {
                Kind::Connection(Change::Enable) => true,
                Kind::Connection(Change::Disable) => false,
                _ => row.enabled,
            },
            enabled_model_ids: row.model_ids.clone(),
            model_overrides: Patch::Keep,
            request_body_overlay: Patch::Keep,
        },
    }
}
fn basis(row: &Row) -> ConnectionVersionBasis {
    ConnectionVersionBasis {
        connection_id: row.id.clone(),
        revision: row.revision,
    }
}

pub(super) async fn execute(
    client: &Client,
    ticket: &Ticket,
) -> Result<CatalogMutationResult, RequestFailure> {
    let Entity::Connection(row) = &ticket.target.entity else {
        return Err(RequestFailure::NotDispatched(ClientError::Protocol(
            "Invalid connection target".into(),
        )));
    };
    match ticket.kind {
        Kind::Connection(Change::Remove) => {
            client
                .remove_connection(RemoveCatalogConnectionInput {
                    expected: basis(row),
                })
                .await
        }
        Kind::Rename
        | Kind::Connection(
            Change::Configuration
            | Change::Enable
            | Change::Disable
            | Change::EnabledModels
            | Change::ModelOverrides,
        ) => {
            let mut input = update(row, ticket.kind, &ticket.text);
            if let Some(ids) = &ticket.enabled_model_ids {
                input.changes.enabled_model_ids = ids.clone();
            }
            if let Some(profiles) = &ticket.model_overrides {
                input.changes.model_overrides = Patch::Set(profiles.clone());
            }
            client.update_connection(input).await
        }
        _ => Err(RequestFailure::NotDispatched(ClientError::Protocol(
            "Invalid connection change".into(),
        ))),
    }
}

impl App {
    fn connection_provider_changes(&self, row: &super::super::connections::Row) -> Vec<Change> {
        let Some(provider) = self.providers.find(&row.provider).filter(|_| row.enabled) else {
            return vec![];
        };
        let mut changes = vec![];
        if provider.descriptor.discovery {
            changes.push(Change::FetchModels);
        }
        changes.push(Change::Test);
        changes
    }

    pub(crate) fn resolved_provider_commands(
        &self,
        action: &Action,
    ) -> Vec<(Action, &'static str)> {
        let Action::Manage(Command::Open(target, _)) = action else {
            return vec![];
        };
        let Entity::Connection(row) = &target.entity else {
            return vec![];
        };
        self.connection_provider_changes(row)
            .into_iter()
            .map(|change| {
                (
                    Action::Manage(Command::Open(target.clone(), Kind::Connection(change))),
                    change.label(),
                )
            })
            .collect()
    }

    pub(super) fn connection_management_commands(
        &self,
        root: &str,
        epoch: &str,
    ) -> Vec<(Action, &'static str)> {
        let Some(row) = self
            .connections
            .rows
            .iter()
            .find(|row| Some(&row.id) == self.connections.selected.as_ref())
        else {
            return vec![];
        };
        let target = Target {
            root: root.into(),
            epoch: epoch.into(),
            name: row.name.clone(),
            entity: Entity::Connection(row.clone()),
        };
        let mut kinds = vec![];
        kinds.push(Kind::Rename);
        kinds.push(Kind::Connection(Change::EnabledModels));
        kinds.push(Kind::Connection(Change::ModelOverrides));
        kinds.extend(
            self.connection_provider_changes(row)
                .into_iter()
                .map(Kind::Connection),
        );
        kinds.push(Kind::Credential(super::credentials::Change::Clear));
        kinds.push(Kind::Connection(Change::Configuration));
        kinds.push(Kind::Connection(if row.enabled {
            Change::Disable
        } else {
            Change::Enable
        }));
        kinds.push(Kind::Connection(Change::Remove));
        kinds
            .into_iter()
            .map(|kind| {
                (
                    Action::Manage(Command::Open(target.clone(), kind)),
                    kind.label(&target),
                )
            })
            .collect()
    }
    pub(super) fn connection_target_known(&self, target: &Target) -> bool {
        let Entity::Connection(row) = &target.entity else {
            return true;
        };
        self.connections
            .rows
            .iter()
            .any(|current| current.id == row.id)
    }
    pub fn rename_connection_action(&self) -> Option<Action> {
        self.management_commands()
            .into_iter()
            .map(|(action, _)| action)
            .find(|action| matches!(action, Action::Manage(Command::Open(_, Kind::Rename))))
    }
    pub(super) fn connection_acknowledged(
        &mut self,
        ticket: &Ticket,
        result: &CatalogMutationResult,
    ) {
        let Entity::Connection(basis) = &ticket.target.entity else {
            return;
        };
        let CatalogMutationResult::Committed { connection, .. } = result else {
            return;
        };
        if let Some(committed) = connection {
            if let Some(row) = self
                .connections
                .rows
                .iter_mut()
                .find(|row| row.id == basis.id)
            {
                // Apply only this acknowledged change. A newer catalog projection wins.
                if row.revision < committed.revision {
                    let mut changed = (**basis).clone();
                    let changes = update(&changed, ticket.kind, &ticket.text).changes;
                    changed.name = changes.name;
                    changed.configuration = changes.configuration;
                    changed.enabled = changes.enabled;
                    if let Some(ids) = &ticket.enabled_model_ids {
                        changed.model_ids = ids.clone();
                        changed.enabled_models = ids.len() as u64;
                        changed.default_model = changed.default_model.filter(|id| ids.contains(id));
                    }
                    changed.revision = committed.revision;
                    if !changed.enabled {
                        changed.default_model = None;
                    }
                    *row = std::sync::Arc::new(changed);
                }
            }
        } else {
            self.connections.rows.retain(|row| row.id != basis.id);
            if self.connections.selected.as_deref() == Some(&basis.id) {
                self.connections.selected = None;
            }
        }
    }
}

pub(super) fn configuration(row: &Row, text: &str) -> Result<String, &'static str> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|_| "connection-configuration-invalid")?;
    validation::provider_configuration(&value).map_err(|_| "connection-configuration-invalid")?;
    if value == row.configuration {
        return Err("connection-configuration-unchanged");
    }
    Ok(value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Locale, LocalePreference, app::ConnectionState, i18n::I18n, navigation::Route};
    use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
    use ratatui::{Terminal, backend::TestBackend};
    use serde_json::json;
    const ID: &str = "b746eb13-287c-4f3a-8590-dac93c0a1253";

    fn load(app: &mut App) {
        app.providers = crate::providers::fixtures::catalog();
        app.connections.refresh();
        app.connections.query().unwrap();
        app.connections.complete(Ok(json!({"kind":"page","revision":10,"connectionCount":1,
            "defaultTarget":null,"nextCursor":null,"items":[
            {"kind":"connection","connectionIndex":0,"connectionId":ID,"revision":7,"slug":"fixture","name":"Fixture",
                "provider":crate::providers::fixtures::entry("openai-compatible", false).identity,"configuration":{"baseUrl":"http://127.0.0.1/v1"},"enabled":true,"enabledModelIdCount":1},
            {"kind":"enabled_model_id","connectionIndex":0,"itemIndex":0,"modelId":"model"}
        ]})));
    }

    #[test]
    fn late_provider_capabilities_extend_the_palette_without_changing_its_captured_targets() {
        let mut app = App::new(
            "/unused".into(),
            I18n::new(LocalePreference::Explicit(Locale::En), Locale::En),
        );
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "epoch".into(),
        };
        app.apply(Action::Visit(Route::Connections));
        load(&mut app);
        let Action::Manage(Command::Open(target, _)) = app.rename_connection_action().unwrap()
        else {
            panic!("captured connection");
        };
        app.providers = Default::default();
        app.apply(Action::Palette);
        let frozen = app.commands();
        let mut terminal = Terminal::new(TestBackend::new(100, 30)).unwrap();
        terminal
            .draw(|frame| crate::view::draw(frame, &mut app))
            .unwrap();
        app.input(Event::Paste("Fetch models".into()));
        assert!(app.commands().is_empty());
        let generation = app.providers.query().unwrap();
        app.providers.complete(
            generation,
            Ok(maka_client::ProviderDirectory {
                revision: 1,
                entries: vec![crate::providers::fixtures::entry(
                    "openai-compatible",
                    false,
                )],
            }),
        );
        app.provider_commands_loaded();
        let fetch = Action::Manage(Command::Open(
            target.clone(),
            Kind::Connection(Change::FetchModels),
        ));
        assert_eq!(
            app.commands(),
            vec![(fetch.clone(), Change::FetchModels.label().into())]
        );
        app.provider_commands_loaded();
        assert_eq!(
            app.commands().len(),
            1,
            "repeated notices do not duplicate a command"
        );
        app.input(Event::Key(KeyEvent::new(
            KeyCode::Char('u'),
            KeyModifiers::CONTROL,
        )));
        assert_eq!(&app.commands()[..frozen.len()], frozen.as_slice());
        std::sync::Arc::make_mut(&mut app.connections.rows[0]).revision += 1;
        app.provider_commands_loaded();
        app.input(Event::Paste("Fetch models".into()));
        assert_eq!(
            app.commands(),
            vec![(fetch.clone(), Change::FetchModels.label().into())]
        );
    }

    #[test]
    fn configuration_review_preserves_provider_data_and_never_replays_uncertain_changes() {
        let mut app = App::new(
            "/unused".into(),
            I18n::new(LocalePreference::Explicit(Locale::En), Locale::En),
        );
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "epoch".into(),
        };
        app.apply(Action::Visit(Route::Connections));
        load(&mut app);
        let Action::Manage(Command::Open(target, _)) = app.rename_connection_action().unwrap()
        else {
            panic!()
        };
        let Entity::Connection(row) = &target.entity else {
            panic!()
        };
        for invalid in ["", "[]", "null", "https://example.org/v1"] {
            assert_eq!(
                configuration(row, invalid),
                Err("connection-configuration-invalid")
            );
        }
        assert_eq!(
            configuration(row, r#"{"baseUrl":"http://127.0.0.1/v1"}"#),
            Err("connection-configuration-unchanged")
        );
        app.apply(Action::Manage(Command::Open(
            target,
            Kind::Connection(Change::Configuration),
        )));
        let mut screen = Terminal::new(TestBackend::new(80, 24)).unwrap();
        screen.draw(|f| crate::view::draw(f, &mut app)).unwrap();
        let canonical = r#"{"region":"eu","tenant":"new"}"#;
        app.input(Event::Paste(canonical.into()));
        assert!(
            app.management_request().is_none(),
            "editing does not dispatch"
        );
        app.apply(Action::Manage(Command::Save));
        assert!(app.management.dialog.as_ref().unwrap().reviewing);
        for locale in Locale::ALL {
            app.i18n = I18n::new(LocalePreference::Explicit(locale), Locale::En);
            for (width, height) in [(80, 24), (25, 10)] {
                let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
                terminal.draw(|f| crate::view::draw(f, &mut app)).unwrap();
                assert_eq!(app.management_enabled(&Command::Save), width >= 45);
                if width >= 45 {
                    let compact = |s: &str| {
                        s.chars()
                            .filter(|c| !c.is_whitespace() && !"│─╭╮╰╯".contains(*c))
                            .collect::<String>()
                    };
                    let text: String = terminal
                        .backend()
                        .buffer()
                        .content
                        .iter()
                        .map(|c| c.symbol())
                        .collect();
                    assert!(compact(&text).contains(canonical));
                    assert!(
                        compact(&text)
                            .contains(&compact(&app.i18n.text(Change::Configuration.note())))
                    );
                }
                assert!(app.i18n.diagnostics().is_empty());
            }
        }
        screen.draw(|f| crate::view::draw(f, &mut app)).unwrap();
        app.input(Event::Paste("https://evil.example".into()));
        assert_eq!(
            app.management.dialog.as_ref().unwrap().editor.text(),
            canonical,
            "review is read-only"
        );
        app.input(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::NONE,
        )));
        assert!(app.management.dialog.is_none(), "review defaults to cancel");
        app.apply(
            app.management_commands()
                .into_iter()
                .find(|(_, key)| *key == "connection-configuration")
                .unwrap()
                .0,
        );
        screen.draw(|f| crate::view::draw(f, &mut app)).unwrap();
        let configuration = json!({"tenant":"x".repeat(4096),"zone":"visible-tail"}).to_string();
        app.input(Event::Paste(configuration.clone()));
        app.apply(Action::Manage(Command::Save));
        screen.draw(|f| crate::view::draw(f, &mut app)).unwrap();
        assert!(
            app.management_enabled(&Command::Save),
            "large configurations remain reviewable"
        );
        app.layer.focus("field");
        app.input(Event::Key(KeyEvent::new(
            KeyCode::End,
            KeyModifiers::CONTROL,
        )));
        app.input(Event::Key(KeyEvent::new(
            KeyCode::Delete,
            KeyModifiers::NONE,
        )));
        screen.draw(|f| crate::view::draw(f, &mut app)).unwrap();
        let displayed: String = screen
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect();
        assert!(displayed.contains("visible-tail"));
        let ticket = app.management_request().unwrap();
        assert_eq!(ticket.text, configuration);
        app.management_completed(ticket, Err(RequestFailure::Unknown(ClientError::Timeout)));
        assert!(!app.management_enabled(&Command::Edit));
        assert!(!app.management_enabled(&Command::Save));
        app.input(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        assert!(app.management.dialog.is_none());
        assert!(
            app.management_commands().is_empty(),
            "new authoritative read required after unknown write"
        );
    }

    #[test]
    fn connection_management_preserves_configuration_confirms_impact_and_blocks_uncertain_writes() {
        let mut app = App::new(
            "/unused".into(),
            I18n::new(LocalePreference::Explicit(Locale::En), Locale::En),
        );
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "epoch".into(),
        };
        app.apply(Action::Visit(Route::Connections));
        load(&mut app);
        let Action::Manage(Command::Open(target, _)) = app.rename_connection_action().unwrap()
        else {
            panic!()
        };
        let commands = app.management_commands();
        app.connections.refresh();
        assert_eq!(
            app.management_commands(),
            commands,
            "refreshing must not silently remove frozen menu entries"
        );
        assert!(
            app.management_enabled(&Command::Open(target.clone(), Kind::Rename)),
            "a complete confirmed row can open during refresh; the Host still enforces CAS"
        );
        load(&mut app);
        for change in [
            Change::Enable,
            Change::Disable,
            Change::Remove,
            Change::FetchModels,
        ] {
            app.apply(Action::Manage(Command::Open(
                target.clone(),
                Kind::Connection(change),
            )));
            for locale in Locale::ALL {
                app.i18n = I18n::new(LocalePreference::Explicit(locale), Locale::En);
                for (width, height) in [(80, 24), (45, 20), (30, 10)] {
                    let mut screen = Terminal::new(TestBackend::new(width, height)).unwrap();
                    screen.draw(|f| crate::view::draw(f, &mut app)).unwrap();
                    if width >= 45 {
                        let compact = |s: &str| {
                            s.chars()
                                .filter(|c| !c.is_whitespace() && !"│─╭╮╰╯".contains(*c))
                                .collect::<String>()
                        };
                        let text: String = screen
                            .backend()
                            .buffer()
                            .content
                            .iter()
                            .map(|c| c.symbol())
                            .collect();
                        assert!(
                            compact(&text).contains(&compact(&app.i18n.text(change.note()))),
                            "full impact note before enabling confirmation: {text}"
                        );
                        assert!(app.management_enabled(&Command::Save));
                    } else {
                        assert!(!app.management_enabled(&Command::Save));
                    }
                    assert!(app.i18n.diagnostics().is_empty());
                }
            }
            let mut screen = Terminal::new(TestBackend::new(80, 24)).unwrap();
            screen.draw(|f| crate::view::draw(f, &mut app)).unwrap();
            // The confirming button repeats the title; it is the lower copy.
            let label = app.i18n.text(change.label());
            let buffer = screen.backend().buffer();
            let save = (0..buffer.area.height)
                .rev()
                .find_map(|y| {
                    let (mut line, mut x) = (String::new(), 0);
                    while x < buffer.area.width {
                        let symbol = buffer[(x, y)].symbol();
                        line.push_str(symbol);
                        x += (unicode_width::UnicodeWidthStr::width(symbol) as u16).max(1);
                    }
                    line.find(&label).map(|byte| {
                        let x = unicode_width::UnicodeWidthStr::width(&line[..byte]) as u16;
                        ratatui::layout::Position::new(x, y)
                    })
                })
                .unwrap();
            let normal = screen.backend().buffer()[(save.x, save.y)].style();
            let hover = |x, y| {
                Event::Mouse(crossterm::event::MouseEvent {
                    kind: crossterm::event::MouseEventKind::Moved,
                    column: x,
                    row: y,
                    modifiers: KeyModifiers::NONE,
                })
            };
            assert!(app.input(hover(save.x, save.y)).0);
            assert!(app.management.pending.is_none(), "hover never submits");
            screen.draw(|f| crate::view::draw(f, &mut app)).unwrap();
            let highlighted = screen.backend().buffer()[(save.x, save.y)].style();
            assert_ne!(normal.bg, highlighted.bg);
            if change == Change::Remove {
                assert_eq!(normal.fg, Some(app.theme.colors().error));
                assert_eq!(highlighted.fg, normal.fg);
            }
            assert!(app.input(hover(0, 0)).0);
            assert!(app.hover.is_none(), "no hover leaks to the covered page");
            screen.draw(|f| crate::view::draw(f, &mut app)).unwrap();
            assert_eq!(screen.backend().buffer()[(save.x, save.y)].style(), normal);
            app.input(Event::Key(KeyEvent::new(
                KeyCode::Enter,
                KeyModifiers::NONE,
            )));
            assert!(
                app.management.dialog.is_none(),
                "lifecycle confirmation defaults to cancel"
            );
        }
        let Entity::Connection(row) = &target.entity else {
            panic!()
        };
        let renamed = update(row, Kind::Rename, "New name");
        assert_eq!(renamed.expected.revision, 7);
        assert_eq!(
            renamed.changes.configuration,
            json!({"baseUrl":"http://127.0.0.1/v1"})
        );
        assert_eq!(renamed.changes.enabled_model_ids, ["model"]);
        let wire = serde_json::to_value(renamed).unwrap();
        assert!(wire["changes"].get("modelOverrides").is_none());
        assert!(wire["changes"].get("requestBodyOverlay").is_none());
        assert!(
            !update(row, Kind::Connection(Change::Disable), "ignored")
                .changes
                .enabled
        );
        let mut screen = Terminal::new(TestBackend::new(80, 24)).unwrap();
        for failure in [
            RequestFailure::Unknown(ClientError::Timeout),
            RequestFailure::Rejected(ClientError::Rejected(maka_protocol::OperationError {
                code: maka_protocol::OperationErrorCode::CommitOutcomeUnknown,
                message: "opaque".into(),
            })),
        ] {
            app.apply(Action::Manage(Command::Open(target.clone(), Kind::Rename)));
            screen.draw(|f| crate::view::draw(f, &mut app)).unwrap();
            let ticket = app.management_request().unwrap();
            assert!(app.management_request().is_none());
            app.management_completed(ticket, Err(failure));
            assert!(!app.management_enabled(&Command::Save));
            app.apply(Action::Manage(Command::Close));
            assert!(!app.management_enabled(&Command::Open(target.clone(), Kind::Rename)));
            load(&mut app);
        }
        app.apply(Action::Manage(Command::Open(target.clone(), Kind::Rename)));
        screen.draw(|f| crate::view::draw(f, &mut app)).unwrap();
        let ticket = app.management_request().unwrap();
        app.management_completed(
            ticket,
            Ok(super::super::Updated::Catalog(
                CatalogMutationResult::ConnectionStale {
                    expected: basis(row),
                    actual: Some(ConnectionVersionBasis {
                        connection_id: ID.into(),
                        revision: 8,
                    }),
                },
            )),
        );
        assert!(!app.management_enabled(&Command::Save));
        assert_eq!(
            app.management.dialog.as_ref().unwrap().error,
            Some("connection-edit-conflict")
        );
        app.apply(Action::Manage(Command::Close));
        load(&mut app);
        app.apply(Action::Manage(Command::Open(
            target.clone(),
            Kind::Connection(Change::Remove),
        )));
        screen.draw(|f| crate::view::draw(f, &mut app)).unwrap();
        let ticket = app.management_request().unwrap();
        app.apply(Action::Manage(Command::Close));
        app.apply(Action::Visit(Route::Settings));
        app.management_completed(
            ticket,
            Ok(super::super::Updated::Catalog(
                CatalogMutationResult::Committed {
                    catalog_revision: 11,
                    connection: None,
                },
            )),
        );
        assert_eq!(
            app.navigation.current(),
            Route::Settings,
            "late acknowledgement never changes page"
        );
        assert!(app.management.dialog.is_none());
    }

    #[test]
    fn model_fetch_rechecks_authority_without_guessing_enabled_ids_or_replaying_unknown_writes() {
        use super::super::Updated;
        use maka_protocol::connection_effects::*;
        let mut app = App::new(
            "/unused".into(),
            I18n::new(LocalePreference::Explicit(Locale::En), Locale::En),
        );
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "epoch".into(),
        };
        app.apply(Action::Visit(Route::Connections));
        load(&mut app);
        let Action::Manage(Command::Open(target, _)) = app.rename_connection_action().unwrap()
        else {
            panic!()
        };
        let kind = Kind::Connection(Change::FetchModels);
        let mut screen = Terminal::new(TestBackend::new(80, 24)).unwrap();
        for (result, blocked, error) in [
            (
                ConnectionModelFetchResult::Failed {
                    error_class: ConnectionEffectFailureClass::Auth,
                },
                false,
                "connection-models-fetch-auth",
            ),
            (
                ConnectionModelFetchResult::Failed {
                    error_class: ConnectionEffectFailureClass::InvalidResponse,
                },
                false,
                "connection-models-fetch-invalid",
            ),
            (
                ConnectionModelFetchResult::Rejected {
                    reason: ConnectionEffectRejectionReason::CredentialNotConfigured,
                },
                true,
                "connection-models-fetch-key",
            ),
            (
                ConnectionModelFetchResult::Superseded {
                    changed: vec![ConnectionEffectChangedDomain::Credential],
                },
                true,
                "connection-models-fetch-changed",
            ),
        ] {
            app.apply(Action::Manage(Command::Open(target.clone(), kind)));
            screen.draw(|f| crate::view::draw(f, &mut app)).unwrap();
            let ticket = app.management_request().unwrap();
            assert!(app.management_request().is_none());
            app.management_completed(ticket, Ok(Updated::ModelFetch(result)));
            let dialog = app.management.dialog.as_ref().unwrap();
            assert_eq!(dialog.blocked, blocked);
            assert_eq!(dialog.error, Some(error));
            screen.draw(|f| crate::view::draw(f, &mut app)).unwrap();
            assert_eq!(
                app.layer.focused_path(),
                Some("footer/cancel"),
                "failure leaves focus on Cancel, not network replay"
            );
            app.apply(Action::Manage(Command::Close));
        }
        app.apply(Action::Manage(Command::Open(target.clone(), kind)));
        screen.draw(|f| crate::view::draw(f, &mut app)).unwrap();
        let ticket = app.management_request().unwrap();
        app.management_completed(
            ticket,
            Err(RequestFailure::Rejected(ClientError::Rejected(
                maka_protocol::OperationError {
                    code: maka_protocol::OperationErrorCode::OperationUnavailable,
                    message: "network configuration or OAuth detail must not be rendered".into(),
                },
            ))),
        );
        assert_eq!(
            app.management.dialog.as_ref().unwrap().error,
            Some("connection-models-fetch-not-ready")
        );
        assert!(!app.management_enabled(&Command::Save));
        app.apply(Action::Manage(Command::Close));
        for current_revision in [7, 9] {
            load(&mut app);
            app.apply(Action::Manage(Command::Open(target.clone(), kind)));
            screen.draw(|f| crate::view::draw(f, &mut app)).unwrap();
            let ticket = app.management_request().unwrap();
            std::sync::Arc::make_mut(&mut app.connections.rows[0]).revision = current_revision;
            app.apply(Action::Manage(Command::Close));
            app.apply(Action::Visit(Route::Settings));
            app.management_completed(
                ticket,
                Ok(Updated::ModelFetch(ConnectionModelFetchResult::Committed {
                    catalog_revision: 12,
                    connection: ConnectionVersionBasis {
                        connection_id: ID.into(),
                        revision: 8,
                    },
                    model_count: 5,
                    source: ModelDiscoverySource::Fetched,
                    fetched_at: 1,
                })),
            );
            assert_eq!(app.navigation.current(), Route::Settings);
            assert!(app.management.dialog.is_none());
            assert_eq!(
                app.connections.rows.len(),
                usize::from(current_revision > 8),
                "old basis removed, newer projection preserved"
            );
        }
        app.apply(Action::Visit(Route::Connections));
        load(&mut app);
        app.apply(Action::Manage(Command::Open(target.clone(), kind)));
        screen.draw(|f| crate::view::draw(f, &mut app)).unwrap();
        let ticket = app.management_request().unwrap();
        app.management_completed(ticket, Err(RequestFailure::Unknown(ClientError::Timeout)));
        assert!(!app.management_enabled(&Command::Save));
        app.apply(Action::Manage(Command::Close));
        assert!(!app.management_enabled(&Command::Open(target, kind)));
    }
    #[test]
    fn opening_uses_current_connection_but_never_rebases_an_existing_dialog() {
        let mut app = App::new(
            "/unused".into(),
            I18n::new(LocalePreference::Explicit(Locale::En), Locale::En),
        );
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "epoch".into(),
        };
        app.apply(Action::Visit(Route::Connections));
        load(&mut app);
        let action = app.rename_connection_action().unwrap();
        let current = std::sync::Arc::make_mut(&mut app.connections.rows[0]);
        current.revision = 8;
        current.name = "Updated".into();
        current.configuration = json!({"baseUrl":"https://updated.example/v1"});
        assert!(app.enabled(&action));
        app.apply(action.clone());
        let dialog = app.management.dialog.as_ref().unwrap();
        assert_eq!(dialog.target.name, "Updated");
        assert_eq!(dialog.editor.text(), "Updated");
        let Entity::Connection(row) = &dialog.target.entity else {
            panic!()
        };
        assert_eq!(row.revision, 8);
        assert_eq!(
            row.configuration,
            json!({"baseUrl":"https://updated.example/v1"})
        );

        // A later read must not silently authorize the edited form on a new basis.
        std::sync::Arc::make_mut(&mut app.connections.rows[0]).revision = 9;
        let mut screen = Terminal::new(TestBackend::new(80, 24)).unwrap();
        screen.draw(|f| crate::view::draw(f, &mut app)).unwrap();
        let ticket = app.management_request().unwrap();
        let Entity::Connection(row) = &ticket.target.entity else {
            panic!()
        };
        assert_eq!(row.revision, 8);
        app.management_completed(ticket, Err(RequestFailure::Unknown(ClientError::Timeout)));
        app.apply(Action::Manage(Command::Close));
        assert!(
            !app.enabled(&action),
            "unknown outcome needs an authoritative read"
        );

        load(&mut app);
        app.connections.rows.clear();
        assert!(
            !app.enabled(&action),
            "a removed connection cannot be opened"
        );
        load(&mut app);
        app.connection = ConnectionState::Connected {
            root_id: "another-root".into(),
            epoch: "epoch".into(),
        };
        assert!(
            !app.enabled(&action),
            "connection IDs never cross Host identity"
        );
    }
}
