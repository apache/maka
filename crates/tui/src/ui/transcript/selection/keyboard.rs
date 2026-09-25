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
use crossterm::event::KeyCode;

#[derive(Clone, PartialEq, Eq)]
pub(super) struct Caret {
    pub key: MessageKey,
    pub offset: usize,
    /// A soft-wrap boundary can belong to the preceding visual line's end.
    pub trailing: bool,
}
#[derive(Clone)]
pub(super) struct Extent {
    pub anchor: Caret,
    pub head: Caret,
    pub column: Option<usize>,
}
impl Transcript {
    /// Shift movement edits a text range, never the selected card's disclosure.
    pub fn selection_key(&mut self, key: KeyCode) -> Option<bool> {
        if !matches!(
            key,
            KeyCode::Left
                | KeyCode::Right
                | KeyCode::Up
                | KeyCode::Down
                | KeyCode::Home
                | KeyCode::End
        ) {
            return None;
        }
        let area = self.text_selection.area?;
        let mut extent = self.text_selection.extent.clone().or_else(|| {
            let selected = self.selection()?;
            let row = self
                .text_selection
                .rows
                .iter()
                .find(|row| row.key == selected)
                .or_else(|| self.text_selection.rows.first())?;
            let span = self.blocks[&row.key].layout.as_ref()?.lines[row.index]
                .mapping
                .first()?;
            let caret = Caret {
                key: row.key.clone(),
                offset: span.logical.start,
                trailing: false,
            };
            Some(Extent {
                anchor: caret.clone(),
                head: caret,
                column: None,
            })
        })?;
        let previous = extent.head.clone();
        match key {
            KeyCode::Left | KeyCode::Right => {
                extent.column = None;
                extent.head = self.horizontal_caret(&extent.head, key == KeyCode::Right)?;
            }
            _ => {
                let (block, line, column) = self.caret_position(&extent.head)?;
                if matches!(key, KeyCode::Home | KeyCode::End) {
                    extent.column = None;
                    extent.head = self.line_caret(
                        block,
                        line,
                        if key == KeyCode::Home { 0 } else { usize::MAX },
                    )?;
                } else {
                    let column = *extent.column.get_or_insert(column);
                    if let Some((block, line)) =
                        self.adjacent_text_line(block, line, key == KeyCode::Down)
                    {
                        extent.head = self.line_caret(block, line, column)?;
                    }
                }
            }
        }
        let changed = extent.head != previous;
        if let Some((block, line, _)) = self.caret_position(&extent.head) {
            let row = self.starts[block] + line;
            self.top = if row < self.top {
                row
            } else if row >= self.top + self.height {
                row.saturating_sub(self.height.saturating_sub(1))
            } else {
                self.top
            }
            .min(self.total.saturating_sub(self.height));
            self.anchor = self.position(self.top);
        }
        self.selected = Some(extent.head.key.clone());
        self.mouse_selected = true;
        self.select_extent(extent);
        self.selection_geometry(area);
        Some(changed)
    }

    fn horizontal_caret(&self, caret: &Caret, forward: bool) -> Option<Caret> {
        let text = &self.blocks.get(&caret.key)?.layout.as_ref()?.text;
        let offset = if forward {
            text.get(caret.offset..)?
                .graphemes(true)
                .next()
                .map(|glyph| caret.offset + glyph.len())
        } else {
            text.get(..caret.offset)?
                .graphemes(true)
                .next_back()
                .map(|glyph| caret.offset - glyph.len())
        };
        if let Some(offset) = offset {
            return Some(Caret {
                key: caret.key.clone(),
                offset,
                trailing: forward,
            });
        }
        let mut index = self.order.iter().position(|key| key == &caret.key)?;
        loop {
            index = if forward {
                index.checked_add(1)?
            } else {
                match index.checked_sub(1) {
                    Some(index) => index,
                    None => return Some(caret.clone()),
                }
            };
            let Some(key) = self.order.get(index) else {
                return Some(caret.clone());
            };
            let text = &self.blocks[key].layout.as_ref()?.text;
            if let Some((offset, glyph)) = if forward {
                text.grapheme_indices(true).next()
            } else {
                text.grapheme_indices(true).next_back()
            } {
                return Some(Caret {
                    key: key.clone(),
                    offset: if forward {
                        offset + glyph.len()
                    } else {
                        offset
                    },
                    trailing: forward,
                });
            }
        }
    }

    fn caret_position(&self, caret: &Caret) -> Option<(usize, usize, usize)> {
        let block = self.order.iter().position(|key| key == &caret.key)?;
        let layout = self.blocks[&caret.key].layout.as_ref()?;
        let mut trailing = None;
        let mut nearest = None;
        for (row, visual) in layout.lines.iter().enumerate() {
            let text = visual.line.to_string();
            for span in &visual.mapping {
                for (logical, display) in [
                    (span.logical.start, span.display.start),
                    (span.logical.end, span.display.end),
                ] {
                    let distance = caret.offset.abs_diff(logical);
                    if nearest.as_ref().is_none_or(|(old, _)| distance < *old) {
                        nearest = Some((distance, (block, row, text[..display].width())));
                    }
                }
                if span.logical.contains(&caret.offset) || span.logical.end == caret.offset {
                    let byte = if span.logical.len() == span.display.len() {
                        span.display.start + caret.offset - span.logical.start
                    } else if caret.offset == span.logical.end {
                        span.display.end
                    } else {
                        span.display.start
                    };
                    let column = text.get(..byte)?.width();
                    let position = (block, row, column);
                    if span.logical.contains(&caret.offset)
                        || (caret.trailing && span.logical.end == caret.offset)
                    {
                        return Some(position);
                    }
                    trailing = Some(position);
                }
            }
        }
        trailing.or_else(|| nearest.map(|(_, position)| position))
    }

    fn adjacent_text_line(
        &self,
        mut block: usize,
        mut line: usize,
        forward: bool,
    ) -> Option<(usize, usize)> {
        loop {
            let layout = self.blocks[&self.order[block]].layout.as_ref()?;
            if forward {
                line += 1;
                if line >= layout.lines.len() {
                    block += 1;
                    self.order.get(block)?;
                    line = 0;
                }
            } else if line == 0 {
                block = block.checked_sub(1)?;
                line = self.blocks[&self.order[block]]
                    .layout
                    .as_ref()?
                    .lines
                    .len()
                    .checked_sub(1)?;
            } else {
                line -= 1;
            }
            if !self.blocks[&self.order[block]].layout.as_ref()?.lines[line]
                .mapping
                .is_empty()
            {
                return Some((block, line));
            }
        }
    }

    fn line_caret(&self, block: usize, row: usize, column: usize) -> Option<Caret> {
        let key = &self.order[block];
        let visual = &self.blocks[key].layout.as_ref()?.lines[row];
        let text = visual.line.to_string();
        let mut nearest: Option<(usize, Caret)> = None;
        let mut cell = 0;
        for (byte, glyph) in text.grapheme_indices(true) {
            let width = glyph.width();
            let mut mapped: Option<Range<usize>> = None;
            for span in &visual.mapping {
                let start = span.display.start.max(byte);
                let end = span.display.end.min(byte + glyph.len());
                if start >= end {
                    continue;
                }
                let logical = if span.display.len() == span.logical.len() {
                    span.logical.start + start - span.display.start
                        ..span.logical.start + end - span.display.start
                } else {
                    span.logical.clone()
                };
                mapped = Some(mapped.map_or(logical.clone(), |old| {
                    old.start.min(logical.start)..old.end.max(logical.end)
                }));
            }
            if let Some(logical) = mapped {
                for (position, offset) in [(cell, logical.start), (cell + width, logical.end)] {
                    let distance = column.abs_diff(position);
                    if nearest.as_ref().is_none_or(|(old, _)| distance < *old) {
                        nearest = Some((
                            distance,
                            Caret {
                                key: key.clone(),
                                offset,
                                trailing: position == cell + width,
                            },
                        ));
                    }
                }
            }
            cell += width;
        }
        nearest.map(|(_, caret)| caret)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::{Locale, LocalePreference};
    use crossterm::event::KeyModifiers;
    use ratatui::{Terminal, backend::TestBackend};
    use serde_json::json;

    fn draw(view: &mut Transcript, width: u16, height: u16) {
        Terminal::new(TestBackend::new(width, height))
            .unwrap()
            .draw(|frame| {
                view.draw(frame, frame.area(), false).unwrap();
            })
            .unwrap();
    }
    fn fixture(text: &str) -> (Transcript, MessageKey) {
        let rows = BTreeMap::from([(1, json!({"id":"m","turnId":"t","type":"user","text":text}))]);
        let key = MessageKey::durable(&rows[&1]);
        let mut view = Transcript::default();
        view.sync(
            &rows,
            &[],
            0,
            &I18n::new(LocalePreference::Explicit(Locale::En), Locale::En),
            false,
        );
        view.blocks.get_mut(&key).unwrap().folded = false; // Selection fixture starts with the full plain-text prompt.
        draw(&mut view, 30, 8);
        view.select(key.clone());
        (view, key)
    }
    fn collapse(view: &mut Transcript, key: &MessageKey, offset: usize) {
        let caret = Caret {
            key: key.clone(),
            offset,
            trailing: false,
        };
        view.select_extent(Extent {
            anchor: caret.clone(),
            head: caret,
            column: None,
        });
    }
    fn copied(view: &Transcript) -> String {
        view.copy_text(CopyMode::Selection, false)
            .unwrap_or_default()
    }

    #[test]
    fn keyboard_ranges_extend_mouse_unicode_reverse_and_keep_a_visual_column() {
        let (mut view, _) = fixture("e\u{301}中👩‍💻x\nab\n0123456789\nABCDEFGHIJ");
        for expected in ["e\u{301}", "e\u{301}中", "e\u{301}中👩‍💻"] {
            assert_eq!(view.selection_key(KeyCode::Right), Some(true));
            assert_eq!(copied(&view), expected);
        }
        for expected in ["e\u{301}中", "e\u{301}", ""] {
            view.selection_key(KeyCode::Left);
            assert_eq!(copied(&view), expected);
        }
        assert!(view.text_selection.has_caret());
        assert!(!view.text_selection.active());
        assert_eq!(view.selection_key(KeyCode::Left), Some(false));
        for (kind, column) in [
            (MouseEventKind::Down(MouseButton::Left), 3),
            (MouseEventKind::Drag(MouseButton::Left), 6),
            (MouseEventKind::Up(MouseButton::Left), 6),
        ] {
            view.text_mouse(
                MouseEvent {
                    kind,
                    column,
                    row: 0,
                    modifiers: KeyModifiers::NONE,
                },
                None,
            );
        }
        assert_eq!(copied(&view), "中👩‍💻");
        view.selection_key(KeyCode::Left);
        assert_eq!(copied(&view), "中");
        view.selection_key(KeyCode::Left);
        assert_eq!(copied(&view), "");
        view.selection_key(KeyCode::Left);
        assert_eq!(copied(&view), "e\u{301}");
        // The same visual column survives a short intervening line.
        let source = "abcd中z\nx\n0123456789\nABCDEFGHIJ";
        let (mut view, key) = fixture(source);
        collapse(&mut view, &key, 4);
        view.selection_key(KeyCode::Down);
        assert_eq!(copied(&view), "中z\nx");
        view.selection_key(KeyCode::Down);
        assert_eq!(copied(&view), "中z\nx\n0123");
        view.selection_key(KeyCode::Home);
        assert_eq!(copied(&view), "中z\nx\n");
        view.selection_key(KeyCode::End);
        assert_eq!(copied(&view), "中z\nx\n0123456789");
        view.text_selection.invalidate_geometry();
        draw(&mut view, 8, 3);
        for _ in 0..5 {
            view.selection_key(KeyCode::Down);
            draw(&mut view, 8, 3);
        }
        let head = &view.text_selection.extent.as_ref().unwrap().head;
        let (block, line, _) = view.caret_position(head).unwrap();
        assert!((view.top..view.top + view.height).contains(&(view.starts[block] + line)));
        assert!(!view.following());
        assert_eq!(view.selection_key(KeyCode::Enter), None);
        let (mut wrapped, _) = fixture("abcdefghi");
        draw(&mut wrapped, 8, 8); // Four text columns plus disclosure and scrollbar gutters.
        wrapped.selection_key(KeyCode::End);
        assert_eq!(copied(&wrapped), "abcd");
        wrapped.selection_key(KeyCode::Home);
        assert_eq!(
            copied(&wrapped),
            "",
            "End then Home stays on the same visual line"
        );
    }

    #[test]
    fn keyboard_selection_crosses_messages_and_never_copies_hidden_folded_text() {
        let rows = BTreeMap::from([
            (1, json!({"id":"a","turnId":"t","type":"user","text":"ab"})),
            (
                2,
                json!({"id":"b","turnId":"t","type":"assistant","text":"**中**文\n\nlast"}),
            ),
        ]);
        let mut view = Transcript::default();
        view.sync(
            &rows,
            &[],
            0,
            &I18n::new(LocalePreference::Explicit(Locale::En), Locale::En),
            false,
        );
        draw(&mut view, 20, 10);
        view.first();
        for _ in 0..3 {
            view.selection_key(KeyCode::Right);
        }
        assert_eq!(copied(&view), "ab\n\n中");
        view.selection_key(KeyCode::Right);
        view.selection_key(KeyCode::Right);
        view.selection_key(KeyCode::Right); // A paragraph gap has no drawn glyph.
        assert!(view.selection_key(KeyCode::Down).is_some());
        let (mut folded, key) = fixture("中文中文中文中文 hidden");
        // Only a width that actually hides content offers a fold action.
        draw(&mut folded, 10, 4);
        folded.toggle(&key);
        draw(&mut folded, 10, 4);
        for _ in 0..20 {
            folded.selection_key(KeyCode::Right);
        }
        assert_eq!(copied(&folded), "中文中文中文中文 ");
        assert!(folded.folded(&key));
    }
}
