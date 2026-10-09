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

//! Older history: reaching the top of the transcript reads the previous page
//! (`session.transcript.page` `older`), the rows go above without moving the
//! view, and the first row says when the Session's start is reached.

use super::*;
use host_protocol::HostOperationErrorCode;

use crate::rows::{HistoryRow, history_element_id};
use crate::{OLDER_PAGE_BYTES, OlderHistory};

/// The rows of one finished Turn, starting at `first`: the prompt, a reply
/// of `paragraphs` paragraphs, and the terminal state.
fn turn_rows(turn: &str, first: u64, paragraphs: usize) -> Vec<(u64, Value)> {
    let reply: String =
        (1..=paragraphs).map(|n| format!("Reply {turn} paragraph {n}.\n\n")).collect();
    vec![
        (first, json!({"type": "user", "id": turn, "turnId": turn, "ts": first, "text": turn})),
        (
            first + 8,
            json!({"type": "assistant", "id": format!("{turn}-a"), "turnId": turn,
                   "ts": first + 8, "text": reply, "contentOrder": ["text"],
                   "modelId": "qwen2.5:7b"}),
        ),
        (
            first + 16,
            json!({"type": "turn_state", "id": format!("{turn}-end"), "turnId": turn,
                   "ts": first + 16, "status": "completed"}),
        ),
    ]
}

/// An `older` page through watermark 72: `rows` newest first on the wire.
fn older_page(rows: &[(u64, Value)], next: Option<&str>) -> Value {
    let mut raw = 0;
    let fragments: Vec<Value> = rows
        .iter()
        .rev()
        .map(|(sequence, row)| {
            let bytes = serde_json::to_vec(row).expect("row");
            raw += bytes.len();
            json!({
                "sequence": sequence, "byteOffset": 0, "totalBytes": bytes.len(),
                "payloadDigest": null,
                "data": base64::engine::general_purpose::STANDARD.encode(&bytes)
            })
        })
        .collect();
    json!({
        "kind": "page", "sessionId": SESSION, "direction": "older", "throughSequence": 72,
        "rawBytes": raw, "fragments": fragments, "nextCursor": next, "endsAtTurnBoundary": true
    })
}

/// A session whose tail holds Turn `t3`, a reply taller than the window,
/// with older history behind cursor `c1`.
fn open_with_history(cx: &mut TestAppContext) -> Harness {
    let mut open = open_result(SUBSCRIPTION);
    open["transcript"]["durable"] = older_page(&turn_rows("t3", 56, 120), Some("c1"));
    let transport = Arc::new(ScriptedHost::default());
    transport.reply("subscription.open", Ok(open));
    let harness = Harness::open(transport, EPOCH, cx);
    harness.select(SESSION, cx);
    harness
}

fn older(harness: &Harness, cx: &mut TestAppContext) -> OlderHistory {
    harness.state.read_with(cx, |state, _| state.older_history())
}

fn history_label(harness: &Harness, cx: &mut TestAppContext) -> Option<String> {
    harness.with_window(cx, |window, _| {
        window.try_find(history_element_id())?;
        let status = window.within(history_element_id()).try_find("transcript-history")?;
        status.label().map(str::to_owned)
    })
}

fn press(harness: &Harness, key: &str, cx: &mut TestAppContext) {
    harness.with_window(cx, |window, cx| window.press(key, cx));
}

#[gpui_kit::test]
fn reaching_the_top_prepends_older_turns_without_moving_the_view(cx: &mut TestAppContext) {
    let harness = open_with_history(cx);
    assert_eq!(older(&harness, cx), OlderHistory::Available);
    assert!(following_tail(&harness, cx), "the transcript opens at its latest output");
    assert!(
        harness.transport.requests("session.transcript.page").is_empty(),
        "nothing older is read while the top is out of view"
    );

    // Home reaches the top: the previous page is read, with the tail's
    // cursor at the tail's watermark.
    let page = harness.transport.hold("session.transcript.page");
    harness.with_window(cx, |window, cx| window.focus_next(cx));
    press(&harness, "home", cx);
    assert_eq!(
        harness.transport.requests("session.transcript.page"),
        [json!({
            "subscriptionId": SUBSCRIPTION, "direction": "older", "throughSequence": 72,
            "cursor": "c1", "anchorSequence": null, "maxBytes": OLDER_PAGE_BYTES
        })]
    );
    assert_eq!(older(&harness, cx), OlderHistory::Loading);
    assert_eq!(history_label(&harness, cx).as_deref(), Some(copy::OLDER_HISTORY_LOADING.en()));

    // The rows go above; the first message on screen stays where it was.
    let first = item_element_id("t3", &ItemKey::User("t3".into()));
    let before = row_top(&harness, first.clone(), cx);
    let mut rows = turn_rows("t1", 8, 2);
    rows.extend(turn_rows("t2", 32, 2));
    page.try_send(Ok(older_page(&rows, None))).expect("release");
    settle(cx);
    assert_near(row_top(&harness, first.clone(), cx), before, "the view did not move");
    assert_eq!(older(&harness, cx), OlderHistory::Reached);
    let turns: Vec<String> = harness.state.read_with(cx, |state, _| {
        state.transcript().expect("transcript").turns().iter().map(|t| t.turn_id.clone()).collect()
    });
    assert_eq!(turns, ["t1", "t2", "t3"]);
    assert_eq!(
        harness.rows(cx).first(),
        Some(&RowBody::History(HistoryRow::Beginning)),
        "the first row marks the start"
    );

    // Home again shows the start; there is nothing more to read.
    press(&harness, "home", cx);
    assert_eq!(history_label(&harness, cx).as_deref(), Some(copy::TASK_BEGINNING.en()));
    harness.with_window(cx, |window, _| {
        assert!(window.find(item_element_id("t1", &ItemKey::User("t1".into()))).visible());
    });
    assert_eq!(harness.transport.requests("session.transcript.page").len(), 1);
}

#[gpui_kit::test]
fn a_short_transcript_loads_older_history_as_soon_as_its_top_shows(cx: &mut TestAppContext) {
    let mut open = open_result(SUBSCRIPTION);
    open["transcript"]["durable"] = older_page(&turn_rows("t3", 56, 1), Some("c1"));
    let transport = Arc::new(ScriptedHost::default());
    transport.reply("subscription.open", Ok(open));
    transport.reply("session.transcript.page", Ok(older_page(&turn_rows("t2", 32, 1), None)));
    let harness = Harness::open(transport, EPOCH, cx);
    harness.select(SESSION, cx);
    // The first frame paints the history row inside the viewport.
    harness.with_window(cx, |_, _| {});
    settle(cx);
    assert_eq!(harness.transport.requests("session.transcript.page").len(), 1);
    assert_eq!(older(&harness, cx), OlderHistory::Reached);
    assert_eq!(history_label(&harness, cx).as_deref(), Some(copy::TASK_BEGINNING.en()));
}

#[gpui_kit::test]
fn a_failed_read_offers_retry_and_a_refused_cursor_reopens(cx: &mut TestAppContext) {
    let harness = open_with_history(cx);
    harness.transport.reply(
        "session.transcript.page",
        Err(HostRequestError::Transport("the connection dropped a frame".into())),
    );
    harness.state.update(cx, |state, cx| state.load_older_history(cx));
    settle(cx);
    let OlderHistory::Failed(message) = older(&harness, cx) else { panic!("a failure") };
    assert!(message.starts_with(copy::OLDER_HISTORY_FAILED.en()), "{message}");
    // Home tries again, and so does the row's Retry; merely showing a
    // failed row does not, so a failure never loops.
    harness.with_window(cx, |window, cx| {
        window.focus_next(cx);
        window.press("home", cx);
    });
    settle(cx);
    assert_eq!(harness.transport.requests("session.transcript.page").len(), 2);
    assert!(matches!(older(&harness, cx), OlderHistory::Failed(_)));
    harness.with_window(cx, |window, cx| window.click("older-history-retry", cx));
    settle(cx);
    harness.with_window(cx, |_, _| {});
    settle(cx);
    assert_eq!(harness.transport.requests("session.transcript.page").len(), 3);

    // The Host no longer honors the cursor: open a new tail instead.
    harness.transport.reply(
        "session.transcript.page",
        Err(HostRequestError::Operation {
            operation: "session.transcript.page",
            code: HostOperationErrorCode::InvalidRequest,
            message: "Transcript cursor does not match request".into(),
        }),
    );
    harness.transport.reply("subscription.open", Ok(open_result("sub-2")));
    harness.state.update(cx, |state, cx| state.load_older_history(cx));
    settle(cx);
    assert_eq!(harness.transport.requests("subscription.open").len(), 2);
    assert_eq!(harness.phase(cx), ConversationPhase::Live);
    assert_eq!(older(&harness, cx), OlderHistory::None, "the new tail holds the whole Session");
}
