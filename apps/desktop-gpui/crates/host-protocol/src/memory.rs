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

//! `memory.query` and `memory.mutate`: the Host's local memory, a bundle of
//! two Markdown documents (MEMORY.md and the pending proposals) at one
//! revision, the entries the Host parses out of them, and up to three
//! backups of MEMORY.md.
//!
//! Source: `packages/runtime-host/src/protocol/memory.ts`
//! (`MEMORY_OPERATION_SPECS`, `decodeMemoryQueryInput`,
//! `decodeMemoryQueryResult`, `decodeMemoryMutateInput`,
//! `decodeMemoryMutateResult`); entries are `LocalMemoryEntryPreview` in
//! `packages/core/src/local-memory.ts` as the Host projects them
//! (`projectEntry` in packages/runtime-host/src/server/memory-projection.ts).
//!
//! Reads come in pages: entries (at most [`MEMORY_ENTRY_PAGE_MAX_ITEMS`] a
//! page) and a document's bytes (at most [`MEMORY_DOCUMENT_CHUNK_MAX_BYTES`]
//! a page, base64) continue at a cursor, pinned to the revision the first
//! page answered, which answers `revision_changed` once the bundle moved.
//! Every write names the bundle revision it expects; a stale one is a
//! `revision_conflict` result. MEMORY.md is replaced whole through an
//! upload (`replace_begin`, `replace_chunk`s, `replace_commit`) whose bytes
//! must hash to the digest `replace_begin` names.
//!
//! Both operations fail with `host_not_ready`, `host_draining`,
//! `operation_unavailable`, `invalid_request`, `persistence_failed`, or
//! `internal_failure` (`QUERY_ERRORS`), a mutation also with
//! `commit_outcome_unknown` (`MUTATE_ERRORS`). Memory switched off or
//! incognito is a `blocked` read and a `rejected` write, not an error.

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::Operation;

/// The largest document chunk a page or an upload carries
/// (`MEMORY_DOCUMENT_CHUNK_MAX_BYTES`).
pub const MEMORY_DOCUMENT_CHUNK_MAX_BYTES: usize = 32 * 1024;

/// The most entries one page holds (`MEMORY_ENTRY_PAGE_MAX_ITEMS`).
pub const MEMORY_ENTRY_PAGE_MAX_ITEMS: usize = 64;

/// The largest MEMORY.md the Host keeps out of safe mode
/// (`LOCAL_MEMORY_MAX_BYTES` in packages/core/src/local-memory.ts).
pub const MEMORY_DOCUMENT_MAX_BYTES: usize = 128 * 1024;

/// The longest title a `remember` takes, in UTF-8 bytes (`decodeRemember`).
pub const MEMORY_TITLE_MAX_BYTES: usize = 512;

/// The longest content a `remember` takes, in UTF-8 bytes
/// (`MEMORY_SEMANTIC_CONTENT_MAX_BYTES`).
pub const MEMORY_CONTENT_MAX_BYTES: usize = 24 * 1024;

wire_enum! {
    /// `MemoryDocumentName`: MEMORY.md, or the pending proposals.
    pub enum MemoryDocumentName {
        Memory = "memory",
        Pending = "pending",
    }
}

wire_enum! {
    /// `MemoryEntriesView`: which entries a page lists.
    pub enum MemoryEntriesView {
        Active = "active",
        Archived = "archived",
        Proposals = "proposals",
    }
}

wire_enum! {
    /// `MemoryBackupKind`: the copy of MEMORY.md the Host kept before a
    /// save, a reset, or a restore.
    pub enum MemoryBackupKind {
        Save = "save",
        Reset = "reset",
        Restore = "restore",
    }
}

wire_enum! {
    /// `MemoryStateProjection['status']`: MEMORY.md is there, not written
    /// yet, or too large or not UTF-8 to read (safe mode).
    pub enum MemoryDocumentStatus {
        Ok = "ok",
        Missing = "missing",
        SafeMode = "safe_mode",
    }
}

wire_enum! {
    /// `LocalMemorySource`: who wrote an entry.
    pub enum MemoryEntrySource {
        UserAuthored = "user_authored",
        ChatExtracted = "chat_extracted",
        Unknown = "unknown",
    }
}

wire_enum! {
    /// `LocalMemoryEntryStatus`. A write sets `active` or `archived` only.
    pub enum MemoryEntryStatus {
        Draft = "draft",
        ReviewRequired = "review_required",
        Active = "active",
        Archived = "archived",
        Rejected = "rejected",
        Unknown = "unknown",
    }
}

wire_enum! {
    /// `LocalMemoryScope`: every task, or one task (`session_id`).
    pub enum MemoryEntryScope {
        Workspace = "workspace",
        Session = "session",
    }
}

wire_enum! {
    /// Why memory cannot be read now (`blocked`).
    pub enum MemoryBlockReason {
        Disabled = "disabled",
        IncognitoActive = "incognito_active",
    }
}

wire_enum! {
    /// Why a document is in safe mode.
    pub enum MemorySafeModeReason {
        InvalidUtf8 = "invalid_utf8",
        Oversize = "oversize",
    }
}

wire_enum! {
    /// `MemoryMutationRejectionReason`.
    pub enum MemoryRejectionReason {
        Disabled = "disabled",
        IncognitoActive = "incognito_active",
        InvalidContent = "invalid_content",
        InvalidScope = "invalid_scope",
        InvalidState = "invalid_state",
        NotFound = "not_found",
        NotPending = "not_pending",
        Oversize = "oversize",
        SafeMode = "safe_mode",
        UploadNotFound = "upload_not_found",
        UploadIncomplete = "upload_incomplete",
        UploadConflict = "upload_conflict",
        BackupNotFound = "backup_not_found",
    }
}

/// `MemoryQueryInput` (`decodeMemoryQueryInput`). A continuation names the
/// revision its first page answered and the cursor the last page gave.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum MemoryQueryInput {
    State,
    EntriesStart { view: MemoryEntriesView },
    EntriesContinue { view: MemoryEntriesView, revision: String, cursor: u64 },
    DocumentStart { document: MemoryDocumentName },
    DocumentContinue { document: MemoryDocumentName, revision: String, cursor: u64 },
}

/// `MemoryBackupProjection` (`decodeBackup`): what a backup holds, never
/// its text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct MemoryBackup {
    pub kind: MemoryBackupKind,
    /// What `restore_backup` expects (`expectedBackupRevision`).
    pub revision: String,
    /// Milliseconds since the Unix epoch.
    pub updated_at: u64,
    pub size_bytes: u64,
    pub entry_count: u64,
    pub active_entry_count: u64,
    pub archived_entry_count: u64,
    /// Too large to parse: its counts are zero.
    pub safe_mode: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// `MemoryStateProjection` (`decodeState`): the bundle's revision (what
/// every write expects), each document's, the counts, and the backups.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct MemoryState {
    pub revision: String,
    pub memory_revision: Option<String>,
    pub pending_revision: Option<String>,
    pub agent_read_enabled: bool,
    pub status: MemoryDocumentStatus,
    pub entry_count: u64,
    pub active_entry_count: u64,
    pub archived_entry_count: u64,
    pub proposal_count: u64,
    /// At most three, one of each kind.
    pub backups: Vec<MemoryBackup>,
}

/// `MemoryEntryProjection` (`decodeEntry`): an entry as the Host parsed it
/// out of MEMORY.md. `content` is the preview the parser keeps (its first
/// 500 characters), not the whole section.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct MemoryEntry {
    pub id: String,
    pub source: MemoryEntrySource,
    pub status: MemoryEntryStatus,
    pub title: String,
    pub content: String,
    pub scope: MemoryEntryScope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposal_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_turn_id: Option<String>,
    /// Milliseconds since the Unix epoch, each when the entry records it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposed_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmed_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rejected_at: Option<u64>,
    /// At most eight.
    pub tags: Vec<String>,
}

/// `MemoryEntriesPage` (`decodeEntriesPage`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct MemoryEntriesPage {
    pub view: MemoryEntriesView,
    /// The bundle revision the page was read at.
    pub revision: String,
    pub items: Vec<MemoryEntry>,
    /// Where the next page starts; `None` on the last.
    pub next_cursor: Option<u64>,
}

/// `MemoryDocumentPage` (`decodeDocumentPage`): `offset` is where the
/// chunk starts in the document's `total_bytes`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct MemoryDocumentPage {
    pub document: MemoryDocumentName,
    /// The document's own revision.
    pub revision: String,
    pub total_bytes: u64,
    pub offset: u64,
    /// Canonical padded base64; empty for an empty document.
    pub chunk_base64: String,
    pub next_cursor: Option<u64>,
}

impl MemoryDocumentPage {
    /// The chunk's bytes, or `None` when it is not base64.
    pub fn chunk(&self) -> Option<Vec<u8>> {
        base64::engine::general_purpose::STANDARD.decode(&self.chunk_base64).ok()
    }
}

/// `MemoryQueryResult` (`decodeMemoryQueryResult`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum MemoryQueryResult {
    State(MemoryState),
    EntriesPage(MemoryEntriesPage),
    DocumentPage(MemoryDocumentPage),
    /// A continuation's revision is no longer current: start again.
    #[serde(rename_all = "camelCase")]
    RevisionChanged {
        expected_revision: String,
        actual_revision: Option<String>,
    },
    /// Memory is off, or incognito is on.
    Blocked {
        reason: MemoryBlockReason,
    },
    #[serde(rename_all = "camelCase")]
    SafeMode {
        document: MemoryDocumentName,
        revision: String,
        reason: MemorySafeModeReason,
        byte_length: u64,
    },
    /// The document has not been written yet.
    Missing {
        document: MemoryDocumentName,
    },
    /// A result kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// `MemoryScopeInput` (`decodeScope`): where a remembered entry applies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum MemoryScope {
    Workspace,
    #[serde(rename_all = "camelCase")]
    Session {
        session_id: String,
    },
}

/// `MemoryMutateInput` (`decodeMemoryMutateInput`): the writes the
/// settings page makes. Each semantic write expects the bundle revision
/// it read; the upload's chunks and commit are tied to its upload id.
/// (`propose`, `approve`, and `reject`, the proposal queue's, are not
/// modeled: no page of this client reviews proposals.)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum MemoryMutateInput {
    /// Adds an entry the user wrote to MEMORY.md, active at once; the Host
    /// gives it its id and redacts suspected secrets.
    #[serde(rename_all = "camelCase")]
    Remember { expected_revision: String, title: String, content: String, scope: MemoryScope },
    /// Archives an active entry or brings an archived one back.
    #[serde(rename_all = "camelCase")]
    SetStatus {
        expected_revision: String,
        entry_id: String,
        status: MemoryEntryStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        archive_reason: Option<String>,
    },
    /// Writes the starter MEMORY.md, backing up the current one.
    #[serde(rename_all = "camelCase")]
    Reset { expected_revision: String },
    /// Puts a backup back, backing up the current MEMORY.md first.
    #[serde(rename_all = "camelCase")]
    RestoreBackup {
        expected_revision: String,
        backup_kind: MemoryBackupKind,
        expected_backup_revision: String,
    },
    /// Opens an upload of `total_bytes` whose bytes hash to
    /// `content_sha256` (`sha256:<64 hex>`).
    #[serde(rename_all = "camelCase")]
    ReplaceBegin { expected_revision: String, total_bytes: u64, content_sha256: String },
    #[serde(rename_all = "camelCase")]
    ReplaceChunk { upload_id: String, offset: u64, chunk_base64: String },
    #[serde(rename_all = "camelCase")]
    ReplaceCommit { upload_id: String },
    #[serde(rename_all = "camelCase")]
    ReplaceAbort { upload_id: String },
}

impl MemoryMutateInput {
    /// Remembers `title` and `content` for every task, at `revision`.
    pub fn remember(revision: &str, title: impl Into<String>, content: impl Into<String>) -> Self {
        Self::Remember {
            expected_revision: revision.to_owned(),
            title: title.into(),
            content: content.into(),
            scope: MemoryScope::Workspace,
        }
    }

    /// Archives (`archived`) or restores (`!archived`) the entry `entry_id`.
    pub fn set_archived(revision: &str, entry_id: impl Into<String>, archived: bool) -> Self {
        Self::SetStatus {
            expected_revision: revision.to_owned(),
            entry_id: entry_id.into(),
            status: if archived { MemoryEntryStatus::Archived } else { MemoryEntryStatus::Active },
            archive_reason: None,
        }
    }

    /// Opens the upload that replaces MEMORY.md with `content`.
    pub fn replace_begin(revision: &str, content: &[u8]) -> Self {
        Self::ReplaceBegin {
            expected_revision: revision.to_owned(),
            total_bytes: content.len() as u64,
            content_sha256: memory_content_revision(content),
        }
    }

    /// The chunk of `content` that starts at `offset`, or `None` when
    /// `offset` is at or past the end.
    pub fn replace_chunk(upload_id: &str, content: &[u8], offset: u64) -> Option<Self> {
        let start = usize::try_from(offset).ok().filter(|start| *start < content.len())?;
        let end = content.len().min(start + MEMORY_DOCUMENT_CHUNK_MAX_BYTES);
        Some(Self::ReplaceChunk {
            upload_id: upload_id.to_owned(),
            offset,
            chunk_base64: base64::engine::general_purpose::STANDARD.encode(&content[start..end]),
        })
    }
}

/// The revision the Host gives `content`: `sha256:` and its SHA-256 in
/// lowercase hex (`revision` in memory-coordinator.ts).
pub fn memory_content_revision(content: &[u8]) -> String {
    let digest = Sha256::digest(content);
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("sha256:{hex}")
}

/// `MemoryMutateResult` (`decodeMemoryMutateResult`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum MemoryMutateResult {
    /// The upload is open; its first chunk starts at 0.
    #[serde(rename_all = "camelCase")]
    UploadOpened {
        upload_id: String,
        next_offset: u64,
    },
    #[serde(rename_all = "camelCase")]
    ChunkAccepted {
        upload_id: String,
        next_offset: u64,
    },
    #[serde(rename_all = "camelCase")]
    UploadAborted {
        upload_id: String,
    },
    /// The bundle changed, at `revision`.
    #[serde(rename_all = "camelCase")]
    Committed {
        revision: String,
        memory_revision: Option<String>,
        pending_revision: Option<String>,
    },
    /// The write left the bundle as it was (the same bytes).
    #[serde(rename_all = "camelCase")]
    Unchanged {
        revision: String,
        memory_revision: Option<String>,
        pending_revision: Option<String>,
    },
    /// The bundle moved since it was read: read it again.
    #[serde(rename_all = "camelCase")]
    RevisionConflict {
        expected_revision: String,
        actual_revision: String,
    },
    /// The backup changed since it was read.
    #[serde(rename_all = "camelCase")]
    BackupRevisionConflict {
        backup_kind: MemoryBackupKind,
        expected_revision: String,
        actual_revision: String,
    },
    Rejected {
        reason: MemoryRejectionReason,
    },
    /// A result kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// `memory.query` (mode `query`).
#[derive(Debug)]
pub enum MemoryQuery {}

impl Operation for MemoryQuery {
    const NAME: &'static str = "memory.query";
    type Input = MemoryQueryInput;
    type Output = MemoryQueryResult;
}

/// `memory.mutate` (mode `command`).
#[derive(Debug)]
pub enum MemoryMutate {}

impl Operation for MemoryMutate {
    const NAME: &'static str = "memory.mutate";
    type Input = MemoryMutateInput;
    type Output = MemoryMutateResult;
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    /// The TS protocol test's revision.
    fn revision(fill: char) -> String {
        format!("sha256:{}", fill.to_string().repeat(64))
    }

    fn round_trip<T: Serialize + for<'de> Deserialize<'de>>(value: Value) -> T {
        let decoded: T = serde_json::from_value(value.clone()).expect("decode");
        assert_eq!(serde_json::to_value(&decoded).expect("encode"), value);
        decoded
    }

    #[test]
    fn queries_encode_as_the_host_decodes_them() {
        for (input, expected) in [
            (MemoryQueryInput::State, json!({"kind": "state"})),
            (
                MemoryQueryInput::EntriesStart { view: MemoryEntriesView::Archived },
                json!({"kind": "entries_start", "view": "archived"}),
            ),
            (
                MemoryQueryInput::EntriesContinue {
                    view: MemoryEntriesView::Active,
                    revision: revision('a'),
                    cursor: 64,
                },
                json!({"kind": "entries_continue", "view": "active", "revision": revision('a'),
                       "cursor": 64}),
            ),
            (
                MemoryQueryInput::DocumentContinue {
                    document: MemoryDocumentName::Memory,
                    revision: revision('a'),
                    cursor: 32,
                },
                json!({"kind": "document_continue", "document": "memory",
                       "revision": revision('a'), "cursor": 32}),
            ),
        ] {
            assert_eq!(serde_json::to_value(&input).expect("encode"), expected);
            assert_eq!(
                serde_json::from_value::<MemoryQueryInput>(expected).expect("decode"),
                input
            );
        }
    }

    #[test]
    fn the_state_entries_and_documents_decode_as_the_host_sends_them() {
        let state: MemoryQueryResult = round_trip(json!({
            "kind": "state", "revision": revision('a'), "memoryRevision": revision('b'),
            "pendingRevision": null, "agentReadEnabled": false, "status": "ok",
            "entryCount": 3, "activeEntryCount": 2, "archivedEntryCount": 1, "proposalCount": 0,
            "backups": [{"kind": "save", "revision": revision('c'), "updatedAt": 1_759_000_000_000u64,
                         "sizeBytes": 812, "entryCount": 2, "activeEntryCount": 2,
                         "archivedEntryCount": 0, "safeMode": false},
                        {"kind": "reset", "revision": revision('d'), "updatedAt": 1,
                         "sizeBytes": 200_000, "entryCount": 0, "activeEntryCount": 0,
                         "archivedEntryCount": 0, "safeMode": true, "reason": "oversize"}]
        }));
        let MemoryQueryResult::State(state) = state else { panic!("a state") };
        assert_eq!(state.status, MemoryDocumentStatus::Ok);
        assert_eq!(state.backups[1].reason.as_deref(), Some("oversize"));

        // The TS test's entry, with every optional field this client reads.
        let page: MemoryQueryResult = round_trip(json!({
            "kind": "entries_page", "view": "active", "revision": revision('a'),
            "items": [{"id": "mem-0123456789abcdef", "source": "user_authored",
                       "status": "active", "title": "Preference",
                       "content": "Use concise answers.", "scope": "workspace",
                       "createdAt": 10, "updatedAt": 20, "confirmedAt": 10,
                       "tags": ["style"]},
                      {"id": "entry-1", "source": "chat_extracted", "status": "active",
                       "title": "Session", "content": "c", "scope": "session",
                       "sessionId": "session-1", "proposalId": "proposal-1", "tags": []}],
            "nextCursor": 2
        }));
        let MemoryQueryResult::EntriesPage(page) = page else { panic!("a page") };
        assert_eq!(page.next_cursor, Some(2));
        assert_eq!(page.items[1].scope, MemoryEntryScope::Session);

        // An empty document is an empty chunk.
        let empty: MemoryQueryResult = round_trip(json!({
            "kind": "document_page", "document": "memory", "revision": revision('a'),
            "totalBytes": 0, "offset": 0, "chunkBase64": "", "nextCursor": null
        }));
        let MemoryQueryResult::DocumentPage(empty) = empty else { panic!("a page") };
        assert_eq!(empty.chunk(), Some(Vec::new()));
        let hello: MemoryDocumentPage = serde_json::from_value(json!({
            "document": "memory", "revision": revision('a'), "totalBytes": 5, "offset": 0,
            "chunkBase64": "aGVsbG8=", "nextCursor": null
        }))
        .expect("decode");
        assert_eq!(hello.chunk().as_deref(), Some(b"hello".as_slice()));

        for value in [
            json!({"kind": "revision_changed", "expectedRevision": revision('a'),
                   "actualRevision": null}),
            json!({"kind": "blocked", "reason": "incognito_active"}),
            json!({"kind": "safe_mode", "document": "memory", "revision": revision('a'),
                   "reason": "oversize", "byteLength": 200_000}),
            json!({"kind": "missing", "document": "memory"}),
        ] {
            round_trip::<MemoryQueryResult>(value);
        }
        let newer: MemoryQueryResult =
            serde_json::from_value(json!({"kind": "later"})).expect("decode");
        assert_eq!(newer, MemoryQueryResult::Unknown);
    }

    #[test]
    fn writes_encode_as_the_host_decodes_them() {
        assert_eq!(
            serde_json::to_value(MemoryMutateInput::remember(
                &revision('a'),
                "Preference",
                "Use concise answers."
            ))
            .expect("encode"),
            json!({"kind": "remember", "expectedRevision": revision('a'), "title": "Preference",
                   "content": "Use concise answers.", "scope": {"kind": "workspace"}})
        );
        assert_eq!(
            serde_json::to_value(MemoryMutateInput::set_archived(&revision('a'), "mem-1", true))
                .expect("encode"),
            json!({"kind": "set_status", "expectedRevision": revision('a'), "entryId": "mem-1",
                   "status": "archived"})
        );
        assert_eq!(
            serde_json::to_value(MemoryMutateInput::set_archived(&revision('a'), "mem-1", false))
                .expect("encode")["status"],
            "active"
        );
        // The TS test's restore.
        round_trip::<MemoryMutateInput>(json!({"kind": "restore_backup",
            "expectedRevision": revision('a'), "backupKind": "save",
            "expectedBackupRevision": revision('a')}));
        round_trip::<MemoryMutateInput>(
            json!({"kind": "reset", "expectedRevision": revision('a')}),
        );
        round_trip::<MemoryMutateInput>(json!({"kind": "remember",
            "expectedRevision": revision('a'), "title": "t", "content": "c",
            "scope": {"kind": "session", "sessionId": "session-1"}}));
    }

    #[test]
    fn an_upload_names_the_contents_digest_and_carries_it_in_chunks() {
        let begin = MemoryMutateInput::replace_begin(&revision('a'), b"abc");
        assert_eq!(
            serde_json::to_value(&begin).expect("encode"),
            json!({"kind": "replace_begin", "expectedRevision": revision('a'), "totalBytes": 3,
                   "contentSha256":
                     "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"})
        );
        let content = vec![b'a'; MEMORY_DOCUMENT_CHUNK_MAX_BYTES + 3];
        let Some(MemoryMutateInput::ReplaceChunk { offset, chunk_base64, .. }) =
            MemoryMutateInput::replace_chunk("upload-1", &content, 0)
        else {
            panic!("a chunk");
        };
        assert_eq!(offset, 0);
        let decoded = base64::engine::general_purpose::STANDARD.decode(chunk_base64).expect("b64");
        assert_eq!(decoded.len(), MEMORY_DOCUMENT_CHUNK_MAX_BYTES, "a full chunk first");
        let last = MemoryMutateInput::replace_chunk(
            "upload-1",
            &content,
            MEMORY_DOCUMENT_CHUNK_MAX_BYTES as u64,
        );
        assert_eq!(
            serde_json::to_value(last).expect("encode"),
            json!({"kind": "replace_chunk", "uploadId": "upload-1",
                   "offset": MEMORY_DOCUMENT_CHUNK_MAX_BYTES, "chunkBase64": "YWFh"})
        );
        assert_eq!(
            MemoryMutateInput::replace_chunk("upload-1", &content, content.len() as u64),
            None
        );
        assert_eq!(
            serde_json::to_value(MemoryMutateInput::ReplaceCommit { upload_id: "u".into() })
                .expect("encode"),
            json!({"kind": "replace_commit", "uploadId": "u"})
        );
    }

    #[test]
    fn every_mutation_result_decodes() {
        for value in [
            json!({"kind": "upload_opened", "uploadId": "u", "nextOffset": 0}),
            json!({"kind": "chunk_accepted", "uploadId": "u", "nextOffset": 3}),
            json!({"kind": "upload_aborted", "uploadId": "u"}),
            json!({"kind": "committed", "revision": revision('a'),
                   "memoryRevision": revision('b'), "pendingRevision": null}),
            json!({"kind": "unchanged", "revision": revision('a'), "memoryRevision": null,
                   "pendingRevision": null}),
            json!({"kind": "revision_conflict", "expectedRevision": revision('a'),
                   "actualRevision": revision('b')}),
            // The TS test's backup conflict.
            json!({"kind": "backup_revision_conflict", "backupKind": "save",
                   "expectedRevision": revision('a'), "actualRevision": revision('b')}),
            json!({"kind": "rejected", "reason": "safe_mode"}),
        ] {
            round_trip::<MemoryMutateResult>(value);
        }
        let rejected: MemoryMutateResult =
            serde_json::from_value(json!({"kind": "rejected", "reason": "incognito_active"}))
                .expect("decode");
        assert_eq!(
            rejected,
            MemoryMutateResult::Rejected { reason: MemoryRejectionReason::IncognitoActive }
        );
    }
}
