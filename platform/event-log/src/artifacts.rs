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
use sqlx::Connection;

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
        self.validate_root()?;
        self.check_bound_session(&artifact.session_id)?;
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
                    // The job retains the payload owner, including any memory reservation,
                    // independently of its caller. Hashing runs on the database thread.
                    let artifact = commit_in_transaction(&mut tx, artifact, bytes.as_ref()).await?;
                    tx.commit().await.map_err(StoreError::CommitUnknown)?;
                    Ok(artifact)
                })
            })
            .await
    }

    /// Runtime-owned evidence cannot be deleted independently of its workflow.
    pub async fn delete_user_artifact(
        &self,
        session_id: &str,
        artifact_id: &str,
    ) -> Result<ArtifactDeletion, StoreError> {
        self.validate_root()?;
        records::ids(session_id, Some(artifact_id))?;
        let (session_id, artifact_id) = (session_id.to_owned(), artifact_id.to_owned());
        let commits = self.commits.notice();
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
                    require_session(&mut tx, &session_id).await?;
                    let Some((artifact, _)) =
                        read_record(&mut tx, &session_id, &artifact_id).await?
                    else {
                        return Ok(ArtifactDeletion::NotFound);
                    };
                    let retained: bool = sqlx::query_scalar(
                        "SELECT EXISTS(SELECT 1 FROM session_history_artifacts WHERE session_id = ? AND artifact_id = ?)",
                    ).bind(&session_id).bind(&artifact_id).fetch_one(&mut *tx).await?;
                    if !artifact.source.user_deletable() || retained
                        || sqlx::query_scalar::<_, bool>("SELECT canonical_at IS NOT NULL FROM artifacts WHERE session_id = ? AND id = ?")
                            .bind(&session_id).bind(&artifact_id).fetch_one(&mut *tx).await?
                    {
                        return Ok(ArtifactDeletion::Protected);
                    }
                    sqlx::query("DELETE FROM artifacts WHERE session_id = ? AND id = ?")
                        .bind(&session_id)
                        .bind(&artifact_id)
                        .execute(&mut *tx)
                        .await?;
                    advance(&mut tx, &session_id).await?;
                    tx.commit().await.map_err(StoreError::CommitUnknown)?;
                    commits.material_released();
                    Ok(ArtifactDeletion::Deleted)
                })
            })
            .await
    }
}

/// Shared immutable artifact write; the caller owns the enclosing transaction.
pub(crate) async fn commit_in_transaction(
    connection: &mut sqlx::SqliteConnection,
    mut artifact: Artifact,
    bytes: &[u8],
) -> Result<Artifact, StoreError> {
    let digest = content_digest(bytes);
    let encoded = validate_material(&artifact, bytes.len() as u64, &digest)?;
    require_session(connection, &artifact.session_id).await?;
    if let Some((existing, stored_digest)) =
        read_record(connection, &artifact.session_id, &artifact.id).await?
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
        verify_payload(connection, &artifact, bytes).await?;
        return Ok(existing);
    }
    store_content(connection, &digest, bytes).await?;
    sqlx::query(
        "INSERT INTO artifacts (session_id, id, created_at, record_json, content_sha256, lookup_digest)
        VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&artifact.session_id)
    .bind(&artifact.id)
    .bind(artifact.created_at as i64)
    .bind(encoded)
    .bind(digest)
    .bind(identity::artifact_lookup_digest(&artifact.session_id, &artifact.id).as_slice())
    .execute(&mut *connection)
    .await?;
    advance(connection, &artifact.session_id).await?;
    Ok(artifact)
}

// The caller's transaction publishes content and its Session reference together.
// Hash equality selects a candidate; exact bytes still decide whether it is reusable.
async fn store_content(
    connection: &mut sqlx::SqliteConnection,
    digest: &str,
    bytes: &[u8],
) -> Result<(), StoreError> {
    let inserted = sqlx::query("INSERT INTO artifact_contents(content_sha256,payload) VALUES (?,?) ON CONFLICT(content_sha256) DO NOTHING")
        .bind(digest).bind(bytes).execute(&mut *connection).await?.rows_affected();
    if inserted == 0
        && !sqlx::query_scalar::<_, bool>(
            "SELECT payload=? FROM artifact_contents WHERE content_sha256=?",
        )
        .bind(bytes)
        .bind(digest)
        .fetch_one(connection)
        .await?
    {
        return Err(StoreError::ArtifactConflict);
    }
    Ok(())
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

pub(crate) async fn verify_projection_replay(
    connection: &mut sqlx::SqliteConnection,
    artifact: &Artifact,
    bytes: &[u8],
) -> Result<(), StoreError> {
    let Some((existing, digest)) =
        read_record(connection, &artifact.session_id, &artifact.id).await?
    else {
        return Err(StoreError::EventConflict);
    };
    if &existing != artifact || digest != content_digest(bytes) {
        return Err(StoreError::EventConflict);
    }
    verify_payload(connection, artifact, bytes).await
}

async fn verify_payload(
    connection: &mut sqlx::SqliteConnection,
    artifact: &Artifact,
    bytes: &[u8],
) -> Result<(), StoreError> {
    let matches: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM artifacts JOIN artifact_contents USING(content_sha256) WHERE session_id = ? AND id = ? AND payload = ?)",
    )
    .bind(&artifact.session_id)
    .bind(&artifact.id)
    .bind(bytes)
    .fetch_one(connection)
    .await?;
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

pub(crate) async fn read_image(
    connection: &mut sqlx::SqliteConnection,
    session: &str,
    id: &str,
    mime: &str,
    offset: u64,
    limit: usize,
    row_event: u64,
) -> Result<ImageChunk, StoreError> {
    records::ids(session, Some(id))?;
    require_session(connection, session).await?;
    let (artifact, digest) = read_record(connection, session, id)
        .await?
        .ok_or_else(|| invalid("tool image artifact not found"))?;
    let canonical_at: Option<i64> =
        sqlx::query_scalar("SELECT canonical_at FROM artifacts WHERE session_id = ? AND id = ?")
            .bind(session)
            .bind(id)
            .fetch_one(&mut *connection)
            .await?;
    if !canonical_at.is_some_and(|at| at > 0 && at as u64 <= row_event) {
        return Err(invalid(
            "tool image bytes were not frozen at their canonical row",
        ));
    }
    image_chunk(connection, &artifact, digest, mime, offset, limit).await
}

pub(crate) async fn read_attachment_image(
    connection: &mut sqlx::SqliteConnection,
    session: &str,
    id: &str,
    attachment: Option<&maka_agent_facts::attachment::AttachmentRef>,
    offset: u64,
    limit: usize,
) -> Result<ImageChunk, StoreError> {
    records::ids(session, Some(id))?;
    require_session(connection, session).await?;
    let (artifact, digest) = read_record(connection, session, id)
        .await?
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
    image_chunk(connection, &artifact, digest, mime, offset, limit).await
}

async fn image_chunk(
    connection: &mut sqlx::SqliteConnection,
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
    let (total, bytes): (i64, Vec<u8>) = sqlx::query_as(
        "SELECT length(payload), substr(payload, ?, ?) FROM artifacts JOIN artifact_contents USING(content_sha256) WHERE session_id = ? AND id = ?"
    ).bind(offset as i64 + 1).bind(limit as i64).bind(&artifact.session_id).bind(&artifact.id).fetch_one(&mut *connection).await?;
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
pub(crate) async fn freeze_tool_media(
    connection: &mut sqlx::SqliteConnection,
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
        sqlx::query("UPDATE artifacts SET canonical_at=COALESCE(canonical_at, ?) WHERE session_id=? AND id=?")
            .bind(sequence as i64).bind(session_id).bind(relative_path).execute(&mut *connection).await?;
        // Unavailable borrowed media does not revoke the successful effect or
        // its exact raw result. No freeze/read grant is created for a missing
        // artifact; replay already renders unavailable media explicitly.
    }
    Ok(())
}
