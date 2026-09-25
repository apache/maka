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
use crossterm::event::{Event, KeyCode, KeyEventKind, MouseEventKind};
use render::{Effect, Hit, search::Command};

impl Chat {
    pub fn history_scope(&self) -> bool {
        self.view
            .search
            .as_ref()
            .is_some_and(|search| search.history)
    }
    pub fn sync_history(&mut self) {
        if self.history_scope() {
            let history = self.history.get_or_insert_with(Box::default);
            history.changed(
                self.view.search.as_ref().unwrap().editor.text(),
                self.view.trace,
            );
        } else {
            self.history = None;
        }
    }
    pub fn search_command(&mut self, command: Command) {
        self.view.search_command(command);
        self.apply_search_commands();
    }
    fn apply_search_commands(&mut self) {
        self.sync_history();
        for command in self.view.take_search_commands() {
            let Some(history) = &mut self.history else {
                continue;
            };
            match command {
                Command::Restart => history.restart(),
                Command::Pick(sequence) => history.pick(sequence),
                Command::PreviewToggle(key) => {
                    if let Some(preview) = &mut history.preview {
                        preview.toggle(&key);
                    }
                }
                Command::Next | Command::Previous => history.navigate(command == Command::Next),
                _ => {}
            }
        }
    }
    pub fn search_input(&mut self, event: &Event) -> Option<bool> {
        self.sync_history();
        if let Some(history) = &mut self.history {
            match event {
                Event::Key(key)
                    if key.kind != KeyEventKind::Release
                        && matches!(key.code, KeyCode::PageUp | KeyCode::PageDown) =>
                {
                    if let Some(preview) = &mut history.preview {
                        preview.scroll(key.code == KeyCode::PageUp, 8);
                    }
                    return Some(true);
                }
                Event::Mouse(mouse)
                    if matches!(
                        mouse.kind,
                        MouseEventKind::ScrollUp | MouseEventKind::ScrollDown
                    ) =>
                {
                    let point = (mouse.column, mouse.row).into();
                    if history
                        .preview_area
                        .is_some_and(|area| area.contains(point))
                    {
                        if let Some(preview) = &mut history.preview {
                            preview.scroll(mouse.kind == MouseEventKind::ScrollUp, 3);
                        }
                        return Some(true);
                    }
                    if history.list_area.is_some_and(|area| area.contains(point)) {
                        history.navigate(mouse.kind == MouseEventKind::ScrollDown);
                        return Some(true);
                    }
                }
                _ => {}
            }
        }
        let outcome = self.view.search_input(event);
        self.apply_search_commands();
        outcome
    }
    pub fn hit(&self, hit: Hit, preview: bool) -> Option<crate::app::Hit> {
        Some(crate::app::Hit {
            area: hit.area,
            action: self.effect(hit.effect, preview)?,
        })
    }
    pub fn effect(&self, effect: Effect, preview: bool) -> Option<crate::app::Action> {
        use crate::app::Action;
        Some(match effect {
            Effect::Disclosure(key) if preview => Action::Search(Command::PreviewToggle(key)),
            Effect::Disclosure(key) => Action::ToggleMessage(key),
            Effect::Link { key, revision } => {
                Action::CopyFile(self.reader()?.link(&key, &revision)?.into())
            }
        })
    }
    pub fn local_effect(&self, action: &crate::app::Action) -> Option<Effect> {
        use crate::app::Action;
        match action {
            Action::ToggleMessage(key) | Action::Search(Command::PreviewToggle(key)) => {
                Some(Effect::Disclosure(key.clone()))
            }
            Action::CopyFile(path) => self.reader()?.file_effect(path),
            _ => None,
        }
    }
}
