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

//! Links under the pointer. While ⌘ (Control elsewhere) is held over the
//! grid, the link under the pointer is underlined and the pointer becomes a
//! pointing hand; ⌘-click opens it with the app's external-link path
//! (`App::open_url`, as the transcript's links open). Only web addresses
//! and OSC 8 hyperlinks to them are links ([`crate::link`]). A ⌘-click is
//! never a mouse report or a selection.
//!
//! Finding the link reads the emulator under its lock, off the main thread.
//! As in Zed's terminal (GPL-3.0; the practice, not the code), the search
//! runs when ⌘ is held as the pointer moves or is pressed while it hovers,
//! at most once every [`LINK_SEARCH_INTERVAL`]: a move inside that interval
//! is searched when it ends.

use std::time::Duration;

use alacritty_terminal::index::Point;
use gpui_kit::{Context, Modifiers, Pixels, Task};

use super::TerminalView;
use crate::TerminalLink;

/// The least time between two link searches.
pub(crate) const LINK_SEARCH_INTERVAL: Duration = Duration::from_millis(100);

/// The link under the pointer and what finds it.
#[derive(Default)]
pub(crate) struct LinkHover {
    /// Where the pointer is over the grid, in window coordinates; `None`
    /// once it left.
    pointer: Option<gpui_kit::Point<Pixels>>,
    /// Whether ⌘ (Control elsewhere) is held, as the last event said.
    held: bool,
    /// The link last found under the pointer.
    found: Option<TerminalLink>,
    /// Bumped by each search: an answer to an older one is dropped.
    generation: u64,
    /// A search asked for while the interval since the last one runs.
    again: bool,
    _search: Option<Task<()>>,
    throttle: Option<Task<()>>,
}

impl TerminalView {
    /// The link to underline: the one under the pointer while ⌘ is held.
    pub(super) fn shown_link(&self, cx: &gpui_kit::App) -> Option<&TerminalLink> {
        if !self.links.held {
            return None;
        }
        let (column, row, _) = self.cell_at(self.links.pointer?)?;
        let point = self.grid_point(column, row, cx)?;
        self.links.found.as_ref().filter(|link| link.contains(point))
    }

    /// The pointer moved over the grid with `modifiers` held.
    pub(super) fn link_pointer_moved(
        &mut self,
        position: gpui_kit::Point<Pixels>,
        modifiers: &Modifiers,
        cx: &mut Context<Self>,
    ) {
        let moved_cell = self
            .links
            .pointer
            .and_then(|before| self.cell_at(before))
            .map(|(column, row, _)| (column, row))
            != self.cell_at(position).map(|(column, row, _)| (column, row));
        self.links.pointer = Some(position);
        let held = modifiers.secondary();
        let changed = std::mem::replace(&mut self.links.held, held) != held;
        if held && (moved_cell || changed) {
            self.request_link_search(cx);
        }
        if changed || (held && moved_cell) {
            cx.notify();
        }
    }

    /// ⌘ was pressed or released.
    pub(super) fn link_modifiers_changed(&mut self, modifiers: &Modifiers, cx: &mut Context<Self>) {
        let held = modifiers.secondary();
        if std::mem::replace(&mut self.links.held, held) == held {
            return;
        }
        if held && self.links.pointer.is_some() {
            self.request_link_search(cx);
        }
        cx.notify();
    }

    /// The pointer left the grid.
    pub(super) fn link_pointer_left(&mut self, cx: &mut Context<Self>) {
        self.links.pointer = None;
        if self.links.found.take().is_some() {
            cx.notify();
        }
    }

    /// A new picture: a link found in the old one may have moved. It is
    /// searched again while ⌘ is held, and forgotten otherwise.
    pub(super) fn links_invalidated(&mut self, cx: &mut Context<Self>) {
        if self.links.held && self.links.pointer.is_some() {
            self.request_link_search(cx);
        } else {
            self.links.found = None;
        }
    }

    /// Searches under the pointer now, or once the interval since the last
    /// search ends.
    fn request_link_search(&mut self, cx: &mut Context<Self>) {
        if self.links.throttle.is_some() {
            self.links.again = true;
            return;
        }
        self.search_link(cx);
        self.links.throttle = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(LINK_SEARCH_INTERVAL).await;
            this.update(cx, |this, cx| {
                this.links.throttle = None;
                if std::mem::take(&mut this.links.again) && this.links.held {
                    this.request_link_search(cx);
                }
            })
            .ok();
        }));
    }

    fn search_link(&mut self, cx: &mut Context<Self>) {
        let Some(terminal) = self.active_terminal(cx) else { return };
        let Some((column, row, _)) = self.links.pointer.and_then(|at| self.cell_at(at)) else {
            return;
        };
        let Some(point) = self.grid_point(column, row, cx) else { return };
        self.links.generation += 1;
        let generation = self.links.generation;
        let search = terminal.update(cx, |terminal, cx| terminal.link_at(point, cx));
        self.links._search = Some(cx.spawn(async move |this, cx| {
            let found = search.await;
            this.update(cx, |this, cx| {
                if this.links.generation == generation && this.links.found != found {
                    this.links.found = found;
                    cx.notify();
                }
            })
            .ok();
        }));
    }

    /// ⌘-click at `point`: opens the link there, the one underlined or, when
    /// the search has not caught up with the pointer, the one found now.
    pub(super) fn open_link_at(&mut self, point: Point, cx: &mut Context<Self>) {
        if let Some(link) = self.links.found.as_ref().filter(|link| link.contains(point)) {
            cx.open_url(&link.url);
            return;
        }
        let Some(terminal) = self.active_terminal(cx) else { return };
        let search = terminal.update(cx, |terminal, cx| terminal.link_at(point, cx));
        cx.spawn(async move |_, cx| {
            if let Some(link) = search.await {
                cx.update(|cx| cx.open_url(&link.url));
            }
        })
        .detach();
    }
}
