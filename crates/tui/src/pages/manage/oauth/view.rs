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

use super::{Command, Manage, State};
use crate::{
    app::{Action, App},
    ui::{self, Node, On, Role, Sheet, Size, Tone},
    view::{safe, tone},
};
use maka_protocol::oauth::Phase;
use ratatui::{Frame, layout::Rect, style::Style, widgets::Paragraph};
use unicode_width::UnicodeWidthStr;

/// The connection details rows, one per field index.
const ROWS: &str = "identity/rows";

fn action(command: Command) -> Action {
    Action::Manage(Manage::Oauth(command))
}

/// The connection details row a focus path points into.
pub(super) fn row(path: &str) -> Option<usize> {
    path.strip_prefix(ROWS)?.strip_prefix('/')?.parse().ok()
}

pub(super) fn row_path(index: usize) -> String {
    format!("{ROWS}/{index}")
}

fn label(app: &App, state: &State, index: usize) -> String {
    let mut label = app.i18n.text(Command::Field(index).label());
    if index == 3
        && let Some(field) = state.identity.authentication_field()
    {
        label.push_str(&format!(" · {}", safe(field)));
    }
    label
}

/// One label column for the provider and every shown field, so the form
/// reads as a single aligned column.
fn label_width(app: &App) -> u16 {
    let state = &app.management.oauth;
    let width = ui::content_width(app.frame_size.map_or(80, |(width, _)| width));
    let widest = state
        .fields()
        .filter(|_| state.identity.expanded)
        .map(|index| label(app, state, index).width())
        .chain([app.i18n.text("onboard-provider").width()])
        .max()
        .unwrap_or(0) as u16;
    (widest + 2).min(width * 2 / 5)
}

/// Signing in: choose a provider and method (and, optionally, how the
/// connection is named), follow the authorization it presents, then see the
/// outcome. Every step opens on Close, so Enter alone never starts or cancels
/// a sign-in; closing only hides an attempt, which keeps running.
pub(in crate::pages::manage) fn sheet(app: &App) -> Sheet<Action> {
    let state = &app.management.oauth;
    let step = if state.terminal() || state.not_found {
        "done"
    } else if state.attempt.is_some() {
        "attempt"
    } else {
        "choose"
    };
    let mut sheet = Sheet::new(
        format!("oauth:{}:{step}", state.generation),
        app.i18n.text("oauth-title"),
    );
    let mut about = vec![];
    if state.attempt.is_some() {
        about.push(Node::text(
            "provider",
            vec![(safe(&state.provider_name()), Tone::Normal)],
        ));
    }
    if !state.connection_label.is_empty() {
        about.push(Node::text(
            "connection",
            vec![(safe(&state.connection_label), Tone::Subtle)],
        ));
    }
    if state.attempt.is_none() && !state.choices.is_empty() {
        about.push(provider(app, state));
    }
    if !about.is_empty() {
        sheet = sheet.body(Node::column("about", about));
    }
    if state.customizable() {
        sheet = sheet.body(identity(app, state));
    }
    let phase = state.projection.as_ref().map(|projection| projection.phase);
    let warning = state.error.is_some()
        || (state.customizable() && state.identity.error().is_some())
        || matches!(phase, Some(Phase::Failed { .. }));
    sheet = sheet.text(
        "note",
        &app.i18n.text(state.status()),
        if warning { Tone::Warning } else { Tone::Subtle },
    );
    if let Some((url, code)) = &state.display {
        sheet = sheet.body(authorization(app, url, code.as_deref()));
    }
    if step == "attempt" {
        sheet = sheet.text("hide", &app.i18n.text("oauth-hide-note"), Tone::Subtle);
    }
    sheet = sheet.button(
        "close",
        app.i18n.text("oauth-close"),
        Role::Normal,
        Action::Manage(Manage::Close),
        true,
    );
    let button = |sheet: Sheet<Action>, key, command: Command, role| {
        sheet.button(
            key,
            app.i18n.text(command.label()),
            role,
            action(command),
            app.oauth_enabled(command),
        )
    };
    sheet = match step {
        "done" => button(sheet, "new", Command::New, Role::Primary),
        "attempt" => button(
            button(sheet, "check", Command::Check, Role::Normal),
            "cancel",
            Command::Cancel,
            Role::Normal,
        ),
        _ if state.error.is_some() => button(
            button(sheet, "check", Command::Check, Role::Normal),
            "begin",
            Command::Begin,
            Role::Primary,
        ),
        _ => button(sheet, "begin", Command::Begin, Role::Primary),
    };
    sheet.focus("close")
}

/// The provider and method, chosen from a pop-up of every one offered.
fn provider(app: &App, state: &State) -> Node<Action> {
    let enabled = app.oauth_enabled(Command::Provider(state.provider));
    let choices = state
        .choices
        .iter()
        .enumerate()
        .map(|(index, choice)| ui::Choice {
            label: choice.label(),
            action: action(Command::Provider(index)),
        })
        .collect();
    Node::row(
        "choice",
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
                    format!(
                        "{} {}",
                        safe(&state.provider_name()),
                        app.chrome.symbol("▾", "v")
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
        current: Some(state.provider),
    })
    .enabled(enabled)
}

/// A disclosure of the connection's name, ID, configuration and
/// authentication input; its rows are fields drawn by `draw`.
fn identity(app: &App, state: &State) -> Node<Action> {
    let expanded = state.identity.expanded;
    let mut children = vec![
        Node::text(
            "toggle",
            vec![(
                format!(
                    "{} {}",
                    if expanded {
                        app.chrome.symbol("▾", "v")
                    } else {
                        app.chrome.symbol("▸", ">")
                    },
                    app.i18n.text("oauth-identity")
                ),
                Tone::Normal,
            )],
        )
        .on(On::Activate(action(Command::Identity)))
        .enabled(app.oauth_enabled(Command::Identity)),
    ];
    if expanded {
        children.push(Node::column(
            "rows",
            state
                .fields()
                .map(|index| {
                    Node::slot(index.to_string(), 1)
                        .on(On::Activate(action(Command::Field(index))))
                        .enabled(app.oauth_enabled(Command::Field(index)))
                })
                .collect(),
        ));
    }
    Node::column("identity", children)
}

/// What the provider asks the user to open and enter, with ways to copy
/// both. A long link scrolls within a few rows; copying takes all of it.
fn authorization(app: &App, url: &str, code: Option<&str>) -> Node<Action> {
    let copy = |key, command: Command| {
        Node::button(key, app.i18n.text(command.label()), Role::Normal)
            .on(On::Activate(action(command)))
            .enabled(app.oauth_enabled(command))
    };
    let mut children = vec![
        Node::scroll("link", Node::text("url", vec![(safe(url), Tone::Accent)]))
            .size(Size::Upto(3)),
    ];
    let mut buttons = vec![copy("link", Command::CopyLink)];
    if let Some(code) = code {
        children.push(Node::text("code", vec![(safe(code), Tone::Primary)]));
        buttons.push(copy("code", Command::CopyCode));
    }
    children.push(Node::row("copy", buttons).gap(2));
    Node::column("authorization", children)
}

/// Paints the connection details rows: a label, then the editor (the
/// authentication input masked), or the provider default when empty.
pub(in crate::pages::manage) fn draw(frame: &mut Frame<'_>, app: &mut App) {
    let width = label_width(app);
    let focused = app.layer.focused_path().and_then(row);
    let colors = app.theme.colors();
    let default = app.i18n.text("oauth-identity-default");
    let rows: Vec<_> = (0..4)
        .map(|index| {
            let rect = app
                .layer
                .rect(&row_path(index))
                .filter(|rect| !rect.is_empty())?;
            Some((
                rect,
                label(app, &app.management.oauth, index),
                app.oauth_enabled(Command::Field(index)),
            ))
        })
        .collect();
    let fields = &mut app.management.oauth.identity.fields;
    for (index, (field, row)) in fields.iter_mut().zip(rows).enumerate() {
        let Some((rect, label, enabled)) = row else {
            field.invalidate_geometry();
            continue;
        };
        let here = enabled && focused == Some(index);
        let label_rect = Rect::new(rect.x, rect.y, width.min(rect.width), 1);
        frame.buffer_mut().set_style(label_rect, colors.base());
        frame.render_widget(
            Paragraph::new(label).style(Style::default().fg(if here {
                tone::accent(colors)
            } else {
                colors.muted
            })),
            Rect::new(
                label_rect.x,
                label_rect.y,
                label_rect.width.saturating_sub(1),
                1,
            ),
        );
        let value = Rect::new(
            rect.x + label_rect.width,
            rect.y,
            rect.width.saturating_sub(label_rect.width),
            1,
        );
        if index == 3 {
            field.draw_masked(frame, value, here, colors);
        } else {
            field.draw(frame, value, here, colors);
        }
        if index < 2 && field.text().is_empty() && !here {
            frame.render_widget(
                Paragraph::new(default.as_str()).style(Style::default().fg(colors.subtle)),
                value,
            );
        }
    }
}
