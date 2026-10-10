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

//! The Search page in a window, over a scripted Host: searching as the
//! person types, stale answers, what the results show and in what order,
//! the failures, and the keys.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_lite::future::Boxed;
use gpui_kit::component::Root;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{Entity, TestAppContext, WindowHandle, px, size};
use serde_json::{Value, json};
use shared::copy::search as copy;
use workspace::{HostRequestError, HostSession, HostTransport};

use super::*;

type Reply = Result<Value, HostRequestError>;

/// Answers `recall.query` with scripted replies in order, or holds one
/// until the test sends it. Records every request.
#[derive(Default)]
struct ScriptedHost {
    replies: Mutex<VecDeque<Reply>>,
    held: Mutex<VecDeque<async_channel::Receiver<Reply>>>,
    requests: Mutex<Vec<Value>>,
}

impl ScriptedHost {
    fn reply(&self, reply: Reply) {
        self.replies.lock().expect("replies").push_back(reply);
    }

    fn hold(&self) -> async_channel::Sender<Reply> {
        let (sender, receiver) = async_channel::bounded(1);
        self.held.lock().expect("held").push_back(receiver);
        sender
    }

    fn requests(&self) -> Vec<Value> {
        self.requests.lock().expect("requests").clone()
    }
}

impl HostTransport for ScriptedHost {
    fn request(&self, operation: &'static str, input: Value, _: Duration) -> Boxed<Reply> {
        assert_eq!(operation, "recall.query");
        self.requests.lock().expect("requests").push(input);
        if let Some(held) = self.held.lock().expect("held").pop_front() {
            return Box::pin(async move {
                held.recv().await.unwrap_or(Err(HostRequestError::NotConnected))
            });
        }
        let reply = self.replies.lock().expect("replies").pop_front();
        Box::pin(async move { reply.unwrap_or(Err(HostRequestError::NotConnected)) })
    }
}

/// The page in a window, and what it asked the window to do.
struct Harness {
    view: Entity<SearchView>,
    host: Arc<ScriptedHost>,
    events: Arc<Mutex<Vec<SearchPageEvent>>>,
    window: WindowHandle<Root>,
}

/// Unix milliseconds the tests' clock reads: 2026-10-10.
const NOW: u64 = 1_791_590_400_000;
const MINUTE: u64 = 60_000;

impl Harness {
    fn open(cx: &mut TestAppContext) -> Self {
        Self::sized(size(px(1000.), px(800.)), cx)
    }

    fn sized(window_size: gpui_kit::Size<gpui_kit::Pixels>, cx: &mut TestAppContext) -> Self {
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::init(cx);
        });
        let host = Arc::new(ScriptedHost::default());
        let session =
            cx.new(|_| HostSession::with_transport(PathBuf::from("/tmp/r"), host.clone()));
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut view = None;
        let window = cx.open_window(window_size, |window, cx| {
            let page = cx.new(|cx| {
                let mut page = SearchView::new(session.clone(), window, cx);
                page.set_clock(|| NOW);
                page
            });
            let recorded = events.clone();
            cx.subscribe(&page, move |_, _, event: &SearchPageEvent, _| {
                recorded.lock().expect("events").push(event.clone());
            })
            .detach();
            view = Some(page.clone());
            Root::new(page, window, cx)
        });
        let harness = Self { view: view.expect("view"), host, events, window };
        harness.with_window(cx, |window, cx| {
            harness.view.update(cx, |view, cx| view.focus_query(window, cx));
        });
        harness
    }

    fn with_window<R>(
        &self,
        cx: &mut TestAppContext,
        f: impl FnOnce(&mut Window, &mut App) -> R,
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

    fn type_text(&self, text: &str, cx: &mut TestAppContext) {
        self.with_window(cx, |window, cx| window.input(text, cx));
    }

    /// Types `text` and lets the pause pass and the answer land.
    fn search(&self, text: &str, cx: &mut TestAppContext) {
        self.type_text(text, cx);
        self.settle(cx);
    }

    fn settle(&self, cx: &mut TestAppContext) {
        cx.executor().advance_clock(SEARCH_DEBOUNCE);
        cx.run_until_parked();
        self.with_window(cx, |_, _| {});
    }

    fn press(&self, key: &str, cx: &mut TestAppContext) {
        self.with_window(cx, |window, cx| window.press(key, cx));
        self.with_window(cx, |_, _| {});
    }

    fn label(&self, id: impl Into<ElementId>, cx: &mut TestAppContext) -> Option<String> {
        let id = id.into();
        self.with_window(cx, |window, _| {
            window.try_find(id).and_then(|element| element.label().map(str::to_owned))
        })
    }

    fn shows(&self, id: impl Into<ElementId>, cx: &mut TestAppContext) -> bool {
        let id = id.into();
        self.with_window(cx, |window, _| window.try_find(id).is_some())
    }

    fn top(&self, id: impl Into<ElementId>, cx: &mut TestAppContext) -> gpui_kit::Pixels {
        let id = id.into();
        self.with_window(cx, |window, _| window.find(id).bounds().top())
    }

    fn query(&self, cx: &mut TestAppContext) -> String {
        self.view.read_with(cx, |view, cx| view.query().read(cx).value().to_string())
    }

    fn events(&self) -> Vec<SearchPageEvent> {
        std::mem::take(&mut *self.events.lock().expect("events"))
    }
}

fn message(id: &str, role: &str, text: &str, anchor: bool) -> Value {
    let kind = match role {
        "user" => "user_message",
        "assistant" => "assistant_message",
        _ => "tool_result",
    };
    json!({"messageId": id, "role": role, "matchKind": kind, "text": text, "timestamp": 1,
           "isAnchor": anchor})
}

fn passage(session: &str, anchor: &str, text: &str, terms: &[&str], last: u64) -> Value {
    json!({
        "sessionId": session, "sessionTitle": format!("Host title {session}"),
        "turnId": format!("{session}-t"), "anchorMessageId": anchor, "sequence": 7,
        "messages": [
            message("m-before", "user", "What does the client do?", false),
            message(anchor, "assistant", text, true),
            message("m-after", "tool", "cat backoff.rs", false)
        ],
        "matchedTerms": terms, "score": 1.0, "lastMessageAt": last,
        "hasMoreBefore": true, "hasMoreAfter": false, "truncated": true
    })
}

fn found(passages: Vec<Value>) -> Reply {
    Ok(json!({"ok": true, "facts": [], "passages": passages,
              "gaps": "Searched 3 Session(s).", "searchedEverySession": false}))
}

fn tasks() -> Vec<TaskEntry> {
    vec![
        TaskEntry::new("s1", "Explain the reconnect backoff")
            .with_project(Some("maka-gpui".into()))
            .with_activity_at(NOW - 5 * MINUTE),
        TaskEntry::new("s2", "Map the workspace crates").archived(true).with_activity_at(NOW),
        TaskEntry::new("s3", "Reconnect after sleep").with_activity_at(NOW - MINUTE),
    ]
}

#[gpui_kit::test]
fn typing_searches_once_after_a_pause(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    assert_eq!(harness.label("search-status", cx).as_deref(), Some(copy::SEARCH_HINT.en()));
    harness.host.reply(found(vec![]));
    harness.type_text("rec", cx);
    cx.executor().advance_clock(Duration::from_millis(100));
    cx.run_until_parked();
    harness.type_text("onnect  backoff", cx);
    cx.executor().advance_clock(Duration::from_millis(200));
    cx.run_until_parked();
    assert!(harness.host.requests().is_empty(), "still typing");
    assert_eq!(harness.label("search-status", cx).as_deref(), Some(copy::SEARCHING.en()));
    harness.settle(cx);
    let requests = harness.host.requests();
    assert_eq!(requests.len(), 1, "{requests:?}");
    assert_eq!(requests[0], json!({"terms": ["reconnect", "backoff"], "limit": 25}));
    assert_eq!(harness.label("search-no-results", cx).as_deref(), Some(copy::NO_RESULTS.en()));
    assert_eq!(harness.label("search-status", cx), None, "quiet once answered");
}

#[gpui_kit::test]
fn the_last_results_stay_until_the_next_land_and_a_stale_answer_is_dropped(
    cx: &mut TestAppContext,
) {
    let harness = Harness::open(cx);
    let first = passage_element_id("s1", "a1");
    let second = passage_element_id("s2", "b1");
    let third = passage_element_id("s3", "c1");
    harness.host.reply(found(vec![passage("s1", "a1", "The backoff doubles.", &["backoff"], 1)]));
    harness.search("backoff", cx);
    assert!(harness.shows(first.clone(), cx));

    // A new query: until its answer lands the old results stay, dimmed,
    // and the line under the field says a search runs.
    let late = harness.host.hold();
    harness.search(" jitter", cx);
    assert_eq!(harness.host.requests().len(), 2);
    assert!(harness.view.read_with(cx, |view, _| view.is_searching()));
    assert!(harness.shows(first.clone(), cx), "the old results stay");
    assert_eq!(harness.label("search-status", cx).as_deref(), Some(copy::SEARCHING.en()));

    // Another query is answered first; the held answer, arriving after it,
    // is dropped.
    harness.host.reply(found(vec![passage("s3", "c1", "Jitter is 20%.", &["jitter"], 1)]));
    harness.press("cmd-a", cx);
    harness.search("jitter", cx);
    assert!(harness.shows(third.clone(), cx));
    assert!(!harness.shows(first.clone(), cx), "replaced");
    late.try_send(found(vec![passage("s2", "b1", "Stale.", &["jitter"], 1)])).ok();
    cx.run_until_parked();
    assert!(!harness.shows(second, cx), "the answer to an earlier query is dropped");
    assert!(harness.shows(third, cx));
    assert!(!harness.view.read_with(cx, |view, _| view.is_searching()));
}

#[gpui_kit::test]
fn titles_come_first_then_each_task_where_its_best_passage_ranks(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    harness.view.update(cx, |view, cx| view.set_tasks(tasks(), cx));
    harness.host.reply(Ok(json!({
        "ok": true,
        "facts": [{"content": "The client reconnects with backoff.", "kind": "fact",
                   "observedAt": 1}],
        "passages": [
            passage("s2", "b1", "reconnect lives in host-client", &["reconnect"], NOW - 2 * MINUTE),
            passage("s1", "a1", "It will reconnect with backoff.", &["reconnect"], NOW - 9 * MINUTE),
            passage("s2", "b2", "reconnect again", &["reconnect"], NOW - MINUTE),
            passage("s9", "z1", "reconnect from elsewhere", &["reconnect"], NOW - 3 * MINUTE)
        ],
        "gaps": "", "searchedEverySession": false
    })));
    harness.search("reconnect", cx);

    // The titles the query matches, best first.
    assert_eq!(harness.label("search-tasks", cx).as_deref(), Some(copy::TASKS.en()));
    let s3 = harness.top(title_element_id("s3"), cx);
    let s1 = harness.top(title_element_id("s1"), cx);
    assert!(s3 < s1, "a prefix match first");
    assert!(!harness.shows(title_element_id("s2"), cx), "its title does not match");
    // Then the facts, then the tasks: s2 (its best passage ranks first),
    // its passages in the Host's order, s1, and a task the window does not
    // list.
    let memory = harness.top("search-memory", cx);
    assert!(s1 < memory);
    let order = [
        domain_element_id("search-task", "s2"),
        passage_element_id("s2", "b1"),
        passage_element_id("s2", "b2"),
        domain_element_id("search-task", "s1"),
        passage_element_id("s1", "a1"),
        domain_element_id("search-task", "s9"),
    ];
    let mut above = memory;
    for id in order {
        let top = harness.top(id.clone(), cx);
        assert!(top > above, "{id:?} in order");
        above = top;
    }
    // A heading names the task as the window does, with its project,
    // Archived, and its latest passage's time.
    assert_eq!(
        harness.label(domain_element_id("search-task", "s2"), cx).as_deref(),
        Some("Map the workspace crates, Archived, 1 minute ago")
    );
    assert_eq!(
        harness.label(domain_element_id("search-task", "s1"), cx).as_deref(),
        Some("Explain the reconnect backoff, maka-gpui, 9 minutes ago")
    );
    assert_eq!(
        harness.label(domain_element_id("search-task", "s9"), cx).as_deref(),
        Some("Host title s9, 3 minutes ago"),
        "the answer's title for a task the window does not list"
    );
    // A passage is named by its message, and marks what was cut.
    assert_eq!(
        harness.label(passage_element_id("s1", "a1"), cx).as_deref(),
        Some("Maka: It will reconnect with backoff.")
    );
    assert!(harness.with_window(cx, |window, _| {
        window
            .within(passage_element_id("s1", "a1"))
            .try_find(("search-shortened", 0usize))
            .is_some()
    }));
}

#[gpui_kit::test]
fn a_chinese_query_marks_every_occurrence(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    harness.host.reply(found(vec![passage(
        "s1",
        "a1",
        "客户端的重连退避从 100 毫秒开始，重连成功后清零。",
        &["重连"],
        1,
    )]));
    harness.search("重连", cx);
    assert_eq!(harness.host.requests()[0]["terms"], json!(["重连"]));
    let marks = harness.view.read_with(cx, |view, _| {
        let anchor = view.found().expect("found").tasks()[0].passages()[0].anchor().cloned();
        let excerpt = anchor.expect("anchor").excerpt().clone();
        excerpt
            .marks()
            .iter()
            .map(|range| excerpt.text()[range.clone()].to_owned())
            .collect::<Vec<_>>()
    });
    assert_eq!(marks, ["重连", "重连"]);
    assert!(harness.shows(passage_element_id("s1", "a1"), cx));
}

#[gpui_kit::test]
fn each_failure_says_what_to_do(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    let refused = |reason: &str| Ok(json!({"ok": false, "reason": reason, "message": "m"}));
    let cases: [(Reply, Text, bool); 7] = [
        (refused("incognito_active"), copy::FAILED_INCOGNITO, false),
        (refused("invalid_query"), copy::FAILED_INVALID, false),
        (refused("not_found"), copy::FAILED_NOT_FOUND, true),
        (refused("aborted"), copy::FAILED_ABORTED, true),
        (refused("rate_limited"), copy::FAILED_UNKNOWN, true),
        (Err(HostRequestError::NotConnected), copy::FAILED_NOT_CONNECTED, true),
        (Err(HostRequestError::Transport("closed".into())), copy::FAILED_UNREACHABLE, true),
    ];
    for (ix, (reply, text, again)) in cases.into_iter().enumerate() {
        harness.host.reply(reply);
        harness.press("cmd-a", cx);
        harness.search(&format!("query{ix}"), cx);
        assert_eq!(harness.label("search-failure", cx).as_deref(), Some(text.en()), "{ix}");
        assert_eq!(harness.shows("search-again", cx), again, "{ix}");
    }
    // Searching again asks the Host again, now.
    let before = harness.host.requests().len();
    harness.host.reply(found(vec![]));
    harness.with_window(cx, |window, cx| window.click("search-again", cx));
    assert_eq!(harness.host.requests().len(), before + 1);
    assert!(!harness.shows("search-failure", cx));
    // A term the Host would refuse fails without asking it.
    harness.press("cmd-a", cx);
    harness.search(&"x".repeat(501), cx);
    assert_eq!(harness.host.requests().len(), before + 1);
    assert_eq!(harness.label("search-failure", cx).as_deref(), Some(copy::FAILED_INVALID.en()));
}

#[gpui_kit::test]
fn a_scan_the_host_capped_is_noted(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    harness.host.reply(Ok(json!({
        "ok": true, "facts": [], "passages": [passage("s1", "a1", "backoff", &["backoff"], 1)],
        "gaps": "Searched 200 Session(s). Session scan capped at 200; older Sessions were not read.",
        "searchedEverySession": false
    })));
    harness.search("backoff", cx);
    assert_eq!(
        harness.label("search-status", cx).as_deref(),
        Some("Only the 200 most recently active tasks were searched.")
    );
}

#[gpui_kit::test]
fn arrows_move_through_titles_and_passages_enter_opens_and_escape_clears_then_leaves(
    cx: &mut TestAppContext,
) {
    let harness = Harness::open(cx);
    harness.view.update(cx, |view, cx| view.set_tasks(tasks(), cx));
    harness.host.reply(found(vec![
        passage("s1", "a1", "reconnect one", &["reconnect"], 1),
        passage("s2", "b1", "reconnect two", &["reconnect"], 1),
    ]));
    harness.search("reconnect", cx);
    let selected = |harness: &Harness, cx: &mut TestAppContext| {
        harness.with_window(cx, |window, _| {
            [
                title_element_id("s3"),
                title_element_id("s1"),
                passage_element_id("s1", "a1"),
                passage_element_id("s2", "b1"),
            ]
            .into_iter()
            .position(|id| window.find(id).selected() == Some(true))
        })
    };
    // From the field: Down walks the titles, then the passages; Up back.
    assert_eq!(selected(&harness, cx), None);
    for expected in [0, 1, 2, 3, 3] {
        harness.press("down", cx);
        assert_eq!(selected(&harness, cx), Some(expected));
    }
    harness.press("up", cx);
    assert_eq!(selected(&harness, cx), Some(2));
    assert_eq!(harness.query(cx), "reconnect", "the arrows leave the field's text alone");
    harness.press("enter", cx);
    let target = PassageTarget::new("s1", "a1", 7).with_turn_id("s1-t").with_term("reconnect");
    assert_eq!(harness.events(), [SearchPageEvent::OpenPassage(target)]);
    harness.press("up", cx);
    harness.press("up", cx);
    harness.press("enter", cx);
    assert_eq!(harness.events(), [SearchPageEvent::OpenTask("s3".into())]);
    // A click opens too.
    harness.with_window(cx, |window, cx| window.click(title_element_id("s1"), cx));
    assert_eq!(harness.events(), [SearchPageEvent::OpenTask("s1".into())]);

    // Escape clears the query, then leaves.
    harness.with_window(cx, |window, cx| {
        harness.view.update(cx, |view, cx| view.focus_query(window, cx));
    });
    harness.press("escape", cx);
    assert_eq!(harness.query(cx), "");
    assert!(!harness.shows(passage_element_id("s1", "a1"), cx));
    assert!(harness.events().is_empty());
    harness.press("escape", cx);
    assert_eq!(harness.events(), [SearchPageEvent::Leave]);
}

#[gpui_kit::test]
fn the_cursor_scrolls_into_view(cx: &mut TestAppContext) {
    let harness = Harness::sized(size(px(900.), px(400.)), cx);
    let passages: Vec<Value> = (0..12)
        .map(|ix| passage(&format!("s{ix}"), &format!("a{ix}"), "needle", &["needle"], 1))
        .collect();
    harness.host.reply(found(passages));
    harness.search("needle", cx);
    let last = passage_element_id("s11", "a11");
    let viewport = harness.with_window(cx, |window, _| window.find("search-body").bounds());
    assert!(harness.top(last.clone(), cx) > viewport.bottom(), "below the fold");
    for _ in 0..12 {
        harness.press("down", cx);
    }
    let row = harness.with_window(cx, |window, _| window.find(last.clone()).bounds());
    assert!(row.top() >= viewport.top() && row.bottom() <= viewport.bottom() + px(1.), "{row:?}");
    let offset = harness.view.read_with(cx, |view, _| view.scroll_handle().offset().y);
    assert!(offset < px(0.), "scrolled: {offset:?}");
}

#[gpui_kit::test]
fn a_handed_query_searches_at_once_selected(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    harness.host.reply(found(vec![]));
    harness.with_window(cx, |window, cx| {
        harness.view.update(cx, |view, cx| view.search_for("backoff", window, cx));
    });
    assert_eq!(harness.host.requests().len(), 1, "no pause for a whole query");
    harness.type_text("jitter", cx);
    assert_eq!(harness.query(cx), "jitter", "its text was selected");
}

#[gpui_kit::test]
fn tab_reaches_the_results_with_the_cursor_on_the_first(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    harness.host.reply(found(vec![
        passage("s1", "a1", "reconnect one", &["reconnect"], 1),
        passage("s2", "b1", "reconnect two", &["reconnect"], 1),
    ]));
    harness.search("reconnect", cx);
    let list = harness.view.read_with(cx, gpui_kit::Focusable::focus_handle);
    let mut tabs = 0;
    while !harness.with_window(cx, |window, _| list.is_focused(window)) {
        assert!(tabs < 4, "Tab reaches the results");
        harness.press("tab", cx);
        tabs += 1;
    }
    let first = passage_element_id("s1", "a1");
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find(first.clone()).selected(), Some(true), "the cursor shows");
    });
    harness.press("down", cx);
    harness.press("enter", cx);
    let opened = harness.events();
    assert!(
        matches!(&opened[..], [SearchPageEvent::OpenPassage(target)] if target.anchor_message_id() == "b1"),
        "{opened:?}"
    );
    // Without results there is nothing to tab into.
    harness.press("escape", cx);
    assert!(!harness.shows("search-results", cx));
}
