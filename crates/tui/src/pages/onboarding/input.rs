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
    Action, App, Command,
    view::{row, row_path},
};
use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers, MouseButton, MouseEventKind};

impl App {
    /// The setup form's rows take their keys, pastes and pointer before the
    /// sheet: Enter moves on to the next row and from the last to Verify.
    pub(crate) fn onboarding_sheet_input(
        &mut self,
        event: &Event,
    ) -> Option<(bool, Option<Action>)> {
        if !self.onboarding_enabled(&Command::Field(0)) {
            return None;
        }
        let focused = self.layer.focused_path().and_then(row);
        let f = self.onboarding.dialog.as_mut()?;
        match event {
            Event::Key(key) if key.kind != KeyEventKind::Release => {
                let index = focused?;
                if matches!(
                    key.code,
                    KeyCode::Esc | KeyCode::Tab | KeyCode::BackTab | KeyCode::Up | KeyCode::Down
                ) || (key.modifiers.contains(KeyModifiers::CONTROL)
                    && key.code == KeyCode::Char('q'))
                {
                    return None;
                }
                if key.code == KeyCode::Enter {
                    if index + 1 < f.fields.len() {
                        self.layer.focus_path(&row_path(index + 1));
                    } else if self.onboarding_enabled(&Command::Verify) {
                        self.layer.focus_path("footer/verify");
                    }
                    return Some((true, None));
                }
                if matches!(key.code, KeyCode::Char(c) if c.is_control()) {
                    return Some((false, None));
                }
                let changed = f.fields[index].key(*key);
                if changed {
                    f.error = None;
                }
                Some((changed, None))
            }
            Event::Paste(text) => {
                let index = focused?;
                // Only the configuration is JSON; the rest are one line.
                if index != 1 && text.chars().any(char::is_control) {
                    f.error = Some("onboard-field-invalid");
                    return Some((true, None));
                }
                let changed = f.fields[index].insert(text);
                f.error = None;
                Some((changed, None))
            }
            Event::Mouse(mouse) => {
                let index = f.fields.iter().position(|editor| editor.takes(mouse))?;
                let changed = f.fields[index].mouse(*mouse);
                if mouse.kind == MouseEventKind::Down(MouseButton::Left) {
                    self.layer.focus_path(&row_path(index));
                    return Some((true, None));
                }
                Some((changed, None))
            }
            _ => None,
        }
    }
}
