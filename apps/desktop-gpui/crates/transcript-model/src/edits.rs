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

//! The file edits of a session's turns, as the tools that made them report
//! them: what each turn changed through Maka's file tools, in order, for
//! the card under a settled turn and the changes panel's turn scopes.
//!
//! A tool call counts only when it succeeded ([`ToolStatus::Completed`]):
//!
//! - `Edit` and `FormatJson` change a file in place; their `file_diff`
//!   result (`ToolResultContent` in packages/core/src/events.ts) carries a
//!   unified diff (`createEditUnifiedDiff`, `createUnifiedDiff` in
//!   packages/runtime/src/unified-diff.ts), and without one the change is
//!   known to have happened but not how.
//! - `Write` writes the whole file from its `content` argument; a
//!   `file_diff` whose old side is `/dev/null` says it created the file,
//!   any other says it replaced one, and a `file_write` (no diff: the file
//!   was too large to diff, or what it held could not be read) says
//!   neither.
//! - `apply_patch` reports only a status; its input carries the operations
//!   (`create_file`, `update_file`, `delete_file`), either as one
//!   `operation` (OpenAI's apply_patch tool) or as a Codex V4A patch
//!   (`parseCodexV4aPatch` in packages/runtime/src/codex-v4a-patch.ts). A
//!   batch that stopped part way reports `status: "failed"`, and none of its
//!   operations count.
//!
//! A call a Code Mode code cell (`exec`) makes from its script is a Tool of
//! the turn like any other (the Host stores it as its own row, under the
//! tool's name, `origin: "code_mode"`, the `exec` its parent), so it counts
//! on its own result, whatever became of the cell after it.
//!
//! `Bash`, `exec` and every other tool are ignored: a file a shell command
//! changed is not tracked (Codex has the same limit). An archived result
//! (`archived_tool_result`) has lost its diff: the edit is kept, its change
//! unknown.
//!
//! Paths are as the tool reported them: absolute from a result, as given
//! (often relative to the task's folder) from an `apply_patch` input. No
//! GPUI, no I/O.

use std::sync::Arc;

use serde_json::Value;

use crate::transcript::Transcript;
use crate::view::{ToolItem, ToolStatus, TurnItem, TurnView, TurnViewStatus};

/// What a tool call did to one file.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum EditChange {
    /// Changed in place by this unified diff (`Edit`, `FormatJson`, or
    /// `Write` over a file it replaced), with the whole text after the
    /// change when the call says it (`Write`'s `content`).
    Unified {
        diff: Arc<str>,
        after: Option<Arc<str>>,
    },
    /// Changed in place by this V4A section (`apply_patch`'s
    /// `update_file`): `@@` anchors and lines marked ` `, `-` and `+`.
    Patch(Arc<str>),
    /// Changed in place, how is not known: no diff in the result, or the
    /// result was archived.
    Unknown,
    /// Created with this text (`Write` to a new file, `apply_patch`'s
    /// `create_file`).
    Created {
        content: Arc<str>,
    },
    /// Written whole with this text (`Write` whose result says neither
    /// created nor replaced), `bytes` long by the result.
    Written {
        content: Arc<str>,
        bytes: Option<u64>,
    },
    Deleted,
}

/// One file one tool call changed.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct FileEdit {
    pub tool_use_id: String,
    pub tool_name: String,
    /// As the tool reported it: absolute, or relative to the task's folder.
    pub path: String,
    pub change: EditChange,
}

/// The file edits of one turn, in the order its calls ran.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct TurnEdits {
    pub turn_id: String,
    pub status: TurnViewStatus,
    /// The first line of the message that opened the turn.
    pub prompt: String,
    /// Host wall-clock milliseconds of the turn's earliest row.
    pub started_at: u64,
    pub edits: Vec<FileEdit>,
}

impl TurnEdits {
    /// Whether the turn has ended: completed, failed or stopped.
    pub fn is_settled(&self) -> bool {
        self.status.is_terminal()
    }
}

/// How a turn left a file it edited.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum ChangeKind {
    Created,
    Modified,
    Deleted,
}

/// One file a settled turn changed, as the card under the turn lists it:
/// its path (relative to the task's folder when inside it), how the turn
/// left it, and the lines it added and deleted when they are known.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct EditedFile {
    pub path: String,
    pub kind: ChangeKind,
    pub counts: Option<(u32, u32)>,
}

impl EditedFile {
    pub fn new(path: impl Into<String>, kind: ChangeKind, counts: Option<(u32, u32)>) -> Self {
        Self { path: path.into(), kind, counts }
    }
}

/// The files each settled turn of a session changed, in the order the turn
/// first edited them, by turn id.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
#[non_exhaustive]
pub struct EditedTurns {
    pub session_id: String,
    pub turns: std::collections::HashMap<String, Arc<[EditedFile]>>,
}

impl EditedTurns {
    pub fn new(
        session_id: impl Into<String>,
        turns: std::collections::HashMap<String, Arc<[EditedFile]>>,
    ) -> Self {
        Self { session_id: session_id.into(), turns }
    }

    /// The files turn `turn_id` changed, if it changed any.
    pub fn files(&self, turn_id: &str) -> Option<&Arc<[EditedFile]>> {
        self.turns.get(turn_id).filter(|files| !files.is_empty())
    }
}

/// What a session's edits were read from: the transcript's first and last
/// durable rows, its turns and the state of its last one, and whether a
/// turn the tail cut is still missing its start. Equal keys give equal
/// [`session_edits`], so the work done from them need not be done again.
/// The first row matters because a turn larger than the transcript's tail
/// shows from its end, and the older history that brings the rest of it,
/// its edits among them, adds no turn and no newer row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditsKey {
    session_id: String,
    durable_from: Option<u64>,
    durable_through: Option<u64>,
    turns: usize,
    first_turn: Option<String>,
    last_turn: Option<(String, TurnViewStatus)>,
    partial_turn: bool,
}

impl EditsKey {
    pub fn of(transcript: &Transcript) -> Self {
        let turns = transcript.turns();
        Self {
            session_id: transcript.session_id().to_owned(),
            durable_from: transcript.durable_from(),
            durable_through: transcript.durable_through(),
            turns: turns.len(),
            first_turn: turns.first().map(|turn| turn.turn_id.clone()),
            last_turn: turns.last().map(|turn| (turn.turn_id.clone(), turn.status)),
            partial_turn: transcript.has_partial_turn(),
        }
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }
}

/// Every turn of `transcript` that edited a file, oldest first, running
/// turns included (a later turn's edits are part of what an earlier turn's
/// changes are worked out from). A turn whose first rows the transcript
/// does not hold yet ([`Transcript::has_turn_start`]) is left out, not
/// counted from the part it holds: its card and its scope wait for the
/// older history that completes it.
pub fn session_edits(transcript: &Transcript) -> Vec<TurnEdits> {
    transcript
        .turns()
        .iter()
        .filter(|turn| transcript.has_turn_start(&turn.turn_id))
        .filter_map(turn_edits)
        .collect()
}

/// `turn`'s file edits, or `None` when it made none.
pub fn turn_edits(turn: &TurnView) -> Option<TurnEdits> {
    let edits: Vec<FileEdit> = turn
        .items
        .iter()
        .filter_map(|item| match item {
            TurnItem::Tool(tool) if tool.status == ToolStatus::Completed => Some(tool_edits(tool)),
            _ => None,
        })
        .flatten()
        .collect();
    if edits.is_empty() {
        return None;
    }
    let prompt = turn
        .items
        .iter()
        .find_map(|item| match item {
            TurnItem::User(user) => Some(first_line(user.text())),
            _ => None,
        })
        .unwrap_or_default();
    Some(TurnEdits {
        turn_id: turn.turn_id.clone(),
        status: turn.status,
        prompt,
        started_at: turn.started_at,
        edits,
    })
}

fn first_line(text: &str) -> String {
    text.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or("").to_owned()
}

/// The files a succeeded call changed.
fn tool_edits(tool: &ToolItem) -> Vec<FileEdit> {
    let edit = |path: String, change: EditChange| FileEdit {
        tool_use_id: tool.tool_use_id.clone(),
        tool_name: tool.tool_name.clone(),
        path,
        change,
    };
    let args = tool.args.as_ref().or(tool.args_preview.as_ref());
    let result = tool.result.as_ref();
    let kind = result.and_then(|result| result.get("kind")).and_then(Value::as_str);
    match tool.tool_name.as_str() {
        "Edit" | "FormatJson" => {
            let path = result_path(result).or_else(|| arg_path(args));
            let change = match kind {
                Some("file_diff") => match str_field(result, "diff") {
                    Some(diff) => EditChange::Unified { diff: diff.into(), after: None },
                    None => EditChange::Unknown,
                },
                // FormatJson's diagnostic: a file it left as it was.
                Some("json")
                    if json_value(result).and_then(|value| value.get("changed"))
                        == Some(&Value::Bool(false)) =>
                {
                    return Vec::new();
                }
                _ => EditChange::Unknown,
            };
            path.map(|path| vec![edit(path, change)]).unwrap_or_default()
        }
        "Write" => {
            let path = result_path(result).or_else(|| arg_path(args));
            let content = args.and_then(|args| args.get("content")).and_then(Value::as_str);
            let change = match (kind, str_field(result, "diff"), content) {
                (Some("file_diff"), Some(diff), content) if creates(diff) => EditChange::Created {
                    content: content.map_or_else(|| added_text(diff), Arc::from),
                },
                (Some("file_diff"), Some(diff), content) => {
                    EditChange::Unified { diff: diff.into(), after: content.map(Arc::from) }
                }
                (_, _, Some(content)) => EditChange::Written {
                    content: content.into(),
                    bytes: result.and_then(|result| result.get("bytes")).and_then(Value::as_u64),
                },
                _ => EditChange::Unknown,
            };
            path.map(|path| vec![edit(path, change)]).unwrap_or_default()
        }
        "apply_patch" => {
            let failed = json_value(result)
                .and_then(|value| value.get("status"))
                .is_some_and(|status| status == "failed");
            if failed {
                return Vec::new();
            }
            patch_operations(args)
                .into_iter()
                .map(|operation| {
                    let change = match operation.kind {
                        OperationKind::Create => {
                            EditChange::Created { content: create_content(&operation.diff).into() }
                        }
                        OperationKind::Update => EditChange::Patch(operation.diff.into()),
                        OperationKind::Delete => EditChange::Deleted,
                    };
                    edit(operation.path, change)
                })
                .collect()
        }
        _ => Vec::new(),
    }
}

fn str_field<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a str> {
    value?.get(key)?.as_str()
}

fn json_value(result: Option<&Value>) -> Option<&Value> {
    let result = result?;
    (result.get("kind")?.as_str()? == "json").then(|| result.get("value"))?
}

/// The file a result names: a `file_diff`'s first path, a `file_write`'s
/// path, or the `path` of a JSON result.
fn result_path(result: Option<&Value>) -> Option<String> {
    let result = result?;
    let path = match result.get("kind")?.as_str()? {
        "file_diff" => result.get("paths")?.as_array()?.first()?.as_str(),
        "file_write" => result.get("path")?.as_str(),
        "json" => result.get("value")?.get("path")?.as_str(),
        _ => None,
    }?;
    (!path.is_empty()).then(|| path.to_owned())
}

fn arg_path(args: Option<&Value>) -> Option<String> {
    let args = args?;
    ["path", "file_path"]
        .iter()
        .find_map(|key| args.get(*key)?.as_str())
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
}

/// A unified diff that creates its file: its old side is `/dev/null`.
fn creates(diff: &str) -> bool {
    diff.lines().find(|line| line.starts_with("--- ")) == Some("--- /dev/null")
}

/// A new file's text from the diff that created it: its added lines, each
/// ended. Only used when the call's own `content` is missing.
fn added_text(diff: &str) -> Arc<str> {
    let mut text = String::new();
    let mut in_hunk = false;
    for line in diff.split('\n') {
        if line.starts_with("@@ ") {
            in_hunk = true;
        } else if in_hunk && let Some(added) = line.strip_prefix('+') {
            text.push_str(added);
            text.push('\n');
        }
    }
    text.into()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OperationKind {
    Create,
    Update,
    Delete,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Operation {
    kind: OperationKind,
    path: String,
    /// A create's `+` lines, or an update's V4A section; empty for a delete.
    diff: String,
}

/// The operations of an `apply_patch` input: the patch text itself, or
/// `{patch}`, or one `{operation: {type, path, diff}}`
/// (`applyPatchTool.impl` in packages/runtime/src/builtin-tools.ts).
fn patch_operations(args: Option<&Value>) -> Vec<Operation> {
    let Some(args) = args else { return Vec::new() };
    let patch = args.as_str().or_else(|| args.get("patch").and_then(Value::as_str));
    if let Some(patch) = patch {
        return parse_codex_patch(patch);
    }
    let Some(operation) = args.get("operation") else { return Vec::new() };
    let kind = match operation.get("type").and_then(Value::as_str) {
        Some("create_file") => OperationKind::Create,
        Some("update_file") => OperationKind::Update,
        Some("delete_file") => OperationKind::Delete,
        _ => return Vec::new(),
    };
    let Some(path) = operation.get("path").and_then(Value::as_str).filter(|path| !path.is_empty())
    else {
        return Vec::new();
    };
    let diff = operation.get("diff").and_then(Value::as_str).unwrap_or_default();
    vec![Operation { kind, path: path.to_owned(), diff: diff.to_owned() }]
}

/// `parseCodexV4aPatch`: `*** Begin Patch`, then per file an `*** Add
/// File:`, `*** Delete File:` or `*** Update File:` header and its lines,
/// then `*** End Patch`. A patch the Host would have refused gives nothing.
fn parse_codex_patch(input: &str) -> Vec<Operation> {
    let normalized = input.replace("\r\n", "\n");
    let mut lines: Vec<&str> = normalized.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    if lines.first() != Some(&"*** Begin Patch") || lines.last() != Some(&"*** End Patch") {
        return Vec::new();
    }
    let lines = &lines[1..lines.len() - 1];
    let header = |line: &str| -> Option<(OperationKind, String)> {
        let rest = line.strip_prefix("*** ")?;
        let (kind, path) = if let Some(path) = rest.strip_prefix("Add File: ") {
            (OperationKind::Create, path)
        } else if let Some(path) = rest.strip_prefix("Delete File: ") {
            (OperationKind::Delete, path)
        } else {
            (OperationKind::Update, rest.strip_prefix("Update File: ")?)
        };
        let path = path.trim();
        (!path.is_empty()).then(|| (kind, path.to_owned()))
    };
    let mut operations = Vec::new();
    let mut ix = 0;
    while ix < lines.len() {
        let Some((kind, path)) = header(lines[ix]) else { return Vec::new() };
        ix += 1;
        if kind == OperationKind::Delete {
            operations.push(Operation { kind, path, diff: String::new() });
            continue;
        }
        let start = ix;
        while ix < lines.len() && header(lines[ix]).is_none() {
            ix += 1;
        }
        let body = &lines[start..ix];
        if body.is_empty() {
            return Vec::new();
        }
        let diff = match kind {
            // The parser ends an added file with an empty `+` line: its
            // text ends with a line end.
            OperationKind::Create => [body, &["+"]].concat().join("\n"),
            _ => body.join("\n"),
        };
        operations.push(Operation { kind, path, diff });
    }
    operations
}

/// A created file's text from its `+` lines, as `applyDiff` in create mode
/// makes it (`@openai/agents-core` `utils/applyDiff`): each line without
/// its `+`, joined by line ends, a last empty line dropped first.
pub fn create_content(diff: &str) -> String {
    let mut lines: Vec<&str> =
        diff.split('\n').map(|line| line.strip_suffix('\r').unwrap_or(line)).collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    lines.iter().map(|line| line.strip_prefix('+').unwrap_or(line)).collect::<Vec<_>>().join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::materialize::materialize_turn;
    use host_protocol::StoredMessage;
    use serde_json::json;

    fn turn(rows: Vec<Value>) -> TurnView {
        let rows: Vec<StoredMessage> =
            rows.into_iter().map(|value| serde_json::from_value(value).expect("row")).collect();
        let refs: Vec<&StoredMessage> = rows.iter().collect();
        materialize_turn("t", &refs).view
    }

    fn call(id: &str, tool: &str, args: Value) -> Value {
        json!({"type": "tool_call", "id": id, "turnId": "t", "ts": 2, "toolName": tool,
               "args": args, "stepId": "s1"})
    }

    fn result(id: &str, content: Value, error: bool) -> Value {
        json!({"type": "tool_result", "id": format!("r-{id}"), "turnId": "t", "ts": 3,
               "toolUseId": id, "isError": error, "content": content})
    }

    const EDIT_DIFF: &str = "--- a//w/a.py\n+++ b//w/a.py\n@@ -1,2 +1,2 @@\n-x = 1\n+x = 2\n y = 3";

    /// Each file tool's succeeded calls, in order; Bash and failed calls
    /// are left out; apply_patch's operations come from its input.
    #[test]
    fn a_turn_lists_its_file_edits_in_order() {
        let patch = "*** Begin Patch\n*** Update File: b.txt\n@@\n one\n-two\n+2\n*** Delete File: \
                     c.txt\n*** Add File: d.txt\n+hello\n*** End Patch";
        let view = turn(vec![
            json!({"type": "user", "id": "t", "turnId": "t", "ts": 1,
                   "text": "\n  Build the report\nthen check it"}),
            call(
                "c1",
                "Edit",
                json!({"path": "a.py", "old_string": "x = 1", "new_string": "x = 2"}),
            ),
            result(
                "c1",
                json!({"kind": "file_diff", "paths": ["/w/a.py"], "diff": EDIT_DIFF}),
                false,
            ),
            call("c2", "Bash", json!({"command": "sed -i s/a/b/ a.py"})),
            result("c2", json!({"kind": "text", "text": ""}), false),
            call("c3", "Write", json!({"path": "new.txt", "content": "hi\n"})),
            result(
                "c3",
                json!({"kind": "file_diff", "paths": ["/w/new.txt"],
                                "diff": "--- /dev/null\n+++ b//w/new.txt\n@@ -0,0 +1 @@\n+hi"}),
                false,
            ),
            call("c4", "Edit", json!({"path": "a.py"})),
            result("c4", json!({"kind": "text", "text": "old_string not found"}), true),
            call("c5", "apply_patch", json!(patch)),
            result("c5", json!({"kind": "json", "value": {"status": "completed"}}), false),
            call("c6", "Write", json!({"path": "/w/big.txt", "content": "big"})),
            result("c6", json!({"kind": "file_write", "path": "/w/big.txt", "bytes": 3}), false),
            json!({"type": "assistant", "id": "s1", "turnId": "t", "ts": 4, "text": "Done.",
                   "contentOrder": ["tools", "text"], "modelId": "m"}),
            json!({"type": "turn_state", "id": "e", "turnId": "t", "ts": 6, "status": "completed"}),
        ]);
        let edits = turn_edits(&view).expect("edits");
        assert_eq!(edits.prompt, "Build the report");
        assert!(edits.is_settled());
        let listed: Vec<(&str, &str)> = edits
            .edits
            .iter()
            .map(|edit| (edit.tool_use_id.as_str(), edit.path.as_str()))
            .collect();
        assert_eq!(
            listed,
            [
                ("c1", "/w/a.py"),
                ("c3", "/w/new.txt"),
                ("c5", "b.txt"),
                ("c5", "c.txt"),
                ("c5", "d.txt"),
                ("c6", "/w/big.txt")
            ]
        );
        let changes: Vec<&EditChange> = edits.edits.iter().map(|edit| &edit.change).collect();
        assert_eq!(*changes[0], EditChange::Unified { diff: EDIT_DIFF.into(), after: None });
        assert_eq!(*changes[1], EditChange::Created { content: "hi\n".into() });
        assert_eq!(*changes[2], EditChange::Patch("@@\n one\n-two\n+2".into()));
        assert_eq!(*changes[3], EditChange::Deleted);
        assert_eq!(*changes[4], EditChange::Created { content: "hello\n".into() });
        assert_eq!(*changes[5], EditChange::Written { content: "big".into(), bytes: Some(3) });
    }

    /// The single-operation input, a failed batch, a diffless Edit, an
    /// archived result and an unchanged FormatJson.
    #[test]
    fn edits_without_a_diff_are_kept_and_failures_dropped() {
        let archived = json!({"kind": "archived_tool_result", "status": "not_loaded",
            "runtimeEventId": "e", "toolCallId": "c3", "toolName": "Edit",
            "originalEstimatedTokens": 1, "originalBytes": 1, "rewriteVersion": 1,
            "reason": "tool_result_pruned"});
        let view = turn(vec![
            call(
                "c1",
                "apply_patch",
                json!({"operation": {"type": "update_file", "path": "a.txt",
                                                            "diff": "@@\n-a\n+b"}}),
            ),
            result("c1", json!({"kind": "json", "value": {"status": "completed"}}), false),
            call(
                "c2",
                "apply_patch",
                json!({"patch": "*** Begin Patch\n*** Delete File: x\n*** End Patch"}),
            ),
            result(
                "c2",
                json!({"kind": "json", "value": {"status": "failed", "output": "no"}}),
                false,
            ),
            call("c3", "Edit", json!({"path": "/w/e.rs"})),
            result("c3", archived, false),
            call("c4", "FormatJson", json!({"path": "/w/p.json"})),
            result(
                "c4",
                json!({"kind": "json", "value": {"path": "/w/p.json", "changed": false}}),
                false,
            ),
            call("c5", "Edit", json!({"path": "/w/f.rs"})),
            result("c5", json!({"kind": "json", "value": {"ok": true, "path": "/w/f.rs"}}), false),
        ]);
        let edits = turn_edits(&view).expect("edits").edits;
        let listed: Vec<(&str, &EditChange)> =
            edits.iter().map(|edit| (edit.path.as_str(), &edit.change)).collect();
        assert_eq!(
            listed,
            [
                ("a.txt", &EditChange::Patch("@@\n-a\n+b".into())),
                ("/w/e.rs", &EditChange::Unknown),
                ("/w/f.rs", &EditChange::Unknown),
            ]
        );
        assert_eq!(turn_edits(&turn(vec![call("c1", "Bash", json!({}))])), None);
    }

    // A code cell (`exec`) calls tools from its script, in the shape a real
    // Host stores them at epoch 197: each call is a row of its own, named
    // after the tool (`Write`, not `tools.Write`), with the id `<exec
    // id>:nested:<uuid>` in the step `<exec id>:nested`, its origin
    // `code_mode` and its parent the `exec`. A step's assistant row comes
    // before its calls.

    const EXEC: &str = "call_e1";

    fn step(id: &str, text: &str) -> Value {
        json!({"type": "assistant", "id": id, "turnId": "t", "ts": 2, "text": text,
               "thinking": {"text": "Plan the next step."},
               "contentOrder": ["thinking", "text", "tools"], "modelId": "m"})
    }

    fn exec_call(step: &str) -> Value {
        json!({"type": "tool_call", "id": EXEC, "turnId": "t", "ts": 2, "toolName": "exec",
               "stepId": step, "origin": "provider", "modelVisibility": "visible",
               "args": {"code": "await tools.Write({path: \"notes.md\", content: \"# Notes\\n\"});"}})
    }

    fn exec_result(content: Value, error: bool) -> Value {
        json!({"type": "tool_result", "id": "op-exec_response", "turnId": "t", "ts": 4,
               "toolUseId": EXEC, "isError": error, "origin": "provider",
               "modelVisibility": "visible", "content": content})
    }

    /// Call `id` of the code cell (`<exec id>:nested:<id>`) and its
    /// result, or the call alone without one.
    fn nested(id: &str, tool: &str, args: Value, result: Option<(Value, bool)>) -> Vec<Value> {
        let tool_use_id = format!("{EXEC}:nested:{id}");
        let tag = |mut row: Value| {
            row["origin"] = json!("code_mode");
            row["modelVisibility"] = json!("hidden");
            row["parentToolCallId"] = json!(EXEC);
            row["parentOperationId"] = json!("op-exec");
            row
        };
        let mut rows = vec![tag(json!({"type": "tool_call", "id": tool_use_id, "turnId": "t",
                                       "ts": 3, "toolName": tool, "args": args,
                                       "stepId": format!("{EXEC}:nested")}))];
        if let Some((content, error)) = result {
            rows.push(tag(json!({"type": "tool_result", "id": format!("op-{id}_response"),
                                 "turnId": "t", "ts": 3, "toolUseId": tool_use_id,
                                 "isError": error, "content": content})));
        }
        rows
    }

    const NOTES_DIFF: &str = "--- /dev/null\n+++ b//w/notes.md\n@@ -0,0 +1 @@\n+# Notes";

    fn write_notes() -> Vec<Value> {
        nested(
            "u1",
            "Write",
            json!({"path": "notes.md", "content": "# Notes\n"}),
            Some((
                json!({"kind": "file_diff", "paths": ["/w/notes.md"], "diff": NOTES_DIFF}),
                false,
            )),
        )
    }

    fn edit_report(id: &str) -> Vec<Value> {
        nested(
            id,
            "Edit",
            json!({"path": "a.py", "old_string": "x = 1", "new_string": "x = 2"}),
            Some((json!({"kind": "file_diff", "paths": ["/w/a.py"], "diff": EDIT_DIFF}), false)),
        )
    }

    fn listed(view: &TurnView) -> Vec<(String, String, String)> {
        turn_edits(view)
            .map(|edits| edits.edits)
            .unwrap_or_default()
            .into_iter()
            .map(|edit| (edit.tool_use_id, edit.tool_name, edit.path))
            .collect()
    }

    fn row(id: &str, tool: &str, path: &str) -> (String, String, String) {
        (id.to_owned(), tool.to_owned(), path.to_owned())
    }

    /// The `Write` and `Edit` a code cell's script makes are the turn's
    /// edits, in the order they ran; its `Bash` and the `exec` itself are
    /// not.
    #[test]
    fn the_calls_a_code_cell_makes_are_its_turns_edits() {
        let mut rows = vec![
            json!({"type": "user", "id": "t", "turnId": "t", "ts": 1, "text": "Write the notes"}),
            step("s1", ""),
            exec_call("s1"),
        ];
        rows.extend(write_notes());
        rows.extend(edit_report("u2"));
        rows.extend(nested(
            "u3",
            "Bash",
            json!({"command": "python a.py"}),
            Some((json!({"kind": "text", "text": ""}), false)),
        ));
        rows.extend([
            exec_result(json!({"kind": "json", "value": {"ok": true}}), false),
            step("s2", "Done."),
            json!({"type": "turn_state", "id": "e", "turnId": "t", "ts": 6, "status": "completed"}),
        ]);
        let view = turn(rows);
        assert_eq!(
            listed(&view),
            [
                row("call_e1:nested:u1", "Write", "/w/notes.md"),
                row("call_e1:nested:u2", "Edit", "/w/a.py")
            ]
        );
        let changes: Vec<EditChange> =
            turn_edits(&view).expect("edits").edits.into_iter().map(|edit| edit.change).collect();
        assert_eq!(
            changes,
            [
                EditChange::Created { content: "# Notes\n".into() },
                EditChange::Unified { diff: EDIT_DIFF.into(), after: None },
            ]
        );
    }

    /// A call that succeeded changed its file, whatever became of the code
    /// cell after it: the `exec` failing, or the turn being stopped while
    /// it ran. A call that failed, or never finished, did not count.
    #[test]
    fn a_code_cell_that_failed_or_was_stopped_keeps_its_calls_edits() {
        let mut failed = vec![step("s1", ""), exec_call("s1")];
        failed.extend(write_notes());
        failed.extend(nested(
            "u2",
            "Edit",
            json!({"path": "a.py"}),
            Some((json!({"kind": "text", "text": "old_string not found"}), true)),
        ));
        failed.extend([
            exec_result(json!({"kind": "text", "text": "Error: the script threw"}), true),
            step("s2", "It failed."),
            json!({"type": "turn_state", "id": "e", "turnId": "t", "ts": 6, "status": "completed"}),
        ]);
        let view = turn(failed);
        let exec = view.item(&crate::ItemKey::Tool(EXEC.into()));
        assert!(matches!(exec, Some(TurnItem::Tool(tool)) if tool.status == ToolStatus::Errored));
        assert_eq!(listed(&view), [row("call_e1:nested:u1", "Write", "/w/notes.md")]);

        let mut stopped = vec![step("s1", ""), exec_call("s1")];
        stopped.extend(write_notes());
        stopped.extend(nested("u2", "Edit", json!({"path": "a.py"}), None));
        stopped.push(
            json!({"type": "turn_state", "id": "e", "turnId": "t", "ts": 6, "status": "aborted"}),
        );
        let view = turn(stopped);
        let exec = view.item(&crate::ItemKey::Tool(EXEC.into()));
        assert!(
            matches!(exec, Some(TurnItem::Tool(tool)) if tool.status == ToolStatus::Interrupted)
        );
        assert_eq!(listed(&view), [row("call_e1:nested:u1", "Write", "/w/notes.md")]);
    }

    /// The model's own calls and a code cell's calls list together, in the
    /// order they ran.
    #[test]
    fn direct_and_code_cell_edits_list_in_the_order_they_ran() {
        let direct = |id: &str, step: &str, tool: &str, args: Value, content: Value| {
            vec![
                json!({"type": "tool_call", "id": id, "turnId": "t", "ts": 2, "toolName": tool,
                       "args": args, "stepId": step, "origin": "provider",
                       "modelVisibility": "visible"}),
                result(id, content, false),
            ]
        };
        let mut rows = vec![step("s1", "")];
        rows.extend(direct(
            "c1",
            "s1",
            "Edit",
            json!({"path": "a.py"}),
            json!({"kind": "file_diff", "paths": ["/w/a.py"], "diff": EDIT_DIFF}),
        ));
        rows.extend([step("s2", ""), exec_call("s2")]);
        rows.extend(write_notes());
        rows.extend(edit_report("u2"));
        rows.extend([
            exec_result(json!({"kind": "json", "value": {"ok": true}}), false),
            step("s3", "Now the summary."),
        ]);
        rows.extend(direct(
            "c2",
            "s3",
            "Write",
            json!({"path": "/w/summary.md", "content": "big"}),
            json!({"kind": "file_write", "path": "/w/summary.md", "bytes": 3}),
        ));
        rows.extend([
            step("s4", "Done."),
            json!({"type": "turn_state", "id": "e", "turnId": "t", "ts": 6, "status": "completed"}),
        ]);
        assert_eq!(
            listed(&turn(rows)),
            [
                row("c1", "Edit", "/w/a.py"),
                row("call_e1:nested:u1", "Write", "/w/notes.md"),
                row("call_e1:nested:u2", "Edit", "/w/a.py"),
                row("c2", "Write", "/w/summary.md"),
            ]
        );
    }

    #[test]
    fn a_created_files_text_follows_apply_diff() {
        assert_eq!(create_content("+a\n+b\n+"), "a\nb\n");
        assert_eq!(create_content("+a\r\n+b"), "a\nb");
        assert_eq!(create_content("+only\n"), "only");
    }
}
