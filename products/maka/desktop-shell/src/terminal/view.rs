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

//! One terminal's retained view: its emulator and the parser that feeds it
//! off the main thread, the latest picture, and what the person does to it.
//!
//! Keys, text (the IME's included), pastes, and mouse reports become the
//! Host's input actions ([`super::input`]) and go to the script as
//! [`TerminalEvent::Input`]: the script holds the controller and sends them,
//! so the view sends nothing itself. The keyboard's input is reported
//! whether or not the script holds the controller (typing is what takes it);
//! the mouse goes to a program that asked for it, and the wheel and
//! Shift-Page Up/Down to a full-screen one, only while the script holds it
//! ([`Options::controlled`]). The selection, ⌘C and the scrollback are the
//! view's own. Pictures from the parser are shown in batches, as maka-gpui's
//! terminal shows them: the first at once, then what follows within
//! [`BATCH_WINDOW`] together, so a stream of output costs a frame per batch.

use std::cell::Cell;
use std::ops::Range;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use alacritty_terminal::grid::Scroll;
use alacritty_terminal::index::{Column, Line, Point, Side};
use alacritty_terminal::selection::SelectionType;
use alacritty_terminal::sync::FairMutex;
use alacritty_terminal::term::TermMode;
use alacritty_terminal::vte::ansi::CursorShape;
use futures_lite::future;
use gpui_shell::gpui;
use gpui_shell::gpui::{
    App, AppContext as _, Bounds, ClipboardItem, Context, EntityInputHandler, EventEmitter,
    FocusHandle, InteractiveElement as _, IntoElement, KeyBinding, KeyDownEvent, MouseButton,
    MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement as _, Pixels, Render, ScrollDelta,
    ScrollWheelEvent, Styled as _, Subscription, Task, UTF16Selection, Window, div,
};

use super::element::{GridGeometry, TerminalElement};
use super::emulator::{self, Emulator, Feed, GridSize, Snapshot, TerminalContent};
use super::input::{self, InputAction, MouseEvent};
use super::palette::TerminalPalette;

/// The first picture is shown at once; what follows within this window is
/// shown together.
const BATCH_WINDOW: Duration = Duration::from_millis(4);
/// At most this many pictures go into one batch.
const BATCH_LIMIT: usize = 100;
/// Pictures the parser may publish before the window takes them.
const PICTURES_IN_FLIGHT: usize = 4;
/// How long each phase of the cursor's blink lasts, shown and hidden.
const BLINK_INTERVAL: Duration = Duration::from_millis(500);
/// How long the cursor holds still after input and output.
const BLINK_PAUSE: Duration = Duration::from_millis(500);

/// The key context the terminal's bindings live in.
pub(crate) const CONTEXT: &str = "MakaTerminal";

gpui::actions!(
    maka_terminal,
    [
        /// Tab, to the program: the window's root binds it to move focus.
        SendTab,
        /// Shift-Tab, to the program.
        SendShiftTab,
        /// Copies the selection.
        Copy,
        /// Pastes the clipboard's text.
        Paste,
        /// Selects the scrollback and the screen.
        SelectAll,
        /// Scrolls the scrollback a page up (Shift-Page Up).
        ScrollPageUp,
        /// Scrolls the scrollback a page down (Shift-Page Down).
        ScrollPageDown,
    ]
);

/// Binds the terminal's keys.
pub(crate) fn init(cx: &mut App) {
    cx.bind_keys(bindings(cfg!(target_os = "macos")));
}

/// The terminal's keys, in its own context so they win over the window
/// root's Tab and copy. Away from macOS the root copies with Ctrl-C, which
/// the program needs (an interrupt), so the terminal unbinds it there and
/// copies and pastes with Ctrl-Shift-C and -V.
fn bindings(macos: bool) -> Vec<KeyBinding> {
    let context = Some(CONTEXT);
    let mut bindings = vec![
        KeyBinding::new("tab", SendTab, context),
        KeyBinding::new("shift-tab", SendShiftTab, context),
        KeyBinding::new("shift-pageup", ScrollPageUp, context),
        KeyBinding::new("shift-pagedown", ScrollPageDown, context),
    ];
    if macos {
        bindings.extend([
            KeyBinding::new("cmd-c", Copy, context),
            KeyBinding::new("cmd-v", Paste, context),
            KeyBinding::new("cmd-a", SelectAll, context),
        ]);
    } else {
        bindings.extend([
            KeyBinding::new("ctrl-c", gpui::NoAction, context),
            KeyBinding::new("ctrl-shift-c", Copy, context),
            KeyBinding::new("ctrl-shift-v", Paste, context),
            KeyBinding::new("ctrl-shift-a", SelectAll, context),
        ]);
    }
    bindings
}

/// What the view tells the script.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum TerminalEvent {
    /// The person typed, pasted or used the mouse: actions for `control`.
    Input(Vec<InputAction>),
    /// The grid the view's bounds hold changed: the size to ask the PTY for.
    Resize(GridSize),
    /// The person pressed in the terminal: it took the keyboard.
    Activate,
    /// Whether the view shows the bottom of the output, when that changed.
    Scrolled { at_bottom: bool },
}

/// How the script draws it this frame, set by the element's methods.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Options {
    pub palette: TerminalPalette,
    /// Whether to draw the cursor (not over an ended terminal).
    pub cursor: bool,
    /// Whether the script holds the controller, so what is reported reaches
    /// the program. Without it a press selects and the wheel scrolls the
    /// scrollback, as in a terminal whose program asked for nothing.
    pub controlled: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            palette: TerminalPalette::default(),
            cursor: true,
            controlled: false,
        }
    }
}

/// The platform's button for a reported one.
fn platform_button(button: input::MouseButton) -> MouseButton {
    match button {
        input::MouseButton::Left => MouseButton::Left,
        input::MouseButton::Middle => MouseButton::Middle,
        input::MouseButton::Right => MouseButton::Right,
    }
}

/// `range` (in UTF-16 units, as the platform's text input counts) of
/// `text`, clamped to it, and the range it took.
fn utf16_slice(text: &str, range: Range<usize>) -> (String, Range<usize>) {
    let utf16: Vec<u16> = text.encode_utf16().collect();
    let start = range.start.min(utf16.len());
    let range = start..range.end.clamp(start, utf16.len());
    (String::from_utf16_lossy(&utf16[range.clone()]), range)
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// What a press started.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Pressed {
    Selecting,
    /// The program asked for the mouse: the drag and release go to it.
    Reporting(input::MouseButton),
}

impl Pressed {
    /// Whether a move with `down` held continues the press. Without the
    /// press's own button its release was missed (it happened where the
    /// window did not see it), and the press ends there.
    fn lasts(self, down: Option<MouseButton>) -> bool {
        let button = match self {
            Pressed::Selecting => MouseButton::Left,
            Pressed::Reporting(button) => platform_button(button),
        };
        down == Some(button)
    }

    /// The button the program gets a release of when the press ends: only
    /// a press it got. A selection just stops following the pointer.
    fn reported(self) -> Option<input::MouseButton> {
        match self {
            Pressed::Selecting => None,
            Pressed::Reporting(button) => Some(button),
        }
    }
}

/// Whether the mouse goes to the program: it asked for it in SGR's encoding
/// (the only one the Host sends; it drops the others), and the script holds
/// the controller. Otherwise a press selects and the wheel scrolls, as in a
/// terminal whose program asked for nothing.
fn reports_mouse(mode: TermMode, controlled: bool) -> bool {
    controlled && mode.intersects(TermMode::MOUSE_MODE) && mode.contains(TermMode::SGR_MOUSE)
}

/// Where the wheel and Shift-Page Up/Down go.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Scrolling {
    /// The scrollback, the view's own.
    Scrollback,
    /// The program, as mouse reports (the wheel, when it asked for the mouse).
    Reports,
    /// The program, as keys: arrows for the wheel, the page keys for
    /// Shift-Page Up/Down.
    Keys,
    /// Nowhere: a full-screen program has no scrollback, and the script
    /// does not hold the controller (or, for the wheel, the program did not
    /// ask for alternate scroll).
    Nowhere,
}

/// Where the wheel goes: mouse reports while [`reports_mouse`], arrow keys
/// to a full-screen program with alternate scroll while the script holds
/// the controller, otherwise the scrollback (none on the alternate screen).
fn wheel_goes(mode: TermMode, controlled: bool) -> Scrolling {
    if reports_mouse(mode, controlled) {
        Scrolling::Reports
    } else if !mode.contains(TermMode::ALT_SCREEN) {
        Scrolling::Scrollback
    } else if controlled && mode.contains(TermMode::ALTERNATE_SCROLL) {
        Scrolling::Keys
    } else {
        Scrolling::Nowhere
    }
}

/// Where Shift-Page Up/Down goes: the scrollback, or on the alternate screen
/// the program's own keys while the script holds the controller.
fn page_goes(mode: TermMode, controlled: bool) -> Scrolling {
    if !mode.contains(TermMode::ALT_SCREEN) {
        Scrolling::Scrollback
    } else if controlled {
        Scrolling::Keys
    } else {
        Scrolling::Nowhere
    }
}

/// The cursor's blink. The timer toggles `visible` while `blinking`; every
/// pause or change bumps `epoch`, which stops an older timer.
struct CursorBlink {
    visible: bool,
    blinking: bool,
    epoch: u64,
    _timer: Option<Task<()>>,
}

pub(crate) struct TerminalView {
    focus: FocusHandle,
    /// `None` while the script has it closed.
    parser: Option<Parser>,
    content: Arc<TerminalContent>,
    /// Written by the element's materializer on each script render.
    options: Rc<Cell<Options>>,
    /// The IME's composition so far.
    marked: Option<String>,
    geometry: Rc<Cell<Option<GridGeometry>>>,
    pressed: Option<Pressed>,
    /// The last cell a mouse report was sent for, so a move within a cell
    /// sends nothing.
    reported_cell: Option<(usize, usize)>,
    /// Wheel lines not yet whole.
    scroll_remainder: f32,
    /// The grid last reported with [`TerminalEvent::Resize`].
    grid: Option<GridSize>,
    at_bottom: bool,
    focused: bool,
    blink: CursorBlink,
    _focus: [Subscription; 2],
}

/// The emulator, the background parser that feeds it, and the task that
/// shows its pictures in batches.
struct Parser {
    emulator: Arc<FairMutex<Emulator>>,
    feeds: async_channel::Sender<Feed>,
    _parse: Task<()>,
    _batches: Task<()>,
}

impl Parser {
    fn start(size: GridSize, cx: &mut Context<TerminalView>) -> Self {
        let emulator = Arc::new(FairMutex::new(Emulator::new(size)));
        let (feeds, feed_receiver) = async_channel::unbounded();
        // Each picture copies the visible cells: while the window is busy the
        // parser waits instead of piling them up.
        let (parsed, parsed_receiver) = async_channel::bounded(PICTURES_IN_FLIGHT);
        let executor = cx.background_executor().clone();
        let parse = cx.background_spawn(emulator::parse(
            emulator.clone(),
            feed_receiver,
            parsed,
            move |duration| Box::pin(executor.timer(duration)),
        ));
        let batches = cx.spawn(async move |this, cx| {
            while let Ok(first) = parsed_receiver.recv().await {
                if this.update(cx, |this, cx| this.show(first, cx)).is_err() {
                    return;
                }
                let mut latest = None;
                let mut count = 0;
                let mut window = cx.background_executor().timer(BATCH_WINDOW);
                while count < BATCH_LIMIT {
                    let next = future::or(async { parsed_receiver.recv().await.ok() }, async {
                        (&mut window).await;
                        None
                    })
                    .await;
                    let Some(parsed) = next else { break };
                    latest = Some(parsed);
                    count += 1;
                }
                if let Some(latest) = latest
                    && this.update(cx, |this, cx| this.show(latest, cx)).is_err()
                {
                    return;
                }
            }
        });
        Self {
            emulator,
            feeds,
            _parse: parse,
            _batches: batches,
        }
    }
}

impl EventEmitter<TerminalEvent> for TerminalView {}

impl TerminalView {
    pub(crate) fn new(
        options: Rc<Cell<Options>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let focus = cx.focus_handle();
        let parser = Parser::start(GridSize::new(80, 24), cx);
        let content = Arc::new(parser.emulator.lock().content());
        let focus_in = cx.on_focus_in(&focus, window, |this, _, cx| this.focus_changed(true, cx));
        let focus_out = cx.on_focus_out(&focus, window, |this, _, _, cx| {
            this.focus_changed(false, cx)
        });
        Self {
            focus,
            parser: Some(parser),
            content,
            options,
            marked: None,
            geometry: Rc::new(Cell::new(None)),
            pressed: None,
            reported_cell: None,
            scroll_remainder: 0.,
            grid: None,
            at_bottom: true,
            focused: false,
            blink: CursorBlink {
                visible: true,
                blinking: false,
                epoch: 0,
                _timer: None,
            },
            _focus: [focus_in, focus_out],
        }
    }

    // What the script asks.

    /// Hands `feed` to the parser, in order with every other.
    pub(crate) fn feed(&self, feed: Feed) {
        if let Some(parser) = &self.parser {
            parser.feeds.try_send(feed).ok();
        }
    }

    /// A closed view starts again with a new emulator.
    fn revive(&mut self, size: GridSize, cx: &mut Context<Self>) {
        if self.parser.is_none() {
            self.parser = Some(Parser::start(size, cx));
        }
    }

    pub(crate) fn feed_output(&self, data: String) {
        self.feed(Feed::Output(data));
    }

    pub(crate) fn resize(&self, size: GridSize) {
        self.feed(Feed::Resize(size));
    }

    pub(crate) fn reset(&mut self, size: GridSize, cx: &mut Context<Self>) {
        self.marked = None;
        self.revive(size, cx);
        self.feed(Feed::Reset(size));
    }

    pub(crate) fn paint(&mut self, snapshot: Snapshot, cx: &mut Context<Self>) {
        self.marked = None;
        self.revive(snapshot.size, cx);
        self.feed(Feed::Paint(snapshot));
    }

    pub(crate) fn focus(&self, window: &mut Window, cx: &mut App) {
        self.focus.focus(window, cx);
    }

    pub(crate) fn scroll_to_bottom(&self) {
        self.feed(Feed::Scroll(Scroll::Bottom));
    }

    /// The visible text, for the dev driver and tests.
    pub(crate) fn text(&self) -> String {
        self.content.text()
    }

    /// Ends the parser and lets the emulator go: a retained state lives as
    /// long as the script's application, so a terminal the script is done
    /// with keeps only this empty view, until `reset` or `paint` use it for
    /// another.
    pub(crate) fn close(&mut self, cx: &mut Context<Self>) {
        self.parser = None;
        self.marked = None;
        self.grid = None;
        self.at_bottom = true;
        self.blink.epoch += 1;
        self.blink.blinking = false;
        self.blink._timer = None;
        self.content = Arc::new(Emulator::new(GridSize::new(1, 1)).content());
        cx.notify();
    }

    pub(crate) fn reported_grid(&self) -> Option<GridSize> {
        self.grid
    }

    /// The element measured the grid its bounds hold.
    pub(crate) fn fits(&mut self, grid: GridSize, cx: &mut Context<Self>) {
        if self.grid != Some(grid) {
            self.grid = Some(grid);
            cx.emit(TerminalEvent::Resize(grid));
        }
    }

    /// A picture from the parser.
    fn show(&mut self, content: Arc<TerminalContent>, cx: &mut Context<Self>) {
        if self.parser.is_none() {
            return;
        }
        let at_bottom = content.display_offset == 0;
        self.content = content;
        if at_bottom != self.at_bottom {
            self.at_bottom = at_bottom;
            cx.emit(TerminalEvent::Scrolled { at_bottom });
        }
        self.sync_blink(cx);
        self.hold_blink(cx);
        cx.notify();
    }

    // The cursor's blink: only while focused, as the cursor's style asks.

    fn focus_changed(&mut self, focused: bool, cx: &mut Context<Self>) {
        self.focused = focused;
        self.sync_blink(cx);
        cx.notify();
    }

    fn wants_blink(&self, cx: &App) -> bool {
        self.focused
            && !cx.reduce_motion()
            && self.options.get().cursor
            && self.content.cursor.blinking
            && self.content.cursor.shape != CursorShape::Hidden
    }

    fn sync_blink(&mut self, cx: &mut Context<Self>) {
        let wanted = self.wants_blink(cx);
        if wanted == self.blink.blinking {
            return;
        }
        self.blink.blinking = wanted;
        self.blink.visible = true;
        self.blink.epoch += 1;
        self.blink._timer = None;
        if wanted {
            self.schedule_blink(BLINK_INTERVAL, cx);
        }
        cx.notify();
    }

    /// Input or output: the cursor shows and holds still for a moment.
    fn hold_blink(&mut self, cx: &mut Context<Self>) {
        if !self.blink.blinking {
            return;
        }
        self.blink.epoch += 1;
        if !std::mem::replace(&mut self.blink.visible, true) {
            cx.notify();
        }
        self.schedule_blink(BLINK_PAUSE, cx);
    }

    fn schedule_blink(&mut self, delay: Duration, cx: &mut Context<Self>) {
        let epoch = self.blink.epoch;
        self.blink._timer = Some(cx.spawn(async move |this, cx| {
            let mut delay = delay;
            loop {
                cx.background_executor().timer(delay).await;
                let going = this.update(cx, |this, cx| {
                    if this.blink.epoch != epoch || !this.blink.blinking {
                        return false;
                    }
                    this.blink.visible = !this.blink.visible;
                    cx.notify();
                    true
                });
                if !matches!(going, Ok(true)) {
                    return;
                }
                delay = BLINK_INTERVAL;
            }
        }));
    }

    // Input.

    /// Sends `actions` to the script, and returns the view to the bottom,
    /// where the program writes.
    fn send(&mut self, actions: Vec<InputAction>, cx: &mut Context<Self>) {
        if actions.is_empty() {
            return;
        }
        if self.content.display_offset > 0 {
            self.scroll_to_bottom();
        }
        // Typing replaces what was selected, as in a shell's line editor.
        if self.content.selection.is_some() {
            self.feed(Feed::ClearSelection);
        }
        self.hold_blink(cx);
        cx.emit(TerminalEvent::Input(actions));
    }

    fn key_down(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        // While the IME composes, the keys are its.
        if self.marked.is_some() {
            return;
        }
        if let Some(actions) = input::key_actions(&event.keystroke) {
            self.send(actions, cx);
            cx.stop_propagation();
        }
    }

    fn send_tab(&mut self, _: &SendTab, _: &mut Window, cx: &mut Context<Self>) {
        self.send(
            vec![InputAction::Key {
                key: "tab".into(),
                modifiers: vec![],
            }],
            cx,
        );
    }

    fn send_shift_tab(&mut self, _: &SendShiftTab, _: &mut Window, cx: &mut Context<Self>) {
        self.send(
            vec![InputAction::Key {
                key: "tab".into(),
                modifiers: vec!["shift"],
            }],
            cx,
        );
    }

    /// ⌘C: copies the selection, read off the main thread; without one it
    /// does nothing.
    fn copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        let Some(emulator) = self.parser.as_ref().map(|parser| parser.emulator.clone()) else {
            return;
        };
        let text = cx.background_spawn(async move { emulator.lock().selection_text() });
        cx.spawn(async move |_, cx| {
            if let Some(text) = text.await {
                cx.update(|cx| cx.write_to_clipboard(ClipboardItem::new_string(text)));
            }
        })
        .detach();
    }

    /// ⌘V: the clipboard's text.
    fn paste(&mut self, _: &Paste, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
            self.send(input::paste_actions(&text), cx);
        }
    }

    fn select_all(&mut self, _: &SelectAll, _: &mut Window, _: &mut Context<Self>) {
        self.feed(Feed::SelectAll);
    }

    /// A page of the scrollback. A full-screen program has none: it gets
    /// the key while the script holds the controller, and otherwise nothing
    /// happens.
    fn scroll_page(&mut self, up: bool, cx: &mut Context<Self>) {
        match page_goes(self.content.mode, self.options.get().controlled) {
            Scrolling::Keys => {
                let key = if up { "page_up" } else { "page_down" };
                self.send(
                    vec![InputAction::Key {
                        key: key.into(),
                        modifiers: vec!["shift"],
                    }],
                    cx,
                );
            }
            Scrolling::Scrollback => self.feed(Feed::Scroll(if up {
                Scroll::PageUp
            } else {
                Scroll::PageDown
            })),
            Scrolling::Reports | Scrolling::Nowhere => {}
        }
    }

    fn scroll_page_up(&mut self, _: &ScrollPageUp, _: &mut Window, cx: &mut Context<Self>) {
        self.scroll_page(true, cx);
    }

    fn scroll_page_down(&mut self, _: &ScrollPageDown, _: &mut Window, cx: &mut Context<Self>) {
        self.scroll_page(false, cx);
    }

    // The pointer.

    fn cell_at(&self, position: gpui::Point<Pixels>) -> Option<(usize, usize, bool)> {
        let geometry = self.geometry.get()?;
        (geometry.columns > 0 && geometry.rows > 0).then(|| geometry.cell_at(position))
    }

    /// The grid point of the cell at `column`, `row` of the screen.
    fn grid_point(&self, column: usize, row: usize) -> Point {
        let offset = i32::try_from(self.content.display_offset).unwrap_or(0);
        Point::new(
            Line(i32::try_from(row).unwrap_or(0) - offset),
            Column(column),
        )
    }

    /// Whether the mouse goes to the program ([`reports_mouse`]).
    fn reports_mouse(&self) -> bool {
        reports_mouse(self.content.mode, self.options.get().controlled)
    }

    fn report(
        &mut self,
        event: MouseEvent,
        (column, row): (usize, usize),
        modifiers: &gpui::Modifiers,
        cx: &mut Context<Self>,
    ) {
        self.reported_cell = Some((column, row));
        cx.emit(TerminalEvent::Input(vec![InputAction::Mouse {
            event,
            x: column,
            y: row,
            modifiers: input::mouse_modifiers(modifiers),
        }]));
    }

    fn mouse_down(&mut self, event: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        self.focus.focus(window, cx);
        cx.emit(TerminalEvent::Activate);
        let Some((column, row, right)) = self.cell_at(event.position) else {
            return;
        };
        let button = match event.button {
            MouseButton::Left => input::MouseButton::Left,
            MouseButton::Middle => input::MouseButton::Middle,
            MouseButton::Right => input::MouseButton::Right,
            _ => return,
        };
        // Shift selects even when the program asked for the mouse.
        if self.reports_mouse() && !event.modifiers.shift {
            self.report(
                MouseEvent::Press(button),
                (column, row),
                &event.modifiers,
                cx,
            );
            self.pressed = Some(Pressed::Reporting(button));
            return;
        }
        if button != input::MouseButton::Left {
            return;
        }
        let point = self.grid_point(column, row);
        let side = if right { Side::Right } else { Side::Left };
        let feed = match event.click_count {
            1 if event.modifiers.shift && self.content.selection.is_some() => {
                Feed::UpdateSelection(point, side)
            }
            1 => Feed::StartSelection(SelectionType::Simple, point, side),
            2 => Feed::StartSelection(SelectionType::Semantic, point, side),
            _ => Feed::StartSelection(SelectionType::Lines, point, side),
        };
        self.feed(feed);
        self.pressed = Some(Pressed::Selecting);
    }

    /// A move over the terminal with no button down: a hover report, to a
    /// program that asked for every motion. A press's drag is the window's
    /// to follow ([`Self::drag`]).
    fn mouse_move(&mut self, event: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        if self.pressed.is_some() {
            return;
        }
        let Some((column, row, _)) = self.cell_at(event.position) else {
            return;
        };
        if self.reports_mouse()
            && self.content.mode.contains(TermMode::MOUSE_MOTION)
            && self.focused
            && self.reported_cell != Some((column, row))
        {
            self.report(MouseEvent::Move(None), (column, row), &event.modifiers, cx);
        }
    }

    /// A move anywhere in the window while a press that started here lasts:
    /// the selection follows it, or the program gets the drag. A move without
    /// the press's button down means its release was missed: the press ends
    /// there.
    pub(crate) fn drag(&mut self, event: &MouseMoveEvent, cx: &mut Context<Self>) {
        let Some(pressed) = self.pressed else {
            return;
        };
        if !pressed.lasts(event.pressed_button) {
            self.end_press(event.position, &event.modifiers, cx);
            return;
        }
        let Some((column, row, right)) = self.cell_at(event.position) else {
            return;
        };
        match pressed {
            Pressed::Selecting => {
                let point = self.grid_point(column, row);
                let side = if right { Side::Right } else { Side::Left };
                self.feed(Feed::UpdateSelection(point, side));
            }
            Pressed::Reporting(button) if self.reported_cell != Some((column, row)) => {
                self.report(
                    MouseEvent::Move(Some(button)),
                    (column, row),
                    &event.modifiers,
                    cx,
                );
            }
            Pressed::Reporting(_) => {}
        }
    }

    /// The release of a press that started here, wherever in the window it
    /// happens.
    pub(crate) fn release(&mut self, event: &MouseUpEvent, cx: &mut Context<Self>) {
        self.end_press(event.position, &event.modifiers, cx);
    }

    fn end_press(
        &mut self,
        position: gpui::Point<Pixels>,
        modifiers: &gpui::Modifiers,
        cx: &mut Context<Self>,
    ) {
        if let Some(button) = self.pressed.take().and_then(Pressed::reported)
            && let Some((column, row, _)) = self.cell_at(position)
        {
            self.report(MouseEvent::Release(button), (column, row), modifiers, cx);
        }
    }

    /// The wheel and the trackpad: pixel deltas add up into lines; whole
    /// lines scroll the scrollback, or go to the program as mouse reports
    /// or (on a full-screen program with alternate scroll) arrow keys.
    fn scroll_wheel(&mut self, event: &ScrollWheelEvent, _: &mut Window, cx: &mut Context<Self>) {
        let line_height = self.geometry.get().map(|geometry| geometry.cell.height);
        let lines = match event.delta {
            ScrollDelta::Lines(delta) => delta.y,
            ScrollDelta::Pixels(delta) => match line_height {
                Some(height) if height > Pixels::ZERO => f32::from(delta.y) / f32::from(height),
                _ => 0.,
            },
        };
        self.scroll_remainder += lines;
        let whole = self.scroll_remainder.trunc();
        if whole == 0. {
            return;
        }
        self.scroll_remainder -= whole;
        let lines = whole as i32;
        cx.stop_propagation();
        let count = lines.unsigned_abs().min(64);
        match wheel_goes(self.content.mode, self.options.get().controlled) {
            Scrolling::Reports => {
                let Some((column, row, _)) = self.cell_at(event.position) else {
                    return;
                };
                let actions = (0..count)
                    .map(|_| InputAction::Mouse {
                        event: MouseEvent::Scroll(lines > 0),
                        x: column,
                        y: row,
                        modifiers: input::mouse_modifiers(&event.modifiers),
                    })
                    .collect();
                cx.emit(TerminalEvent::Input(actions));
            }
            // A full-screen program has no scrollback: with alternate scroll
            // the wheel is its arrow keys.
            Scrolling::Keys => {
                let key = if lines > 0 { "arrow_up" } else { "arrow_down" };
                let actions = (0..count)
                    .map(|_| InputAction::Key {
                        key: key.into(),
                        modifiers: vec![],
                    })
                    .collect();
                cx.emit(TerminalEvent::Input(actions));
            }
            Scrolling::Scrollback => self.feed(Feed::Scroll(Scroll::Delta(lines))),
            Scrolling::Nowhere => {}
        }
    }
}

impl Render for TerminalView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let options = self.options.get();
        let focused = self.focus.is_focused(window);
        div()
            .id("maka-terminal")
            .key_context(CONTEXT)
            .track_focus(&self.focus)
            .size_full()
            .on_key_down(cx.listener(Self::key_down))
            .on_action(cx.listener(Self::send_tab))
            .on_action(cx.listener(Self::send_shift_tab))
            .on_action(cx.listener(Self::copy))
            .on_action(cx.listener(Self::paste))
            .on_action(cx.listener(Self::select_all))
            .on_action(cx.listener(Self::scroll_page_up))
            .on_action(cx.listener(Self::scroll_page_down))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::mouse_down))
            .on_mouse_down(MouseButton::Middle, cx.listener(Self::mouse_down))
            .on_mouse_down(MouseButton::Right, cx.listener(Self::mouse_down))
            .on_mouse_move(cx.listener(Self::mouse_move))
            .on_scroll_wheel(cx.listener(Self::scroll_wheel))
            .child(TerminalElement {
                view: cx.entity(),
                focus: self.focus.clone(),
                content: self.content.clone(),
                palette: options.palette,
                focused,
                cursor: options.cursor,
                cursor_blinked_off: !self.blink.visible,
                marked: self.marked.clone(),
                geometry: self.geometry.clone(),
            })
    }
}

impl EntityInputHandler for TerminalView {
    fn text_for_range(
        &mut self,
        range: Range<usize>,
        adjusted_range: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let (text, range) = utf16_slice(self.marked.as_ref()?, range);
        *adjusted_range = Some(range);
        Some(text)
    }

    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        let end = self.marked.as_deref().map_or(0, utf16_len);
        Some(UTF16Selection {
            range: end..end,
            reversed: false,
        })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked.as_deref().map(|marked| 0..utf16_len(marked))
    }

    fn unmark_text(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        if self.marked.take().is_some() {
            cx.notify();
        }
    }

    /// The platform's paste (the Edit menu) is a paste, not typing.
    fn paste(&mut self, item: ClipboardItem, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = item.text() {
            self.send(input::paste_actions(&text), cx);
        }
    }

    /// Committed text (typed, or what the IME composed) goes to the
    /// program.
    fn replace_text_in_range(
        &mut self,
        _: Option<Range<usize>>,
        text: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.marked = None;
        self.send(input::text_actions(text), cx);
        cx.notify();
    }

    /// The IME's composition so far: drawn at the cursor, sent once
    /// committed.
    fn replace_and_mark_text_in_range(
        &mut self,
        _: Option<Range<usize>>,
        new_text: &str,
        _: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.marked = (!new_text.is_empty()).then(|| new_text.to_owned());
        cx.notify();
    }

    /// The cursor's cell: where the IME's candidates open.
    fn bounds_for_range(
        &mut self,
        _: Range<usize>,
        element_bounds: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let geometry = self.geometry.get();
        Some(
            geometry
                .and_then(|geometry| geometry.cursor)
                .unwrap_or(Bounds::new(
                    element_bounds.origin,
                    geometry.map_or(element_bounds.size, |geometry| geometry.cell),
                )),
        )
    }

    fn character_index_for_point(
        &mut self,
        _: gpui::Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What the keymap gives `keystroke` in a terminal under the window's
    /// root, which binds Tab and its copy (⌘C on macOS, Ctrl-C elsewhere):
    /// the actions in the order they are tried, the first handled winning.
    fn bound(macos: bool, keystroke: &str) -> Vec<String> {
        gpui::actions!(shell_root, [RootTab, RootCopy]);
        let root = Some("ShellRoot");
        let mut keymap = gpui::Keymap::new(vec![
            KeyBinding::new("tab", RootTab, root),
            KeyBinding::new(if macos { "cmd-c" } else { "ctrl-c" }, RootCopy, root),
        ]);
        keymap.add_bindings(bindings(macos));
        let stack = ["ShellRoot", CONTEXT].map(|context| gpui::KeyContext::parse(context).unwrap());
        let keystroke = gpui::Keystroke::parse(keystroke).unwrap();
        keymap
            .bindings_for_input(&[keystroke], &stack)
            .0
            .iter()
            .map(|binding| binding.action().name().to_owned())
            .collect()
    }

    #[test]
    fn the_program_keeps_ctrl_c_and_tab() {
        for macos in [true, false] {
            assert!(
                bound(macos, "ctrl-c").is_empty(),
                "ctrl-c is bound (macOS {macos})"
            );
            assert_eq!(bound(macos, "tab")[0], "maka_terminal::SendTab");
        }
        assert_eq!(bound(true, "cmd-c")[0], "maka_terminal::Copy");
        assert_eq!(bound(false, "ctrl-shift-c"), ["maka_terminal::Copy"]);
    }

    #[test]
    fn the_mouse_goes_to_the_program_only_in_sgr_while_held() {
        let clicks = TermMode::MOUSE_REPORT_CLICK | TermMode::SGR_MOUSE;
        assert!(reports_mouse(clicks, true));
        assert!(reports_mouse(
            TermMode::MOUSE_DRAG | TermMode::SGR_MOUSE,
            true
        ));
        // Not while the script does not hold the controller,
        assert!(!reports_mouse(clicks, false));
        // not in the default encoding, which the Host drops,
        assert!(!reports_mouse(TermMode::MOUSE_REPORT_CLICK, true));
        // and not when the program asked for no mouse.
        assert!(!reports_mouse(TermMode::SGR_MOUSE, true));
    }

    #[test]
    fn the_wheel_reaches_a_full_screen_program_only_while_held() {
        let full_screen = TermMode::ALT_SCREEN | TermMode::ALTERNATE_SCROLL;
        let mouse = TermMode::MOUSE_REPORT_CLICK | TermMode::SGR_MOUSE;
        assert_eq!(wheel_goes(full_screen, true), Scrolling::Keys);
        assert_eq!(wheel_goes(full_screen, false), Scrolling::Nowhere);
        assert_eq!(wheel_goes(TermMode::ALT_SCREEN, true), Scrolling::Nowhere);
        assert_eq!(wheel_goes(full_screen | mouse, true), Scrolling::Reports);
        assert_eq!(wheel_goes(mouse, true), Scrolling::Reports);
        // A program's mouse without the controller: the wheel scrolls the
        // scrollback, or on the alternate screen does nothing.
        assert_eq!(wheel_goes(mouse, false), Scrolling::Scrollback);
        assert_eq!(wheel_goes(full_screen | mouse, false), Scrolling::Nowhere);
        // A mouse the Host cannot send scrolls too.
        assert_eq!(
            wheel_goes(TermMode::MOUSE_REPORT_CLICK, true),
            Scrolling::Scrollback
        );
        assert_eq!(wheel_goes(TermMode::empty(), true), Scrolling::Scrollback);
    }

    #[test]
    fn shift_page_reaches_a_full_screen_program_only_while_held() {
        assert_eq!(page_goes(TermMode::ALT_SCREEN, true), Scrolling::Keys);
        assert_eq!(page_goes(TermMode::ALT_SCREEN, false), Scrolling::Nowhere);
        assert_eq!(page_goes(TermMode::empty(), true), Scrolling::Scrollback);
        assert_eq!(page_goes(TermMode::empty(), false), Scrolling::Scrollback);
    }

    #[test]
    fn a_press_ends_once_its_button_is_up_wherever_it_was_released() {
        let selecting = Pressed::Selecting;
        assert!(selecting.lasts(Some(MouseButton::Left)));
        assert!(!selecting.lasts(None));
        assert!(!selecting.lasts(Some(MouseButton::Right)));
        let reporting = Pressed::Reporting(input::MouseButton::Right);
        assert!(reporting.lasts(Some(MouseButton::Right)));
        assert!(!reporting.lasts(Some(MouseButton::Left)));
        assert!(!reporting.lasts(None));
        // The program gets the release of a press it got, and only of that.
        assert_eq!(reporting.reported(), Some(input::MouseButton::Right));
        assert_eq!(selecting.reported(), None);
    }

    #[test]
    fn the_ime_counts_its_composition_in_utf16_units() {
        // 中 is one unit, 😀 two.
        let composing = "中😀a";
        assert_eq!(utf16_len(composing), 4);
        assert_eq!(utf16_slice(composing, 0..1), ("中".into(), 0..1));
        assert_eq!(utf16_slice(composing, 1..3), ("😀".into(), 1..3));
        // Past the end is clamped to it.
        assert_eq!(utf16_slice(composing, 3..9), ("a".into(), 3..4));
        assert_eq!(utf16_slice(composing, 7..9), (String::new(), 4..4));
        // A backwards range is empty where it starts.
        let backwards = Range { start: 3, end: 1 };
        assert_eq!(utf16_slice(composing, backwards), (String::new(), 3..3));
    }

    #[test]
    fn a_reported_press_is_followed_by_its_own_button() {
        assert_eq!(platform_button(input::MouseButton::Left), MouseButton::Left);
        assert_eq!(
            platform_button(input::MouseButton::Middle),
            MouseButton::Middle
        );
        assert_eq!(
            platform_button(input::MouseButton::Right),
            MouseButton::Right
        );
    }
}
