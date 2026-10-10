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

//! Find in the terminal (⌘F): the view as a [`Searchable`] item over its
//! active terminal's grid and scrollback, and the find bar over the grid.
//!
//! The view, not [`crate::Terminal`], is the item: it emits
//! [`SearchEvent::MatchesInvalidated`] on every new picture of the active
//! terminal and when another terminal becomes active. Matches are grid
//! points; the element maps them to rows through the display offset.

use std::rc::Rc;

use alacritty_terminal::grid::Scroll;
use gpui_kit::{
    AnyElement, AppContext as _, Context, Entity, EventEmitter, InteractiveElement as _,
    IntoElement as _, MouseButton, ParentElement as _, Styled as _, Subscription, Task, Window,
    div, rems,
};
use search::{FindBar, FindBarEvent, SearchEvent, SearchQuery, Searchable};
use shared::copy::terminal as copy;

use super::TerminalView;
use crate::TerminalMatch;

/// The bar's width: about 360 pt at the default zoom, as the
/// conversation's.
const FIND_BAR_WIDTH_REMS: f32 = 22.5;

/// The find bar over the terminal and the matches it painted.
#[derive(Default)]
pub(crate) struct Find {
    bar: Option<Entity<FindBar<TerminalView>>>,
    open: bool,
    matches: Rc<[TerminalMatch]>,
    active: Option<usize>,
    _events: Option<Subscription>,
}

impl Find {
    /// The bar, while it shows.
    pub(crate) fn bar(&self) -> Option<&Entity<FindBar<TerminalView>>> {
        self.bar.as_ref().filter(|_| self.open)
    }

    pub(crate) fn painted(&self) -> Rc<[TerminalMatch]> {
        self.matches.clone()
    }

    pub(crate) fn active_ix(&self) -> Option<usize> {
        self.active
    }

    pub(crate) fn clear_matches(&mut self) {
        self.matches = Rc::from([]);
        self.active = None;
    }
}

impl EventEmitter<SearchEvent> for TerminalView {}

impl TerminalView {
    /// Shows the find bar over the active terminal and focuses its query;
    /// shown already, it only focuses the query. Without a terminal there is
    /// nothing to find.
    pub fn open_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.active_terminal(cx).is_none() {
            return;
        }
        let bar = match &self.find.bar {
            Some(bar) => bar.clone(),
            None => {
                let view = cx.entity();
                let label = copy::FIND_IN_TERMINAL.get(cx);
                let bar = cx.new(|cx| FindBar::new(&view, label, window, cx));
                self.find._events = Some(cx.subscribe_in(
                    &bar,
                    window,
                    |this, _, event: &FindBarEvent, window, cx| {
                        if *event == FindBarEvent::Dismissed {
                            this.close_find(window, cx);
                        }
                    },
                ));
                self.find.bar = Some(bar.clone());
                bar
            }
        };
        self.find.open = true;
        bar.update(cx, |bar, cx| bar.focus_query(window, cx));
        cx.notify();
    }

    /// Whether the find bar shows.
    pub fn is_find_open(&self) -> bool {
        self.find.open
    }

    /// The find bar, while it shows.
    pub fn find_bar(&self) -> Option<&Entity<FindBar<TerminalView>>> {
        self.find.bar()
    }

    /// Hides the bar (Escape in it, or its Close): its matches go and focus
    /// returns to the terminal.
    fn close_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.find.open {
            return;
        }
        self.find.open = false;
        self.find.clear_matches();
        self.focus.focus(window, cx);
        cx.notify();
    }

    /// Hides the bar without a window, for a face left with no terminal to
    /// find in (the task's last one closed, another task).
    pub(super) fn end_find(&mut self, cx: &mut Context<Self>) {
        if !self.find.open {
            return;
        }
        self.find.open = false;
        self.find.clear_matches();
        if let Some(bar) = &self.find.bar {
            bar.update(cx, |bar, cx| bar.reset(cx));
        }
    }

    pub(super) fn select_next_match(
        &mut self,
        _: &search::SelectNextMatch,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.step_find(true, window, cx) {
            cx.propagate();
        }
    }

    pub(super) fn select_previous_match(
        &mut self,
        _: &search::SelectPreviousMatch,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.step_find(false, window, cx) {
            cx.propagate();
        }
    }

    /// ⌘G and ⇧⌘G with the terminal focused: the bar's next or previous
    /// match while it shows. Whether it does.
    fn step_find(&mut self, forward: bool, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(bar) = self.find.bar().cloned() else { return false };
        // The bar asks this view to show the match: not inside its update.
        window.defer(cx, move |window, cx| {
            bar.update(cx, |bar, cx| {
                if forward {
                    bar.select_next_match(window, cx);
                } else {
                    bar.select_previous_match(window, cx);
                }
            });
        });
        true
    }

    /// The bar, placed at the top right of the terminal's box. It covers
    /// the grid, never moves it.
    pub(super) fn render_find_bar(&self) -> Option<AnyElement> {
        let bar = self.find.bar()?.clone();
        Some(
            div()
                .absolute()
                .top_2()
                .left_2()
                .right_2()
                .flex()
                .justify_end()
                .child(
                    div()
                        .w(rems(FIND_BAR_WIDTH_REMS))
                        .min_w_0()
                        // A press on the bar is the bar's: not a selection in
                        // the grid or a jump of the scrollbar under it.
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .child(bar),
                )
                .into_any_element(),
        )
    }
}

impl Searchable for TerminalView {
    type Match = TerminalMatch;

    fn find_matches(
        &mut self,
        query: SearchQuery,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) -> Task<Vec<TerminalMatch>> {
        match self.active_terminal(cx) {
            Some(terminal) => terminal.update(cx, |terminal, cx| terminal.find(query, cx)),
            None => Task::ready(Vec::new()),
        }
    }

    fn update_matches(
        &mut self,
        matches: &[TerminalMatch],
        active: Option<usize>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.find.matches = matches.into();
        self.find.active = active;
        cx.notify();
    }

    fn clear_matches(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        self.find.clear_matches();
        cx.notify();
    }

    /// Scrolls the match's line to the middle of the screen when it is off
    /// it.
    fn activate_match(
        &mut self,
        ix: usize,
        matches: &[TerminalMatch],
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(found) = matches.get(ix).copied() else { return };
        let Some(terminal) = self.active_terminal(cx) else { return };
        terminal.update(cx, |terminal, _| {
            let content = terminal.content();
            let rows = i32::from(content.size.rows);
            let offset = i32::try_from(content.display_offset).unwrap_or(0);
            let history = i32::try_from(content.history_size).unwrap_or(i32::MAX);
            let line = found.start.line.0;
            let top = -offset;
            if line >= top && line < top + rows {
                return;
            }
            let target = (rows / 2 - line).clamp(0, history);
            terminal.scroll_display(Scroll::Delta(target - offset));
        });
    }

    /// The latest output's match: a terminal is read from the bottom up.
    fn active_match_index(
        &mut self,
        matches: &[TerminalMatch],
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        matches.len().checked_sub(1)
    }
}
