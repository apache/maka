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

use super::{
    Inventory,
    closure::Closure,
    format::{Blob, CHUNK, Record, Writer},
};
use crate::{StoreError, sequence_number};
use sha2::{Digest, Sha256};
use sqlx::SqliteConnection;
use tokio::io::AsyncWrite;

pub(super) async fn export<W: AsyncWrite + Unpin>(
    db: &mut SqliteConnection,
    inventory: &Inventory,
    closure: &Closure,
    writer: &mut Writer<W>,
) -> Result<(), StoreError> {
    for sequence in &closure.events {
        let tool: Option<(String, i64, Option<String>, Option<i64>)> = sqlx::query_as(
            "SELECT e.event_id,length(p.payload),json_extract(e.event_json,'$.fact.outcome.raw.digest'),
                json_extract(e.event_json,'$.fact.outcome.raw.bytes')
             FROM runtime_events e JOIN tool_result_payloads p ON p.event_id=e.event_id WHERE e.sequence=?"
        ).bind(*sequence as i64).fetch_optional(&mut *db).await?;
        if let Some((event_id, bytes, digest, expected_bytes)) = tool {
            if expected_bytes != Some(bytes) {
                return Err(invalid("tool payload length changed"));
            }
            let blob = Blob::ToolResult {
                event_id,
                bytes: sequence_number(bytes)?,
                digest: digest.ok_or_else(|| invalid("unbound tool payload"))?,
            };
            transfer(db, blob, writer).await?;
        }
        let composition: Option<(String, String, i64)> = sqlx::query_as(
            "SELECT e.event_id,c.digest,length(c.surface) FROM runtime_events e
             JOIN model_request_compositions r ON r.event_id=e.event_id
             JOIN request_compositions c ON c.digest=r.digest WHERE e.sequence=?",
        )
        .bind(*sequence as i64)
        .fetch_optional(&mut *db)
        .await?;
        if let Some((event_id, digest, bytes)) = composition {
            transfer(
                db,
                Blob::Composition {
                    event_id,
                    bytes: sequence_number(bytes)?,
                    digest,
                },
                writer,
            )
            .await?;
        }
    }
    for session in &inventory.sessions {
        required(db, &session.id).await?;
        let mut after = None::<String>;
        loop {
            let next: Option<(String, String, String, i64)> = sqlx::query_as(
                "SELECT id,record_json,artifacts.content_sha256,length(payload) FROM artifacts JOIN artifact_contents USING(content_sha256)
                 WHERE session_id=?1 AND (?2 IS NULL OR id>?2) ORDER BY id LIMIT 1",
            )
            .bind(&session.id)
            .bind(&after)
            .fetch_optional(&mut *db)
            .await?;
            let Some((id, json, digest, bytes)) = next else {
                break;
            };
            let metadata: maka_agent_facts::artifact::Artifact = serde_json::from_str(&json)?;
            metadata.validate().map_err(invalid)?;
            if metadata.session_id != session.id
                || metadata.id != id
                || metadata.size_bytes != sequence_number(bytes)?
            {
                return Err(invalid("artifact metadata differs from stored bytes"));
            }
            let frozen_at = frozen_witness(db, &metadata).await?;
            if frozen_at.is_some_and(|sequence| !closure.events.contains(&sequence)) {
                return Err(invalid(
                    "bundle media witness is outside its selected history",
                ));
            }
            transfer(
                db,
                Blob::Artifact {
                    metadata,
                    digest,
                    frozen_at,
                },
                writer,
            )
            .await?;
            after = Some(id);
        }
        let mut after = None::<(String, String)>;
        loop {
            let next: Option<(String,String,String)> = sqlx::query_as(
                "SELECT source_session_id,source_artifact_id,artifact_id FROM session_history_artifacts
                 WHERE session_id=?1 AND (?2 IS NULL OR (source_session_id,source_artifact_id)>(?2,?3))
                 ORDER BY source_session_id,source_artifact_id LIMIT 1"
            ).bind(&session.id).bind(after.as_ref().map(|key| &key.0)).bind(after.as_ref().map(|key| &key.1))
                .fetch_optional(&mut *db).await?;
            let Some((source_session, source_artifact, artifact)) = next else {
                break;
            };
            after = Some((source_session.clone(), source_artifact.clone()));
            writer
                .record(&Record::HistoryArtifact {
                    session: session.id.clone(),
                    source_session,
                    source_artifact,
                    artifact,
                })
                .await?;
        }
    }
    Ok(())
}

/// An earlier source freeze need not be in a partial copied history. Export the
/// first consumption in this owner's selected history at which those same bytes
/// were already frozen, without bringing in another Session's private history.
async fn frozen_witness(
    db: &mut SqliteConnection,
    metadata: &maka_agent_facts::artifact::Artifact,
) -> Result<Option<u64>, StoreError> {
    let Some(mime) = metadata.mime_type.as_deref() else {
        return Ok(None);
    };
    let kind = if mime.starts_with("image/") {
        maka_agent_facts::artifact::ArtifactKind::Image
    } else {
        maka_agent_facts::artifact::ArtifactKind::File
    };
    if metadata.kind != kind {
        return Ok(None);
    }
    let sequence: Option<i64> = sqlx::query_scalar(
        "WITH media AS (
            SELECT e.sequence,e.inherited,
                CASE json_extract(p.value,'$.kind')
                    WHEN 'artifact' THEN json_extract(p.value,'$.image')
                    WHEN 'audio' THEN json_extract(p.value,'$.audio') END AS value
            FROM session_history_events e
            JOIN json_each(e.event_json,'$.fact.outcome.model_projection.parts') p
            JOIN artifacts a ON a.session_id=?1 AND a.id=?2
            WHERE e.owner_session_id=?1 AND e.kind='tool_settled'
                AND json_extract(e.event_json,'$.fact.outcome.kind')='succeeded'
                AND json_extract(e.event_json,'$.fact.outcome.model_projection.kind')='content'
                AND a.canonical_at>0 AND a.canonical_at<=e.sequence)
         SELECT MIN(sequence) FROM media
         WHERE json_extract(value,'$.ref.kind')='session_file'
           AND json_extract(value,'$.mimeType')=?3
           AND ((inherited=0 AND json_extract(value,'$.ref.sessionId')=?1
                AND json_extract(value,'$.ref.relativePath')=?2)
             OR (inherited=1 AND EXISTS(
                SELECT 1 FROM session_history_artifacts h WHERE h.session_id=?1 AND h.artifact_id=?2
                  AND h.source_session_id=json_extract(value,'$.ref.sessionId')
                  AND h.source_artifact_id=json_extract(value,'$.ref.relativePath'))))",
    )
    .bind(&metadata.session_id)
    .bind(&metadata.id)
    .bind(&metadata.mime_type)
    .fetch_one(db)
    .await?;
    sequence.map(sequence_number).transpose()
}

async fn required(db: &mut SqliteConnection, session: &str) -> Result<(), StoreError> {
    // Copied evidence resolves through destination-owned material, never through
    // a live lookup into an ancestor's artifact namespace.
    let broken: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM session_history_events e
         JOIN json_each(e.event_json,'$.fact.outcome.artifacts') proof
         LEFT JOIN session_history_artifacts h ON h.session_id=e.owner_session_id
           AND h.source_session_id=e.event_session AND h.source_artifact_id=json_extract(proof.value,'$.id')
         LEFT JOIN artifacts a ON a.session_id=e.owner_session_id AND
           a.id=CASE WHEN e.inherited=1 THEN h.artifact_id ELSE json_extract(proof.value,'$.id') END
         LEFT JOIN artifact_contents c ON c.content_sha256=a.content_sha256
         WHERE e.owner_session_id=? AND e.kind='tool_settled' AND
           (a.id IS NULL OR c.content_sha256 IS NULL OR length(c.payload)!=json_extract(proof.value,'$.bytes')
            OR a.content_sha256!=json_extract(proof.value,'$.digest')
            OR json_extract(a.record_json,'$.source')!='tool_result_projection'
            OR json_extract(a.record_json,'$.turnId')!=json_extract(e.event_json,'$.invocation.turn_id')))"
    ).bind(session).fetch_one(db).await?;
    if broken {
        return Err(invalid("bundle lacks generated tool material"));
    }
    Ok(())
}

async fn transfer<W: AsyncWrite + Unpin>(
    db: &mut SqliteConnection,
    blob: Blob,
    writer: &mut Writer<W>,
) -> Result<(), StoreError> {
    let length = blob.bytes();
    let mut offset = 0;
    let mut hash = Sha256::new();
    writer.record(&Record::Blob(blob.clone())).await?;
    while offset < length {
        let size = (length - offset).min(CHUNK as u64) as i64;
        let start = (offset + 1) as i64;
        let bytes: Vec<u8> = match &blob {
            Blob::ToolResult { event_id, .. } => {
                sqlx::query_scalar(
                    "SELECT substr(payload,?2,?3) FROM tool_result_payloads WHERE event_id=?1",
                )
                .bind(event_id)
                .bind(start)
                .bind(size)
                .fetch_one(&mut *db)
                .await?
            }
            Blob::Composition { digest, .. } => {
                sqlx::query_scalar(
                    "SELECT substr(surface,?2,?3) FROM request_compositions WHERE digest=?1",
                )
                .bind(digest)
                .bind(start)
                .bind(size)
                .fetch_one(&mut *db)
                .await?
            }
            Blob::Artifact { metadata, .. } => {
                sqlx::query_scalar(
                    "SELECT substr(payload,?3,?4) FROM artifacts JOIN artifact_contents USING(content_sha256) WHERE session_id=?1 AND id=?2",
                )
                .bind(&metadata.session_id)
                .bind(&metadata.id)
                .bind(start)
                .bind(size)
                .fetch_one(&mut *db)
                .await?
            }
        };
        if bytes.len() != size as usize {
            return Err(invalid("bundle payload disappeared"));
        }
        hash.update(&bytes);
        writer.bytes(&bytes).await?;
        offset += bytes.len() as u64;
    }
    if format!("sha256:{}", hex::encode(hash.finalize())) != blob.digest() {
        return Err(invalid("bundle payload digest mismatch"));
    }
    Ok(())
}

fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}
