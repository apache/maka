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

//! Find in the conversation in the window: ⌘F in the task view, the bar's
//! place over the transcript, and the command in the palette and the
//! keyboard shortcuts sheet.

use base64::Engine as _;
use gpui_kit::component::kbd::Kbd;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{AsKeystroke as _, Focusable as _, KeyContext, TestAppContext, px, size};
use shared::domain_element_id;

use crate::TASK_VIEW_CONTEXT;
use crate::chrome_tests::row;
use crate::tests::{EPOCH, Harness, ScriptedHost, session, settle};
use serde_json::{Value, json};

/// Task `s1`'s `subscription.open`: one settled turn in its tail.
fn open_with_a_turn() -> Value {
    let rows = [
        json!({"type": "user", "id": "t1", "turnId": "t1", "ts": 1, "text": "Where is the needle?"}),
        json!({"type": "assistant", "id": "t1-a", "turnId": "t1", "ts": 2,
               "text": "The **needle** is here.", "contentOrder": ["text"], "modelId": "m"}),
        json!({"type": "turn_state", "id": "t1-end", "turnId": "t1", "ts": 3,
               "status": "completed"}),
    ];
    let fragments: Vec<Value> = rows
        .iter()
        .enumerate()
        .rev()
        .map(|(ix, row)| {
            let bytes = serde_json::to_vec(row).expect("row");
            json!({
                "sequence": ix + 1, "byteOffset": 0, "totalBytes": bytes.len(),
                "payloadDigest": null,
                "data": base64::engine::general_purpose::STANDARD.encode(&bytes)
            })
        })
        .collect();
    json!({
        "hostEpoch": EPOCH, "subscriptionId": "sub-s1", "nextSequence": 1,
        "snapshot": {
            "schemaVersion": 5,
            "session": {"sessionId": "s1", "metadataRevision": 1, "status": "active",
                        "createdAt": 1, "isArchived": false},
            "projectionRevision": 1, "rootTurn": null, "goal": null,
            "queue": {"hostEpoch": EPOCH, "queueRevision": 0, "steering": [], "followup": []},
            "interactions": {"pending": []}
        },
        "activeAssistantStreams": [],
        "transcript": {"durable": {
            "kind": "page", "sessionId": "s1", "direction": "older", "throughSequence": 3,
            "rawBytes": 0, "fragments": fragments, "nextCursor": null,
            "endsAtTurnBoundary": true
        }}
    })
}

/// Task `s1` selected, a turn in it, and "hello" in its draft.
fn task_with_a_turn(cx: &mut TestAppContext) -> Harness {
    let transport = ScriptedHost::new(vec![session("s1", "Alpha", "/work/demo", "active")]);
    transport.reply("subscription.open", Ok(open_with_a_turn()));
    let harness = Harness::with_transport(transport, cx);
    harness.with_window(cx, |window, cx| window.click(row("s1"), cx));
    let draft = harness.draft_id(cx);
    harness.with_window(cx, |window, cx| {
        window.click(draft.clone(), cx);
        window.input("hello", cx);
    });
    harness
}

fn find_open(harness: &Harness, cx: &mut TestAppContext) -> bool {
    harness
        .workbench
        .read_with(cx, |workbench, cx| workbench.conversation().read(cx).is_find_open())
}

/// Whether the bar's query has keyboard focus.
fn query_focused(harness: &Harness, cx: &mut TestAppContext) -> bool {
    let bar = harness
        .workbench
        .read_with(cx, |workbench, cx| workbench.conversation().read(cx).find_bar().cloned())
        .expect("the bar was shown");
    harness.with_window(cx, |window, cx| {
        bar.read(cx).query().read(cx).focus_handle(cx).is_focused(window)
    })
}

/// The bar over the transcript: under the plate's header, inside the
/// transcript's edges, at most about 360 pt wide.
fn assert_placed(harness: &Harness, cx: &mut TestAppContext) {
    harness.with_window(cx, |window, _| {
        let header = window.find("main-header").bounds();
        let transcript = window.find("conversation-transcript").bounds();
        let bar = window.find("find-bar").bounds();
        assert!(bar.top() >= header.bottom(), "under the header: {bar:?} {header:?}");
        assert!(bar.top() >= transcript.top() && bar.top() <= transcript.top() + px(12.));
        assert!(bar.left() >= transcript.left() && bar.right() <= transcript.right(), "{bar:?}");
        assert!(bar.size.width <= px(360.5), "{bar:?}");
        assert!(transcript.right() - bar.right() <= px(16.), "at the top right: {bar:?}");
        // One row of controls, all inside the bar, the query widest.
        let query = window.find("find-query").bounds();
        let close = window.find("find-close").bounds();
        assert!(query.left() >= bar.left() && close.right() <= bar.right(), "{query:?} {close:?}");
        assert!(query.top() < close.bottom() && close.top() < query.bottom(), "one row");
        assert!(query.size.width >= px(80.), "room to type: {query:?}");
    });
}

#[gpui_kit::test]
fn command_f_in_the_task_view_opens_the_bar_and_escape_returns_to_the_draft(
    cx: &mut TestAppContext,
) {
    let harness = task_with_a_turn(cx);
    let draft = harness.draft_id(cx);
    harness.with_window(cx, |window, cx| window.press("cmd-f", cx));
    assert!(find_open(&harness, cx));
    assert!(query_focused(&harness, cx), "the query has focus");
    assert_eq!(harness.draft(cx), "hello", "the draft keeps its text");
    assert_placed(&harness, cx);
    harness.with_window(cx, |window, _| {
        let bar = window.find("find-bar").bounds();
        assert!((bar.size.width - px(360.)).abs() < px(1.), "360 pt in a wide window: {bar:?}");
    });
    // ⌘F again selects the query; Escape closes the bar and gives focus
    // back to the draft.
    harness.with_window(cx, |window, cx| window.input("needle", cx));
    harness.with_window(cx, |window, cx| window.press("cmd-f", cx));
    harness.with_window(cx, |window, cx| window.input("other", cx));
    let query = harness.workbench.read_with(cx, |workbench, cx| {
        let bar = workbench.conversation().read(cx).find_bar().cloned().expect("bar");
        bar.read(cx).query().read(cx).value().to_string()
    });
    assert_eq!(query, "other", "the existing query was selected and replaced");
    harness.with_window(cx, |window, cx| window.press("escape", cx));
    assert!(!find_open(&harness, cx));
    harness.with_window(cx, |window, _| {
        assert!(window.try_find("find-bar").is_none());
        assert_eq!(window.find(draft.clone()).focused(), Some(true), "back in the draft");
    });
}

/// Lets the changes panel's read of the task folder (a real `git` on a
/// background thread) finish.
#[allow(clippy::disallowed_methods)] // A test waiting on a real subprocess.
fn wait_for_the_panel(harness: &Harness, cx: &mut TestAppContext) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        settle(cx);
        let busy = harness.workbench.read_with(cx, |workbench, cx| {
            let panel = workbench.review_panel().read(cx);
            panel.is_loading() || panel.turn_changes().read(cx).is_computing()
        });
        if !busy || std::time::Instant::now() > deadline {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    harness.with_window(cx, |_, _| {});
}

#[gpui_kit::test]
fn the_bar_fits_beside_the_changes_panel_and_in_a_narrow_window(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let harness = task_with_a_turn(cx);
    harness.with_window(cx, |window, cx| window.click("review-toggle", cx));
    wait_for_the_panel(&harness, cx);
    harness.with_window(cx, |window, cx| window.press("cmd-f", cx));
    assert!(find_open(&harness, cx));
    assert_placed(&harness, cx);
    harness.with_window(cx, |window, _| {
        assert!(window.find("review-panel").visible(), "the panel stays open");
    });
    cx.simulate_window_resize(harness.window.into(), size(px(560.), px(700.)));
    harness.with_window(cx, |_, _| {});
    assert_placed(&harness, cx);
}

#[gpui_kit::test]
fn the_palette_and_the_shortcuts_sheet_offer_find_in_conversation(cx: &mut TestAppContext) {
    let harness = task_with_a_turn(cx);
    let entry = domain_element_id("palette-entry", "command:find-in-conversation");
    harness.with_window(cx, |window, cx| window.press("cmd-k", cx));
    harness.with_window(cx, |window, cx| window.input("find in conversation", cx));
    // The line shows the key that runs it in the task view.
    let keys = harness.with_window(cx, |window, _| {
        assert!(window.find(entry.clone()).visible());
        let context = KeyContext::parse(TASK_VIEW_CONTEXT).expect("context");
        let action = workspace::actions::FindInConversation;
        window
            .bindings_for_action_in_context(&action, context)
            .iter()
            .filter_map(|binding| binding.keystrokes().first())
            .map(|keystroke| Kbd::format(keystroke.as_keystroke()))
            .collect::<Vec<_>>()
    });
    assert_eq!(keys, ["⌘F"]);
    harness.with_window(cx, |window, cx| window.press("enter", cx));
    assert!(find_open(&harness, cx), "choosing it opens the bar");
    assert!(query_focused(&harness, cx));
    harness.with_window(cx, |window, cx| window.press("escape", cx));

    harness.with_window(cx, |window, cx| window.press("cmd-/", cx));
    harness.with_window(cx, |window, _| {
        for (id, keys) in
            [("find-in-conversation", "⌘F"), ("next-match", "⌘G"), ("previous-match", "⇧⌘G")]
        {
            let line = window.find(domain_element_id("shortcut", id));
            let label = line.label().expect("label");
            assert!(label.ends_with(keys), "{id}: {label}");
        }
    });
}

#[gpui_kit::test]
fn an_empty_task_has_nothing_to_find(cx: &mut TestAppContext) {
    let harness = Harness::open(vec![session("s1", "Alpha", "/work/demo", "active")], cx);
    harness.with_window(cx, |window, cx| window.click(row("s1"), cx));
    let draft = harness.draft_id(cx);
    harness.with_window(cx, |window, cx| {
        window.click(draft.clone(), cx);
        window.press("cmd-f", cx);
    });
    assert!(!find_open(&harness, cx));
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find(draft.clone()).focused(), Some(true), "the draft keeps focus");
    });
    let listed = harness.workbench.read_with(cx, |workbench, cx| {
        workbench
            .palette_entries(cx)
            .iter()
            .any(|entry| entry.key.as_ref() == "command:find-in-conversation")
    });
    assert!(!listed, "the palette offers it only with a conversation to find in");
}
