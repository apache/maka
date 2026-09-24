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
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

/// Browsing Host directories to register a project or reference one in a
/// turn. Arrows move through the folders, Enter or a click opens one,
/// Backspace or Left goes up; the location shown is what Register saves.
pub(in crate::pages::manage) fn sheet(app: &App, dialog: &Dialog) -> Sheet<Action> {
    let reference = app.directory_reference_active();
    let references = app
        .directory_reference_target()
        .map(|target| app.reference_items(target).to_vec())
        .unwrap_or_default();
    let full = app
        .directory_reference_target()
        .is_some_and(|target| app.reference_count(target) >= 4);
    let busy = app.management.pending.is_some();
    let browser = dialog.browser.as_ref().expect("directory browser");
    let enabled = browser.ready() && !browser.resolving && !dialog.blocked && !busy;
    let place = browser.location.as_ref().map_or_else(
        || app.i18n.text("directory-roots"),
        |location| {
            std::iter::once(location.label.as_str())
                .chain(location.segments.iter().map(String::as_str))
                .collect::<Vec<_>>()
                .join(" / ")
        },
    );
    // A new place or page opens on its first folder once the folders arrive.
    let step = if browser.rows.is_empty() {
        "empty"
    } else {
        "rows"
    };
    let mut sheet = Sheet::new(
        format!(
            "directory:{place}:{}:{step}",
            browser.cursor.as_deref().unwrap_or("")
        ),
        app.i18n.text(if reference {
            "references-title"
        } else {
            "directory-title"
        }),
    );
    let tool = |key: &'static str, glyph: (&'static str, &'static str), command: Command| {
        let action = Action::Manage(Manage::Directory(command));
        let enabled = app.enabled(&action);
        Node::button(
            key,
            app.chrome.symbol(glyph.0, glyph.1).to_owned(),
            Role::Normal,
        )
        .on(On::Activate(action))
        .enabled(enabled)
    };
    let tools = vec![
        tool("parent", ("↑", "^"), Command::Parent),
        tool("previous", ("‹", "<"), Command::Previous),
        tool("next", ("›", ">"), Command::Next),
        tool("refresh", ("⟳", "R"), Command::Refresh),
    ];
    // Labels are presentation only, never joined into a Host filesystem path;
    // a long place keeps its end, where the reader is.
    let width = crate::ui::content_width(app.frame_size.map_or(80, |(width, _)| width))
        .saturating_sub(tools.len() as u16 * 6) as usize;
    let place = safe(&place);
    let place = if place.width() > width {
        let mut tail = String::new();
        for grapheme in place.graphemes(true).rev() {
            if tail.width() + grapheme.width() + 1 > width {
                break;
            }
            tail.insert_str(0, grapheme);
        }
        format!("{}{tail}", app.chrome.symbol("…", "."))
    } else {
        place
    };
    let mut header = vec![
        Node::text("place", vec![(place, Tone::Normal)])
            .clip()
            .size(Size::Fill),
    ];
    header.extend(tools);
    sheet = sheet.body(Node::row("header", header).gap(1));
    if browser.rows.is_empty() {
        if !browser.error {
            let key = if browser.loading || browser.requested {
                "projects-loading"
            } else if browser.location.is_some() {
                "directory-empty"
            } else {
                "directory-no-roots"
            };
            sheet = sheet.text("empty", &app.i18n.text(key), Tone::Subtle);
        }
    } else {
        let rows = browser
            .rows
            .iter()
            .enumerate()
            .map(|(index, row)| {
                let action = Action::Manage(Manage::Directory(Command::Open(index)));
                let open = app.enabled(&action);
                Node::text(
                    index.to_string(),
                    vec![(
                        format!("{} {}", app.chrome.symbol("›", ">"), safe(&row.name)),
                        Tone::Normal,
                    )],
                )
                .clip()
                .on(On::Activate(action))
                .enabled(enabled && open)
            })
            .collect();
        let height = app.frame_size.map_or(24, |(_, height)| height);
        let cap = height.saturating_sub(16 + references.len() as u16).max(3);
        sheet = sheet.body(Node::scroll("list", Node::column("rows", rows)).size(Size::Upto(cap)));
    }
    let note = if busy {
        Some(("session-saving", Tone::Subtle))
    } else if let Some(error) = dialog.error {
        Some((error, Tone::Warning))
    } else if browser.error {
        Some(("directory-failed", Tone::Warning))
    } else if full {
        Some(("references-limit", Tone::Subtle))
    } else {
        None
    };
    if let Some((key, tone)) = note {
        sheet = sheet.text("note", &app.i18n.text(key), tone);
    }
    if !references.is_empty() {
        let rows = references
            .iter()
            .enumerate()
            .map(|(index, item)| {
                let action = Action::Manage(Manage::Directory(Command::RemoveReference(index)));
                let enabled = app.enabled(&action);
                Node::text(
                    index.to_string(),
                    vec![(
                        format!("{}  {}", app.chrome.symbol("×", "x"), safe(&item.path)),
                        Tone::Normal,
                    )],
                )
                .clip()
                .on(On::Activate(action))
                .enabled(enabled)
            })
            .collect();
        sheet = sheet.body(Node::column("references", rows));
    }
    if !reference {
        let action = Action::Manage(Manage::Directory(Command::Path));
        let enabled = app.enabled(&action);
        sheet = sheet.aside("path", app.i18n.text("directory-path"), action, enabled);
        if enabled {
            // Esc returns to typing the path rather than closing.
            sheet = sheet.back(Action::Manage(Manage::Directory(Command::Path)));
        }
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
            "save",
            app.i18n.text(if reference {
                "references-select"
            } else {
                "directory-register"
            }),
            Role::Primary,
            Action::Manage(Manage::Save),
            app.enabled(&Action::Manage(Manage::Save)),
        );
    if browser.rows.is_empty() {
        sheet
    } else {
        sheet.focus_node("list/rows/0")
    }
}
