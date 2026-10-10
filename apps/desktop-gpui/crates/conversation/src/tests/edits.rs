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

//! The card under a settled turn that edited files: its files in the order
//! the window gives them, the first three and then the rest in place, and
//! its buttons asking the owner to show the turn's changes.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use transcript_model::edits::{ChangeKind, EditedFile, EditedTurns};

use super::*;
use crate::{ConversationViewEvent, edits_element_id};

/// Rows of a transcript tail: turn `t1` settled, its Edit and its reply;
/// turn `t2`, the live root turn, running.
fn rows() -> Vec<Value> {
    vec![
        json!({"type": "user", "id": "t1", "turnId": "t1", "ts": 1, "text": "Build the report"}),
        json!({"type": "tool_call", "id": "c1", "turnId": "t1", "ts": 2, "toolName": "Edit",
               "args": {"path": "report.py"}, "stepId": "s1"}),
        json!({"type": "tool_result", "id": "r1", "turnId": "t1", "ts": 3, "toolUseId": "c1",
               "isError": false, "content": {"kind": "file_diff", "paths": ["/w/report.py"],
               "diff": "--- a//w/report.py\n+++ b//w/report.py\n@@ -1 +1 @@\n-a\n+b"}}),
        json!({"type": "assistant", "id": "s1", "turnId": "t1", "ts": 4, "text": "Done.",
               "contentOrder": ["tools", "text"], "modelId": "m"}),
        json!({"type": "turn_state", "id": "e1", "turnId": "t1", "ts": 5, "status": "completed"}),
        json!({"type": "user", "id": "t2", "turnId": "t2", "ts": 6, "text": "Again"}),
    ]
}

/// The session open with [`rows`] as its durable tail.
fn open_turns(cx: &mut TestAppContext) -> Harness {
    let rows = rows();
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
    let mut open = open_result(SUBSCRIPTION);
    open["snapshot"]["rootTurn"] =
        json!({"sessionId": SESSION, "turnId": "t2", "runId": RUN, "status": "running"});
    open["transcript"]["durable"]["throughSequence"] = json!(rows.len());
    open["transcript"]["durable"]["fragments"] = json!(fragments);
    let transport = Arc::new(ScriptedHost::default());
    transport.reply("subscription.open", Ok(open));
    let harness = Harness::open(transport, EPOCH, cx);
    harness.select(SESSION, cx);
    harness
}

fn file(path: &str, kind: ChangeKind, counts: Option<(u32, u32)>) -> EditedFile {
    EditedFile::new(path, kind, counts)
}

/// What the window worked out: four files for `t1`, one for the running
/// `t2`.
fn edited() -> EditedTurns {
    let t1: Arc<[EditedFile]> = Arc::from(vec![
        file("workspace/report/build_report.py", ChangeKind::Modified, Some((88, 88))),
        file("notes.md", ChangeKind::Created, Some((3, 0))),
        file("data.txt", ChangeKind::Modified, Some((1, 1))),
        file("old.txt", ChangeKind::Deleted, None),
    ]);
    let t2: Arc<[EditedFile]> = Arc::from(vec![file("a.txt", ChangeKind::Modified, Some((1, 0)))]);
    EditedTurns::new(SESSION, [("t1".to_owned(), t1), ("t2".to_owned(), t2)].into())
}

fn file_id(path: &str) -> ElementId {
    shared::domain_element_id("turn-edits-file", path)
}

/// The card under the settled turn lists its files, the first three and
/// then all four; the running turn has none.
#[gpui_kit::test]
fn a_settled_turn_lists_the_files_it_edited(cx: &mut TestAppContext) {
    let harness = open_turns(cx);
    harness.view.update(cx, |view, cx| view.set_edited_turns(edited(), cx));
    settle(cx);
    let card = edits_element_id("t1");
    let (title, counts, files, more, running) = harness.with_window(cx, |window, _| {
        let within = window.within(card.clone());
        let files: Vec<String> =
            ["workspace/report/build_report.py", "notes.md", "data.txt", "old.txt"]
                .iter()
                .filter_map(|path| {
                    within.try_find(file_id(path)).and_then(|row| row.label().map(str::to_owned))
                })
                .collect();
        (
            within.find("turn-edits-title").label().map(str::to_owned),
            within.find("turn-edits-counts").label().map(str::to_owned),
            files,
            within.find("turn-edits-more").label().map(str::to_owned),
            window.try_find(edits_element_id("t2")).is_some(),
        )
    });
    assert_eq!(title.as_deref(), Some("Edited 4 files"));
    assert_eq!(counts.as_deref(), Some("92 lines added, 89 lines deleted"));
    assert_eq!(
        files,
        [
            "workspace/report/build_report.py, 88 lines added, 88 lines deleted",
            "notes.md, 3 lines added, 0 lines deleted",
            "data.txt, 1 line added, 1 line deleted",
        ]
    );
    assert_eq!(more.as_deref(), Some("Show 1 more file"));
    assert!(!running, "a running turn shows no card");
    // The rows' figures share one trailing edge, inside the card, and the
    // card spans the reading column as the reply above it does.
    let (lanes, card_bounds, reply) = harness.with_window(cx, |window, _| {
        let within = window.within(card.clone());
        let lanes: Vec<_> = ["workspace/report/build_report.py", "notes.md", "data.txt"]
            .iter()
            .map(|path| {
                within.find(shared::domain_element_id("turn-edits-file-counts", path)).bounds()
            })
            .collect();
        let reply = window.find(item_element_id("t1", &ItemKey::Text("s1".into()))).bounds();
        (lanes, window.find(card.clone()).bounds(), reply)
    });
    assert!(lanes.iter().all(|lane| lane.right() == lanes[0].right()), "{lanes:?}");
    assert!(lanes[0].right() < card_bounds.right(), "{lanes:?} {card_bounds:?}");
    assert_eq!((card_bounds.left(), card_bounds.right()), (reply.left(), reply.right()));
    let rows = harness.rows(cx);
    let at = |find: fn(&RowBody) -> bool| rows.iter().position(find).expect("row");
    assert!(
        at(|row| matches!(row, RowBody::Text { .. })) < at(|row| matches!(row, RowBody::Edits(_))),
        "after the turn's reply"
    );

    harness.with_window(cx, |window, cx| window.within(card.clone()).click("turn-edits-more", cx));
    settle(cx);
    let (deleted, more) = harness.with_window(cx, |window, _| {
        let within = window.within(card.clone());
        (
            within.try_find(file_id("old.txt")).and_then(|row| row.label().map(str::to_owned)),
            within.find("turn-edits-more").label().map(str::to_owned),
        )
    });
    assert_eq!(deleted.as_deref(), Some("old.txt, Deleted"), "no counts: what the turn did");
    assert_eq!(more.as_deref(), Some(copy::SHOW_FEWER_FILES.en()));

    harness.with_window(cx, |window, cx| window.within(card.clone()).click("turn-edits-more", cx));
    settle(cx);
    let folded = harness.with_window(cx, |window, _| {
        window.within(card.clone()).try_find(file_id("old.txt")).is_none()
    });
    assert!(folded, "folded back to the first three");
}

/// "View changes" asks the owner for the turn's changes, a file's row for
/// the turn's changes at that file.
#[gpui_kit::test]
fn the_card_asks_for_the_turns_changes(cx: &mut TestAppContext) {
    let harness = open_turns(cx);
    harness.view.update(cx, |view, cx| view.set_edited_turns(edited(), cx));
    settle(cx);
    let events = Rc::new(RefCell::new(Vec::new()));
    let recorded = events.clone();
    cx.update(|cx| {
        cx.subscribe(&harness.view, move |_, event: &ConversationViewEvent, _| {
            recorded.borrow_mut().push(event.clone());
        })
        .detach();
    });
    let card = edits_element_id("t1");
    harness.with_window(cx, |window, cx| window.within(card.clone()).click("turn-edits-view", cx));
    harness
        .with_window(cx, |window, cx| window.within(card.clone()).click(file_id("notes.md"), cx));
    assert_eq!(
        *events.borrow(),
        [
            ConversationViewEvent::ShowTurnChanges { turn_id: "t1".into(), path: None },
            ConversationViewEvent::ShowTurnChanges {
                turn_id: "t1".into(),
                path: Some("notes.md".into())
            },
        ]
    );
}

/// Edits worked out for another session show no card.
#[gpui_kit::test]
fn another_sessions_edits_show_no_card(cx: &mut TestAppContext) {
    let harness = open_turns(cx);
    let mut other = edited();
    other.session_id = "s2".into();
    harness.view.update(cx, |view, cx| view.set_edited_turns(other, cx));
    settle(cx);
    assert!(!harness.rows(cx).iter().any(|row| matches!(row, RowBody::Edits(_))));
}

/// Rows that only add have no deletions' lane: their counts end where
/// "View changes" does. A row shown that deletes lines brings the lane
/// back for every row.
#[gpui_kit::test]
fn the_deletions_lane_shows_only_with_a_row_that_deletes(cx: &mut TestAppContext) {
    let harness = open_turns(cx);
    let t1: Arc<[EditedFile]> = Arc::from(vec![
        file("a.txt", ChangeKind::Modified, Some((5, 0))),
        file("b.txt", ChangeKind::Created, Some((3, 0))),
        file("c.txt", ChangeKind::Modified, Some((2, 0))),
        file("d.txt", ChangeKind::Modified, Some((1, 4))),
    ]);
    let edited = EditedTurns::new(SESSION, [("t1".to_owned(), t1)].into());
    harness.view.update(cx, |view, cx| view.set_edited_turns(edited, cx));
    settle(cx);
    let card = edits_element_id("t1");
    let measure = |cx: &mut TestAppContext| {
        harness.with_window(cx, |window, _| {
            let within = window.within(card.clone());
            let counts = shared::domain_element_id("turn-edits-file-counts", "a.txt");
            (within.find(counts).bounds(), within.find("turn-edits-view").bounds())
        })
    };
    let (counts, view) = measure(cx);
    assert_eq!(counts.size.width, px(40.), "one lane");
    assert_eq!(counts.right(), view.right(), "ending where View changes does");

    harness.with_window(cx, |window, cx| window.within(card.clone()).click("turn-edits-more", cx));
    settle(cx);
    let (counts, view) = measure(cx);
    assert_eq!(counts.size.width, px(84.), "both lanes, with d.txt shown");
    assert_eq!(counts.right(), view.right());
}
