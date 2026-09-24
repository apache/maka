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

use super::{State, saved};
use crate::editor::{Editor, saved::Saved};
use std::collections::BTreeMap;

// Each widget also has its own bound. This shared budget prevents switching
// through 64 inputs from retaining 64 independent megabytes of undo data.
const HISTORY_BYTES: usize = 4 * 1024 * 1024;

impl State {
    pub(super) fn capture_view(&self) -> saved::View {
        let mut positions: BTreeMap<_, _> = self
            .saved
            .as_ref()
            .map(|s| &s.view)
            .into_iter()
            .flat_map(|view| &view.positions)
            .map(|p| ((p.input, p.display), p.cursor))
            .collect();
        for (key, editor) in &self.editors {
            positions.insert(*key, editor.cursor());
        }
        positions.insert((self.selected, self.display), self.editor.cursor());
        saved::View {
            selected: self.selected,
            display: self.display,
            positions: positions
                .into_iter()
                .map(|((input, display), cursor)| saved::Position {
                    input,
                    display,
                    cursor,
                })
                .collect(),
        }
    }
    pub(super) fn clear_editors(&mut self) {
        self.resources = Default::default();
        self.problem = None;
        self.show_problem = false;
        self.editors.clear();
        self.editor = Editor::default();
    }
    pub(super) fn switch_editor(&mut self, selected: usize, display: bool) {
        if (self.selected, self.display) == (selected, display) {
            return;
        }
        self.editor.invalidate_geometry();
        self.editors.push_back((
            (self.selected, self.display),
            std::mem::take(&mut self.editor),
        ));
        self.resources = Default::default();
        self.selected = selected;
        self.display = display;
        self.load_editor();
        self.trim_history();
    }
    pub(super) fn trim_history(&mut self) {
        let history = |editor: &Editor| editor.retained_bytes() - editor.text().len();
        let mut bytes =
            history(&self.editor) + self.editors.iter().map(|(_, e)| history(e)).sum::<usize>();
        for (_, editor) in &mut self.editors {
            if bytes <= HISTORY_BYTES {
                break;
            }
            bytes -= history(editor);
            editor.clear_history();
        }
    }
    pub(super) fn load_editor(&mut self) {
        let key = (self.selected, self.display);
        if let Some(index) = self.editors.iter().position(|(other, _)| *other == key) {
            self.editor = self.editors.remove(index).unwrap().1;
        } else {
            let saved = self.saved.as_ref().expect("loaded revision");
            let input = &saved.inputs[self.selected];
            let text = if self.display {
                input
                    .content
                    .display_text
                    .as_deref()
                    .expect("display field")
            } else {
                &input.content.text
            };
            self.editor = Editor::restore(Saved {
                text: text.into(),
                cursor: 0,
                anchor: None,
                upstream: false,
            })
            .expect("validated revision text");
            if let Some(position) = saved
                .view
                .positions
                .iter()
                .find(|p| (p.input, p.display) == key)
            {
                self.editor
                    .restore_cursor(position.cursor)
                    .expect("validated revision cursor");
            }
        }
        self.invalidate_geometry();
    }
}

#[cfg(test)]
mod tests {
    use super::super::{
        Action, Command, Output,
        tests::{frame, sources},
    };
    use super::*;
    use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};

    #[test]
    fn switching_preserves_independent_selections_and_undo_while_restart_restores_positions() {
        let (mut app, basis) = crate::pages::branch::tests::fixture();
        app.apply(Action::Revision(Command::Open(basis)));
        let request = app.revision_request().unwrap();
        let mut source = sources("source");
        source.messages[1].content.display_text = Some("shown".into());
        app.revision_completed(request, Ok(Output::Sources(source)));
        frame(&mut app, 80, 24);
        app.input(Event::Paste("中文".into()));
        app.input(Event::Key(KeyEvent::new(
            KeyCode::Left,
            KeyModifiers::SHIFT,
        )));
        let first = app.revision.editor.cursor();
        app.apply(Action::Revision(Command::Select(1)));
        frame(&mut app, 80, 24);
        app.input(Event::Paste("second edit ".into()));
        app.apply(Action::Revision(Command::Display));
        frame(&mut app, 80, 24);
        app.input(Event::Paste("显示".into()));
        app.input(Event::Key(KeyEvent::new(
            KeyCode::Home,
            KeyModifiers::SHIFT,
        )));
        let display = app.revision.editor.cursor();
        app.apply(Action::Revision(Command::Select(0)));
        assert_eq!(app.revision.editor.cursor(), first);
        frame(&mut app, 80, 24);
        app.input(Event::Key(KeyEvent::new(
            KeyCode::Char('z'),
            KeyModifiers::CONTROL,
        )));
        assert_eq!(app.revision.editor.text(), "🦀 @a.rs first");
        app.input(Event::Key(KeyEvent::new(
            KeyCode::Char('y'),
            KeyModifiers::CONTROL,
        )));
        app.apply(Action::Revision(Command::Select(1)));
        frame(&mut app, 80, 24);
        app.apply(Action::Revision(Command::Display));
        assert_eq!(app.revision.editor.cursor(), display);
        let saved = app.revision.checkpoint().unwrap();
        saved.validate("root").unwrap();
        let value = serde_json::to_value(&saved).unwrap();
        for (pointer, invalid) in [
            ("/view/positions/0/input", serde_json::json!(2)),
            ("/view/positions/0/display", serde_json::json!(true)),
            ("/view/positions/2/cursor/cursor", serde_json::json!(1)),
            ("/view/selected", serde_json::json!(2)),
        ] {
            let mut malformed = value.clone();
            *malformed.pointer_mut(pointer).unwrap() = invalid;
            assert!(
                serde_json::from_value::<super::super::Checkpoint>(malformed)
                    .unwrap()
                    .validate("root")
                    .is_err(),
                "{pointer}"
            );
        }
        let mut duplicate = value.clone();
        duplicate["view"]["positions"]
            .as_array_mut()
            .unwrap()
            .push(value["view"]["positions"][0].clone());
        assert!(
            serde_json::from_value::<super::super::Checkpoint>(duplicate)
                .unwrap()
                .validate("root")
                .is_err()
        );
        app.revision = State::default();
        app.revision.restore(saved);
        assert!(!app.revision.visible);
        assert!(app.revision_request().is_none());
        assert_eq!(app.revision.selected, 1);
        assert!(app.revision.display);
        assert_eq!(app.revision.editor.cursor(), display);
        assert_eq!(
            app.revision.editor.retained_bytes(),
            app.revision.editor.text().len()
        );
        app.apply(Action::Revision(Command::Resume));
        frame(&mut app, 80, 24);
        app.input(Event::Paste("新".into()));
        assert_eq!(app.revision.editor.text(), "新shown");
        app.apply(Action::Revision(Command::Select(0)));
        assert_eq!(app.revision.editor.text(), "中文🦀 @a.rs first");
    }

    #[test]
    fn shared_history_budget_evicts_old_undo_without_losing_text_or_selection() {
        let mut state = State::default();
        for n in 0..7 {
            let mut editor = Editor::default();
            editor.preferred_height(80, 5);
            for letter in ['a', 'b', 'c'] {
                editor.key(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::CONTROL));
                editor.insert(&letter.to_string().repeat(180_000));
            }
            editor.key(KeyEvent::new(KeyCode::Home, KeyModifiers::SHIFT));
            state.editors.push_back(((n, false), editor));
        }
        let cursors: Vec<_> = state.editors.iter().map(|(_, e)| e.cursor()).collect();
        state.trim_history();
        assert!(
            state
                .editors
                .iter()
                .map(|(_, e)| e.retained_bytes() - e.text().len())
                .sum::<usize>()
                <= HISTORY_BYTES
        );
        for ((_, editor), cursor) in state.editors.iter().zip(cursors) {
            assert_eq!(editor.cursor(), cursor);
            assert_eq!(editor.text(), "c".repeat(180_000));
        }
        let oldest = &mut state.editors.front_mut().unwrap().1;
        assert_eq!(oldest.retained_bytes(), oldest.text().len());
        oldest.key(KeyEvent::new(KeyCode::Char('z'), KeyModifiers::CONTROL));
        assert_eq!(oldest.text(), "c".repeat(180_000));
        let newest = &mut state.editors.back_mut().unwrap().1;
        newest.key(KeyEvent::new(KeyCode::Char('z'), KeyModifiers::CONTROL));
        assert_eq!(newest.text(), "b".repeat(180_000));
    }
}
