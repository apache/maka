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

use super::{Command, Manage, thinking_key};
use crate::{
    app::{Action, App},
    pages::manage::Dialog,
    ui::{Choice, Node, On, Role, Sheet, Size, Tone},
    view::safe,
};
use std::iter;

/// Choosing a model: arrows or a click choose a row, Enter applies it.
/// For the default model the first row clears the default. Thinking is a
/// chooser of the levels the chosen model supports.
pub(in crate::pages::manage) fn sheet(app: &App, dialog: &Dialog) -> Sheet<Action> {
    let busy = app.management.pending.is_some();
    let models = dialog.models.as_ref().expect("model chooser");
    let catalog = &models.catalog;
    let enabled = !dialog.blocked && !busy;
    // Rows arriving are a new step: focus moves into the list.
    let step = if catalog.rows.is_empty() {
        "empty"
    } else {
        "list"
    };
    let mut sheet = Sheet::new(
        format!("model:{}:{step}", dialog.target.name),
        app.i18n.text(dialog.kind.label(&dialog.target)),
    );
    if !models.for_default {
        sheet = sheet.text("name", &safe(&dialog.target.name), Tone::Normal);
    }
    let marker = |selected: bool| match (selected, app.chrome.ascii) {
        (true, false) => "›",
        (true, true) => ">",
        _ => " ",
    };
    let current = format!(" · {}", app.i18n.text("default-model-current"));
    let choose = |node: Node<Action>, command: Command| {
        node.on(On::Activate(Action::Manage(Manage::Models(command))))
            .follow_focus()
            .submit(Action::Manage(Manage::Save))
            .enabled(enabled)
    };
    let mut rows = vec![];
    let mut lines = 0;
    if models.for_default {
        let label = format!(
            "{} {}{}",
            marker(models.clear_default),
            app.i18n.text("default-model-none"),
            if catalog.revision().is_some() && !catalog.has_default {
                current.as_str()
            } else {
                ""
            }
        );
        rows.push(choose(
            Node::text("none", vec![(label, Tone::Normal)]).clip(),
            Command::ClearDefault,
        ));
        lines += 1;
    }
    for row in &catalog.rows {
        let selected = catalog.selected.as_ref() == Some(&row.choice);
        let title = format!(
            "{} {}{}",
            marker(selected),
            safe(&row.name),
            if models.for_default && row.is_default {
                current.as_str()
            } else {
                ""
            }
        );
        let detail = if row.name == row.choice.model {
            safe(&row.connection)
        } else {
            format!("{} · {}", safe(&row.connection), safe(&row.choice.model))
        };
        rows.push(choose(
            Node::column(
                key(row),
                vec![
                    Node::text("name", vec![(title, Tone::Normal)]).clip(),
                    Node::text("detail", vec![(format!("  {detail}"), Tone::Subtle)]).clip(),
                ],
            ),
            Command::Select(row.choice.clone()),
        ));
        lines += 2;
    }
    if !rows.is_empty() {
        let height = app.frame_size.map_or(24, |(_, height)| height);
        let visible = lines.min(height.saturating_sub(18).max(4));
        sheet = sheet.body(
            Node::scroll("list", Node::column("rows", rows).focus_group())
                .size(Size::Fixed(visible)),
        );
    }
    if catalog.rows.is_empty() && !catalog.error {
        let key = match (catalog.ready(), catalog.can_previous()) {
            (true, true) => "session-model-page-empty",
            (true, false) => "session-model-empty",
            _ => "session-model-loading",
        };
        sheet = sheet.text("empty", &app.i18n.text(key), Tone::Subtle);
    }
    if let Some(row) = models.selection().filter(|_| models.has_thinking()) {
        let level = models.thinking_level();
        let levels: Vec<_> = iter::once(None)
            .chain(row.thinking_levels.iter().copied().map(Some))
            .collect();
        let choices = levels
            .iter()
            .map(|level| Choice {
                label: app.i18n.text(thinking_key(*level)),
                action: Action::Manage(Manage::Models(Command::Thinking(*level))),
            })
            .collect();
        sheet = sheet.body(
            Node::row(
                "thinking",
                vec![
                    Node::text(
                        "label",
                        vec![(app.i18n.text("session-thinking"), Tone::Normal)],
                    )
                    .size(Size::Fill),
                    Node::text(
                        "value",
                        vec![(
                            format!(
                                "{} {}",
                                app.i18n.text(thinking_key(level)),
                                app.chrome.symbol("▾", "v")
                            ),
                            Tone::Muted,
                        )],
                    ),
                ],
            )
            .on(On::Choose {
                choices,
                current: levels.iter().position(|candidate| *candidate == level),
            })
            .enabled(enabled),
        );
    }
    let (note, tone) = if busy {
        ("session-saving", Tone::Subtle)
    } else if let Some(error) = dialog.error {
        (error, Tone::Warning)
    } else if catalog.error {
        ("session-model-load-failed", Tone::Warning)
    } else if models.for_default && models.clear_default {
        ("default-model-clear-note", Tone::Subtle)
    } else if models.for_default {
        ("default-model-note", Tone::Subtle)
    } else if models.selection().is_some()
        && models.thinking.is_some()
        && models.thinking_level().is_none()
    {
        ("session-thinking-fallback", Tone::Subtle)
    } else {
        ("session-model-note", Tone::Subtle)
    };
    sheet = sheet.text("note", &app.i18n.text(note), tone);
    let command = |command: Command| {
        let action = Action::Manage(Manage::Models(command));
        let enabled = app.enabled(&action);
        (action, enabled)
    };
    if catalog.can_previous() || catalog.can_next() {
        let (previous, can_previous) = command(Command::Previous);
        let (next, can_next) = command(Command::Next);
        sheet = sheet
            .aside(
                "previous",
                format!(
                    "{} {}",
                    app.chrome.symbol("‹", "<"),
                    app.i18n.text("sessions-previous")
                ),
                previous,
                can_previous,
            )
            .aside(
                "next",
                format!(
                    "{} {}",
                    app.i18n.text("sessions-next"),
                    app.chrome.symbol("›", ">")
                ),
                next,
                can_next,
            );
    }
    if catalog.error {
        let (refresh, can_refresh) = command(Command::Refresh);
        sheet = sheet.aside("refresh", app.i18n.text("list-retry"), refresh, can_refresh);
    }
    let save = match (models.for_default, models.clear_default) {
        (true, true) => "default-model-clear",
        (true, false) => "default-model-apply",
        _ => "session-model-apply",
    };
    let sheet = sheet
        .button(
            "cancel",
            app.i18n.text("session-cancel"),
            Role::Normal,
            Action::Manage(Manage::Close),
            true,
        )
        .button(
            "save",
            app.i18n.text(save),
            Role::Primary,
            Action::Manage(Manage::Save),
            app.enabled(&Action::Manage(Manage::Save)),
        );
    if models.for_default && models.clear_default {
        return sheet.focus_node("list/rows/none");
    }
    match catalog
        .rows
        .iter()
        .find(|row| catalog.selected.as_ref() == Some(&row.choice))
    {
        Some(row) => sheet.focus_node(format!("list/rows/{}", key(row))),
        None => sheet,
    }
}

/// A model's identity across pages: its connection and model id.
fn key(row: &super::catalog::Row) -> String {
    format!("{}:{}", row.choice.connection_id, row.choice.model)
}
