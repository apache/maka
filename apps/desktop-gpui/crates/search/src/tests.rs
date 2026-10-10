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

//! The find bar over a stand-in item: a text whose matches are byte
//! ranges, searched on the background executor, recording what the bar
//! asked it to paint and to bring into view.

use std::ops::Range;

use gpui_kit::component::Root;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    AppContext as _, Context, Entity, EventEmitter, IntoElement, ParentElement as _, Render,
    SharedString, Styled as _, Task, TestAppContext, Window, WindowHandle, div, px, size,
};

use crate::matching::find_ranges;
use crate::{FindBar, FindBarEvent, REFRESH_DELAY, SearchEvent, SearchQuery, Searchable};

/// The stand-in item: its text, and what the bar did to it.
struct Text {
    text: String,
    /// What was painted, and which of it was active.
    painted: Vec<Range<usize>>,
    painted_active: Option<usize>,
    /// The matches brought into view, by their range.
    activated: Vec<Range<usize>>,
    searches: usize,
    /// Where its own position points: the first match at or after it.
    position: usize,
    /// While set, a search waits for the test to release it.
    hold: Option<async_channel::Receiver<()>>,
}

impl EventEmitter<SearchEvent> for Text {}

impl Text {
    fn new(text: &str) -> Self {
        Self {
            text: text.to_owned(),
            painted: Vec::new(),
            painted_active: None,
            activated: Vec::new(),
            searches: 0,
            position: 0,
            hold: None,
        }
    }

    /// Replaces the text, as a live item does, and says so.
    fn set_text(&mut self, text: &str, cx: &mut Context<Self>) {
        self.text = text.to_owned();
        cx.emit(SearchEvent::MatchesInvalidated);
        cx.notify();
    }
}

impl Searchable for Text {
    type Match = Range<usize>;

    fn find_matches(
        &mut self,
        query: SearchQuery,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) -> Task<Vec<Range<usize>>> {
        self.searches += 1;
        let text = self.text.clone();
        let hold = self.hold.take();
        cx.background_spawn(async move {
            if let Some(hold) = hold {
                hold.recv().await.ok();
            }
            find_ranges(&text, &query)
        })
    }

    fn update_matches(
        &mut self,
        matches: &[Range<usize>],
        active: Option<usize>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.painted = matches.to_vec();
        self.painted_active = active;
        cx.notify();
    }

    fn clear_matches(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        self.painted.clear();
        self.painted_active = None;
        cx.notify();
    }

    fn activate_match(
        &mut self,
        ix: usize,
        matches: &[Range<usize>],
        _: &mut Window,
        _: &mut Context<Self>,
    ) {
        self.activated.push(matches[ix].clone());
    }

    fn active_match_index(
        &mut self,
        matches: &[Range<usize>],
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        let at = matches.iter().position(|range| range.start >= self.position);
        at.or_else(|| matches.len().checked_sub(1))
    }

    fn progress_note(&self, _: &gpui_kit::App) -> Option<SharedString> {
        self.text.ends_with('…').then(|| "Reading more…".into())
    }
}

/// The bar in a window, as an owner places it.
struct Owner {
    bar: Entity<FindBar<Text>>,
    dismissed: usize,
    _subscription: gpui_kit::Subscription,
}

impl Render for Owner {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(div().w(px(360.)).child(self.bar.clone()))
    }
}

struct Harness {
    item: Entity<Text>,
    bar: Entity<FindBar<Text>>,
    owner: Entity<Owner>,
    window: WindowHandle<Root>,
}

impl Harness {
    fn open(text: &str, cx: &mut TestAppContext) -> Self {
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::init(cx);
        });
        let item = cx.new(|_| Text::new(text));
        let (mut bar, mut owner) = (None, None);
        let window = cx.open_window(size(px(600.), px(200.)), |window, cx| {
            let find = cx.new(|cx| FindBar::new(&item, "Find in text", window, cx));
            let view = cx.new(|cx| {
                let subscription = cx.subscribe(&find, |owner: &mut Owner, _, event, _| {
                    if *event == FindBarEvent::Dismissed {
                        owner.dismissed += 1;
                    }
                });
                Owner { bar: find.clone(), dismissed: 0, _subscription: subscription }
            });
            bar = Some(find);
            owner = Some(view.clone());
            Root::new(view, window, cx)
        });
        let harness = Self { item, bar: bar.expect("bar"), owner: owner.expect("owner"), window };
        harness.with_window(cx, |window, cx| {
            harness.bar.update(cx, |bar, cx| bar.focus_query(window, cx));
        });
        harness
    }

    fn with_window<R>(
        &self,
        cx: &mut TestAppContext,
        f: impl FnOnce(&mut Window, &mut gpui_kit::App) -> R,
    ) -> R {
        let result = cx
            .update_window(self.window.into(), |_, window, cx| {
                window.render_frame(cx);
                f(window, cx)
            })
            .expect("window");
        cx.run_until_parked();
        result
    }

    fn type_query(&self, text: &str, cx: &mut TestAppContext) {
        self.with_window(cx, |window, cx| window.input(text, cx));
        cx.run_until_parked();
    }

    fn press(&self, key: &str, cx: &mut TestAppContext) {
        self.with_window(cx, |window, cx| window.press(key, cx));
    }

    fn count(&self, cx: &mut TestAppContext) -> Option<String> {
        self.with_window(cx, |window, _| {
            window.try_find("find-count").and_then(|count| count.label().map(str::to_owned))
        })
    }

    fn active(&self, cx: &mut TestAppContext) -> Option<Range<usize>> {
        self.bar
            .read_with(cx, |bar, _| bar.active_match_index().map(|ix| bar.matches()[ix].clone()))
    }

    fn item<R>(&self, cx: &mut TestAppContext, read: impl FnOnce(&Text) -> R) -> R {
        self.item.read_with(cx, |item, _| read(item))
    }
}

const TEXT: &str = "One fish, two fish. Red FISH, blue fish.";

#[gpui_kit::test]
fn a_query_counts_its_matches_and_moves_to_the_first(cx: &mut TestAppContext) {
    let harness = Harness::open(TEXT, cx);
    assert_eq!(harness.count(cx), None, "nothing to count before a query");
    harness.type_query("fish", cx);
    assert_eq!(harness.count(cx).as_deref(), Some("1/4"));
    assert_eq!(harness.item(cx, |item| item.painted.len()), 4);
    assert_eq!(harness.item(cx, |item| item.painted_active), Some(0));
    assert_eq!(harness.item(cx, |item| item.activated.clone()), vec![4..8], "brought into view");

    harness.type_query("y", cx);
    assert_eq!(harness.count(cx).as_deref(), Some(copy_no_results()));
    assert!(harness.item(cx, |item| item.painted.is_empty()));
}

fn copy_no_results() -> &'static str {
    shared::copy::search::NO_RESULTS.en()
}

#[gpui_kit::test]
fn enter_shift_enter_and_command_g_move_through_matches_and_wrap(cx: &mut TestAppContext) {
    let harness = Harness::open(TEXT, cx);
    harness.type_query("fish", cx);
    harness.press("enter", cx);
    assert_eq!(harness.count(cx).as_deref(), Some("2/4"));
    harness.press("cmd-g", cx);
    harness.press("enter", cx);
    assert_eq!(harness.count(cx).as_deref(), Some("4/4"));
    harness.press("enter", cx);
    assert_eq!(harness.count(cx).as_deref(), Some("1/4"), "past the last, back to the first");
    harness.press("shift-enter", cx);
    assert_eq!(harness.count(cx).as_deref(), Some("4/4"), "before the first, on to the last");
    harness.press("cmd-shift-g", cx);
    assert_eq!(harness.count(cx).as_deref(), Some("3/4"));
    assert_eq!(harness.item(cx, |item| item.painted_active), Some(2), "the active fill moves");
    assert_eq!(
        harness.item(cx, |item| item.activated.clone()),
        [4..8, 14..18, 24..28, 35..39, 4..8, 35..39, 24..28]
    );
    // The buttons do the same.
    harness.with_window(cx, |window, cx| window.click("find-next", cx));
    assert_eq!(harness.count(cx).as_deref(), Some("4/4"));
    harness.with_window(cx, |window, cx| window.click("find-previous", cx));
    assert_eq!(harness.count(cx).as_deref(), Some("3/4"));
}

#[gpui_kit::test]
fn the_options_search_again(cx: &mut TestAppContext) {
    let harness = Harness::open(TEXT, cx);
    harness.type_query("FISH", cx);
    assert_eq!(harness.count(cx).as_deref(), Some("1/4"));
    harness.with_window(cx, |window, cx| window.click("find-match-case", cx));
    assert_eq!(harness.count(cx).as_deref(), Some("1/1"));
    assert_eq!(harness.active(cx), Some(24..28));
    assert!(harness.bar.read_with(cx, |bar, _| bar.options().is_case_sensitive()));
    harness.with_window(cx, |window, cx| window.click("find-match-case", cx));
    harness.with_window(cx, |window, cx| window.click("find-whole-word", cx));
    assert_eq!(harness.count(cx).as_deref(), Some("1/4"), "every fish is a word");
    // Back in the query, its text selected: typing replaces it.
    harness.with_window(cx, |window, cx| {
        harness.bar.update(cx, |bar, cx| bar.focus_query(window, cx));
    });
    harness.type_query("fis", cx);
    assert_eq!(harness.count(cx).as_deref(), Some(copy_no_results()), "not a whole word");
}

#[gpui_kit::test]
fn a_new_query_drops_the_search_in_flight(cx: &mut TestAppContext) {
    let harness = Harness::open(TEXT, cx);
    let (release, hold) = async_channel::bounded(1);
    harness.item.update(cx, |item, _| item.hold = Some(hold));
    harness.type_query("f", cx);
    assert!(harness.bar.read_with(cx, |bar, _| bar.is_searching()));
    harness.type_query("ish", cx);
    assert_eq!(harness.count(cx).as_deref(), Some("1/4"), "the second query's result");
    // The first search, released late, changes nothing.
    release.try_send(()).ok();
    cx.run_until_parked();
    assert_eq!(harness.count(cx).as_deref(), Some("1/4"));
    assert_eq!(harness.bar.read_with(cx, |bar, _| bar.matches().len()), 4);
}

#[gpui_kit::test]
fn changed_content_keeps_the_active_match_on_its_text(cx: &mut TestAppContext) {
    let harness = Harness::open(TEXT, cx);
    harness.type_query("fish", cx);
    harness.press("enter", cx);
    assert_eq!(harness.active(cx), Some(14..18));
    let activated = harness.item(cx, |item| item.activated.len());
    let searches = harness.item(cx, |item| item.searches);

    // A live reply grows twice within the pause: one search, the same
    // match still active, nothing moved to.
    harness.item.update(cx, |item, cx| item.set_text(&format!("{TEXT} More"), cx));
    cx.executor().advance_clock(REFRESH_DELAY / 2);
    harness.item.update(cx, |item, cx| item.set_text(&format!("{TEXT} More fish."), cx));
    cx.run_until_parked();
    assert_eq!(harness.item(cx, |item| item.searches), searches, "waits out the pause");
    cx.executor().advance_clock(REFRESH_DELAY);
    cx.run_until_parked();
    assert_eq!(harness.item(cx, |item| item.searches), searches + 1);
    assert_eq!(harness.active(cx), Some(14..18), "the same text");
    assert_eq!(harness.count(cx).as_deref(), Some("2/5"));
    assert_eq!(
        harness.item(cx, |item| item.activated.len()),
        activated,
        "nothing moves to the match"
    );
    assert_eq!(harness.item(cx, |item| item.painted_active), Some(1));

    // The active match's text goes: the position stays, still not moved to.
    harness.item.update(cx, |item, cx| item.set_text("One fish, two dogs. Red FISH.", cx));
    cx.executor().advance_clock(REFRESH_DELAY);
    cx.run_until_parked();
    assert_eq!(harness.count(cx).as_deref(), Some("2/2"));
    assert_eq!(harness.item(cx, |item| item.activated.len()), activated);
}

#[gpui_kit::test]
fn content_that_keeps_changing_still_refreshes_every_pause(cx: &mut TestAppContext) {
    let harness = Harness::open("fish", cx);
    harness.type_query("fish", cx);
    let searches = harness.item(cx, |item| item.searches);
    // A reply streaming a fish every 100 ms, for a second: never still for
    // the whole pause, yet the count follows it.
    let mut text = String::from("fish");
    for _ in 0..10 {
        text.push_str(" fish");
        harness.item.update(cx, |item, cx| item.set_text(&text, cx));
        cx.executor().advance_clock(std::time::Duration::from_millis(100));
        cx.run_until_parked();
    }
    let refreshed = harness.item(cx, |item| item.searches) - searches;
    assert!(refreshed >= 5, "refreshed {refreshed} times");
    cx.executor().advance_clock(REFRESH_DELAY);
    cx.run_until_parked();
    assert_eq!(harness.count(cx).as_deref(), Some("1/11"));
}

#[gpui_kit::test]
fn escape_and_close_dismiss_and_clear(cx: &mut TestAppContext) {
    let harness = Harness::open(TEXT, cx);
    harness.type_query("fish", cx);
    harness.press("escape", cx);
    assert_eq!(harness.owner.read_with(cx, |owner, _| owner.dismissed), 1);
    assert!(harness.item(cx, |item| item.painted.is_empty()));
    assert_eq!(harness.count(cx), None);
    // Shown again, the query is searched again and selected.
    harness.with_window(cx, |window, cx| {
        harness.bar.update(cx, |bar, cx| bar.focus_query(window, cx));
    });
    assert_eq!(harness.count(cx).as_deref(), Some("1/4"));
    harness.with_window(cx, |window, cx| window.click("find-close", cx));
    assert_eq!(harness.owner.read_with(cx, |owner, _| owner.dismissed), 2);
    assert!(harness.item(cx, |item| item.painted.is_empty()));
    // Content changing while dismissed searches nothing.
    let searches = harness.item(cx, |item| item.searches);
    harness.item.update(cx, |item, cx| item.set_text("fish", cx));
    cx.executor().advance_clock(REFRESH_DELAY * 2);
    cx.run_until_parked();
    assert_eq!(harness.item(cx, |item| item.searches), searches);
}

#[gpui_kit::test]
fn the_item_names_the_active_match_when_its_position_moves(cx: &mut TestAppContext) {
    let harness = Harness::open(TEXT, cx);
    harness.type_query("fish", cx);
    harness.item.update(cx, |item, cx| {
        item.position = 20;
        cx.emit(SearchEvent::ActiveMatchChanged);
    });
    cx.run_until_parked();
    assert_eq!(harness.count(cx).as_deref(), Some("3/4"));
    assert_eq!(harness.item(cx, |item| item.painted_active), Some(2));
}

#[gpui_kit::test]
fn the_item_s_progress_note_shows_under_the_count(cx: &mut TestAppContext) {
    let harness = Harness::open("fish…", cx);
    harness.type_query("fish", cx);
    let note = harness.with_window(cx, |window, _| {
        window.try_find("find-note").and_then(|note| note.label().map(str::to_owned))
    });
    assert_eq!(note.as_deref(), Some("Reading more…"));
    harness.item.update(cx, |item, cx| item.set_text("fish", cx));
    cx.run_until_parked();
    let note = harness.with_window(cx, |window, _| window.try_find("find-note").is_some());
    assert!(!note, "gone once everything is searched");
}

#[gpui_kit::test]
fn a_query_handed_over_replaces_the_typed_one_and_moves_where_the_item_says(
    cx: &mut TestAppContext,
) {
    let harness = Harness::open(TEXT, cx);
    harness.type_query("red", cx);
    assert_eq!(harness.count(cx).as_deref(), Some("1/1"));
    // The item points past the first two fish: the bar starts there.
    harness.item.update(cx, |item, _| item.position = 20);
    harness.with_window(cx, |window, cx| {
        harness.bar.update(cx, |bar, cx| bar.search_for("fish", window, cx));
    });
    assert_eq!(
        harness.bar.read_with(cx, |bar, cx| bar.query().read(cx).value().to_string()),
        "fish"
    );
    assert_eq!(harness.count(cx).as_deref(), Some("3/4"));
    assert_eq!(harness.item(cx, |item| item.activated.last().cloned()), Some(24..28));
    // Its text is selected: typing replaces it.
    harness.type_query("two", cx);
    assert_eq!(harness.count(cx).as_deref(), Some("1/1"));
}
