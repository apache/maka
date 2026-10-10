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

//! Session Artifacts: `artifact.ingest`, uploading a file into a Session,
//! which makes it an attachment a message can carry; and `artifact.query`
//! and `artifact.delete`, the files a Session holds (Desktop's Files tool,
//! which polls the list every 2 s while visible).
//!
//! Sources: `ArtifactIngestInput`, `ArtifactIngestResult`,
//! `decodeArtifactIngestInput`, and `decodeArtifactIngestResult` in
//! `packages/runtime-host/src/protocol/artifact.ts`, and in the same file
//! `ArtifactQueryInput`, `ArtifactQueryResult`, `ArtifactProjection`,
//! `decodeArtifactQueryResult` and `decodeArtifactDeleteResult`; the kinds,
//! sources and read failures in `packages/core/src/artifacts.ts`; the Host
//! side in `packages/runtime-host/src/server/artifact-coordinator.ts`.
//! `AttachmentRef` and
//! `StorageRef` in `packages/core/src/events.ts`; the limits in
//! `packages/core/src/attachments.ts`. The Desktop's upload loop is
//! `RuntimeHostClient.ingestAttachment` in
//! `apps/desktop/src/main/runtime-host-client.ts`: `begin` with the size and
//! SHA-256 of the whole file (the Host may answer `committed` at once for
//! bytes it already holds), then `chunk`s of at most
//! [`ARTIFACT_INGEST_CHUNK_MAX_BYTES`] from the offset the Host names, then
//! `commit`, which answers the [`AttachmentRef`] to put in
//! `MessageContent.attachments`; `abort` after a failure.

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::Operation;

/// `MAX_ATTACHMENT_COUNT`: attachments per message.
pub const MAX_ATTACHMENT_COUNT: usize = 8;
/// `MAX_ATTACHMENT_BYTES`: bytes per attachment (50 MiB).
pub const MAX_ATTACHMENT_BYTES: u64 = 50 * 1024 * 1024;
/// `ARTIFACT_INGEST_CHUNK_MAX_BYTES`: decoded bytes per `chunk`.
pub const ARTIFACT_INGEST_CHUNK_MAX_BYTES: usize = 48 * 1024;
/// `ARTIFACT_NAME_MAX_BYTES`: UTF-8 bytes of an attachment's or Artifact's
/// name.
pub const ARTIFACT_NAME_MAX_BYTES: usize = 512;
/// `ARTIFACT_PAGE_MAX_ITEMS`: Artifacts per `artifact.query` page.
pub const ARTIFACT_PAGE_MAX_ITEMS: usize = 128;
/// `ARTIFACT_RESULT_MAX_BYTES`: one encoded `artifact.query` result. A text
/// preview that would not fit answers `too_large`.
pub const ARTIFACT_RESULT_MAX_BYTES: usize = 48 * 1024;
/// `ARTIFACT_PREVIEW_MAX_BYTES`: the largest file `read_text` and
/// `read_binary` return whole; larger ones answer `too_large` and are read
/// with `read_chunk`.
pub const ARTIFACT_PREVIEW_MAX_BYTES: usize = 32 * 1024;
/// `ARTIFACT_READ_CHUNK_MAX_BYTES`: bytes per `read_chunk`.
pub const ARTIFACT_READ_CHUNK_MAX_BYTES: usize = 32 * 1024;
/// `ARTIFACT_CURSOR_MAX_BYTES`.
pub const ARTIFACT_CURSOR_MAX_BYTES: usize = 32;
/// `ARTIFACT_MIME_TYPE_MAX_BYTES`.
pub const ARTIFACT_MIME_TYPE_MAX_BYTES: usize = 512;
/// `ARTIFACT_SUMMARY_MAX_BYTES`.
pub const ARTIFACT_SUMMARY_MAX_BYTES: usize = 8 * 1024;

wire_enum! {
    /// `AttachmentRef.kind`. The wire's `other` is [`Self::Generic`]
    /// (`Other` holds a kind this client does not know).
    pub enum AttachmentKind {
        Image = "image",
        Pdf = "pdf",
        Doc = "doc",
        Code = "code",
        Generic = "other",
    }
}

/// `StorageRef`: where an attachment's bytes live.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum StorageRef {
    /// A Session Artifact: what `artifact.ingest` commits.
    #[serde(rename_all = "camelCase")]
    SessionFile { session_id: String, relative_path: String },
    #[serde(rename_all = "camelCase")]
    WorkspaceFile { relative_path: String },
    #[serde(rename_all = "camelCase")]
    ExternalFile { absolute_path: String },
    /// Host-owned; a client never sends one.
    #[serde(rename_all = "camelCase")]
    SessionContext { session_id: String, ref_id: String },
}

/// `AttachmentRef` (`isCanonicalAttachmentRef`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct AttachmentRef {
    pub kind: AttachmentKind,
    pub name: String,
    pub mime_type: String,
    pub bytes: u64,
    #[serde(rename = "ref")]
    pub storage: StorageRef,
}

/// `ArtifactIngestInput` (`decodeArtifactIngestInput`), by `kind`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum ArtifactIngestInput {
    /// Opens an upload of `total_bytes` (at most [`MAX_ATTACHMENT_BYTES`])
    /// whose bytes hash to `content_sha256` (`sha256:<64 hex>`).
    #[serde(rename_all = "camelCase")]
    Begin {
        session_id: String,
        upload_id: String,
        /// At most [`ARTIFACT_NAME_MAX_BYTES`] of UTF-8.
        name: String,
        /// At most 256 bytes.
        mime_type: String,
        total_bytes: u64,
        content_sha256: String,
    },
    /// Canonical padded base64 of 1 to [`ARTIFACT_INGEST_CHUNK_MAX_BYTES`]
    /// bytes starting at `offset`.
    #[serde(rename_all = "camelCase")]
    Chunk { session_id: String, upload_id: String, offset: u64, chunk_base64: String },
    #[serde(rename_all = "camelCase")]
    Commit { session_id: String, upload_id: String },
    #[serde(rename_all = "camelCase")]
    Abort { session_id: String, upload_id: String },
}

impl ArtifactIngestInput {
    /// `begin` for `content`, with its size and digest.
    pub fn begin(
        session_id: impl Into<String>,
        upload_id: impl Into<String>,
        name: impl Into<String>,
        mime_type: impl Into<String>,
        content: &[u8],
    ) -> Self {
        Self::Begin {
            session_id: session_id.into(),
            upload_id: upload_id.into(),
            name: name.into(),
            mime_type: mime_type.into(),
            total_bytes: content.len() as u64,
            content_sha256: format!("sha256:{}", hex(&Sha256::digest(content))),
        }
    }

    /// The `chunk` of `content` that starts at `offset`, or `None` when
    /// `offset` is at or past the end.
    pub fn chunk(
        session_id: impl Into<String>,
        upload_id: impl Into<String>,
        content: &[u8],
        offset: u64,
    ) -> Option<Self> {
        let start = usize::try_from(offset).ok().filter(|start| *start < content.len())?;
        let end = content.len().min(start + ARTIFACT_INGEST_CHUNK_MAX_BYTES);
        Some(Self::Chunk {
            session_id: session_id.into(),
            upload_id: upload_id.into(),
            offset,
            chunk_base64: base64::engine::general_purpose::STANDARD.encode(&content[start..end]),
        })
    }

    pub fn commit(session_id: impl Into<String>, upload_id: impl Into<String>) -> Self {
        Self::Commit { session_id: session_id.into(), upload_id: upload_id.into() }
    }

    pub fn abort(session_id: impl Into<String>, upload_id: impl Into<String>) -> Self {
        Self::Abort { session_id: session_id.into(), upload_id: upload_id.into() }
    }
}

/// `ArtifactIngestResult` (`decodeArtifactIngestResult`), by `kind`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum ArtifactIngestResult {
    /// Send bytes from `next_offset` (non-zero when the Host already holds
    /// a prefix).
    #[serde(rename_all = "camelCase")]
    UploadOpened { upload_id: String, next_offset: u64 },
    #[serde(rename_all = "camelCase")]
    ChunkAccepted { upload_id: String, next_offset: u64 },
    /// The attachment exists; its `ref` is a `session_file` of the Session.
    #[serde(rename_all = "camelCase")]
    Committed { upload_id: String, attachment: AttachmentRef },
    #[serde(rename_all = "camelCase")]
    UploadAborted { upload_id: String },
    /// A result kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// `artifact.ingest` (mode `command`, `ARTIFACT_OPERATION_SPECS`).
#[derive(Debug)]
pub enum ArtifactIngest {}

impl Operation for ArtifactIngest {
    const NAME: &'static str = "artifact.ingest";
    type Input = ArtifactIngestInput;
    type Output = ArtifactIngestResult;
}

wire_enum! {
    /// `ArtifactKind` (`ARTIFACT_KINDS` in `packages/core/src/artifacts.ts`).
    pub enum ArtifactKind {
        File = "file",
        Diff = "diff",
        Html = "html",
        Image = "image",
        Pdf = "pdf",
    }
}

wire_enum! {
    /// `ArtifactSource` (`ARTIFACT_SOURCES`): what made the Artifact.
    pub enum ArtifactSource {
        ToolResult = "tool_result",
        ToolResultProjection = "tool_result_projection",
        ToolResultArchive = "tool_result_archive",
        SubagentWriteback = "subagent_writeback",
        DeepResearch = "deep_research",
        /// An `artifact.ingest` upload; its `turnId` is the upload id.
        UserUpload = "user_upload",
        SessionEffect = "session_effect",
    }
}

/// `ArtifactProjection` (`decodeArtifactProjection`): one file of a Session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ArtifactProjection {
    pub id: String,
    pub session_id: String,
    /// The Turn that made it (1 to 512 characters, no control characters);
    /// for an upload, its upload id.
    pub turn_id: String,
    /// Unix milliseconds.
    pub created_at: u64,
    /// At most [`ARTIFACT_NAME_MAX_BYTES`]; control characters are replaced.
    pub name: String,
    pub kind: ArtifactKind,
    pub size_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    pub source: ArtifactSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

/// `ArtifactQueryInput` (`decodeArtifactQueryInput`), by `kind`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum ArtifactQueryInput {
    /// The Session's Artifacts from the start.
    #[serde(rename_all = "camelCase")]
    ListStart { session_id: String },
    /// The next page, at the revision of the first one.
    #[serde(rename_all = "camelCase")]
    ListContinue { session_id: String, revision: String, cursor: String },
    #[serde(rename_all = "camelCase")]
    Get { session_id: String, artifact_id: String },
    /// The whole file as UTF-8 text, up to [`ARTIFACT_PREVIEW_MAX_BYTES`].
    #[serde(rename_all = "camelCase")]
    ReadText { session_id: String, artifact_id: String },
    /// The whole file as base64, up to [`ARTIFACT_PREVIEW_MAX_BYTES`], for a
    /// type the Host previews (images).
    #[serde(rename_all = "camelCase")]
    ReadBinary { session_id: String, artifact_id: String },
    /// [`ARTIFACT_READ_CHUNK_MAX_BYTES`] from `offset`; follow `nextOffset`.
    #[serde(rename_all = "camelCase")]
    ReadChunk { session_id: String, artifact_id: String, offset: u64 },
}

wire_enum! {
    /// `ArtifactReadFailureReason` and `ArtifactBinaryReadFailureReason`.
    pub enum ArtifactReadFailureReason {
        NotFound = "not_found",
        /// Over [`ARTIFACT_PREVIEW_MAX_BYTES`] or the result size.
        TooLarge = "too_large",
        ReadFailed = "read_failed",
        NotAllowed = "not_allowed",
        /// `read_binary` only: not a type the Host previews.
        UnsupportedMime = "unsupported_mime",
    }
}

/// `ArtifactTextPreview` (`decodeTextPreview`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "RawPreview", into = "RawPreview")]
#[non_exhaustive]
pub enum ArtifactTextPreview {
    Text(String),
    Unavailable(ArtifactReadFailureReason),
}

/// `ArtifactBinaryPreview` (`decodeBinaryPreview`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "RawPreview", into = "RawPreview")]
#[non_exhaustive]
pub enum ArtifactBinaryPreview {
    /// Canonical padded base64 of the whole file.
    Bytes {
        base64: String,
        mime_type: String,
    },
    Unavailable(ArtifactReadFailureReason),
}

impl ArtifactBinaryPreview {
    /// The file's bytes, if the preview has them and they decode.
    pub fn bytes(&self) -> Option<Vec<u8>> {
        match self {
            Self::Bytes { base64, .. } => {
                base64::engine::general_purpose::STANDARD.decode(base64).ok()
            }
            Self::Unavailable(_) => None,
        }
    }
}

/// A preview as the wire has it: `ok` says which fields it carries.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
struct RawPreview {
    ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    base64: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mime_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<ArtifactReadFailureReason>,
}

impl RawPreview {
    fn unavailable(reason: ArtifactReadFailureReason) -> Self {
        Self { ok: false, text: None, base64: None, mime_type: None, reason: Some(reason) }
    }
}

impl TryFrom<RawPreview> for ArtifactTextPreview {
    type Error = &'static str;

    fn try_from(raw: RawPreview) -> Result<Self, Self::Error> {
        match raw {
            RawPreview {
                ok: true,
                text: Some(text),
                base64: None,
                mime_type: None,
                reason: None,
            } => Ok(Self::Text(text)),
            RawPreview {
                ok: false,
                text: None,
                base64: None,
                mime_type: None,
                reason: Some(r),
            } => Ok(Self::Unavailable(r)),
            _ => Err("a text preview is its text or its failure reason"),
        }
    }
}

impl From<ArtifactTextPreview> for RawPreview {
    fn from(preview: ArtifactTextPreview) -> Self {
        match preview {
            ArtifactTextPreview::Text(text) => {
                Self { ok: true, text: Some(text), base64: None, mime_type: None, reason: None }
            }
            ArtifactTextPreview::Unavailable(reason) => Self::unavailable(reason),
        }
    }
}

impl TryFrom<RawPreview> for ArtifactBinaryPreview {
    type Error = &'static str;

    fn try_from(raw: RawPreview) -> Result<Self, Self::Error> {
        match raw {
            RawPreview {
                ok: true,
                text: None,
                base64: Some(base64),
                mime_type: Some(mime_type),
                reason: None,
            } => Ok(Self::Bytes { base64, mime_type }),
            RawPreview {
                ok: false,
                text: None,
                base64: None,
                mime_type: None,
                reason: Some(r),
            } => Ok(Self::Unavailable(r)),
            _ => Err("a binary preview is its bytes or its failure reason"),
        }
    }
}

impl From<ArtifactBinaryPreview> for RawPreview {
    fn from(preview: ArtifactBinaryPreview) -> Self {
        match preview {
            ArtifactBinaryPreview::Bytes { base64, mime_type } => Self {
                ok: true,
                text: None,
                base64: Some(base64),
                mime_type: Some(mime_type),
                reason: None,
            },
            ArtifactBinaryPreview::Unavailable(reason) => Self::unavailable(reason),
        }
    }
}

/// `ArtifactQueryResult` (`decodeArtifactQueryResult`), by `kind`.
/// Revisions are `sha256:<64 hex>`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum ArtifactQueryResult {
    /// At most [`ARTIFACT_PAGE_MAX_ITEMS`] Artifacts.
    #[serde(rename_all = "camelCase")]
    Page {
        session_id: String,
        revision: String,
        artifacts: Vec<ArtifactProjection>,
        next_cursor: Option<String>,
    },
    /// The list changed since its first page: start again.
    RevisionChanged { expected: String, actual: String },
    /// `get`: `null` when the Session has no such Artifact.
    #[serde(rename_all = "camelCase")]
    Artifact { session_id: String, revision: String, artifact: Option<Box<ArtifactProjection>> },
    #[serde(rename_all = "camelCase")]
    Text { session_id: String, artifact_id: String, preview: ArtifactTextPreview },
    #[serde(rename_all = "camelCase")]
    Binary { session_id: String, artifact_id: String, preview: ArtifactBinaryPreview },
    /// Bytes `offset..offset + n` of `total_bytes`; `next_offset` is `null`
    /// at the end.
    #[serde(rename_all = "camelCase")]
    Chunk {
        session_id: String,
        artifact_id: String,
        offset: u64,
        total_bytes: u64,
        chunk_base64: String,
        next_offset: Option<u64>,
    },
    /// A result kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

impl ArtifactQueryResult {
    /// A `chunk` result's bytes, if they decode.
    pub fn chunk_bytes(&self) -> Option<Vec<u8>> {
        match self {
            Self::Chunk { chunk_base64, .. } => {
                base64::engine::general_purpose::STANDARD.decode(chunk_base64).ok()
            }
            _ => None,
        }
    }
}

/// `ArtifactDeleteInput` (`decodeArtifactDeleteInput`). Only what a user
/// uploaded or a Turn produced can go; runtime-owned evidence answers
/// `operation_conflict`, an unknown id `not_found`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ArtifactDeleteInput {
    pub session_id: String,
    pub artifact_id: String,
}

impl ArtifactDeleteInput {
    pub fn new(session_id: impl Into<String>, artifact_id: impl Into<String>) -> Self {
        Self { session_id: session_id.into(), artifact_id: artifact_id.into() }
    }
}

wire_tag! {
    /// `ArtifactDeleteResult.kind`.
    DeletedKind = "deleted"
}

/// `ArtifactDeleteResult`: `{ kind: "deleted" }`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ArtifactDeleteResult {
    kind: DeletedKind,
}

/// `artifact.query` (mode `query`).
#[derive(Debug)]
pub enum ArtifactQuery {}

impl Operation for ArtifactQuery {
    const NAME: &'static str = "artifact.query";
    type Input = ArtifactQueryInput;
    type Output = ArtifactQueryResult;
}

/// `artifact.delete` (mode `command`).
#[derive(Debug)]
pub enum ArtifactDelete {}

impl Operation for ArtifactDelete {
    const NAME: &'static str = "artifact.delete";
    type Input = ArtifactDeleteInput;
    type Output = ArtifactDeleteResult;
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn begin_carries_the_size_and_digest_of_the_whole_file() {
        let input = ArtifactIngestInput::begin("s", "u", "notes.txt", "text/plain", b"abc");
        assert_eq!(
            serde_json::to_value(input).expect("encode"),
            json!({
                "kind": "begin", "sessionId": "s", "uploadId": "u", "name": "notes.txt",
                "mimeType": "text/plain", "totalBytes": 3,
                "contentSha256":
                    "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
            })
        );
    }

    #[test]
    fn chunks_are_bounded_and_start_where_the_host_asks() {
        let content = vec![7u8; ARTIFACT_INGEST_CHUNK_MAX_BYTES + 10];
        let Some(ArtifactIngestInput::Chunk { offset, chunk_base64, .. }) =
            ArtifactIngestInput::chunk("s", "u", &content, 0)
        else {
            panic!("a chunk")
        };
        let decoded = base64::engine::general_purpose::STANDARD.decode(chunk_base64).expect("b64");
        assert_eq!((offset, decoded.len()), (0, ARTIFACT_INGEST_CHUNK_MAX_BYTES));
        let Some(ArtifactIngestInput::Chunk { chunk_base64, .. }) =
            ArtifactIngestInput::chunk("s", "u", &content, ARTIFACT_INGEST_CHUNK_MAX_BYTES as u64)
        else {
            panic!("the rest")
        };
        let decoded = base64::engine::general_purpose::STANDARD.decode(chunk_base64).expect("b64");
        assert_eq!(decoded.len(), 10);
        assert_eq!(ArtifactIngestInput::chunk("s", "u", &content, content.len() as u64), None);
    }

    #[test]
    fn query_results_decode_by_kind_and_previews_by_ok() {
        let artifact = json!({
            "id": "a1", "sessionId": "s", "turnId": "u1", "createdAt": 1, "name": "n.txt",
            "kind": "file", "sizeBytes": 3, "mimeType": "text/plain", "source": "user_upload"
        });
        let page = json!({"kind": "page", "sessionId": "s", "revision": "sha256:00",
                          "artifacts": [artifact], "nextCursor": null});
        let decoded: ArtifactQueryResult = serde_json::from_value(page.clone()).expect("decode");
        assert_eq!(serde_json::to_value(&decoded).expect("encode"), page);
        let ArtifactQueryResult::Page { artifacts, .. } = decoded else { panic!("page") };
        assert_eq!(
            (artifacts[0].kind.clone(), artifacts[0].source.clone()),
            (ArtifactKind::File, ArtifactSource::UserUpload)
        );

        for (preview, expected) in [
            (json!({"ok": true, "text": "abc"}), ArtifactTextPreview::Text("abc".into())),
            (
                json!({"ok": false, "reason": "too_large"}),
                ArtifactTextPreview::Unavailable(ArtifactReadFailureReason::TooLarge),
            ),
        ] {
            let decoded: ArtifactTextPreview =
                serde_json::from_value(preview.clone()).expect("decode");
            assert_eq!(decoded, expected);
            assert_eq!(serde_json::to_value(&decoded).expect("encode"), preview);
        }
        let binary: ArtifactBinaryPreview =
            serde_json::from_value(json!({"ok": true, "base64": "YWJj", "mimeType": "image/png"}))
                .expect("decode");
        assert_eq!(binary.bytes().as_deref(), Some(&b"abc"[..]));
        for broken in [json!({"ok": true}), json!({"ok": false, "text": "x", "reason": "x"})] {
            assert!(serde_json::from_value::<ArtifactTextPreview>(broken).is_err());
        }
        let future: ArtifactQueryResult =
            serde_json::from_value(json!({"kind": "thumbnail"})).expect("decode");
        assert_eq!(future, ArtifactQueryResult::Unknown);
    }

    #[test]
    fn delete_answers_deleted() {
        let deleted: ArtifactDeleteResult =
            serde_json::from_value(json!({"kind": "deleted"})).expect("decode");
        assert_eq!(serde_json::to_value(deleted).expect("encode"), json!({"kind": "deleted"}));
        assert!(serde_json::from_value::<ArtifactDeleteResult>(json!({"kind": "kept"})).is_err());
        assert_eq!(
            serde_json::to_value(ArtifactDeleteInput::new("s", "a")).expect("encode"),
            json!({"sessionId": "s", "artifactId": "a"})
        );
    }

    #[test]
    fn a_committed_upload_names_its_session_file() {
        let result: ArtifactIngestResult = serde_json::from_value(json!({
            "kind": "committed", "uploadId": "u",
            "attachment": {"kind": "other", "name": "notes.txt",
                           "mimeType": "application/octet-stream", "bytes": 3,
                           "ref": {"kind": "session_file", "sessionId": "s", "relativePath": "a1"}}
        }))
        .expect("decode");
        let ArtifactIngestResult::Committed { attachment, .. } = result else {
            panic!("committed")
        };
        assert_eq!(attachment.kind, AttachmentKind::Generic);
        assert_eq!(
            attachment.storage,
            StorageRef::SessionFile { session_id: "s".into(), relative_path: "a1".into() }
        );
    }
}
