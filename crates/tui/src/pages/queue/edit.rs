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
    ui::{Role, Sheet, Tone},
};
use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers};
use ratatui::{Frame, layout::Position};

const FIELD: &str = "message";

/// Editing a queued message: a multi-line field where Enter breaks the
/// line, so saving is the button, Ctrl+S or Ctrl+Enter.
pub(crate) fn sheet(app: &App) -> Option<Sheet<Action>> {
    let edit = app.queue.edit.as_ref()?;
    let (width, height) = app.frame_size.unwrap_or((80, 24));
    let most = height.saturating_sub(14).clamp(3, 10);
    let rows = edit
        .editor
        .rows(crate::ui::content_width(width))
        .clamp(3, most);
    let mut sheet = Sheet::new(
        format!("queue-edit:{}", edit.target.entry),
        app.i18n.text("queue-edit"),
    )
    .field(FIELD, None, rows, Action::Queue(Command::Save), true);
    if let Some(status) = app.queue_edit_status() {
        sheet = sheet.text("status", &status, Tone::Warning);
    }
    Some(
        sheet
            .button(
                "cancel",
                app.i18n.text("queue-close"),
                Role::Normal,
                Action::Queue(Command::Close),
                true,
            )
            .button(
                "save",
                app.i18n.text("queue-save"),
                Role::Primary,
                Action::Queue(Command::Save),
                app.queue_enabled(&Command::Save),
            ),
    )
}

pub(crate) fn draw_field(frame: &mut Frame<'_>, app: &mut App) {
    let rect = app.layer.slot(FIELD).filter(|rect| !rect.is_empty());
    let focused = app.layer.focused(FIELD);
    let colors = app.theme.colors();
    let Some(edit) = &mut app.queue.edit else {
        return;
    };
    match rect {
        Some(rect) => edit.editor.draw(frame, rect, focused, colors),
        None => edit.editor.invalidate_geometry(),
    }
}

impl App {
    /// Input the field takes before the sheet: every key but the sheet's own
    /// (Esc, Tab, quitting) while focused, Enter included, pastes and its
    /// pointer. Saving by chord needs the sheet on screen.
    pub(crate) fn queue_edit_sheet_input(
        &mut self,
        event: &Event,
    ) -> Option<(bool, Option<Action>)> {
        self.layer.slot(FIELD)?;
        let focused = self.layer.focused(FIELD);
        let edit = self.queue.edit.as_mut()?;
        match event {
            Event::Key(key) if key.kind != KeyEventKind::Release => {
                let control = key.modifiers.contains(KeyModifiers::CONTROL);
                if control && matches!(key.code, KeyCode::Char('s') | KeyCode::Enter) {
                    return Some((true, self.apply(Action::Queue(Command::Save))));
                }
                if !focused
                    || matches!(key.code, KeyCode::Esc | KeyCode::Tab | KeyCode::BackTab)
                    || (control && key.code == KeyCode::Char('q'))
                {
                    return None;
                }
                Some((edit.editor.key(*key), None))
            }
            Event::Paste(text) if focused => Some((edit.editor.insert(text), None)),
            Event::Mouse(mouse)
                if edit.editor.contains(Position::new(mouse.column, mouse.row))
                    || edit.editor.dragging() =>
            {
                let changed = edit.editor.mouse(*mouse);
                self.layer.focus(FIELD);
                Some((changed || !focused, None))
            }
            _ => None,
        }
    }
}
