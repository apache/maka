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

//! `artifact.ingest`: uploading a file into a Session, which makes it an
//! attachment a message can carry.
//!
//! Sources: `ArtifactIngestInput`, `ArtifactIngestResult`,
//! `decodeArtifactIngestInput`, and `decodeArtifactIngestResult` in
//! `packages/runtime-host/src/protocol/artifact.ts`; `AttachmentRef` and
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
/// `ARTIFACT_NAME_MAX_BYTES`: UTF-8 bytes of an attachment's name.
pub const ARTIFACT_NAME_MAX_BYTES: usize = 512;

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
