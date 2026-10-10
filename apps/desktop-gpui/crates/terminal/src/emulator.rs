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

//! The emulator a terminal's output is parsed into: an `alacritty_terminal`
//! [`Term`] fed by its vte [`Processor`], with no PTY and no event loop (the
//! Host owns the PTY and sends its output as UTF-8 text).
//!
//! What the emulator would write back to the PTY is filtered here, as Maka
//! Desktop filters xterm's replies
//! (`apps/desktop/src/renderer/features/workbar/tools/terminal/session-terminal-query.ts`):
//! input travels through durable, serialized controls, so a late reply to a
//! short capability probe would show up at the next prompt. Only cursor
//! position reports go back, which full-screen programs need to place
//! themselves.

use std::sync::{Arc, Mutex, PoisonError};

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::index::{Point, Side};
use alacritty_terminal::selection::{Selection, SelectionRange, SelectionType};
use alacritty_terminal::term::cell::Cell;
use alacritty_terminal::term::color::Colors;
use alacritty_terminal::term::{Config, Osc52, Term, TermMode};
use alacritty_terminal::vte::ansi::{CursorShape, Processor, Timeout};
use gpui_kit::SharedString;
use host_protocol::PtySize;

/// Lines of scrollback each terminal keeps.
pub const SCROLLBACK_LINES: usize = 10_000;

/// The size a terminal starts with before it knows its PTY's.
pub(crate) fn default_size() -> PtySize {
    PtySize::clamped(80, 24)
}

/// What a [`TerminalContent`] holds for one cell: where it is and what it
/// shows. `point` is in grid coordinates: line 0 is the top of the screen,
/// negative lines are scrollback, so with a display offset of `n` the first
/// visible line is `-n`.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct IndexedCell {
    pub point: Point,
    pub cell: Cell,
}

/// The cursor a view draws.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub struct TerminalCursor {
    /// [`CursorShape::Hidden`] when the program hid it.
    pub shape: CursorShape,
    /// In grid coordinates, as [`IndexedCell::point`]; on the first cell of
    /// a wide character.
    pub point: Point,
    /// Whether it blinks: the program's choice (DECSCUSR, or the blinking
    /// cursor mode), or the app's default when it made none
    /// ([`crate::Terminal::set_cursor_blink_default`]).
    pub blinking: bool,
}

/// A picture of the terminal for a view to paint from, made off the main
/// thread after each batch of output: nothing a view reads takes a lock.
#[derive(Clone)]
#[non_exhaustive]
pub struct TerminalContent {
    /// The visible cells, row by row, `size.cols` per row.
    pub cells: Vec<IndexedCell>,
    /// The grid the cells fill.
    pub size: PtySize,
    pub cursor: TerminalCursor,
    /// Mode flags the program set (alternate screen, application cursor,
    /// bracketed paste, mouse reporting, …).
    pub mode: TermMode,
    /// Lines scrolled up into the scrollback; 0 at the bottom.
    pub display_offset: usize,
    /// Lines of scrollback held.
    pub history_size: usize,
    pub selection: Option<SelectionRange>,
    /// Colours the program redefined (OSC 4, 10, 11, 12), by index; `None`
    /// keeps the theme's.
    pub colors: Arc<Colors>,
    /// The title the program set (OSC 0 and 2); `None` when it set none or
    /// reset it.
    pub title: Option<SharedString>,
}

impl std::fmt::Debug for TerminalContent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TerminalContent")
            .field("size", &self.size)
            .field("cursor", &self.cursor)
            .field("mode", &self.mode)
            .field("display_offset", &self.display_offset)
            .field("title", &self.title)
            .finish_non_exhaustive()
    }
}

impl TerminalContent {
    /// The visible text, one line per row, trailing blanks trimmed: what a
    /// test or an accessibility summary reads.
    pub fn text(&self) -> String {
        let columns = usize::from(self.size.cols).max(1);
        let mut lines = Vec::new();
        for row in self.cells.chunks(columns) {
            let line: String = row
                .iter()
                .filter(|indexed| !indexed.cell.flags.contains(WIDE_SPACER))
                .map(|indexed| indexed.cell.c)
                .collect();
            lines.push(line.trim_end().to_owned());
        }
        lines.join("\n")
    }
}

const WIDE_SPACER: alacritty_terminal::term::cell::Flags =
    alacritty_terminal::term::cell::Flags::WIDE_CHAR_SPACER;

/// What the emulator reports besides its picture, already filtered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum EmulatorEvent {
    /// The program set (`Some`) or reset (`None`) its title.
    Title(Option<SharedString>),
    Bell,
    /// OSC 52: the program asks to put this text on the clipboard.
    ClipboardStore(String),
    /// A cursor position report the program asked for, to send to the PTY.
    Reply(String),
}

/// Whether `reply` is a cursor position report (`CSI row ; column R`, or
/// DECXCPR's `CSI ? row ; column R`): the one reply this client sends.
pub(crate) fn is_cursor_position_report(reply: &str) -> bool {
    let Some(rest) = reply.strip_prefix("\x1b[") else {
        return false;
    };
    let rest = rest.strip_prefix('?').unwrap_or(rest);
    let Some(rest) = rest.strip_suffix('R') else {
        return false;
    };
    let Some((row, column)) = rest.split_once(';') else {
        return false;
    };
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());
    digits(row) && digits(column)
}

/// The [`Term`]'s size.
struct TermSize(PtySize);

impl Dimensions for TermSize {
    fn total_lines(&self) -> usize {
        self.screen_lines()
    }

    fn screen_lines(&self) -> usize {
        usize::from(self.0.rows)
    }

    fn columns(&self) -> usize {
        usize::from(self.0.cols)
    }
}

/// Collects what the [`Term`] reports while it parses.
#[derive(Clone, Default)]
pub(crate) struct Listener(Arc<Mutex<Vec<Event>>>);

impl EventListener for Listener {
    fn send_event(&self, event: Event) {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).push(event);
    }
}

/// vte's synchronized updates (`CSI ? 2026 h` … `l`) with the deadline kept
/// by whoever drives the parser: the background task ends an update that
/// stays open past [`SYNC_UPDATE_TIMEOUT`] with [`Emulator::stop_sync`].
#[derive(Default)]
pub(crate) struct SyncTimeout {
    pending: bool,
}

impl Timeout for SyncTimeout {
    fn set_timeout(&mut self, _: std::time::Duration) {
        self.pending = true;
    }

    fn clear_timeout(&mut self) {
        self.pending = false;
    }

    fn pending_timeout(&self) -> bool {
        self.pending
    }
}

/// How long a synchronized update may hold output back (vte's own
/// `SYNC_UPDATE_TIMEOUT`).
pub(crate) const SYNC_UPDATE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(150);

/// A terminal's emulator: the grid, its modes and scrollback, and the
/// parser that feeds it.
pub(crate) struct Emulator {
    term: Term<Listener>,
    processor: Processor<SyncTimeout>,
    listener: Listener,
    title: Option<SharedString>,
    /// While the snapshot of an attach is replayed: its replies, bells and
    /// clipboard writes happened long ago and are dropped.
    replaying: bool,
    pending: Vec<EmulatorEvent>,
    /// Whether the cursor blinks while the program has not chosen.
    blink_default: bool,
}

impl Emulator {
    pub(crate) fn new(size: PtySize) -> Self {
        let listener = Listener::default();
        Self {
            term: Term::new(config(false), &TermSize(size), listener.clone()),
            processor: Processor::new(),
            listener,
            title: None,
            replaying: false,
            pending: Vec::new(),
            blink_default: false,
        }
    }

    /// Whether the cursor blinks while the program has not chosen a style:
    /// the app's setting, the default the program's choice overrides.
    pub(crate) fn set_cursor_blink_default(&mut self, blinking: bool) {
        if self.blink_default != blinking {
            self.blink_default = blinking;
            self.term.set_options(config(blinking));
            self.collect();
        }
    }

    /// Starts over from an attach's snapshot: a fresh emulator and parser
    /// (the snapshot may begin inside an escape sequence) at the size the
    /// output was produced for, the buffer written, then resized to `grid`.
    pub(crate) fn hydrate(&mut self, size: PtySize, buffer: &str, grid: PtySize) {
        self.collect();
        self.term = Term::new(config(self.blink_default), &TermSize(size), self.listener.clone());
        self.processor = Processor::new();
        if self.title.take().is_some() {
            self.pending.push(EmulatorEvent::Title(None));
        }
        self.replaying = true;
        self.processor.advance(&mut self.term, buffer.as_bytes());
        if self.processor.sync_timeout().pending_timeout() {
            self.processor.stop_sync(&mut self.term);
        }
        self.collect();
        self.replaying = false;
        self.resize(grid);
    }

    /// Parses output.
    pub(crate) fn advance(&mut self, data: &str) {
        self.processor.advance(&mut self.term, data.as_bytes());
        self.collect();
    }

    /// Whether a synchronized update holds output back.
    pub(crate) fn sync_pending(&self) -> bool {
        self.processor.sync_timeout().pending_timeout()
    }

    /// Ends a synchronized update that took too long, showing what it held.
    pub(crate) fn stop_sync(&mut self) {
        self.processor.stop_sync(&mut self.term);
        self.collect();
    }

    pub(crate) fn resize(&mut self, size: PtySize) {
        if self.size() != size {
            self.term.resize(TermSize(size));
        }
    }

    pub(crate) fn size(&self) -> PtySize {
        PtySize::clamped(
            u16::try_from(self.term.columns()).unwrap_or(u16::MAX),
            u16::try_from(self.term.screen_lines()).unwrap_or(u16::MAX),
        )
    }

    pub(crate) fn scroll(&mut self, scroll: Scroll) {
        self.term.scroll_display(scroll);
        self.collect();
    }

    /// Scrolls so that `display_offset` lines of scrollback are below the
    /// screen (clamped to what it holds).
    pub(crate) fn scroll_to(&mut self, display_offset: usize) {
        let current = self.term.grid().display_offset();
        let delta = i64::try_from(display_offset).unwrap_or(i64::MAX)
            - i64::try_from(current).unwrap_or(i64::MAX);
        let delta = i32::try_from(delta).unwrap_or(if delta > 0 { i32::MAX } else { i32::MIN });
        if delta != 0 {
            self.scroll(Scroll::Delta(delta));
        }
    }

    pub(crate) fn start_selection(&mut self, ty: SelectionType, point: Point, side: Side) {
        self.term.selection = Some(Selection::new(ty, point, side));
    }

    pub(crate) fn update_selection(&mut self, point: Point, side: Side) {
        if let Some(selection) = self.term.selection.as_mut() {
            selection.update(point, side);
        }
    }

    pub(crate) fn clear_selection(&mut self) {
        self.term.selection = None;
    }

    pub(crate) fn selection_text(&self) -> Option<String> {
        self.term.selection_to_string().filter(|text| !text.is_empty())
    }

    pub(crate) fn term(&self) -> &Term<Listener> {
        &self.term
    }

    /// What happened since the last call, filtered.
    pub(crate) fn take_events(&mut self) -> Vec<EmulatorEvent> {
        self.collect();
        std::mem::take(&mut self.pending)
    }

    pub(crate) fn content(&self) -> TerminalContent {
        let content = self.term.renderable_content();
        let cells = content
            .display_iter
            .map(|indexed| IndexedCell { point: indexed.point, cell: indexed.cell.clone() })
            .collect();
        TerminalContent {
            cells,
            size: self.size(),
            cursor: TerminalCursor {
                shape: content.cursor.shape,
                point: content.cursor.point,
                blinking: self.term.cursor_style().blinking,
            },
            mode: content.mode,
            display_offset: content.display_offset,
            history_size: self.term.history_size(),
            selection: content.selection,
            colors: Arc::new(*content.colors),
            title: self.title.clone(),
        }
    }

    /// Moves what the [`Term`] reported into `pending`, dropping what this
    /// client never acts on.
    fn collect(&mut self) {
        let events =
            std::mem::take(&mut *self.listener.0.lock().unwrap_or_else(PoisonError::into_inner));
        for event in events {
            let event = match event {
                Event::Title(title) => {
                    self.title = Some(title.into());
                    EmulatorEvent::Title(self.title.clone())
                }
                Event::ResetTitle => {
                    self.title = None;
                    EmulatorEvent::Title(None)
                }
                Event::Bell if !self.replaying => EmulatorEvent::Bell,
                Event::ClipboardStore(_, text) if !self.replaying => {
                    EmulatorEvent::ClipboardStore(text)
                }
                Event::PtyWrite(reply) if !self.replaying && is_cursor_position_report(&reply) => {
                    EmulatorEvent::Reply(reply)
                }
                // Never answered: an OSC 52 read would hand the clipboard
                // to whatever runs in the shell. Colour and text area size
                // requests, the other replies (device attributes, status,
                // mode and window reports), and the event loop's own events
                // are dropped too.
                _ => continue,
            };
            self.pending.push(event);
        }
    }
}

/// The emulator's settings; `blinking` is whether the cursor blinks until
/// the program chooses.
fn config(blinking: bool) -> Config {
    Config {
        scrolling_history: SCROLLBACK_LINES,
        // Programs may copy to the clipboard, never read it.
        osc52: Osc52::OnlyCopy,
        default_cursor_style: alacritty_terminal::vte::ansi::CursorStyle {
            shape: CursorShape::Block,
            blinking,
        },
        ..Config::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn size(cols: u16, rows: u16) -> PtySize {
        PtySize::new(cols, rows).expect("size")
    }

    #[test]
    fn only_cursor_position_reports_go_back() {
        let mut emulator = Emulator::new(size(20, 5));
        // Device status, device attributes, XTVERSION, a mode report, a
        // window report, DECRQSS and a colour query, then a cursor report.
        emulator.advance(
            "ab\x1b[5n\x1b[c\x1b[>c\x1b[>0q\x1b[?2004$p\x1b[18t\x1bP$qm\x1b\\\x1b]11;?\x07\x1b[6n",
        );
        assert_eq!(emulator.take_events(), [EmulatorEvent::Reply("\x1b[1;3R".into())]);
        assert!(is_cursor_position_report("\x1b[?12;80R"));
        assert!(!is_cursor_position_report("\x1b[0n"));
        assert!(!is_cursor_position_report("\x1b[12;R"));
        assert!(!is_cursor_position_report("\x1b[12;3Rx"));
    }

    #[test]
    fn a_clipboard_read_is_never_answered_and_a_write_is_exposed() {
        let mut emulator = Emulator::new(size(20, 5));
        emulator.advance("\x1b]52;c;?\x07");
        assert!(emulator.take_events().is_empty(), "OSC 52 read: no reply, no event");
        emulator.advance("\x1b]52;c;aGk=\x07");
        assert_eq!(emulator.take_events(), [EmulatorEvent::ClipboardStore("hi".into())]);
    }

    #[test]
    fn a_replayed_snapshot_asks_nothing_and_rings_nothing() {
        let mut emulator = Emulator::new(size(20, 5));
        emulator.hydrate(
            size(20, 5),
            "\x1b]0;build\x07\x07\x1b[6n\x1b]52;c;aGk=\x07$ ",
            size(30, 6),
        );
        assert_eq!(emulator.take_events(), [EmulatorEvent::Title(Some("build".into()))]);
        assert_eq!(emulator.size(), size(30, 6));
        emulator.advance("\x07");
        assert_eq!(emulator.take_events(), [EmulatorEvent::Bell]);
    }

    #[test]
    fn a_snapshot_is_written_at_its_size_then_reflowed() {
        let mut emulator = Emulator::new(size(80, 24));
        // Ten characters on a 5-column PTY wrap onto two rows; at 20
        // columns they reflow onto one.
        emulator.hydrate(size(5, 4), "abcdefghij", size(20, 4));
        let content = emulator.content();
        assert_eq!(content.size, size(20, 4));
        assert!(content.text().starts_with("abcdefghij"), "{:?}", content.text());
    }

    #[test]
    fn content_carries_the_cursor_modes_and_title() {
        let mut emulator = Emulator::new(size(10, 3));
        emulator.advance("\x1b]2;vim\x07\x1b[?1h\x1b[?2004hhi\x1b[6 q");
        let content = emulator.content();
        assert_eq!(content.title.as_deref(), Some("vim"));
        assert!(content.mode.contains(TermMode::APP_CURSOR | TermMode::BRACKETED_PASTE));
        assert_eq!(content.cursor.shape, CursorShape::Beam);
        assert_eq!(
            content.cursor.point,
            Point::new(alacritty_terminal::index::Line(0), alacritty_terminal::index::Column(2))
        );
        assert_eq!(content.cells.len(), 30);
        emulator.advance("\x1b[?25l");
        assert_eq!(emulator.content().cursor.shape, CursorShape::Hidden);
    }

    #[test]
    fn the_cursor_blinks_by_the_programs_choice_or_else_the_default() {
        let mut emulator = Emulator::new(size(10, 3));
        assert!(!emulator.content().cursor.blinking);
        emulator.set_cursor_blink_default(true);
        assert!(emulator.content().cursor.blinking, "no choice: the default");
        // DECSCUSR 2 and 6: steady block and bar, whatever the default.
        emulator.advance("\x1b[2 q");
        assert!(!emulator.content().cursor.blinking);
        emulator.advance("\x1b[6 q");
        assert!(!emulator.content().cursor.blinking);
        // 5: a blinking bar, with the default off too.
        emulator.set_cursor_blink_default(false);
        emulator.advance("\x1b[5 q");
        assert!(emulator.content().cursor.blinking);
        assert_eq!(emulator.content().cursor.shape, CursorShape::Beam);
        // 0: back to the default.
        emulator.advance("\x1b[0 q");
        assert!(!emulator.content().cursor.blinking);
        // A new snapshot keeps the default.
        emulator.set_cursor_blink_default(true);
        emulator.hydrate(size(10, 3), "$ ", size(10, 3));
        assert!(emulator.content().cursor.blinking);
    }

    #[test]
    fn a_synchronized_update_holds_output_until_it_ends_or_is_stopped() {
        let mut emulator = Emulator::new(size(10, 3));
        emulator.advance("\x1b[?2026hheld");
        assert!(emulator.sync_pending());
        assert!(!emulator.content().text().contains("held"));
        emulator.stop_sync();
        assert!(!emulator.sync_pending());
        assert!(emulator.content().text().contains("held"));
    }
}
