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

//! A task's terminals: PTYs the Runtime Host owns, driven through its
//! runtime resources, the emulator their output is parsed into, and the
//! view that paints them and takes what the person types.
//!
//! The Host runs each shell (`runtime.resource.start`) and keeps it; this
//! client never spawns one. A window attaches to a terminal by naming its
//! ref in the Session subscription's PTY interest and taking its one
//! controller seat, whose acquire answers the screen so far; output then
//! streams as subscription frames and keystrokes go back as numbered
//! controls. The emulator is `alacritty_terminal`'s `Term` and vte parser,
//! without its PTY or event loop, running off the main thread.
//!
//! - [`Terminals`] is the window's owner: the selected task's terminals,
//!   their PTY interest and controllers as far as they show
//!   ([`TerminalsShown`]), starting and closing, the Host's limit of live
//!   PTYs, reconnects. Build one per window beside its
//!   [`workspace::HostSession`] and [`conversation::ConversationState`].
//! - [`Terminal`] is one terminal: its lifecycle ([`TerminalPhase`]), its
//!   controls, its picture ([`TerminalContent`]), title, bell and
//!   clipboard writes ([`TerminalEvent`]), and a find over its grid and
//!   scrollback ([`Terminal::find`]).
//! - [`key_input`], [`mouse_input`], [`paste_input`], [`focus_input`] and
//!   [`alternate_scroll_input`] turn what the person does into what the
//!   PTY reads.
//! - [`TerminalView`] is the workbar's Terminal face: the active terminal
//!   painted by a custom element (themed text raised to a minimum
//!   contrast, a blinking cursor), its tabs' order, input, selection,
//!   scrolling and its scrollbar, ⌘-click on web links ([`TerminalLink`])
//!   and find. Its keys bind in [`TERMINAL_CONTEXT`] ([`init`]).
//!
//! Zed's terminal (GPL-3.0) informed the practices here, not the code:
//! output parsed off the main thread and shown in batches, resizes sent
//! only when the grid changes, a key table written from xterm's
//! documentation, and the grid painted as merged runs at a forced cell
//! width over merged, snapped backgrounds.

mod controls;
mod emulator;
mod hydration;
mod input;
mod link;
mod owner;
mod search;
mod terminal;
mod view;

pub use alacritty_terminal::grid::Scroll;
pub use alacritty_terminal::index::{Column, Line, Point, Side};
pub use alacritty_terminal::selection::{SelectionRange, SelectionType};
pub use alacritty_terminal::term::TermMode;
pub use alacritty_terminal::term::cell::{Cell, Flags};
pub use alacritty_terminal::term::color::Colors;
pub use alacritty_terminal::vte::ansi::{Color, CursorShape, NamedColor, Rgb};
pub use emulator::{IndexedCell, SCROLLBACK_LINES, TerminalContent, TerminalCursor};
pub use input::{
    MouseAction, MouseButton, alternate_scroll_input, focus_input, key_input, mouse_input,
    paste_input,
};
pub use link::{TerminalLink, web_url};
pub use owner::{Inventory, StartState, Terminals, TerminalsEvent, TerminalsShown};
pub use search::TerminalMatch;
pub use terminal::{BATCH_LIMIT, BATCH_WINDOW, CloseState, Terminal, TerminalEvent, TerminalPhase};
pub use view::{
    Copy, FindInTerminal, Paste, ScrollPageDown, ScrollPageUp, ScrollToBottom, ScrollToTop,
    SelectAll, SendShiftTab, SendTab, TERMINAL_CONTEXT, TerminalTab, TerminalView,
    TerminalViewEvent, init,
};

#[cfg(test)]
mod tests;
#[cfg(test)]
mod view_tests;
