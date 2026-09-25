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

use super::*;
use crate::{
    app::Hit,
    ui::{Node, On, Role, Sheet, Size, Tone},
    view::safe,
};
use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers, MouseButton, MouseEventKind};
use ratatui::{
    Frame,
    layout::Rect,
    style::Style,
    text::{Line, Span},
    widgets::Paragraph,
};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

/// The path field of the file browser.
pub(super) const PATH: &str = "path";
const ROWS: &str = "list/rows";

pub fn size(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KiB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MiB", bytes as f64 / (1024.0 * 1024.0))
    }
}

fn action(command: Command) -> Action {
    Action::Attachment(command)
}

/// A message's files: the list with each file's upload state, actions on
/// the selected one, and the local file browser as a second step. Host
/// directories and Skills, the other things a message can carry, sit at
/// the bottom left when there is room.
pub(crate) fn sheet(app: &App) -> Option<Sheet<Action>> {
    let dialog = app.attachments.dialog.as_ref()?;
    let mut title = app.i18n.text(if dialog.browse {
        "attachments-local-files"
    } else {
        "attachments-title"
    });
    if let Some((position, count)) = dialog
        .input
        .as_deref()
        .and_then(|input| app.revision.file_position(&dialog.session, input))
    {
        title = format!(
            "{title} · {} {position} / {count}",
            app.i18n.text("revision-input")
        );
    }
    let items = app.attachment_files(&dialog.session, dialog.input.as_deref());
    let height = app.frame_size.map_or(24, |(_, height)| height);
    let width = crate::ui::content_width(app.frame_size.map_or(80, |(width, _)| width));
    let key = format!(
        "attachments:{}:{}",
        dialog.session,
        dialog.input.as_deref().unwrap_or("")
    );
    let mut sheet = if dialog.browse {
        let loading = dialog.requested || app.attachments.browser_pending.is_some();
        let sheet = Sheet::new(
            format!(
                "{key}:browse:{}:{loading}",
                dialog.directory.to_string_lossy()
            ),
            title,
        );
        browse(app, dialog, sheet, height)
    } else {
        list(
            app,
            dialog,
            items,
            Sheet::new(format!("{key}:list"), title),
            height,
        )
    };
    let enabled = |command: &Command| app.attachment_enabled(command);
    let mut asides = vec![];
    if dialog.browse && !items.is_empty() {
        asides.push(("attachments", "attachments-title", Command::Open));
        sheet = sheet.back(action(Command::Open));
    }
    asides.push(("directories", "references-title", Command::Directory));
    asides.push(("skills", "skills-title", Command::Skills));
    let close = app.i18n.text("attachments-close");
    // The other sources are also on the composer; below this width they
    // make way for the sheet's own controls.
    let room = asides
        .iter()
        .map(|(_, label, _)| app.i18n.text(label).width() as u16 + 6)
        .sum::<u16>()
        + close.width() as u16
        + 4;
    for (index, (key, label, command)) in asides.into_iter().enumerate() {
        if room <= width || (index == 0 && command == Command::Open) {
            sheet = sheet.aside(
                key,
                app.i18n.text(label),
                action(command.clone()),
                enabled(&command),
            );
        }
    }
    Some(sheet.button("close", close, Role::Normal, action(Command::Close), true))
}

fn list(
    app: &App,
    dialog: &Dialog,
    items: &[Saved],
    sheet: Sheet<Action>,
    height: u16,
) -> Sheet<Action> {
    let state = &app.attachments;
    let mut rows: Vec<_> = items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let (key, progress) = if item.attachment.is_some() {
                ("attachments-ready", None)
            } else if let Some(active) = state.active.as_ref().filter(|a| a.ticket.id == item.id) {
                match active.phase {
                    Phase::Reading => ("attachments-reading", None),
                    Phase::Checkpoint => ("attachments-saving", None),
                    Phase::Uploading => (
                        "attachments-uploading",
                        Some(active.transfer.bytes.load(Ordering::Relaxed)),
                    ),
                }
            } else if let Some(error) = state.errors.get(&item.id) {
                (error.key(), None)
            } else if state.queued.iter().any(|(_, _, id)| id == &item.id) {
                ("attachments-queued", None)
            } else if dialog.input.is_some() && item.manifest.is_none() {
                ("attachments-selected", None)
            } else {
                ("attachments-paused", None)
            };
            let name = item
                .manifest
                .as_ref()
                .map(|m| m.name.as_str())
                .unwrap_or_else(|| item.path.file_name().and_then(|s| s.to_str()).unwrap_or(""));
            let amount = item
                .manifest
                .as_ref()
                .map(|m| match progress {
                    Some(bytes) => format!("{} / {}", size(bytes), size(m.bytes)),
                    None => size(m.bytes),
                })
                .unwrap_or_default();
            let status = format!(
                "  {}{}{amount}",
                app.i18n.text(key),
                if amount.is_empty() { "" } else { " · " },
            );
            let tone = if state.errors.contains_key(&item.id) {
                Tone::Error
            } else {
                Tone::Subtle
            };
            Node::column(
                index.to_string(),
                vec![
                    Node::text("name", vec![(safe(name), Tone::Normal)]).clip(),
                    Node::text("status", vec![(status, tone)]).clip(),
                ],
            )
            .on(On::Activate(action(Command::Select(index))))
            .current(index == dialog.selected)
            .follow_focus()
        })
        .collect();
    // Adding is the list's last row, where a reader looks for it.
    let add = Command::Browse;
    rows.push(
        Node::text(
            "add",
            vec![(
                format!(
                    "{} {}",
                    app.chrome.symbol("+", "+"),
                    app.i18n.text(add.label())
                ),
                Tone::Accent,
            )],
        )
        .on(On::Activate(action(add.clone())))
        .enabled(app.attachment_enabled(&add)),
    );
    let mut sheet = sheet.body(
        Node::scroll("list", Node::column("rows", rows).focus_group())
            .size(Size::Upto(height.saturating_sub(14).max(4))),
    );
    let selected = items.get(dialog.selected);
    let detail = selected.and_then(|item| state.errors.get(&item.id).and_then(Failure::detail));
    let note = match (&dialog.problem, selected) {
        (Some(problem), _) => Some((app.i18n.text(problem.key()), Tone::Error)),
        (None, Some(item)) => Some((
            match detail.filter(|_| dialog.details) {
                Some(detail) => safe(detail),
                None => safe(&item.path.to_string_lossy()),
            },
            Tone::Subtle,
        )),
        (None, None) => None,
    };
    if let Some((note, tone)) = note {
        sheet = sheet.body(Node::text("note", vec![(note, tone)]));
    }
    // What can be done to the selected file.
    let mut actions = vec![];
    for (key, command) in [("retry", Command::Retry), ("remove", Command::Remove)] {
        if app.attachment_enabled(&command) {
            actions.push(
                Node::button(key, app.i18n.text(command.label()), Role::Normal)
                    .on(On::Activate(action(command))),
            );
        }
    }
    if detail.is_some() {
        actions.push(
            Node::button(
                "details",
                app.i18n.text(Command::Details.label()),
                Role::Normal,
            )
            .on(On::Activate(action(Command::Details)))
            .current(dialog.details),
        );
    }
    if !actions.is_empty() {
        sheet = sheet.body(Node::row("actions", actions).gap(2));
    }
    sheet.focus_node(if items.is_empty() {
        format!("{ROWS}/add")
    } else {
        format!("{ROWS}/{}", dialog.selected)
    })
}

fn browse(app: &App, dialog: &Dialog, sheet: Sheet<Action>, height: u16) -> Sheet<Action> {
    let tool = |key: &'static str, glyph: (&'static str, &'static str), command: Command| {
        Node::button(
            key,
            app.chrome.symbol(glyph.0, glyph.1).to_owned(),
            Role::Normal,
        )
        .on(On::Activate(action(command.clone())))
        .enabled(app.attachment_enabled(&command))
    };
    let mut sheet = sheet.body(
        Node::row(
            PATH,
            vec![
                tool("parent", ("↑", "^"), Command::Parent),
                Node::slot("input", 1)
                    .on(On::Activate(action(Command::EnterPath)))
                    .enabled(app.attachment_enabled(&Command::Path))
                    .size(Size::Fill),
                tool("enter", ("→", ">"), Command::EnterPath),
            ],
        )
        .gap(1),
    );
    let pick = |index: usize| Command::Pick(index);
    let rows: Vec<_> = dialog
        .entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let name = safe(&entry.path.file_name().unwrap_or_default().to_string_lossy());
            let (glyph, detail) = if entry.directory {
                (app.chrome.symbol("▸", ">"), String::new())
            } else {
                ("·", size(entry.bytes))
            };
            Node::row(
                index.to_string(),
                vec![
                    Node::text("name", vec![(format!("{glyph} {name}"), Tone::Normal)])
                        .clip()
                        .size(Size::Fill),
                    Node::text("size", vec![(detail, Tone::Subtle)]),
                ],
            )
            .gap(2)
            .on(On::Activate(action(pick(index))))
            .enabled(app.attachment_enabled(&pick(index)))
        })
        .collect();
    let empty = rows.is_empty();
    if !empty {
        sheet = sheet.body(
            Node::scroll("list", Node::column("rows", rows).focus_group())
                .size(Size::Upto(height.saturating_sub(14).max(4))),
        );
    }
    if let Some(problem) = &dialog.problem {
        sheet = sheet.text("note", &app.i18n.text(problem.key()), Tone::Error);
    } else if dialog.truncated {
        sheet = sheet.text(
            "note",
            &app.i18n.text("attachments-truncated"),
            Tone::Subtle,
        );
    }
    if empty {
        sheet.focus_node(format!("{PATH}/input"))
    } else {
        sheet.focus_node(format!("{ROWS}/0"))
    }
}

/// Paints the browser's path field over the drawn sheet.
pub(crate) fn draw_field(frame: &mut Frame<'_>, app: &mut App) {
    let rect = app.layer.slot(PATH).filter(|rect| !rect.is_empty());
    let focused = app.layer.focused(PATH);
    let colors = app.theme.colors();
    let Some(dialog) = app.attachments.dialog.as_mut() else {
        return;
    };
    match rect.filter(|_| dialog.browse) {
        Some(rect) => dialog.path.draw(frame, rect, focused, colors),
        None => dialog.path.invalidate_geometry(),
    }
}

impl App {
    /// The path field's keys, pastes and pointer, and the list's shortcuts
    /// (Delete removes, R resumes, D shows details, Backspace goes up),
    /// taken before the sheet.
    pub(crate) fn attachment_sheet_input(
        &mut self,
        event: &Event,
    ) -> Option<(bool, Option<Action>)> {
        let focused = self.layer.focused(PATH);
        let editable = self.attachment_enabled(&Command::Path);
        let dialog = self.attachments.dialog.as_mut()?;
        let command = match event {
            Event::Key(key) if key.kind != KeyEventKind::Release => {
                if focused {
                    if !editable
                        || matches!(
                            key.code,
                            KeyCode::Esc
                                | KeyCode::Tab
                                | KeyCode::BackTab
                                | KeyCode::Enter
                                | KeyCode::Up
                                | KeyCode::Down
                        )
                        || (key.modifiers.contains(KeyModifiers::CONTROL)
                            && key.code == KeyCode::Char('q'))
                    {
                        return None;
                    }
                    return Some((dialog.path.key(*key), None));
                }
                if !key.modifiers.is_empty() {
                    return None;
                }
                match key.code {
                    KeyCode::Backspace if dialog.browse => Command::Parent,
                    KeyCode::Delete if !dialog.browse => Command::Remove,
                    KeyCode::Char('r') if !dialog.browse => Command::Retry,
                    KeyCode::Char('d') if !dialog.browse => Command::Details,
                    _ => return None,
                }
            }
            Event::Paste(text) if focused && editable => {
                return Some((dialog.path.insert(&text.replace(['\n', '\r'], "")), None));
            }
            Event::Mouse(mouse) if dialog.browse && editable && dialog.path.takes(mouse) => {
                let changed = dialog.path.mouse(*mouse);
                if mouse.kind == MouseEventKind::Down(MouseButton::Left) {
                    self.layer.focus(PATH);
                    return Some((true, None));
                }
                return Some((changed, None));
            }
            _ => return None,
        };
        Some((true, self.apply(action(command))))
    }
}

pub fn chips(frame: &mut Frame<'_>, app: &mut App, area: Rect, session: &str) {
    if area.is_empty() {
        return;
    }
    let Some(items) = app.attachments.saved.get(session).filter(|i| !i.is_empty()) else {
        return;
    };
    let item = items
        .iter()
        .find(|item| {
            app.attachments
                .active
                .as_ref()
                .is_some_and(|active| active.ticket.id == item.id)
        })
        .or_else(|| items.iter().find(|item| item.attachment.is_none()))
        .unwrap_or(&items[0]);
    let name = item
        .manifest
        .as_ref()
        .map(|m| m.name.as_str())
        .unwrap_or_else(|| item.path.file_name().and_then(|n| n.to_str()).unwrap_or(""));
    let (status, _) = app.attachments.status(item);
    let extra = if items.len() > 1 {
        format!("  +{}", items.len() - 1)
    } else {
        String::new()
    };
    let icon = if items
        .iter()
        .any(|item| app.attachments.errors.contains_key(&item.id))
    {
        "!"
    } else if app.attachments.ready(session) {
        "✓"
    } else {
        "↑"
    };
    let suffix = format!("{extra} · {}", app.i18n.text(status));
    let name = safe(name);
    let limit = usize::from(area.width).saturating_sub(2 + suffix.width());
    let name = if name.width() > limit {
        let mut cells = 0;
        let mut visible: String = name
            .graphemes(true)
            .take_while(|glyph| {
                cells += glyph.width();
                cells <= limit.saturating_sub(1)
            })
            .collect();
        if limit > 0 {
            visible.push(if app.chrome.ascii { '.' } else { '…' });
        }
        visible
    } else {
        name
    };
    let text = Line::from(vec![
        Span::styled(
            format!("{icon} "),
            Style::default().fg(app.theme.colors().accent),
        ),
        Span::raw(name),
        Span::styled(suffix, Style::default().fg(app.theme.colors().subtle)),
    ]);
    frame.render_widget(Paragraph::new(text), area);
    app.hits.push(Hit {
        area,
        action: Action::Attachment(Command::Open),
    });
}
