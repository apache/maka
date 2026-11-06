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

mod copy;
pub(crate) mod history;
pub(crate) mod identity;
mod read;
mod records;
pub(crate) mod references;
use crate::{EventLog, StoreError};
use maka_agent_facts::artifact::Artifact;
use maka_agent_facts::artifact::ArtifactSource;
use maka_agent_facts::artifact::content_digest;
use records::{advance, decode, invalid, read_record, require_session};
use rusqlite::OptionalExtension;

#[derive(Debug, PartialEq, Eq)]
pub enum ArtifactDeletion {
    Deleted,
    NotFound,
    Protected,
}

#[derive(Debug)]
pub struct ArtifactPage {
    pub revision: String,
    pub records: Vec<Artifact>,
    pub total: u64,
}

#[derive(Debug)]
pub struct ArtifactEntry {
    pub revision: String,
    pub record: Option<Artifact>,
}

/// Trusted read scope; execution preserves the original Session + Turn predicate.
pub enum ArtifactReadScope<'a> {
    Session(&'a str),
    Execution(&'a maka_agent_facts::event::Invocation),
}

#[derive(Debug)]
pub struct ArtifactChunk {
    pub total_bytes: u64,
    pub bytes: Vec<u8>,
}

impl EventLog {
    /// Immutable payload + metadata in one transaction. Exact retries retain the
    /// first creation time; all other metadata and payload bytes must agree.
    pub async fn commit_artifact(
        &self,
        artifact: Artifact,
        bytes: impl AsRef<[u8]> + Send + 'static,
    ) -> Result<Artifact, StoreError> {
        self.check_bound_session(&artifact.session_id)?;
        self.connection
            .run_prepared(
                move || {
                    let prepared = PreparedArtifact::new(artifact, bytes.as_ref())?;
                    Ok((prepared, bytes))
                },
                |connection, (prepared, bytes)| {
                    let tx = rusqlite::Transaction::new_unchecked(
                        connection,
                        rusqlite::TransactionBehavior::Immediate,
                    )?;
                    let artifact = commit_prepared(&tx, prepared, bytes.as_ref())?;
                    tx.commit().map_err(StoreError::CommitUnknown)?;
                    Ok(artifact)
                },
            )
            .await
    }

    /// Runtime-owned evidence cannot be deleted independently of its workflow.
    pub async fn delete_user_artifact(
        &self,
        session_id: &str,
        artifact_id: &str,
    ) -> Result<ArtifactDeletion, StoreError> {
        records::ids(session_id, Some(artifact_id))?;
        let (session_id, artifact_id) = (session_id.to_owned(), artifact_id.to_owned());
        let commits = self.commits.notice();
        self.connection
            .run(move |connection| {
                {
                    let tx = rusqlite::Transaction::new_unchecked(connection, rusqlite::TransactionBehavior::Immediate)?;
                    require_session(&tx, &session_id)?;
                    let Some((artifact, _)) =
                        read_record(&tx, &session_id, &artifact_id)?
                    else {
                        return Ok(ArtifactDeletion::NotFound);
                    };
                    let retained: bool = tx.prepare_cached("SELECT EXISTS(SELECT 1 FROM session_history_artifacts WHERE session_id = ? AND artifact_id = ?)")?.query_row(rusqlite::params![&session_id, &artifact_id], |row| row.get(0))?;
                    if !artifact.source.user_deletable() || retained
                        || tx.prepare_cached("SELECT canonical_at IS NOT NULL FROM artifacts WHERE session_id = ? AND id = ?")?.query_row(rusqlite::params![&session_id, &artifact_id], |row| row.get(0))?
                    {
                        return Ok(ArtifactDeletion::Protected);
                    }
                    tx.prepare_cached("DELETE FROM artifacts WHERE session_id = ? AND id = ?")?.execute(rusqlite::params![&session_id, &artifact_id])?;
                    advance(&tx, &session_id)?;
                    tx.commit().map_err(StoreError::CommitUnknown)?;
                    commits.material_released();
                    Ok(ArtifactDeletion::Deleted)
                }
            })
            .await
    }
}

pub(crate) struct PreparedArtifact {
    artifact: Artifact,
    digest: String,
    encoded: String,
}
impl PreparedArtifact {
    fn new(artifact: Artifact, bytes: &[u8]) -> Result<Self, StoreError> {
        let digest = content_digest(bytes);
        Self::from_digest(artifact, bytes.len() as u64, digest)
    }
    fn from_digest(artifact: Artifact, bytes: u64, digest: String) -> Result<Self, StoreError> {
        let encoded = validate_material(&artifact, bytes, &digest)?;
        Ok(Self {
            artifact,
            digest,
            encoded,
        })
    }
    pub(crate) fn from_projection(
        pending: &maka_agent_facts::event::ProjectionArtifactWrite,
        evidence: &maka_agent_facts::artifact::ArtifactEvidence,
    ) -> Result<Self, StoreError> {
        if pending.artifact().id != evidence.id || pending.bytes().len() as u64 != evidence.bytes {
            return Err(StoreError::EventConflict);
        }
        // EventWrite freezes this digest with the private projection payload.
        Self::from_digest(
            pending.artifact().clone(),
            evidence.bytes,
            evidence.digest.clone(),
        )
    }
}

/// Import independently verifies its untrusted payload before publishing a binding.
pub(crate) fn commit_in_transaction(
    connection: &rusqlite::Connection,
    artifact: Artifact,
    bytes: &[u8],
) -> Result<Artifact, StoreError> {
    commit_prepared(connection, PreparedArtifact::new(artifact, bytes)?, bytes)
}

pub(crate) fn commit_prepared(
    connection: &rusqlite::Connection,
    prepared: PreparedArtifact,
    bytes: &[u8],
) -> Result<Artifact, StoreError> {
    let PreparedArtifact {
        mut artifact,
        digest,
        encoded,
    } = prepared;
    require_session(connection, &artifact.session_id)?;
    if let Some((existing, stored_digest)) =
        read_record(connection, &artifact.session_id, &artifact.id)?
    {
        if artifact.source == ArtifactSource::ToolResultProjection
            && artifact.created_at != existing.created_at
        {
            return Err(StoreError::ArtifactConflict);
        }
        artifact.created_at = existing.created_at;
        if artifact != existing || digest != stored_digest {
            return Err(StoreError::ArtifactConflict);
        }
        verify_payload(connection, &artifact, bytes)?;
        return Ok(existing);
    }
    crate::content::put(connection, &digest, bytes)?;
    connection.prepare_cached("INSERT INTO artifacts (session_id, id, created_at, record_json, content_sha256, lookup_digest)
        VALUES (?, ?, ?, ?, ?, ?)")?.execute(rusqlite::params![&artifact.session_id, &artifact.id, artifact.created_at as i64, encoded, digest, identity::artifact_lookup_digest(&artifact.session_id, &artifact.id).as_slice()])?;
    advance(connection, &artifact.session_id)?;
    Ok(artifact)
}

/// Validate immutable metadata against already checked payload length and digest.
pub(crate) fn validate_material(
    artifact: &Artifact,
    bytes: u64,
    digest: &str,
) -> Result<String, StoreError> {
    artifact.validate().map_err(invalid)?;
    if artifact.size_bytes != bytes {
        return Err(invalid("Artifact payload size mismatch"));
    }
    let encoded = serde_json::to_string(artifact)?;
    if artifact.source == ArtifactSource::UserUpload && artifact.summary.as_deref() != Some(digest)
    {
        return Err(StoreError::ArtifactConflict);
    }
    Ok(encoded)
}

pub(crate) fn verify_projection_replay(
    connection: &rusqlite::Connection,
    artifact: &Artifact,
    bytes: &[u8],
    expected_digest: &str,
) -> Result<(), StoreError> {
    let Some((existing, digest)) = read_record(connection, &artifact.session_id, &artifact.id)?
    else {
        return Err(StoreError::EventConflict);
    };
    if &existing != artifact || digest != expected_digest {
        return Err(StoreError::EventConflict);
    }
    verify_payload(connection, artifact, bytes)
}

fn verify_payload(
    connection: &rusqlite::Connection,
    artifact: &Artifact,
    bytes: &[u8],
) -> Result<(), StoreError> {
    let matches: bool = connection.prepare_cached("SELECT EXISTS(SELECT 1 FROM artifacts JOIN contents USING(content_sha256) WHERE session_id = ? AND artifacts.id = ? AND payload = ?)")?.query_row(rusqlite::params![&artifact.session_id, &artifact.id, bytes], |row| row.get(0))?;
    if !matches {
        return Err(StoreError::ArtifactConflict);
    }
    Ok(())
}

/// Bounded immutable encoded image material; no filesystem path or bearer handle.
#[derive(Debug)]
pub struct ImageChunk {
    pub total_bytes: u64,
    pub mime_type: String,
    pub digest: String,
    pub bytes: Vec<u8>,
}

pub(crate) fn read_image(
    connection: &rusqlite::Connection,
    session: &str,
    id: &str,
    mime: &str,
    offset: u64,
    limit: usize,
    row_event: u64,
) -> Result<ImageChunk, StoreError> {
    records::ids(session, Some(id))?;
    require_session(connection, session)?;
    let (artifact, digest) = read_record(connection, session, id)?
        .ok_or_else(|| invalid("tool image artifact not found"))?;
    let canonical_at: Option<i64> = connection
        .prepare_cached("SELECT canonical_at FROM artifacts WHERE session_id = ? AND id = ?")?
        .query_row(rusqlite::params![session, id], |row| row.get(0))?;
    if !canonical_at.is_some_and(|at| at > 0 && at as u64 <= row_event) {
        return Err(invalid(
            "tool image bytes were not frozen at their canonical row",
        ));
    }
    image_chunk(connection, &artifact, digest, mime, offset, limit)
}

pub(crate) fn read_attachment_image(
    connection: &rusqlite::Connection,
    session: &str,
    id: &str,
    attachment: Option<&maka_agent_facts::attachment::AttachmentRef>,
    offset: u64,
    limit: usize,
) -> Result<ImageChunk, StoreError> {
    records::ids(session, Some(id))?;
    require_session(connection, session)?;
    let (artifact, digest) = read_record(connection, session, id)?
        .ok_or_else(|| invalid("uploaded image artifact not found"))?;
    if artifact.source != ArtifactSource::UserUpload || artifact.summary.as_ref() != Some(&digest) {
        return Err(invalid("image is not an immutable user upload"));
    }
    if let Some(attachment) = attachment {
        artifact.validate_attachment(attachment).map_err(invalid)?;
    }
    let mime = artifact
        .mime_type
        .as_deref()
        .ok_or_else(|| invalid("uploaded image has no MIME type"))?;
    image_chunk(connection, &artifact, digest, mime, offset, limit)
}

fn image_chunk(
    connection: &rusqlite::Connection,
    artifact: &Artifact,
    digest: String,
    mime: &str,
    offset: u64,
    limit: usize,
) -> Result<ImageChunk, StoreError> {
    if artifact.kind != maka_agent_facts::artifact::ArtifactKind::Image
        || artifact.mime_type.as_deref() != Some(mime)
        || !matches!(
            mime,
            "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif"
        )
        || artifact.size_bytes == 0
        || !digest.strip_prefix("sha256:").is_some_and(|value| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
    {
        return Err(invalid("invalid retained image metadata"));
    }
    if offset > artifact.size_bytes {
        return Err(StoreError::ArtifactOffset);
    }
    let (total, bytes): (i64, Vec<u8>) = connection.prepare_cached("SELECT length(payload), substr(payload, ?, ?) FROM artifacts JOIN contents USING(content_sha256) WHERE session_id = ? AND artifacts.id = ?")?.query_row(rusqlite::params![offset as i64 + 1, limit as i64, &artifact.session_id, &artifact.id], |row| Ok((row.get(0)?, row.get(1)?,)))?;
    if total as u64 != artifact.size_bytes
        || bytes.len() as u64 != (artifact.size_bytes - offset).min(limit as u64)
    {
        return Err(invalid("image artifact size mismatch"));
    }
    Ok(ImageChunk {
        total_bytes: artifact.size_bytes,
        mime_type: mime.to_owned(),
        digest,
        bytes,
    })
}

/// Consume artifact-backed media in the same transaction as original settlement.
/// The private artifact owner field survives pruning and is inherited by copies;
/// a later copy/consumer cannot retroactively establish an earlier byte identity.
pub(crate) fn freeze_tool_media(
    connection: &rusqlite::Connection,
    event: &maka_agent_facts::event::RuntimeEvent,
    sequence: u64,
) -> Result<(), StoreError> {
    use maka_agent_facts::attachment::StorageRef;
    use maka_agent_facts::event::Fact;
    use maka_agent_facts::event::ToolOutcome;
    use maka_agent_facts::tool_output::DurableToolProjection;
    let Fact::ToolSettled {
        outcome:
            ToolOutcome::Succeeded {
                model_projection: DurableToolProjection::Content { parts },
                ..
            },
        ..
    } = &event.fact
    else {
        return Ok(());
    };
    for part in parts {
        let Some((
            StorageRef::SessionFile {
                session_id,
                relative_path,
            },
            _,
        )) = part.media()
        else {
            continue;
        };
        if session_id != &event.invocation.session_id {
            continue;
        }
        connection.prepare_cached("UPDATE artifacts SET canonical_at=COALESCE(canonical_at, ?) WHERE session_id=? AND id=?")?.execute(rusqlite::params![sequence as i64, session_id, relative_path])?;
        // Unavailable borrowed media does not revoke the successful effect or
        // its exact raw result. No freeze/read grant is created for a missing
        // artifact; replay already renders unavailable media explicitly.
    }
    Ok(())
}
