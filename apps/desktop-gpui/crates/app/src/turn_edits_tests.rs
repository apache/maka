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

//! UI integration tests of what a turn edited, in the window: the card
//! under the settled turn with each file's net lines, worked out from the
//! files on this machine, and its buttons opening the changes panel on the
//! turn. The task's folder is in the system's temporary folder, in no
//! repository, as a task's folder may be.

// Setup writes the files the turn's tools edited; the settle loop waits on
// the work that reads them on the blocking pool.
#![allow(clippy::disallowed_methods)]

use std::path::PathBuf;
use std::time::{Duration, Instant};

use base64::Engine as _;
use gpui_kit::TestAppContext;
use gpui_kit::test::TestWindowExt as _;
use serde_json::{Value, json};

use crate::tests::{EPOCH, Harness, ScriptedHost, session, settle};

/// The task's folder, removed when dropped.
struct Folder(PathBuf);

impl Folder {
    fn new(name: &str) -> Self {
        let dir =
            std::env::temp_dir().join(format!("app-turn-edits-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).expect("folder");
        Self(dir)
    }

    fn path(&self, name: &str) -> String {
        self.0.join(name).to_string_lossy().into_owned()
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).ok();
    }
}

/// Turn `t1`: `Edit` twice on `report.py` (its third and eighth lines), a
/// `Write` creating `notes.md`, a `Bash` call, and `apply_patch` updating
/// `data.txt` and deleting `old.txt`, then its reply. The folder holds the
/// files as the turn left them.
fn turn_rows(folder: &Folder) -> Vec<Value> {
    std::fs::write(folder.0.join("report.py"), "a1\na2\nA3\na4\na5\na6\na7\nA8\na9\na10\n")
        .expect("write");
    std::fs::write(folder.0.join("notes.md"), "# Notes\n\nfirst\n").expect("write");
    std::fs::write(folder.0.join("data.txt"), "x\nY\nz\n").expect("write");
    let (report, notes) = (folder.path("report.py"), folder.path("notes.md"));
    let diff = |path: &str, hunks: &str| {
        json!({"kind": "file_diff", "paths": [path],
               "diff": format!("--- a/{path}\n+++ b/{path}\n{hunks}")})
    };
    let call = |id: &str, tool: &str, args: Value| {
        json!({"type": "tool_call", "id": id, "turnId": "t1", "ts": 2, "toolName": tool,
               "args": args, "stepId": "s1"})
    };
    let result = |id: &str, content: Value| {
        json!({"type": "tool_result", "id": format!("r-{id}"), "turnId": "t1", "ts": 3,
               "toolUseId": id, "isError": false, "content": content})
    };
    let patch = "*** Begin Patch\n*** Update File: data.txt\n@@\n x\n-y\n+Y\n z\n\
                 *** Delete File: old.txt\n*** End Patch";
    vec![
        json!({"type": "user", "id": "t1", "turnId": "t1", "ts": 1, "text": "Build the report"}),
        call("c1", "Edit", json!({"path": "report.py"})),
        result("c1", diff(&report, "@@ -1,6 +1,6 @@\n a1\n a2\n-a3\n+A3\n a4\n a5\n a6")),
        call("c2", "Edit", json!({"path": "report.py"})),
        result("c2", diff(&report, "@@ -5,6 +5,6 @@\n a5\n a6\n a7\n-a8\n+A8\n a9\n a10")),
        call("c3", "Write", json!({"path": "notes.md", "content": "# Notes\n\nfirst\n"})),
        result(
            "c3",
            json!({"kind": "file_diff", "paths": [notes], "diff": format!(
                "--- /dev/null\n+++ b/{notes}\n@@ -0,0 +1,3 @@\n+# Notes\n+\n+first")}),
        ),
        call("c4", "Bash", json!({"command": "python report.py"})),
        result("c4", json!({"kind": "text", "text": ""})),
        call("c5", "apply_patch", json!(patch)),
        result("c5", json!({"kind": "json", "value": {"status": "completed"}})),
        json!({"type": "assistant", "id": "s1", "turnId": "t1", "ts": 4, "text": "Done.",
               "contentOrder": ["tools", "text"], "modelId": "m"}),
        json!({"type": "turn_state", "id": "e1", "turnId": "t1", "ts": 5, "status": "completed"}),
    ]
}

/// Turn `t1` in Code Mode, as a real Host stores it at epoch 197: a step,
/// then one code cell (`exec`) whose script writes `notes.md` (new), edits
/// `report.py`'s eighth line and runs a command, each call a row of its own
/// (`<exec id>:nested:<id>`, origin `code_mode`, the `exec` its parent),
/// then the reply. The folder holds the files as the turn left them.
fn code_cell_rows(folder: &Folder) -> Vec<Value> {
    std::fs::write(folder.0.join("report.py"), "a1\na2\na3\na4\na5\na6\na7\nA8\na9\na10\n")
        .expect("write");
    std::fs::write(folder.0.join("notes.md"), "# Notes\n\nfirst\n").expect("write");
    let (report, notes) = (folder.path("report.py"), folder.path("notes.md"));
    let step = |id: &str, text: &str| {
        json!({"type": "assistant", "id": id, "turnId": "t1", "ts": 2, "text": text,
               "thinking": {"text": "Plan the next step."},
               "contentOrder": ["thinking", "text", "tools"], "modelId": "m"})
    };
    let nested = |row: Value| {
        let mut row = row;
        row["origin"] = json!("code_mode");
        row["modelVisibility"] = json!("hidden");
        row["parentToolCallId"] = json!("call_e1");
        row["parentOperationId"] = json!("op-exec");
        row
    };
    let call = |id: &str, tool: &str, args: Value| {
        nested(json!({"type": "tool_call", "id": format!("call_e1:nested:{id}"), "turnId": "t1",
                      "ts": 3, "toolName": tool, "args": args, "stepId": "call_e1:nested"}))
    };
    let result = |id: &str, content: Value| {
        nested(json!({"type": "tool_result", "id": format!("op-{id}_response"), "turnId": "t1",
                      "ts": 3, "toolUseId": format!("call_e1:nested:{id}"), "isError": false,
                      "content": content}))
    };
    vec![
        json!({"type": "user", "id": "t1", "turnId": "t1", "ts": 1, "text": "Write the notes"}),
        step("s1", ""),
        json!({"type": "tool_call", "id": "call_e1", "turnId": "t1", "ts": 2, "toolName": "exec",
               "stepId": "s1", "origin": "provider", "modelVisibility": "visible",
               "args": {"code": "await tools.Write({path: \"notes.md\", content: \"…\"});"}}),
        call("u1", "Write", json!({"path": "notes.md", "content": "# Notes\n\nfirst\n"})),
        result(
            "u1",
            json!({"kind": "file_diff", "paths": [notes], "diff": format!(
                "--- /dev/null\n+++ b/{notes}\n@@ -0,0 +1,3 @@\n+# Notes\n+\n+first")}),
        ),
        call("u2", "Edit", json!({"path": "report.py", "old_string": "a8", "new_string": "A8"})),
        result(
            "u2",
            json!({"kind": "file_diff", "paths": [report], "diff": format!(
                "--- a/{report}\n+++ b/{report}\n\
                 @@ -5,6 +5,6 @@\n a5\n a6\n a7\n-a8\n+A8\n a9\n a10")}),
        ),
        call("u3", "Bash", json!({"command": "python report.py"})),
        result("u3", json!({"kind": "text", "text": ""})),
        json!({"type": "tool_result", "id": "op-exec_response", "turnId": "t1", "ts": 4,
               "toolUseId": "call_e1", "isError": false, "origin": "provider",
               "modelVisibility": "visible", "content": {"kind": "json", "value": {"ok": true}}}),
        step("s2", "Done."),
        json!({"type": "turn_state", "id": "e1", "turnId": "t1", "ts": 5, "status": "completed"}),
    ]
}

/// Session `s1`'s `subscription.open`, its durable tail `rows`.
fn open_with(rows: &[Value]) -> Value {
    open_with_tail(older_page(rows, 1, rows.len(), None))
}

/// An `older` page of session `s1` read at `through`: `rows`, numbered from
/// `first`, newest first as the Host sends them. With a cursor `next` to
/// older rows, it stops inside a turn.
fn older_page(rows: &[Value], first: usize, through: usize, next: Option<&str>) -> Value {
    let fragments: Vec<Value> = rows
        .iter()
        .enumerate()
        .rev()
        .map(|(ix, row)| {
            let bytes = serde_json::to_vec(row).expect("row");
            json!({
                "sequence": first + ix, "byteOffset": 0, "totalBytes": bytes.len(),
                "payloadDigest": null,
                "data": base64::engine::general_purpose::STANDARD.encode(&bytes)
            })
        })
        .collect();
    json!({
        "kind": "page", "sessionId": "s1", "direction": "older", "throughSequence": through,
        "rawBytes": 0, "fragments": fragments, "nextCursor": next,
        "endsAtTurnBoundary": next.is_none()
    })
}

/// Session `s1`'s `subscription.open` with the durable tail `tail`.
fn open_with_tail(tail: Value) -> Value {
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
        "transcript": {"durable": tail}
    })
}

/// The window on task `s1` in `folder`, whose transcript holds the turn.
fn open(folder: &Folder, cx: &mut TestAppContext) -> Harness {
    cx.executor().allow_parking();
    let path = folder.0.to_string_lossy().into_owned();
    let transport = ScriptedHost::new(vec![session("s1", "Alpha", &path, "active")]);
    transport.reply("subscription.open", Ok(open_with(&turn_rows(folder))));
    let harness = Harness::with_transport(transport, cx);
    wait(&harness, cx);
    harness
}

/// Runs the window's work to its end: the turns' changes, and the panel's
/// reads.
fn wait(harness: &Harness, cx: &mut TestAppContext) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        settle(cx);
        let busy = harness.workbench.read_with(cx, |workbench, cx| {
            let panel = workbench.review_panel().read(cx);
            panel.is_loading() || panel.turn_changes().read(cx).is_computing()
        });
        if !busy || Instant::now() > deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    harness.with_window(cx, |_, _| {});
}

fn label(
    harness: &Harness,
    within: gpui_kit::ElementId,
    id: impl Into<gpui_kit::ElementId>,
    cx: &mut TestAppContext,
) -> Option<String> {
    let id = id.into();
    harness.with_window(cx, |window, _| {
        window.within(within).try_find(id).and_then(|element| element.label().map(str::to_owned))
    })
}

fn file_id(path: &str) -> gpui_kit::ElementId {
    shared::domain_element_id("turn-edits-file", path)
}

/// The card under the turn lists its four files in the order it first
/// edited them, the two Edits of `report.py` as one net change; the file it
/// deleted, unknown before, says so.
#[gpui_kit::test]
fn the_card_lists_the_turns_files_with_their_net_lines(cx: &mut TestAppContext) {
    let folder = Folder::new("card");
    let harness = open(&folder, cx);
    let card = conversation::edits_element_id("t1");
    assert_eq!(
        label(&harness, card.clone(), "turn-edits-title", cx).as_deref(),
        Some("Edited 4 files")
    );
    assert_eq!(
        label(&harness, card.clone(), "turn-edits-counts", cx).as_deref(),
        Some("6 lines added, 3 lines deleted")
    );
    let rows: Vec<Option<String>> = ["report.py", "notes.md", "data.txt", "old.txt"]
        .iter()
        .map(|path| label(&harness, card.clone(), file_id(path), cx))
        .collect();
    assert_eq!(
        rows,
        [
            Some("report.py, 2 lines added, 2 lines deleted".to_owned()),
            Some("notes.md, 3 lines added, 0 lines deleted".to_owned()),
            Some("data.txt, 1 line added, 1 line deleted".to_owned()),
            None,
        ]
    );
    harness.with_window(cx, |window, cx| window.within(card.clone()).click("turn-edits-more", cx));
    assert_eq!(
        label(&harness, card.clone(), file_id("old.txt"), cx).as_deref(),
        Some("old.txt, Deleted")
    );
}

/// "View changes" opens the changes panel on the turn, which a folder in no
/// repository shows instead of saying so; a file's row shows that file.
#[gpui_kit::test]
fn view_changes_opens_the_panel_on_the_turn(cx: &mut TestAppContext) {
    let folder = Folder::new("panel");
    let harness = open(&folder, cx);
    let card = conversation::edits_element_id("t1");
    assert!(harness.with_window(cx, |window, _| window.try_find("workbar-pane").is_none()));
    harness.with_window(cx, |window, cx| window.within(card.clone()).click("turn-edits-view", cx));
    wait(&harness, cx);
    let (shown, failure) = harness.with_window(cx, |window, _| {
        (
            window.try_find("review-turn-label").and_then(|label| label.label().map(str::to_owned)),
            window
                .try_find(shared::domain_element_id("settings-status", "review-failure"))
                .is_some(),
        )
    });
    assert_eq!(shown.as_deref(), Some("Build the report"), "the panel opens on the turn");
    assert!(!failure, "no repository is no failure where the turn shows");
    let turn = harness.workbench.read_with(cx, |workbench, cx| {
        workbench.review_panel().read(cx).shown_turn().map(ToString::to_string)
    });
    assert_eq!(turn.as_deref(), Some("t1"));

    harness
        .with_window(cx, |window, cx| window.within(card.clone()).click(file_id("data.txt"), cx));
    wait(&harness, cx);
    let selected = harness.workbench.read_with(cx, |workbench, cx| {
        workbench.review_panel().read(cx).selected_file().map(ToString::to_string)
    });
    assert_eq!(selected.as_deref(), Some("data.txt"));
    let header = shared::domain_element_id("review-file-header", "data.txt");
    assert!(harness.with_window(cx, |window, _| window.try_find(header).is_some()));
}

/// A Code Mode turn too large for the transcript's 16 KiB tail: the window
/// opens on its reply, reads the rest of it as older history, and then
/// cards the files its code cell wrote, as it would had the turn been read
/// whole (F29: the card never showed, the turn's edits read once from the
/// tail alone).
#[gpui_kit::test]
fn the_card_counts_a_code_cell_turn_the_tail_cut(cx: &mut TestAppContext) {
    let folder = Folder::new("cut");
    let rows = code_cell_rows(&folder);
    // The tail starts at the `exec`'s result; the older page has the rest.
    let (older, tail) = rows.split_at(9);
    cx.executor().allow_parking();
    let path = folder.0.to_string_lossy().into_owned();
    let transport = ScriptedHost::new(vec![session("s1", "Alpha", &path, "active")]);
    let tail = older_page(tail, older.len() + 1, rows.len(), Some("c1"));
    transport.reply("subscription.open", Ok(open_with_tail(tail)));
    transport.reply("session.transcript.page", Ok(older_page(older, 1, rows.len(), None)));
    let harness = Harness::with_transport(transport.clone(), cx);
    wait(&harness, cx);
    assert_eq!(
        transport.requests("session.transcript.page").len(),
        1,
        "the rest of the turn was read as older history"
    );
    let card = conversation::edits_element_id("t1");
    assert_eq!(
        label(&harness, card.clone(), "turn-edits-title", cx).as_deref(),
        Some("Edited 2 files")
    );
    let rows: Vec<Option<String>> = ["notes.md", "report.py"]
        .iter()
        .map(|path| label(&harness, card.clone(), file_id(path), cx))
        .collect();
    assert_eq!(
        rows,
        [
            Some("notes.md, 3 lines added, 0 lines deleted".to_owned()),
            Some("report.py, 1 line added, 1 line deleted".to_owned()),
        ]
    );
}

/// Turn `t1` of [`turn_rows`] with a reply taller than the window, so a
/// tail of its last rows fills the transcript.
fn turn_rows_long_reply(folder: &Folder) -> Vec<Value> {
    let mut rows = turn_rows(folder);
    let reply: String =
        (1..=40).map(|n| format!("Paragraph {n} on how the report was built.\n\n")).collect();
    rows[11]["text"] = json!(reply);
    rows
}

/// The window on task `s1` whose transcript tail is `rows` from
/// `tail_from` on, cut inside turn `t1` (older history behind cursor `c1`).
/// The first read of older history waits for the returned sender.
fn open_cut(
    folder: &Folder,
    rows: &[Value],
    tail_from: usize,
    cx: &mut TestAppContext,
) -> (Harness, async_channel::Sender<Result<Value, workspace::HostRequestError>>) {
    cx.executor().allow_parking();
    let path = folder.0.to_string_lossy().into_owned();
    let transport = ScriptedHost::new(vec![session("s1", "Alpha", &path, "active")]);
    let tail = older_page(&rows[tail_from..], tail_from + 1, rows.len(), Some("c1"));
    transport.reply("subscription.open", Ok(open_with_tail(tail)));
    let page = transport.hold("session.transcript.page");
    let harness = Harness::with_transport(transport, cx);
    wait(&harness, cx);
    (harness, page)
}

fn has_card(harness: &Harness, cx: &mut TestAppContext) -> bool {
    harness.with_window(cx, |window, _| {
        window.try_find(conversation::edits_element_id("t1")).is_some()
    })
}

fn footer_top(harness: &Harness, cx: &mut TestAppContext) -> gpui_kit::Pixels {
    harness.with_window(cx, |window, _| {
        window.find(conversation::footer_element_id("t1")).bounds().top()
    })
}

/// The card lists all four files of turn `t1`, the first of them edited at
/// the turn's start.
fn assert_whole_card(harness: &Harness, cx: &mut TestAppContext) {
    let card = conversation::edits_element_id("t1");
    assert_eq!(
        label(harness, card.clone(), "turn-edits-title", cx).as_deref(),
        Some("Edited 4 files")
    );
    assert_eq!(
        label(harness, card.clone(), "turn-edits-counts", cx).as_deref(),
        Some("6 lines added, 3 lines deleted")
    );
    assert_eq!(
        label(harness, card, file_id("report.py"), cx).as_deref(),
        Some("report.py, 2 lines added, 2 lines deleted")
    );
}

/// A task whose last turn is larger than the tail opens on the turn's
/// reply, which fills the transcript: no card, because the turn's start
/// and its edits are older history. The window reads it on its own, in the
/// background, and then cards the whole turn, its end where it was.
#[gpui_kit::test]
fn a_turn_larger_than_the_tail_cards_once_its_start_is_read(cx: &mut TestAppContext) {
    let folder = Folder::new("whole");
    let rows = turn_rows_long_reply(&folder);
    // The tail holds the reply and the end; every call is older.
    let (harness, page) = open_cut(&folder, &rows, 11, cx);
    let reads = harness.transport.requests("session.transcript.page");
    assert_eq!(reads.len(), 1, "the turn's end shows: its start is read on its own");
    assert_eq!(reads[0]["maxBytes"], conversation::BACKGROUND_PAGE_BYTES);
    assert!(!has_card(&harness, cx), "no card for half a turn");
    let before = footer_top(&harness, cx);

    page.try_send(Ok(older_page(&rows[..11], 1, rows.len(), None))).expect("release");
    wait(&harness, cx);
    assert_whole_card(&harness, cx);
    assert_eq!(harness.transport.requests("session.transcript.page").len(), 1);
    let after = footer_top(&harness, cx);
    assert!(f32::from((after - before).abs()) < 1., "the turn's end stayed: {before:?} {after:?}");
}

/// Every edit of the turn is in the tail, only its prompt older: the card
/// still waits for the turn's start, then lists the same files.
#[gpui_kit::test]
fn a_turn_whose_edits_are_all_in_the_tail_waits_for_its_start(cx: &mut TestAppContext) {
    let folder = Folder::new("tail-edits");
    let rows = turn_rows_long_reply(&folder);
    let (harness, page) = open_cut(&folder, &rows, 1, cx);
    assert_eq!(harness.transport.requests("session.transcript.page").len(), 1);
    assert!(!has_card(&harness, cx), "the edits are here, the start is not");
    harness.workbench.read_with(cx, |workbench, cx| {
        let turns = workbench.review_panel().read(cx).turn_changes().read(cx).turns().len();
        assert_eq!(turns, 0, "nor is the turn a scope of the panel");
    });

    page.try_send(Ok(older_page(&rows[..1], 1, rows.len(), None))).expect("release");
    wait(&harness, cx);
    assert_whole_card(&harness, cx);
}

/// Turn `turn` writing `name`, a new file of two lines, then a reply
/// of `paragraphs` paragraphs.
fn writing_turn(folder: &Folder, turn: &str, name: &str, paragraphs: usize) -> Vec<Value> {
    let content = "one\ntwo\n";
    std::fs::write(folder.0.join(name), content).expect("write");
    let path = folder.path(name);
    let call = format!("{turn}-c1");
    let reply: String = (1..=paragraphs).map(|n| format!("Paragraph {n}.\n\n")).collect();
    vec![
        json!({"type": "user", "id": turn, "turnId": turn, "ts": 1,
               "text": format!("Write {name}")}),
        json!({"type": "tool_call", "id": call, "turnId": turn, "ts": 2, "toolName": "Write",
               "args": {"path": name, "content": content}, "stepId": format!("{turn}-s1")}),
        json!({"type": "tool_result", "id": format!("{call}-r"), "turnId": turn, "ts": 3,
               "toolUseId": call, "isError": false,
               "content": {"kind": "file_diff", "paths": [path], "diff": format!(
                   "--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,2 @@\n+one\n+two")}}),
        json!({"type": "assistant", "id": format!("{turn}-s1"), "turnId": turn, "ts": 4,
               "text": reply, "contentOrder": ["tools", "text"], "modelId": "m"}),
        json!({"type": "turn_state", "id": format!("{turn}-end"), "turnId": turn, "ts": 5,
               "status": "completed"}),
    ]
}

fn listed_turns(harness: &Harness, cx: &mut TestAppContext) -> Vec<String> {
    harness.workbench.read_with(cx, |workbench, cx| {
        let panel = workbench.review_panel().read(cx);
        panel.turn_list().iter().map(|turn| turn.turn_id().to_string()).collect()
    })
}

fn reading_line(harness: &Harness, cx: &mut TestAppContext) -> Option<String> {
    harness.with_window(cx, |window, _| {
        window.try_find("review-turns-reading").and_then(|line| line.label().map(str::to_owned))
    })
}

/// Three turns, each writing a file; the tail holds only the newest. The
/// changes panel opened on the task reads the rest of the history in the
/// background, saying so under the turns meanwhile, and then lists every
/// turn's scope.
#[gpui_kit::test]
fn the_panel_lists_every_turn_once_the_history_is_read(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let folder = Folder::new("history");
    let (t1, t2) = (writing_turn(&folder, "t1", "a.md", 1), writing_turn(&folder, "t2", "b.md", 1));
    let t3 = writing_turn(&folder, "t3", "c.md", 40);
    let through = t1.len() + t2.len() + t3.len();
    let path = folder.0.to_string_lossy().into_owned();
    let transport = ScriptedHost::new(vec![session("s1", "Alpha", &path, "active")]);
    // The tail ends between turns: no turn is cut, older ones exist.
    let mut tail = older_page(&t3, t1.len() + t2.len() + 1, through, Some("c1"));
    tail["endsAtTurnBoundary"] = json!(true);
    transport.reply("subscription.open", Ok(open_with_tail(tail)));
    let page = transport.hold("session.transcript.page");
    let mut second = older_page(&t1, 1, through, None);
    second["endsAtTurnBoundary"] = json!(true);
    transport.reply("session.transcript.page", Ok(second));
    let harness = Harness::with_transport(transport, cx);
    wait(&harness, cx);
    assert!(
        harness.transport.requests("session.transcript.page").is_empty(),
        "nothing is read while the panel is closed and no turn is cut"
    );

    harness.with_window(cx, |window, cx| window.click("review-toggle", cx));
    wait(&harness, cx);
    let reads = harness.transport.requests("session.transcript.page");
    assert_eq!(reads.len(), 1, "opening the panel reads the earlier history");
    assert_eq!(reads[0]["maxBytes"], conversation::BACKGROUND_PAGE_BYTES);
    assert_eq!(listed_turns(&harness, cx), ["t3"]);
    assert_eq!(reading_line(&harness, cx).as_deref(), Some("Reading earlier turns"));

    let mut first = older_page(&t2, t1.len() + 1, through, Some("c2"));
    first["endsAtTurnBoundary"] = json!(true);
    page.try_send(Ok(first)).expect("release");
    wait(&harness, cx);
    assert_eq!(harness.transport.requests("session.transcript.page").len(), 2);
    assert_eq!(listed_turns(&harness, cx), ["t1", "t2", "t3"]);
    assert_eq!(reading_line(&harness, cx), None, "the history is whole");
}

/// The panel opened while a turn runs reads nothing; once the turn ends,
/// it reads the earlier history.
#[gpui_kit::test]
fn the_panel_reads_no_history_while_a_turn_runs(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let folder = Folder::new("running");
    let t1 = writing_turn(&folder, "t1", "a.md", 1);
    let t2 = writing_turn(&folder, "t2", "b.md", 40);
    let through = t1.len() + t2.len();
    let path = folder.0.to_string_lossy().into_owned();
    let transport = ScriptedHost::new(vec![session("s1", "Alpha", &path, "active")]);
    let mut tail = older_page(&t2, t1.len() + 1, through, Some("c1"));
    tail["endsAtTurnBoundary"] = json!(true);
    transport.reply("subscription.open", Ok(open_with_tail(tail)));
    transport.reply("session.transcript.page", Ok(older_page(&t1, 1, through, None)));
    let mut harness = Harness::with_transport(transport, cx);
    wait(&harness, cx);
    harness.project("s1", crate::tests::root("t3", "run-3", "running"), cx);
    harness.with_window(cx, |window, cx| window.click("review-toggle", cx));
    wait(&harness, cx);
    assert!(harness.transport.requests("session.transcript.page").is_empty(), "a turn runs");
    assert_eq!(reading_line(&harness, cx), None);
    assert_eq!(listed_turns(&harness, cx), ["t2"]);

    harness.project("s1", crate::tests::root("t3", "run-3", "completed"), cx);
    wait(&harness, cx);
    assert_eq!(harness.transport.requests("session.transcript.page").len(), 1);
    assert_eq!(listed_turns(&harness, cx), ["t1", "t2"]);
}
