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

//! The Memory page's reads and writes against the Host, as Maka Desktop's
//! main process makes them (apps/desktop/src/main/runtime-host-memory-ipc-main.ts):
//! the bundle's state, MEMORY.md page by page, and every active and
//! archived entry page by page, all at one revision; a semantic write at
//! the revision just read, tried again after a conflict; and MEMORY.md
//! replaced whole through an upload.
//!
//! Desktop adds and archives an entry by editing the MEMORY.md draft in
//! the renderer and uploading the whole file; this client asks the Host to
//! do it (`remember`, `set_status`), so the Host keeps its own markup. The
//! Host's `remember` takes no tags.

use host_protocol::{
    MEMORY_DOCUMENT_MAX_BYTES, MemoryBackup, MemoryBlockReason, MemoryDocumentName,
    MemoryDocumentStatus, MemoryEntriesView, MemoryEntry, MemoryMutate, MemoryMutateInput,
    MemoryMutateResult, MemoryQuery, MemoryQueryInput, MemoryQueryResult, MemoryRejectionReason,
    MemoryState,
};
use shared::copy::memory as copy;
use shared::copy::{Locale, Text};
use workspace::HostRequester;

use crate::policy::host_error_reason;

/// A read that saw the bundle move under it starts again, at most this many
/// times in all (Desktop's `MAX_REVISION_ATTEMPTS`); so does a write.
const ATTEMPTS: usize = 3;

/// What the page can show of memory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryAccess {
    /// Read: MEMORY.md and its entries (a file not written yet reads empty).
    Ready,
    /// Local memory is switched off.
    Disabled,
    /// Incognito withholds it.
    Incognito,
    /// MEMORY.md is too large or not UTF-8: nothing is read from it.
    SafeMode,
}

/// Memory as one read found it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemorySnapshot {
    pub access: MemoryAccess,
    /// The counts and the backups, unless blocked.
    pub state: Option<MemoryState>,
    /// MEMORY.md's text.
    pub content: String,
    /// Newest first.
    pub active: Vec<MemoryEntry>,
    pub archived: Vec<MemoryEntry>,
}

impl MemorySnapshot {
    fn empty(access: MemoryAccess, state: Option<MemoryState>) -> Self {
        Self { access, state, content: String::new(), active: Vec::new(), archived: Vec::new() }
    }

    /// The backups, newest first.
    pub fn backups(&self) -> Vec<MemoryBackup> {
        let mut backups =
            self.state.as_ref().map(|state| state.backups.clone()).unwrap_or_default();
        backups.sort_by_key(|backup| std::cmp::Reverse(backup.updated_at));
        backups
    }
}

/// Why a read or a write did not go through, as the clause a failure line
/// ends with.
pub type Reason = String;

fn text(text: Text, locale: Locale) -> Reason {
    text.in_locale(locale).to_owned()
}

/// The sentence for a write the Host rejected (Desktop's `results`).
pub fn rejection_text(reason: &MemoryRejectionReason, locale: Locale) -> Reason {
    let sentence = match reason {
        MemoryRejectionReason::Disabled => copy::RESULT_DISABLED,
        MemoryRejectionReason::IncognitoActive => copy::RESULT_INCOGNITO,
        MemoryRejectionReason::InvalidContent => copy::RESULT_INVALID_CONTENT,
        MemoryRejectionReason::InvalidScope => copy::RESULT_INVALID_SCOPE,
        MemoryRejectionReason::NotFound => copy::RESULT_NOT_FOUND,
        MemoryRejectionReason::NotPending => copy::RESULT_NOT_PENDING,
        MemoryRejectionReason::Oversize => copy::RESULT_OVERSIZE,
        MemoryRejectionReason::SafeMode => copy::SAFE_MODE,
        MemoryRejectionReason::UploadNotFound => copy::RESULT_UPLOAD_NOT_FOUND,
        MemoryRejectionReason::UploadIncomplete => copy::RESULT_UPLOAD_INCOMPLETE,
        MemoryRejectionReason::UploadConflict => copy::RESULT_UPLOAD_CONFLICT,
        MemoryRejectionReason::BackupNotFound => copy::RESULT_BACKUP_NOT_FOUND,
        _ => copy::RESULT_INVALID_STATE,
    };
    text(sentence, locale)
}

fn blocked(reason: &MemoryBlockReason) -> MemoryAccess {
    match reason {
        MemoryBlockReason::IncognitoActive => MemoryAccess::Incognito,
        _ => MemoryAccess::Disabled,
    }
}

async fn query(
    requester: &HostRequester,
    input: MemoryQueryInput,
    locale: Locale,
) -> Result<MemoryQueryResult, Reason> {
    requester
        .request::<MemoryQuery>(&input)
        .await
        .map_err(|error| host_error_reason(&error, locale))
}

async fn mutate(
    requester: &HostRequester,
    input: &MemoryMutateInput,
    locale: Locale,
) -> Result<MemoryMutateResult, Reason> {
    requester
        .request::<MemoryMutate>(input)
        .await
        .map_err(|error| host_error_reason(&error, locale))
}

/// The bundle's state, or how it is blocked.
async fn read_state(
    requester: &HostRequester,
    locale: Locale,
) -> Result<Result<MemoryState, MemoryAccess>, Reason> {
    match query(requester, MemoryQueryInput::State, locale).await? {
        MemoryQueryResult::State(state) => Ok(Ok(state)),
        MemoryQueryResult::Blocked { reason } => Ok(Err(blocked(&reason))),
        _ => Err(text(copy::RESULT_INVALID_STATE, locale)),
    }
}

/// A document's text and its revision, page by page from one revision
/// (`readRuntimeHostMemoryDocumentSnapshot`).
async fn read_document(
    requester: &HostRequester,
    document: MemoryDocumentName,
    locale: Locale,
) -> Result<(String, Option<String>), Reason> {
    'attempt: for _ in 0..ATTEMPTS {
        let start = MemoryQueryInput::DocumentStart { document: document.clone() };
        let first = match query(requester, start, locale).await? {
            MemoryQueryResult::Missing { .. } | MemoryQueryResult::Blocked { .. } => {
                return Ok((String::new(), None));
            }
            MemoryQueryResult::SafeMode { revision, .. } => {
                return Ok((String::new(), Some(revision)));
            }
            MemoryQueryResult::DocumentPage(page) if page.offset == 0 => page,
            MemoryQueryResult::RevisionChanged { .. } => continue,
            _ => return Err(text(copy::RESULT_INVALID_STATE, locale)),
        };
        let revision = first.revision.clone();
        let mut bytes = first.chunk().ok_or_else(|| text(copy::RESULT_INVALID_STATE, locale))?;
        let mut next = first.next_cursor;
        while let Some(cursor) = next {
            let input = MemoryQueryInput::DocumentContinue {
                document: document.clone(),
                revision: revision.clone(),
                cursor,
            };
            match query(requester, input, locale).await? {
                MemoryQueryResult::DocumentPage(page) if page.revision == revision => {
                    bytes.extend(
                        page.chunk().ok_or_else(|| text(copy::RESULT_INVALID_STATE, locale))?,
                    );
                    next = page.next_cursor;
                }
                MemoryQueryResult::RevisionChanged { .. } => continue 'attempt,
                _ => return Err(text(copy::RESULT_INVALID_STATE, locale)),
            }
        }
        return Ok((String::from_utf8_lossy(&bytes).into_owned(), Some(revision)));
    }
    Err(text(copy::RESULT_REVISION_CONFLICT, locale))
}

/// Every entry of `view`, page by page from one revision, newest first
/// (`readMemoryEntriesSnapshot`).
async fn read_entries(
    requester: &HostRequester,
    view: MemoryEntriesView,
    locale: Locale,
) -> Result<(Vec<MemoryEntry>, Option<String>), Reason> {
    'attempt: for _ in 0..ATTEMPTS {
        let start = MemoryQueryInput::EntriesStart { view: view.clone() };
        let first = match query(requester, start, locale).await? {
            MemoryQueryResult::Missing { .. } | MemoryQueryResult::Blocked { .. } => {
                return Ok((Vec::new(), None));
            }
            MemoryQueryResult::EntriesPage(page) if page.view == view => page,
            MemoryQueryResult::RevisionChanged { .. } => continue,
            _ => return Err(text(copy::RESULT_INVALID_STATE, locale)),
        };
        let revision = first.revision.clone();
        let mut entries = first.items;
        let mut next = first.next_cursor;
        while let Some(cursor) = next {
            let input = MemoryQueryInput::EntriesContinue {
                view: view.clone(),
                revision: revision.clone(),
                cursor,
            };
            match query(requester, input, locale).await? {
                MemoryQueryResult::EntriesPage(page)
                    if page.revision == revision && page.view == view =>
                {
                    entries.extend(page.items);
                    next = page.next_cursor;
                }
                MemoryQueryResult::RevisionChanged { .. } => continue 'attempt,
                _ => return Err(text(copy::RESULT_INVALID_STATE, locale)),
            }
        }
        entries.sort_by_key(|entry| {
            std::cmp::Reverse(entry.updated_at.or(entry.created_at).unwrap_or(0))
        });
        return Ok((entries, Some(revision)));
    }
    Err(text(copy::RESULT_REVISION_CONFLICT, locale))
}

/// Memory as it stands: the state, then MEMORY.md and both lists, read
/// again until all three answer the state's revisions (`getMemoryState`).
pub async fn read_snapshot(
    requester: &HostRequester,
    locale: Locale,
) -> Result<MemorySnapshot, Reason> {
    for _ in 0..ATTEMPTS {
        let state = match read_state(requester, locale).await? {
            Ok(state) => state,
            Err(access) => return Ok(MemorySnapshot::empty(access, None)),
        };
        match state.status {
            MemoryDocumentStatus::Missing => {
                return Ok(MemorySnapshot::empty(MemoryAccess::Ready, Some(state)));
            }
            MemoryDocumentStatus::SafeMode => {
                return Ok(MemorySnapshot::empty(MemoryAccess::SafeMode, Some(state)));
            }
            _ => {}
        }
        let (content, document) =
            read_document(requester, MemoryDocumentName::Memory, locale).await?;
        let (active, active_revision) =
            read_entries(requester, MemoryEntriesView::Active, locale).await?;
        let (archived, archived_revision) =
            read_entries(requester, MemoryEntriesView::Archived, locale).await?;
        let current = Some(state.revision.clone());
        if document != state.memory_revision
            || active_revision != current
            || archived_revision != current
        {
            continue;
        }
        return Ok(MemorySnapshot {
            access: MemoryAccess::Ready,
            state: Some(state),
            content,
            active,
            archived,
        });
    }
    Err(text(copy::RESULT_REVISION_CONFLICT, locale))
}

/// Sends the write `make` builds from the state just read, and again after
/// a revision conflict (Desktop's `mutateMemory`). `make` returns `None`
/// when the state has nothing to write to (a backup that is gone).
pub async fn write(
    requester: &HostRequester,
    make: impl Fn(&MemoryState) -> Option<MemoryMutateInput>,
    locale: Locale,
) -> Result<(), Reason> {
    for _ in 0..ATTEMPTS {
        let state = match read_state(requester, locale).await? {
            Ok(state) => state,
            Err(MemoryAccess::Incognito) => return Err(text(copy::RESULT_INCOGNITO, locale)),
            Err(_) => return Err(text(copy::RESULT_DISABLED, locale)),
        };
        let Some(input) = make(&state) else {
            return Err(text(copy::RESULT_BACKUP_NOT_FOUND, locale));
        };
        match mutate(requester, &input, locale).await? {
            MemoryMutateResult::Committed { .. } | MemoryMutateResult::Unchanged { .. } => {
                return Ok(());
            }
            MemoryMutateResult::RevisionConflict { .. } => continue,
            MemoryMutateResult::BackupRevisionConflict { .. } => {
                return Err(text(copy::RESULT_BACKUP_REVISION_CONFLICT, locale));
            }
            MemoryMutateResult::Rejected { reason } => return Err(rejection_text(&reason, locale)),
            _ => return Err(text(copy::RESULT_INVALID_STATE, locale)),
        }
    }
    Err(text(copy::RESULT_REVISION_CONFLICT, locale))
}

/// Replaces MEMORY.md with `content`: an upload opened at the revision just
/// read, its chunks, and its commit; an upload that fails on the way is
/// aborted (`replaceRuntimeHostMemoryDocument`). A file over the Host's
/// limit is not sent.
pub async fn replace_document(
    requester: &HostRequester,
    content: &str,
    locale: Locale,
) -> Result<(), Reason> {
    let bytes = content.as_bytes();
    if bytes.len() > MEMORY_DOCUMENT_MAX_BYTES {
        return Err(text(copy::RESULT_OVERSIZE, locale));
    }
    for _ in 0..ATTEMPTS {
        let state = match read_state(requester, locale).await? {
            Ok(state) => state,
            Err(MemoryAccess::Incognito) => return Err(text(copy::RESULT_INCOGNITO, locale)),
            Err(_) => return Err(text(copy::RESULT_DISABLED, locale)),
        };
        let begin = MemoryMutateInput::replace_begin(&state.revision, bytes);
        let upload = match mutate(requester, &begin, locale).await? {
            MemoryMutateResult::UploadOpened { upload_id, .. } => upload_id,
            MemoryMutateResult::Unchanged { .. } => return Ok(()),
            MemoryMutateResult::RevisionConflict { .. } => continue,
            MemoryMutateResult::Rejected { reason } => return Err(rejection_text(&reason, locale)),
            _ => return Err(text(copy::RESULT_INVALID_STATE, locale)),
        };
        let sent = send_upload(requester, &upload, bytes, locale).await;
        if sent.is_err() {
            let abort = MemoryMutateInput::ReplaceAbort { upload_id: upload.clone() };
            if let Err(reason) = mutate(requester, &abort, locale).await {
                log::warn!("memory.mutate replace_abort failed: {reason}");
            }
        }
        return sent;
    }
    Err(text(copy::RESULT_REVISION_CONFLICT, locale))
}

/// The chunks of an open upload, then its commit.
async fn send_upload(
    requester: &HostRequester,
    upload: &str,
    bytes: &[u8],
    locale: Locale,
) -> Result<(), Reason> {
    let mut offset = 0u64;
    while let Some(chunk) = MemoryMutateInput::replace_chunk(upload, bytes, offset) {
        match mutate(requester, &chunk, locale).await? {
            MemoryMutateResult::ChunkAccepted { next_offset, .. } if next_offset > offset => {
                offset = next_offset;
            }
            MemoryMutateResult::Rejected { reason } => return Err(rejection_text(&reason, locale)),
            _ => return Err(text(copy::RESULT_UPLOAD_INCOMPLETE, locale)),
        }
    }
    let commit = MemoryMutateInput::ReplaceCommit { upload_id: upload.to_owned() };
    match mutate(requester, &commit, locale).await? {
        MemoryMutateResult::Committed { .. } | MemoryMutateResult::Unchanged { .. } => Ok(()),
        MemoryMutateResult::Rejected { reason } => Err(rejection_text(&reason, locale)),
        _ => Err(text(copy::RESULT_INVALID_STATE, locale)),
    }
}
