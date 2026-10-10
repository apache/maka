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

//! The seam between the find bar and a view whose content it searches.

use gpui_kit::{App, Context, EventEmitter, SharedString, Task, Window};

use crate::SearchQuery;

/// What a [`Searchable`] item tells the find bar following it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchEvent {
    /// The item's content changed: the bar searches again, after a short
    /// pause while changes keep coming, and keeps the active match on the
    /// same text where that text still matches. The bar does not move the
    /// item to it.
    MatchesInvalidated,
    /// The item's own position moved (a selection, a cursor): the bar
    /// takes the match [`Searchable::active_match_index`] names as active.
    ActiveMatchChanged,
}

/// A view the find bar can search: it finds a query's matches in its whole
/// content, paints the matches it is handed, and brings one into view.
///
/// The bar owns the matches and which one is active; the item owns what a
/// match means and how one is drawn. Matches are values the item defines,
/// compared to recognize the same text across searches, and in the order
/// the item's content reads.
pub trait Searchable: EventEmitter<SearchEvent> + Sized + 'static {
    /// One occurrence of a query in the item's content.
    type Match: Clone + PartialEq + std::fmt::Debug + 'static;

    /// Every match of `query` in the item's content, in reading order,
    /// worked out off the main thread. The bar runs one search at a time:
    /// dropping the task abandons it.
    fn find_matches(
        &mut self,
        query: SearchQuery,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Task<Vec<Self::Match>>;

    /// Paints `matches`, the one at `active` with the stronger fill.
    /// Replaces what an earlier call painted.
    fn update_matches(
        &mut self,
        matches: &[Self::Match],
        active: Option<usize>,
        window: &mut Window,
        cx: &mut Context<Self>,
    );

    /// Removes every match painted.
    fn clear_matches(&mut self, window: &mut Window, cx: &mut Context<Self>);

    /// Brings `matches[ix]` into view, revealing whatever hides it.
    fn activate_match(
        &mut self,
        ix: usize,
        matches: &[Self::Match],
        window: &mut Window,
        cx: &mut Context<Self>,
    );

    /// The match the item's own position points at: where a new query
    /// starts, and the active match after [`SearchEvent::ActiveMatchChanged`].
    /// The first match unless the item knows better; `None` without any.
    fn active_match_index(
        &mut self,
        matches: &[Self::Match],
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        (!matches.is_empty()).then_some(0)
    }

    /// A quiet line the bar shows under its count while the item still
    /// gathers content to search, so the count may grow; `None` once
    /// everything is searched.
    fn progress_note(&self, _cx: &App) -> Option<SharedString> {
        None
    }
}
