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

use super::{Command, Manage};
use crate::{
    app::{Action, App},
    pages::manage::Dialog,
    ui::{Node, On, Role, Sheet, Size, Tone},
    view::safe,
};

/// Moving a session into a project. Arrows or a click choose a row, Enter
/// applies it; opening chooses nothing, so Enter alone commits nothing.
pub(in crate::pages::manage) fn sheet(app: &App, dialog: &Dialog) -> Sheet<Action> {
    let busy = app.management.pending.is_some();
    let chooser = dialog.chooser.as_ref().expect("project chooser");
    let catalog = &chooser.catalog;
    let enabled = !dialog.blocked && !busy;
    // The first page arriving is a new step: focus moves into the list.
    let step = if catalog.loaded { "list" } else { "loading" };
    let mut sheet = Sheet::new(
        format!("project:{}:{step}", dialog.target.name),
        app.i18n.text("session-project-change"),
    )
    .text("name", &safe(&dialog.target.name), Tone::Normal);
    if catalog.items.is_empty() {
        if !catalog.error {
            let key = if !catalog.ready() {
                "projects-loading"
            } else if catalog.can_next() || catalog.can_previous() {
                "projects-page-empty"
            } else {
                "projects-empty"
            };
            sheet = sheet.text("empty", &app.i18n.text(key), Tone::Subtle);
        }
    } else {
        let rows = catalog
            .items
            .iter()
            .map(|item| {
                let selected = catalog.selected.as_ref() == Some(&item.id);
                let marker = match (selected, app.chrome.ascii) {
                    (true, false) => "›",
                    (true, true) => ">",
                    _ => " ",
                };
                let mut label = format!("{marker} {}", safe(&item.name));
                if item.archived {
                    label.push_str(&format!(" · {}", app.i18n.text("session-archived")));
                } else if !item.available {
                    label.push_str(&format!(" · {}", app.i18n.text("project-unavailable")));
                }
                let tone = if item.usable() {
                    Tone::Normal
                } else {
                    Tone::Subtle
                };
                Node::text(item.id.clone(), vec![(label, tone)])
                    .clip()
                    .on(On::Activate(Action::Manage(Manage::ChooseProject(
                        Command::Select(item.id.clone()),
                    ))))
                    .follow_focus()
                    .submit(Action::Manage(Manage::Save))
                    .current(selected)
                    .enabled(enabled)
            })
            .collect();
        let height = app.frame_size.map_or(24, |(_, height)| height);
        let visible = (catalog.items.len() as u16).min(height.saturating_sub(16).max(3));
        sheet = sheet.body(
            Node::scroll("list", Node::column("rows", rows).focus_group())
                .size(Size::Fixed(visible)),
        );
    }
    let (note, tone) = if busy {
        ("session-saving", Tone::Subtle)
    } else if let Some(error) = dialog.error {
        (error, Tone::Warning)
    } else if catalog.error {
        ("projects-failed", Tone::Warning)
    } else {
        ("session-project-note", Tone::Subtle)
    };
    sheet = sheet.text("note", &app.i18n.text(note), tone);
    let command = |command: Command| {
        let action = Action::Manage(Manage::ChooseProject(command));
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
    let sheet = sheet
        .button(
            "cancel",
            app.i18n.text("session-cancel"),
            Role::Normal,
            Action::Manage(Manage::Close),
            true,
        )
        .button(
            "apply",
            app.i18n.text("session-project-apply"),
            Role::Primary,
            Action::Manage(Manage::Save),
            app.enabled(&Action::Manage(Manage::Save)),
        );
    match &catalog.selected {
        Some(id) if catalog.items.iter().any(|item| item.id == *id) => {
            sheet.focus_node(format!("list/rows/{id}"))
        }
        _ => sheet,
    }
}
