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

//! Each turn's net change to each file it edited, worked out from the
//! session's tracked edits and, when the Host is on this machine, the
//! file's text now.
//!
//! The algorithm, per file, over every tracked edit of it in the session:
//!
//! 1. Start from the file as it is now: its text, or absent. A file that
//!    cannot be read (not text, past [`FILE_MAX_PATCH_BYTES`], not a file,
//!    or on a Host elsewhere) gives no start.
//! 2. Undo the edits newest first ([`super::patch`]): a unified diff's new
//!    side must be where its hunks say, a V4A section's new side where its
//!    anchors lead and the section must redo to the same text, a created
//!    or whole written file must hold exactly what was written, and a
//!    deleted file must be absent. The state after each turn's last edit
//!    and before its first edit fall out on the way. Any mismatch (a shell
//!    command or the person changed the file since, an edit whose change is
//!    unknown, an archived diff, a delete) leaves every older state
//!    unknown.
//! 3. A turn whose before and after are both known gets its net diff: the
//!    two texts compared line by line (Myers, `similar`) and written as
//!    Git writes a unified diff with [`DIFF_CONTEXT_LINES`] of context,
//!    under a `diff --git` header; a file the turn created shows as added,
//!    one it deleted as deleted.
//! 4. Any other turn shows its edits of the file one after another, each
//!    its own diff ([`FileView::Steps`]), their counts summed. A file the
//!    turn deleted shows as deleted with the lines it had when the session
//!    last knew them (redoing the edits from a whole text it wrote, oldest
//!    first), else with no counts.
//!
//! A `Write` with no diff (`file_write`) created the file when the session
//! has no earlier edit of it (or the last one deleted it); otherwise it
//! replaced a text it does not show, which nothing can be undone past.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

use similar::{Algorithm, DiffOp};
use transcript_model::edits::{EditChange, FileEdit, TurnEdits};

use super::patch::{
    Section, apply_patch, apply_unified, parse_sections, split_lines, unapply_patch,
    unapply_unified,
};
use super::{ChangeKind, FileChange, FileView, Step, TurnChange};
use crate::git::{DIFF_CONTEXT_LINES, FILE_MAX_PATCH_BYTES};

/// How long one file's comparison may search for the shortest diff before
/// it settles for a longer one.
const DIFF_DEADLINE: Duration = Duration::from_secs(2);

/// Where the session's files are: the task's folder, which relative paths
/// resolve against and shown paths are relative to, and whether this
/// machine can read them.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct Place {
    pub(crate) folder: Option<PathBuf>,
    pub(crate) readable: bool,
}

/// A file as it is now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum OnDisk {
    Absent,
    Text(String),
    /// Not text, too large, not a file, or not readable.
    Unreadable,
}

/// A file's state between edits.
#[derive(Debug, Clone, PartialEq, Eq)]
enum State {
    Absent,
    Text(String),
}

/// One tracked edit as the algorithm reads it: a whole write resolved to a
/// creation or a replacement.
#[derive(Debug, Clone, Copy)]
enum Step0<'a> {
    Unified { diff: &'a str, after: Option<&'a str> },
    Patch(&'a str),
    Unknown,
    Created(&'a str),
    Replaced(&'a str),
    Deleted,
}

/// An edit of a file, with the turn (its place in the session's list) that
/// made it.
struct Tracked<'a> {
    turn: usize,
    tool_use_id: &'a str,
    step: Step0<'a>,
}

/// A file the session edited.
struct Edited<'a> {
    /// Where it is: absolute, or relative when there is no folder.
    key: String,
    /// As shown: relative to the folder when inside it.
    label: String,
    edits: Vec<Tracked<'a>>,
}

/// The session's edited files in the order they were first edited, and the
/// path of each file each turn edited, in the turn's order.
fn edited_files<'a>(
    turns: &'a [TurnEdits],
    folder: Option<&Path>,
) -> (Vec<Edited<'a>>, Vec<Vec<usize>>) {
    let mut files: Vec<Edited<'a>> = Vec::new();
    let mut by_key: HashMap<String, usize> = HashMap::new();
    let mut per_turn = vec![Vec::new(); turns.len()];
    for (turn_ix, turn) in turns.iter().enumerate() {
        for edit in &turn.edits {
            let key = resolve(&edit.path, folder);
            let file_ix = *by_key.entry(key.clone()).or_insert_with(|| {
                files.push(Edited { label: label(&key, folder), key, edits: Vec::new() });
                files.len() - 1
            });
            let file = &mut files[file_ix];
            let exists_before =
                file.edits.last().is_some_and(|last| !matches!(last.step, Step0::Deleted));
            file.edits.push(Tracked {
                turn: turn_ix,
                tool_use_id: &edit.tool_use_id,
                step: step_of(edit, exists_before),
            });
            if !per_turn[turn_ix].contains(&file_ix) {
                per_turn[turn_ix].push(file_ix);
            }
        }
    }
    (files, per_turn)
}

fn step_of(edit: &FileEdit, exists_before: bool) -> Step0<'_> {
    match &edit.change {
        EditChange::Unified { diff, after } => Step0::Unified { diff, after: after.as_deref() },
        EditChange::Patch(diff) => Step0::Patch(diff),
        EditChange::Created { content } => Step0::Created(content),
        EditChange::Written { content, .. } if exists_before => Step0::Replaced(content),
        EditChange::Written { content, .. } => Step0::Created(content),
        EditChange::Deleted => Step0::Deleted,
        _ => Step0::Unknown,
    }
}

/// `path` resolved against `folder` when relative, `.` and `..` folded.
pub(crate) fn resolve(path: &str, folder: Option<&Path>) -> String {
    let joined = match folder {
        Some(folder) if Path::new(path).is_relative() => folder.join(path),
        _ => PathBuf::from(path),
    };
    normalize(&joined).to_string_lossy().into_owned()
}

/// `path` with `.` and `..` folded, as written (links are not followed).
fn normalize(path: &Path) -> PathBuf {
    let mut normal = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normal.pop();
            }
            other => normal.push(other),
        }
    }
    normal
}

/// `key` as shown: relative to `folder` when inside it.
fn label(key: &str, folder: Option<&Path>) -> String {
    folder
        .and_then(|folder| Path::new(key).strip_prefix(normalize(folder)).ok())
        .map(|rest| rest.to_string_lossy().into_owned())
        .filter(|rest| !rest.is_empty())
        .unwrap_or_else(|| key.to_owned())
}

/// A turn's net change of one file, kept while the turn's edits of it stay
/// the same: what was worked out once stays true, whatever happens to the
/// file later.
#[derive(Debug, Clone)]
pub(crate) struct Kept {
    pub(crate) edits: Vec<String>,
    pub(crate) change: FileChange,
}

/// The files of `turns` whose changes are to be worked out, by key: on a
/// Host elsewhere none, and a file every turn of which has a [`Kept`]
/// change needs no reading.
pub(crate) fn files_to_read(
    turns: &[TurnEdits],
    place: &Place,
    kept: &HashMap<(String, String), Kept>,
) -> Vec<PathBuf> {
    if !place.readable {
        return Vec::new();
    }
    let (files, _) = edited_files(turns, place.folder.as_deref());
    files
        .iter()
        .filter(|file| {
            file.edits.iter().any(|edit| kept_for(kept, turns, edit.turn, file).is_none())
        })
        .map(|file| PathBuf::from(&file.key))
        .collect()
}

/// The [`Kept`] change of `file` in turn `turn_ix`, if it was worked out
/// for the same edits.
fn kept_for<'k>(
    kept: &'k HashMap<(String, String), Kept>,
    turns: &[TurnEdits],
    turn_ix: usize,
    file: &Edited<'_>,
) -> Option<&'k Kept> {
    let entry = kept.get(&(turns[turn_ix].turn_id.clone(), file.key.clone()))?;
    let edits = file.edits.iter().filter(|edit| edit.turn == turn_ix).map(|edit| edit.tool_use_id);
    edits.eq(entry.edits.iter().map(String::as_str)).then_some(entry)
}

/// Reads the file at `path` as it is now, for [`compute`]: on the
/// background executor (`async_fs` runs it on the blocking pool).
pub(crate) async fn read_on_disk(path: &Path) -> OnDisk {
    let metadata = match async_fs::symlink_metadata(path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return OnDisk::Absent,
        Err(_) => return OnDisk::Unreadable,
    };
    if !metadata.is_file() || metadata.len() > FILE_MAX_PATCH_BYTES as u64 {
        return OnDisk::Unreadable;
    }
    match async_fs::read(path).await {
        Ok(bytes) if !bytes.contains(&0) => {
            String::from_utf8(bytes).map_or(OnDisk::Unreadable, OnDisk::Text)
        }
        Ok(_) => OnDisk::Unreadable,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => OnDisk::Absent,
        Err(_) => OnDisk::Unreadable,
    }
}

/// Every turn's change of every file it edited, in the turn's order of
/// first edits, given the files `disk` read now (by key; a file not in it
/// was not read). A change in `kept` for the same edits is taken as it is.
pub(crate) fn compute(
    turns: &[TurnEdits],
    place: &Place,
    disk: &HashMap<PathBuf, OnDisk>,
    kept: &HashMap<(String, String), Kept>,
) -> Vec<TurnChange> {
    let (files, per_turn) = edited_files(turns, place.folder.as_deref());
    let mut changes: HashMap<(usize, usize), FileChange> = HashMap::new();
    for (file_ix, file) in files.iter().enumerate() {
        let now = match disk.get(Path::new(&file.key)) {
            Some(OnDisk::Absent) if place.readable => Some(State::Absent),
            Some(OnDisk::Text(text)) if place.readable => Some(State::Text(text.clone())),
            _ => None,
        };
        for (turn_ix, change) in file_changes(turns, file, now, kept) {
            changes.insert((turn_ix, file_ix), change);
        }
    }
    turns
        .iter()
        .enumerate()
        .map(|(turn_ix, turn)| {
            let files: Vec<FileChange> = per_turn[turn_ix]
                .iter()
                .filter_map(|file_ix| changes.remove(&(turn_ix, *file_ix)))
                .collect();
            TurnChange::new(turn, files)
        })
        .collect()
}

/// `file`'s change in each turn that edited it, from its state `now`.
fn file_changes(
    turns: &[TurnEdits],
    file: &Edited<'_>,
    now: Option<State>,
    kept: &HashMap<(String, String), Kept>,
) -> Vec<(usize, FileChange)> {
    // What the session last knew of the file before each delete, redoing
    // its edits from a whole text, oldest first.
    let mut known: Option<State> = None;
    let mut at_delete: HashMap<usize, Option<String>> = HashMap::new();
    let mut known_before_turn: HashMap<usize, Option<String>> = HashMap::new();
    for (ix, edit) in file.edits.iter().enumerate() {
        known_before_turn.entry(edit.turn).or_insert_with(|| text_of(known.as_ref()));
        known = match (edit.step, known.take()) {
            (Step0::Created(text) | Step0::Replaced(text), _) => Some(State::Text(text.to_owned())),
            (Step0::Unified { after: Some(text), .. }, _) => Some(State::Text(text.to_owned())),
            (Step0::Unified { diff, .. }, Some(State::Text(text))) => {
                apply_unified(&text, diff).map(State::Text)
            }
            (Step0::Patch(diff), Some(State::Text(text))) => {
                apply_patch(&text, diff).map(State::Text)
            }
            (Step0::Deleted, state) => {
                at_delete.insert(ix, text_of(state.as_ref()));
                Some(State::Absent)
            }
            _ => None,
        };
    }

    // Newest first: the state after each turn's last edit and before its
    // first one.
    let mut results = Vec::new();
    let mut state = now;
    let mut ix = file.edits.len();
    while ix > 0 {
        let turn_ix = file.edits[ix - 1].turn;
        let mut start = ix;
        while start > 0 && file.edits[start - 1].turn == turn_ix {
            start -= 1;
        }
        let edits = &file.edits[start..ix];
        let after = state.clone();
        for edit in edits.iter().rev() {
            state = state.and_then(|state| undo(edit.step, state));
        }
        let before = state.clone();
        let change = match kept_for(kept, turns, turn_ix, file) {
            Some(entry) => entry.change.clone(),
            None => {
                let deleted_text = known_before_turn.get(&turn_ix).cloned().flatten();
                turn_change(file, edits, start, before, after, deleted_text, &at_delete)
            }
        };
        results.push((turn_ix, change));
        ix = start;
    }
    results
}

fn text_of(state: Option<&State>) -> Option<String> {
    match state {
        Some(State::Text(text)) => Some(text.clone()),
        _ => None,
    }
}

/// The state before `step`, given the state after it; `None` when it does
/// not match exactly or cannot be known.
fn undo(step: Step0<'_>, state: State) -> Option<State> {
    match (step, state) {
        (Step0::Unified { diff, after }, State::Text(text)) => {
            if after.is_some_and(|after| after != text) {
                return None;
            }
            unapply_unified(&text, diff).map(State::Text)
        }
        (Step0::Patch(diff), State::Text(text)) => unapply_patch(&text, diff).map(State::Text),
        (Step0::Created(content), State::Text(text)) if text == content => Some(State::Absent),
        _ => None,
    }
}

/// One file's change in one turn: net when both ends are known, else its
/// edits one after another. `edits` are the turn's edits of the file, the
/// first at `first` among the file's.
fn turn_change(
    file: &Edited<'_>,
    edits: &[Tracked<'_>],
    first: usize,
    before: Option<State>,
    after: Option<State>,
    known_before: Option<String>,
    at_delete: &HashMap<usize, Option<String>>,
) -> FileChange {
    let label = file.label.as_str();
    let edit_ids = edits.iter().map(|edit| edit.tool_use_id.to_owned()).collect();
    let net = |patch: String, kind: ChangeKind, counts: Option<(u32, u32)>| FileChange {
        path: label.into(),
        kind,
        counts,
        view: FileView::Net(patch.into()),
        edits: edit_ids,
        key: file.key.clone(),
        exact: true,
    };
    if let (Some(before), Some(after)) = (&before, &after) {
        let (patch, counts) = net_patch(label, before, after);
        let kind = match (before, after) {
            (State::Absent, State::Text(_)) => ChangeKind::Created,
            (State::Text(_), State::Absent) => ChangeKind::Deleted,
            _ => ChangeKind::Modified,
        };
        return net(patch, kind, Some(counts));
    }
    // Deleted by the turn, which did not create it: gone after it,
    // whatever came later; its lines as the session last knew them.
    if matches!(edits[edits.len() - 1].step, Step0::Deleted)
        && !matches!(edits[0].step, Step0::Created(_))
    {
        return match known_before {
            Some(text) => {
                let (patch, counts) = net_patch(label, &State::Text(text), &State::Absent);
                net(patch, ChangeKind::Deleted, Some(counts))
            }
            // Not kept: older history may yet say what it held.
            None => {
                FileChange { exact: false, ..net(deleted_header(label), ChangeKind::Deleted, None) }
            }
        };
    }
    steps_change(file, edits, first, at_delete)
}

/// The turn's edits of a file one after another, each its own diff, their
/// counts summed.
fn steps_change(
    file: &Edited<'_>,
    edits: &[Tracked<'_>],
    first: usize,
    at_delete: &HashMap<usize, Option<String>>,
) -> FileChange {
    let total = edits.len();
    let mut steps = Vec::with_capacity(total);
    for (n, edit) in edits.iter().enumerate() {
        let label = if total == 1 {
            file.label.clone()
        } else {
            format!("{} ({}/{total})", file.label, n + 1)
        };
        let (patch, counts) = match edit.step {
            Step0::Unified { diff, .. } => {
                let counts = shared::diff::line_counts(diff);
                let creates =
                    diff.lines().find(|line| line.starts_with("--- ")) == Some("--- /dev/null");
                (reheaded(&label, diff, creates), Some(counts))
            }
            Step0::Patch(diff) => match parse_sections(diff) {
                Some(sections) => section_patch(&label, &sections),
                None => (header(&label), None),
            },
            Step0::Created(text) => {
                let (patch, counts) = net_patch(&label, &State::Absent, &State::Text(text.into()));
                (patch, Some(counts))
            }
            Step0::Deleted => match at_delete.get(&(first + n)).cloned().flatten() {
                Some(text) => {
                    let (patch, counts) = net_patch(&label, &State::Text(text), &State::Absent);
                    (patch, Some(counts))
                }
                None => (deleted_header(&label), None),
            },
            Step0::Replaced(_) | Step0::Unknown => (header(&label), None),
        };
        steps.push(Step { patch: patch.into(), counts });
    }
    let created = matches!(edits[0].step, Step0::Created(_));
    let deleted = matches!(edits[total - 1].step, Step0::Deleted);
    let kind = match (created, deleted) {
        (_, true) => ChangeKind::Deleted,
        (true, false) => ChangeKind::Created,
        (false, false) => ChangeKind::Modified,
    };
    let known: Vec<(u32, u32)> = steps.iter().filter_map(|step| step.counts).collect();
    let counts = (!known.is_empty()).then(|| {
        known.iter().fold((0u32, 0u32), |(a, d), (add, del)| {
            (a.saturating_add(*add), d.saturating_add(*del))
        })
    });
    FileChange {
        path: file.label.as_str().into(),
        kind,
        counts,
        view: FileView::Steps(steps),
        edits: edits.iter().map(|edit| edit.tool_use_id.to_owned()).collect(),
        key: file.key.clone(),
        exact: false,
    }
}

/// A file header with no hunk.
fn header(label: &str) -> String {
    format!("--- a/{label}\n+++ b/{label}\n")
}

fn deleted_header(label: &str) -> String {
    format!(
        "diff --git a/{label} b/{label}\ndeleted file mode 100644\n--- a/{label}\n+++ /dev/null\n"
    )
}

/// A tool's unified diff under the file's shown name, its own headers
/// dropped.
fn reheaded(label: &str, diff: &str, creates: bool) -> String {
    let mut patch = if creates { format!("--- /dev/null\n+++ b/{label}\n") } else { header(label) };
    let mut in_hunks = false;
    for line in diff.split('\n') {
        in_hunks |= line.starts_with("@@ ");
        if in_hunks {
            patch.push_str(line);
            patch.push('\n');
        }
    }
    patch
}

/// A V4A update as a unified diff, one hunk per section. Its sections carry
/// no line numbers: they are numbered one after another from the top, a
/// line apart.
fn section_patch(label: &str, sections: &[Section]) -> (String, Option<(u32, u32)>) {
    let mut patch = header(label);
    let (mut added, mut removed) = (0u32, 0u32);
    let (mut old_at, mut new_at) = (1usize, 1usize);
    for section in sections {
        let (old, new) = section.sides();
        let ops = similar::capture_diff_slices(Algorithm::Myers, &old, &new);
        write_hunk(&mut patch, &ops, &old, &new, old_at - 1, new_at - 1, &mut added, &mut removed);
        old_at += old.len() + 1;
        new_at += new.len() + 1;
    }
    (patch, Some((added, removed)))
}

/// The diff of `before` against `after` as Git writes it, with
/// [`DIFF_CONTEXT_LINES`] of context, and its counts.
fn net_patch(label: &str, before: &State, after: &State) -> (String, (u32, u32)) {
    let lines = |state: &State| -> Vec<String> {
        match state {
            State::Absent => Vec::new(),
            State::Text(text) => split_lines(text).0.into_iter().map(str::to_owned).collect(),
        }
    };
    let (old, new) = (lines(before), lines(after));
    let mut patch = format!("diff --git a/{label} b/{label}\n");
    match (before, after) {
        (State::Absent, _) => {
            patch.push_str(&format!("new file mode 100644\n--- /dev/null\n+++ b/{label}\n"));
        }
        (_, State::Absent) => {
            patch.push_str(&format!("deleted file mode 100644\n--- a/{label}\n+++ /dev/null\n"));
        }
        _ => patch.push_str(&format!("--- a/{label}\n+++ b/{label}\n")),
    }
    let deadline = Instant::now() + DIFF_DEADLINE;
    let ops = similar::capture_diff_slices_deadline(Algorithm::Myers, &old, &new, Some(deadline));
    let (mut added, mut removed) = (0, 0);
    for group in similar::group_diff_ops(ops, DIFF_CONTEXT_LINES) {
        write_hunk(&mut patch, &group, &old, &new, 0, 0, &mut added, &mut removed);
    }
    (patch, (added, removed))
}

/// One hunk of `ops` (over `old` and `new`, which start `old_offset` and
/// `new_offset` lines into their files), with Git's header: a side of one
/// line gives no count, an empty side the line before it.
#[allow(clippy::too_many_arguments)]
fn write_hunk(
    patch: &mut String,
    ops: &[DiffOp],
    old: &[String],
    new: &[String],
    old_offset: usize,
    new_offset: usize,
    added: &mut u32,
    removed: &mut u32,
) {
    let (Some(first), Some(last)) = (ops.first(), ops.last()) else { return };
    let (old_range, new_range) = (
        first.old_range().start..last.old_range().end,
        first.new_range().start..last.new_range().end,
    );
    if !ops.iter().any(|op| !matches!(op, DiffOp::Equal { .. })) {
        return;
    }
    let range = |start: usize, len: usize| match len {
        0 => format!("{start},0"),
        1 => format!("{}", start + 1),
        len => format!("{},{len}", start + 1),
    };
    patch.push_str(&format!(
        "@@ -{} +{} @@\n",
        range(old_offset + old_range.start, old_range.len()),
        range(new_offset + new_range.start, new_range.len())
    ));
    let mut push = |mark: char, line: &str| {
        patch.push(mark);
        patch.push_str(line);
        patch.push('\n');
    };
    for op in ops {
        match *op {
            DiffOp::Equal { old_index, len, .. } => {
                old[old_index..old_index + len].iter().for_each(|line| push(' ', line));
            }
            DiffOp::Delete { old_index, old_len, .. } => {
                old[old_index..old_index + old_len].iter().for_each(|line| push('-', line));
                *removed = removed.saturating_add(u32::try_from(old_len).unwrap_or(u32::MAX));
            }
            DiffOp::Insert { new_index, new_len, .. } => {
                new[new_index..new_index + new_len].iter().for_each(|line| push('+', line));
                *added = added.saturating_add(u32::try_from(new_len).unwrap_or(u32::MAX));
            }
            DiffOp::Replace { old_index, old_len, new_index, new_len } => {
                old[old_index..old_index + old_len].iter().for_each(|line| push('-', line));
                new[new_index..new_index + new_len].iter().for_each(|line| push('+', line));
                *removed = removed.saturating_add(u32::try_from(old_len).unwrap_or(u32::MAX));
                *added = added.saturating_add(u32::try_from(new_len).unwrap_or(u32::MAX));
            }
        }
    }
}
