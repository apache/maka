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
use crate::{
    app::{Action, App, Focus},
    navigation::Route,
};
use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEventKind};

impl App {
    pub(crate) fn queue_surface_invalidate(&mut self) {
        self.queue.area = None;
        self.queue.surface.invalidate();
    }

    pub(crate) fn queue_surface_input(&mut self, event: &Event) -> Option<(bool, Option<Action>)> {
        let Event::Mouse(mouse) = event else {
            return None;
        };
        let Route::Session(session) = self.navigation.current() else {
            return None;
        };
        self.queue.area?;
        if self.overlay().is_some()
            || self
                .chat
                .reader()
                .is_some_and(|reader| reader.text_selection.dragging())
            || self
                .drafts
                .get(&session)
                .is_some_and(|editor| editor.dragging())
        {
            return None;
        }
        let outcome = self.queue.surface.input(event);
        if !outcome.consumed {
            return None;
        }
        let shell_hover = self.hover.take().is_some();
        let redraw = outcome.redraw || shell_hover;
        self.hover_area = None;
        if outcome.message.is_some() && mouse.kind == MouseEventKind::Down(MouseButton::Left) {
            self.chat
                .search_command(crate::ui::transcript::search::Command::Close);
        }
        let action = outcome
            .message
            .and_then(|command| self.apply(Action::Queue(command)));
        Some((redraw || action.is_some(), action))
    }

    pub fn queue_key(&mut self, key: KeyEvent) -> (bool, Option<Action>) {
        self.queue.surface.input(&Event::FocusLost);
        let Some(target) = self.queue_selected().map(|row| row.target) else {
            // The projection may consume an entry before the next frame.
            self.queue.selected = None;
            self.focus = Focus::Composer;
            return (true, None);
        };
        let command = match key.code {
            KeyCode::Esc | KeyCode::Tab | KeyCode::BackTab => {
                self.focus = Focus::Composer;
                return (true, None);
            }
            KeyCode::Up | KeyCode::Down if key.modifiers.contains(KeyModifiers::ALT) => {
                Some(Command::Reorder(target, key.code == KeyCode::Down))
            }
            KeyCode::Up | KeyCode::Down => {
                self.queue_move(key.code == KeyCode::Down);
                return (true, None);
            }
            KeyCode::Home | KeyCode::End => {
                let rows = self.queue_rows();
                if let Some(row) = if key.code == KeyCode::Home {
                    rows.first()
                } else {
                    rows.last()
                } {
                    self.queue.selected = Some(row.target.entry.clone());
                    self.queue
                        .surface
                        .focus_within(row.target.control_key("preview"));
                }
                return (true, None);
            }
            KeyCode::Char('e') | KeyCode::Enter => Some(Command::Edit(target)),
            KeyCode::Char('x') | KeyCode::Delete => Some(Command::Retract(target)),
            KeyCode::Char('s') if key.modifiers.is_empty() => Some(Command::Promote(target)),
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
