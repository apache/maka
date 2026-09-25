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

impl Editor {
    // A proposed edit owns only today's text and the single history record it
    // will use. Replaying an accepted event preserves the real journal/geometry.
    fn preview(&self, undo: Option<bool>) -> Self {
        let mut preview = Self {
            byte_limit: self.byte_limit,
            limit_error: self.limit_error,
            text: self.text.clone(),
            selection: self.selection,
            layout: Layout::new(&self.text, self.layout.width),
            ..Self::default()
        };
        let record = match undo {
            Some(true) => self.redo.last(),
            Some(false) => self.undo.back(),
            None => None,
        };
        if let Some(record) = record {
            let edit = Edit {
                start: record.start,
                removed: record.removed.clone(),
                inserted: record.inserted.clone(),
                before: record.before,
                after: record.after,
            };
            preview.history_bytes = edit.bytes();
            if undo == Some(true) {
                preview.redo.push(edit);
            } else {
                preview.undo.push_back(edit);
            }
        }
        preview
    }

    pub(crate) fn preview_key_text(&self, key: KeyEvent) -> Option<String> {
        let control = key.modifiers.contains(KeyModifiers::CONTROL);
        let undo = match (control, key.code) {
            (true, KeyCode::Char('z')) => Some(key.modifiers.contains(KeyModifiers::SHIFT)),
            (true, KeyCode::Char('y')) => Some(true),
            (_, KeyCode::Backspace | KeyCode::Delete | KeyCode::Enter) => None,
            (false, KeyCode::Char(_)) => None,
            // Movement/selection never clone or encode a draft.
            _ => return None,
        };
        let mut preview = self.preview(undo);
        preview.key(key);
        (preview.text != self.text).then_some(preview.text)
    }

    pub(crate) fn preview_insert_text(&self, text: &str) -> Option<String> {
        let mut preview = self.preview(None);
        preview.insert(text);
        (preview.text != self.text).then_some(preview.text)
    }
}

impl Selection {
    pub(crate) fn largest(text: &str) -> Self {
        Self {
            cursor: text.len(),
            // JSON null occupies four bytes, longer than a short offset.
            anchor: (text.len() >= 1000).then_some(text.len()),
            upstream: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserved_cursor_bounds_null_and_every_numeric_selection() {
        for length in [0, 9, 99, 999, 1000, 10000] {
            let text = "x".repeat(length);
            let largest = serde_json::to_vec(&Selection::largest(&text))
                .unwrap()
                .len();
            for cursor in [0, length] {
                for anchor in [None, Some(0), Some(length)] {
                    for upstream in [false, true] {
                        let selection = Selection {
                            cursor,
                            anchor,
                            upstream,
                        };
                        selection.validate(&text).unwrap();
                        assert!(serde_json::to_vec(&selection).unwrap().len() <= largest);
                    }
                }
            }
        }
    }

    #[test]
    fn preview_leaves_selection_and_full_history_until_the_event_is_accepted() {
        let mut editor = Editor::default();
        editor.insert("中文");
        editor.insert(" one");
        editor.insert(" two");
        editor.key(KeyEvent::new(KeyCode::Left, KeyModifiers::SHIFT));
        let cursor = editor.cursor();
        let retained = editor.retained_bytes();
        let key = KeyEvent::new(KeyCode::Char('z'), KeyModifiers::CONTROL);
        let proposed = editor.preview_key_text(key).unwrap();
        assert_eq!(editor.text(), "中文 one two");
        assert_eq!(editor.cursor(), cursor);
        assert_eq!(editor.retained_bytes(), retained);
        editor.key(key);
        assert_eq!(editor.text(), proposed);
        let redo = KeyEvent::new(KeyCode::Char('y'), KeyModifiers::CONTROL);
        let proposed = editor.preview_key_text(redo).unwrap();
        editor.key(redo);
        assert_eq!(editor.text(), proposed);
        assert!(
            editor
                .preview_key_text(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE))
                .is_none()
        );
    }
}
