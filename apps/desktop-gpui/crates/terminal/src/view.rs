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

//! The terminal view: the workbar's Terminal face. It shows one of the
//! selected task's terminals at a time, painting its picture with a custom
//! element the way Zed's terminal does ([`element`], [`grid`]), and turns
//! what the person does into what the PTY reads: keys, text and the IME,
//! pastes, the mouse and the wheel. It keeps the tabs' order (the order the
//! terminals opened in here, per task, by ref), the active terminal of each
//! task, and a find over the active terminal's grid and scrollback.
//!
//! Keys. GPUI matches action bindings up the whole key-context stack
//! before any key handler sees a key, so a key the app binds elsewhere
//! would never reach the program: such keys are bound again here, in
//! [`TERMINAL_CONTEXT`], as this view's actions ([`init`]). Tab and
//! Shift-Tab (the kit's focus keys) go to the program; ⌘C copies the
//! selection (the kit's copy key); ⌘F opens this terminal's find and ⌘G /
//! ⇧⌘G step through it. The view's own: ⌘A selects everything, ⌘V pastes,
//! ⌘↑ / ⌘↓ and Shift-PageUp / PageDown scroll by a page (Shift-PageUp /
//! PageDown go to a full-screen program, which has no scrollback),
//! ⌘Home / ⌘End to the top and the bottom. Everything else (arrows,
//! Escape, Enter, Control keys, letters) goes through [`crate::key_input`]
//! or the text input.
//!
//! The pointer: a click and a drag select (a double click the word, a
//! triple click the line, Shift-click extends), or go to a program that
//! asked for the mouse; with ⌘ held a link under the pointer underlines and
//! ⌘-click opens it ([`links`]). The scrollbar over the box shows and drags
//! the scrollback ([`scrollbar`]); the cursor blinks as its style asks
//! ([`blink`]).
//!
//! Keys that deliberately never reach the program: ⇧Esc (maximize the
//! workbar), ⌃⇧G (the changes), ⌃` (show or hide the terminal), the kit
//! inspector's ⌃⇧I, and the app's ⌘ shortcuts (⌘K, ⌘N, ⌘,, ⌘+ …). ⌘W is
//! unbound. ⌘K is not a clear: the model has no clear, and ⌘K is the
//! palette; the shell's `clear` and Ctrl-L clear.

mod blink;
mod box_drawing;
mod element;
mod find;
mod grid;
mod links;
mod scrollbar;

use std::cell::Cell;
use std::collections::HashMap;
use std::ops::Range;
use std::rc::Rc;
use std::sync::Arc;

use alacritty_terminal::grid::Scroll;
use alacritty_terminal::index::{Column, Line, Point, Side};
use alacritty_terminal::selection::SelectionType;
use alacritty_terminal::term::TermMode;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::scroll::Scrollbar;
use gpui_kit::component::{Disableable as _, Sizable as _, v_flex};
use gpui_kit::{
    App, Bounds, ClipboardItem, Context, Entity, EntityId, EntityInputHandler, EventEmitter,
    FocusHandle, Focusable, HoverListenerMode, InteractiveElement as _, IntoElement, KeyBinding,
    KeyDownEvent, Keystroke, ModifiersChangedEvent, MouseButton as PointerButton, MouseDownEvent,
    MouseMoveEvent, MouseUpEvent, ParentElement as _, Pixels, Render, Role, ScrollDelta,
    ScrollWheelEvent, SharedString, StatefulInteractiveElement as _, Styled as _, Subscription,
    TestSupportExt as _, UTF16Selection, Window, canvas, div, prelude::FluentBuilder as _,
};
use shared::copy::{self as shell_copy, Locale, terminal as copy};
use shared::rows::StatusLine;
use shared::theme::{ActiveMakaPalette as _, DISABLED_OPACITY, RADIUS_SURFACE};

use crate::input::{MouseAction, MouseButton};
use crate::{
    CloseState, Inventory, StartState, Terminal, TerminalContent, TerminalEvent, TerminalPhase,
    Terminals, TerminalsEvent,
};

#[cfg(test)]
pub(crate) use blink::{BLINK_INTERVAL, BLINK_PAUSE};
pub(crate) use element::GridGeometry;
use element::TerminalElement;

/// Key context of a focused terminal.
pub const TERMINAL_CONTEXT: &str = "Terminal";

gpui_kit::actions!(
    terminal,
    [
        /// Send Tab to the program (elsewhere Tab moves focus).
        SendTab,
        /// Send Shift-Tab to the program.
        SendShiftTab,
        /// Copy the terminal's selection, when it has one.
        Copy,
        /// Paste the clipboard's text into the program.
        Paste,
        /// Select the terminal's whole grid and scrollback.
        SelectAll,
        /// Scroll the scrollback up a page.
        ScrollPageUp,
        /// Scroll the scrollback down a page.
        ScrollPageDown,
        /// Scroll to the top of the scrollback.
        ScrollToTop,
        /// Scroll back to the bottom, where the program writes.
        ScrollToBottom,
        /// Show the find bar over the terminal.
        FindInTerminal,
    ]
);

/// Binds a focused terminal's keys. Call once at startup, before building
/// menus.
pub fn init(cx: &mut App) {
    let context = Some(TERMINAL_CONTEXT);
    cx.bind_keys([
        KeyBinding::new("tab", SendTab, context),
        KeyBinding::new("shift-tab", SendShiftTab, context),
        KeyBinding::new("shift-pageup", ScrollPageUp, context),
        KeyBinding::new("shift-pagedown", ScrollPageDown, context),
        #[cfg(target_os = "macos")]
        KeyBinding::new("cmd-c", Copy, context),
        #[cfg(target_os = "macos")]
        KeyBinding::new("cmd-v", Paste, context),
        #[cfg(target_os = "macos")]
        KeyBinding::new("cmd-a", SelectAll, context),
        #[cfg(target_os = "macos")]
        KeyBinding::new("cmd-up", ScrollPageUp, context),
        #[cfg(target_os = "macos")]
        KeyBinding::new("cmd-down", ScrollPageDown, context),
        #[cfg(target_os = "macos")]
        KeyBinding::new("cmd-home", ScrollToTop, context),
        #[cfg(target_os = "macos")]
        KeyBinding::new("cmd-end", ScrollToBottom, context),
        #[cfg(target_os = "macos")]
        KeyBinding::new("cmd-f", FindInTerminal, context),
        #[cfg(target_os = "macos")]
        KeyBinding::new("cmd-g", search::SelectNextMatch, context),
        #[cfg(target_os = "macos")]
        KeyBinding::new("cmd-shift-g", search::SelectPreviousMatch, context),
        // Elsewhere Control is the program's: the terminal's own commands
        // take Shift with it, and Ctrl-C reaches the program, not the
        // kit's copy.
        #[cfg(not(target_os = "macos"))]
        KeyBinding::new("ctrl-shift-c", Copy, context),
        #[cfg(not(target_os = "macos"))]
        KeyBinding::new("ctrl-shift-v", Paste, context),
        #[cfg(not(target_os = "macos"))]
        KeyBinding::new("ctrl-shift-a", SelectAll, context),
        #[cfg(not(target_os = "macos"))]
        KeyBinding::new("ctrl-shift-f", FindInTerminal, context),
        #[cfg(not(target_os = "macos"))]
        KeyBinding::new("ctrl-c", gpui_kit::NoAction, context),
    ]);
}

/// What a terminal's tab shows, for the workbar's strip.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct TerminalTab {
    /// The PTY's ref: the tab's stable id.
    pub resource_ref: SharedString,
    /// The program's title, or "Terminal", "Terminal 2" … when it set none.
    pub title: SharedString,
    /// The bell rang since the terminal was last typed in.
    pub bell: bool,
    pub exited: bool,
    pub close: CloseState,
}

/// Emitted by [`TerminalView`].
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum TerminalViewEvent {
    /// A terminal this window started is now the active one: the owner
    /// shows the face and focuses it.
    Started,
    /// The terminals, the active one or a tab's marks changed.
    TabsChanged,
}

/// What a press on the grid is doing until its button comes up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Pressed {
    /// Dragging out a selection.
    Selecting,
    /// Reporting to a program that asked for the mouse.
    Reporting(MouseButton),
}

/// The workbar's Terminal face for one window.
///
/// Behavior owner of the tabs' order and the active terminal of each task,
/// of input to the active terminal, of its selection, scrolling and find;
/// [`Terminals`] owns the terminals themselves. The face's presentation
/// (the strip's tabs) is the workbar's, from [`Self::tabs`].
pub struct TerminalView {
    terminals: Entity<Terminals>,
    focus: FocusHandle,
    /// Each task's terminals in the order they opened here, by ref.
    orders: HashMap<SharedString, Vec<SharedString>>,
    /// Each task's most recently active terminal.
    active: HashMap<SharedString, SharedString>,
    option_as_meta: bool,
    /// Whether the cursor blinks while the program has not chosen a style
    /// (a setting, on by default).
    cursor_blink: bool,
    /// Whether the grid has focus, and the window is the active one.
    focused: bool,
    window_active: bool,
    blink: blink::CursorBlink,
    links: links::LinkHover,
    scroll: scrollbar::TerminalScroll,
    /// The IME's composition, drawn at the cursor until it is committed.
    marked: Option<String>,
    /// Wheel movement not yet a whole line, in lines.
    scroll_remainder: f32,
    pressed: Option<Pressed>,
    /// A click started a selection on the active terminal, which Shift-click
    /// extends (an empty one is not in the picture).
    selection_started: bool,
    geometry: Rc<Cell<Option<GridGeometry>>>,
    find: find::Find,
    /// The active terminal's picture last seen, to tell when it changes.
    seen: Option<(EntityId, Arc<TerminalContent>)>,
    /// A terminal was asked for while the task's list was being read: one
    /// starts once it is read, if the task has none.
    start_when_listed: bool,
    /// The task whose terminals the face last showed.
    shown_session: Option<SharedString>,
    terminal_subscriptions: HashMap<EntityId, [Subscription; 2]>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<TerminalViewEvent> for TerminalView {}

impl std::fmt::Debug for TerminalView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TerminalView").field("active", &self.active).finish_non_exhaustive()
    }
}

impl Focusable for TerminalView {
    /// The grid's: it takes keys, text and the IME.
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl TerminalView {
    /// The face of the window whose terminals `terminals` owns.
    pub fn new(terminals: Entity<Terminals>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus = cx.focus_handle();
        let subscriptions = vec![
            cx.observe(&terminals, |this, _, cx| this.sync(cx)),
            cx.subscribe(&terminals, |this, _, event: &TerminalsEvent, cx| {
                let TerminalsEvent::Started(terminal) = event;
                this.sync(cx);
                let resource_ref = terminal.read(cx).resource_ref().clone();
                if let Some(session) = this.session(cx) {
                    this.active.insert(session, resource_ref);
                }
                cx.emit(TerminalViewEvent::Started);
                cx.emit(TerminalViewEvent::TabsChanged);
                cx.notify();
            }),
            cx.on_focus(&focus, window, |this, _, cx| this.report_focus(true, cx)),
            cx.on_blur(&focus, window, |this, _, cx| this.report_focus(false, cx)),
            cx.observe_window_activation(window, |this, window, cx| {
                this.window_active = window.is_window_active();
                this.sync_blink(cx);
            }),
        ];
        let mut this = Self {
            terminals,
            focus,
            orders: HashMap::new(),
            active: HashMap::new(),
            option_as_meta: false,
            cursor_blink: true,
            focused: false,
            window_active: window.is_window_active(),
            blink: blink::CursorBlink::default(),
            links: links::LinkHover::default(),
            scroll: scrollbar::TerminalScroll::default(),
            marked: None,
            scroll_remainder: 0.,
            pressed: None,
            selection_started: false,
            geometry: Rc::new(Cell::new(None)),
            find: find::Find::default(),
            seen: None,
            start_when_listed: false,
            shown_session: None,
            terminal_subscriptions: HashMap::new(),
            _subscriptions: subscriptions,
        };
        this.sync(cx);
        this
    }

    pub fn terminals(&self) -> &Entity<Terminals> {
        &self.terminals
    }

    /// Whether Option sends Meta (Escape and the key) rather than compose
    /// text: a preference, off by default as on macOS.
    pub fn set_option_as_meta(&mut self, option_as_meta: bool) {
        self.option_as_meta = option_as_meta;
    }

    /// Whether the cursor blinks where the program has not chosen a style
    /// (DECSCUSR): a preference, on by default. A program's choice, blinking
    /// or steady, overrides it; reduced motion stops every blink.
    pub fn set_cursor_blink(&mut self, blinking: bool, cx: &mut Context<Self>) {
        if self.cursor_blink == blinking {
            return;
        }
        self.cursor_blink = blinking;
        for terminal in self.terminals.read(cx).terminals().to_vec() {
            terminal.update(cx, |terminal, _| terminal.set_cursor_blink_default(blinking));
        }
    }

    /// Whether the cursor shows in this phase of its blink, and whether it
    /// blinks.
    #[cfg(test)]
    pub(crate) fn cursor_blink_state(&self) -> (bool, bool) {
        (self.blink.is_visible(), self.blink.is_blinking())
    }

    /// The link underlined under the pointer.
    #[cfg(test)]
    pub(crate) fn underlined_link(&self, cx: &App) -> Option<crate::TerminalLink> {
        self.shown_link(cx).cloned()
    }

    /// The scrollbar's handle.
    #[cfg(test)]
    pub(crate) fn scroll_handle(&self) -> &scrollbar::TerminalScroll {
        &self.scroll
    }

    /// Where the grid was last painted.
    #[cfg(test)]
    pub(crate) fn geometry(&self) -> Option<GridGeometry> {
        self.geometry.get()
    }

    /// How many matches the grid paints.
    #[cfg(test)]
    pub(crate) fn painted_matches(&self) -> usize {
        self.find.painted().len()
    }

    /// Whether the IME is composing.
    #[cfg(test)]
    pub(crate) fn is_composing(&self) -> bool {
        self.marked.is_some()
    }

    fn session(&self, cx: &App) -> Option<SharedString> {
        self.terminals.read(cx).session_id().cloned()
    }

    /// The selected task's terminals in the tabs' order.
    fn ordered(&self, cx: &App) -> Vec<Entity<Terminal>> {
        let terminals = self.terminals.read(cx);
        let Some(order) = terminals.session_id().and_then(|session| self.orders.get(session))
        else {
            return Vec::new();
        };
        order
            .iter()
            .filter_map(|resource_ref| {
                terminals
                    .terminals()
                    .iter()
                    .find(|terminal| terminal.read(cx).resource_ref() == resource_ref)
                    .cloned()
            })
            .collect()
    }

    /// The selected task's terminals as the strip shows them, in the order
    /// they opened here: an inventory read never reorders them.
    pub fn tabs(&self, cx: &App) -> Vec<TerminalTab> {
        let locale = Locale::current(cx);
        self.ordered(cx)
            .iter()
            .enumerate()
            .map(|(ix, terminal)| {
                let terminal = terminal.read(cx);
                TerminalTab {
                    resource_ref: terminal.resource_ref().clone(),
                    title: terminal
                        .title()
                        .filter(|title| !title.trim().is_empty())
                        .cloned()
                        .unwrap_or_else(|| copy::untitled(locale, ix + 1).into()),
                    bell: terminal.bell(),
                    exited: terminal.is_exited(),
                    close: terminal.close_state().clone(),
                }
            })
            .collect()
    }

    /// Whether the selected task has terminals.
    pub fn has_terminals(&self, cx: &App) -> bool {
        !self.terminals.read(cx).terminals().is_empty()
    }

    /// The selected task's active terminal: the one last made active, or
    /// the first.
    pub fn active_terminal(&self, cx: &App) -> Option<Entity<Terminal>> {
        let ordered = self.ordered(cx);
        let session = self.session(cx)?;
        let active = self.active.get(&session);
        active
            .and_then(|resource_ref| {
                ordered.iter().find(|terminal| terminal.read(cx).resource_ref() == resource_ref)
            })
            .or(ordered.first())
            .cloned()
    }

    /// The active terminal's ref.
    pub fn active_ref(&self, cx: &App) -> Option<SharedString> {
        self.active_terminal(cx).map(|terminal| terminal.read(cx).resource_ref().clone())
    }

    /// Makes the terminal `resource_ref` the active one.
    pub fn activate(&mut self, resource_ref: &SharedString, cx: &mut Context<Self>) {
        let Some(session) = self.session(cx) else { return };
        if self.active.get(&session) == Some(resource_ref) {
            return;
        }
        self.active.insert(session, resource_ref.clone());
        self.active_changed(cx);
        cx.emit(TerminalViewEvent::TabsChanged);
        cx.notify();
    }

    /// Focuses the active terminal's grid.
    pub fn focus(&self, window: &mut Window, cx: &mut App) {
        self.focus.focus(window, cx);
    }

    /// Whether the terminal, or its find bar, has focus.
    pub fn is_focused(&self, window: &Window, cx: &App) -> bool {
        self.focus.is_focused(window)
            || self
                .find
                .bar()
                .is_some_and(|bar| bar.read(cx).focus_handle(cx).contains_focused(window, cx))
    }

    /// Whether the face has something of its own to show with no terminal:
    /// the list not read yet (no connection to read it on), being read or
    /// failing, a start under way or refused. Until the list is read, the
    /// task's terminals are unknown, not absent.
    pub fn has_pending_state(&self, cx: &App) -> bool {
        let terminals = self.terminals.read(cx);
        let unread = match terminals.inventory() {
            Inventory::Idle => terminals.session_id().is_some(),
            Inventory::Loading | Inventory::Failed(_) => true,
            _ => false,
        };
        unread || *terminals.start_state() != StartState::Idle || self.start_when_listed
    }

    /// Starts a terminal in the selected task; it becomes the active one
    /// when it starts.
    pub fn new_terminal(&mut self, cx: &mut Context<Self>) {
        self.terminals.update(cx, |terminals, cx| terminals.start(cx));
        cx.notify();
    }

    /// Ctrl+`: a terminal to show. With none in the task one starts (once
    /// the task's list is read, so a terminal it lists is not doubled).
    pub fn ensure_terminal(&mut self, cx: &mut Context<Self>) {
        if self.has_terminals(cx) {
            return;
        }
        match self.terminals.read(cx).inventory() {
            Inventory::Loading => {
                self.start_when_listed = true;
                cx.notify();
            }
            _ => self.new_terminal(cx),
        }
    }

    /// Closes the terminal `resource_ref`: stops its shell, without asking
    /// (the model cannot see what runs in it). Its tab goes when the Host
    /// confirms; a failed stop can be closed again.
    pub fn close(&mut self, resource_ref: &SharedString, cx: &mut Context<Self>) {
        let Some(terminal) = self
            .ordered(cx)
            .into_iter()
            .find(|terminal| terminal.read(cx).resource_ref() == resource_ref)
        else {
            return;
        };
        self.terminals.update(cx, |terminals, cx| terminals.close(&terminal, cx));
        cx.notify();
    }

    /// Restart on an exited terminal: it goes, and a new one starts in its
    /// place, appended to the tabs.
    pub fn restart(&mut self, resource_ref: &SharedString, cx: &mut Context<Self>) {
        if *self.terminals.read(cx).start_state() == StartState::Starting {
            return;
        }
        self.close(resource_ref, cx);
        self.new_terminal(cx);
    }

    // Following the terminals.

    /// Follows the owner: the selected task's terminals join the order
    /// (new ones at the end), closed ones leave it, and each is watched.
    fn sync(&mut self, cx: &mut Context<Self>) {
        let (session, present, inventory) = {
            let terminals = self.terminals.read(cx);
            let present: Vec<(SharedString, Entity<Terminal>)> = terminals
                .terminals()
                .iter()
                .map(|terminal| (terminal.read(cx).resource_ref().clone(), terminal.clone()))
                .collect();
            (terminals.session_id().cloned(), present, terminals.inventory().clone())
        };
        let Some(session) = session else {
            self.terminal_subscriptions.clear();
            if self.shown_session.take().is_some() {
                self.active_changed(cx);
            }
            cx.notify();
            return;
        };
        let order = self.orders.entry(session.clone()).or_default();
        let before = order.clone();
        // While the list is read again (returning to the task) the
        // terminals come back one list later: their places are kept.
        if inventory != Inventory::Loading {
            order.retain(|resource_ref| present.iter().any(|(listed, _)| listed == resource_ref));
        }
        for (resource_ref, _) in &present {
            if !order.contains(resource_ref) {
                order.push(resource_ref.clone());
            }
        }
        let order = order.clone();
        // The active terminal closed: its neighbour before it takes over.
        if let Some(active) = self.active.get(&session).cloned()
            && !order.contains(&active)
            && before.contains(&active)
        {
            let ix = before.iter().position(|resource_ref| *resource_ref == active).unwrap_or(0);
            let neighbour = before[..ix]
                .iter()
                .rev()
                .chain(before[ix..].iter())
                .find(|resource_ref| order.contains(resource_ref))
                .cloned();
            match neighbour {
                Some(neighbour) => self.active.insert(session.clone(), neighbour),
                None => self.active.remove(&session),
            };
        }
        let blinking = self.cursor_blink;
        for (_, terminal) in &present {
            terminal.update(cx, |terminal, _| terminal.set_cursor_blink_default(blinking));
        }
        let live: Vec<EntityId> =
            present.iter().map(|(_, terminal)| terminal.entity_id()).collect();
        self.terminal_subscriptions.retain(|id, _| live.contains(id));
        for (_, terminal) in &present {
            if self.terminal_subscriptions.contains_key(&terminal.entity_id()) {
                continue;
            }
            let subscriptions = [
                cx.observe(terminal, |this, terminal, cx| this.terminal_changed(&terminal, cx)),
                cx.subscribe(terminal, |_, _, event: &TerminalEvent, cx| {
                    // OSC 52: a program may put text on the clipboard, never
                    // read it.
                    if let TerminalEvent::ClipboardStore(text) = event {
                        cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
                    }
                }),
            ];
            self.terminal_subscriptions.insert(terminal.entity_id(), subscriptions);
        }
        if self.start_when_listed && inventory != Inventory::Loading {
            self.start_when_listed = false;
            if present.is_empty() {
                self.new_terminal(cx);
            }
        }
        let session_changed = self.shown_session.as_ref() != Some(&session);
        if session_changed {
            self.shown_session = Some(session);
            self.start_when_listed = false;
        }
        if before != order || session_changed {
            self.active_changed(cx);
        }
        self.sync_blink(cx);
        cx.emit(TerminalViewEvent::TabsChanged);
        cx.notify();
    }

    /// A terminal changed: its marks, phase or picture. A new picture of
    /// the active one invalidates find's matches.
    fn terminal_changed(&mut self, terminal: &Entity<Terminal>, cx: &mut Context<Self>) {
        if self.active_terminal(cx).as_ref() == Some(terminal) {
            let content = terminal.read(cx).content().clone();
            let changed = match &self.seen {
                Some((id, seen)) => *id != terminal.entity_id() || !Arc::ptr_eq(seen, &content),
                None => true,
            };
            if changed {
                self.seen = Some((terminal.entity_id(), content));
                cx.emit(search::SearchEvent::MatchesInvalidated);
                self.links_invalidated(cx);
                // Its cursor style may have changed; output holds the blink.
                self.sync_blink(cx);
                self.hold_blink(cx);
            }
        } else {
            self.sync_blink(cx);
        }
        cx.emit(TerminalViewEvent::TabsChanged);
        cx.notify();
    }

    /// Another terminal is active: find searches it instead, and with none
    /// left the bar goes.
    fn active_changed(&mut self, cx: &mut Context<Self>) {
        self.marked = None;
        self.pressed = None;
        self.selection_started = false;
        self.find.clear_matches();
        self.seen = None;
        self.links_invalidated(cx);
        if self.active_terminal(cx).is_none() {
            self.end_find(cx);
        }
        self.sync_blink(cx);
        cx.emit(search::SearchEvent::MatchesInvalidated);
    }

    fn report_focus(&mut self, focused: bool, cx: &mut Context<Self>) {
        self.focused = focused;
        if let Some(terminal) = self.active_terminal(cx) {
            terminal.update(cx, |terminal, cx| terminal.focus_changed(focused, cx));
        }
        self.sync_blink(cx);
        cx.notify();
    }

    // Input.

    /// Something was typed into `terminal`: its bell mark clears and the
    /// view returns to the bottom, where the program writes.
    fn typed(&mut self, terminal: &Entity<Terminal>, cx: &mut Context<Self>) {
        terminal.update(cx, |terminal, cx| {
            terminal.clear_bell(cx);
            if terminal.content().display_offset > 0 {
                terminal.scroll_display(Scroll::Bottom);
            }
        });
        self.hold_blink(cx);
    }

    /// Sends `text` to the active terminal as typed.
    fn send_text(&mut self, text: &str, cx: &mut Context<Self>) {
        let Some(terminal) = self.active_terminal(cx) else { return };
        self.typed(&terminal, cx);
        terminal.update(cx, |terminal, cx| terminal.input(text, cx));
    }

    /// Sends what `keystroke` types, when it types anything of its own.
    fn send_key(&mut self, keystroke: &Keystroke, cx: &mut Context<Self>) -> bool {
        let Some(terminal) = self.active_terminal(cx) else { return false };
        let option_as_meta = self.option_as_meta;
        let sent = terminal.update(cx, |terminal, cx| terminal.key(keystroke, option_as_meta, cx));
        if sent {
            self.typed(&terminal, cx);
        }
        sent
    }

    fn key_down(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        // While the IME composes, the keys are its.
        if self.marked.is_some() {
            return;
        }
        if self.send_key(&event.keystroke, cx) {
            cx.stop_propagation();
        }
    }

    fn send_tab(&mut self, _: &SendTab, _: &mut Window, cx: &mut Context<Self>) {
        self.send_key(&Keystroke::parse("tab").expect("tab"), cx);
    }

    fn send_shift_tab(&mut self, _: &SendShiftTab, _: &mut Window, cx: &mut Context<Self>) {
        self.send_key(&Keystroke::parse("shift-tab").expect("shift-tab"), cx);
    }

    /// ⌘C: copies the selection; without one it does nothing.
    fn copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        let Some(terminal) = self.active_terminal(cx) else { return };
        let text = terminal.update(cx, |terminal, cx| terminal.selection_text(cx));
        cx.spawn(async move |_, cx| {
            if let Some(text) = text.await {
                cx.update(|cx| cx.write_to_clipboard(ClipboardItem::new_string(text)));
            }
        })
        .detach();
    }

    /// ⌘V: the clipboard's text, bracketed when the program asked for it.
    fn paste(&mut self, _: &Paste, _: &mut Window, cx: &mut Context<Self>) {
        let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) else { return };
        let Some(terminal) = self.active_terminal(cx) else { return };
        self.typed(&terminal, cx);
        terminal.update(cx, |terminal, cx| terminal.paste(&text, cx));
    }

    /// ⌘A: the whole grid and its scrollback.
    fn select_all(&mut self, _: &SelectAll, _: &mut Window, cx: &mut Context<Self>) {
        let Some(terminal) = self.active_terminal(cx) else { return };
        terminal.update(cx, |terminal, cx| {
            let content = terminal.content().clone();
            let history = i32::try_from(content.history_size).unwrap_or(i32::MAX);
            let last_row = i32::from(content.size.rows) - 1;
            let last_column = usize::from(content.size.cols).saturating_sub(1);
            terminal.start_selection(
                SelectionType::Simple,
                Point::new(Line(-history), Column(0)),
                Side::Left,
            );
            terminal.update_selection(Point::new(Line(last_row), Column(last_column)), Side::Right);
            cx.notify();
        });
    }

    /// Scrolls by a page, or, on a full-screen program's screen (which has
    /// no scrollback), sends it the key.
    fn scroll_page(&mut self, up: bool, cx: &mut Context<Self>) {
        let Some(terminal) = self.active_terminal(cx) else { return };
        if terminal.read(cx).mode().contains(TermMode::ALT_SCREEN) {
            let key = if up { "shift-pageup" } else { "shift-pagedown" };
            self.send_key(&Keystroke::parse(key).expect("key"), cx);
            return;
        }
        let scroll = if up { Scroll::PageUp } else { Scroll::PageDown };
        terminal.update(cx, |terminal, _| terminal.scroll_display(scroll));
    }

    fn scroll_to(&mut self, scroll: Scroll, cx: &mut Context<Self>) {
        if let Some(terminal) = self.active_terminal(cx) {
            terminal.update(cx, |terminal, _| terminal.scroll_display(scroll));
        }
    }

    // The pointer.

    fn cell_at(&self, position: gpui_kit::Point<Pixels>) -> Option<(usize, usize, bool)> {
        let geometry = self.geometry.get()?;
        (geometry.columns > 0 && geometry.rows > 0).then(|| geometry.cell_at(position))
    }

    /// The grid point of the cell at `column`, `row` of the screen.
    fn grid_point(&self, column: usize, row: usize, cx: &App) -> Option<Point> {
        let terminal = self.active_terminal(cx)?;
        let offset = i32::try_from(terminal.read(cx).content().display_offset).unwrap_or(0);
        Some(Point::new(Line(i32::try_from(row).unwrap_or(0) - offset), Column(column)))
    }

    fn reports_mouse(&self, cx: &App) -> bool {
        self.active_terminal(cx)
            .is_some_and(|terminal| terminal.read(cx).mode().intersects(TermMode::MOUSE_MODE))
    }

    fn mouse_down(&mut self, event: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        self.focus.focus(window, cx);
        let Some(terminal) = self.active_terminal(cx) else { return };
        let Some((column, row, right)) = self.cell_at(event.position) else { return };
        // ⌘-click (Control-click elsewhere) is for links: never a mouse
        // report, never a selection.
        if event.modifiers.secondary() {
            if event.button == PointerButton::Left
                && let Some(point) = self.grid_point(column, row, cx)
            {
                self.open_link_at(point, cx);
            }
            return;
        }
        let button = match event.button {
            PointerButton::Left => MouseButton::Left,
            PointerButton::Middle => MouseButton::Middle,
            PointerButton::Right => MouseButton::Right,
            _ => return,
        };
        // Shift selects even when the program asked for the mouse.
        if self.reports_mouse(cx) && !event.modifiers.shift {
            let modifiers = event.modifiers;
            terminal.update(cx, |terminal, cx| {
                terminal.mouse(MouseAction::Press(button), column, row, &modifiers, cx)
            });
            self.pressed = Some(Pressed::Reporting(button));
            return;
        }
        if button != MouseButton::Left {
            return;
        }
        let Some(point) = self.grid_point(column, row, cx) else { return };
        let side = if right { Side::Right } else { Side::Left };
        let extend = self.selection_started || terminal.read(cx).content().selection.is_some();
        self.selection_started = true;
        terminal.update(cx, |terminal, cx| {
            match event.click_count {
                1 if event.modifiers.shift && extend => {
                    terminal.update_selection(point, side);
                }
                1 => terminal.start_selection(SelectionType::Simple, point, side),
                2 => terminal.start_selection(SelectionType::Semantic, point, side),
                _ => terminal.start_selection(SelectionType::Lines, point, side),
            }
            cx.notify();
        });
        self.pressed = Some(Pressed::Selecting);
    }

    fn mouse_move(&mut self, event: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        self.link_pointer_moved(event.position, &event.modifiers, cx);
        let Some(terminal) = self.active_terminal(cx) else { return };
        let Some((column, row, right)) = self.cell_at(event.position) else { return };
        match self.pressed {
            Some(Pressed::Selecting) if event.pressed_button == Some(PointerButton::Left) => {
                let Some(point) = self.grid_point(column, row, cx) else { return };
                let side = if right { Side::Right } else { Side::Left };
                terminal.update(cx, |terminal, cx| {
                    terminal.update_selection(point, side);
                    cx.notify();
                });
            }
            Some(Pressed::Reporting(button)) => {
                let modifiers = event.modifiers;
                terminal.update(cx, |terminal, cx| {
                    terminal.mouse(MouseAction::Move(Some(button)), column, row, &modifiers, cx)
                });
            }
            None if self.reports_mouse(cx) && !event.modifiers.secondary() => {
                let modifiers = event.modifiers;
                terminal.update(cx, |terminal, cx| {
                    terminal.mouse(MouseAction::Move(None), column, row, &modifiers, cx)
                });
            }
            _ => {}
        }
    }

    fn mouse_up(&mut self, event: &MouseUpEvent, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(Pressed::Reporting(button)) = self.pressed.take()
            && let Some(terminal) = self.active_terminal(cx)
            && let Some((column, row, _)) = self.cell_at(event.position)
        {
            let modifiers = event.modifiers;
            terminal.update(cx, |terminal, cx| {
                terminal.mouse(MouseAction::Release(button), column, row, &modifiers, cx)
            });
        }
    }

    /// The wheel and the trackpad: pixel deltas add up into lines; whole
    /// lines scroll the scrollback, or go to the program as mouse reports
    /// or (on a full-screen program with alternate scroll) arrow keys.
    fn scroll_wheel(&mut self, event: &ScrollWheelEvent, _: &mut Window, cx: &mut Context<Self>) {
        let Some(terminal) = self.active_terminal(cx) else { return };
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
        if self.reports_mouse(cx) {
            let Some((column, row, _)) = self.cell_at(event.position) else { return };
            let action = if lines > 0 { MouseAction::WheelUp } else { MouseAction::WheelDown };
            let modifiers = event.modifiers;
            terminal.update(cx, |terminal, cx| {
                for _ in 0..lines.unsigned_abs() {
                    terminal.mouse(action, column, row, &modifiers, cx);
                }
            });
            return;
        }
        terminal.update(cx, |terminal, cx| terminal.scroll_wheel(lines, cx));
    }

    // Rendering.

    /// The lines over the face that say where the task's terminals and the
    /// active one stand, each with its way forward.
    fn render_notices(
        &self,
        terminal: Option<&Entity<Terminal>>,
        cx: &mut Context<Self>,
    ) -> Vec<gpui_kit::AnyElement> {
        let locale = Locale::current(cx);
        let (inventory, start) = {
            let terminals = self.terminals.read(cx);
            (terminals.inventory().clone(), terminals.start_state().clone())
        };
        let mut lines = Vec::new();
        let session = self.terminals.read(cx).session_id().is_some();
        match &inventory {
            // Being read, or not read yet (no connection to read it on).
            Inventory::Loading | Inventory::Idle if terminal.is_none() && session => {
                lines.push(
                    StatusLine::info("terminal-loading", copy::LOADING.get(cx)).into_any_element(),
                );
            }
            Inventory::Failed(message) => {
                let text = shell_copy::failure(locale, copy::LOAD_FAILED.get(cx), message);
                lines.push(
                    StatusLine::error("terminal-load-failed", text)
                        .centred()
                        .action(quiet_button("terminal-reload", copy::RETRY.get(cx)).on_click(
                            cx.listener(|this, _, _, cx| {
                                this.terminals.update(cx, |terminals, cx| terminals.reload(cx));
                            }),
                        ))
                        .into_any_element(),
                );
            }
            _ => {}
        }
        let dismiss = |cx: &mut Context<Self>| {
            quiet_button("terminal-dismiss-start", copy::DISMISS.get(cx)).on_click(cx.listener(
                |this, _, _, cx| {
                    this.terminals.update(cx, |terminals, cx| terminals.dismiss_start(cx));
                },
            ))
        };
        match &start {
            StartState::Starting if terminal.is_none() => {
                lines.push(
                    StatusLine::info("terminal-starting", copy::STARTING.get(cx))
                        .into_any_element(),
                );
            }
            StartState::LimitReached => lines.push(
                StatusLine::info("terminal-limit", copy::LIMIT_REACHED.get(cx))
                    .centred()
                    .action(dismiss(cx))
                    .into_any_element(),
            ),
            StartState::HostRestarting => lines.push(
                StatusLine::info("terminal-host-restarting", copy::HOST_RESTARTING.get(cx))
                    .centred()
                    .action(dismiss(cx))
                    .into_any_element(),
            ),
            StartState::Failed(message) => {
                let text = shell_copy::failure(locale, copy::START_FAILED.get(cx), message);
                lines.push(
                    StatusLine::error("terminal-start-failed", text)
                        .centred()
                        .action(dismiss(cx))
                        .into_any_element(),
                );
            }
            _ => {}
        }
        let starting = start == StartState::Starting;
        if terminal.is_none()
            && inventory == Inventory::Loaded
            && start == StartState::Idle
            && !self.start_when_listed
        {
            lines.push(
                StatusLine::info("terminal-empty", copy::EMPTY.get(cx))
                    .centred()
                    .action(
                        quiet_button("terminal-new", copy::NEW_TERMINAL.get(cx))
                            .on_click(cx.listener(|this, _, _, cx| this.new_terminal(cx))),
                    )
                    .into_any_element(),
            );
        }
        let Some(terminal) = terminal else { return lines };
        let resource_ref = terminal.read(cx).resource_ref().clone();
        match terminal.read(cx).phase().clone() {
            TerminalPhase::Attaching => {
                lines.push(
                    StatusLine::info("terminal-attaching", copy::ATTACHING.get(cx))
                        .into_any_element(),
                );
            }
            TerminalPhase::HeldElsewhere => lines.push(
                StatusLine::info("terminal-held-elsewhere", copy::HELD_ELSEWHERE.get(cx))
                    .centred()
                    .action(retry_button(terminal, cx))
                    .into_any_element(),
            ),
            TerminalPhase::Failed(message) => {
                let text = shell_copy::failure(locale, copy::ATTACH_FAILED.get(cx), &message);
                lines.push(
                    StatusLine::error("terminal-attach-failed", text)
                        .centred()
                        .action(retry_button(terminal, cx))
                        .into_any_element(),
                );
            }
            TerminalPhase::Exited { exit_code, failure_message } => {
                let mut text = copy::exited_line(locale, exit_code);
                if let Some(message) = failure_message {
                    text = shell_copy::failure(locale, &text, &message);
                }
                lines.push(
                    StatusLine::info("terminal-exited", text)
                        .centred()
                        .action(
                            quiet_button("terminal-restart", copy::RESTART.get(cx))
                                .loading(starting)
                                .disabled(starting)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.restart(&resource_ref, cx);
                                })),
                        )
                        .into_any_element(),
                );
            }
            _ => {}
        }
        lines
    }

    /// Whether the scrollbar shows: over a terminal's scrollback, not over
    /// a full-screen program's screen, which has none.
    pub(crate) fn has_scrollbar(&self, cx: &App) -> bool {
        self.active_terminal(cx)
            .is_some_and(|terminal| !terminal.read(cx).mode().contains(TermMode::ALT_SCREEN))
    }

    fn render_grid(
        &self,
        terminal: Option<&Entity<Terminal>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui_kit::AnyElement {
        let palette = cx.terminal_palette();
        let focused = self.focus.is_focused(window);
        let exited = terminal.is_some_and(|terminal| terminal.read(cx).is_exited());
        let grid = div()
            .id("terminal-grid")
            .test_support()
            .key_context(TERMINAL_CONTEXT)
            .track_focus(&self.focus)
            .role(Role::Terminal)
            .aria_label(copy::REGION.get(cx))
            .size_full()
            .when(exited, |this| this.opacity(DISABLED_OPACITY))
            .on_key_down(cx.listener(Self::key_down))
            .on_action(cx.listener(Self::send_tab))
            .on_action(cx.listener(Self::send_shift_tab))
            .on_action(cx.listener(Self::copy))
            .on_action(cx.listener(Self::paste))
            .on_action(cx.listener(Self::select_all))
            .on_action(cx.listener(|this, _: &ScrollPageUp, _, cx| this.scroll_page(true, cx)))
            .on_action(cx.listener(|this, _: &ScrollPageDown, _, cx| this.scroll_page(false, cx)))
            .on_action(cx.listener(|this, _: &ScrollToTop, _, cx| this.scroll_to(Scroll::Top, cx)))
            .on_action(
                cx.listener(|this, _: &ScrollToBottom, _, cx| this.scroll_to(Scroll::Bottom, cx)),
            )
            .on_action(
                cx.listener(|this, _: &FindInTerminal, window, cx| this.open_find(window, cx)),
            )
            .on_action(cx.listener(Self::select_next_match))
            .on_action(cx.listener(Self::select_previous_match))
            .on_mouse_down(PointerButton::Left, cx.listener(Self::mouse_down))
            .on_mouse_down(PointerButton::Middle, cx.listener(Self::mouse_down))
            .on_mouse_down(PointerButton::Right, cx.listener(Self::mouse_down))
            .on_mouse_move(cx.listener(Self::mouse_move))
            .on_mouse_up(PointerButton::Left, cx.listener(Self::mouse_up))
            .on_mouse_up(PointerButton::Middle, cx.listener(Self::mouse_up))
            .on_mouse_up(PointerButton::Right, cx.listener(Self::mouse_up))
            .on_scroll_wheel(cx.listener(Self::scroll_wheel))
            .on_modifiers_changed(cx.listener(|this, event: &ModifiersChangedEvent, _, cx| {
                this.link_modifiers_changed(&event.modifiers, cx);
            }))
            // Typing must not count as the pointer leaving: ⌘ pressed after
            // it still finds the link under the pointer.
            .hover_listener_mode(HoverListenerMode::InputModalityIndependent)
            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                if !*hovered {
                    this.link_pointer_left(cx);
                }
            }))
            .children(terminal.map(|terminal| {
                let content = terminal.read(cx).content().clone();
                TerminalElement::new(
                    cx.entity(),
                    terminal.clone(),
                    self.focus.clone(),
                    content,
                    focused,
                    !exited,
                    self.find.painted(),
                    self.find.active_ix(),
                    self.marked.clone().map(Into::into),
                    self.geometry.clone(),
                )
                .link(self.shown_link(cx).map(|link| (link.start, link.end)))
                .cursor_blinked_off(!self.blink.is_visible())
                .scroll(self.scroll.clone())
            }));
        if terminal.is_none() {
            return div().flex_1().min_h_0().w_full().child(grid).into_any_element();
        }
        let scrollback = self.has_scrollbar(cx);
        let scroll = self.scroll.clone();
        // F31's diff box: the code fill, its radius, 8 px in at the sides
        // and the radius in above and below.
        div()
            .flex_1()
            .min_h_0()
            .w_full()
            .p_2()
            .child(
                div()
                    .id("terminal-box")
                    .test_support()
                    .relative()
                    .size_full()
                    .rounded(RADIUS_SURFACE)
                    .bg(palette.background)
                    .px_2()
                    .py(RADIUS_SURFACE)
                    .child(grid)
                    .when(scrollback, |this| {
                        this.child(
                            canvas(
                                move |bounds, _, _| scroll.set_viewport(bounds),
                                |_, _, _, _| {},
                            )
                            .absolute()
                            .inset_0(),
                        )
                        .child(Scrollbar::vertical(&self.scroll).id("terminal-scrollbar"))
                    })
                    // Over the scrollbar, whose strip its right edge covers.
                    .children(self.render_find_bar()),
            )
            .into_any_element()
    }
}

fn quiet_button(id: &'static str, label: &'static str) -> Button {
    Button::new(id).ghost().small().label(label)
}

fn retry_button(terminal: &Entity<Terminal>, cx: &mut Context<TerminalView>) -> Button {
    let terminal = terminal.downgrade();
    quiet_button("terminal-retry", copy::RETRY.get(cx)).on_click(move |_, _, cx| {
        terminal.update(cx, |terminal, cx| terminal.retry(cx)).ok();
    })
}

impl Render for TerminalView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let terminal = self.active_terminal(cx);
        let notices = self.render_notices(terminal.as_ref(), cx);
        let has_notices = !notices.is_empty();
        v_flex()
            .id("terminal-face")
            .test_support()
            .role(Role::Region)
            .aria_label(copy::REGION.get(cx))
            .size_full()
            .min_w_0()
            .min_h_0()
            .text_color(cx.maka().ink)
            .when(has_notices, |this| {
                this.child(v_flex().flex_none().px_4().py_3().gap_2().children(notices))
            })
            .child(self.render_grid(terminal.as_ref(), window, cx))
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
        let marked = self.marked.as_ref()?;
        let utf16: Vec<u16> = marked.encode_utf16().collect();
        let range = range.start.min(utf16.len())..range.end.min(utf16.len());
        *adjusted_range = Some(range.clone());
        Some(String::from_utf16_lossy(&utf16[range]))
    }

    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        let end = self.marked.as_ref().map_or(0, |marked| marked.encode_utf16().count());
        Some(UTF16Selection { range: end..end, reversed: false })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked.as_ref().map(|marked| 0..marked.encode_utf16().count())
    }

    fn unmark_text(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        if self.marked.take().is_some() {
            cx.notify();
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
        self.send_text(text, cx);
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
        Some(geometry.and_then(|geometry| geometry.cursor).unwrap_or(Bounds::new(
            element_bounds.origin,
            geometry.map_or(element_bounds.size, |geometry| geometry.cell),
        )))
    }

    fn character_index_for_point(
        &mut self,
        _: gpui_kit::Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        None
    }
}
