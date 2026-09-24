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

use super::{Action, App, Command, Phase, resources};
use crate::{
    ui::{Node, On, Role, Sheet, Size, Tone},
    view::safe,
};
use crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseEventKind};
use ratatui::Frame;

/// The input's text, a field its owner draws.
const EDITOR: &str = "editor";
/// Host detail of a blocked turn, a read-only viewer.
const PROBLEM: &str = "problem";
const RESOURCES: &str = "resources/rows";

fn action(command: Command) -> Action {
    Action::Revision(command)
}

/// Revising a turn: page through its inputs, edit each one's text or
/// choose which of its resources go along, then run it in a new session.
/// Resource pickers for the input sit under it; what can be done about
/// the note (retry, details) under the note; Discard at the bottom left,
/// confirmed in its own step.
pub(crate) fn sheet(app: &App) -> Option<Sheet<Action>> {
    let state = &app.revision;
    if !state.visible {
        return None;
    }
    let enabled = |command: &Command| app.revision_enabled(command);
    if state.confirm_discard {
        return Some(
            Sheet::new("revision:discard", app.i18n.text("revision-discard"))
                .text(
                    "note",
                    &app.i18n.text("revision-discard-note"),
                    Tone::Subtle,
                )
                .back(action(Command::Keep))
                .button(
                    "cancel",
                    app.i18n.text("session-cancel"),
                    Role::Normal,
                    action(Command::Keep),
                    true,
                )
                .button(
                    "discard",
                    app.i18n.text("revision-discard"),
                    Role::Destructive,
                    action(Command::ConfirmDiscard),
                    enabled(&Command::ConfirmDiscard),
                )
                .focus("cancel"),
        );
    }
    let editing = state.phase == Phase::Editing;
    let listing = editing && state.resources.visible;
    let step = if state.show_problem {
        "details"
    } else if listing {
        "resources"
    } else {
        match state.phase {
            Phase::Editing => "edit",
            Phase::Uploading | Phase::Ready => "ready",
            Phase::Busy | Phase::Loading => "wait",
            Phase::UnknownCopy | Phase::UnknownTurn | Phase::Failed => "unknown",
            Phase::Done | Phase::Retained => "done",
        }
    };
    let mut sheet = Sheet::new(format!("revision:{step}"), app.i18n.text("revision-title"));
    let width = crate::ui::content_width(app.frame_size.map_or(80, |(width, _)| width));
    let height = app.frame_size.map_or(24, |(_, height)| height);
    let selected = state.selected;
    let input = state
        .saved
        .as_ref()
        .and_then(|saved| saved.inputs.get(selected));
    let count = state.saved.as_ref().map_or(0, |saved| saved.inputs.len());
    if state.show_problem {
        sheet = sheet.text("heading", &app.i18n.text("revision-details"), Tone::Warning);
    } else if let Some(input) = input {
        let tool = |key: &'static str, glyph: (&'static str, &'static str), command: Command| {
            let enabled = enabled(&command);
            Node::button(
                key,
                app.chrome.symbol(glyph.0, glyph.1).to_owned(),
                Role::Normal,
            )
            .on(On::Activate(action(command)))
            .enabled(enabled)
        };
        let mut pager = vec![
            tool(
                "previous",
                ("‹", "<"),
                Command::Select(selected.saturating_sub(1)),
            )
            .enabled(
                selected
                    .checked_sub(1)
                    .is_some_and(|previous| enabled(&Command::Select(previous))),
            ),
            Node::text(
                "position",
                vec![(
                    format!(
                        "{}  {} / {count}",
                        app.i18n.text("revision-input"),
                        selected + 1
                    ),
                    Tone::Muted,
                )],
            ),
            tool("next", ("›", ">"), Command::Select(selected + 1)),
            Node::text("space", vec![]).size(Size::Fill),
        ];
        if input.content.display_text.is_some() {
            pager.push(
                Node::button(
                    "display",
                    app.i18n.text(if state.display {
                        "revision-text"
                    } else {
                        "revision-display"
                    }),
                    Role::Normal,
                )
                .on(On::Activate(action(Command::Display)))
                .enabled(enabled(&Command::Display)),
            );
        }
        let message = input.message();
        let content = &message.content;
        let counts = [
            (
                "revision-attachments",
                content.attachments.as_ref().map_or(0, Vec::len),
            ),
            (
                "revision-references",
                content.quotes.as_ref().map_or(0, Vec::len)
                    + content.directory_references.as_ref().map_or(0, Vec::len)
                    + content.inline_references.as_ref().map_or(0, Vec::len),
            ),
            (
                "revision-selections",
                message.input_selections.values().map(Vec::len).sum(),
            ),
        ]
        .into_iter()
        .filter(|(_, n)| *n > 0)
        .map(|(key, n)| app.i18n.format(key, &[("count", &n.to_string())]))
        .collect::<Vec<_>>()
        .join(" · ");
        let mut about = vec![Node::row("pager", pager).gap(1)];
        if !counts.is_empty() {
            about.push(Node::text("counts", vec![(counts, Tone::Subtle)]).clip());
        }
        sheet = sheet.body(Node::column("about", about));
    }
    if state.show_problem {
        let rows = state
            .problem
            .as_ref()
            .map_or(3, |problem| problem.rows(width))
            .clamp(3, 15);
        // Enter in the viewer leaves it for the text again.
        sheet = sheet.body(Node::slot(PROBLEM, rows).on(On::Activate(action(Command::Details))));
    } else if let Some(input) = input {
        if listing {
            sheet = sheet.body(
                Node::scroll(
                    "resources",
                    Node::column("rows", resources::rows(app, input)),
                )
                .size(Size::Upto(height.saturating_sub(12).max(4))),
            );
        } else {
            let rows = state.editor.rows(width).clamp(3, 15);
            sheet = sheet.body(
                Node::slot(EDITOR, rows)
                    .on(On::Activate(action(Command::Send)))
                    .enabled(editing),
            );
        }
        sheet = tools(app, input, sheet);
    }
    let key = state.error.unwrap_or(match state.phase {
        Phase::Editing if listing => "revision-resources-note",
        Phase::Editing => "revision-note",
        Phase::Ready => "revision-prepared",
        Phase::Done => "revision-started",
        Phase::Retained => "revision-retained",
        Phase::UnknownCopy | Phase::UnknownTurn | Phase::Failed => "revision-unknown",
        Phase::Busy | Phase::Loading => "revision-wait",
        Phase::Uploading => "attachments-uploading",
    });
    let tone = if state.error.is_some() {
        Tone::Warning
    } else {
        Tone::Subtle
    };
    let mut lines: Vec<_> = app
        .i18n
        .text(key)
        .lines()
        .enumerate()
        .map(|(index, line)| Node::text(index.to_string(), vec![(line.to_owned(), tone)]))
        .collect();
    if !state.show_problem
        && key == "revision-blocked"
        && let Some(problem) = &state.problem
    {
        // Full Host detail stays opt-in and scrollable; a preview of two
        // rows cannot displace the controls.
        lines.extend(
            problem
                .text()
                .lines()
                .take(2)
                .enumerate()
                .map(|(index, line)| {
                    Node::text(format!("preview-{index}"), vec![(safe(line), Tone::Subtle)]).clip()
                }),
        );
    }
    let mut notes = vec![Node::column("text", lines)];
    let mut actions = vec![];
    if matches!(state.phase, Phase::UnknownCopy | Phase::UnknownTurn) {
        actions.push(
            Node::button("retry", app.i18n.text(Command::Retry.label()), Role::Normal)
                .on(On::Activate(action(Command::Retry)))
                .enabled(enabled(&Command::Retry)),
        );
    }
    if state.problem.is_some() {
        actions.push(
            Node::button(
                "details",
                app.i18n.text(Command::Details.label()),
                Role::Normal,
            )
            .on(On::Activate(action(Command::Details)))
            .enabled(enabled(&Command::Details))
            .current(state.show_problem),
        );
    }
    if !actions.is_empty() {
        notes.push(Node::row("actions", actions).gap(2));
    }
    sheet = sheet.body(Node::column("note", notes));
    if state.saved.is_some() {
        sheet = sheet.aside(
            "discard",
            app.i18n.text(Command::Discard.label()),
            action(Command::Discard),
            enabled(&Command::Discard),
        );
    }
    sheet = sheet.button(
        "close",
        app.i18n.text(Command::Close.label()),
        Role::Normal,
        action(Command::Close),
        true,
    );
    if let Some(primary) = state.primary() {
        let enabled = enabled(&primary);
        sheet = sheet.button(
            "primary",
            app.i18n.text(primary.label()),
            Role::Primary,
            action(primary),
            enabled,
        );
    }
    Some(match step {
        "edit" => sheet.focus_node(EDITOR),
        "details" => sheet.focus_node(PROBLEM),
        "resources" => sheet.focus_node(format!("{RESOURCES}/0")),
        _ => sheet.focus("close"),
    })
}

/// What the input carries, each with its picker: Host directories, Skills
/// and files, and the switch between its text and its resources.
fn tools(app: &App, input: &super::draft::Input, sheet: Sheet<Action>) -> Sheet<Action> {
    let state = &app.revision;
    let counted = |icon: &str, count: usize| {
        if count > 0 {
            format!("{icon} {count}")
        } else {
            icon.to_owned()
        }
    };
    let button = |key: &'static str, label: String, command: Command| {
        let enabled = app.revision_enabled(&command);
        Node::button(key, label, Role::Normal)
            .on(On::Activate(action(command)))
            .enabled(enabled)
    };
    let mut tools = vec![];
    if state.phase == Phase::Editing {
        tools.push(button(
            "directories",
            counted(app.chrome.symbol("▱", "/"), input.directories.len()),
            Command::Directories,
        ));
        tools.push(button(
            "skills",
            counted(app.chrome.symbol("✧", "*"), input.skills.len()),
            Command::Skills,
        ));
    }
    if matches!(
        state.phase,
        Phase::Editing | Phase::Uploading | Phase::Ready
    ) {
        let files = input.files.len();
        let add = app.i18n.text("inputs-add");
        tools.push(button(
            "files",
            if files > 0 {
                format!("{add} · {files}")
            } else {
                add
            },
            Command::Attachments,
        ));
    }
    if state.phase == Phase::Editing && !input.resources().is_empty() {
        let command = if state.resources.visible {
            Command::Content
        } else {
            Command::Resources
        };
        tools.push(button("view", app.i18n.text(command.label()), command));
    }
    if tools.is_empty() {
        sheet
    } else {
        sheet.body(Node::row("tools", tools).gap(2))
    }
}

/// Paints the input's text, or the Host detail, over the drawn sheet.
pub(crate) fn draw_field(frame: &mut Frame<'_>, app: &mut App) {
    let editor = app.layer.rect(EDITOR).filter(|rect| !rect.is_empty());
    let problem = app.layer.rect(PROBLEM).filter(|rect| !rect.is_empty());
    let focused = app.layer.focused_path() == Some(EDITOR);
    let colors = app.theme.colors();
    let state = &mut app.revision;
    let editing = state.phase == Phase::Editing;
    match editor {
        Some(rect) => state.editor.draw(frame, rect, editing && focused, colors),
        None => state.editor.invalidate_geometry(),
    }
    if let Some(viewer) = &mut state.problem {
        match problem {
            Some(rect) => viewer.draw(frame, rect, false, colors),
            None => viewer.invalidate_geometry(),
        }
    }
}

impl App {
    /// Shortcuts and the owner-drawn text taken before the sheet: Ctrl+S
    /// runs, Alt+A switches text and resources, Alt+D the display text,
    /// PgUp/PgDn the input; the focused editor takes its keys (Enter breaks
    /// the line), and the Host detail only scrolls.
    pub(crate) fn revision_sheet_input(&mut self, event: &Event) -> Option<(bool, Option<Action>)> {
        if !self.revision.rendered {
            return None;
        }
        let focused = self.layer.focused_path().map(str::to_owned);
        let in_editor = focused.as_deref() == Some(EDITOR);
        let in_problem = focused.as_deref() == Some(PROBLEM);
        let state = &mut self.revision;
        let command = match event {
            Event::Key(key) if key.kind != KeyEventKind::Release => {
                let control = key.modifiers.contains(KeyModifiers::CONTROL);
                let alt = key.modifiers.contains(KeyModifiers::ALT);
                match key.code {
                    KeyCode::Char('s') if control => Command::Send,
                    KeyCode::Char('a') if alt => {
                        if state.resources.visible {
                            Command::Content
                        } else {
                            Command::Resources
                        }
                    }
                    KeyCode::Char('d') if alt => Command::Display,
                    KeyCode::PageUp | KeyCode::PageDown
                        if !state.show_problem && !state.resources.visible =>
                    {
                        Command::Select(if key.code == KeyCode::PageUp {
                            state.selected.saturating_sub(1)
                        } else {
                            state.selected + 1
                        })
                    }
                    _ if matches!(key.code, KeyCode::Esc | KeyCode::Tab | KeyCode::BackTab)
                        || (control && key.code == KeyCode::Char('q')) =>
                    {
                        return None;
                    }
                    _ if in_editor => {
                        self.revision_edit(event);
                        return Some((true, None));
                    }
                    _ if in_problem
                        && matches!(
                            key.code,
                            KeyCode::Left
                                | KeyCode::Right
                                | KeyCode::Up
                                | KeyCode::Down
                                | KeyCode::Home
                                | KeyCode::End
                        ) =>
                    {
                        let changed = state
                            .problem
                            .as_mut()
                            .is_some_and(|problem| problem.key(*key));
                        return Some((changed, None));
                    }
                    _ => return None,
                }
            }
            Event::Paste(_) if in_editor => {
                self.revision_edit(event);
                return Some((true, None));
            }
            // The Host detail is read only.
            Event::Paste(_) if in_problem => return Some((false, None)),
            Event::Mouse(mouse) => {
                let press = matches!(mouse.kind, MouseEventKind::Down(_));
                if state.editor.takes(mouse) && state.phase == Phase::Editing {
                    self.revision_edit(event);
                    if press {
                        self.layer.focus_path(EDITOR);
                    }
                    return Some((true, None));
                }
                let problem = state
                    .problem
                    .as_mut()
                    .filter(|problem| problem.takes(mouse))?;
                let changed = problem.mouse(*mouse);
                if press {
                    self.layer.focus_path(PROBLEM);
                }
                return Some((changed || press, None));
            }
            _ => return None,
        };
        Some((true, self.apply(action(command))))
    }

    fn revision_edit(&mut self, event: &Event) {
        let state = &mut self.revision;
        if state.phase != Phase::Editing
            || state.confirm_discard
            || state.resources.visible
            || state.show_problem
        {
            return;
        }
        let before = state.editor.save();
        match event {
            Event::Key(key) => {
                state.editor.key(*key);
            }
            Event::Paste(text) => {
                state.editor.insert(text);
            }
            Event::Mouse(mouse) => {
                state.editor.mouse(*mouse);
            }
            _ => return,
        }
        if before.text == state.editor.text() {
            return;
        }
        let input = &mut state.saved.as_mut().unwrap().inputs[state.selected];
        match input.replace(state.editor.text().into(), state.display) {
            Ok(()) => state.error = None,
            Err(error) => {
                // Reverse this one edit, preserving the editor's earlier history.
                let redo = matches!(event, Event::Key(key) if key.modifiers.contains(KeyModifiers::CONTROL)
                    && key.code == KeyCode::Char('z') && !key.modifiers.contains(KeyModifiers::SHIFT));
                state.editor.key(KeyEvent::new(
                    if redo {
                        KeyCode::Char('y')
                    } else {
                        KeyCode::Char('z')
                    },
                    KeyModifiers::CONTROL,
                ));
                if state.editor.text() != before.text {
                    state.editor = crate::editor::Editor::restore(before).unwrap();
                }
                state.error = Some(error);
            }
        }
        state.trim_history();
    }
}
