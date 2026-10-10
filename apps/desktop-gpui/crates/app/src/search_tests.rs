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

//! The Search page in the window: ⇧⌘F, the sidebar's search button and
//! the palette open it with its field focused, a selection seeds it, a
//! result opens its task at its message, and Back returns to the page as
//! it was.

use base64::Engine as _;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{Focusable as _, ScrollDelta, TestAppContext, point, px};
use serde_json::{Value, json};
use session::SidebarPage;
use shared::copy::search as copy;

use crate::chrome_tests::row;
use crate::tests::{EPOCH, Harness, ScriptedHost, session, settle};

/// The rows of settled turn `turn`, from sequence `first`: a prompt and a
/// reply that holds a needle.
fn needle_turn(turn: &str, first: u64) -> Vec<(u64, Value)> {
    vec![
        (
            first,
            json!({"type": "user", "id": turn, "turnId": turn, "ts": first,
                       "text": "Where is it?"}),
        ),
        (
            first + 1,
            json!({"type": "assistant", "id": format!("{turn}-a"), "turnId": turn,
                           "ts": first + 1, "text": "The needle is in the hay.",
                           "contentOrder": ["text"], "modelId": "m"}),
        ),
        (
            first + 2,
            json!({"type": "turn_state", "id": format!("{turn}-end"), "turnId": turn,
                           "ts": first + 2, "status": "completed"}),
        ),
    ]
}

/// An older page of task `id` holding `rows`, older history behind `next`.
fn page_of(id: &str, rows: &[(u64, Value)], next: Option<&str>) -> Value {
    let fragments: Vec<Value> = rows
        .iter()
        .rev()
        .map(|(sequence, row)| {
            let bytes = serde_json::to_vec(row).expect("row");
            json!({
                "sequence": sequence, "byteOffset": 0, "totalBytes": bytes.len(),
                "payloadDigest": null,
                "data": base64::engine::general_purpose::STANDARD.encode(&bytes)
            })
        })
        .collect();
    json!({
        "kind": "page", "sessionId": id, "direction": "older", "throughSequence": 99,
        "rawBytes": 0, "fragments": fragments, "nextCursor": next, "endsAtTurnBoundary": true
    })
}

/// `subscription.open` of task `id`: one settled turn whose reply holds a
/// needle.
pub(crate) fn open_with_a_needle(id: &str) -> Value {
    open_with_tail(id, page_of(id, &needle_turn("t1", 1), None))
}

fn open_with_tail(id: &str, tail: Value) -> Value {
    json!({
        "hostEpoch": EPOCH, "subscriptionId": format!("sub-{id}"), "nextSequence": 1,
        "snapshot": {
            "schemaVersion": 5,
            "session": {"sessionId": id, "metadataRevision": 1, "status": "active",
                        "createdAt": 1, "isArchived": false},
            "projectionRevision": 1, "rootTurn": null, "goal": null,
            "queue": {"hostEpoch": EPOCH, "queueRevision": 0, "steering": [], "followup": []},
            "interactions": {"pending": []}
        },
        "activeAssistantStreams": [],
        "transcript": {"durable": tail}
    })
}

fn passage(session: &str, anchor: &str, text: &str) -> Value {
    json!({
        "sessionId": session, "sessionTitle": "", "turnId": "t1", "anchorMessageId": anchor,
        "sequence": 1,
        "messages": [{"messageId": anchor, "role": "assistant", "matchKind": "assistant_message",
                      "text": text, "timestamp": 2, "isAnchor": true}],
        "matchedTerms": ["needle"], "score": 1.0, "lastMessageAt": 2,
        "hasMoreBefore": false, "hasMoreAfter": false
    })
}

/// A recall answer: the needle in `s2`'s reply first, then a dozen in `s1`
/// (enough to scroll the page).
fn needles() -> Value {
    let mut passages = vec![passage("s2", "t1-a", "The needle is in the hay.")];
    passages.extend((0..12).map(|ix| passage("s1", &format!("a{ix}"), "Another needle.")));
    json!({"ok": true, "facts": [], "passages": passages, "gaps": "",
           "searchedEverySession": true})
}

fn two_tasks() -> std::sync::Arc<ScriptedHost> {
    ScriptedHost::new(vec![
        session("s1", "Alpha", "/work/demo", "active"),
        session("s2", "Beta", "/work/demo", "active"),
    ])
}

fn page(harness: &Harness, cx: &mut TestAppContext) -> Option<SidebarPage> {
    harness.workbench.read_with(cx, |workbench, _| workbench.page())
}

/// The Search page's field: whether it has focus, and its text.
fn field(harness: &Harness, cx: &mut TestAppContext) -> (bool, String) {
    let view = harness
        .workbench
        .read_with(cx, |workbench, _| workbench.search_view().cloned())
        .expect("the page was shown");
    let query = view.read_with(cx, |view, _| view.query().clone());
    let focused =
        harness.with_window(cx, |window, cx| query.read(cx).focus_handle(cx).is_focused(window));
    (focused, query.read_with(cx, |query, _| query.value().to_string()))
}

#[gpui_kit::test]
fn command_shift_f_the_search_button_and_the_palette_open_the_page_focused(
    cx: &mut TestAppContext,
) {
    let harness = Harness::with_transport(two_tasks(), cx);
    harness.with_window(cx, |window, cx| window.click(row("s1"), cx));
    harness.with_window(cx, |window, cx| window.press("cmd-shift-f", cx));
    assert_eq!(page(&harness, cx), Some(SidebarPage::Search));
    assert_eq!(field(&harness, cx), (true, String::new()));
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find("page-title").label(), Some(copy::SEARCH.en()));
        assert_eq!(
            window.find("search-status").label(),
            Some(copy::SEARCH_HINT.en()),
            "a hint while nothing is typed"
        );
    });

    // Back in the task, the sidebar's button opens it again.
    harness.with_window(cx, |window, cx| window.click(row("s2"), cx));
    assert_eq!(page(&harness, cx), None);
    harness.with_window(cx, |window, cx| window.click("search-button", cx));
    assert_eq!(page(&harness, cx), Some(SidebarPage::Search));
    assert!(field(&harness, cx).0);

    // And the palette's command; ⌘K stays the palette.
    harness.with_window(cx, |window, cx| window.click(row("s1"), cx));
    harness.with_window(cx, |window, cx| window.press("cmd-k", cx));
    harness.with_window(cx, |window, cx| window.input("search all tasks", cx));
    harness.with_window(cx, |window, cx| window.press("enter", cx));
    assert_eq!(page(&harness, cx), Some(SidebarPage::Search));
    assert!(field(&harness, cx).0);
}

#[gpui_kit::test]
fn a_selection_seeds_the_query_and_is_searched_at_once(cx: &mut TestAppContext) {
    let transport = two_tasks();
    transport.reply("recall.query", Ok(needles()));
    let harness = Harness::with_transport(transport.clone(), cx);
    harness.with_window(cx, |window, cx| window.click(row("s1"), cx));
    let draft = harness.draft_id(cx);
    harness.with_window(cx, |window, cx| {
        window.click(draft.clone(), cx);
        window.input("the   needle\nhere", cx);
        window.press("cmd-a", cx);
    });
    harness.with_window(cx, |window, cx| window.press("cmd-shift-f", cx));
    assert_eq!(field(&harness, cx), (true, "the needle here".to_owned()));
    let requests = transport.requests("recall.query");
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["terms"], json!(["the", "needle", "here"]));
    assert_eq!(harness.draft(cx), "the   needle\nhere", "the draft keeps its text");
}

#[gpui_kit::test]
fn a_passage_opens_its_task_at_its_message_and_back_returns_to_the_page(cx: &mut TestAppContext) {
    let transport = two_tasks();
    transport.reply("recall.query", Ok(needles()));
    // The window opens on s1, the newest task; the passage is in s2.
    transport.reply("subscription.open", Ok(open_with_a_needle("s1")));
    transport.reply("subscription.open", Ok(open_with_a_needle("s2")));
    let harness = Harness::with_transport(transport.clone(), cx);
    harness.with_window(cx, |window, cx| window.press("cmd-shift-f", cx));
    harness.with_window(cx, |window, cx| window.input("needle", cx));
    settle(cx);
    let s2 = search::passage_element_id("s2", "t1-a");
    harness.with_window(cx, |window, _| {
        assert!(window.find(s2.clone()).visible(), "the results show");
    });
    // The cursor on the first passage, then the page scrolled by hand.
    harness.with_window(cx, |window, cx| window.press("down", cx));
    harness.with_window(cx, |window, cx| {
        window.scroll("search-body", ScrollDelta::Pixels(point(px(0.), px(-240.))), cx);
    });
    let offset = |harness: &Harness, cx: &mut TestAppContext| {
        harness.workbench.read_with(cx, |workbench, cx| {
            workbench.search_view().expect("page").read(cx).scroll_handle().offset().y
        })
    };
    let scrolled = offset(&harness, cx);
    assert!(scrolled < px(0.), "scrolled: {scrolled:?}");

    harness.with_window(cx, |window, cx| window.press("enter", cx));
    settle(cx);
    harness.with_window(cx, |_, _| {});
    assert_eq!(page(&harness, cx), None, "the task shows");
    let selected = harness.workbench.read_with(cx, |workbench, cx| {
        workbench.sidebar().read(cx).catalog().read(cx).selected_id().cloned()
    });
    assert_eq!(selected.as_deref(), Some("s2"));
    let (open, query) = harness.workbench.read_with(cx, |workbench, cx| {
        let view = workbench.conversation().read(cx);
        let query = view.find_bar().map(|bar| bar.read(cx).query().read(cx).value().to_string());
        (view.is_find_open(), query)
    });
    assert!(open, "the find bar shows");
    assert_eq!(query.as_deref(), Some("needle"));
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find("find-count").label(), Some("1/1"), "its match is active");
    });

    // Back: the page as it was.
    harness.with_window(cx, |window, cx| window.press("cmd-[", cx));
    assert_eq!(page(&harness, cx), Some(SidebarPage::Search));
    assert_eq!(field(&harness, cx).1, "needle");
    harness.with_window(cx, |window, _| {
        assert!(window.try_find(s2.clone()).is_some(), "the results stay");
    });
    assert_eq!(offset(&harness, cx), scrolled, "and where they were scrolled");
    assert_eq!(transport.requests("recall.query").len(), 1, "nothing searched again");
}

#[gpui_kit::test]
fn escape_clears_the_query_then_leaves_for_the_task(cx: &mut TestAppContext) {
    let transport = two_tasks();
    transport.reply("recall.query", Ok(needles()));
    let harness = Harness::with_transport(transport, cx);
    harness.with_window(cx, |window, cx| window.click(row("s1"), cx));
    harness.with_window(cx, |window, cx| window.press("cmd-shift-f", cx));
    harness.with_window(cx, |window, cx| window.input("needle", cx));
    harness.with_window(cx, |window, cx| window.press("escape", cx));
    assert_eq!(page(&harness, cx), Some(SidebarPage::Search));
    assert_eq!(field(&harness, cx), (true, String::new()));
    harness.with_window(cx, |window, cx| window.press("escape", cx));
    assert_eq!(page(&harness, cx), None, "the task view, as the other pages leave");
    let draft = harness.draft_id(cx);
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find(draft.clone()).focused(), Some(true), "ready to write");
    });
    harness.with_window(cx, |window, cx| window.press("cmd-[", cx));
    assert_eq!(page(&harness, cx), Some(SidebarPage::Search), "Back returns to it");
}

#[gpui_kit::test]
fn text_selected_in_a_reply_seeds_the_query(cx: &mut TestAppContext) {
    let transport = two_tasks();
    transport.reply("subscription.open", Ok(open_with_a_needle("s1")));
    transport.reply("recall.query", Ok(needles()));
    let harness = Harness::with_transport(transport.clone(), cx);
    settle(cx);
    let reply =
        conversation::item_element_id("t1", &transcript_model::ItemKey::Text("t1-a".into()));
    harness.with_window(cx, |window, cx| {
        let bounds = window.find(reply.clone()).bounds();
        let y = bounds.top() + px(10.);
        window.drag(point(bounds.left() + px(2.), y), point(bounds.right() - px(2.), y), cx);
    });
    harness.with_window(cx, |window, cx| window.press("cmd-shift-f", cx));
    let (focused, query) = field(&harness, cx);
    assert!(focused);
    assert!(query.contains("needle"), "{query:?}");
    assert_eq!(transport.requests("recall.query").len(), 1);
}

#[gpui_kit::test]
fn a_search_without_a_connection_runs_again_once_connected(cx: &mut TestAppContext) {
    let transport = two_tasks();
    transport.reply("recall.query", Err(workspace::HostRequestError::NotConnected));
    transport.reply("recall.query", Ok(needles()));
    let harness = Harness::with_transport(transport.clone(), cx);
    harness.with_window(cx, |window, cx| window.press("cmd-shift-f", cx));
    harness.with_window(cx, |window, cx| window.input("needle", cx));
    settle(cx);
    harness.with_window(cx, |window, _| {
        let failure = window.find("search-failure");
        assert_eq!(failure.label(), Some(copy::FAILED_NOT_CONNECTED.en()));
    });
    harness
        .feed(host_client::ConnectionEvent::Connected { accepted: crate::tests::accepted() }, cx);
    harness.with_window(cx, |_, _| {});
    assert_eq!(transport.requests("recall.query").len(), 2, "searched again");
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("search-failure").is_none());
        assert!(window.find(search::passage_element_id("s2", "t1-a")).visible());
    });
}

/// Back to the page while the passage's task is still read back to its
/// message: the passage no longer waits, and its find bar never opens
/// over the task.
#[gpui_kit::test]
fn leaving_before_a_passage_is_read_back_forgets_it(cx: &mut TestAppContext) {
    let transport = two_tasks();
    let mut answer = needles();
    answer["passages"][0]["anchorMessageId"] = json!("t0-a");
    answer["passages"][0]["turnId"] = json!("t0");
    transport.reply("recall.query", Ok(answer));
    transport.reply("subscription.open", Ok(open_with_a_needle("s1")));
    let tail = page_of("s2", &needle_turn("t1", 10), Some("c1"));
    transport.reply("subscription.open", Ok(open_with_tail("s2", tail)));
    let page_read = transport.hold("session.transcript.page");
    let harness = Harness::with_transport(transport.clone(), cx);
    harness.with_window(cx, |window, cx| window.press("cmd-shift-f", cx));
    harness.with_window(cx, |window, cx| window.input("needle", cx));
    settle(cx);
    harness.with_window(cx, |window, cx| window.press("down", cx));
    harness.with_window(cx, |window, cx| window.press("enter", cx));
    settle(cx);
    assert_eq!(page(&harness, cx), None);
    assert_eq!(transport.requests("session.transcript.page").len(), 1, "reading back to it");
    harness.with_window(cx, |window, cx| window.press("cmd-[", cx));
    assert_eq!(page(&harness, cx), Some(SidebarPage::Search));
    page_read.try_send(Ok(page_of("s2", &needle_turn("t0", 1), None))).expect("release");
    settle(cx);
    harness.with_window(cx, |_, _| {});
    let open = harness
        .workbench
        .read_with(cx, |workbench, cx| workbench.conversation().read(cx).is_find_open());
    assert!(!open, "no find bar opened behind the page");
    let focused = harness.with_window(cx, |window, cx| {
        let view = harness.workbench.read(cx).search_view().cloned().expect("page");
        let list = gpui_kit::Focusable::focus_handle(view.read(cx), cx);
        list.is_focused(window)
    });
    assert!(focused, "the page keeps focus, on its results");
}

/// A side chat's fork of task `source`, as the catalog lists it: the
/// source's name, its parent, the side-conversation label.
fn fork_of(id: &str, source: &str) -> Value {
    let mut fork = session(id, "Forked words", "/work/demo", "active");
    fork["parentSessionId"] = json!(source);
    fork["branchOfTurnId"] = json!("t1");
    fork["labels"] = json!(["mode:side_conversation"]);
    fork
}

#[gpui_kit::test]
fn a_side_chat_fork_is_hidden_from_the_sidebar_the_palette_and_the_search_page(
    cx: &mut TestAppContext,
) {
    let transport = ScriptedHost::new(vec![
        session("s1", "Alpha", "/work/demo", "active"),
        fork_of("f1", "s1"),
        session("s2", "Beta", "/work/demo", "active"),
    ]);
    let mut answer = needles();
    answer["passages"]
        .as_array_mut()
        .expect("passages")
        .insert(0, passage("f1", "f-a", "The forked needle."));
    transport.reply("recall.query", Ok(answer));
    let harness = Harness::with_transport(transport, cx);
    harness.with_window(cx, |window, _| {
        assert!(window.try_find(row("s1")).is_some() && window.try_find(row("s2")).is_some());
        assert!(window.try_find(row("f1")).is_none(), "no row for the fork");
    });
    let keys: Vec<String> = harness.workbench.read_with(cx, |workbench, cx| {
        workbench.palette_entries(cx).iter().map(|entry| entry.key.to_string()).collect()
    });
    assert!(keys.iter().any(|key| key.ends_with("s1")), "{keys:?}");
    assert!(!keys.iter().any(|key| key.ends_with("f1")), "no palette line for the fork: {keys:?}");

    harness.with_window(cx, |window, cx| window.press("cmd-shift-f", cx));
    harness.with_window(cx, |window, cx| window.input("needle", cx));
    settle(cx);
    harness.with_window(cx, |window, _| {
        assert!(window.find(search::passage_element_id("s2", "t1-a")).visible());
        assert!(
            window.try_find(search::passage_element_id("f1", "f-a")).is_none(),
            "the fork's passage is left out"
        );
    });
}
