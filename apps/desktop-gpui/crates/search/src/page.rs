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

//! The Search page: what was said in every task, through the Host's search
//! (`recall.query`), after Zed's project search (its practices, not its
//! code): a results document grouped by task, searched as the person types
//! after a pause, the last results kept, dimmed, until the next arrive.
//!
//! The page is a sidebar page on the plate ([`SearchView::render_page`]);
//! the shell owns when it shows, hands it the window's task list
//! ([`SearchView::set_tasks`]) and opens what it asks for
//! ([`SearchPageEvent`]).

use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use gpui_kit::assets::IconName as AssetIcon;
use gpui_kit::component::button::Button;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::scroll::Scrollbar;
use gpui_kit::component::{Icon, Sizable as _, StyledExt as _, ThemeStyled as _, h_flex, v_flex};
use gpui_kit::{
    AnyElement, App, AppContext as _, ClickEvent, Context, ElementId, Empty, Entity, EventEmitter,
    FocusHandle, HighlightStyle, InteractiveElement as _, IntoElement, KeyBinding, MouseButton,
    MouseDownEvent, ParentElement as _, Role, ScrollHandle, SharedString,
    StatefulInteractiveElement as _, Styled as _, StyledText, Subscription, Task,
    TestSupportExt as _, Window, div, prelude::FluentBuilder as _, rems,
};
use host_protocol::{RecallFailureReason, RecallQuery, RecallRole};
use shared::copy::{self as shell_copy, Locale, Text, search as copy};
use shared::domain_element_id;
use shared::icons::MakaIcon;
use shared::layout::PAGE_MAX_WIDTH_REMS;
use shared::theme::{
    ActiveMakaPalette as _, FieldFill as _, RADIUS_SURFACE, badge, group_label_size, page_header,
    quiet_button, selectable_row, tabular_nums,
};
use shared::time::{local_utc_offset, relative_time};
use workspace::{HostSession, HostSessionEvent};

use crate::recall::{
    Answer, Excerpt, Found, MAX_TASKS_SEARCHED, Passage, PassageTarget, SearchFailure, TaskEntry,
    recall_input, title_matches,
};

/// Key context of the Search page, its field and its results.
pub const SEARCH_PAGE_CONTEXT: &str = "SearchPage";

/// How long the page waits after the last keystroke before it searches
/// (Zed's project search on type).
pub const SEARCH_DEBOUNCE: Duration = Duration::from_millis(250);

/// Lines of a passage's message a result shows: its anchor, and the
/// neighbours around it.
const ANCHOR_LINES: usize = 4;
const NEIGHBOUR_LINES: usize = 2;

/// The lane of a message's role: wide enough for "Maka" and "工具".
const ROLE_LANE_REMS: f32 = 3.;

gpui_kit::actions!(
    search_page,
    [
        /// Move the cursor to the next result: a task title or a passage.
        SelectNextResult,
        /// Move the cursor to the previous result.
        SelectPreviousResult,
        /// Open the result under the cursor, or the first result.
        OpenResult,
        /// Clear the query; with nothing typed, leave the page.
        DismissSearch,
    ]
);

/// Binds the page's keys, in the field and in the results alike: a
/// one-line field leaves Up and Down unhandled and passes Enter and Escape
/// on, so they reach the page from the field too.
pub(crate) fn bind_keys(cx: &mut App) {
    let context = Some(SEARCH_PAGE_CONTEXT);
    cx.bind_keys([
        KeyBinding::new("down", SelectNextResult, context),
        KeyBinding::new("up", SelectPreviousResult, context),
        KeyBinding::new("enter", OpenResult, context),
        KeyBinding::new("escape", DismissSearch, context),
    ]);
}

/// What the page asks the window to do.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum SearchPageEvent {
    /// Show this task, as the sidebar does.
    OpenTask(SharedString),
    /// Show this passage's task at its message, with the find bar on its
    /// term.
    OpenPassage(PassageTarget),
    /// Escape with nothing typed: leave the page.
    Leave,
}

/// The element of task `id`'s row among the title matches.
pub fn title_element_id(id: &str) -> ElementId {
    domain_element_id("search-title", id)
}

/// The element of a passage's row, by its task and its message.
pub fn passage_element_id(session_id: &str, anchor_message_id: &str) -> ElementId {
    domain_element_id("search-passage", &format!("{session_id}/{anchor_message_id}"))
}

/// A result the cursor can rest on, by domain identity.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum ResultKey {
    Title(SharedString),
    Passage { session: SharedString, anchor: SharedString },
}

impl ResultKey {
    fn of_passage(passage: &Passage) -> Self {
        let target = passage.target();
        Self::Passage {
            session: target.session_id().clone(),
            anchor: target.anchor_message_id().clone(),
        }
    }
}

/// How a result's row shows the cursor: the selected fill while it rests
/// there, and the focus ring too while the keyboard moves it.
#[derive(Debug, Clone, Copy)]
struct RowMark {
    cursor: bool,
    ring: bool,
}

impl RowMark {
    fn of(key: &ResultKey, cursor: &Option<ResultKey>, keyboard: bool) -> Self {
        let at = cursor.as_ref() == Some(key);
        Self { cursor: at, ring: at && keyboard }
    }
}

/// One block of the page's column, top to bottom: each a child of the
/// scrolling column, so a result can be scrolled into view by position.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Block {
    Header,
    Field,
    Status,
    /// The results' Tab stop, after the field: the keyboard's way into
    /// the results when it is not in the field.
    Results,
    TitlesLabel,
    Title(usize),
    FactsLabel,
    Facts,
    Task(usize),
    Passage(usize, usize),
    Failure,
    NoResults,
    End,
}

/// The Search page's state: the query, the window's tasks, the last
/// answer, the search in flight, and the cursor.
///
/// Behavior owner of searching: each change of the query matches task
/// titles at once and searches the Host after [`SEARCH_DEBOUNCE`]; the
/// protocol has no cancel, so each search is tagged and an answer for any
/// but the latest is dropped. While a search runs the last answer stays,
/// dimmed. A failure that searching again can mend offers it; one for lack
/// of a connection searches again once the Host connects.
///
/// Keyboard ([`SEARCH_PAGE_CONTEXT`]): Up and Down move the cursor through
/// the title matches and the passages, from the field or the results (one
/// Tab stop); Enter opens the cursor's result (the first without one);
/// Escape clears the query, then leaves.
pub struct SearchView {
    host: Entity<HostSession>,
    query: Entity<InputState>,
    tasks: Vec<TaskEntry>,
    /// Positions in `tasks` by id.
    by_id: HashMap<SharedString, usize>,
    /// Sessions whose passages never show: side chats' forks, which copy
    /// their task's words.
    hidden: HashSet<SharedString>,
    /// Positions in `tasks` of the titles the query matches, best first.
    titles: Vec<usize>,
    /// The last answer, kept while a newer search runs.
    shown: Option<Answer>,
    /// The search waiting out [`SEARCH_DEBOUNCE`] or running; dropping it
    /// abandons it.
    pending: Option<Task<()>>,
    /// Bumped by every search: an answer for an older one is dropped.
    generation: u64,
    cursor: Option<ResultKey>,
    /// The results' Tab stop.
    focus: FocusHandle,
    scroll: ScrollHandle,
    /// Wall-clock milliseconds since the Unix epoch.
    clock: Rc<dyn Fn() -> u64>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<SearchPageEvent> for SearchView {}

impl std::fmt::Debug for SearchView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SearchView")
            .field("tasks", &self.tasks.len())
            .field("generation", &self.generation)
            .field("cursor", &self.cursor)
            .finish_non_exhaustive()
    }
}

fn system_time_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as u64)
}

impl SearchView {
    pub fn new(host: Entity<HostSession>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let query =
            cx.new(|cx| InputState::new(window, cx).placeholder(copy::SEARCH_ALL_TASKS.get(cx)));
        let focus = cx.focus_handle().tab_stop(true);
        let subscriptions = vec![
            cx.subscribe(&query, |this, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    this.query_changed(true, cx);
                }
            }),
            // A search that failed for want of a connection runs again
            // once there is one.
            cx.subscribe(&host, |this, _, event: &HostSessionEvent, cx| {
                if matches!(event, HostSessionEvent::Connected { .. }) {
                    this.search_again_after_reconnect(cx);
                }
            }),
            cx.observe_global_in::<Locale>(window, |this, window, cx| {
                let placeholder = copy::SEARCH_ALL_TASKS.get(cx);
                this.query.update(cx, |query, cx| query.set_placeholder(placeholder, window, cx));
            }),
        ];
        Self {
            host,
            query,
            tasks: Vec::new(),
            by_id: HashMap::new(),
            hidden: HashSet::new(),
            titles: Vec::new(),
            shown: None,
            pending: None,
            generation: 0,
            cursor: None,
            focus,
            scroll: ScrollHandle::new(),
            clock: Rc::new(system_time_ms),
            _subscriptions: subscriptions,
        }
    }

    /// The query field.
    pub fn query(&self) -> &Entity<InputState> {
        &self.query
    }

    /// Whether a search waits out the pause or runs.
    pub fn is_searching(&self) -> bool {
        self.pending.is_some()
    }

    /// Where the results are scrolled.
    pub fn scroll_handle(&self) -> &ScrollHandle {
        &self.scroll
    }

    /// The window's tasks: their titles match the query, and they name and
    /// mark the tasks the passages are in.
    pub fn set_tasks(&mut self, tasks: Vec<TaskEntry>, cx: &mut Context<Self>) {
        if tasks == self.tasks {
            return;
        }
        self.by_id = tasks.iter().enumerate().map(|(ix, task)| (task.id.clone(), ix)).collect();
        self.tasks = tasks;
        let phrase = self.phrase(cx);
        self.titles = title_matches(&self.tasks, &phrase);
        cx.notify();
    }

    /// The Sessions whose passages the page leaves out (side chats'
    /// forks): taken out of the answer shown and of every answer after.
    pub fn set_hidden_sessions(&mut self, hidden: HashSet<SharedString>, cx: &mut Context<Self>) {
        if hidden == self.hidden {
            return;
        }
        self.hidden = hidden;
        if let Some(Answer::Found(found)) = &mut self.shown {
            found.drop_sessions(&self.hidden);
        }
        cx.notify();
    }

    /// Focuses the field with its text selected, so typing replaces it.
    pub fn focus_query(&self, window: &mut Window, cx: &mut App) {
        self.query.update(cx, |query, cx| {
            query.focus(window, cx);
            query.select_all(window, cx);
        });
    }

    /// Gives the page focus back where it was: the results while the
    /// cursor rests on one of them, else the field.
    pub fn focus(&self, window: &mut Window, cx: &mut App) {
        let keys = self.result_keys();
        if self.cursor.as_ref().is_some_and(|cursor| keys.contains(cursor)) {
            self.focus.focus(window, cx);
        } else {
            self.query.update(cx, |query, cx| query.focus(window, cx));
        }
    }

    /// Puts `text` in the field, focused and selected, and searches it now.
    pub fn search_for(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.query.update(cx, |query, cx| {
            query.set_value(text.to_owned(), window, cx);
        });
        self.focus_query(window, cx);
        self.query_changed(false, cx);
    }

    /// Reads the wall clock from `clock` instead of the system's.
    #[cfg(test)]
    pub(crate) fn set_clock(&mut self, clock: impl Fn() -> u64 + 'static) {
        self.clock = Rc::new(clock);
    }

    fn phrase(&self, cx: &App) -> String {
        self.query.read(cx).value().to_string()
    }

    /// The query changed: titles match at once, the Host is asked after
    /// the pause (`debounce`) or now.
    fn query_changed(&mut self, debounce: bool, cx: &mut Context<Self>) {
        let phrase = self.phrase(cx);
        self.cursor = None;
        self.titles = title_matches(&self.tasks, &phrase);
        self.search(phrase, debounce, cx);
    }

    /// Searches the Host for `phrase`, after the pause when `debounce`,
    /// dropping any search before it. A blank phrase clears the answer; one
    /// the Host would refuse fails at once.
    fn search(&mut self, phrase: String, debounce: bool, cx: &mut Context<Self>) {
        self.generation += 1;
        let generation = self.generation;
        let input = match recall_input(&phrase) {
            Ok(Some(input)) => input,
            Ok(None) => {
                self.pending = None;
                self.shown = None;
                cx.notify();
                return;
            }
            Err(_) => {
                self.pending = None;
                self.shown = Some(Answer::Failed(SearchFailure::Invalid));
                cx.notify();
                return;
            }
        };
        let requester = self.host.read(cx).requester();
        let task = cx.spawn(async move |this, cx| {
            if debounce {
                cx.background_executor().timer(SEARCH_DEBOUNCE).await;
            }
            let terms = input.terms.clone();
            let result = requester.request::<RecallQuery>(&input).await;
            let answer =
                cx.background_spawn(async move { Answer::from_result(result, &terms) }).await;
            this.update(cx, |this, cx| this.finish(generation, answer, cx)).ok();
        });
        self.pending = Some(task);
        cx.notify();
    }

    /// Shows `answer` if it is for the latest search.
    fn finish(&mut self, generation: u64, mut answer: Answer, cx: &mut Context<Self>) {
        if generation != self.generation {
            log::info!("search: dropped an answer for an earlier query");
            return;
        }
        self.pending = None;
        if let Answer::Found(found) = &mut answer {
            found.drop_sessions(&self.hidden);
        }
        self.shown = Some(answer);
        cx.notify();
    }

    /// Searches the shown phrase again now.
    fn search_again(&mut self, cx: &mut Context<Self>) {
        let phrase = self.phrase(cx);
        self.search(phrase, false, cx);
    }

    fn search_again_after_reconnect(&mut self, cx: &mut Context<Self>) {
        let failed = self.shown.as_ref().is_some_and(|shown| {
            matches!(
                shown,
                Answer::Failed(SearchFailure::NotConnected | SearchFailure::Unreachable)
            )
        });
        if failed && self.pending.is_none() {
            self.search_again(cx);
        }
    }

    /// What the last answer found, while it is for the field's phrase or
    /// a search for it runs.
    fn found(&self) -> Option<&Found> {
        match self.shown.as_ref()? {
            Answer::Found(found) => Some(found),
            Answer::Failed(_) => None,
        }
    }

    fn failure(&self) -> Option<&SearchFailure> {
        match self.shown.as_ref()? {
            Answer::Failed(failure) => Some(failure),
            Answer::Found(_) => None,
        }
    }

    /// The results the cursor walks, in the page's order.
    fn result_keys(&self) -> Vec<ResultKey> {
        let titles = self.titles.iter().map(|ix| ResultKey::Title(self.tasks[*ix].id.clone()));
        let passages = self
            .found()
            .into_iter()
            .flat_map(|found| found.tasks())
            .flat_map(|task| task.passages())
            .map(ResultKey::of_passage);
        titles.chain(passages).collect()
    }

    /// The page's blocks, top to bottom.
    fn blocks(&self, cx: &App) -> Vec<Block> {
        let mut blocks = vec![Block::Header, Block::Field, Block::Status];
        if !self.result_keys().is_empty() {
            blocks.push(Block::Results);
        }
        if !self.titles.is_empty() {
            blocks.push(Block::TitlesLabel);
            blocks.extend((0..self.titles.len()).map(Block::Title));
        }
        if let Some(found) = self.found() {
            if !found.facts().is_empty() {
                blocks.extend([Block::FactsLabel, Block::Facts]);
            }
            for (task_ix, task) in found.tasks().iter().enumerate() {
                blocks.push(Block::Task(task_ix));
                blocks.extend((0..task.passages().len()).map(|ix| Block::Passage(task_ix, ix)));
            }
            if found.is_empty() && self.titles.is_empty() && !self.phrase(cx).trim().is_empty() {
                blocks.push(Block::NoResults);
            }
        }
        if self.failure().is_some() {
            blocks.push(Block::Failure);
        }
        blocks.push(Block::End);
        blocks
    }

    fn block_of(&self, key: &ResultKey, cx: &App) -> Option<usize> {
        self.blocks(cx).iter().position(|block| match (block, key) {
            (Block::Title(ix), ResultKey::Title(id)) => self.tasks[self.titles[*ix]].id == *id,
            (Block::Passage(task, ix), ResultKey::Passage { .. }) => self
                .found()
                .and_then(|found| found.tasks().get(*task)?.passages().get(*ix))
                .is_some_and(|passage| ResultKey::of_passage(passage) == *key),
            _ => false,
        })
    }

    /// The result the cursor rests on; with none, the first while the
    /// results have focus (Tab into them shows where focus is).
    fn cursor(&self, window: &Window) -> Option<ResultKey> {
        let keys = self.result_keys();
        match &self.cursor {
            Some(cursor) if keys.contains(cursor) => Some(cursor.clone()),
            _ if self.focus.is_focused(window) => keys.into_iter().next(),
            _ => None,
        }
    }

    fn move_cursor(&mut self, forward: bool, window: &Window, cx: &mut Context<Self>) {
        let keys = self.result_keys();
        let Some(last) = keys.len().checked_sub(1) else { return };
        let cursor = self.cursor(window);
        let current = cursor.as_ref().and_then(|cursor| keys.iter().position(|k| k == cursor));
        let target = match (forward, current) {
            (true, None) => 0,
            (true, Some(ix)) => (ix + 1).min(last),
            (false, None) => return,
            (false, Some(ix)) => ix.saturating_sub(1),
        };
        let key = keys[target].clone();
        if let Some(block) = self.block_of(&key, cx) {
            self.scroll.scroll_to_item(block);
        }
        self.cursor = Some(key);
        cx.notify();
    }

    fn select_next(&mut self, _: &SelectNextResult, window: &mut Window, cx: &mut Context<Self>) {
        self.move_cursor(true, window, cx);
    }

    fn select_previous(
        &mut self,
        _: &SelectPreviousResult,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.move_cursor(false, window, cx);
    }

    fn open_cursor(&mut self, _: &OpenResult, window: &mut Window, cx: &mut Context<Self>) {
        let first = self.result_keys().into_iter().next();
        if let Some(key) = self.cursor(window).or(first) {
            self.open(&key, cx);
        }
    }

    /// Asks the window to show the result `key`.
    fn open(&mut self, key: &ResultKey, cx: &mut Context<Self>) {
        self.cursor = Some(key.clone());
        let event = match key {
            ResultKey::Title(id) => SearchPageEvent::OpenTask(id.clone()),
            ResultKey::Passage { session, anchor } => {
                let Some(passage) = self.passage(session, anchor) else { return };
                SearchPageEvent::OpenPassage(passage.target().clone())
            }
        };
        cx.emit(event);
        cx.notify();
    }

    fn passage(&self, session: &str, anchor: &str) -> Option<&Passage> {
        self.found()?.tasks().iter().flat_map(|task| task.passages()).find(|passage| {
            let target = passage.target();
            target.session_id() == session && target.anchor_message_id() == anchor
        })
    }

    fn dismiss(&mut self, _: &DismissSearch, window: &mut Window, cx: &mut Context<Self>) {
        if self.phrase(cx).is_empty() {
            cx.emit(SearchPageEvent::Leave);
            return;
        }
        self.query.update(cx, |query, cx| query.set_value(String::new(), window, cx));
        self.query.update(cx, |query, cx| query.focus(window, cx));
        self.query_changed(false, cx);
    }

    /// The page under the window's chrome: its title, the field and what
    /// it found, in the page column, which scrolls inside the plate.
    pub fn render_page(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let blocks = self.blocks(cx);
        let keyboard = window.last_input_was_keyboard();
        let cursor = self.cursor(window);
        let children: Vec<AnyElement> = blocks
            .iter()
            .map(|block| self.render_block(*block, keyboard, &cursor, window, cx))
            .collect();
        div()
            .id("search-page")
            .test_support()
            .key_context(SEARCH_PAGE_CONTEXT)
            .on_action(cx.listener(Self::select_next))
            .on_action(cx.listener(Self::select_previous))
            .on_action(cx.listener(Self::open_cursor))
            .on_action(cx.listener(Self::dismiss))
            .relative()
            .flex_1()
            .min_h_0()
            .w_full()
            .child(
                v_flex()
                    .id("search-body")
                    .test_support()
                    .size_full()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .text_color(cx.maka().ink)
                    .children(children),
            )
            .child(Scrollbar::vertical(&self.scroll))
            .into_any_element()
    }

    fn render_block(
        &self,
        block: Block,
        keyboard: bool,
        cursor: &Option<ResultKey>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let column =
            || div().w_full().max_w(rems(PAGE_MAX_WIDTH_REMS)).mx_auto().px_6().flex_shrink_0();
        // The Host's results are dimmed while a newer search runs; the
        // title matches are the query's own.
        let stale = self.pending.is_some();
        match block {
            Block::Header => column()
                .child(page_header(copy::SEARCH.get(cx), None, Empty.into_any_element(), cx))
                .into_any_element(),
            Block::Field => column().pt_6().child(self.render_field(cx)).into_any_element(),
            Block::Status => column().pt_2().child(self.render_status(cx)).into_any_element(),
            Block::Results => div()
                .id("search-results")
                .test_support()
                .track_focus(&self.focus)
                .size_0()
                .into_any_element(),
            Block::TitlesLabel => {
                { column().pt_6().pb_1().child(section_label("search-tasks", copy::TASKS, cx)) }
                    .into_any_element()
            }
            Block::Title(ix) => column()
                .child(self.render_title(ix, keyboard, cursor, window, cx))
                .into_any_element(),
            Block::FactsLabel => column()
                .pt_6()
                .pb_1()
                .when(stale, |this| this.opacity(0.5))
                .child(section_label("search-memory", copy::FROM_MEMORY, cx))
                .into_any_element(),
            Block::Facts => column()
                .when(stale, |this| this.opacity(0.5))
                .child(self.render_facts(cx))
                .into_any_element(),
            Block::Task(ix) => column()
                .pt_6()
                .pb_1()
                .when(stale, |this| this.opacity(0.5))
                .child(self.render_task_heading(ix, cx))
                .into_any_element(),
            Block::Passage(task, ix) => column()
                .when(stale, |this| this.opacity(0.5))
                .child(self.render_passage(task, ix, keyboard, cursor, window, cx))
                .into_any_element(),
            Block::Failure => column()
                .pt_6()
                .when(stale, |this| this.opacity(0.5))
                .child(self.render_failure(cx))
                .into_any_element(),
            Block::NoResults => column()
                .pt_6()
                .when(stale, |this| this.opacity(0.5))
                .child(
                    div()
                        .id("search-no-results")
                        .test_support()
                        .role(Role::Status)
                        .aria_label(copy::NO_RESULTS.get(cx))
                        .px_3()
                        .text_sm()
                        .text_color(cx.maka().ink_muted)
                        .child(copy::NO_RESULTS.get(cx)),
                )
                .into_any_element(),
            Block::End => column().pb_12().into_any_element(),
        }
    }

    fn render_field(&self, cx: &App) -> AnyElement {
        let label = copy::SEARCH_ALL_TASKS.get(cx);
        Input::new(&self.query)
            .id("search-query")
            .field_fill(cx)
            .px_3()
            .aria_label(label)
            .prefix(Icon::new(MakaIcon::Search).small())
            .cleanable(true)
            .into_any_element()
    }

    /// The quiet line under the field: the hint while nothing is typed,
    /// "Searching…" while a search waits or runs, else a note when the
    /// Host searched only its most recent tasks.
    fn render_status(&self, cx: &App) -> AnyElement {
        let locale = Locale::current(cx);
        let text: Option<SharedString> = if self.phrase(cx).trim().is_empty() {
            Some(copy::SEARCH_HINT.get(cx).into())
        } else if self.pending.is_some() {
            Some(copy::SEARCHING.get(cx).into())
        } else if self.found().is_some_and(Found::is_scan_capped) {
            let count = MAX_TASKS_SEARCHED.to_string();
            Some(copy::SCAN_CAPPED.fill(locale, &[("count", &count)]).into())
        } else {
            None
        };
        div()
            .id("search-status")
            .test_support()
            .role(Role::Status)
            .when_some(text.clone(), |this, text| this.aria_label(text))
            .min_h(rems(1.25))
            .px_3()
            .text_xs()
            .line_height(rems(1.25))
            .text_color(cx.maka().ink_muted)
            .children(text)
            .into_any_element()
    }

    /// The facets of a task beside its title: its project, Archived, and
    /// the time given, in muted ink.
    fn task_facets(&self, id: &str, at: Option<u64>, cx: &App) -> (Vec<AnyElement>, Vec<String>) {
        let maka = cx.maka();
        let locale = Locale::current(cx);
        let task = self.by_id.get(id).map(|ix| &self.tasks[*ix]);
        let mut facets = Vec::new();
        let mut words = Vec::new();
        if let Some(project) = task.and_then(|task| task.project.clone()) {
            words.push(project.to_string());
            facets.push(
                div()
                    .flex_shrink(1.)
                    .min_w_0()
                    .truncate()
                    .text_xs()
                    .text_color(maka.ink_muted)
                    .child(project)
                    .into_any_element(),
            );
        }
        if task.is_some_and(|task| task.archived) {
            let archived = shell_copy::GROUP_ARCHIVED.get(cx);
            words.push(archived.to_owned());
            facets.push(badge(archived, cx).into_any_element());
        }
        facets.push(div().flex_1().into_any_element());
        if let Some(at) = at {
            let when = relative_time(locale, at, (self.clock)(), local_utc_offset());
            words.push(when.clone());
            facets.push(
                div()
                    .flex_shrink_0()
                    .text_xs()
                    .font_features(tabular_nums())
                    .text_color(maka.ink_muted)
                    .child(when)
                    .into_any_element(),
            );
        }
        (facets, words)
    }

    /// The title a task shows: the window's own when it lists the task,
    /// else the one in the answer.
    fn task_title(&self, id: &str, answered: &str, cx: &App) -> SharedString {
        match self.by_id.get(id) {
            Some(ix) => self.tasks[*ix].title.clone(),
            None => shell_copy::task_title(Locale::current(cx), answered).to_owned().into(),
        }
    }

    fn render_title(
        &self,
        ix: usize,
        keyboard: bool,
        cursor: &Option<ResultKey>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let task = &self.tasks[self.titles[ix]];
        let key = ResultKey::Title(task.id.clone());
        let at = (task.activity_at > 0).then_some(task.activity_at);
        let (facets, words) = self.task_facets(&task.id, at, cx);
        let mut label = vec![task.title.to_string()];
        label.extend(words);
        let parts: Vec<&str> = label.iter().map(String::as_str).collect();
        let label = shell_copy::parts(Locale::current(cx), &parts);
        let mark = RowMark::of(&key, cursor, keyboard);
        self.result_row(title_element_id(&task.id), key, label, mark, window, cx)
            .flex()
            .flex_row()
            .items_center()
            .gap_2()
            .py_1p5()
            .child(
                Icon::new(AssetIcon::MessageSquare)
                    .size_4()
                    .flex_shrink_0()
                    .text_color(cx.maka().ink_muted),
            )
            .child(div().flex_shrink(1.).min_w_0().truncate().text_sm().child(task.title.clone()))
            .children(facets)
            .into_any_element()
    }

    /// A result's row: its identity, role and name, the cursor's ring
    /// while the keyboard moves it, and a press that opens it.
    fn result_row(
        &self,
        id: ElementId,
        key: ResultKey,
        label: String,
        mark: RowMark,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl gpui_kit::Styled + gpui_kit::ParentElement + IntoElement + use<> {
        let focus = self.focus.clone();
        div()
            .id(id)
            .test_support()
            .role(Role::ListItem)
            .aria_label(label)
            .aria_selected(mark.cursor)
            .w_full()
            .px_3()
            .rounded(RADIUS_SURFACE)
            .map(|this| selectable_row(this, mark.cursor, cx))
            .when(mark.ring, |this| this.focus_ring_style(window, cx))
            .on_mouse_down(MouseButton::Left, move |_: &MouseDownEvent, window, cx| {
                // The results' one Tab stop takes focus, not the row.
                window.prevent_default();
                focus.focus(window, cx);
            })
            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.open(&key, cx)))
    }

    fn render_facts(&self, cx: &App) -> AnyElement {
        let facts = self.found().map(Found::facts).unwrap_or_default();
        v_flex()
            .id("search-facts")
            .test_support()
            .role(Role::List)
            .px_3()
            .gap_1()
            .children(facts.iter().enumerate().map(|(ix, fact)| {
                div()
                    .id(("search-fact", ix))
                    .test_support()
                    .role(Role::ListItem)
                    .aria_label(fact.text().clone())
                    .text_sm()
                    .line_clamp(NEIGHBOUR_LINES)
                    .text_ellipsis()
                    .child(marked_text(fact, cx))
            }))
            .into_any_element()
    }

    fn render_task_heading(&self, ix: usize, cx: &App) -> AnyElement {
        let Some(task) = self.found().and_then(|found| found.tasks().get(ix)) else {
            return Empty.into_any_element();
        };
        let title = self.task_title(task.session_id(), task.session_title(), cx);
        let (facets, words) = self.task_facets(task.session_id(), task.last_message_at(), cx);
        let mut label = vec![title.to_string()];
        label.extend(words);
        let parts: Vec<&str> = label.iter().map(String::as_str).collect();
        h_flex()
            .id(domain_element_id("search-task", task.session_id()))
            .test_support()
            .role(Role::Heading)
            .aria_label(shell_copy::parts(Locale::current(cx), &parts))
            .w_full()
            .px_3()
            .gap_2()
            .child(
                div().flex_shrink(1.).min_w_0().truncate().text_sm().font_semibold().child(title),
            )
            .children(facets)
            .into_any_element()
    }

    fn render_passage(
        &self,
        task: usize,
        ix: usize,
        keyboard: bool,
        cursor: &Option<ResultKey>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(passage) =
            self.found().and_then(|found| found.tasks().get(task)?.passages().get(ix))
        else {
            return Empty.into_any_element();
        };
        let maka = cx.maka();
        let locale = Locale::current(cx);
        let target = passage.target();
        let label = passage.anchor().map_or_else(String::new, |anchor| {
            shell_copy::labeled(
                locale,
                role_word(anchor.role()).in_locale(locale),
                anchor.excerpt().text(),
            )
        });
        let more = || {
            h_flex()
                .gap_3()
                .child(div().w(rems(ROLE_LANE_REMS)).flex_shrink_0())
                .child(div().text_sm().text_color(maka.ink_muted).child("…"))
        };
        let messages: Vec<AnyElement> = passage
            .messages()
            .iter()
            .map(|message| {
                let anchor = message.is_anchor();
                let role = role_word(message.role()).in_locale(locale);
                h_flex()
                    .items_start()
                    .gap_3()
                    .child(
                        div()
                            .w(rems(ROLE_LANE_REMS))
                            .flex_shrink_0()
                            .text_xs()
                            .line_height(rems(1.25))
                            .text_color(maka.ink_muted)
                            .child(role),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_sm()
                            .line_height(rems(1.25))
                            .text_color(if anchor { maka.ink } else { maka.ink_muted })
                            .line_clamp(if anchor { ANCHOR_LINES } else { NEIGHBOUR_LINES })
                            .text_ellipsis()
                            .child(marked_text(message.excerpt(), cx)),
                    )
                    .into_any_element()
            })
            .collect();
        let key = ResultKey::of_passage(passage);
        let mark = RowMark::of(&key, cursor, keyboard);
        let row = self.result_row(
            passage_element_id(target.session_id(), target.anchor_message_id()),
            key,
            label,
            mark,
            window,
            cx,
        );
        row.flex()
            .flex_col()
            .py_2()
            .gap_1()
            .when(passage.has_more_before(), |this| this.child(more()))
            .children(messages)
            .when(passage.has_more_after(), |this| this.child(more()))
            .when(passage.is_truncated(), |this| {
                this.child(
                    h_flex().gap_3().child(div().w(rems(ROLE_LANE_REMS)).flex_shrink_0()).child(
                        div()
                            .id(("search-shortened", ix))
                            .test_support()
                            .text_xs()
                            .text_color(maka.ink_muted)
                            .child(copy::SHORTENED.get(cx)),
                    ),
                )
            })
            .into_any_element()
    }

    fn render_failure(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(failure) = self.failure() else { return Empty.into_any_element() };
        let (text, again) = failure_line(failure);
        let text = text.get(cx);
        h_flex()
            .id("search-failure")
            .test_support()
            .role(Role::Status)
            .aria_label(text)
            .px_3()
            .gap_3()
            .items_center()
            .child(div().flex_1().min_w_0().text_sm().text_color(cx.maka().ink_muted).child(text))
            .when(again, |this| {
                this.child(
                    quiet_button(Button::new("search-again"), cx)
                        .label(copy::SEARCH_AGAIN.get(cx))
                        .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.search_again(cx))),
                )
            })
            .into_any_element()
    }
}

/// A section's label over its rows: the task list's group heading style.
fn section_label(id: &'static str, text: Text, cx: &App) -> AnyElement {
    let text = text.get(cx);
    div()
        .id(id)
        .test_support()
        .role(Role::Heading)
        .aria_label(text)
        .px_3()
        .text_size(group_label_size(Locale::current(cx)))
        .font_medium()
        .text_color(cx.maka().ink_muted)
        .child(text)
        .into_any_element()
}

/// `excerpt`'s text with its terms on the find bar's match fill.
fn marked_text(excerpt: &Excerpt, cx: &App) -> StyledText {
    let fill = cx.maka().find_match;
    let highlights = excerpt.marks().iter().map(move |range| {
        (range.clone(), HighlightStyle { background_color: Some(fill), ..Default::default() })
    });
    StyledText::new(excerpt.text().clone()).with_highlights(highlights)
}

/// The word for who wrote a message, as the transcript's words go.
fn role_word(role: &RecallRole) -> Text {
    match role {
        RecallRole::User => copy::ROLE_YOU,
        RecallRole::Assistant => copy::ROLE_MAKA,
        _ => copy::ROLE_TOOL,
    }
}

/// What a failure says, and whether searching again can mend it.
fn failure_line(failure: &SearchFailure) -> (Text, bool) {
    match failure {
        SearchFailure::Refused(RecallFailureReason::IncognitoActive) => {
            (copy::FAILED_INCOGNITO, false)
        }
        SearchFailure::Refused(RecallFailureReason::InvalidQuery) | SearchFailure::Invalid => {
            (copy::FAILED_INVALID, false)
        }
        SearchFailure::Refused(RecallFailureReason::NotFound) => (copy::FAILED_NOT_FOUND, true),
        SearchFailure::Refused(RecallFailureReason::Aborted) => (copy::FAILED_ABORTED, true),
        SearchFailure::Refused(_) => (copy::FAILED_UNKNOWN, true),
        SearchFailure::NotConnected => (copy::FAILED_NOT_CONNECTED, true),
        SearchFailure::Unreachable => (copy::FAILED_UNREACHABLE, true),
    }
}

/// The page on its own, as previews and tests draw it; the shell puts it
/// on the plate under the window's chrome.
impl gpui_kit::Render for SearchView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let page = self.render_page(window, cx);
        v_flex().id("search").test_support().size_full().child(page)
    }
}

impl gpui_kit::Focusable for SearchView {
    /// The results' Tab stop.
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

#[cfg(test)]
#[path = "page_tests.rs"]
mod tests;
