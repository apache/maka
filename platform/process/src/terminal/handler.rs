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
use alacritty_terminal::{
    event::{Event, EventListener},
    grid::GridCell,
    vte::ansi::*,
};
use unicode_width::UnicodeWidthChar;

const MAX_REPLIES: usize = 1024 * 1024;

#[derive(Default)]
pub(super) struct ReplyBuffer {
    text: String,
    failed: bool,
}
#[derive(Clone)]
pub(super) struct Events(pub Rc<RefCell<ReplyBuffer>>);
impl EventListener for Events {
    fn send_event(&self, event: Event) {
        // UI effects (including OSC clipboard/title requests) never escape the
        // headless parser. Only protocol replies can reach the native PTY.
        if let Event::PtyWrite(text) = event {
            let mut replies = self.0.borrow_mut();
            if replies.text.len() + text.len() > MAX_REPLIES {
                replies.failed = true;
            } else if !replies.failed {
                replies.text.push_str(&text);
            }
        }
    }
}

pub(super) struct State {
    pub term: Term<Events>,
    events: Events,
    pub truncated: bool,
    pub last_alternate: Option<std::sync::Arc<maka_plugin_core::terminal::display::Alternate>>,
    pub mouse: MouseTracking,
    pub encoding: MouseEncoding,
    failed: bool,
    region: std::ops::Range<usize>,
}
impl State {
    pub fn new(term: Term<Events>, events: Events) -> Self {
        let rows = term.screen_lines();
        Self {
            term,
            events,
            truncated: false,
            last_alternate: None,
            mouse: MouseTracking::None,
            encoding: MouseEncoding::Default,
            failed: false,
            region: 0..rows,
        }
    }
    pub fn failed(&self) -> bool {
        self.failed || self.events.0.borrow().failed
    }
    pub fn take_replies(&self) -> String {
        std::mem::take(&mut self.events.0.borrow_mut().text)
    }
    fn loses_history(&mut self, origin: usize, lines: usize) {
        self.truncated |= !self.term.mode().contains(TermMode::ALT_SCREEN)
            && origin == 0
            && self.term.history_size().saturating_add(lines)
                > maka_plugin_core::terminal::history_rows(self.term.columns() as u16);
    }
    fn line_wrap(&mut self) {
        if self.term.grid().cursor.point.line.0 as usize == self.region.end - 1 {
            self.loses_history(self.region.start, 1);
        }
    }
    pub fn resized(&mut self) {
        self.region = 0..self.term.screen_lines();
    }
    fn alternate(&mut self, enabled: bool) {
        let active = self.term.mode().contains(TermMode::ALT_SCREEN);
        if enabled && !active {
            self.last_alternate = None;
        } else if !enabled && active {
            self.last_alternate = Some(std::sync::Arc::new(
                maka_plugin_core::terminal::display::Alternate {
                    size: TerminalSize::new(
                        self.term.columns() as u16,
                        self.term.screen_lines() as u16,
                    )
                    .expect("native terminal geometry"),
                    rows: display::rows(&self.term, 0..self.term.screen_lines() as i32),
                },
            ));
        }
        if active != enabled {
            self.term.swap_alt();
        }
    }
}

macro_rules! forward {
    ($($name:ident($($arg:ident: $ty:ty),*);)*) => {$(
        fn $name(&mut self, $($arg: $ty),*) {
            self.term.$name($($arg),*);
        }
    )*};
}

impl Handler for State {
    forward! {
        set_cursor_style(style: Option<CursorStyle>);
        set_cursor_shape(shape: CursorShape);
        goto(line: i32, col: usize);
        goto_line(line: i32);
        goto_col(col: usize);
        insert_blank(count: usize);
        move_up(count: usize);
        move_down(count: usize);
        identify_terminal(intermediate: Option<char>);
        device_status(kind: usize);
        move_forward(count: usize);
        move_backward(count: usize);
        move_down_and_cr(count: usize);
        move_up_and_cr(count: usize);
        backspace();
        carriage_return();
        substitute();
        set_horizontal_tabstop();
        erase_chars(count: usize);
        delete_chars(count: usize);
        save_cursor_position();
        restore_cursor_position();
        clear_line(mode: LineClearMode);
        clear_tabs(mode: TabulationClearMode);
        set_tabs(interval: u16);
        reverse_index();
        terminal_attribute(attr: Attr);
        set_mode(mode: Mode);
        unset_mode(mode: Mode);
        report_mode(mode: Mode);
        set_keypad_application_mode();
        unset_keypad_application_mode();
        set_active_charset(index: CharsetIndex);
        configure_charset(index: CharsetIndex, charset: StandardCharset);
        set_color(index: usize, color: Rgb);
        reset_color(index: usize);
        decaln();
    }

    fn input(&mut self, c: char) {
        let grid = self.term.grid();
        if c.width() == Some(0) {
            let point = grid.cursor.point;
            let mut col = point.column.0;
            if !grid.cursor.input_needs_wrap {
                col = col.saturating_sub(1);
            }
            if grid[point.line][Column(col)]
                .flags
                .contains(Flags::WIDE_CHAR_SPACER)
            {
                col = col.saturating_sub(1);
            }
            if grid[point.line][Column(col)]
                .zerowidth()
                .is_some_and(|chars| chars.len() >= 32)
            {
                self.failed = true;
                return;
            }
        } else if self.term.mode().contains(TermMode::LINE_WRAP)
            && (grid.cursor.input_needs_wrap
                || (c.width() == Some(2) && grid.cursor.point.column.0 + 1 >= self.term.columns()))
        {
            self.line_wrap();
        }
        self.term.input(c);
    }

    fn linefeed(&mut self) {
        self.line_wrap();
        self.term.linefeed();
    }
    fn newline(&mut self) {
        self.line_wrap();
        self.term.newline();
    }
    fn scroll_up(&mut self, count: usize) {
        self.loses_history(self.region.start, count.min(self.region.len()));
        self.term.scroll_up(count);
    }
    fn scroll_down(&mut self, count: usize) {
        self.term.scroll_down(count);
    }
    fn insert_blank_lines(&mut self, count: usize) {
        self.term.insert_blank_lines(count);
    }
    fn delete_lines(&mut self, count: usize) {
        let origin = self.term.grid().cursor.point.line.0 as usize;
        if self.region.contains(&origin) {
            self.loses_history(origin, count.min(self.region.len()));
        }
        self.term.delete_lines(count);
    }
    fn put_tab(&mut self, count: u16) {
        if self.term.grid().cursor.input_needs_wrap
            && self.term.mode().contains(TermMode::LINE_WRAP)
        {
            self.line_wrap();
        }
        self.term.put_tab(count);
    }
    fn move_forward_tabs(&mut self, count: u16) {
        self.term.move_forward_tabs(count);
    }
    fn move_backward_tabs(&mut self, count: u16) {
        self.term.move_backward_tabs(count);
    }
    fn set_scrolling_region(&mut self, top: usize, bottom: Option<usize>) {
        let bottom = bottom
            .unwrap_or(self.term.screen_lines())
            .min(self.term.screen_lines());
        if top > 0 && top < bottom {
            self.region = top - 1..bottom;
        }
        self.term.set_scrolling_region(top, Some(bottom));
    }
    fn clear_screen(&mut self, mode: ClearMode) {
        if matches!(mode, ClearMode::All) {
            let lines = (0..self.term.screen_lines())
                .rev()
                .find(|&y| {
                    (0..self.term.columns())
                        .any(|x| !self.term.grid()[Line(y as i32)][Column(x)].is_empty())
                })
                .map_or(0, |y| y + 1);
            self.loses_history(0, lines);
        }
        self.term.clear_screen(mode);
    }
    fn reset_state(&mut self) {
        self.term.reset_state();
        self.last_alternate = None;
        self.mouse = MouseTracking::None;
        self.encoding = MouseEncoding::Default;
        self.resized();
    }
    fn set_private_mode(&mut self, mode: PrivateMode) {
        match mode.raw() {
            47 | 1047 | 1049 => {
                self.alternate(true);
                return;
            }
            9 => self.mouse = MouseTracking::X10,
            1000 => self.mouse = MouseTracking::Vt200,
            1002 => self.mouse = MouseTracking::Drag,
            1003 => self.mouse = MouseTracking::Any,
            1006 => self.encoding = MouseEncoding::Sgr,
            1016 => self.encoding = MouseEncoding::SgrPixels,
            _ => {}
        }
        self.term.set_private_mode(mode);
    }
    fn unset_private_mode(&mut self, mode: PrivateMode) {
        match mode.raw() {
            47 | 1047 | 1049 => {
                self.alternate(false);
                return;
            }
            9 | 1000 | 1002 | 1003 => self.mouse = MouseTracking::None,
            1006 | 1016 => self.encoding = MouseEncoding::Default,
            _ => {}
        }
        self.term.unset_private_mode(mode);
    }
    fn report_private_mode(&mut self, mode: PrivateMode) {
        // Do not advertise keyboard encodings the Host's typed input API does
        // not implement. Pixel mouse input is likewise rejected by that API.
        match mode.raw() {
            9 | 1016 => {
                let enabled = if mode.raw() == 9 {
                    self.mouse == MouseTracking::X10
                } else {
                    self.encoding == MouseEncoding::SgrPixels
                };
                self.events.send_event(Event::PtyWrite(format!(
                    "\x1b[?{};{}$y",
                    mode.raw(),
                    if enabled { 1 } else { 2 }
                )));
            }
            _ => self.term.report_private_mode(mode),
        }
    }
    fn text_area_size_chars(&mut self) {
        self.events.send_event(Event::PtyWrite(format!(
            "\x1b[8;{};{}t",
            self.term.screen_lines(),
            self.term.columns()
        )));
    }
}
