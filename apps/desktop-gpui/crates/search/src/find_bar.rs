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

//! The find bar: a query field, Match case and Match whole word, the count
//! of matches, previous and next, and close, following one [`Searchable`]
//! item.

use std::time::Duration;

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{
    ActiveTheme as _, Disableable as _, Icon, Selectable as _, Sizable as _, h_flex, v_flex,
};
use gpui_kit::{
    App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, Role, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Task, TestSupportExt as _,
    WeakEntity, Window, div, prelude::FluentBuilder as _,
};
use shared::copy::{self as shell_copy, search as copy};
use shared::icons::MakaIcon;
use shared::theme::{
    ActiveMakaPalette as _, FieldFill as _, RADIUS_MODAL, floating_shadow, tabular_nums,
};

use crate::{
    Dismiss, FIND_BAR_CONTEXT, SearchEvent, SearchOptions, SearchQuery, Searchable,
    SelectNextMatch, SelectPreviousMatch,
};

/// How long the bar waits after the item's content last changed before it
/// searches again: a streaming reply commits about 8 times a second, and
/// one search per pause is enough.
pub const REFRESH_DELAY: Duration = Duration::from_millis(150);

/// What the find bar asks its owner to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum FindBarEvent {
    /// Escape or Close: hide the bar and give focus back. The bar has
    /// already cleared the item's matches.
    Dismissed,
}

/// Why a search runs: a new query moves to its first match; a refresh after
/// the item changed keeps the active match where it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SearchKind {
    Fresh,
    Refresh,
}

/// The search in flight, or the refresh waiting out [`REFRESH_DELAY`].
struct Pending {
    kind: SearchKind,
    /// Still waiting: the search has not started.
    waiting: bool,
    _task: Task<()>,
}

/// Finds a query in one [`Searchable`] item.
///
/// Behavior owner of the query, the options, the matches and which one is
/// active; the item paints them and brings one into view, and the owner
/// places the bar, shows and hides it ([`FindBarEvent::Dismissed`]), and
/// gives focus back. One search runs at a time: a new query or option
/// drops the search in flight, and so does the refresh that follows a
/// change of the item's content ([`SearchEvent::MatchesInvalidated`]).
///
/// Keyboard ([`FIND_BAR_CONTEXT`]): Enter and Shift-Enter in the query move
/// to the next and previous match, as ⌘G and ⇧⌘G do; Escape dismisses.
/// Moving past either end wraps around.
pub struct FindBar<S: Searchable> {
    item: WeakEntity<S>,
    query: Entity<InputState>,
    options: SearchOptions,
    matches: Vec<S::Match>,
    active: Option<usize>,
    /// The query the matches belong to; `None` until a search finishes and
    /// after the bar is dismissed.
    searched: Option<SearchQuery>,
    pending: Option<Pending>,
    /// The bar's name: its accessible name and the query's placeholder.
    label: SharedString,
    _subscriptions: Vec<Subscription>,
}

impl<S: Searchable> EventEmitter<FindBarEvent> for FindBar<S> {}

impl<S: Searchable> std::fmt::Debug for FindBar<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FindBar")
            .field("options", &self.options)
            .field("matches", &self.matches.len())
            .field("active", &self.active)
            .finish_non_exhaustive()
    }
}

impl<S: Searchable> FindBar<S> {
    /// A bar following `item`, named `label`.
    pub fn new(
        item: &Entity<S>,
        label: impl Into<SharedString>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let label = label.into();
        let query = cx.new(|cx| InputState::new(window, cx).placeholder(label.clone()));
        let subscriptions = vec![
            cx.subscribe_in(
                &query,
                window,
                |this, _, event: &InputEvent, window, cx| match event {
                    InputEvent::Change => this.search(SearchKind::Fresh, window, cx),
                    InputEvent::PressEnter { shift, .. } => {
                        if *shift {
                            this.select_previous_match(window, cx);
                        } else {
                            this.select_next_match(window, cx);
                        }
                    }
                    _ => {}
                },
            ),
            cx.subscribe_in(item, window, |this, _, event: &SearchEvent, window, cx| match event {
                SearchEvent::MatchesInvalidated => this.schedule_refresh(window, cx),
                SearchEvent::ActiveMatchChanged => this.follow_item(window, cx),
            }),
            // The item's progress note shows under the count.
            cx.observe(item, |_, _, cx| cx.notify()),
        ];
        Self {
            item: item.downgrade(),
            query,
            options: SearchOptions::default(),
            matches: Vec::new(),
            active: None,
            searched: None,
            pending: None,
            label,
            _subscriptions: subscriptions,
        }
    }

    /// The query field.
    pub fn query(&self) -> &Entity<InputState> {
        &self.query
    }

    /// The matches of the last search, in the item's reading order.
    pub fn matches(&self) -> &[S::Match] {
        &self.matches
    }

    /// The position of the active match in [`Self::matches`].
    pub fn active_match_index(&self) -> Option<usize> {
        self.active
    }

    pub fn options(&self) -> SearchOptions {
        self.options
    }

    /// Whether a search is in flight or waiting to run.
    pub fn is_searching(&self) -> bool {
        self.pending.is_some()
    }

    /// Puts `text` in the query, focused with its text selected, and
    /// searches it as a new query, which moves to the match the item's
    /// [`Searchable::active_match_index`] names. The search runs once the
    /// current update ends: the owner may call this from an update of the
    /// item.
    pub fn search_for(
        &mut self,
        text: impl Into<SharedString>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let text = text.into();
        self.query.update(cx, |query, cx| {
            query.set_value(text, window, cx);
            query.focus(window, cx);
            query.select_all(window, cx);
        });
        let task = cx.spawn_in(window, async move |this, cx| {
            this.update_in(cx, |this, window, cx| this.search(SearchKind::Fresh, window, cx)).ok();
        });
        self.pending = Some(Pending { kind: SearchKind::Fresh, waiting: true, _task: task });
        cx.notify();
    }

    /// Focuses the query with its text selected, so typing replaces it. A
    /// bar shown again with a query searches it again.
    pub fn focus_query(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.query.update(cx, |query, cx| {
            query.focus(window, cx);
            query.select_all(window, cx);
        });
        if self.searched.is_none() && !self.query.read(cx).value().is_empty() {
            // Not now: the owner that shows the bar may be in an update of
            // the item.
            let task = cx.spawn_in(window, async move |this, cx| {
                this.update_in(cx, |this, window, cx| {
                    this.search(SearchKind::Fresh, window, cx);
                })
                .ok();
            });
            self.pending = Some(Pending { kind: SearchKind::Fresh, waiting: true, _task: task });
        }
    }

    /// Flips Match case and searches again.
    pub fn toggle_case_sensitive(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.options = self.options.case_sensitive(!self.options.is_case_sensitive());
        self.search(SearchKind::Fresh, window, cx);
    }

    /// Flips Match whole word and searches again.
    pub fn toggle_whole_word(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.options = self.options.whole_word(!self.options.is_whole_word());
        self.search(SearchKind::Fresh, window, cx);
    }

    /// Moves to the next match, after the last back to the first.
    pub fn select_next_match(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.step(true, window, cx);
    }

    /// Moves to the previous match, before the first on to the last.
    pub fn select_previous_match(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.step(false, window, cx);
    }

    /// Stops searching, clears the item's matches and asks the owner to
    /// hide the bar. The query stays for the next time it shows.
    pub fn dismiss(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.clear(window, cx);
        cx.emit(FindBarEvent::Dismissed);
    }

    /// Stops searching and forgets the matches without telling the item:
    /// for an owner that hides the bar and clears the item's matches
    /// itself, from inside an update of the item. The query stays.
    pub fn reset(&mut self, cx: &mut Context<Self>) {
        self.pending = None;
        self.matches.clear();
        self.active = None;
        self.searched = None;
        cx.notify();
    }

    fn clear(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.reset(cx);
        if let Some(item) = self.item.upgrade() {
            item.update(cx, |item, cx| item.clear_matches(window, cx));
        }
    }

    fn step(&mut self, forward: bool, window: &mut Window, cx: &mut Context<Self>) {
        let count = self.matches.len();
        if count == 0 {
            return;
        }
        let next = match self.active {
            Some(ix) if forward => (ix + 1) % count,
            Some(ix) => (ix + count - 1) % count,
            None if forward => 0,
            None => count - 1,
        };
        self.active = Some(next);
        if let Some(item) = self.item.upgrade() {
            let matches = &self.matches;
            item.update(cx, |item, cx| {
                item.update_matches(matches, Some(next), window, cx);
                item.activate_match(next, matches, window, cx);
            });
        }
        cx.notify();
    }

    /// Searches the item for the current query, dropping any search in
    /// flight. An empty query clears the matches at once.
    fn search(&mut self, kind: SearchKind, window: &mut Window, cx: &mut Context<Self>) {
        let query = SearchQuery::new(self.query.read(cx).value().as_ref(), self.options);
        let Some(item) = self.item.upgrade() else { return };
        if query.is_empty() {
            self.pending = None;
            self.matches.clear();
            self.active = None;
            self.searched = Some(query);
            item.update(cx, |item, cx| item.clear_matches(window, cx));
            cx.notify();
            return;
        }
        let task = item.update(cx, |item, cx| item.find_matches(query.clone(), window, cx));
        let search = cx.spawn_in(window, async move |this, cx| {
            let matches = task.await;
            this.update_in(cx, |this, window, cx| {
                this.finish_search(kind, query, matches, window, cx);
            })
            .ok();
        });
        self.pending = Some(Pending { kind, waiting: false, _task: search });
    }

    /// Searches again [`REFRESH_DELAY`] after the item's content changed,
    /// once for all the changes in that time: a refresh already waiting
    /// takes this change too, so content that keeps changing (a streaming
    /// reply) still refreshes the count every pause. A search in flight is
    /// dropped, its content being out of date. A new query waiting to be
    /// searched stays new.
    fn schedule_refresh(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.searched.is_none() && self.pending.is_none() {
            // Hidden, or nothing searched yet.
            return;
        }
        if self.pending.as_ref().is_some_and(|pending| pending.waiting) {
            return;
        }
        let kind = match &self.pending {
            Some(pending) => pending.kind,
            None => SearchKind::Refresh,
        };
        let refresh = cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(REFRESH_DELAY).await;
            this.update_in(cx, |this, window, cx| this.search(kind, window, cx)).ok();
        });
        self.pending = Some(Pending { kind, waiting: true, _task: refresh });
    }

    fn finish_search(
        &mut self,
        kind: SearchKind,
        query: SearchQuery,
        matches: Vec<S::Match>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(item) = self.item.upgrade() else { return };
        self.pending = None;
        let previous = self.active.and_then(|ix| self.matches.get(ix).cloned().map(|m| (ix, m)));
        self.matches = matches;
        self.searched = Some(query);
        let matches = &self.matches;
        let active = item.update(cx, |item, cx| {
            let active = match (kind, previous) {
                (SearchKind::Refresh, Some((ix, previous))) => matches
                    .iter()
                    .position(|candidate| *candidate == previous)
                    .or_else(|| matches.len().checked_sub(1).map(|last| ix.min(last))),
                _ => item.active_match_index(matches, window, cx),
            };
            item.update_matches(matches, active, window, cx);
            if kind == SearchKind::Fresh
                && let Some(ix) = active
            {
                item.activate_match(ix, matches, window, cx);
            }
            active
        });
        self.active = active;
        cx.notify();
    }

    /// Takes the match the item now points at as active.
    fn follow_item(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(item) = self.item.upgrade() else { return };
        if self.matches.is_empty() {
            return;
        }
        let matches = &self.matches;
        let active = item.update(cx, |item, cx| {
            let active = item.active_match_index(matches, window, cx);
            item.update_matches(matches, active, window, cx);
            active
        });
        self.active = active;
        cx.notify();
    }

    /// What the count says: "3/12", "No results" once a query found
    /// nothing, or nothing while the query is empty.
    pub fn count_text(&self, cx: &App) -> Option<SharedString> {
        let searched = self.searched.as_ref().filter(|query| !query.is_empty())?;
        if self.matches.is_empty() {
            return (!searched.is_empty()).then(|| copy::NO_RESULTS.get(cx).into());
        }
        let position = self.active.map_or(0, |ix| ix + 1);
        Some(format!("{position}/{}", self.matches.len()).into())
    }

    fn render_button(&self, id: &'static str, icon: Icon, label: &'static str, cx: &App) -> Button {
        Button::new(id)
            .ghost()
            .small()
            .size_6()
            .flex_shrink_0()
            .icon(icon.size_3p5().text_color(cx.maka().ink_muted))
            .accessibility_label(label)
            .tooltip(label)
    }

    fn render_toggle(
        &self,
        id: &'static str,
        icon: Icon,
        label: &'static str,
        on: bool,
        cx: &App,
    ) -> Button {
        self.render_button(id, icon, label, cx).selected(on).toggled(on)
    }
}

impl<S: Searchable> Focusable for FindBar<S> {
    /// The query field.
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.query.read(cx).focus_handle(cx)
    }
}

impl<S: Searchable> Render for FindBar<S> {
    /// DESIGN.md's floating recipe (the overlay fill, a `border_soft`
    /// hairline, the modal radius, one soft shadow), one row of 24 pt
    /// controls: the query, Match case and Match whole word, the count,
    /// previous and next, close; the item's progress note under them.
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let maka = cx.maka();
        let shadow = floating_shadow(&maka, cx.theme().mode.is_dark());
        let has_matches = !self.matches.is_empty();
        let count = self.count_text(cx);
        let note = self.item.upgrade().and_then(|item| item.read(cx).progress_note(cx));
        let case = self.options.is_case_sensitive();
        let word = self.options.is_whole_word();
        let match_case = copy::MATCH_CASE.get(cx);
        let whole_word = copy::MATCH_WHOLE_WORD.get(cx);
        let previous = copy::PREVIOUS_MATCH.get(cx);
        let next = copy::NEXT_MATCH.get(cx);
        let close = shell_copy::CLOSE.get(cx);
        v_flex()
            .id("find-bar")
            .test_support()
            .key_context(FIND_BAR_CONTEXT)
            .role(Role::Search)
            .aria_label(self.label.clone())
            .on_action(cx.listener(|this, _: &SelectNextMatch, window, cx| {
                this.select_next_match(window, cx);
            }))
            .on_action(cx.listener(|this, _: &SelectPreviousMatch, window, cx| {
                this.select_previous_match(window, cx);
            }))
            .on_action(cx.listener(|this, _: &Dismiss, window, cx| this.dismiss(window, cx)))
            .w_full()
            .min_w_0()
            .p_1()
            .gap_0p5()
            .rounded(RADIUS_MODAL)
            .border_1()
            .border_color(maka.border_soft)
            .bg(maka.overlay)
            .shadow(shadow)
            .child(
                h_flex()
                    .w_full()
                    .min_w_0()
                    .gap_0p5()
                    .child(
                        div().flex_1().min_w_0().child(
                            Input::new(&self.query)
                                .id("find-query")
                                .small()
                                .field_fill(cx)
                                .aria_label(self.label.clone())
                                .prefix(Icon::new(MakaIcon::Search).small()),
                        ),
                    )
                    .child(
                        self.render_toggle(
                            "find-match-case",
                            Icon::new(gpui_kit::assets::IconName::CaseSensitive),
                            match_case,
                            case,
                            cx,
                        )
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.toggle_case_sensitive(window, cx);
                        })),
                    )
                    .child(
                        self.render_toggle(
                            "find-whole-word",
                            Icon::new(gpui_kit::assets::IconName::WholeWord),
                            whole_word,
                            word,
                            cx,
                        )
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.toggle_whole_word(window, cx);
                        })),
                    )
                    .children(count.map(|count| {
                        div()
                            .id("find-count")
                            .test_support()
                            .role(Role::Status)
                            .aria_label(count.clone())
                            .flex_shrink_0()
                            .px_1()
                            .text_xs()
                            .font_features(tabular_nums())
                            .text_color(maka.ink_muted)
                            .child(count)
                            .into_any_element()
                    }))
                    .child(
                        self.render_button(
                            "find-previous",
                            Icon::new(MakaIcon::ChevronLeft),
                            previous,
                            cx,
                        )
                        .disabled(!has_matches)
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.select_previous_match(window, cx);
                        })),
                    )
                    .child(
                        self.render_button(
                            "find-next",
                            Icon::new(MakaIcon::ChevronRight),
                            next,
                            cx,
                        )
                        .disabled(!has_matches)
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.select_next_match(window, cx);
                        })),
                    )
                    .child(
                        self.render_button("find-close", Icon::new(MakaIcon::Close), close, cx)
                            .on_click(cx.listener(|this, _, window, cx| this.dismiss(window, cx))),
                    ),
            )
            .when_some(note, |this, note| {
                this.child(
                    div()
                        .id("find-note")
                        .test_support()
                        .role(Role::Status)
                        .aria_label(note.clone())
                        .px_2()
                        .pb_0p5()
                        .text_xs()
                        .text_color(maka.ink_muted)
                        .child(note),
                )
            })
    }
}
