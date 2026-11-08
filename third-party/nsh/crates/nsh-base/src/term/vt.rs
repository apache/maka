//! NSH's own terminal emulator: `vte`'s parser (the one Alacritty uses)
//! over a grid of cells. It covers what shells and full-screen programs
//! use: printing with wrap and wide characters, cursor moves, erasing,
//! inserting and deleting, scroll regions, SGR colors (16, 256, 24-bit),
//! the alternate screen, cursor visibility, bracketed paste, application
//! cursor keys, titles, the bell and the device queries programs wait on.

use std::collections::VecDeque;

use unicode_width::UnicodeWidthChar;
use vte::{Params, Parser, Perform};

use super::emulator::{
    TerminalColor, TerminalCursor, TerminalEmulator, TerminalEmulatorEvent, TerminalLine,
    TerminalModes, TerminalRun, TerminalSize, TerminalStyle,
};

/// One cell: a character, or the right half of a wide one (`'\0'`).
#[derive(Debug, Clone, Copy, PartialEq)]
struct Cell {
    ch: char,
    style: TerminalStyle,
}

impl Default for Cell {
    fn default() -> Self {
        Self {
            ch: ' ',
            style: TerminalStyle::default(),
        }
    }
}

type Row = Vec<Cell>;

fn blank(cols: usize, style: TerminalStyle) -> Row {
    // Erased cells keep only the background, as xterm's do.
    let style = TerminalStyle {
        bg: style.bg,
        ..TerminalStyle::default()
    };
    vec![Cell { ch: ' ', style }; cols]
}

#[derive(Debug, Clone, Copy, Default)]
struct Saved {
    x: usize,
    y: usize,
    style: TerminalStyle,
}

struct State {
    cols: usize,
    rows: usize,
    screen: Vec<Row>,
    scrollback: VecDeque<Row>,
    max_scrollback: usize,
    /// The primary screen while the alternate one shows.
    primary: Option<(Vec<Row>, Saved)>,
    x: usize,
    y: usize,
    /// The last column was printed: the next character wraps first.
    wrap_pending: bool,
    style: TerminalStyle,
    saved: Saved,
    top: usize,
    bottom: usize,
    cursor_visible: bool,
    auto_wrap: bool,
    modes: TerminalModes,
    events: Vec<TerminalEmulatorEvent>,
}

/// NSH's own [`TerminalEmulator`] (see the module doc).
pub struct VtEmulator {
    parser: Parser,
    state: State,
}

impl VtEmulator {
    /// An emulator with a screen of `size` keeping `scrollback` lines.
    pub fn new(size: TerminalSize, scrollback: usize) -> Self {
        let (cols, rows) = (size.cols.max(1) as usize, size.rows.max(1) as usize);
        Self {
            parser: Parser::new(),
            state: State {
                cols,
                rows,
                screen: vec![blank(cols, TerminalStyle::default()); rows],
                scrollback: VecDeque::new(),
                max_scrollback: scrollback,
                primary: None,
                x: 0,
                y: 0,
                wrap_pending: false,
                style: TerminalStyle::default(),
                saved: Saved::default(),
                top: 0,
                bottom: rows - 1,
                cursor_visible: true,
                auto_wrap: true,
                modes: TerminalModes::default(),
                events: Vec::new(),
            },
        }
    }
}

impl TerminalEmulator for VtEmulator {
    fn feed(&mut self, bytes: &[u8]) {
        self.parser.advance(&mut self.state, bytes);
    }

    fn resize(&mut self, size: TerminalSize) {
        self.state
            .resize(size.cols.max(1) as usize, size.rows.max(1) as usize);
    }

    fn line_count(&self) -> usize {
        self.state.scrollback.len() + self.state.rows
    }

    fn line(&self, index: usize) -> TerminalLine {
        let s = &self.state;
        let row = match index.checked_sub(s.scrollback.len()) {
            None => s.scrollback.get(index),
            Some(i) => s.screen.get(i),
        };
        row.map(runs).unwrap_or_default()
    }

    fn cursor(&self) -> Option<TerminalCursor> {
        let s = &self.state;
        s.cursor_visible.then(|| TerminalCursor {
            col: s.x.min(s.cols - 1) as u16,
            row: s.y as u16,
        })
    }

    fn take_events(&mut self) -> Vec<TerminalEmulatorEvent> {
        std::mem::take(&mut self.state.events)
    }

    fn modes(&self) -> TerminalModes {
        self.state.modes
    }
}

/// A row as runs, its trailing default blanks left out.
fn runs(row: &Row) -> TerminalLine {
    let end = row
        .iter()
        .rposition(|c| c.ch != ' ' || c.style != TerminalStyle::default())
        .map_or(0, |i| i + 1);
    let mut out: Vec<TerminalRun> = Vec::new();
    for cell in &row[..end] {
        if cell.ch == '\0' {
            continue;
        }
        match out.last_mut() {
            Some(run) if run.style == cell.style => run.text.push(cell.ch),
            _ => out.push(TerminalRun::new(cell.ch.to_string(), cell.style)),
        }
    }
    TerminalLine::new(out)
}

impl State {
    fn resize(&mut self, cols: usize, rows: usize) {
        if cols == self.cols && rows == self.rows {
            return;
        }
        for row in self.screen.iter_mut() {
            row.resize(cols, Cell::default());
        }
        // Shrinking keeps the rows up to the cursor: those above go to the
        // scrollback, as terminals do.
        while self.screen.len() > rows {
            if self.y + 1 < self.screen.len() && self.screen.last().is_some_and(is_blank) {
                self.screen.pop();
            } else {
                let row = self.screen.remove(0);
                self.push_scrollback(row);
                self.y = self.y.saturating_sub(1);
            }
        }
        while self.screen.len() < rows {
            self.screen.push(blank(cols, TerminalStyle::default()));
        }
        if let Some((primary, _)) = &mut self.primary {
            for row in primary.iter_mut() {
                row.resize(cols, Cell::default());
            }
            primary.resize(rows, blank(cols, TerminalStyle::default()));
        }
        self.cols = cols;
        self.rows = rows;
        self.top = 0;
        self.bottom = rows - 1;
        self.x = self.x.min(cols - 1);
        self.y = self.y.min(rows - 1);
        self.wrap_pending = false;
    }

    fn push_scrollback(&mut self, row: Row) {
        if self.primary.is_some() || self.max_scrollback == 0 {
            return;
        }
        if self.scrollback.len() == self.max_scrollback {
            self.scrollback.pop_front();
        }
        self.scrollback.push_back(row);
    }

    /// Scrolls the region up `n` rows.
    fn scroll_up(&mut self, n: usize) {
        let blank_row = blank(self.cols, self.style);
        for _ in 0..n.min(self.bottom + 1 - self.top) {
            let row = self.screen.remove(self.top);
            if self.top == 0 {
                self.push_scrollback(row);
            }
            self.screen.insert(self.bottom, blank_row.clone());
        }
    }

    /// Scrolls the region down `n` rows.
    fn scroll_down(&mut self, n: usize) {
        let blank_row = blank(self.cols, self.style);
        for _ in 0..n.min(self.bottom + 1 - self.top) {
            self.screen.remove(self.bottom);
            self.screen.insert(self.top, blank_row.clone());
        }
    }

    fn linefeed(&mut self) {
        self.wrap_pending = false;
        if self.y == self.bottom {
            self.scroll_up(1);
        } else if self.y + 1 < self.rows {
            self.y += 1;
        }
    }

    fn goto(&mut self, x: usize, y: usize) {
        self.x = x.min(self.cols - 1);
        self.y = y.min(self.rows - 1);
        self.wrap_pending = false;
    }

    fn erase(&mut self, y: usize, from: usize, to: usize) {
        let cell = blank(1, self.style)[0];
        let row = &mut self.screen[y];
        for c in row.iter_mut().take(to.min(self.cols)).skip(from) {
            *c = cell;
        }
    }

    fn sgr(&mut self, params: &Params) {
        let mut it = params.iter();
        if params.is_empty() {
            self.style = TerminalStyle::default();
            return;
        }
        while let Some(p) = it.next() {
            let s = &mut self.style;
            match p[0] {
                0 => *s = TerminalStyle::default(),
                1 => s.bold = true,
                2 => s.dim = true,
                3 => s.italic = true,
                4 => s.underline = p.get(1) != Some(&0),
                7 => s.inverse = true,
                8 => s.hidden = true,
                9 => s.strikethrough = true,
                21 | 22 => (s.bold, s.dim) = (false, false),
                23 => s.italic = false,
                24 => s.underline = false,
                27 => s.inverse = false,
                28 => s.hidden = false,
                29 => s.strikethrough = false,
                n @ 30..=37 => s.fg = Some(TerminalColor::Indexed((n - 30) as u8)),
                39 => s.fg = None,
                n @ 40..=47 => s.bg = Some(TerminalColor::Indexed((n - 40) as u8)),
                49 => s.bg = None,
                n @ 90..=97 => s.fg = Some(TerminalColor::Indexed((n - 90 + 8) as u8)),
                n @ 100..=107 => s.bg = Some(TerminalColor::Indexed((n - 100 + 8) as u8)),
                n @ (38 | 48) => {
                    // `38;5;n` / `38;2;r;g;b`, or the colon forms in one param.
                    let color = if p.len() > 1 {
                        extended(&p[1..])
                    } else {
                        let mut rest = Vec::new();
                        if let Some(kind) = it.next() {
                            rest.push(kind[0]);
                            let more = if kind[0] == 2 { 3 } else { 1 };
                            for _ in 0..more {
                                if let Some(v) = it.next() {
                                    rest.push(v[0]);
                                }
                            }
                        }
                        extended(&rest)
                    };
                    if n == 38 {
                        s.fg = color;
                    } else {
                        s.bg = color;
                    }
                }
                _ => {}
            }
        }
    }

    fn set_mode(&mut self, params: &Params, private: bool, on: bool) {
        for p in params.iter() {
            match (private, p[0]) {
                (true, 1) => self.modes.application_cursor = on,
                (true, 7) => self.auto_wrap = on,
                (true, 25) => self.cursor_visible = on,
                (true, 2004) => self.modes.bracketed_paste = on,
                (true, 47 | 1047 | 1049) => self.alternate(on, p[0] == 1049),
                _ => {}
            }
        }
    }

    fn alternate(&mut self, on: bool, save_cursor: bool) {
        let cursor = Saved {
            x: self.x,
            y: self.y,
            style: self.style,
        };
        match (on, self.primary.take()) {
            (true, None) => {
                let screen = std::mem::replace(
                    &mut self.screen,
                    vec![blank(self.cols, TerminalStyle::default()); self.rows],
                );
                self.primary = Some((screen, cursor));
            }
            (false, Some((screen, saved))) => {
                self.screen = screen;
                if save_cursor {
                    self.goto(saved.x, saved.y);
                    self.style = saved.style;
                }
            }
            (_, primary) => self.primary = primary,
        }
    }
}

fn is_blank(row: &Row) -> bool {
    row.iter().all(|c| *c == Cell::default())
}

/// `5;n` or `2;r;g;b`.
fn extended(p: &[u16]) -> Option<TerminalColor> {
    match p {
        [5, n, ..] => Some(TerminalColor::Indexed(*n as u8)),
        // The colon form may carry a color space id first.
        [2, _, r, g, b] => Some(TerminalColor::Rgb(*r as u8, *g as u8, *b as u8)),
        [2, r, g, b, ..] => Some(TerminalColor::Rgb(*r as u8, *g as u8, *b as u8)),
        _ => None,
    }
}

/// Parameter `i`, `default` when missing or 0.
fn arg(params: &Params, i: usize, default: usize) -> usize {
    match params.iter().nth(i).map(|p| p[0] as usize) {
        None | Some(0) => default,
        Some(v) => v,
    }
}

impl Perform for State {
    fn print(&mut self, ch: char) {
        let width = ch.width().unwrap_or(0);
        if width == 0 {
            return;
        }
        if self.wrap_pending && self.auto_wrap {
            self.x = 0;
            self.linefeed();
        }
        if width == 2 && self.x + 1 >= self.cols {
            // A wide character that does not fit wraps whole.
            if self.auto_wrap {
                self.x = 0;
                self.linefeed();
            } else {
                return;
            }
        }
        let style = self.style;
        let row = &mut self.screen[self.y];
        row[self.x] = Cell { ch, style };
        if width == 2 {
            row[self.x + 1] = Cell { ch: '\0', style };
        }
        if self.x + width >= self.cols {
            self.x = self.cols - 1;
            self.wrap_pending = true;
        } else {
            self.x += width;
            self.wrap_pending = false;
        }
    }

    fn execute(&mut self, byte: u8) {
        match byte {
            0x07 => self.events.push(TerminalEmulatorEvent::Bell),
            0x08 => {
                self.x = self.x.saturating_sub(1);
                self.wrap_pending = false;
            }
            0x09 => {
                self.x = ((self.x / 8 + 1) * 8).min(self.cols - 1);
            }
            0x0a..=0x0c => self.linefeed(),
            0x0d => {
                self.x = 0;
                self.wrap_pending = false;
            }
            _ => {}
        }
    }

    fn osc_dispatch(&mut self, params: &[&[u8]], _bell_terminated: bool) {
        if let [b"0" | b"2", title, ..] = params {
            self.events.push(TerminalEmulatorEvent::Title(
                String::from_utf8_lossy(title).into_owned(),
            ));
        }
    }

    fn csi_dispatch(&mut self, params: &Params, intermediates: &[u8], ignore: bool, action: char) {
        if ignore {
            return;
        }
        let private = intermediates.first() == Some(&b'?');
        let n = arg(params, 0, 1);
        match action {
            'A' => self.goto(self.x, self.y.saturating_sub(n)),
            'B' | 'e' => self.goto(self.x, self.y + n),
            'C' | 'a' => self.goto(self.x + n, self.y),
            'D' => self.goto(self.x.saturating_sub(n), self.y),
            'E' => self.goto(0, self.y + n),
            'F' => self.goto(0, self.y.saturating_sub(n)),
            'G' | '`' => self.goto(n - 1, self.y),
            'd' => self.goto(self.x, n - 1),
            'H' | 'f' => self.goto(arg(params, 1, 1) - 1, n - 1),
            'J' => {
                let (x, y) = (self.x, self.y);
                match arg(params, 0, 0) {
                    0 => {
                        self.erase(y, x, self.cols);
                        for r in y + 1..self.rows {
                            self.erase(r, 0, self.cols);
                        }
                    }
                    1 => {
                        for r in 0..y {
                            self.erase(r, 0, self.cols);
                        }
                        self.erase(y, 0, x + 1);
                    }
                    2 => {
                        for r in 0..self.rows {
                            self.erase(r, 0, self.cols);
                        }
                    }
                    3 => self.scrollback.clear(),
                    _ => {}
                }
            }
            'K' => {
                let (x, y) = (self.x, self.y);
                match arg(params, 0, 0) {
                    0 => self.erase(y, x, self.cols),
                    1 => self.erase(y, 0, x + 1),
                    2 => self.erase(y, 0, self.cols),
                    _ => {}
                }
            }
            'X' => {
                let (x, y) = (self.x, self.y);
                self.erase(y, x, x + n);
            }
            '@' => {
                let cell = blank(1, self.style)[0];
                let (x, cols) = (self.x, self.cols);
                let row = &mut self.screen[self.y];
                for _ in 0..n.min(cols - x) {
                    row.pop();
                    row.insert(x, cell);
                }
            }
            'P' => {
                let cell = blank(1, self.style)[0];
                let (x, cols) = (self.x, self.cols);
                let row = &mut self.screen[self.y];
                for _ in 0..n.min(cols - x) {
                    row.remove(x);
                    row.push(cell);
                }
            }
            'L' | 'M' if (self.top..=self.bottom).contains(&self.y) => {
                let top = self.top;
                self.top = self.y;
                if action == 'L' {
                    self.scroll_down(n);
                } else {
                    self.scroll_up_no_scrollback(n);
                }
                self.top = top;
                self.x = 0;
            }
            'S' => self.scroll_up_no_scrollback(n),
            'T' => self.scroll_down(n),
            'r' if !private => {
                let top = arg(params, 0, 1) - 1;
                let bottom = arg(params, 1, self.rows).min(self.rows) - 1;
                if top < bottom {
                    self.top = top;
                    self.bottom = bottom;
                    self.goto(0, 0);
                }
            }
            'm' if intermediates.is_empty() => self.sgr(params),
            'h' => self.set_mode(params, private, true),
            'l' => self.set_mode(params, private, false),
            'n' if !private && arg(params, 0, 0) == 6 => {
                let reply = format!("\x1b[{};{}R", self.y + 1, self.x.min(self.cols - 1) + 1);
                self.events
                    .push(TerminalEmulatorEvent::Reply(reply.into_bytes()));
            }
            'n' if !private && arg(params, 0, 0) == 5 => {
                self.events
                    .push(TerminalEmulatorEvent::Reply(b"\x1b[0n".to_vec()));
            }
            'c' if intermediates.is_empty() && arg(params, 0, 0) == 0 => {
                // A VT220 with no options.
                self.events
                    .push(TerminalEmulatorEvent::Reply(b"\x1b[?62;22c".to_vec()));
            }
            's' if !private => self.save(),
            'u' if !private => self.restore(),
            _ => {}
        }
    }

    fn esc_dispatch(&mut self, intermediates: &[u8], _ignore: bool, byte: u8) {
        match (intermediates, byte) {
            ([], b'7') => self.save(),
            ([], b'8') => self.restore(),
            ([], b'D') => self.linefeed(),
            ([], b'E') => {
                self.x = 0;
                self.linefeed();
            }
            ([], b'M') => {
                if self.y == self.top {
                    self.scroll_down(1);
                } else {
                    self.y = self.y.saturating_sub(1);
                }
            }
            ([], b'c') => {
                let (cols, rows, max) = (self.cols, self.rows, self.max_scrollback);
                let events = std::mem::take(&mut self.events);
                *self = VtEmulator::new(TerminalSize::new(cols as u16, rows as u16), max).state;
                self.events = events;
            }
            _ => {}
        }
    }
}

impl State {
    /// Lines that leave the region by deleting are gone, not scrollback.
    fn scroll_up_no_scrollback(&mut self, n: usize) {
        let blank_row = blank(self.cols, self.style);
        for _ in 0..n.min(self.bottom + 1 - self.top) {
            self.screen.remove(self.top);
            self.screen.insert(self.bottom, blank_row.clone());
        }
    }

    fn save(&mut self) {
        self.saved = Saved {
            x: self.x,
            y: self.y,
            style: self.style,
        };
    }

    fn restore(&mut self) {
        let saved = self.saved;
        self.goto(saved.x, saved.y);
        self.style = saved.style;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn term(cols: u16, rows: u16) -> VtEmulator {
        VtEmulator::new(TerminalSize::new(cols, rows), 100)
    }

    fn screen(t: &VtEmulator) -> Vec<String> {
        let first = t.line_count() - t.state.rows;
        (first..t.line_count()).map(|i| t.line(i).text()).collect()
    }

    #[test]
    fn prints_wraps_and_scrolls_into_scrollback() {
        let mut t = term(4, 2);
        t.feed(b"abcdef\r\nxy");
        assert_eq!(screen(&t), ["ef", "xy"]);
        assert_eq!(t.line(0).text(), "abcd");
        assert_eq!(t.cursor(), Some(TerminalCursor { col: 2, row: 1 }));
    }

    #[test]
    fn colors_and_styles() {
        let mut t = term(10, 1);
        t.feed(b"\x1b[1;31mA\x1b[38;5;200mB\x1b[38;2;1;2;3mC\x1b[0mD");
        let runs = t.line(0).runs;
        assert_eq!(runs[0].style.fg, Some(TerminalColor::Indexed(1)));
        assert!(runs[0].style.bold);
        assert_eq!(runs[1].style.fg, Some(TerminalColor::Indexed(200)));
        assert_eq!(runs[2].style.fg, Some(TerminalColor::Rgb(1, 2, 3)));
        assert_eq!(runs[3].style, TerminalStyle::default());
    }

    #[test]
    fn cursor_moves_and_erases() {
        let mut t = term(5, 2);
        t.feed(b"hello\r\nworld\x1b[1;3H\x1b[K\x1b[2;2H\x1b[1P");
        assert_eq!(screen(&t), ["he", "wrld"]);
    }

    #[test]
    fn alternate_screen_restores_the_primary() {
        let mut t = term(5, 2);
        t.feed(b"shell\x1b[?1049h\x1b[2Jvim\x1b[?1049l");
        assert_eq!(screen(&t)[0], "shell");
    }

    #[test]
    fn wide_characters_take_two_cells() {
        let mut t = term(4, 1);
        t.feed("中文".as_bytes());
        assert_eq!(t.line(0).text(), "中文");
        assert_eq!(t.cursor(), Some(TerminalCursor { col: 3, row: 0 }));
    }

    #[test]
    fn answers_cursor_queries_and_reports_titles() {
        let mut t = term(5, 2);
        t.feed(b"\x1b]0;hi\x07ab\x1b[6n\x07");
        assert_eq!(
            t.take_events(),
            [
                TerminalEmulatorEvent::Title("hi".into()),
                TerminalEmulatorEvent::Reply(b"\x1b[1;3R".to_vec()),
                TerminalEmulatorEvent::Bell,
            ]
        );
    }

    #[test]
    fn modes() {
        let mut t = term(5, 2);
        t.feed(b"\x1b[?1h\x1b[?2004h\x1b[?25l");
        assert!(t.modes().application_cursor && t.modes().bracketed_paste);
        assert_eq!(t.cursor(), None);
    }
}
