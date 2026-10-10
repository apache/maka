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

//! What each turn of the selected task edited, through Maka's file tools:
//! per turn, each file it changed with its net change ([`net`] has the
//! algorithm), for the card under a settled turn and the changes panel's
//! turn scopes.
//!
//! [`TurnChanges`] keeps them for the task the panel follows. Its owner
//! (the window) hands it the session's edits ([`transcript_model::edits`])
//! with the [`EditsKey`] they were read at; an equal key does nothing, so
//! the work runs once per transcript row, not per frame. The work runs on
//! the background executor: reading each edited file on this machine (a
//! Host elsewhere gives none), undoing the edits, and diffing. A turn's
//! net change of a file, once worked out for a settled turn, is kept for
//! as long as the turn's edits of it stay the same: a later change to the
//! file cannot make it untrue.

mod net;
mod patch;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use gpui_kit::{AppContext as _, Context, SharedString, Task};
pub use transcript_model::edits::ChangeKind;
use transcript_model::edits::{EditedFile, EditedTurns, EditsKey, TurnEdits};

use crate::panel::ReviewTarget;
use net::{Kept, Place};

/// One edit of a file shown on its own: its diff, under the file's name
/// (with its place among the turn's edits of the file when there are
/// several), and its counts when it says them.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct Step {
    pub patch: Arc<str>,
    pub counts: Option<(u32, u32)>,
}

/// How a file's change in a turn shows.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum FileView {
    /// The net diff of the turn: the file before its first edit against
    /// the file after its last.
    Net(Arc<str>),
    /// The turn's edits one after another, where the net diff could not be
    /// worked out.
    Steps(Vec<Step>),
}

/// One file a turn changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileChange {
    /// As shown: relative to the task's folder when inside it.
    pub(crate) path: SharedString,
    pub(crate) kind: ChangeKind,
    /// Lines added and deleted; summed over the steps of a stepwise
    /// change; `None` when nothing says them.
    pub(crate) counts: Option<(u32, u32)>,
    pub(crate) view: FileView,
    /// The tool calls of the turn that changed it, in order.
    pub(crate) edits: Vec<String>,
    /// Where it is (absolute when the task's folder is known).
    pub(crate) key: String,
    /// Its net diff, worked out exactly.
    pub(crate) exact: bool,
}

impl FileChange {
    pub fn path(&self) -> &SharedString {
        &self.path
    }

    pub fn kind(&self) -> ChangeKind {
        self.kind
    }

    pub fn counts(&self) -> Option<(u32, u32)> {
        self.counts
    }

    pub fn view(&self) -> &FileView {
        &self.view
    }

    /// Shown as the turn's edits one after another.
    pub fn is_stepwise(&self) -> bool {
        matches!(self.view, FileView::Steps(_))
    }
}

/// What one turn changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnChange {
    turn_id: SharedString,
    prompt: SharedString,
    started_at: u64,
    settled: bool,
    files: Vec<FileChange>,
    additions: u32,
    deletions: u32,
}

impl TurnChange {
    pub(crate) fn new(turn: &TurnEdits, files: Vec<FileChange>) -> Self {
        let (additions, deletions) =
            files.iter().filter_map(|file| file.counts).fold((0u32, 0u32), |(a, d), (add, del)| {
                (a.saturating_add(add), d.saturating_add(del))
            });
        Self {
            turn_id: turn.turn_id.clone().into(),
            prompt: turn.prompt.clone().into(),
            started_at: turn.started_at,
            settled: turn.is_settled(),
            files,
            additions,
            deletions,
        }
    }

    pub fn turn_id(&self) -> &SharedString {
        &self.turn_id
    }

    /// The first line of the message that opened the turn.
    pub fn prompt(&self) -> &SharedString {
        &self.prompt
    }

    /// Host wall-clock milliseconds of the turn's start.
    pub fn started_at(&self) -> u64 {
        self.started_at
    }

    /// Completed, failed or stopped.
    pub fn is_settled(&self) -> bool {
        self.settled
    }

    /// The files it changed, in the order it first edited them.
    pub fn files(&self) -> &[FileChange] {
        &self.files
    }

    /// The file at `path` (as shown).
    pub fn file(&self, path: &str) -> Option<&FileChange> {
        self.files.iter().find(|file| file.path.as_ref() == path)
    }

    /// Lines added and deleted over its files whose counts are known.
    pub fn totals(&self) -> (u32, u32) {
        (self.additions, self.deletions)
    }
}

/// The turns of the followed task and what each changed. See the module
/// header.
#[derive(Default)]
pub struct TurnChanges {
    session_id: Option<SharedString>,
    place: Place,
    key: Option<EditsKey>,
    edits: Arc<Vec<TurnEdits>>,
    /// The session's turns that edited files, oldest first.
    turns: Arc<Vec<TurnChange>>,
    kept: Arc<HashMap<(String, String), Kept>>,
    computing: bool,
    generation: u64,
    _compute: Option<Task<()>>,
}

impl std::fmt::Debug for TurnChanges {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TurnChanges")
            .field("session_id", &self.session_id)
            .field("turns", &self.turns.len())
            .finish_non_exhaustive()
    }
}

impl TurnChanges {
    pub fn new() -> Self {
        Self::default()
    }

    /// Follows `target`'s task: its folder, and whether this machine reads
    /// it. Another task starts with nothing.
    pub(crate) fn set_target(&mut self, target: Option<&ReviewTarget>, cx: &mut Context<Self>) {
        let session_id = target.map(|target| target.session_id().clone());
        let place = Place {
            folder: target.and_then(|target| target.folder().map(PathBuf::from)),
            readable: target.is_some_and(|target| target.workspace().is_some()),
        };
        if self.session_id == session_id && self.place == place {
            return;
        }
        *self = Self { session_id, place, ..Self::default() };
        cx.notify();
    }

    /// What the edits were last read at.
    pub fn key(&self) -> Option<&EditsKey> {
        self.key.as_ref()
    }

    /// The session's edits, read at `key`: works out what each turn
    /// changed, unless they were read at `key` already. Edits of a session
    /// other than the followed one are dropped.
    pub fn set_edits(&mut self, key: EditsKey, edits: Vec<TurnEdits>, cx: &mut Context<Self>) {
        if self.key.as_ref() == Some(&key) || self.session_id.as_deref() != Some(key.session_id()) {
            return;
        }
        self.key = Some(key);
        self.edits = Arc::new(edits);
        self.compute(cx);
    }

    fn compute(&mut self, cx: &mut Context<Self>) {
        self.generation += 1;
        let generation = self.generation;
        self.computing = true;
        let (edits, place, kept) = (self.edits.clone(), self.place.clone(), self.kept.clone());
        let work = cx.background_spawn(async move {
            let mut disk = HashMap::new();
            for path in net::files_to_read(&edits, &place, &kept) {
                let read = net::read_on_disk(&path).await;
                disk.insert(path, read);
            }
            net::compute(&edits, &place, &disk, &kept)
        });
        self._compute = Some(cx.spawn(async move |this, cx| {
            let turns = work.await;
            this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                let mut kept = (*this.kept).clone();
                for turn in turns.iter().filter(|turn| turn.settled) {
                    for file in turn.files.iter().filter(|file| file.exact) {
                        kept.insert(
                            (turn.turn_id.to_string(), file.key.clone()),
                            Kept { edits: file.edits.clone(), change: file.clone() },
                        );
                    }
                }
                this.kept = Arc::new(kept);
                this.turns = Arc::new(turns);
                this.computing = false;
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// The followed task's turns that edited files, oldest first, as last
    /// worked out.
    pub fn turns(&self) -> &Arc<Vec<TurnChange>> {
        &self.turns
    }

    /// Turn `turn_id`'s changes.
    pub fn turn(&self, turn_id: &str) -> Option<&TurnChange> {
        self.turns.iter().find(|turn| turn.turn_id.as_ref() == turn_id)
    }

    /// The work is running.
    pub fn is_computing(&self) -> bool {
        self.computing
    }

    /// What the card under each settled turn lists.
    pub fn edited_turns(&self) -> EditedTurns {
        let turns = self
            .turns
            .iter()
            .filter(|turn| turn.settled && !turn.files.is_empty())
            .map(|turn| {
                let files: Arc<[EditedFile]> = turn
                    .files
                    .iter()
                    .map(|file| EditedFile::new(file.path.to_string(), file.kind, file.counts))
                    .collect();
                (turn.turn_id.to_string(), files)
            })
            .collect();
        EditedTurns::new(self.session_id.clone().unwrap_or_default().to_string(), turns)
    }
}

/// Works out `edits` at once, reading the files in `folder` when
/// `readable`, as [`TurnChanges`] does on the background executor.
#[cfg(test)]
pub(crate) fn work_out(
    edits: &[TurnEdits],
    folder: Option<&std::path::Path>,
    readable: bool,
) -> Vec<TurnChange> {
    let place = Place { folder: folder.map(PathBuf::from), readable };
    let kept = HashMap::new();
    let mut disk = HashMap::new();
    for path in net::files_to_read(edits, &place, &kept) {
        let read = futures_lite::future::block_on(net::read_on_disk(&path));
        disk.insert(path, read);
    }
    net::compute(edits, &place, &disk, &kept)
}
