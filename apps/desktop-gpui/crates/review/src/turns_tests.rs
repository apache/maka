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

//! Each turn's net change of each file it edited, from a fixture transcript
//! whose files are made in a folder under `target/tmp` that is not a
//! repository.

// Setup writes the files the transcript's tools edited.
#![allow(clippy::disallowed_methods)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use base64::Engine as _;
use host_protocol::SubscriptionOpenResult;
use serde_json::{Value, json};
use transcript_model::Transcript;
use transcript_model::edits::{ChangeKind, TurnEdits, session_edits};

use crate::turns::{FileView, TurnChange, work_out};

/// A folder the fixture's files live in, removed when dropped.
pub(crate) struct Folder(pub(crate) PathBuf);

impl Folder {
    /// A folder under `target/tmp`: inside this checkout's repository.
    pub(crate) fn new(name: &str) -> Self {
        Self::under(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/tmp"), name)
    }

    /// A folder in the system's temporary folder: in no repository.
    pub(crate) fn outside(name: &str) -> Self {
        Self::under(&std::env::temp_dir(), name)
    }

    fn under(parent: &Path, name: &str) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = parent.join(format!(
            "turns-{name}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).expect("folder");
        Self(dir)
    }

    pub(crate) fn path(&self, name: &str) -> String {
        self.0.join(name).to_string_lossy().into_owned()
    }

    pub(crate) fn write(&self, name: &str, text: &str) {
        std::fs::write(self.0.join(name), text).expect("write");
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).ok();
    }
}

/// A transcript of session `s1` holding `rows`, bootstrapped as the Host's
/// `subscription.open` with a tail would give it (an older page: its rows
/// newest first).
pub(crate) fn transcript(rows: &[Value]) -> Transcript {
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
    let open: SubscriptionOpenResult = serde_json::from_value(json!({
        "hostEpoch": "e1", "subscriptionId": "sub", "nextSequence": 1,
        "snapshot": {
            "schemaVersion": 5,
            "session": {"sessionId": "s1", "metadataRevision": 1, "status": "idle",
                        "createdAt": 1, "isArchived": false},
            "projectionRevision": 1, "rootTurn": null, "goal": null,
            "queue": {"hostEpoch": "e1", "queueRevision": 0, "steering": [], "followup": []},
            "interactions": {"pending": []}
        },
        "activeAssistantStreams": [],
        "transcript": {"durable": {
            "kind": "page", "sessionId": "s1", "direction": "older",
            "throughSequence": rows.len(), "rawBytes": 0, "fragments": fragments,
            "nextCursor": null, "endsAtTurnBoundary": true
        }}
    }))
    .expect("open result");
    Transcript::bootstrap(&open).expect("bootstrap")
}

pub(crate) fn user(turn: &str, ts: u64, text: &str) -> Value {
    json!({"type": "user", "id": turn, "turnId": turn, "ts": ts, "text": text})
}

pub(crate) fn call(turn: &str, id: &str, tool: &str, args: Value) -> Value {
    json!({"type": "tool_call", "id": id, "turnId": turn, "ts": 2, "toolName": tool,
           "args": args, "stepId": format!("{turn}-s1")})
}

pub(crate) fn result(turn: &str, id: &str, content: Value) -> Value {
    json!({"type": "tool_result", "id": format!("r-{id}"), "turnId": turn, "ts": 3,
           "toolUseId": id, "isError": false, "content": content})
}

/// The turn's reply after its calls, and its end.
pub(crate) fn reply(turn: &str, status: &str) -> [Value; 2] {
    [
        json!({"type": "assistant", "id": format!("{turn}-s1"), "turnId": turn, "ts": 4,
               "text": "Done.", "contentOrder": ["tools", "text"], "modelId": "m"}),
        json!({"type": "turn_state", "id": format!("{turn}-end"), "turnId": turn, "ts": 5,
               "status": status}),
    ]
}

/// A `file_diff` result for the file at `path`.
pub(crate) fn file_diff(path: &str, hunks: &str) -> Value {
    json!({"kind": "file_diff", "paths": [path],
           "diff": format!("--- a/{path}\n+++ b/{path}\n{hunks}")})
}

/// `report.py` before the turn: ten lines.
pub(crate) const REPORT_BEFORE: &str = "a1\na2\na3\na4\na5\na6\na7\na8\na9\na10\n";
/// After the turn's two Edits: the third and the eighth line changed.
pub(crate) const REPORT_AFTER: &str = "a1\na2\nA3\na4\na5\na6\na7\nA8\na9\na10\n";
/// Maka's diff of the first Edit (three lines of context, its window).
pub(crate) const FIRST_EDIT: &str = "@@ -1,6 +1,6 @@\n a1\n a2\n-a3\n+A3\n a4\n a5\n a6";
pub(crate) const SECOND_EDIT: &str = "@@ -5,6 +5,6 @@\n a5\n a6\n a7\n-a8\n+A8\n a9\n a10";
pub(crate) const PATCH: &str = "*** Begin Patch\n*** Update File: data.txt\n@@\n x\n-y\n+Y\n z\n\
                                *** Delete File: old.txt\n*** End Patch";

/// Turn `t1` ("Build the report"): `Edit` twice on `report.py`, `Write`
/// creating `notes.md`, a `Bash` call, and `apply_patch` updating
/// `data.txt` and deleting `old.txt`; the folder holds the files as the
/// turn left them.
pub(crate) fn first_turn(folder: &Folder) -> Vec<Value> {
    folder.write("report.py", REPORT_AFTER);
    folder.write("notes.md", "# Notes\n\nfirst\n");
    folder.write("data.txt", "x\nY\nz\n");
    let report = folder.path("report.py");
    let notes = folder.path("notes.md");
    let mut rows = vec![
        user("t1", 1_000, "Build the report\nand tidy up"),
        call(
            "t1",
            "c1",
            "Edit",
            json!({"path": "report.py", "old_string": "a3", "new_string": "A3"}),
        ),
        result("t1", "c1", file_diff(&report, FIRST_EDIT)),
        call(
            "t1",
            "c2",
            "Edit",
            json!({"path": "report.py", "old_string": "a8", "new_string": "A8"}),
        ),
        result("t1", "c2", file_diff(&report, SECOND_EDIT)),
        call("t1", "c3", "Write", json!({"path": "notes.md", "content": "# Notes\n\nfirst\n"})),
        result(
            "t1",
            "c3",
            json!({"kind": "file_diff", "paths": [notes], "diff": format!(
                "--- /dev/null\n+++ b/{notes}\n@@ -0,0 +1,3 @@\n+# Notes\n+\n+first")}),
        ),
        call("t1", "c4", "Bash", json!({"command": "python report.py > out.txt"})),
        result("t1", "c4", json!({"kind": "text", "text": ""})),
        call("t1", "c5", "apply_patch", json!(PATCH)),
        result("t1", "c5", json!({"kind": "json", "value": {"status": "completed"}})),
    ];
    rows.extend(reply("t1", "completed"));
    rows
}

/// One call a code cell's script makes: its id within the cell, the tool,
/// its arguments, and its result.
pub(crate) struct CellCall<'a> {
    pub(crate) id: &'a str,
    pub(crate) tool: &'a str,
    pub(crate) args: Value,
    pub(crate) content: Value,
}

/// An assistant step of turn `t1` as a real Host stores it: before the
/// calls it makes.
pub(crate) fn step(id: &str, text: &str) -> Value {
    json!({"type": "assistant", "id": id, "turnId": "t1", "ts": 2, "text": text,
           "thinking": {"text": "Plan the next step."},
           "contentOrder": ["thinking", "text", "tools"], "modelId": "m"})
}

/// A code cell (`exec`) of turn `t1` in step `step` running `calls`, in the
/// shape a real Host stores them at epoch 197: each call is a row of its
/// own, named after its tool, with the id `<exec id>:nested:<id>` in the
/// step `<exec id>:nested`, its origin `code_mode` and the `exec` its
/// parent; then the `exec`'s own result.
pub(crate) fn code_cell(step: &str, calls: &[CellCall<'_>]) -> Vec<Value> {
    const EXEC: &str = "call_e1";
    let script: Vec<String> =
        calls.iter().map(|call| format!("await tools.{}({});", call.tool, call.args)).collect();
    let mut rows = vec![json!({
        "type": "tool_call", "id": EXEC, "turnId": "t1", "ts": 2, "toolName": "exec",
        "stepId": step, "origin": "provider", "modelVisibility": "visible",
        "args": {"code": script.join("\n")}
    })];
    for call in calls {
        let tool_use_id = format!("{EXEC}:nested:{}", call.id);
        let tag = |mut row: Value| {
            row["origin"] = json!("code_mode");
            row["modelVisibility"] = json!("hidden");
            row["parentToolCallId"] = json!(EXEC);
            row["parentOperationId"] = json!("op-exec");
            row
        };
        rows.push(tag(json!({
            "type": "tool_call", "id": tool_use_id, "turnId": "t1", "ts": 3,
            "toolName": call.tool, "args": call.args, "stepId": format!("{EXEC}:nested")
        })));
        rows.push(tag(json!({
            "type": "tool_result", "id": format!("op-{}_response", call.id), "turnId": "t1",
            "ts": 3, "toolUseId": tool_use_id, "isError": false, "content": call.content
        })));
    }
    rows.push(json!({
        "type": "tool_result", "id": "op-exec_response", "turnId": "t1", "ts": 4,
        "toolUseId": EXEC, "isError": false, "origin": "provider", "modelVisibility": "visible",
        "content": {"kind": "json", "value": {"ok": true}}
    }));
    rows
}

/// `report.py` after only its eighth line changed.
pub(crate) const REPORT_EIGHTH: &str = "a1\na2\na3\na4\na5\na6\na7\nA8\na9\na10\n";

/// The calls of a code cell that writes `notes.md` (new), edits
/// `report.py`'s eighth line, and runs a command.
pub(crate) fn cell_calls(folder: &Folder) -> Vec<CellCall<'static>> {
    let (report, notes) = (folder.path("report.py"), folder.path("notes.md"));
    vec![
        CellCall {
            id: "u1",
            tool: "Write",
            args: json!({"path": "notes.md", "content": "# Notes\n\nfirst\n"}),
            content: json!({"kind": "file_diff", "paths": [notes], "diff": format!(
                "--- /dev/null\n+++ b/{notes}\n@@ -0,0 +1,3 @@\n+# Notes\n+\n+first")}),
        },
        CellCall {
            id: "u2",
            tool: "Edit",
            args: json!({"path": "report.py", "old_string": "a8", "new_string": "A8"}),
            content: file_diff(&report, SECOND_EDIT),
        },
        CellCall {
            id: "u3",
            tool: "Bash",
            args: json!({"command": "python report.py > out.txt"}),
            content: json!({"kind": "text", "text": ""}),
        },
    ]
}

/// Turn `t1` ("Write the notes") in Code Mode: one code cell running
/// [`cell_calls`]; the folder holds the files as the turn left them.
pub(crate) fn code_cell_turn(folder: &Folder) -> Vec<Value> {
    folder.write("report.py", REPORT_EIGHTH);
    folder.write("notes.md", "# Notes\n\nfirst\n");
    let mut rows = vec![user("t1", 1_000, "Write the notes"), step("t1-s1", "")];
    rows.extend(code_cell("t1-s1", &cell_calls(folder)));
    rows.extend(code_cell_end());
    rows
}

/// Turn `t1` ("Build the report") editing `report.py`'s third line itself,
/// then running [`cell_calls`] in a code cell; the folder holds the files
/// as the turn left them.
pub(crate) fn mixed_turn(folder: &Folder) -> Vec<Value> {
    folder.write("report.py", REPORT_AFTER);
    folder.write("notes.md", "# Notes\n\nfirst\n");
    let report = folder.path("report.py");
    let mut rows = vec![
        user("t1", 1_000, "Build the report"),
        step("t1-s1", ""),
        json!({"type": "tool_call", "id": "c1", "turnId": "t1", "ts": 2, "toolName": "Edit",
               "args": {"path": "report.py", "old_string": "a3", "new_string": "A3"},
               "stepId": "t1-s1", "origin": "provider", "modelVisibility": "visible"}),
        result("t1", "c1", file_diff(&report, FIRST_EDIT)),
        step("t1-s2", ""),
    ];
    rows.extend(code_cell("t1-s2", &cell_calls(folder)));
    rows.extend(code_cell_end());
    rows
}

/// The reply of a Code Mode turn `t1` after its code cell, and its end.
fn code_cell_end() -> [Value; 2] {
    [
        step("t1-s9", "Done."),
        json!({"type": "turn_state", "id": "t1-end", "turnId": "t1", "ts": 5,
               "status": "completed"}),
    ]
}

fn edits(rows: &[Value]) -> Vec<TurnEdits> {
    session_edits(&transcript(rows))
}

fn summary(turn: &TurnChange) -> Vec<(String, ChangeKind, Option<(u32, u32)>, bool)> {
    turn.files()
        .iter()
        .map(|file| (file.path().to_string(), file.kind(), file.counts(), file.is_stepwise()))
        .collect()
}

fn net(turn: &TurnChange, path: &str) -> String {
    match turn.file(path).expect("file").view() {
        FileView::Net(patch) => patch.to_string(),
        FileView::Steps(_) => panic!("{path} shows step by step"),
    }
}

/// Git's own diff of `before` against `after` with the panel's context,
/// from its first hunk.
fn git_hunks(folder: &Folder, before: &str, after: &str) -> String {
    folder.write("git-before", before);
    folder.write("git-after", after);
    let output = std::process::Command::new("git")
        .args(["diff", "--no-index", "--no-color", "-U20", "--", "git-before", "git-after"])
        .current_dir(&folder.0)
        .output()
        .expect("git");
    let text = String::from_utf8(output.stdout).expect("utf-8");
    text[text.find("@@").expect("a hunk")..].to_owned()
}

/// Four files in the order the turn first edited them, the two Edits of
/// `report.py` one net diff, Git's diff of the file before and after the
/// turn; the created file added, the deleted one without counts.
#[test]
fn a_turn_gives_each_file_its_net_change() {
    let folder = Folder::new("net");
    let turns = work_out(&edits(&first_turn(&folder)), Some(&folder.0), true);
    let [turn] = turns.as_slice() else { panic!("one turn: {turns:?}") };
    assert_eq!(turn.prompt().as_ref(), "Build the report");
    assert_eq!(
        summary(turn),
        [
            ("report.py".into(), ChangeKind::Modified, Some((2, 2)), false),
            ("notes.md".into(), ChangeKind::Created, Some((3, 0)), false),
            ("data.txt".into(), ChangeKind::Modified, Some((1, 1)), false),
            ("old.txt".into(), ChangeKind::Deleted, None, false),
        ]
    );
    assert_eq!(turn.totals(), (6, 3));
    let report = net(turn, "report.py");
    assert!(
        report
            .starts_with("diff --git a/report.py b/report.py\n--- a/report.py\n+++ b/report.py\n"),
        "{report}"
    );
    let hunks = &report[report.find("@@").expect("hunk")..];
    assert_eq!(hunks, git_hunks(&folder, REPORT_BEFORE, REPORT_AFTER));
    assert_eq!(
        net(turn, "notes.md"),
        "diff --git a/notes.md b/notes.md\nnew file mode 100644\n--- /dev/null\n+++ b/notes.md\n\
         @@ -0,0 +1,3 @@\n+# Notes\n+\n+first\n"
    );
    assert_eq!(
        net(turn, "data.txt"),
        "diff --git a/data.txt b/data.txt\n--- a/data.txt\n+++ b/data.txt\n@@ -1,3 +1,3 @@\n x\n-y\n+Y\n z\n"
    );
}

/// A Code Mode turn: the file its code cell wrote and the one it edited,
/// each with its lines, in the order the script ran; its command and the
/// cell itself change nothing.
#[test]
fn a_code_cell_turn_gives_the_files_its_script_edited() {
    let folder = Folder::new("code-cell");
    let turns = work_out(&edits(&code_cell_turn(&folder)), Some(&folder.0), true);
    let [turn] = turns.as_slice() else { panic!("one turn: {turns:?}") };
    assert_eq!(
        summary(turn),
        [
            ("notes.md".into(), ChangeKind::Created, Some((3, 0)), false),
            ("report.py".into(), ChangeKind::Modified, Some((1, 1)), false),
        ]
    );
    let report = net(turn, "report.py");
    assert_eq!(
        &report[report.find("@@").expect("hunk")..],
        git_hunks(&folder, REPORT_BEFORE, REPORT_EIGHTH)
    );
}

/// The model's own Edit of `report.py` and the code cell's are one net
/// change of it, before the file the cell created.
#[test]
fn direct_and_code_cell_edits_make_one_net_change() {
    let folder = Folder::new("mixed");
    let turns = work_out(&edits(&mixed_turn(&folder)), Some(&folder.0), true);
    let [turn] = turns.as_slice() else { panic!("one turn: {turns:?}") };
    assert_eq!(
        summary(turn),
        [
            ("report.py".into(), ChangeKind::Modified, Some((2, 2)), false),
            ("notes.md".into(), ChangeKind::Created, Some((3, 0)), false),
        ]
    );
    let report = net(turn, "report.py");
    assert_eq!(
        &report[report.find("@@").expect("hunk")..],
        git_hunks(&folder, REPORT_BEFORE, REPORT_AFTER)
    );
}

/// A later turn editing the same file leaves the earlier turn its own net
/// change, and gets its own.
#[test]
fn a_later_turn_on_the_same_file_keeps_each_turns_change() {
    let folder = Folder::new("later");
    let mut rows = first_turn(&folder);
    let report = folder.path("report.py");
    let after = REPORT_AFTER.replace("a5", "A5");
    folder.write("report.py", &after);
    rows.extend([
        user("t2", 2_000, "One more"),
        call("t2", "d1", "Edit", json!({"path": "report.py"})),
        result(
            "t2",
            "d1",
            file_diff(&report, "@@ -2,7 +2,7 @@\n a2\n A3\n a4\n-a5\n+A5\n a6\n a7\n A8"),
        ),
    ]);
    rows.extend(reply("t2", "completed"));
    let turns = work_out(&edits(&rows), Some(&folder.0), true);
    assert_eq!(turns.len(), 2);
    assert_eq!(
        summary(&turns[0])[0],
        ("report.py".into(), ChangeKind::Modified, Some((2, 2)), false)
    );
    let first = net(&turns[0], "report.py");
    assert_eq!(
        &first[first.find("@@").expect("hunk")..],
        git_hunks(&folder, REPORT_BEFORE, REPORT_AFTER)
    );
    assert_eq!(
        summary(&turns[1]),
        [("report.py".into(), ChangeKind::Modified, Some((1, 1)), false)]
    );
    let second = net(&turns[1], "report.py");
    assert_eq!(
        &second[second.find("@@").expect("hunk")..],
        git_hunks(&folder, REPORT_AFTER, &after)
    );
}

/// The file changed by something other than the tools since the turn, where
/// the turn's edits touched it: the edits one after another, their counts
/// summed.
#[test]
fn a_file_changed_outside_the_tools_shows_step_by_step() {
    let folder = Folder::new("outside");
    let rows = first_turn(&folder);
    folder.write("report.py", &REPORT_AFTER.replace("a10", "z10"));
    let turns = work_out(&edits(&rows), Some(&folder.0), true);
    let file = turns[0].file("report.py").expect("report.py");
    assert_eq!(
        (file.kind(), file.counts(), file.is_stepwise()),
        (ChangeKind::Modified, Some((2, 2)), true)
    );
    let FileView::Steps(steps) = file.view() else { panic!("steps") };
    let patches: Vec<&str> = steps.iter().map(|step| step.patch.as_ref()).collect();
    assert_eq!(
        patches,
        [
            format!("--- a/report.py (1/2)\n+++ b/report.py (1/2)\n{FIRST_EDIT}\n"),
            format!("--- a/report.py (2/2)\n+++ b/report.py (2/2)\n{SECOND_EDIT}\n"),
        ]
    );
    assert!(!turns[0].file("data.txt").expect("data").is_stepwise(), "the other files still net");
    // A change past every hunk of the turn's edits leaves the net diff
    // exact, and out of it.
    folder.write("report.py", &format!("{REPORT_AFTER}a11\n"));
    let turns = work_out(&edits(&rows), Some(&folder.0), true);
    assert_eq!(
        summary(&turns[0])[0],
        ("report.py".into(), ChangeKind::Modified, Some((2, 2)), false)
    );
}

/// An archived result lost its diff: nothing undoes past it.
#[test]
fn an_archived_result_shows_step_by_step() {
    let folder = Folder::new("archived");
    let mut rows = first_turn(&folder);
    rows[2] = result(
        "t1",
        "c1",
        json!({"kind": "archived_tool_result", "status": "not_loaded",
        "runtimeEventId": "e", "toolCallId": "c1", "toolName": "Edit",
        "originalEstimatedTokens": 1, "originalBytes": 1, "rewriteVersion": 1,
        "reason": "tool_result_pruned"}),
    );
    let turns = work_out(&edits(&rows), Some(&folder.0), true);
    let file = turns[0].file("report.py").expect("report.py");
    assert_eq!((file.counts(), file.is_stepwise()), (Some((1, 1)), true));
    let FileView::Steps(steps) = file.view() else { panic!("steps") };
    assert_eq!(steps[0].counts, None, "the archived edit says nothing");
    assert_eq!(steps[0].patch.as_ref(), "--- a/report.py (1/2)\n+++ b/report.py (1/2)\n");
}

/// On a Host elsewhere nothing is read: every file shows its edits, the
/// created one as added.
#[test]
fn a_remote_host_shows_step_by_step_without_reading() {
    let folder = Folder::new("remote");
    let rows = first_turn(&folder);
    std::fs::remove_dir_all(&folder.0).expect("remove");
    let turns = work_out(&edits(&rows), Some(&folder.0), false);
    assert_eq!(
        summary(&turns[0]),
        [
            ("report.py".into(), ChangeKind::Modified, Some((2, 2)), true),
            ("notes.md".into(), ChangeKind::Created, Some((3, 0)), true),
            ("data.txt".into(), ChangeKind::Modified, Some((1, 1)), true),
            ("old.txt".into(), ChangeKind::Deleted, None, false),
        ]
    );
    let FileView::Steps(steps) = turns[0].file("data.txt").expect("data").view() else {
        panic!("steps")
    };
    assert_eq!(
        steps[0].patch.as_ref(),
        "--- a/data.txt\n+++ b/data.txt\n@@ -1,3 +1,3 @@\n x\n-y\n+Y\n z\n"
    );
}

/// A file a turn deleted shows the lines the session last knew it had.
#[test]
fn a_deleted_file_shows_the_lines_last_known() {
    let folder = Folder::new("deleted");
    let notes = folder.path("notes.md");
    let mut rows = vec![
        user("t1", 1_000, "Write notes"),
        call("t1", "c1", "Write", json!({"path": "notes.md", "content": "one\ntwo\n"})),
        result(
            "t1",
            "c1",
            json!({"kind": "file_diff", "paths": [notes], "diff": format!(
            "--- /dev/null\n+++ b/{notes}\n@@ -0,0 +1,2 @@\n+one\n+two")}),
        ),
    ];
    rows.extend(reply("t1", "completed"));
    rows.extend([
        user("t2", 2_000, "Remove them"),
        call(
            "t2",
            "d1",
            "apply_patch",
            json!({"operation": {"type": "delete_file", "path": "notes.md"}}),
        ),
        result("t2", "d1", json!({"kind": "json", "value": {"status": "completed"}})),
    ]);
    rows.extend(reply("t2", "completed"));
    let turns = work_out(&edits(&rows), Some(&folder.0), true);
    assert_eq!(summary(&turns[1]), [("notes.md".into(), ChangeKind::Deleted, Some((0, 2)), false)]);
    assert_eq!(
        net(&turns[1], "notes.md"),
        "diff --git a/notes.md b/notes.md\ndeleted file mode 100644\n--- a/notes.md\n+++ /dev/null\n\
         @@ -1,2 +0,0 @@\n-one\n-two\n"
    );
    // The turn that created it cannot be undone past the delete: its
    // edit alone.
    assert_eq!(summary(&turns[0]), [("notes.md".into(), ChangeKind::Created, Some((2, 0)), true)]);
}

/// What a settled turn changed, once worked out, stays: the file changing
/// outside the tools later does not turn it into steps, and only files with
/// a change to work out are read again.
#[gpui_kit::test]
fn a_worked_out_change_stays_when_the_file_changes_later(cx: &mut gpui_kit::TestAppContext) {
    use gpui_kit::AppContext as _;
    use transcript_model::edits::EditsKey;

    use crate::ReviewTarget;
    use crate::turns::TurnChanges;

    cx.executor().allow_parking();
    let folder = Folder::new("kept");
    let mut rows = first_turn(&folder);
    let changes = cx.new(|_| TurnChanges::new());
    let target = ReviewTarget::local("s1", &folder.0);
    changes.update(cx, |changes, cx| changes.set_target(Some(&target), cx));
    let work_out = |rows: &[Value], cx: &mut gpui_kit::TestAppContext| {
        let transcript = transcript(rows);
        let (key, edits) = (EditsKey::of(&transcript), session_edits(&transcript));
        changes.update(cx, |changes, cx| changes.set_edits(key, edits, cx));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while changes.read_with(cx, |changes, _| changes.is_computing())
            && std::time::Instant::now() < deadline
        {
            cx.run_until_parked();
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        changes.read_with(cx, |changes, _| changes.turns().as_ref().clone())
    };
    let first = work_out(&rows, cx);
    assert!(!first[0].file("report.py").expect("report.py").is_stepwise());

    folder.write("report.py", &REPORT_AFTER.replace("a10", "z10"));
    rows.extend([user("t2", 2_000, "Thanks")]);
    rows.extend(reply("t2", "completed"));
    let again = work_out(&rows, cx);
    let file = again[0].file("report.py").expect("report.py");
    assert_eq!((file.counts(), file.is_stepwise()), (Some((2, 2)), false), "kept as it was");
    let edited = changes.read_with(cx, |changes, _| changes.edited_turns());
    assert_eq!(edited.files("t1").map(|files| files.len()), Some(4));
    assert_eq!(edited.files("t2"), None, "a turn that edited nothing has no card");
}
