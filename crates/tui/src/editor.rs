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

//! Bounded, grapheme-aware composer. Inspired by grok-build's separation of byte
//! editing and display geometry; implemented here against Ratatui 0.30.
//! No Host state or submission authority belongs in this widget.
mod layout;
pub mod saved;

use std::{collections::VecDeque, ops::Range};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::{
    Frame,
    layout::{Position, Rect},
    style::{Modifier, Style},
};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use layout::Layout;
use saved::Cursor as Selection;

const MAX_TEXT_BYTES: usize = 256 * 1024;
const MAX_HISTORY_BYTES: usize = 1024 * 1024;
const MAX_HISTORY_EDITS: usize = 128;

impl Selection {
    fn range(self) -> Range<usize> {
        let anchor = self.anchor.unwrap_or(self.cursor);
        anchor.min(self.cursor)..anchor.max(self.cursor)
    }
}

struct Edit {
    start: usize,
    removed: String,
    inserted: String,
    before: Selection,
    after: Selection,
}

impl Edit {
    fn bytes(&self) -> usize {
        self.removed.len() + self.inserted.len()
    }
}

pub struct Editor {
    byte_limit: usize,
    limit_error: &'static str,
    text: String,
    selection: Selection,
    undo: VecDeque<Edit>,
    redo: Vec<Edit>,
    history_bytes: usize,
    layout: Layout,
    area: Option<Rect>,
    top: usize,
    preferred_column: Option<u16>,
    dragging: bool,
    // Message IDs, not English strings; errors survive a locale switch.
    pub error: Option<&'static str>,
}

impl Default for Editor {
    fn default() -> Self {
        Self {
            byte_limit: MAX_TEXT_BYTES,
            limit_error: "composer-too-large",
            text: String::new(),
            selection: Selection::default(),
            undo: VecDeque::new(),
            redo: Vec::new(),
            history_bytes: 0,
            layout: Layout::new("", 1),
            area: None,
            top: 0,
            preferred_column: None,
            dragging: false,
            error: None,
        }
    }
}

impl Editor {
    pub fn bounded(byte_limit: usize, limit_error: &'static str) -> Self {
        Self {
            byte_limit,
            limit_error,
            ..Self::default()
        }
    }
    pub fn text(&self) -> &str {
        &self.text
    }
    pub fn retained_bytes(&self) -> usize {
        self.text.len() + self.history_bytes
    }
    pub fn clear_history(&mut self) {
        self.undo.clear();
        self.redo.clear();
        self.history_bytes = 0;
    }

    pub fn preferred_height(&mut self, width: u16, maximum: u16) -> u16 {
        if self.layout.width != width {
            self.layout = Layout::new(&self.text, width);
        }
        self.layout.rows.len().min(maximum as usize).max(1) as u16
    }

    /// Rows the text wraps to at `width`, leaving the cached layout alone.
    pub fn rows(&self, width: u16) -> u16 {
        let rows = if self.layout.width == width {
            self.layout.rows.len()
        } else {
            Layout::new(&self.text, width).rows.len()
        };
        rows.max(1) as u16
    }

    pub fn invalidate_geometry(&mut self) {
        self.area = None;
        self.dragging = false;
    }

    pub fn contains(&self, point: Position) -> bool {
        self.area.is_some_and(|area| area.contains(point))
    }

    pub fn dragging(&self) -> bool {
        self.dragging
    }

    /// Whether a pointer event is this editor's: a press or the wheel over
    /// it, or anything while it drags a selection it began. Passing over it
    /// or releasing a press made elsewhere is not.
    pub fn takes(&self, mouse: &MouseEvent) -> bool {
        self.dragging
            || (matches!(
                mouse.kind,
                MouseEventKind::Down(_) | MouseEventKind::ScrollUp | MouseEventKind::ScrollDown
            ) && self.contains(Position::new(mouse.column, mouse.row)))
    }

    fn reflow(&mut self) {
        self.layout = Layout::new(&self.text, self.layout.width);
    }

    fn reveal_cursor(&mut self) {
        let Some(area) = self.area else {
            return;
        };
        let (row, _) = self
            .layout
            .cursor(self.selection.cursor, self.selection.upstream);
        if row < self.top {
            self.top = row;
        } else if row >= self.top + area.height as usize {
            self.top = (row + 1).saturating_sub(area.height as usize);
        }
        self.top = self
            .top
            .min(self.layout.rows.len().saturating_sub(area.height as usize));
    }

    /// Bracketed paste is one edit, never interpreted as keys or submitted.
    pub fn insert(&mut self, text: &str) -> bool {
        if text.len() > self.byte_limit {
            self.error = Some(self.limit_error);
            return true;
        }
        if text
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
        {
            self.error = Some("composer-control");
            return true;
        }
        let text = text.replace("\r\n", "\n").replace('\r', "\n");
        let range = self.selection.range();
        if self.text.len() - range.len() + text.len() > self.byte_limit {
            self.error = Some(self.limit_error);
            return true;
        }
        self.replace(range, &text);
        true
    }

    pub fn clear_if_unchanged(&mut self, sent: &str) {
        if self.text == sent {
            self.replace(0..self.text.len(), "");
        }
    }

    fn replace(&mut self, range: Range<usize>, inserted: &str) {
        self.error = None;
        if self.text[range.clone()] == *inserted {
            self.selection = Selection {
                cursor: range.end,
                anchor: None,
                upstream: false,
            };
            self.reveal_cursor();
            return;
        }
        let before = self.selection;
        let removed = self.text[range.clone()].to_owned();
        self.text.replace_range(range.clone(), inserted);
        self.reflow();
        self.selection = Selection {
            cursor: self.layout.snap_right(range.start + inserted.len()),
            anchor: None,
            upstream: false,
        };
        self.preferred_column = None;
        for edit in self.redo.drain(..) {
            self.history_bytes -= edit.bytes();
        }
        let edit = Edit {
            start: range.start,
            removed,
            inserted: inserted.to_owned(),
            before,
            after: self.selection,
        };
        self.history_bytes += edit.bytes();
        self.undo.push_back(edit);
        while self.history_bytes > MAX_HISTORY_BYTES || self.undo.len() > MAX_HISTORY_EDITS {
            if let Some(edit) = self.undo.pop_front() {
                self.history_bytes -= edit.bytes();
            }
        }
        self.reveal_cursor();
    }

    fn undo(&mut self, redo: bool) {
        let edit = if redo {
            self.redo.pop()
        } else {
            self.undo.pop_back()
        };
        let Some(edit) = edit else {
            return;
        };
        if redo {
            self.text
                .replace_range(edit.start..edit.start + edit.removed.len(), &edit.inserted);
            self.selection = edit.after;
        } else {
            self.text
                .replace_range(edit.start..edit.start + edit.inserted.len(), &edit.removed);
            self.selection = edit.before;
        }
        self.reflow();
        self.preferred_column = None;
        self.error = None;
        if redo {
            self.undo.push_back(edit);
        } else {
            self.redo.push(edit);
        }
        self.reveal_cursor();
    }

    fn move_to(&mut self, (byte, upstream): (usize, bool), extend: bool) {
        if extend {
            self.selection.anchor.get_or_insert(self.selection.cursor);
        } else {
            self.selection.anchor = None;
        }
        self.selection.cursor = self.layout.snap_right(byte);
        self.selection.upstream = upstream;
        self.error = None;
        self.reveal_cursor();
    }

    fn word_boundary(&self, forward: bool) -> usize {
        let cursor = self.selection.cursor;
        if forward {
            self.text[cursor..]
                .unicode_word_indices()
                .next()
                .map_or(self.text.len(), |(offset, word)| {
                    cursor + offset + word.len()
                })
        } else {
            self.text[..cursor]
                .unicode_word_indices()
                .next_back()
                .map_or(0, |(offset, _)| offset)
        }
    }

    /// Tab, Escape, application commands and submission stay with the focus scope.
    pub fn key(&mut self, key: KeyEvent) -> bool {
        let shift = key.modifiers.contains(KeyModifiers::SHIFT);
        let control = key.modifiers.contains(KeyModifiers::CONTROL);
        let word = key
            .modifiers
            .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT);
        if control {
            match key.code {
                KeyCode::Char('z') => {
                    self.undo(shift);
                    return true;
                }
                KeyCode::Char('y') => {
                    self.undo(true);
                    return true;
                }
                KeyCode::Char('a') => {
                    self.selection.anchor = Some(0);
                    self.selection.cursor = self.text.len();
                    self.selection.upstream = false;
                    self.reveal_cursor();
                    return true;
                }
                _ => {}
            }
        }
        let cursor = self.selection.cursor;
        let range = self.selection.range();
        let mut upstream = false;
        let target = match key.code {
            KeyCode::Left if !shift && !range.is_empty() => Some(range.start),
            KeyCode::Right if !shift && !range.is_empty() => Some(range.end),
            KeyCode::Left => Some(if word {
                self.word_boundary(false)
            } else {
                self.layout.previous(cursor)
            }),
            KeyCode::Right => Some(if word {
                self.word_boundary(true)
            } else {
                self.layout.next(cursor)
            }),
            KeyCode::Home if control => Some(0),
            KeyCode::End if control => Some(self.text.len()),
            KeyCode::Home => {
                Some(self.layout.rows[self.layout.cursor(cursor, self.selection.upstream).0].start)
            }
            KeyCode::End => {
                upstream = true;
                Some(self.layout.rows[self.layout.cursor(cursor, self.selection.upstream).0].end)
            }
            KeyCode::Up | KeyCode::Down => {
                let (row, column) = self.layout.cursor(cursor, self.selection.upstream);
                let column = *self.preferred_column.get_or_insert(column);
                let row = if key.code == KeyCode::Up {
                    row.saturating_sub(1)
                } else {
                    row + 1
                };
                let (byte, affinity) = self.layout.hit(row, column);
                upstream = affinity;
                Some(byte)
            }
            _ => None,
        };
        if let Some(target) = target {
            if !matches!(key.code, KeyCode::Up | KeyCode::Down) {
                self.preferred_column = None;
            }
            self.move_to((target, upstream), shift);
            return true;
        }
        match key.code {
            KeyCode::Backspace | KeyCode::Delete => {
                let range = if !range.is_empty() {
                    range
                } else if key.code == KeyCode::Backspace {
                    (if word {
                        self.word_boundary(false)
                    } else {
                        self.layout.previous(cursor)
                    })..cursor
                } else {
                    cursor..(if word {
                        self.word_boundary(true)
                    } else {
                        self.layout.next(cursor)
                    })
                };
                self.replace(range, "");
                true
            }
            KeyCode::Enter if !control => self.insert("\n"),
            KeyCode::Char(c)
                if !c.is_control()
                    && (!key.modifiers.intersects(
                        KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER,
                    ) || cfg!(windows)
                        && key
                            .modifiers
                            .contains(KeyModifiers::CONTROL | KeyModifiers::ALT)) =>
            {
                self.insert(c.encode_utf8(&mut [0; 4]))
            }
            _ => false,
        }
    }

    pub fn mouse(&mut self, mouse: MouseEvent) -> bool {
        let Some(area) = self.area.filter(|area| !area.is_empty()) else {
            return false;
        };
        let point = Position::new(mouse.column, mouse.row);
        match mouse.kind {
            MouseEventKind::Down(MouseButton::Left) if area.contains(point) => {
                self.dragging = true;
                self.preferred_column = None;
                self.move_to(
                    self.layout.pointer(area, self.top, point),
                    mouse.modifiers.contains(KeyModifiers::SHIFT),
                );
                self.selection.anchor.get_or_insert(self.selection.cursor);
            }
            MouseEventKind::Drag(MouseButton::Left) if self.dragging => {
                if point.y < area.y {
                    self.top = self.top.saturating_sub(1);
                } else if point.y >= area.bottom() {
                    self.top = (self.top + 1)
                        .min(self.layout.rows.len().saturating_sub(area.height as usize));
                }
                self.move_to(self.layout.pointer(area, self.top, point), true);
            }
            MouseEventKind::Up(MouseButton::Left) if self.dragging => {
                self.dragging = false;
            }
            MouseEventKind::ScrollDown | MouseEventKind::ScrollUp if area.contains(point) => {
                self.top = if mouse.kind == MouseEventKind::ScrollDown {
                    (self.top + 3).min(self.layout.rows.len().saturating_sub(area.height as usize))
                } else {
                    self.top.saturating_sub(3)
                };
            }
            _ => return false,
        }
        true
    }

    pub fn draw(
        &mut self,
        frame: &mut Frame<'_>,
        area: Rect,
        focused: bool,
        colors: crate::theme::Palette,
    ) {
        self.draw_inner(frame, area, focused, false, colors);
    }

    /// Mask before constructing terminal cells; never paint a secret and cover it later.
    pub fn draw_masked(
        &mut self,
        frame: &mut Frame<'_>,
        area: Rect,
        focused: bool,
        colors: crate::theme::Palette,
    ) {
        self.draw_inner(frame, area, focused, true, colors);
    }

    fn draw_inner(
        &mut self,
        frame: &mut Frame<'_>,
        area: Rect,
        focused: bool,
        masked: bool,
        colors: crate::theme::Palette,
    ) {
        if area.is_empty() {
            self.invalidate_geometry();
            return;
        }
        let resized = self.area != Some(area);
        self.area = Some(area);
        if self.layout.width != area.width {
            self.layout = Layout::new(&self.text, area.width);
        }
        if resized {
            self.reveal_cursor();
        }
        let selection = self.selection.range();
        let selected = colors.selected();
        for (screen_row, row) in self
            .layout
            .rows
            .iter()
            .skip(self.top)
            .take(area.height as usize)
            .enumerate()
        {
            let y = area.y + screen_row as u16;
            for cell in &row.cells {
                let x = area.x + cell.column;
                let style = if cell.bytes.start < selection.end && cell.bytes.end > selection.start
                {
                    selected
                } else {
                    Style::default()
                };
                let text = &self.text[cell.bytes.clone()];
                if masked {
                    for column in 0..cell.width {
                        frame.buffer_mut()[(x + column, y)]
                            .set_symbol("*")
                            .set_style(style);
                    }
                } else if text == "\t" {
                    for column in 0..cell.width {
                        frame.buffer_mut()[(x + column, y)]
                            .set_symbol(" ")
                            .set_style(style);
                    }
                } else if text.width() > cell.width as usize {
                    frame.buffer_mut()[(x, y)].set_symbol("�").set_style(style);
                } else {
                    let symbol = if text.width() == 0 {
                        format!("◌{text}")
                    } else {
                        text.to_owned()
                    };
                    frame
                        .buffer_mut()
                        .set_stringn(x, y, symbol, cell.width as usize, style);
                }
            }
            if self.text.as_bytes().get(row.end) == Some(&b'\n') && selection.contains(&row.end) {
                let column = row.cells.last().map_or(0, |cell| cell.column + cell.width);
                frame.buffer_mut()[(area.x + column.min(area.width - 1), y)].set_style(selected);
            }
        }
        if focused {
            let (row, column) = self
                .layout
                .cursor(self.selection.cursor, self.selection.upstream);
            if row >= self.top && row < self.top + area.height as usize {
                let position = Position::new(
                    area.x + column.min(area.width - 1),
                    area.y + (row - self.top) as u16,
                );
                frame.buffer_mut()[position]
                    .set_style(Style::default().add_modifier(Modifier::REVERSED));
                frame.set_cursor_position(position);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::{Terminal, backend::TestBackend};

    fn key(editor: &mut Editor, code: KeyCode, modifiers: KeyModifiers) {
        assert!(editor.key(KeyEvent::new(code, modifiers)));
        assert!(editor.layout.boundaries.contains(&editor.selection.cursor));
    }

    #[test]
    fn grapheme_deletion_selection_and_undo_preserve_unicode() {
        let mut editor = Editor::default();
        for grapheme in ["e\u{301}", "👩🏽‍💻", "🇨🇳", "क्\u{200d}ष"] {
            editor.insert(grapheme);
            key(&mut editor, KeyCode::Backspace, KeyModifiers::NONE);
            assert_eq!(editor.text(), "");
            key(&mut editor, KeyCode::Char('z'), KeyModifiers::CONTROL);
            assert_eq!(editor.text(), grapheme);
            key(&mut editor, KeyCode::Left, KeyModifiers::SHIFT);
            assert_eq!(editor.selection.range(), 0..grapheme.len());
            editor.insert("中文");
            key(&mut editor, KeyCode::Char('z'), KeyModifiers::CONTROL);
            assert_eq!(editor.text(), grapheme);
            key(&mut editor, KeyCode::Char('y'), KeyModifiers::CONTROL);
            assert_eq!(editor.text(), "中文");
            key(&mut editor, KeyCode::Char('a'), KeyModifiers::CONTROL);
            editor.insert("");
        }
        editor.insert("e");
        editor.insert("\u{301}");
        assert_eq!(editor.selection.cursor, "e\u{301}".len());
        key(&mut editor, KeyCode::Backspace, KeyModifiers::NONE);
        assert_eq!(editor.text(), "");
    }

    #[test]
    fn wrap_mouse_drag_resize_and_vertical_motion_share_cell_geometry() {
        let mut editor = Editor::default();
        editor.insert("ab中👩🏽‍💻\nxy\t末");
        let mut terminal = Terminal::new(TestBackend::new(12, 8)).unwrap();
        let area = Rect::new(2, 1, 7, 4);
        terminal
            .draw(|frame| editor.draw(frame, area, true, crate::theme::Palette::default()))
            .unwrap();
        // ab(2) + 中(2) + emoji(2) fit, then explicit newline.
        assert_eq!(editor.layout.rows.len(), 2); // tab reaches column 4, 末 fits.
        let mouse = |kind, x, y| MouseEvent {
            kind,
            column: x,
            row: y,
            modifiers: KeyModifiers::NONE,
        };
        editor.mouse(mouse(MouseEventKind::Down(MouseButton::Left), 5, 1));
        assert_eq!(editor.selection.cursor, 2); // middle of CJK snaps left
        editor.mouse(mouse(MouseEventKind::Drag(MouseButton::Left), 8, 1));
        assert_eq!(&editor.text[editor.selection.range()], "中👩🏽‍💻");
        editor.mouse(mouse(MouseEventKind::Up(MouseButton::Left), 11, 7));
        assert!(!editor.dragging());
        editor.insert("好");
        assert_eq!(editor.text(), "ab好\nxy\t末");
        key(&mut editor, KeyCode::Char('z'), KeyModifiers::CONTROL);
        assert_eq!(editor.text(), "ab中👩🏽‍💻\nxy\t末");
        editor.invalidate_geometry();
        assert!(!editor.mouse(mouse(MouseEventKind::Down(MouseButton::Left), 2, 1)));
        terminal
            .draw(|frame| {
                editor.draw(
                    frame,
                    Rect::new(2, 1, 5, 4),
                    true,
                    crate::theme::Palette::default(),
                )
            })
            .unwrap();
        assert_eq!(editor.layout.rows[1].start, "ab中".len());
        editor.selection = Selection::default();
        key(&mut editor, KeyCode::Down, KeyModifiers::NONE);
        assert_eq!(editor.selection.cursor, "ab中".len());
        key(&mut editor, KeyCode::Up, KeyModifiers::NONE);
        assert_eq!(editor.selection.cursor, 0);
        key(&mut editor, KeyCode::End, KeyModifiers::NONE);
        assert_eq!(
            editor
                .layout
                .cursor(editor.selection.cursor, editor.selection.upstream),
            (0, 4)
        );
        key(&mut editor, KeyCode::Home, KeyModifiers::NONE);
        assert_eq!(
            editor.selection.cursor, 0,
            "End at a wrap must stay on the same visual row"
        );
        editor.mouse(mouse(MouseEventKind::Down(MouseButton::Left), 6, 1));
        assert_eq!(
            editor
                .layout
                .cursor(editor.selection.cursor, editor.selection.upstream),
            (0, 4)
        );
    }

    #[test]
    fn paste_is_atomic_bounded_and_controls_never_reach_the_terminal() {
        let mut editor = Editor::default();
        let paste = "中文👩🏽‍💻\tcode\r\n".repeat(4096);
        assert!(paste.len() >= 100 * 1024);
        editor.insert(&paste);
        assert_eq!(editor.text(), paste.replace("\r\n", "\n"));
        assert_eq!(editor.undo.len(), 1);
        key(&mut editor, KeyCode::Char('z'), KeyModifiers::CONTROL);
        assert_eq!(editor.text(), "");
        key(&mut editor, KeyCode::Char('y'), KeyModifiers::CONTROL);
        let before = editor.text.clone();
        editor.insert("\u{1b}[2J");
        assert_eq!(editor.text(), before);
        assert_eq!(editor.error, Some("composer-control"));
        editor.insert(&"a".repeat(MAX_TEXT_BYTES + 1));
        assert_eq!(editor.text(), before);
        assert_eq!(editor.error, Some("composer-too-large"));
        let mut terminal = Terminal::new(TestBackend::new(120, 40)).unwrap();
        let mut samples = Vec::new();
        for _ in 0..140 {
            let start = std::time::Instant::now();
            editor.insert("!");
            terminal
                .draw(|frame| {
                    editor.draw(
                        frame,
                        Rect::new(2, 28, 116, 8),
                        true,
                        crate::theme::Palette::default(),
                    )
                })
                .unwrap();
            samples.push(start.elapsed());
        }
        samples.sort_unstable();
        eprintln!(
            "100+ KiB editor insert+TestBackend draw: p50={:?}, p95={:?}; debug_assertions={}",
            samples[70],
            samples[133],
            cfg!(debug_assertions)
        );
        assert!(editor.history_bytes <= MAX_HISTORY_BYTES);
        assert!(editor.undo.len() <= MAX_HISTORY_EDITS);
        while !editor.undo.is_empty() {
            editor.undo(false);
        }
        while !editor.redo.is_empty() {
            editor.undo(true);
        }
        assert!(editor.text().ends_with(&"!".repeat(140)));
    }
}
