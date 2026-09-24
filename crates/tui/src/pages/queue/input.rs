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
use super::{Command, Kind};
use crate::app::{Action, App, Focus};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

impl App {
    pub fn queue_key(&mut self, key: KeyEvent) -> (bool, Option<Action>) {
        let target = self.queue_selected().map(|row| row.target);
        let command = match key.code {
            KeyCode::Esc | KeyCode::Tab | KeyCode::BackTab => {
                self.focus = Focus::Composer;
                return (true, None);
            }
            KeyCode::Up | KeyCode::Down if key.modifiers.contains(KeyModifiers::ALT) => {
                target.map(|target| Command::Reorder(target, key.code == KeyCode::Down))
            }
            KeyCode::Up | KeyCode::Down => {
                self.queue_move(key.code == KeyCode::Down);
                return (true, None);
            }
            KeyCode::Home | KeyCode::End => {
                let rows = self.queue_rows();
                self.queue.selected = if key.code == KeyCode::Home {
                    rows.first()
                } else {
                    rows.last()
                }
                .map(|row| row.target.entry.clone());
                return (true, None);
            }
            KeyCode::Char('e') | KeyCode::Enter => target.map(Command::Edit),
            KeyCode::Char('x') | KeyCode::Delete => target.map(Command::Retract),
            KeyCode::Char('s') if key.modifiers.is_empty() => target.map(Command::Promote),
            KeyCode::Char('p') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                return (true, self.apply(Action::Palette));
            }
            KeyCode::F(11) => return (true, self.apply(Action::ToggleFullscreen)),
            _ => return (false, None),
        };
        (
            true,
            command.and_then(|command| self.apply(Action::Queue(command))),
        )
    }
    pub fn queue_edit_status(&self) -> Option<String> {
        let edit = self.queue.edit.as_ref()?;
        if let Some((target, key, error)) = &self.queue.error
            && target == &edit.target
        {
            return Some(
                self.i18n
                    .format(key, &[("error", &crate::view::safe(error))]),
            );
        }
        if self.queue_busy() {
            return Some(self.i18n.text("queue-saving"));
        }
        if self
            .queue_row(&edit.target)
            .is_none_or(|row| row.kind == Kind::InFlight)
        {
            return Some(self.i18n.text("queue-changed"));
        }
        if let Some(error) = edit.editor.error {
            return Some(self.i18n.text(error));
        }
        None
    }
}
