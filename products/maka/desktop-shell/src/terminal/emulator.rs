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
//! [`Term`] fed by its vte [`Processor`], with no PTY and no event loop. The
//! Host owns the PTY, answers the program's queries itself (its own parser
//! writes the replies back), and sends the raw output, so nothing here is
//! ever written back: every event the [`Term`] reports is dropped.
//!
//! The emulator runs off the main thread ([`parse`]): the script's `feed`
//! hands over the base64 text the Host sent, which is decoded and parsed
//! there, and a picture of the visible cells ([`TerminalContent`]) is
//! published after each pass for the view to paint without a lock.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::index::{Column, Line, Point, Side};
use alacritty_terminal::selection::{Selection, SelectionRange, SelectionType};
use alacritty_terminal::sync::FairMutex;
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::color::Colors;
use alacritty_terminal::term::{Config, Osc52, Term, TermMode};
use alacritty_terminal::vte::ansi::{CursorShape, CursorStyle, Processor, Timeout};
use base64::Engine as _;
use futures_lite::future;

/// Lines of scrollback each terminal keeps.
pub(crate) const SCROLLBACK_LINES: usize = 10_000;

/// Feeds the background parser applies before it publishes a picture.
const FEEDS_PER_PASS: usize = 64;

/// How long a synchronized update may hold output back (vte's own
/// `SYNC_UPDATE_TIMEOUT`).
const SYNC_UPDATE_TIMEOUT: Duration = Duration::from_millis(150);

/// A grid size in cells, always within what the Host's PTYs take
/// (`TerminalSize`: 2–240 columns by 1–100 rows). Nothing outside it ever
/// reaches the emulator: alacritty panics on a wide character in one
/// column, reflows without end on a resize to one, and allocates whatever
/// it is asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct GridSize {
    pub cols: u16,
    pub rows: u16,
}

impl GridSize {
    pub(crate) const MIN_COLS: u16 = 2;
    pub(crate) const MAX_COLS: u16 = 240;
    pub(crate) const MIN_ROWS: u16 = 1;
    pub(crate) const MAX_ROWS: u16 = 100;

    /// `cols` × `rows`, brought within the Host's range: a pane that holds
    /// more than 240 columns draws 240. A size from the script is checked
    /// first, and refused outside the range (`super::grid_size`).
    pub(crate) fn new(cols: u16, rows: u16) -> Self {
        Self {
            cols: cols.clamp(Self::MIN_COLS, Self::MAX_COLS),
            rows: rows.clamp(Self::MIN_ROWS, Self::MAX_ROWS),
        }
    }
}

impl Dimensions for GridSize {
    fn total_lines(&self) -> usize {
        self.screen_lines()
    }

    fn screen_lines(&self) -> usize {
        usize::from(self.rows)
    }

    fn columns(&self) -> usize {
        usize::from(self.cols)
    }
}

/// A screen as the Host's `read` answers it for a PTY (`ShellOutput::Pty`):
/// the text of the screen and of the scrollback above it, one line per row,
/// and where the cursor is. It has no colours or modes, so a terminal
/// painted from it shows plain text until the program draws again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Snapshot {
    pub size: GridSize,
    pub screen: String,
    pub scrollback: String,
    /// The cursor's column and row on the screen, from 0.
    pub cursor: (u16, u16),
    pub cursor_visible: bool,
    /// The program was on the alternate screen (a full-screen program): its
    /// screen is painted there, so leaving it (`CSI ? 1049 l`) returns to
    /// the primary screen and its scrollback as live.
    pub alternate_screen: bool,
}

impl Snapshot {
    /// What writing it into an empty terminal of its size takes: the
    /// scrollback's lines, then exactly `rows` lines of screen (the Host trims
    /// the empty rows at its end), so the scrollback scrolls up out of the
    /// screen, then the cursor put back. On the alternate screen the
    /// scrollback stays on the primary one, which the alternate screen is
    /// then entered over.
    pub(crate) fn bytes(&self) -> String {
        let rows = usize::from(self.size.rows);
        let mut out = String::new();
        let mut lines: Vec<&str> = Vec::new();
        if !self.scrollback.is_empty() {
            lines.extend(self.scrollback.split('\n'));
        }
        if self.alternate_screen {
            out.push_str(&lines.join("\r\n"));
            out.push_str("\x1b[?1049h\x1b[H");
            lines.clear();
        }
        let screen: Vec<&str> = self.screen.split('\n').collect();
        let screen = &screen[screen.len().saturating_sub(rows)..];
        lines.extend(screen);
        lines.extend(std::iter::repeat_n("", rows - screen.len()));
        out.push_str(&lines.join("\r\n"));
        let (column, row) = self.cursor;
        out.push_str(&format!(
            "\x1b[{};{}H",
            u32::from(row.min(self.size.rows - 1)) + 1,
            u32::from(column.min(self.size.cols - 1)) + 1
        ));
        if !self.cursor_visible {
            out.push_str("\x1b[?25l");
        }
        out
    }
}

/// What a [`TerminalContent`] holds for one cell: where it is and what it
/// shows. `point` is in grid coordinates: line 0 is the top of the screen,
/// negative lines are scrollback, so with a display offset of `n` the first
/// visible line is `-n`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct IndexedCell {
    pub point: Point,
    pub cell: Cell,
}

/// The cursor a view draws.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TerminalCursor {
    /// [`CursorShape::Hidden`] when the program hid it.
    pub shape: CursorShape,
    /// In grid coordinates, as [`IndexedCell::point`]; on the first cell of
    /// a wide character.
    pub point: Point,
    /// Whether it blinks: the program's choice (DECSCUSR, or the blinking
    /// cursor mode), blinking when it made none.
    pub blinking: bool,
}

/// A picture of the terminal for a view to paint from, made off the main
/// thread after each pass: nothing a view reads takes a lock.
#[derive(Clone)]
pub(crate) struct TerminalContent {
    /// The visible cells, row by row, `size.cols` per row.
    pub cells: Vec<IndexedCell>,
    pub size: GridSize,
    pub cursor: TerminalCursor,
    /// Mode flags the program set (alternate screen, mouse reporting, …).
    pub mode: TermMode,
    /// Lines scrolled up into the scrollback; 0 at the bottom.
    pub display_offset: usize,
    pub selection: Option<SelectionRange>,
    /// Colours the program redefined (OSC 4, 10, 11, 12), by index; `None`
    /// keeps the theme's.
    pub colors: Arc<Colors>,
}

impl TerminalContent {
    /// The visible text, one line per row, trailing blanks trimmed: what a
    /// test or the dev driver reads.
    pub(crate) fn text(&self) -> String {
        let columns = usize::from(self.size.cols).max(1);
        self.cells
            .chunks(columns)
            .map(|row| {
                let line: String = row
                    .iter()
                    .filter(|indexed| !indexed.cell.flags.contains(Flags::WIDE_CHAR_SPACER))
                    .map(|indexed| indexed.cell.c)
                    .collect();
                line.trim_end().to_owned()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

impl std::fmt::Debug for TerminalContent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TerminalContent")
            .field("size", &self.size)
            .field("cursor", &self.cursor)
            .field("display_offset", &self.display_offset)
            .finish_non_exhaustive()
    }
}

/// vte's synchronized updates (`CSI ? 2026 h` … `l`) with the deadline kept
/// by whoever drives the parser: [`parse`] ends an update that stays open
/// past [`SYNC_UPDATE_TIMEOUT`] with [`Emulator::stop_sync`].
#[derive(Default)]
pub(crate) struct SyncTimeout {
    pending: bool,
}

impl Timeout for SyncTimeout {
    fn set_timeout(&mut self, _: Duration) {
        self.pending = true;
    }

    fn clear_timeout(&mut self) {
        self.pending = false;
    }

    fn pending_timeout(&self) -> bool {
        self.pending
    }
}

/// A terminal's emulator: the grid, its modes and scrollback, and the
/// parser that feeds it.
pub(crate) struct Emulator {
    term: Term<VoidListener>,
    processor: Processor<SyncTimeout>,
}

impl Emulator {
    pub(crate) fn new(size: GridSize) -> Self {
        Self {
            term: Term::new(config(), &size, VoidListener),
            processor: Processor::new(),
        }
    }

    /// Starts over, empty, at `size`: a fresh grid and parser (output that
    /// follows may begin anywhere, even inside an escape sequence).
    pub(crate) fn reset(&mut self, size: GridSize) {
        self.term = Term::new(config(), &size, VoidListener);
        self.processor = Processor::new();
    }

    /// Starts over from a screen the Host read: its text written into an
    /// empty terminal of its size.
    pub(crate) fn paint(&mut self, snapshot: &Snapshot) {
        self.reset(snapshot.size);
        self.advance(snapshot.bytes().as_bytes());
        if self.sync_pending() {
            self.stop_sync();
        }
    }

    /// Parses output.
    pub(crate) fn advance(&mut self, bytes: &[u8]) {
        self.processor.advance(&mut self.term, bytes);
    }

    /// Whether a synchronized update holds output back.
    pub(crate) fn sync_pending(&self) -> bool {
        self.processor.sync_timeout().pending_timeout()
    }

    /// Ends a synchronized update that took too long, showing what it held.
    pub(crate) fn stop_sync(&mut self) {
        self.processor.stop_sync(&mut self.term);
    }

    /// Follows the PTY's size. A resize reflows the grid as alacritty does.
    pub(crate) fn resize(&mut self, size: GridSize) {
        if self.size() != size {
            self.term.resize(size);
        }
    }

    pub(crate) fn size(&self) -> GridSize {
        GridSize::new(
            u16::try_from(self.term.columns()).unwrap_or(u16::MAX),
            u16::try_from(self.term.screen_lines()).unwrap_or(u16::MAX),
        )
    }

    pub(crate) fn scroll(&mut self, scroll: Scroll) {
        self.term.scroll_display(scroll);
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

    /// Selects the scrollback and the screen.
    pub(crate) fn select_all(&mut self) {
        let history = i32::try_from(self.term.history_size()).unwrap_or(i32::MAX);
        let last_row = i32::try_from(self.term.screen_lines()).unwrap_or(1) - 1;
        let last_column = self.term.columns().saturating_sub(1);
        let mut selection = Selection::new(
            SelectionType::Simple,
            Point::new(Line(-history), Column(0)),
            Side::Left,
        );
        selection.update(Point::new(Line(last_row), Column(last_column)), Side::Right);
        self.term.selection = Some(selection);
    }

    pub(crate) fn selection_text(&self) -> Option<String> {
        self.term
            .selection_to_string()
            .filter(|text| !text.is_empty())
    }

    pub(crate) fn content(&self) -> TerminalContent {
        let content = self.term.renderable_content();
        let cells = content
            .display_iter
            .map(|indexed| IndexedCell {
                point: indexed.point,
                cell: indexed.cell.clone(),
            })
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
            selection: content.selection,
            colors: Arc::new(*content.colors),
        }
    }
}

/// The emulator's settings: the scrollback, a block cursor that blinks
/// until the program chooses, and OSC 52 never read (the reply would never
/// be sent anyway).
fn config() -> Config {
    Config {
        scrolling_history: SCROLLBACK_LINES,
        osc52: Osc52::OnlyCopy,
        default_cursor_style: CursorStyle {
            shape: CursorShape::Block,
            blinking: true,
        },
        ..Config::default()
    }
}

/// What the background parser is asked to do, in order.
pub(crate) enum Feed {
    /// Output as the Host sent it, base64; decoded here, off the main thread.
    Output(String),
    Resize(GridSize),
    Reset(GridSize),
    Paint(Snapshot),
    Scroll(Scroll),
    StartSelection(SelectionType, Point, Side),
    UpdateSelection(Point, Side),
    ClearSelection,
    SelectAll,
}

/// A timer the parser waits on: the window's background executor's, or a
/// test's.
pub(crate) type Timer = Pin<Box<dyn Future<Output = ()> + Send>>;

/// The background parser: applies feeds to the emulator in order and
/// publishes a picture after each pass of at most [`FEEDS_PER_PASS`],
/// ending a synchronized update that stays open past `timer`'s
/// [`SYNC_UPDATE_TIMEOUT`]. `parsed` is bounded: while the window is busy
/// the parser waits instead of piling up pictures, and catches up in fewer,
/// larger passes.
pub(crate) async fn parse(
    emulator: Arc<FairMutex<Emulator>>,
    feeds: async_channel::Receiver<Feed>,
    parsed: async_channel::Sender<Arc<TerminalContent>>,
    timer: impl Fn(Duration) -> Timer,
) {
    let mut sync_deadline: Option<Timer> = None;
    loop {
        let next = match sync_deadline.as_mut() {
            Some(deadline) => {
                future::or(async { Some(feeds.recv().await) }, async {
                    deadline.as_mut().await;
                    None
                })
                .await
            }
            None => Some(feeds.recv().await),
        };
        let (published, pending) = {
            let mut emulator = emulator.lock();
            match next {
                Some(Ok(feed)) => {
                    apply(&mut emulator, feed);
                    for _ in 1..FEEDS_PER_PASS {
                        let Ok(feed) = feeds.try_recv() else { break };
                        apply(&mut emulator, feed);
                    }
                }
                Some(Err(_)) => return,
                None => {
                    sync_deadline = None;
                    emulator.stop_sync();
                }
            }
            (Arc::new(emulator.content()), emulator.sync_pending())
        };
        if !pending {
            sync_deadline = None;
        } else if sync_deadline.is_none() {
            sync_deadline = Some(timer(SYNC_UPDATE_TIMEOUT));
        }
        if parsed.send(published).await.is_err() {
            return;
        }
    }
}

pub(crate) fn apply(emulator: &mut Emulator, feed: Feed) {
    match feed {
        Feed::Output(data) => match base64::engine::general_purpose::STANDARD.decode(&data) {
            Ok(bytes) => emulator.advance(&bytes),
            Err(error) => eprintln!("maka-terminal: output that is not base64: {error}"),
        },
        Feed::Resize(size) => emulator.resize(size),
        Feed::Reset(size) => emulator.reset(size),
        Feed::Paint(snapshot) => emulator.paint(&snapshot),
        Feed::Scroll(scroll) => emulator.scroll(scroll),
        Feed::StartSelection(ty, point, side) => emulator.start_selection(ty, point, side),
        Feed::UpdateSelection(point, side) => emulator.update_selection(point, side),
        Feed::ClearSelection => emulator.clear_selection(),
        Feed::SelectAll => emulator.select_all(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(emulator: &mut Emulator, text: &str) {
        apply(
            emulator,
            Feed::Output(base64::engine::general_purpose::STANDARD.encode(text)),
        );
    }

    #[test]
    fn output_fed_as_base64_lands_in_the_grid() {
        let mut emulator = Emulator::new(GridSize::new(20, 4));
        feed(&mut emulator, "$ echo hello\r\nhello\r\n$ ");
        let content = emulator.content();
        assert_eq!(content.text(), "$ echo hello\nhello\n$\n");
        assert_eq!(content.cursor.point, Point::new(Line(2), Column(2)));
    }

    #[test]
    fn bytes_split_inside_a_character_or_a_sequence_still_parse() {
        let mut emulator = Emulator::new(GridSize::new(20, 2));
        let text = "\x1b[31m中文\x1b[0m";
        let (head, tail) = text.as_bytes().split_at(6);
        emulator.advance(head);
        emulator.advance(tail);
        let content = emulator.content();
        assert_eq!(content.text().lines().next(), Some("中文"));
        assert!(content.cells[0].cell.flags.contains(Flags::WIDE_CHAR));
        assert_eq!(
            content.cells[0].cell.fg,
            alacritty_terminal::vte::ansi::Color::Named(
                alacritty_terminal::vte::ansi::NamedColor::Red
            )
        );
    }

    #[test]
    fn a_resize_follows_the_pty_and_reflows() {
        let mut emulator = Emulator::new(GridSize::new(10, 3));
        feed(&mut emulator, "abcdefghijkl");
        assert_eq!(emulator.content().text(), "abcdefghij\nkl\n");
        apply(&mut emulator, Feed::Resize(GridSize::new(20, 3)));
        let content = emulator.content();
        assert_eq!(content.size, GridSize::new(20, 3));
        assert!(
            content.text().starts_with("abcdefghijkl"),
            "{:?}",
            content.text()
        );
    }

    #[test]
    fn a_snapshot_paints_its_screen_under_its_scrollback_with_the_cursor() {
        let mut emulator = Emulator::new(GridSize::new(80, 24));
        apply(
            &mut emulator,
            Feed::Paint(Snapshot {
                size: GridSize::new(12, 3),
                screen: "29999\n30000\n$ ls".into(),
                scrollback: "29997\n29998".into(),
                cursor: (4, 2),
                cursor_visible: true,
                alternate_screen: false,
            }),
        );
        let content = emulator.content();
        assert_eq!(content.size, GridSize::new(12, 3));
        assert_eq!(content.text(), "29999\n30000\n$ ls");
        assert_eq!(emulator.term.history_size(), 2);
        assert_eq!(content.cursor.point, Point::new(Line(2), Column(4)));
        // A short screen (the Host trims empty rows) still starts at the top.
        apply(
            &mut emulator,
            Feed::Paint(Snapshot {
                size: GridSize::new(12, 3),
                screen: "$".into(),
                scrollback: String::new(),
                cursor: (2, 0),
                cursor_visible: false,
                alternate_screen: false,
            }),
        );
        let content = emulator.content();
        assert_eq!(content.text(), "$\n\n");
        assert_eq!(emulator.term.history_size(), 0);
        assert_eq!(content.cursor.shape, CursorShape::Hidden);
    }

    #[test]
    fn a_snapshot_of_the_alternate_screen_returns_to_the_primary_one() {
        let mut emulator = Emulator::new(GridSize::new(80, 24));
        apply(
            &mut emulator,
            Feed::Paint(Snapshot {
                size: GridSize::new(12, 3),
                screen: "~\n~\n:wq".into(),
                scrollback: "$ ls\na  b\n$ vim".into(),
                cursor: (3, 2),
                cursor_visible: true,
                alternate_screen: true,
            }),
        );
        let content = emulator.content();
        assert!(content.mode.contains(TermMode::ALT_SCREEN));
        assert_eq!(content.text(), "~\n~\n:wq");
        assert_eq!(content.cursor.point, Point::new(Line(2), Column(3)));
        // The program leaves it: the shell's lines are back, live.
        feed(&mut emulator, "\x1b[?1049l");
        let content = emulator.content();
        assert!(!content.mode.contains(TermMode::ALT_SCREEN));
        assert_eq!(content.text(), "$ ls\na  b\n$ vim");
    }

    #[test]
    fn a_grid_size_stays_within_the_hosts_range() {
        assert_eq!(GridSize::new(1, 0), GridSize { cols: 2, rows: 1 });
        assert_eq!(GridSize::new(80, 24), GridSize { cols: 80, rows: 24 });
        assert_eq!(
            GridSize::new(u16::MAX, u16::MAX),
            GridSize {
                cols: 240,
                rows: 100
            }
        );
    }

    #[test]
    fn wide_characters_fit_the_narrowest_grid() {
        // One column cannot hold a wide character (alacritty panics on it,
        // and reflows to it without end): the narrowest grid is two.
        let mut emulator = Emulator::new(GridSize::new(1, 3));
        feed(&mut emulator, "中文中文");
        apply(&mut emulator, Feed::Reset(GridSize::new(1, 3)));
        feed(&mut emulator, "中文中文");
        apply(&mut emulator, Feed::Resize(GridSize::new(1, 4)));
        apply(&mut emulator, Feed::Resize(GridSize::new(6, 4)));
        let content = emulator.content();
        assert_eq!(content.size, GridSize::new(6, 4));
        assert!(content.text().contains('中'), "{:?}", content.text());
    }

    fn run_parse(feeds: Vec<Feed>) -> Vec<Arc<TerminalContent>> {
        let emulator = Arc::new(FairMutex::new(Emulator::new(GridSize::new(20, 2))));
        let (feed_sender, feed_receiver) = async_channel::unbounded();
        let (parsed, pictures) = async_channel::unbounded();
        for feed in feeds {
            feed_sender.try_send(feed).unwrap();
        }
        // A deadline that has passed by the time it is waited on.
        let timer = |_: Duration| -> Timer { Box::pin(future::ready(())) };
        let parser = std::thread::spawn(move || {
            future::block_on(parse(emulator, feed_receiver, parsed, timer));
        });
        let mut out = Vec::new();
        while let Ok(picture) = pictures.recv_blocking() {
            let shows = picture.text().contains("held");
            out.push(picture);
            if shows || out.len() > 4 {
                break;
            }
        }
        drop(feed_sender);
        drop(pictures);
        parser.join().unwrap();
        out
    }

    #[test]
    fn the_parser_publishes_what_it_was_fed() {
        let pictures = run_parse(vec![Feed::Output(
            base64::engine::general_purpose::STANDARD.encode("one\r\nheld"),
        )]);
        assert_eq!(pictures.len(), 1);
        assert_eq!(pictures[0].text(), "one\nheld");
    }

    #[test]
    fn a_synchronized_update_left_open_shows_at_its_deadline() {
        // The program begins an update and never ends it: what it wrote is
        // held back, then shown once the deadline passes.
        let pictures = run_parse(vec![Feed::Output(
            base64::engine::general_purpose::STANDARD.encode("\x1b[?2026hheld"),
        )]);
        assert!(pictures.len() >= 2, "{pictures:?}");
        assert!(!pictures[0].text().contains("held"));
        assert!(pictures.last().unwrap().text().contains("held"));
    }

    #[test]
    fn scrolled_up_new_output_keeps_the_view_where_it_is() {
        let mut emulator = Emulator::new(GridSize::new(10, 3));
        let lines: String = (1..=10).map(|n| format!("{n}\r\n")).collect();
        feed(&mut emulator, &lines);
        emulator.scroll(Scroll::Delta(2));
        let before = emulator.content();
        assert_eq!(before.display_offset, 2);
        feed(&mut emulator, "11\r\n12\r\n");
        let after = emulator.content();
        assert_eq!(after.display_offset, 4, "the view stays on the same lines");
        assert_eq!(before.text(), after.text());
    }

    #[test]
    fn a_reset_empties_the_grid_and_its_scrollback() {
        let mut emulator = Emulator::new(GridSize::new(10, 2));
        feed(&mut emulator, "1\r\n2\r\n3\r\n");
        apply(&mut emulator, Feed::Reset(GridSize::new(6, 2)));
        let content = emulator.content();
        assert_eq!(
            (content.text().as_str(), emulator.term.history_size()),
            ("\n", 0)
        );
        assert_eq!(content.size, GridSize::new(6, 2));
    }

    #[test]
    fn the_selection_copies_what_it_covers() {
        let mut emulator = Emulator::new(GridSize::new(10, 2));
        feed(&mut emulator, "one two\r\nthree");
        emulator.start_selection(
            SelectionType::Simple,
            Point::new(Line(0), Column(4)),
            Side::Left,
        );
        emulator.update_selection(Point::new(Line(1), Column(2)), Side::Right);
        assert_eq!(emulator.selection_text().as_deref(), Some("two\nthr"));
        apply(&mut emulator, Feed::SelectAll);
        assert_eq!(emulator.selection_text().as_deref(), Some("one two\nthree"));
        apply(&mut emulator, Feed::ClearSelection);
        assert_eq!(emulator.selection_text(), None);
    }
}
