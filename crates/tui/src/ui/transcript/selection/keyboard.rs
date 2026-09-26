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
#[derive(Clone, PartialEq, Eq)]
pub(super) struct Extent {
    pub anchor: Caret,
    pub head: Caret,
    pub column: Option<usize>,
}
pub(super) struct Pending {
    extent: Extent,
    target: Option<Caret>,
    line: Option<LineSearch>,
    horizontal: Option<MessageKey>,
}
impl Pending {
    pub(super) fn retained_bytes(&self) -> usize {
        self.extent.anchor.key.bytes()
            + self.extent.head.key.bytes()
            + self.target.as_ref().map_or(0, |caret| caret.key.bytes())
            + self.line.as_ref().map_or(0, |line| line.key.bytes())
            + self.horizontal.as_ref().map_or(0, MessageKey::bytes)
    }
}
struct LineSearch {
    key: MessageKey,
    row: Option<usize>,
    column: usize,
}
enum Movement<T> {
    Ready(T),
    Pending,
    Boundary,
}

impl Transcript {
    /// Shift movement edits a text range, never the selected card's disclosure.
    pub fn selection_key(&mut self, key: KeyCode) -> Option<bool> {
        let _work = frame_work::begin();
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
        if self.text_selection.extent.is_none() {
            let selected = self.selection()?;
            let row = self
                .text_selection
                .rows
                .iter()
                .find(|row| row.key == selected)
                .or_else(|| self.text_selection.rows.first());
            let caret = row
                .and_then(|row| {
                    let span = self.blocks[&row.key]
                        .visual_line(row.index)?
                        .mapping
                        .first()?;
                    Some(Caret {
                        key: row.key.clone(),
                        offset: span.logical.start,
                        trailing: false,
                    })
                })
                .unwrap_or(Caret {
                    key: selected,
                    offset: 0,
                    trailing: false,
                });
            self.text_selection.extent = Some(Extent {
                anchor: caret.clone(),
                head: caret,
                column: None,
            });
        }
        // Retain accepted input while its semantic text or target rows are loading.
        // Returning None here would hand the same key to card navigation.
        self.text_selection.keys.push_back(key);
        let changed = if self.text_selection.pending.is_none() && !self.text_selection.validating {
            self.advance_selection_key()
        } else {
            false
        };
        if !self.text_selection.keys.is_empty() {
            self.selection_frame();
        }
        Some(changed || !self.text_selection.keys.is_empty())
    }

    pub(super) fn advance_selection_key(&mut self) -> bool {
        let _work = frame_work::begin();
        let Some(&key) = self.text_selection.keys.front() else {
            return false;
        };
        let Some(basis) = self.text_selection.extent.clone() else {
            self.text_selection.keys.clear();
            self.text_selection.movement = None;
            self.text_selection.loading = None;
            return false;
        };
        let mut pending = self.text_selection.movement.take().unwrap_or(Pending {
            extent: basis.clone(),
            target: None,
            line: None,
            horizontal: None,
        });
        let movement = self.move_pending(&mut pending, key);
        if self.text_selection.extent.as_ref() != Some(&basis) {
            self.selection_frame();
            return false;
        }
        match movement {
            Ok(Movement::Pending) => {
                self.text_selection.movement = Some(pending);
                self.selection_frame();
                return false;
            }
            Err(_) => {
                self.text_selection.error = Some("chat-copy-unavailable");
                self.text_selection.keys.clear();
                self.text_selection.loading = None;
                return false;
            }
            Ok(Movement::Ready(caret)) => pending.extent.head = caret,
            Ok(Movement::Boundary) => {}
        }
        self.text_selection.loading = None;
        let extent = pending.extent;
        let previous = basis.head;
        self.text_selection.keys.pop_front();
        let changed = extent.head != previous;
        if let Some((block, line, _)) = self.caret_position(&extent.head) {
            self.total = self.starts.total();
            let row = self.starts.start(block) + line;
            self.top = if row < self.top {
                row
            } else if row >= self.top + self.height {
                row.saturating_sub(self.height.saturating_sub(1))
            } else {
                self.top
            }
            .min(self.total.saturating_sub(self.height));
            if let Some(visual) = self.blocks[&extent.head.key].visual_line(line) {
                self.anchor = Some(Anchor {
                    key: extent.head.key.clone(),
                    source: visual.source,
                    screen_row: row.saturating_sub(self.top),
                });
            }
        }
        self.row_request = None;
        self.selected = Some(extent.head.key.clone());
        self.mouse_selected = true;
        self.select_extent(extent);
        if let Some(area) = self.text_selection.area {
            self.selection_geometry(area);
        }
        changed
    }

    fn move_pending(
        &mut self,
        pending: &mut Pending,
        key: KeyCode,
    ) -> Result<Movement<Caret>, &'static str> {
        if matches!(key, KeyCode::Left | KeyCode::Right) {
            pending.extent.column = None;
            if pending.target.is_none() {
                match self.horizontal_caret(pending, key == KeyCode::Right)? {
                    Movement::Ready(caret) => pending.target = Some(caret),
                    other => return Ok(other),
                }
            }
            let caret = pending.target.as_ref().unwrap();
            return Ok(if self.caret_geometry(caret)? {
                Movement::Ready(caret.clone())
            } else {
                Movement::Pending
            });
        }
        if pending.line.is_none() {
            if !self.caret_geometry(&pending.extent.head)? {
                return Ok(Movement::Pending);
            }
            let Some((block, line, column)) = self.caret_position(&pending.extent.head) else {
                return Ok(Movement::Boundary);
            };
            if matches!(key, KeyCode::Home | KeyCode::End) {
                pending.extent.column = None;
                return Ok(self
                    .line_caret(
                        block,
                        line,
                        if key == KeyCode::Home { 0 } else { usize::MAX },
                    )
                    .map_or(Movement::Boundary, Movement::Ready));
            }
            let column = *pending.extent.column.get_or_insert(column);
            let (block, row) = if key == KeyCode::Down {
                (block, Some(line + 1))
            } else if let Some(row) = line.checked_sub(1) {
                (block, Some(row))
            } else if let Some(block) = block.checked_sub(1) {
                (block, None)
            } else {
                return Ok(Movement::Boundary);
            };
            pending.line = Some(LineSearch {
                key: self.order[block].clone(),
                row,
                column,
            });
        }
        let search = pending.line.as_mut().unwrap();
        Ok(
            match self.adjacent_text_line(search, key == KeyCode::Down)? {
                Movement::Ready((block, line)) => self
                    .line_caret(block, line, search.column)
                    .map_or(Movement::Boundary, Movement::Ready),
                Movement::Pending => Movement::Pending,
                Movement::Boundary => Movement::Boundary,
            },
        )
    }

    fn caret_geometry(&mut self, caret: &Caret) -> Result<bool, &'static str> {
        let index = self
            .selection_index(&caret.key)
            .ok_or("chat-copy-unavailable")?;
        self.text_selection.loading = Some(caret.key.clone());
        if !self.ensure_semantic(index)? {
            return Ok(false);
        }
        self.ensure_geometry(
            index,
            block_layout::Request::Logical {
                offset: caret.offset,
                before: 1,
                rows: self.height.max(1) + 2,
            },
        )
    }

    fn horizontal_caret(
        &mut self,
        pending: &mut Pending,
        forward: bool,
    ) -> Result<Movement<Caret>, &'static str> {
        if pending.horizontal.is_none() {
            let caret = &pending.extent.head;
            let index = self
                .selection_index(&caret.key)
                .ok_or("chat-copy-unavailable")?;
            self.text_selection.loading = Some(caret.key.clone());
            if !resolve::scan_work() || !self.ensure_semantic(index)? {
                return Ok(Movement::Pending);
            }
            let text = self.blocks[&caret.key]
                .selection_text()
                .ok_or("chat-copy-unavailable")?;
            let offset = if forward {
                text.get(caret.offset..)
                    .ok_or("chat-copy-unavailable")?
                    .graphemes(true)
                    .next()
                    .map(|glyph| caret.offset + glyph.len())
            } else {
                text.get(..caret.offset)
                    .ok_or("chat-copy-unavailable")?
                    .graphemes(true)
                    .next_back()
                    .map(|glyph| caret.offset - glyph.len())
            };
            if let Some(offset) = offset {
                return Ok(Movement::Ready(Caret {
                    key: caret.key.clone(),
                    offset,
                    trailing: forward,
                }));
            }
            let next = if forward {
                Some(index + 1)
            } else {
                index.checked_sub(1)
            };
            let Some(key) = next.and_then(|index| self.order.get(index)) else {
                return Ok(Movement::Boundary);
            };
            pending.horizontal = Some(key.clone());
        }
        loop {
            let key = pending.horizontal.as_ref().unwrap();
            let index = self.selection_index(key).ok_or("chat-copy-unavailable")?;
            self.text_selection.loading = Some(key.clone());
            if !resolve::scan_work() || !self.ensure_semantic(index)? {
                return Ok(Movement::Pending);
            }
            let text = self.blocks[key]
                .selection_text()
                .ok_or("chat-copy-unavailable")?;
            if let Some((offset, glyph)) = if forward {
                text.grapheme_indices(true).next()
            } else {
                text.grapheme_indices(true).next_back()
            } {
                return Ok(Movement::Ready(Caret {
                    key: key.clone(),
                    offset: if forward {
                        offset + glyph.len()
                    } else {
                        offset
                    },
                    trailing: forward,
                }));
            }
            let next = if forward {
                Some(index + 1)
            } else {
                index.checked_sub(1)
            };
            let Some(key) = next.and_then(|index| self.order.get(index)) else {
                return Ok(Movement::Boundary);
            };
            pending.horizontal = Some(key.clone());
        }
    }

    fn caret_position(&self, caret: &Caret) -> Option<(usize, usize, usize)> {
        let block = self.selection_index(&caret.key)?;
        let content = &self.blocks[&caret.key];
        let mut trailing = None;
        let mut nearest = None;
        for (offset, visual) in content.visual_lines().iter().enumerate() {
            let row = content.visual_origin() + offset;
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
        &mut self,
        search: &mut LineSearch,
        forward: bool,
    ) -> Result<Movement<(usize, usize)>, &'static str> {
        loop {
            let block = self
                .selection_index(&search.key)
                .ok_or("chat-copy-unavailable")?;
            self.text_selection.loading = Some(search.key.clone());
            if !resolve::scan_work() {
                return Ok(Movement::Pending);
            }
            let request = match search.row {
                Some(row) => block_layout::Request::Rows(
                    row.saturating_sub(1)..row.saturating_add(self.height.max(1)),
                ),
                None => block_layout::Request::Tail(self.height.max(1)),
            };
            if !self.ensure_geometry(block, request)? {
                return Ok(Movement::Pending);
            }
            let content = &self.blocks[&search.key];
            let row = search
                .row
                .unwrap_or_else(|| content.rows().saturating_sub(1));
            if content
                .visual_line(row)
                .is_some_and(|line| !line.mapping.is_empty())
            {
                return Ok(Movement::Ready((block, row)));
            }
            // A completed row request establishes EOF; estimated height alone does not.
            if forward && row < content.rows() {
                search.row = Some(row + 1);
            } else if !forward && row > 0 {
                search.row = Some(row - 1);
            } else {
                let adjacent = if forward {
                    Some(block + 1)
                } else {
                    block.checked_sub(1)
                };
                let Some(key) = adjacent.and_then(|index| self.order.get(index)) else {
                    return Ok(Movement::Boundary);
                };
                search.key = key.clone();
                search.row = forward.then_some(0);
            }
        }
    }

    fn line_caret(&self, block: usize, row: usize, column: usize) -> Option<Caret> {
        let key = &self.order[block];
        let visual = self.blocks[key].visual_line(row)?;
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
    fn extending_an_offscreen_caret_loads_its_neighbor_and_keeps_key_ownership() {
        let rows: BTreeMap<_,_> = (0..100).map(|index| (index, json!({
            "id":format!("m{index}"),"turnId":"t","type":"assistant","text":format!("item {index}")
        }))).collect();
        let mut view = Transcript::default();
        view.sync(
            &rows,
            &[],
            0,
            &I18n::new(LocalePreference::Explicit(Locale::En), Locale::En),
            false,
        );
        view.focused = true;
        view.first();
        draw(&mut view, 50, 8);
        let first = MessageKey::durable(&rows[&0]);
        collapse(&mut view, &first, "item 0".len());
        view.scroll(false, 90);
        draw(&mut view, 50, 8);
        assert!(
            view.blocks[&MessageKey::durable(&rows[&1])]
                .layout
                .is_none()
        );
        assert_eq!(view.selection_key(KeyCode::Right), Some(true));
        assert_eq!(copied(&view), "i");
        let neighbor = MessageKey::durable(&rows[&1]);
        draw(&mut view, 50, 8);
        assert!(
            view.text_selection
                .rows
                .iter()
                .any(|row| row.key == neighbor)
        );
        assert!(view.order.iter().all(|key| !view.blocks[key].folded));
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
        assert!((view.top..view.top + view.height).contains(&(view.starts.start(block) + line)));
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

    #[test]
    fn empty_semantics_and_decoration_scans_yield_without_losing_queued_keys() {
        let rows: BTreeMap<_, _> = (0..602)
            .map(|index| {
                (
                    index,
                    json!({
                        "id":format!("m{index}"), "turnId":"t", "type":"assistant",
                        "text":if index == 0 { "a".to_owned() } else if index == 601 {
                            "bc".to_owned()
                        } else { format!("[unused]: https://example.test/{index}") }
                    }),
                )
            })
            .collect();
        let mut view = Transcript::default();
        view.sync(
            &rows,
            &[],
            0,
            &I18n::new(LocalePreference::Explicit(Locale::En), Locale::En),
            false,
        );
        draw(&mut view, 50, 8);
        // Cached empty semantic results must still consume traversal work.
        for index in 0..view.order.len() {
            let _work = frame_work::begin();
            assert!(view.ensure_semantic(index).unwrap());
        }
        collapse(&mut view, &MessageKey::durable(&rows[&0]), 1);
        for key in [KeyCode::Right, KeyCode::Right, KeyCode::Left] {
            assert_eq!(view.selection_key(key), Some(true));
        }
        assert_eq!(
            view.copy_text(CopyMode::Selection, false),
            Err("chat-copy-pending")
        );
        super::super::loading::settle(&mut view);
        assert_eq!(copied(&view), "b");

        let source = format!("a{}b", "\n".repeat(600));
        let (mut view, key) = fixture(&source);
        collapse(&mut view, &key, 0);
        assert_eq!(view.selection_key(KeyCode::Down), Some(true));
        assert_eq!(
            view.copy_text(CopyMode::Selection, false),
            Err("chat-copy-pending")
        );
        assert_eq!(view.selection_key(KeyCode::Right), Some(true));
        super::super::loading::settle(&mut view);
        assert_eq!(copied(&view), source);
    }
}
