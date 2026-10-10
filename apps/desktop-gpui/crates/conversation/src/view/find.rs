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

//! Find in the conversation (⌘F): the transcript as a [`Searchable`] item
//! and the find bar over it.
//!
//! Matches come from the transcript model ([`crate::corpus`]), for every
//! held row whether the list lays it out or not, computed off the main
//! thread and kept per item until the item changes. The view paints them
//! where they show: in a reply through its text view's range highlights
//! ([`TextViews::paint_marks`]), in plain text (a user message, a
//! reasoning, a Tool call's name, summary and output) as styled runs
//! ([`RowFind::text`]). Activating a match opens the row it is in when
//! that row is collapsed, scrolls the list to the row when it is not on
//! screen, and reveals the match inside it once the row is laid out.
//!
//! While the bar shows, the conversation reads the rest of the session's
//! history in the background ([`ConversationState::set_find_history_wanted`]),
//! through the same older pages scrolling up reads, which keep the
//! viewport where it is; each page's matches join as it lands.

use std::collections::HashMap;
use std::ops::Range;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui_kit::{
    AnyElement, App, AppContext as _, Bounds, Context, Entity, EventEmitter, FocusHandle,
    HighlightStyle, Hsla, IntoElement, ParentElement as _, ScrollHandle, SharedString, Styled as _,
    StyledText, Subscription, Task, WeakEntity, Window, canvas, point, px, size,
};
use search::{FindBar, FindBarEvent, SearchEvent, SearchQuery, Searchable};
use shared::copy::{Locale, search as copy};
use shared::theme::ActiveMakaPalette as _;
use transcript_model::{Change, Transcript};

use super::ConversationView;
use super::text_views::{Reveal, RevealSlot};
use crate::corpus::{self, Entry, Field, ItemSource, ItemText, TranscriptMatch};
use crate::rows::{RowBody, RowKey};

/// How long a requested reveal waits for its row to be laid out.
const REVEAL_WAIT: Duration = Duration::from_secs(1);

/// One match a row paints.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Mark {
    pub(crate) field: Field,
    pub(crate) range: Range<usize>,
    pub(crate) active: bool,
}

/// The matches the rows paint, by row, and a revision that changes with
/// every new set.
#[derive(Debug, Default)]
pub(crate) struct Marks {
    revision: u64,
    by_row: HashMap<RowKey, Rc<[Mark]>>,
}

impl Marks {
    pub(crate) fn revision(&self) -> u64 {
        self.revision
    }

    pub(crate) fn of(&self, key: &RowKey) -> Option<Rc<[Mark]>> {
        self.by_row.get(key).cloned()
    }

    fn replace(&mut self, by_row: HashMap<RowKey, Rc<[Mark]>>) {
        self.revision += 1;
        self.by_row = by_row;
    }
}

/// The searchable text of the items a search has read, kept until each
/// item changes, for the transcript and the language it was read in.
#[derive(Debug, Default)]
pub(crate) struct FindIndex {
    /// The subscription of the transcript the text is of.
    transcript: Option<String>,
    locale: Option<Locale>,
    /// Bumped when everything is dropped: a search started before that
    /// keeps nothing.
    generation: u64,
    /// Bumped by every change: a search keeps the text of an item only if
    /// the item has not changed since the search started.
    epoch: u64,
    changed_items: HashMap<RowKey, u64>,
    changed_turns: HashMap<String, u64>,
    items: HashMap<RowKey, (Arc<RowKey>, Arc<ItemText>)>,
}

/// When a search read the index.
#[derive(Debug, Clone, Copy)]
struct Stamp {
    generation: u64,
    epoch: u64,
}

impl FindIndex {
    /// Drops everything kept.
    fn clear(&mut self) {
        self.generation += 1;
        self.transcript = None;
        self.locale = None;
        self.changed_items.clear();
        self.changed_turns.clear();
        self.items.clear();
    }

    /// Starts over unless what is kept is of `transcript` in `locale`.
    fn follow(&mut self, transcript: &str, locale: Locale) {
        if self.transcript.as_deref() != Some(transcript) || self.locale != Some(locale) {
            self.clear();
            self.transcript = Some(transcript.to_owned());
            self.locale = Some(locale);
        }
    }

    /// Forgets the text of the items `changes` touched. Whether any change
    /// touched the searchable content.
    fn note(&mut self, changes: &[Change]) -> bool {
        let mut touched = false;
        for change in changes {
            match change {
                Change::ItemTextAppended { turn_id, key }
                | Change::ItemUpdated { turn_id, key }
                | Change::ItemRemoved { turn_id, key } => {
                    self.epoch += 1;
                    let row = RowKey::Item { turn_id: turn_id.clone(), key: key.clone() };
                    self.items.remove(&row);
                    self.changed_items.insert(row, self.epoch);
                    touched = true;
                }
                Change::TurnRemoved { turn_id } => {
                    self.epoch += 1;
                    self.items.retain(|row, _| !row.is_of_turn(turn_id));
                    self.changed_turns.insert(turn_id.clone(), self.epoch);
                    touched = true;
                }
                // New rows hold no kept text; their turn's status can hide
                // or show a Tool row.
                Change::TurnAdded { .. }
                | Change::ItemAdded { .. }
                | Change::ItemsReordered { .. }
                | Change::TurnUpdated { .. }
                | Change::TurnFinished { .. } => touched = true,
                _ => {}
            }
        }
        touched
    }

    fn stamp(&self) -> Stamp {
        Stamp { generation: self.generation, epoch: self.epoch }
    }

    /// Every held item a find searches, in transcript order: its kept
    /// text, or what to extract it from.
    fn entries(&self, transcript: &Transcript, locale: Locale) -> Vec<Entry> {
        let mut entries = Vec::new();
        for turn in transcript.turns() {
            for item in &turn.items {
                let key = RowKey::Item { turn_id: turn.turn_id.clone(), key: item.key() };
                // Checked every time: a turn's status hides some Tool rows.
                let Some(source) = ItemSource::of(turn, item, locale) else { continue };
                entries.push(match self.items.get(&key) {
                    Some((row, text)) => Entry::Ready(row.clone(), text.clone()),
                    None => Entry::Pending(Arc::new(key), source),
                });
            }
        }
        entries
    }

    /// Keeps what a search that read the index at `stamp` extracted, for
    /// the items that have not changed since.
    fn store(&mut self, stamp: Stamp, extracted: Vec<(Arc<RowKey>, Arc<ItemText>)>) {
        if stamp.generation != self.generation {
            return;
        }
        for (row, text) in extracted {
            let changed = self.changed_items.get(&row).is_some_and(|epoch| *epoch > stamp.epoch)
                || row
                    .turn_id()
                    .and_then(|turn| self.changed_turns.get(turn))
                    .is_some_and(|epoch| *epoch > stamp.epoch);
            if !changed {
                self.items.insert((*row).clone(), (row, text));
            }
        }
    }

    /// How many items have their text kept.
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.items.len()
    }
}

/// The find bar of the conversation and what it found.
#[derive(Default)]
pub(crate) struct Find {
    bar: Option<Entity<FindBar<ConversationView>>>,
    open: bool,
    /// Where focus was when the bar opened; it goes back there on close.
    restore: Option<FocusHandle>,
    pub(crate) index: FindIndex,
    pub(crate) marks: Marks,
    pub(crate) reveal: RevealSlot,
    /// The row the next new query's active match is in, when it has one:
    /// the message a task was opened at. Taken by that query.
    prefer: Option<RowKey>,
    _bar_events: Option<Subscription>,
}

impl std::fmt::Debug for Find {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Find").field("open", &self.open).finish_non_exhaustive()
    }
}

impl EventEmitter<SearchEvent> for ConversationView {}

impl ConversationView {
    /// Shows the find bar and focuses its query, its text selected; while
    /// it shows, the rest of the session's history is read. Shown already,
    /// it only focuses the query. Without a transcript on screen there is
    /// nothing to find and nothing happens.
    pub fn open_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(bar) = self.show_find_bar(window, cx) else { return };
        bar.update(cx, |bar, cx| bar.focus_query(window, cx));
        cx.notify();
    }

    /// Shows the find bar with `query`, focused, and searches it; the match
    /// it moves to is the first in `row` when `row` has one ([`Find::prefer`]).
    /// Escape then gives focus to the transcript. Nothing happens without a
    /// transcript on screen.
    pub(crate) fn open_find_with(
        &mut self,
        query: SharedString,
        row: Option<RowKey>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let opened = !self.find.open;
        let Some(bar) = self.show_find_bar(window, cx) else { return };
        if opened {
            self.find.restore = None;
        }
        self.find.prefer = row;
        bar.update(cx, |bar, cx| bar.search_for(query, window, cx));
        cx.notify();
    }

    /// The find bar, made the first time and shown, the rest of the history
    /// read while it shows; `None` without rows to find in.
    fn show_find_bar(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Entity<FindBar<ConversationView>>> {
        if !self.has_rows() {
            return None;
        }
        let bar = match &self.find.bar {
            Some(bar) => bar.clone(),
            None => {
                let view = cx.entity();
                let label = copy::FIND_IN_CONVERSATION.get(cx);
                let bar = cx.new(|cx| FindBar::new(&view, label, window, cx));
                self.find._bar_events = Some(cx.subscribe_in(
                    &bar,
                    window,
                    |this, _, event: &FindBarEvent, window, cx| {
                        if *event == FindBarEvent::Dismissed {
                            this.close_find(true, window, cx);
                        }
                    },
                ));
                self.find.bar = Some(bar.clone());
                bar
            }
        };
        if !self.find.open {
            self.find.open = true;
            self.find.restore = window.focused(cx);
            self.state.update(cx, |state, cx| state.set_find_history_wanted(true, cx));
        }
        Some(bar)
    }

    /// Whether the view shows a transcript: rows to find in.
    pub fn has_rows(&self) -> bool {
        !self.rows.is_empty()
    }

    /// Whether the find bar shows.
    pub fn is_find_open(&self) -> bool {
        self.find.open
    }

    /// The find bar, once it has been shown.
    pub fn find_bar(&self) -> Option<&Entity<FindBar<ConversationView>>> {
        self.find.bar.as_ref()
    }

    /// Hides the bar: stops reading history for it (dropping the page in
    /// flight unless something else wants it), clears its matches and
    /// forgets the text it searched; with `restore_focus`, focus goes back
    /// to where it was when the bar opened, else to the transcript.
    pub(crate) fn close_find(
        &mut self,
        restore_focus: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.find.open {
            return;
        }
        self.find.open = false;
        self.end_find(cx);
        let restore = self.find.restore.take();
        if restore_focus {
            let target = restore.unwrap_or_else(|| self.focus.clone());
            target.focus(window, cx);
        }
        cx.notify();
    }

    /// What closing the bar leaves behind, with or without a window: the
    /// session moving on closes it too.
    fn end_find(&mut self, cx: &mut Context<Self>) {
        self.state.update(cx, |state, cx| state.set_find_history_wanted(false, cx));
        if let Some(bar) = &self.find.bar {
            bar.update(cx, |bar, cx| bar.reset(cx));
        }
        self.find.marks.replace(HashMap::new());
        self.find.reveal.clear();
        self.find.index.clear();
        self.find.prefer = None;
    }

    /// Acts on what the transcript reported for the find: a new session
    /// closes the bar; a change of any searchable row asks the bar to
    /// search again.
    pub(super) fn note_find_changes(
        &mut self,
        session_changed: bool,
        changes: &[Change],
        cx: &mut Context<Self>,
    ) {
        if session_changed {
            if self.find.open {
                self.find.open = false;
                self.find.restore = None;
                self.end_find(cx);
            }
            return;
        }
        let touched = self.find.index.note(changes);
        if !self.find.open {
            return;
        }
        let transcript = self.state.read(cx).transcript().map(|t| t.subscription_id().to_owned());
        // A reopened subscription is a new transcript: nothing kept holds.
        let replaced = transcript.is_some() && self.find.index.transcript != transcript;
        if touched || replaced {
            cx.emit(SearchEvent::MatchesInvalidated);
        }
    }

    /// The language changed: the text a Tool's card shows may read
    /// differently.
    pub(super) fn note_find_locale(&mut self, cx: &mut Context<Self>) {
        if self.find.open {
            cx.emit(SearchEvent::MatchesInvalidated);
        }
    }

    /// ⌘G: the next match, while the bar shows; else the key goes on.
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

    /// ⇧⌘G: the previous match, while the bar shows; else the key goes on.
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

    /// Moves to the next or previous match while the bar shows: whether it
    /// does.
    pub fn step_find(
        &mut self,
        forward: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(bar) = self.find.bar.clone().filter(|_| self.find.open) else {
            return false;
        };
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

    /// Escape in the transcript closes the bar while it shows.
    pub(super) fn dismiss_find(
        &mut self,
        _: &search::Dismiss,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(bar) = self.find.bar.clone().filter(|_| self.find.open) else {
            cx.propagate();
            return;
        };
        window.defer(cx, move |window, cx| bar.update(cx, |bar, cx| bar.dismiss(window, cx)));
    }

    /// The bar, placed: floating at the top right of the transcript, under
    /// the plate's header, about 360 pt wide and narrower in a narrow
    /// window. It covers the transcript, never moves it.
    pub(super) fn render_find_bar(&self) -> Option<AnyElement> {
        let bar = self.find.bar.clone().filter(|_| self.find.open)?;
        Some(
            gpui_kit::div()
                .absolute()
                .top_2()
                .left_3()
                .right_3()
                .flex()
                .justify_end()
                .child(gpui_kit::div().w(gpui_kit::rems(FIND_BAR_WIDTH_REMS)).min_w_0().child(bar))
                .into_any_element(),
        )
    }

    /// Opens the row of `found` when it hides the match: a collapsed
    /// reasoning, or a Tool card whose output holds it.
    fn open_row_of(&mut self, found: &TranscriptMatch, cx: &mut Context<Self>) {
        let expansion_key =
            self.rows.iter().find(|row| row.key == *found.row).and_then(|row| {
                match (&row.body, found.field) {
                    (RowBody::Thinking(thinking), Field::Body) if !thinking.expanded => {
                        Some(thinking.expansion_key.clone())
                    }
                    (RowBody::Tool(tool), Field::ToolDetail) if !tool.expanded => {
                        Some(tool.expansion_key.clone())
                    }
                    _ => None,
                }
            });
        if let Some(expansion_key) = expansion_key {
            self.options.expanded.insert(expansion_key.clone());
            self.detail_scrolls.insert(expansion_key, ScrollHandle::new());
            self.sync_rows(false, cx);
        }
    }
}

/// The bar's width: about 360 pt at the default zoom.
const FIND_BAR_WIDTH_REMS: f32 = 22.5;

/// How far into a one-line text its active match may start and still show
/// from the line's start: the summary lane holds about 40 characters in a
/// narrow window.
const LINE_LEAD_CHARS: usize = 24;

/// How many characters before the active match a shifted line keeps.
const LINE_KEEP_CHARS: usize = 8;

/// Where a one-line text cut at its width shows from so that a match at
/// `range` is on screen: its start when the match starts within the first
/// [`LINE_LEAD_CHARS`] characters, else [`LINE_KEEP_CHARS`] characters
/// before the match.
fn line_start(text: &str, range: &Range<usize>) -> usize {
    if range.end > text.len() || !text.is_char_boundary(range.start) {
        return 0;
    }
    let before: Vec<usize> = text[..range.start].char_indices().map(|(at, _)| at).collect();
    if before.len() > LINE_LEAD_CHARS { before[before.len() - LINE_KEEP_CHARS] } else { 0 }
}

impl Searchable for ConversationView {
    type Match = TranscriptMatch;

    fn find_matches(
        &mut self,
        query: SearchQuery,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) -> Task<Vec<TranscriptMatch>> {
        let locale = Locale::current(cx);
        let (entries, stamp) = {
            let state = self.state.read(cx);
            let Some(transcript) = state.transcript() else {
                return Task::ready(Vec::new());
            };
            self.find.index.follow(transcript.subscription_id(), locale);
            (self.find.index.entries(transcript, locale), self.find.index.stamp())
        };
        let search = cx.background_spawn(async move { corpus::search(entries, &query) });
        cx.spawn(async move |this, cx| {
            let found = search.await;
            this.update(cx, |this, _| this.find.index.store(stamp, found.extracted)).ok();
            found.matches
        })
    }

    fn update_matches(
        &mut self,
        matches: &[TranscriptMatch],
        active: Option<usize>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let mut by_row: HashMap<RowKey, Vec<Mark>> = HashMap::new();
        for (ix, found) in matches.iter().enumerate() {
            by_row.entry((*found.row).clone()).or_default().push(Mark {
                field: found.field,
                range: found.range.clone(),
                active: active == Some(ix),
            });
        }
        self.find
            .marks
            .replace(by_row.into_iter().map(|(row, marks)| (row, marks.into())).collect());
        cx.notify();
    }

    fn clear_matches(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        self.find.marks.replace(HashMap::new());
        self.find.reveal.clear();
        cx.notify();
    }

    fn activate_match(
        &mut self,
        ix: usize,
        matches: &[TranscriptMatch],
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(found) = matches.get(ix) else { return };
        self.open_row_of(found, cx);
        let Some(row_ix) = self.rows.iter().position(|row| row.key == *found.row) else { return };
        // The list scrolls to a row only by putting it at the top, which
        // also stops it following new output. A row on screen keeps what
        // shows (the top row is scrolled there and anchored where it was),
        // so only the reveal moves the list, and only as far as it must.
        let hold = self
            .paging
            .is_painted(&found.row)
            .then(|| self.paging.top_anchor(|key| *key == RowKey::History))
            .flatten()
            .and_then(|anchor| {
                let ix = self.rows.iter().position(|row| row.key == anchor.key)?;
                Some((anchor, ix))
            });
        let scroll_to = match hold {
            Some((anchor, ix)) => {
                self.paging.request(anchor);
                ix
            }
            None => {
                self.paging.cancel();
                row_ix
            }
        };
        self.scroller.update(cx, |scroller, cx| {
            scroller.scroll_to_item(scroll_to, cx);
        });
        self.find.reveal.set(Reveal {
            row: (*found.row).clone(),
            field: found.field,
            range: found.range.clone(),
            until: cx.background_executor().now() + REVEAL_WAIT,
        });
        cx.notify();
    }

    /// The first match at or below the top of what the transcript shows,
    /// else the last one above it: the one nearest the reader. For the
    /// query a task was opened at a passage with, the first match in the
    /// passage's message, or none when it has none, so the view stays on
    /// that message.
    fn active_match_index(
        &mut self,
        matches: &[TranscriptMatch],
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        if let Some(row) = self.find.prefer.take() {
            return matches.iter().position(|found| *found.row == row);
        }
        if matches.is_empty() {
            return None;
        }
        let positions: HashMap<&RowKey, usize> =
            self.rows.iter().enumerate().map(|(ix, row)| (&row.key, ix)).collect();
        let top =
            self.paging.top_painted_row().and_then(|key| positions.get(&key).copied()).unwrap_or(0);
        let at_or_below = matches
            .iter()
            .position(|found| positions.get(&*found.row).is_some_and(|position| *position >= top));
        at_or_below.or(Some(matches.len() - 1))
    }

    fn progress_note(&self, cx: &App) -> Option<SharedString> {
        (self.find.open && self.state.read(cx).is_history_pending())
            .then(|| copy::READING_EARLIER_MESSAGES.get(cx).into())
    }
}

/// What a row needs to paint its matches and reveal one.
pub(crate) struct RowFind {
    pub(crate) key: RowKey,
    pub(crate) marks: Option<Rc<[Mark]>>,
    pub(crate) reveal: RevealSlot,
    /// The match fill and the active match's.
    pub(crate) fills: (Hsla, Hsla),
    pub(crate) now: Instant,
    pub(crate) view: WeakEntity<ConversationView>,
}

impl RowFind {
    pub(crate) fn new(
        key: RowKey,
        view: &WeakEntity<ConversationView>,
        marks: Option<Rc<[Mark]>>,
        reveal: RevealSlot,
        cx: &App,
    ) -> Self {
        let maka = cx.maka();
        Self {
            key,
            marks,
            reveal,
            fills: (maka.find_match, maka.find_match_active),
            now: cx.background_executor().now(),
            view: view.clone(),
        }
    }

    /// `text`, the plain text of `field`, with its matches painted behind
    /// it as styled runs (the text itself when it has none), and, while a
    /// reveal waits in it, a probe to place after it in the same parent:
    /// once laid out, it scrolls `scroll` (the block the text scrolls in,
    /// if any) and then the transcript to the match's line.
    pub(crate) fn text(
        &self,
        field: Field,
        text: SharedString,
        scroll: Option<ScrollHandle>,
    ) -> (AnyElement, Option<AnyElement>) {
        self.text_from(field, text, 0, scroll)
    }

    /// [`Self::text`] for one line its row cuts at its width (a Tool
    /// call's summary): while the active match lies past the first
    /// [`LINE_LEAD_CHARS`] characters, the line shows from a few characters
    /// before it, after an ellipsis, so the match is on screen.
    pub(crate) fn line(
        &self,
        field: Field,
        text: SharedString,
    ) -> (AnyElement, Option<AnyElement>) {
        let active = self
            .marks
            .iter()
            .flat_map(|marks| marks.iter())
            .find(|mark| mark.active && mark.field == field);
        let from = active.map_or(0, |mark| line_start(&text, &mark.range));
        self.text_from(field, text, from, None)
    }

    /// `text` from byte `from` on (after an ellipsis when `from` is not 0),
    /// its matches and reveal placed in what shows.
    fn text_from(
        &self,
        field: Field,
        text: SharedString,
        from: usize,
        scroll: Option<ScrollHandle>,
    ) -> (AnyElement, Option<AnyElement>) {
        let full = text.len();
        let (text, lead) = if from == 0 {
            (text, 0)
        } else {
            (SharedString::from(format!("\u{2026}{}", &text[from..])), '\u{2026}'.len_utf8())
        };
        // A range of the whole text, in what shows; `None` for one before it.
        let shown = move |range: &Range<usize>| {
            (range.start >= from && range.end <= full)
                .then(|| range.start - from + lead..range.end - from + lead)
        };
        let highlights: Vec<(Range<usize>, HighlightStyle)> = self
            .marks
            .iter()
            .flat_map(|marks| marks.iter())
            .filter(|mark| mark.field == field)
            .filter_map(|mark| Some((mark, shown(&mark.range)?)))
            .filter(|(_, range)| {
                text.is_char_boundary(range.start) && text.is_char_boundary(range.end)
            })
            .map(|(mark, range)| {
                let fill = if mark.active { self.fills.1 } else { self.fills.0 };
                (range, HighlightStyle { background_color: Some(fill), ..Default::default() })
            })
            .collect();
        let reveal = self
            .reveal
            .pending(&self.key, field, self.now)
            .and_then(|range| Some((shown(&range)?, range)));
        if highlights.is_empty() && reveal.is_none() {
            return (text.into_any_element(), None);
        }
        let styled = StyledText::new(text).with_highlights(highlights);
        let probe = reveal.map(|(at, range)| {
            let layout = styled.layout().clone();
            let (slot, key, view) = (self.reveal.clone(), self.key.clone(), self.view.clone());
            canvas(
                move |_, window, cx| {
                    let now = cx.background_executor().now();
                    if slot.pending(&key, field, now).as_ref() != Some(&range) {
                        return;
                    }
                    let Some(position) = layout.position_for_index(at.start) else { return };
                    let line = layout.line_height();
                    let mut top = position.y;
                    if let Some(scroll) = &scroll {
                        let bounds = scroll.bounds();
                        let offset = scroll.offset();
                        let mut y = offset.y;
                        if top < bounds.top() + line {
                            y += bounds.top() + line - top;
                        } else if top + line * 2. > bounds.bottom() {
                            y -= top + line * 2. - bounds.bottom();
                        }
                        y = y.min(px(0.)).max(-scroll.max_offset().y);
                        if y != offset.y {
                            scroll.set_offset(point(offset.x, y));
                            top += y - offset.y;
                            // The block moves on the next frame.
                            let view = view.clone();
                            cx.defer(move |cx| {
                                view.update(cx, |_, cx| cx.notify()).ok();
                            });
                        }
                    }
                    window.request_autoscroll(Bounds::new(
                        point(position.x, top),
                        size(px(1.), line),
                    ));
                    slot.clear();
                },
                |_, _, _, _| {},
            )
            .absolute()
            .size_0()
            .into_any_element()
        });
        (styled.into_any_element(), probe)
    }
}

#[cfg(test)]
mod line_tests {
    use super::line_start;

    #[test]
    fn a_line_shows_from_a_little_before_a_match_past_its_lead() {
        let text =
            "python3 /Users/me/.agents/skills/mx/scripts/mx.py data \"营收、归母净利润、毛利";
        let at = text.find("毛利").expect("the match");
        let from = line_start(text, &(at..at + "毛利".len()));
        assert_eq!(&text[from..], "收、归母净利润、毛利", "eight characters before the match");
        assert_eq!(line_start("cat notes.txt", &(4..13)), 0, "a match near the start stays put");
        assert_eq!(line_start("short", &(4..99)), 0, "a range off the text changes nothing");
    }
}
