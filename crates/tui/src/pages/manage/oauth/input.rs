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

use super::{
    Command,
    view::{row, row_path},
};
use crate::{app::App, editor::Editor};
use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers, MouseButton, MouseEventKind};
use ratatui::layout::Position;

/// Keys, pastes and pointer presses the connection details rows take before
/// the sheet: a focused row edits its field, Enter moves on to the next row
/// and from the last to Continue, and a press in an editor focuses it.
pub(in crate::pages::manage) fn sheet_input(
    app: &mut App,
    event: &Event,
) -> Option<(bool, Option<crate::app::Action>)> {
    let focused = app
        .layer
        .focused_path()
        .and_then(row)
        .filter(|index| app.oauth_enabled(Command::Field(*index)));
    match event {
        Event::Key(key) if key.kind != KeyEventKind::Release => {
            let index = focused?;
            let quit =
                key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('q');
            if quit
                || matches!(
                    key.code,
                    KeyCode::Esc | KeyCode::Tab | KeyCode::BackTab | KeyCode::Up | KeyCode::Down
                )
            {
                return None;
            }
            if key.code == KeyCode::Enter {
                let next = app.management.oauth.fields().find(|field| *field > index);
                if let Some(next) = next {
                    app.layer.focus_path(&row_path(next));
                } else if app.oauth_enabled(Command::Begin) {
                    app.layer.focus_path("footer/begin");
                }
                return Some((true, None));
            }
            let state = &mut app.management.oauth;
            if !matches!(key.code, KeyCode::Char(c) if c.is_control()) {
                state.identity.fields[index].key(*key);
            }
            state.error = None;
            Some((true, None))
        }
        Event::Paste(text) => {
            let index = focused?;
            let state = &mut app.management.oauth;
            let editor = &mut state.identity.fields[index];
            // Name and ID are one line; configuration and input are JSON.
            if index < 2 && text.chars().any(char::is_control) {
                editor.error = Some("oauth-field-invalid");
            } else {
                editor.insert(text);
            }
            state.error = None;
            Some((true, None))
        }
        Event::Mouse(mouse) => {
            let point = Position::new(mouse.column, mouse.row);
            let fields = &app.management.oauth.identity.fields;
            let index = fields
                .iter()
                .position(Editor::dragging)
                .or_else(|| fields.iter().position(|editor| editor.contains(point)))
                .filter(|index| app.oauth_enabled(Command::Field(*index)))?;
            let changed = app.management.oauth.identity.fields[index].mouse(*mouse);
            if mouse.kind == MouseEventKind::Down(MouseButton::Left) {
                app.layer.focus_path(&row_path(index));
                return Some((true, None));
            }
            Some((changed, None))
        }
        _ => None,
    }
}
