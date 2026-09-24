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

use super::Command;
use crate::{
    app::{Action, App},
    ui::{self, Node, On, Role, Sheet, Size, Tone},
    view::{form, safe},
};
use ratatui::Frame;
use unicode_width::UnicodeWidthStr;

/// The setup form's rows, one per field index.
const FORM: &str = "form";
const MODELS: &str = "list/rows";
const LABELS: [&str; 3] = ["onboard-name", "oauth-configuration", "oauth-slug"];

pub(super) fn row_path(index: usize) -> String {
    format!("{FORM}/{index}")
}

/// The setup row a focus path points into.
pub(super) fn row(path: &str) -> Option<usize> {
    path.strip_prefix(FORM)?.strip_prefix('/')?.parse().ok()
}

fn action(command: Command) -> Action {
    Action::Onboard(command)
}

fn label_width(app: &App) -> u16 {
    form::label_width(
        LABELS
            .iter()
            .chain(["onboard-provider"].iter())
            .map(|key| app.i18n.text(key).width()),
        app.frame_size.map_or(80, |(width, _)| width),
    )
}

/// Adding an anonymous connection: choose the provider and fill in the form,
/// Verify contacts the service, then choose its models and Save. Back (or
/// Esc) returns to the form from the models.
pub(crate) fn sheet(app: &App) -> Option<Sheet<Action>> {
    let f = app.onboarding.dialog.as_ref()?;
    let step = if f.models.is_some() {
        "models"
    } else if f.providers.is_empty() {
        "loading"
    } else {
        "setup"
    };
    let mut sheet = Sheet::new(
        format!("onboard:{}:{step}", f.ticket.generation),
        app.i18n.text("onboard-title"),
    );
    let error = f.error.or_else(|| f.fields.iter().find_map(|e| e.error));
    if let Some(models) = &f.models {
        let rows = models
            .iter()
            .enumerate()
            .map(|(index, model)| {
                let mark = if f.selected.contains(&model.id) {
                    app.chrome.symbol("✓", "x")
                } else {
                    " "
                };
                let name = model.display_name.as_deref().unwrap_or(&model.id);
                let label = if name == model.id {
                    safe(name)
                } else {
                    format!("{} · {}", safe(name), safe(&model.id))
                };
                let toggle = Command::Toggle(model.id.clone());
                Node::text(
                    index.to_string(),
                    vec![(format!("[{mark}] {label}"), Tone::Normal)],
                )
                .clip()
                .enabled(app.onboarding_offered(&toggle))
                .on(On::Activate(action(toggle)))
            })
            .collect();
        let height = app.frame_size.map_or(24, |(_, height)| height);
        sheet = sheet
            .text("heading", &app.i18n.text("onboard-models"), Tone::Normal)
            .body(
                Node::scroll("list", Node::column("rows", rows))
                    .size(Size::Upto(height.saturating_sub(14).max(3))),
            );
    } else {
        let provider = f.providers.get(f.provider);
        let choices = f
            .providers
            .iter()
            .enumerate()
            .map(|(index, provider)| ui::Choice {
                label: provider.descriptor.label.clone(),
                action: action(Command::Provider(index)),
            })
            .collect();
        let enabled = app.onboarding_offered(&Command::Provider(f.provider));
        let mut rows = vec![
            Node::row(
                "provider",
                vec![
                    Node::text(
                        "label",
                        vec![(app.i18n.text("onboard-provider"), Tone::Muted)],
                    )
                    .clip()
                    .size(Size::Fixed(label_width(app))),
                    Node::text(
                        "value",
                        vec![(
                            provider.map_or_else(
                                || app.i18n.text(availability(app)),
                                |provider| {
                                    format!(
                                        "{} {}",
                                        safe(&provider.descriptor.label),
                                        app.chrome.symbol("▾", "v")
                                    )
                                },
                            ),
                            if enabled { Tone::Accent } else { Tone::Subtle },
                        )],
                    )
                    .clip()
                    .size(Size::Fill),
                ],
            )
            .on(On::Choose {
                choices,
                current: Some(f.provider),
            })
            .enabled(enabled),
        ];
        rows.extend((0..LABELS.len()).map(|index| {
            Node::slot(index.to_string(), 1)
                .on(On::Activate(action(Command::Field(index))))
                .enabled(app.onboarding_offered(&Command::Field(index)))
        }));
        sheet = sheet.body(Node::column(FORM, rows));
    }
    let key = if f.providers.is_empty() {
        availability(app)
    } else if app.onboarding.pending.is_some() {
        "onboard-busy"
    } else {
        error.unwrap_or(if f.models.is_some() {
            "onboard-models-note"
        } else {
            "onboard-verify-note"
        })
    };
    sheet = sheet.text(
        "note",
        &app.i18n.text(key),
        if error.is_some() {
            Tone::Warning
        } else {
            Tone::Subtle
        },
    );
    let button = |sheet: Sheet<Action>, key, command: Command, role| {
        let enabled = app.onboarding_offered(&command);
        sheet.button(
            key,
            app.i18n.text(command.label()),
            role,
            action(command),
            enabled,
        )
    };
    let sheet = if f.models.is_some() {
        let sheet = sheet
            .aside(
                "back",
                app.i18n.text(Command::Back.label()),
                action(Command::Back),
                app.onboarding_offered(&Command::Back),
            )
            .back(action(Command::Back));
        let sheet = button(sheet, "cancel", Command::Close, Role::Normal);
        button(sheet, "save", Command::Save, Role::Primary).focus_node(format!("{MODELS}/0"))
    } else {
        let sheet = button(sheet, "cancel", Command::Close, Role::Normal);
        button(sheet, "verify", Command::Verify, Role::Primary).focus_node(row_path(0))
    };
    Some(sheet)
}

fn availability(app: &App) -> &'static str {
    if app.providers.loading() {
        "providers-loading"
    } else if app.providers.failed() {
        "providers-failed"
    } else {
        "onboard-no-providers"
    }
}

/// Paints the setup form's text rows over the drawn sheet.
pub(crate) fn draw_field(frame: &mut Frame<'_>, app: &mut App) {
    let width = label_width(app);
    let focused = app.layer.focused_path().and_then(row);
    let colors = app.theme.colors();
    let editable = app.onboarding_enabled(&Command::Field(0));
    let rows: Vec<_> = (0..LABELS.len())
        .map(|index| {
            app.layer
                .rect(&row_path(index))
                .filter(|rect| !rect.is_empty())
        })
        .collect();
    let labels: Vec<_> = LABELS.iter().map(|key| app.i18n.text(key)).collect();
    let Some(f) = app.onboarding.dialog.as_mut() else {
        return;
    };
    for (index, field) in f.fields.iter_mut().enumerate() {
        let Some(rect) = rows[index].filter(|_| f.models.is_none()) else {
            field.invalidate_geometry();
            continue;
        };
        let row = form::Row {
            label: &labels[index],
            focused: editable && focused == Some(index),
            masked: false,
            placeholder: None,
        };
        form::draw(frame, rect, width, row, field, colors);
    }
}
