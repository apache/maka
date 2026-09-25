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

impl Transcript {
    /// Explicit selection only; the shell retains any mutation authority.
    pub fn selected(&self) -> Option<SelectedBlock<'_>> {
        let key = self
            .selected
            .as_ref()
            .filter(|key| self.order.contains(key))?;
        let block = self.blocks.get(key)?;
        Some(SelectedBlock {
            key,
            revision: &block.revision,
            text: &block.text,
        })
    }
    pub fn file_effect(&self, path: &str) -> Option<Effect> {
        self.order.iter().find_map(|key| {
            let block = self.blocks.get(key)?;
            (block.file.as_ref()?.path == path).then(|| Effect::Link {
                key: key.clone(),
                revision: block.revision.clone(),
            })
        })
    }
    pub fn link(&self, key: &MessageKey, revision: &Revision) -> Option<&str> {
        let block = self.blocks.get(key)?;
        (&block.revision == revision)
            .then(|| block.file.as_ref().map(|file| file.path.as_str()))
            .flatten()
    }
    pub fn selection(&self) -> Option<MessageKey> {
        self.selected
            .as_ref()
            .filter(|key| self.order.contains(key))
            .cloned()
            .or_else(|| self.first_visible())
    }

    pub fn select(&mut self, key: MessageKey) {
        self.text_selection.clear();
        self.mouse_selected = false;
        let Some(index) = self.order.iter().position(|candidate| candidate == &key) else {
            return;
        };
        if !self.contains(&key) {
            return;
        }
        self.selected = Some(key);
        // Move only far enough to reveal the header. Choosing a message is a
        // reading action even when the entire short conversation fits onscreen.
        if let Some(&start) = self.starts.get(index) {
            let top = if start < self.top {
                start
            } else if start >= self.top + self.height {
                start.saturating_sub(self.height.saturating_sub(1))
            } else {
                self.top
            };
            self.anchor = self.position(top);
        }
    }

    pub fn enter(&mut self) {
        if let Some(key) = self.selection() {
            self.select(key);
        }
    }

    pub fn move_selection(&mut self, forward: bool) {
        let choices: Vec<_> = self
            .order
            .iter()
            .filter(|key| self.contains(key))
            .cloned()
            .collect();
        if choices.is_empty() {
            return;
        }
        let current = self
            .selection()
            .and_then(|key| choices.iter().position(|candidate| candidate == &key))
            .unwrap_or(0);
        let next = if forward {
            (current + 1).min(choices.len() - 1)
        } else {
            current.saturating_sub(1)
        };
        self.select(choices[next].clone());
    }

    pub fn first(&mut self) {
        if let Some(key) = self.order.iter().find(|key| self.contains(key)).cloned() {
            self.select(key);
        }
    }

    /// Tree-style left/right navigation. A returned key needs its disclosure toggled.
    pub fn horizontal(&mut self, open: bool) -> Option<MessageKey> {
        let key = self.selection()?;
        if self.folded(&key) == open {
            return Some(key);
        }
        let target = if open {
            self.groups.get(&key).and_then(|members| members.first())
        } else {
            self.membership.get(&key)
        }
        .cloned();
        if let Some(target) = target {
            self.select(target);
        }
        None
    }

    pub(super) fn visible_key(&self, key: &MessageKey) -> Option<MessageKey> {
        if self.order.contains(key) {
            return Some(key.clone());
        }
        let replacement = if self.trace && key.part.members().is_some() {
            self.groups.get(key).and_then(|members| members.first())
        } else {
            self.membership.get(key)
        }?;
        self.order
            .contains(replacement)
            .then(|| replacement.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::Action;
    use crate::{
        app::{App, Focus},
        i18n::{Locale, LocalePreference},
        navigation::Route,
    };
    use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
    use ratatui::{Terminal, backend::TestBackend};
    use serde_json::json;

    fn frame(app: &mut App) {
        app.chat.view.focused = app.focus == Focus::Transcript;
        let mut terminal = Terminal::new(TestBackend::new(60, 20)).unwrap();
        terminal
            .draw(|frame| {
                app.chat.view.draw(frame, frame.area(), false).unwrap();
            })
            .unwrap();
    }
    fn key(app: &mut App, code: KeyCode) {
        app.input(Event::Key(KeyEvent::new(code, KeyModifiers::NONE)));
        frame(app);
    }

    #[test]
    fn transcript_scope_reaches_nested_tools_without_scrolling_and_survives_projection_changes() {
        let i18n = I18n::new(LocalePreference::Explicit(Locale::En), Locale::En);
        let mut app = App::new("/unconfigured".into(), i18n);
        app.apply(Action::Visit(Route::Session("session".into())));
        let mut rows = BTreeMap::from([
            (
                10,
                json!({"type":"user","id":"user","turnId":"t","text":"Question"}),
            ),
            (
                20,
                json!({"type":"assistant","id":"assistant","turnId":"t","text":"Inspecting"}),
            ),
        ]);
        for (seq, id) in [(30, "a"), (40, "b")] {
            rows.insert(seq, json!({"type":"tool_call","id":id,"turnId":"t","toolName":"Read","origin":"provider","args":{"path":format!("{id}.txt")}}));
            rows.insert(seq + 50, json!({"type":"tool_result","id":format!("r-{id}"),"turnId":"t","toolUseId":id,"origin":"provider","isError":false,"content":{"kind":"text","text":"File body"}}));
        }
        app.chat.view.sync(&rows, &[], 0, &app.i18n, false);
        frame(&mut app);
        key(&mut app, KeyCode::Tab);
        assert_eq!(app.focus, Focus::Transcript);
        key(&mut app, KeyCode::Down);
        key(&mut app, KeyCode::Down);
        let group = app.chat.view.selection().unwrap();
        assert_eq!(group.part, Part::Activity);
        assert_eq!(
            app.chat.view.top, 0,
            "short transcripts need no artificial scrolling"
        );
        key(&mut app, KeyCode::Enter);
        key(&mut app, KeyCode::Right);
        let first = app.chat.view.selection().unwrap();
        assert_eq!(first.message, "a");
        key(&mut app, KeyCode::Enter);
        assert!(!app.chat.view.folded(&first));
        app.apply(Action::Palette);
        key(&mut app, KeyCode::Down);
        key(&mut app, KeyCode::Esc);
        assert_eq!(app.chat.view.selection(), Some(first.clone()));
        assert_eq!(app.focus, Focus::Transcript);
        rows.insert(
            1,
            json!({"type":"user","id":"older","turnId":"old","text":"Earlier page"}),
        );
        rows.insert(
            100,
            json!({"type":"assistant","id":"later","turnId":"t","text":"Later output"}),
        );
        app.chat.view.sync(&rows, &[], 0, &app.i18n, false);
        frame(&mut app);
        assert_eq!(app.chat.view.selection(), Some(first.clone()));
        assert!(!app.chat.view.following());
        let mut narrow = Terminal::new(TestBackend::new(8, 6)).unwrap();
        narrow
            .draw(|frame| {
                app.chat.view.draw(frame, frame.area(), false).unwrap();
            })
            .unwrap();
        let index = app
            .chat
            .view
            .order
            .iter()
            .position(|key| key == &first)
            .unwrap();
        assert!((app.chat.view.top..app.chat.view.top + 6).contains(&app.chat.view.starts[index]));
        frame(&mut app);
        key(&mut app, KeyCode::Left);
        assert!(app.chat.view.folded(&first));
        key(&mut app, KeyCode::Left);
        assert_eq!(app.chat.view.selection(), Some(group.clone()));
        key(&mut app, KeyCode::Char(' '));
        assert!(app.chat.view.folded(&group));
        key(&mut app, KeyCode::Tab);
        assert_eq!(app.focus, Focus::Header);
        key(&mut app, KeyCode::BackTab);
        assert_eq!(app.focus, Focus::Transcript);
        key(&mut app, KeyCode::BackTab);
        assert_eq!(app.focus, Focus::Composer);
        app.input(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::SHIFT,
        )));
        assert_eq!(app.drafts["session"].text(), "\n");
        assert!(app.chat.view.folded(&group));
        app.apply(Action::BrowseTranscript);
        key(&mut app, KeyCode::Esc);
        assert_eq!(app.focus, Focus::Page);
        assert_eq!(app.navigation.current(), Route::Session("session".into()));
        app.apply(Action::BrowseTranscript);
        app.apply(Action::ToggleDetails);
        assert_eq!(
            app.focus,
            Focus::Page,
            "hidden transcript cannot keep keyboard capture"
        );
        app.input(Event::Key(KeyEvent::new(
            KeyCode::Char(' '),
            KeyModifiers::NONE,
        )));
        assert!(app.chat.view.folded(&group));
    }
}
