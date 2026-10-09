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

//! Commands on one task: rename and flag (`session.metadata.update`),
//! archive and unarchive (`session.lifecycle.set`), and delete
//! (`session.remove`, after `session.remove.preview`).

use gpui_kit::{App, Context, SharedString};
use host_protocol::{
    SessionCatalogItem, SessionLifecycleSet, SessionLifecycleSetInput, SessionMetadataPatch,
    SessionMetadataUpdate, SessionMetadataUpdateInput, SessionRemove, SessionRemoveInput,
    SessionRemovePreview, SessionRemovePreviewInput, SessionRemoveResult, SessionUpdateResult,
};
use shared::copy::{self, Locale, Text, failure, sentences};
use workspace::{HostRequestError, HostRequester};

use super::{SessionCatalog, SessionCatalogEvent};
use crate::row::SessionRow;

/// A command on one task, while the Host answers it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum TaskCommand {
    Rename,
    Flag,
    Archive,
    Delete,
}

impl TaskCommand {
    /// What the error line says when the command fails.
    fn failed(self, archiving: bool) -> Text {
        match self {
            Self::Rename => copy::TASK_RENAME_FAILED,
            Self::Flag => copy::TASK_FLAG_FAILED,
            Self::Archive if archiving => copy::TASK_ARCHIVE_FAILED,
            Self::Archive => copy::TASK_UNARCHIVE_FAILED,
            Self::Delete => copy::TASK_DELETE_FAILED,
        }
    }
}

/// Why a command did not commit.
#[derive(Debug)]
enum Refusal {
    /// The session moved on twice in a row, or before a delete.
    Changed,
    Unexpected,
    Request(HostRequestError),
}

impl From<HostRequestError> for Refusal {
    fn from(error: HostRequestError) -> Self {
        Self::Request(error)
    }
}

impl SessionCatalog {
    /// The command task `id` is waiting on, if any.
    pub fn pending_command(&self, id: &str) -> Option<TaskCommand> {
        self.pending.get(id).copied()
    }

    /// Why the last command failed, until the next one starts.
    pub fn command_error(&self) -> Option<&SharedString> {
        self.command_error.as_ref()
    }

    /// Renames task `id`. The row shows the new name at once and goes back
    /// to the old one if the Host refuses. A name that is empty after
    /// trimming, or unchanged, sends nothing.
    pub fn rename(&mut self, id: &str, name: &str, cx: &mut Context<Self>) {
        let name = name.trim();
        let Some(row) = self.row(id) else {
            return;
        };
        if name.is_empty() || name == row.name.as_ref() {
            return;
        }
        let previous = row.name.clone();
        let name: SharedString = name.to_owned().into();
        let patch = SessionMetadataPatch::name(name.to_string());
        if self.start_metadata(id, TaskCommand::Rename, patch, cx) {
            self.patch_row(id, |row| row.name = name);
            let id: SharedString = id.to_owned().into();
            self.rollback.insert(id, previous);
            cx.notify();
        }
    }

    /// Flags or unflags task `id`.
    pub fn set_flagged(&mut self, id: &str, flagged: bool, cx: &mut Context<Self>) {
        if self.row(id).is_some_and(|row| row.is_flagged != flagged) {
            self.start_metadata(id, TaskCommand::Flag, SessionMetadataPatch::flagged(flagged), cx);
        }
    }

    /// Sends a metadata patch at the row's revision; on a revision conflict
    /// it sends the same patch once more at the revision the Host names.
    /// Returns whether it started.
    fn start_metadata(
        &mut self,
        id: &str,
        command: TaskCommand,
        patch: SessionMetadataPatch,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(row) = self.row(id) else {
            return false;
        };
        if self.pending.contains_key(id) {
            return false;
        }
        let id = row.id.clone();
        let revision = row.revision;
        let requester = self.host.read(cx).requester();
        log::info!("session.metadata.update {id} at revision {revision}: {patch:?}");
        let request = update_metadata(requester, id.to_string(), revision, patch);
        self.begin(id.clone(), command);
        let key = id.clone();
        let task = cx.spawn(async move |this, cx| {
            let result = request.await;
            this.update(cx, |this, cx| this.finish(&id, command, false, result, cx)).ok();
        });
        self._commands.insert(key, task);
        cx.notify();
        true
    }

    /// Archives task `id` (`archived: true`) or makes it active again.
    pub fn set_archived(&mut self, id: &str, archived: bool, cx: &mut Context<Self>) {
        let Some(row) = self.row(id).filter(|row| row.is_archived != archived) else {
            return;
        };
        if self.pending.contains_key(id) {
            return;
        }
        let id = row.id.clone();
        let input = SessionLifecycleSetInput::new(id.to_string(), archived);
        log::info!("session.lifecycle.set {id}: {}", input.state);
        let request = self.host.read(cx).requester().request::<SessionLifecycleSet>(&input);
        self.begin(id.clone(), TaskCommand::Archive);
        let key = id.clone();
        let task = cx.spawn(async move |this, cx| {
            let result = request.await.map_err(Refusal::from);
            this.update(cx, |this, cx| {
                this.finish(&id, TaskCommand::Archive, archived, result, cx)
            })
            .ok();
        });
        self._commands.insert(key, task);
        cx.notify();
    }

    /// How many subtasks deleting task `id` would move to the archive
    /// (`session.remove.preview`), for the confirmation to say.
    pub fn preview_remove(
        &self,
        id: &str,
        cx: &App,
    ) -> impl Future<Output = Result<u64, HostRequestError>> + 'static {
        let input = SessionRemovePreviewInput::new(id);
        let request = self.host.read(cx).requester().request::<SessionRemovePreview>(&input);
        async move { request.await.map(|preview| preview.archivable_subtask_count) }
    }

    /// Deletes task `id` at the revision the catalog last listed. Call it
    /// only after the person confirmed. A conflict deletes nothing and says
    /// the task changed.
    pub fn remove(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(row) = self.row(id) else {
            return;
        };
        if self.pending.contains_key(id) {
            return;
        }
        let id = row.id.clone();
        let input = SessionRemoveInput::new(id.to_string(), row.revision);
        log::info!("session.remove {id} at revision {}", row.revision);
        let request = self.host.read(cx).requester().request::<SessionRemove>(&input);
        self.begin(id.clone(), TaskCommand::Delete);
        let key = id.clone();
        let task = cx.spawn(async move |this, cx| {
            let result = match request.await {
                Ok(SessionRemoveResult::Removed { .. }) => Ok(None),
                Ok(SessionRemoveResult::RevisionConflict { .. }) => Err(Refusal::Changed),
                Ok(_) => Err(Refusal::Unexpected),
                Err(error) => Err(Refusal::Request(error)),
            };
            this.update(cx, |this, cx| this.finish_remove(&id, result, cx)).ok();
        });
        self._commands.insert(key, task);
        cx.notify();
    }

    fn begin(&mut self, id: SharedString, command: TaskCommand) {
        self.pending.insert(id, command);
        self.command_error = None;
    }

    fn finish(
        &mut self,
        id: &SharedString,
        command: TaskCommand,
        archiving: bool,
        result: Result<SessionCatalogItem, Refusal>,
        cx: &mut Context<Self>,
    ) {
        self.pending.remove(id);
        self._commands.remove(id);
        let previous = self.rollback.remove(id);
        match result {
            Ok(item) => self.apply_item(id, &item),
            Err(refusal) => {
                if let Some(name) = previous {
                    self.patch_row(id, |row| row.name = name);
                }
                self.command_error =
                    Some(describe(Locale::current(cx), command.failed(archiving), refusal));
            }
        }
        cx.notify();
    }

    fn finish_remove(
        &mut self,
        id: &SharedString,
        result: Result<Option<()>, Refusal>,
        cx: &mut Context<Self>,
    ) {
        self.pending.remove(id);
        self._commands.remove(id);
        match result {
            Ok(_) => {
                self.rows.retain(|row| &row.id != id);
                if self.selected.as_ref() == Some(id) {
                    let next =
                        self.rows.iter().find(|row| !row.is_archived).map(|row| row.id.clone());
                    self.selected = next;
                    cx.emit(SessionCatalogEvent::SelectionChanged(self.selected.clone()));
                }
            }
            Err(refusal) => {
                self.command_error =
                    Some(describe(Locale::current(cx), TaskCommand::Delete.failed(false), refusal));
                self.request_reload(cx);
            }
        }
        cx.notify();
    }

    /// Replaces the row of `id` with the committed catalog item.
    fn apply_item(&mut self, id: &SharedString, item: &SessionCatalogItem) {
        match SessionRow::from_item(item) {
            Some(row) => self.patch_row(id, |existing| *existing = row),
            None => self.rows.retain(|row| &row.id != id),
        }
    }

    fn patch_row(&mut self, id: &str, patch: impl FnOnce(&mut SessionRow)) {
        if let Some(row) = self.rows.iter_mut().find(|row| row.id == id) {
            patch(row);
        }
    }
}

/// `session.metadata.update` at `revision`, then once more at the revision
/// a conflict names.
async fn update_metadata(
    requester: HostRequester,
    id: String,
    revision: u64,
    patch: SessionMetadataPatch,
) -> Result<SessionCatalogItem, Refusal> {
    let mut expected = revision;
    for attempt in 0..2 {
        let input = SessionMetadataUpdateInput::new(id.clone(), expected, patch.clone());
        match requester.request::<SessionMetadataUpdate>(&input).await? {
            SessionUpdateResult::Committed { session } => return Ok(session),
            SessionUpdateResult::RevisionConflict { actual_revision, .. } if attempt == 0 => {
                log::info!("session.metadata.update {id}: retrying at revision {actual_revision}");
                expected = actual_revision;
            }
            SessionUpdateResult::RevisionConflict { .. } => return Err(Refusal::Changed),
            _ => return Err(Refusal::Unexpected),
        }
    }
    Err(Refusal::Changed)
}

/// The error line for a command that did not commit, in `locale`.
fn describe(locale: Locale, what: Text, refusal: Refusal) -> SharedString {
    let what = what.in_locale(locale);
    match refusal {
        Refusal::Changed => sentences(locale, what, copy::TASK_CHANGED.in_locale(locale)).into(),
        Refusal::Unexpected => what.into(),
        Refusal::Request(error) => {
            log::warn!("{what} {error}");
            failure(locale, what, &error.to_string()).into()
        }
    }
}
