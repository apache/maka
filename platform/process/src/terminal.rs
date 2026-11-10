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

use alacritty_terminal::{
    Term,
    grid::Dimensions,
    index::{Column, Line},
    term::{Config, TermMode, cell::Flags},
    vte::ansi,
};
use maka_plugin_core::terminal::MouseEncoding;
use maka_plugin_core::terminal::MouseTracking;
use maka_plugin_core::terminal::TerminalCursor;
use maka_plugin_core::terminal::TerminalInputModes;
use maka_plugin_core::terminal::TerminalScreen;
use maka_plugin_core::terminal::TerminalSize;
use std::{cell::RefCell, rc::Rc};

pub mod display;
mod handler;
use handler::{Events, State};

const MAX_STRING_BYTES: usize = 64 * 1024;

#[derive(Debug, thiserror::Error)]
#[error("terminal screen failed: {0}")]
pub struct ScreenError(&'static str);

/// Pure terminal state. No OS handles, runtime, threads, or external effects.
/// Parsing is synchronous; callers own scheduling, backpressure and persistence.
pub struct Screen {
    parser: ansi::Processor,
    state: State,
    strings: StringLimit,
    failed: bool,
}

impl Screen {
    pub fn new(size: TerminalSize) -> Self {
        let events = Events(Rc::new(RefCell::new(Default::default())));
        let term = Term::new(
            Config {
                scrolling_history: maka_plugin_core::terminal::history_rows(size.cols()),
                ..Default::default()
            },
            &Size(size),
            events.clone(),
        );
        Self {
            parser: ansi::Processor::new(),
            state: State::new(term, events),
            strings: StringLimit::default(),
            failed: false,
        }
    }

    pub fn write(&mut self, mut text: &str) -> Result<String, ScreenError> {
        self.check()?;

        // Native transport decoding belongs to the caller. Keep parser cuts
        // on UTF-8 boundaries too: vte's partial-codepoint path can consume a
        // following ASCII character when its four-byte lookahead spans both.
        while !text.is_empty() {
            let end = text.floor_char_boundary(256.min(text.len()));
            let chunk = &text.as_bytes()[..end];
            text = &text[end..];
            let mut filtered = [0; 256];
            let length = match self.strings.feed(chunk, &mut filtered) {
                Ok(length) => length,
                Err(()) => {
                    self.failed = true;
                    return Err(ScreenError("terminal string exceeds 64 KiB"));
                }
            };
            self.parser.advance(&mut self.state, &filtered[..length]);
            // We have no renderer to batch. Flush synchronized output at the
            // parser cut so replies and persisted state never wait for repaint.
            self.parser.stop_sync(&mut self.state);
            if self.state.failed() {
                self.failed = true;
                return Err(ScreenError("terminal cell or reply budget exceeded"));
            }
        }
        Ok(self.state.take_replies())
    }

    pub fn resize(&mut self, size: TerminalSize) -> Result<(), ScreenError> {
        self.check()?;
        let previous = self.size();
        let history = maka_plugin_core::terminal::history_rows(size.cols());
        // Set the new cell allowance before reflow: trim before width growth,
        // allow additional physical rows when columns shrink.
        // set_options targets the primary grid even while the alternate is active.
        self.state.truncated |= self.state.term.history_size() > history
            || (self.state.term.mode().contains(TermMode::ALT_SCREEN)
                && size.cols() > previous.cols());
        self.state.term.set_options(Config {
            scrolling_history: history,
            ..Default::default()
        });
        self.state.term.resize(Size(size));
        self.state.resized();
        self.state.truncated |= self.state.term.history_size() == history
            && (size.cols() < previous.cols() || size.rows() < previous.rows());
        Ok(())
    }

    pub fn reset_after_gap(&mut self) {
        let size = self.size();
        *self = Self::new(size);
        self.state.truncated = true;
    }

    pub fn size(&self) -> TerminalSize {
        TerminalSize::new(
            self.state.term.columns() as u16,
            self.state.term.screen_lines() as u16,
        )
        .expect("validated terminal dimensions")
    }

    /// Input clients must use the application's current paste mode, not infer
    /// support from the shell name or terminal environment.
    pub fn bracketed_paste(&self) -> bool {
        self.state.term.mode().contains(TermMode::BRACKETED_PASTE)
    }

    pub fn preview(&self, budget: usize) -> Result<TerminalScreen, ScreenError> {
        self.check()?;
        Ok(self.text_preview(budget))
    }

    /// Read-only capture remains available when the first failed input freezes
    /// the successfully applied prefix of the native grid.
    pub fn text_preview(&self, budget: usize) -> TerminalScreen {
        let term = &self.state.term;
        let mut remaining = budget;
        let mut clipped = false;
        let screen = render(term, false, &mut remaining, &mut clipped);
        let alternate = self.state.last_alternate.as_ref().map(|rows| {
            maka_plugin_core::terminal::display::text_rows(
                &rows.rows,
                false,
                &mut remaining,
                &mut clipped,
            )
        });
        let scrollback = render(term, true, &mut remaining, &mut clipped);
        let point = term.grid().cursor.point;
        TerminalScreen {
            screen,
            scrollback,
            last_alternate_screen: alternate.filter(|text| !text.is_empty()),
            size: self.size(),
            cursor: TerminalCursor {
                x: point.column.0 as u16,
                y: point.line.0.max(0) as u16,
                visible: term.mode().contains(TermMode::SHOW_CURSOR),
            },
            alternate_screen: term.mode().contains(TermMode::ALT_SCREEN),
            truncated: self.state.truncated || clipped || self.failed,
            input: self.input_modes(),
        }
    }

    fn input_modes(&self) -> TerminalInputModes {
        TerminalInputModes {
            application_cursor_keys_mode: self.state.term.mode().contains(TermMode::APP_CURSOR),
            mouse_tracking_mode: self.state.mouse,
            mouse_encoding: self.state.encoding,
        }
    }

    fn check(&self) -> Result<(), ScreenError> {
        if self.failed {
            Err(ScreenError("parser is closed after a failed operation"))
        } else {
            Ok(())
        }
    }
}

struct Size(TerminalSize);
impl Dimensions for Size {
    fn columns(&self) -> usize {
        self.0.cols().into()
    }
    fn screen_lines(&self) -> usize {
        self.0.rows().into()
    }
    fn total_lines(&self) -> usize {
        self.screen_lines()
    }
}

/// Bound upstream's OSC accumulator across arbitrary native read boundaries.
/// Clipboard requests have no effect in this headless Screen, so discard their
/// payload as it arrives instead of accumulating base64 just to ignore it later.
/// Other OSC strings retain their original budget and vte handling.
#[derive(Default)]
struct StringLimit {
    escaped: bool,
    osc: Option<OscString>,
    clipboard: bool,
}
struct OscString {
    length: usize,
    clipboard_prefix: Option<usize>,
}
impl StringLimit {
    fn feed(&mut self, bytes: &[u8], filtered: &mut [u8]) -> Result<usize, ()> {
        let mut written = 0;
        for &byte in bytes {
            let mut forwarded = byte;
            if self.clipboard {
                match byte {
                    7 => {
                        self.clipboard = false;
                        continue;
                    }
                    0x18 | 0x1a | 0x1b => {
                        self.clipboard = false;
                        self.escaped = byte == 0x1b;
                    }
                    _ => continue,
                }
            } else if let Some(osc) = &mut self.osc {
                if matches!(byte, 7 | 0x18 | 0x1a | 0x1b) {
                    self.osc = None;
                    self.escaped = byte == 0x1b;
                } else {
                    osc.length += 1;
                    // vte ignores these C0 bytes inside an OSC, including in
                    // the command number. Match its significant-byte prefix.
                    if !matches!(byte, 0..=6 | 8..=0x17 | 0x19 | 0x1c..=0x1f) {
                        osc.clipboard_prefix = osc
                            .clipboard_prefix
                            .and_then(|index| (byte == b"52;"[index]).then_some(index + 1));
                    }
                    if osc.clipboard_prefix == Some(3) {
                        self.osc = None;
                        self.clipboard = true;
                        // End the upstream's tiny partial OSC before discarding
                        // subsequent bytes. CAN has no visible or reply effect.
                        forwarded = 0x18;
                    } else if osc.length > MAX_STRING_BYTES {
                        return Err(());
                    }
                }
            } else if byte == 0x1b {
                self.escaped = true;
            } else if self.escaped {
                match byte {
                    b']' => {
                        self.osc = Some(OscString {
                            length: 0,
                            clipboard_prefix: Some(0),
                        });
                        self.escaped = false;
                    }
                    0..=0x17 | 0x19 | 0x1c..=0x1f => {}
                    _ => self.escaped = false,
                }
            }
            filtered[written] = forwarded;
            written += 1;
        }
        Ok(written)
    }
}

fn render(term: &Term<Events>, history: bool, remaining: &mut usize, clipped: &mut bool) -> String {
    let count = if history {
        term.history_size()
    } else {
        term.screen_lines()
    };
    let mut lines = Vec::new();
    for index in 0..count {
        if *remaining == 0 {
            *clipped = true;
            break;
        }
        *remaining -= 1; // A row costs work even when every cell is blank.
        let y = if history {
            -1 - index as i32
        } else {
            index as i32
        };
        let row = &term.grid()[Line(y)];
        let mut text = String::new();
        for x in 0..term.columns() {
            let cell = &row[Column(x)];
            for c in
                std::iter::once(cell.c).chain(cell.zerowidth().unwrap_or_default().iter().copied())
            {
                if c.len_utf8() > *remaining {
                    *remaining = 0;
                    *clipped = true;
                    break;
                }
                *remaining -= c.len_utf8();
                if !cell
                    .flags
                    .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
                {
                    text.push(c);
                }
            }
            if *remaining == 0 {
                *clipped |= x + 1 < term.columns();
                break;
            }
        }
        text.truncate(text.trim_end_matches(' ').len());
        let wrapped = row[Column(term.columns() - 1)]
            .flags
            .contains(Flags::WRAPLINE);
        lines.push((text, wrapped));
    }
    if history {
        lines.reverse();
    }
    let mut out = String::new();
    let mut previous_wrapped = true;
    for (index, (line, wrapped)) in lines.into_iter().enumerate() {
        if index != 0 && (!history || !previous_wrapped) {
            out.push('\n');
        }
        out.push_str(&line);
        previous_wrapped = wrapped;
    }
    if !history {
        out.truncate(out.trim_end_matches('\n').len());
    }
    out
}
