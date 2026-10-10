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

//! The reads and the delete the Files face sends: `artifact.query` and
//! `artifact.delete` (`packages/runtime-host/src/protocol/artifact.ts`,
//! answered by `packages/runtime-host/src/server/artifact-coordinator.ts`).
//!
//! - A list is read page by page (`list_start`, then `list_continue` at the
//!   first page's revision while a cursor comes back; the cursor is an
//!   offset and a page stops at 48 KiB, so several pages are normal). A
//!   `revision_changed` starts it again.
//! - `get` answers the list's revision in a few hundred bytes, even for an
//!   id the Session does not have (`artifact: null`): what the face polls.
//! - `read_text` and `read_binary` are all or nothing: past 32 KiB (or a
//!   result past 48 KiB) they answer `too_large`, and the file is read with
//!   `read_chunk` from offset 0, 32 KiB at a time.

use std::sync::Arc;

use host_protocol::{
    ArtifactBinaryPreview, ArtifactDelete, ArtifactDeleteInput, ArtifactProjection, ArtifactQuery,
    ArtifactQueryInput, ArtifactQueryResult, ArtifactReadFailureReason, ArtifactTextPreview,
    HostOperationErrorCode,
};
use workspace::{HostRequestError, HostRequester};

/// How many times a list read starts over when the list changes under it.
const LIST_ATTEMPTS: usize = 3;

/// Why a read or the delete failed.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ReadFailure {
    /// A preview's reason (`read_text`, `read_binary`).
    Unavailable(ArtifactReadFailureReason),
    /// The Host refused the operation (`read_chunk`, a list, the delete).
    Operation { code: HostOperationErrorCode, message: Arc<str> },
    /// No connection to the Host.
    NotConnected,
    /// The connection failed.
    Transport(Arc<str>),
    /// The Host answered with a result this client does not know.
    Unexpected,
    /// The file's size changed while it was read in chunks.
    Changed,
    /// The file is larger than this read takes.
    TooLarge,
}

impl From<HostRequestError> for ReadFailure {
    fn from(error: HostRequestError) -> Self {
        match error {
            HostRequestError::NotConnected => Self::NotConnected,
            HostRequestError::Operation { code, message, .. } => Self::Operation { code, message },
            HostRequestError::Transport(message) => Self::Transport(message),
            other => Self::Transport(other.to_string().into()),
        }
    }
}

/// A Session's Artifacts at one revision, in the Host's order: newest
/// first, then by id (`compareArtifactRecords` in
/// `packages/storage/src/artifact-store.ts`). Never re-sorted here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listing {
    pub revision: String,
    pub artifacts: Vec<ArtifactProjection>,
}

/// Every Artifact of `session`, every page at one revision.
pub async fn list(requester: &HostRequester, session: &str) -> Result<Listing, ReadFailure> {
    let mut attempt = 0;
    'start: loop {
        attempt += 1;
        let first = ArtifactQueryInput::ListStart { session_id: session.to_owned() };
        let (revision, mut artifacts, mut cursor) =
            match requester.request::<ArtifactQuery>(&first).await? {
                ArtifactQueryResult::Page { revision, artifacts, next_cursor, .. } => {
                    (revision, artifacts, next_cursor)
                }
                _ => return Err(ReadFailure::Unexpected),
            };
        while let Some(next) = cursor.take() {
            let input = ArtifactQueryInput::ListContinue {
                session_id: session.to_owned(),
                revision: revision.clone(),
                cursor: next,
            };
            match requester.request::<ArtifactQuery>(&input).await? {
                ArtifactQueryResult::Page { artifacts: page, next_cursor, .. } => {
                    artifacts.extend(page);
                    cursor = next_cursor;
                }
                ArtifactQueryResult::RevisionChanged { .. } if attempt < LIST_ATTEMPTS => {
                    continue 'start;
                }
                ArtifactQueryResult::RevisionChanged { .. } => return Err(ReadFailure::Changed),
                _ => return Err(ReadFailure::Unexpected),
            }
        }
        return Ok(Listing { revision, artifacts });
    }
}

/// The list's revision, from a `get` of `probe` (any id: the answer
/// carries the revision whether or not the Session has it).
pub async fn revision(
    requester: &HostRequester,
    session: &str,
    probe: &str,
) -> Result<String, ReadFailure> {
    let input =
        ArtifactQueryInput::Get { session_id: session.to_owned(), artifact_id: probe.to_owned() };
    match requester.request::<ArtifactQuery>(&input).await? {
        ArtifactQueryResult::Artifact { revision, .. } => Ok(revision),
        _ => Err(ReadFailure::Unexpected),
    }
}

/// The whole file as text, if it is small enough for `read_text`.
pub async fn text(
    requester: &HostRequester,
    session: &str,
    artifact: &str,
) -> Result<String, ReadFailure> {
    let input = ArtifactQueryInput::ReadText {
        session_id: session.to_owned(),
        artifact_id: artifact.to_owned(),
    };
    match requester.request::<ArtifactQuery>(&input).await? {
        ArtifactQueryResult::Text { preview: ArtifactTextPreview::Text(text), .. } => Ok(text),
        ArtifactQueryResult::Text { preview: ArtifactTextPreview::Unavailable(reason), .. } => {
            Err(ReadFailure::Unavailable(reason))
        }
        _ => Err(ReadFailure::Unexpected),
    }
}

/// The whole file's bytes, if it is an image small enough for
/// `read_binary`.
pub async fn binary(
    requester: &HostRequester,
    session: &str,
    artifact: &str,
) -> Result<Vec<u8>, ReadFailure> {
    let input = ArtifactQueryInput::ReadBinary {
        session_id: session.to_owned(),
        artifact_id: artifact.to_owned(),
    };
    match requester.request::<ArtifactQuery>(&input).await? {
        ArtifactQueryResult::Binary { preview, .. } => match preview {
            ArtifactBinaryPreview::Unavailable(reason) => Err(ReadFailure::Unavailable(reason)),
            preview => preview.bytes().ok_or(ReadFailure::Unexpected),
        },
        _ => Err(ReadFailure::Unexpected),
    }
}

/// One chunk of a file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    pub bytes: Vec<u8>,
    pub total: u64,
    /// Where the next chunk starts; `None` at the end.
    pub next: Option<u64>,
}

/// The chunk of `artifact` that starts at `offset`.
pub async fn chunk(
    requester: &HostRequester,
    session: &str,
    artifact: &str,
    offset: u64,
) -> Result<Chunk, ReadFailure> {
    let input = ArtifactQueryInput::ReadChunk {
        session_id: session.to_owned(),
        artifact_id: artifact.to_owned(),
        offset,
    };
    let result = requester.request::<ArtifactQuery>(&input).await?;
    let bytes = result.chunk_bytes().ok_or(ReadFailure::Unexpected)?;
    match result {
        ArtifactQueryResult::Chunk { total_bytes, next_offset, .. } => {
            // A next offset that does not move on would read forever.
            let next = next_offset.filter(|next| *next > offset);
            if next_offset.is_some() && next.is_none() {
                return Err(ReadFailure::Unexpected);
            }
            Ok(Chunk { bytes, total: total_bytes, next })
        }
        _ => Err(ReadFailure::Unexpected),
    }
}

/// Every byte of `artifact`, chunk by chunk from offset 0, refused past
/// `max` bytes and when the file's size changes between chunks.
pub async fn all(
    requester: &HostRequester,
    session: &str,
    artifact: &str,
    max: Option<u64>,
) -> Result<Vec<u8>, ReadFailure> {
    let first = chunk(requester, session, artifact, 0).await?;
    if max.is_some_and(|max| first.total > max) {
        return Err(ReadFailure::TooLarge);
    }
    Ok(rest(requester, session, artifact, first).await?.bytes)
}

/// The whole of `artifact` from `first`, its first chunk, read on to its
/// end as one chunk; refused when the file's size changes between chunks.
pub async fn rest(
    requester: &HostRequester,
    session: &str,
    artifact: &str,
    first: Chunk,
) -> Result<Chunk, ReadFailure> {
    let total = first.total;
    let mut bytes = first.bytes;
    bytes.reserve(usize::try_from(total).unwrap_or(0).min(64 << 20).saturating_sub(bytes.len()));
    let mut next = first.next;
    while let Some(offset) = next {
        let piece = chunk(requester, session, artifact, offset).await?;
        if piece.total != total {
            return Err(ReadFailure::Changed);
        }
        bytes.extend_from_slice(&piece.bytes);
        next = piece.next;
    }
    if bytes.len() as u64 != total {
        return Err(ReadFailure::Changed);
    }
    Ok(Chunk { bytes, total, next: None })
}

/// Deletes `artifact` from `session`.
pub async fn delete(
    requester: &HostRequester,
    session: &str,
    artifact: &str,
) -> Result<(), ReadFailure> {
    requester.request::<ArtifactDelete>(&ArtifactDeleteInput::new(session, artifact)).await?;
    Ok(())
}
