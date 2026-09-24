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

use super::{Action, App, Command};
use crate::{
    ui::{Node, On, Role, Sheet, Size, Tone},
    view::safe,
};
use crossterm::event::{Event, KeyCode, KeyEventKind};
use ratatui::{Frame, layout::Rect};

const ROWS: &str = "list/rows";

/// Picking Skills for the next turn: Selected · N shows only the picked
/// ones, the tools page and refresh, and the list toggles with a click,
/// Space or Enter. What the focused skill does reads below the list.
/// Picks apply at once, so the sheet only closes.
pub(crate) fn sheet(app: &App) -> Option<Sheet<Action>> {
    let dialog = app.skills.dialog.as_ref()?;
    let rows = app.skill_rows();
    let picked = app.picked_skills(&dialog.target);
    let loading = dialog.loading || dialog.requested;
    let step = if loading {
        "loading"
    } else if rows.is_empty() {
        "empty"
    } else {
        "rows"
    };
    let cursor = dialog
        .page
        .as_ref()
        .map_or("", |(_, cursor)| cursor.as_str());
    let mut sheet = Sheet::new(
        format!(
            "skills:{}:{}:{cursor}:{step}",
            dialog.session, dialog.selected_only
        ),
        app.i18n.text("skills-title"),
    );
    let tool = |key: &'static str, glyph: (&'static str, &'static str), command: Command| {
        Node::button(
            key,
            app.chrome.symbol(glyph.0, glyph.1).to_owned(),
            Role::Normal,
        )
        .on(On::Activate(Action::Skills(command.clone())))
        .enabled(app.skills_enabled(&command))
    };
    let selected = format!("{} · {}", app.i18n.text("skills-selected"), picked.len());
    sheet = sheet.body(
        Node::row(
            "header",
            vec![
                Node::button("selected", selected, Role::Normal)
                    .on(On::Activate(Action::Skills(Command::Selected)))
                    .enabled(app.skills_enabled(&Command::Selected))
                    .current(dialog.selected_only),
                Node::text("space", vec![]).size(Size::Fill),
                tool("previous", ("‹", "<"), Command::Previous),
                tool("next", ("›", ">"), Command::Next),
                tool("refresh", ("⟳", "R"), Command::Refresh),
            ],
        )
        .gap(1),
    );
    if !rows.is_empty() {
        let nodes = rows
            .iter()
            .enumerate()
            .map(|(index, row)| {
                let mark = if picked.iter().any(|item| item.id == row.id) {
                    app.chrome.symbol("✓", "x")
                } else {
                    " "
                };
                Node::text(
                    index.to_string(),
                    vec![(format!("[{mark}] {}", safe(&row.name)), Tone::Normal)],
                )
                .clip()
                .on(On::Activate(Action::Skills(Command::Toggle(index))))
                .enabled(app.skills_enabled(&Command::Toggle(index)))
            })
            .collect();
        let height = app.frame_size.map_or(24, |(_, height)| height);
        sheet = sheet.body(
            Node::scroll("list", Node::column("rows", nodes))
                .size(Size::Upto(height.saturating_sub(14).max(3))),
        );
    }
    let focused = app
        .layer
        .focused_path()
        .and_then(|path| {
            path.strip_prefix(ROWS)?
                .strip_prefix('/')?
                .parse::<usize>()
                .ok()
        })
        .and_then(|index| rows.get(index));
    let (note, tone) = if let Some(error) = dialog.error {
        (app.i18n.text(error), Tone::Warning)
    } else if loading {
        (app.i18n.text("skills-loading"), Tone::Subtle)
    } else if rows.is_empty() {
        (app.i18n.text("skills-empty"), Tone::Subtle)
    } else {
        (
            focused.map_or_else(String::new, |row| safe(&row.description)),
            Tone::Subtle,
        )
    };
    if !note.is_empty() {
        sheet = sheet.text("note", &note, tone);
    }
    let sheet = sheet.button(
        "close",
        app.i18n.text("session-remove-close"),
        Role::Normal,
        Action::Skills(Command::Close),
        true,
    );
    Some(if rows.is_empty() {
        sheet.focus("close")
    } else {
        sheet.focus_node(format!("{ROWS}/0"))
    })
}

impl App {
    /// Shortcuts the sheet's owner takes first: F5 refreshes, PgUp and PgDn
    /// turn the page, and so do ← and → from the list, where they have
    /// nowhere else to go.
    pub(crate) fn skills_sheet_input(&mut self, event: &Event) -> Option<(bool, Option<Action>)> {
        let Event::Key(key) = event else {
            return None;
        };
        if key.kind == KeyEventKind::Release || !key.modifiers.is_empty() {
            return None;
        }
        let listed = self
            .layer
            .focused_path()
            .is_some_and(|path| path.starts_with(ROWS));
        let command = match key.code {
            KeyCode::F(5) => Command::Refresh,
            KeyCode::PageUp => Command::Previous,
            KeyCode::PageDown => Command::Next,
            KeyCode::Left if listed => Command::Previous,
            KeyCode::Right if listed => Command::Next,
            _ => return None,
        };
        Some((true, self.apply(Action::Skills(command))))
    }
}

pub fn chips(frame: &mut Frame<'_>, app: &mut App, area: Rect, session: &str) {
    let names = app
        .skills
        .saved
        .get(session)
        .into_iter()
        .flatten()
        .map(|s| s.name.as_str())
        .collect::<Vec<_>>()
        .join(" · ");
    let label = if app.stop_target().is_some() {
        format!(
            "{} {} · {}",
            app.chrome.symbol("✧", "*"),
            safe(&names),
            app.i18n.text("skills-idle")
        )
    } else {
        format!("{} {}", app.chrome.symbol("✧", "*"), safe(&names))
    };
    crate::view::list_item(
        frame,
        app,
        area,
        &label,
        Action::Skills(Command::Open),
        false,
    );
}
