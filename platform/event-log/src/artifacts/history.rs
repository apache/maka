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

use super::records::{advance, invalid, read_record};
use crate::StoreError;
use maka_agent_facts::attachment::AttachmentRef;
use maka_agent_facts::attachment::StorageRef;
use maka_agent_facts::event::RuntimeEvent;
use sqlx::SqliteConnection;

pub(crate) const RESOLVE_SQL: &str = r#"SELECT h.artifact_id FROM session_history_artifacts h
         JOIN artifacts a ON a.session_id=h.session_id AND a.id=h.artifact_id
         WHERE h.session_id=? AND h.source_session_id=? AND h.source_artifact_id=?"#;

impl crate::EventLog {
    /// Resolve original provenance only through this Session's immutable copy
    /// ownership. Knowing a source Session or Artifact ID grants no access.
    pub async fn resolve_history_artifact(
        &self,
        session: &str,
        source_session: &str,
        source_artifact: &str,
    ) -> Result<Option<StorageRef>, StoreError> {
        self.validate_root()?;
        for id in [session, source_session, source_artifact] {
            crate::sessions::validate_id(id)?;
        }
        let (session, source_session, source_artifact) = (
            session.to_owned(),
            source_session.to_owned(),
            source_artifact.to_owned(),
        );
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    resolve(connection, &session, &source_session, &source_artifact).await
                })
            })
            .await
    }
}

pub(crate) async fn resolve(
    connection: &mut SqliteConnection,
    session: &str,
    source_session: &str,
    source_artifact: &str,
) -> Result<Option<StorageRef>, StoreError> {
    let id: Option<String> = sqlx::query_scalar(RESOLVE_SQL)
        .bind(session)
        .bind(source_session)
        .bind(source_artifact)
        .fetch_optional(connection)
        .await?;
    Ok(id.map(|relative_path| StorageRef::SessionFile {
        session_id: session.into(),
        relative_path,
    }))
}

/// Only typed canonical references convey resource ownership. Never interpret
/// plugin JSON or strings containing an attachment URI as an access grant.
pub(crate) async fn retain(
    tx: &mut SqliteConnection,
    source: &str,
    target: &str,
    now: u64,
) -> Result<(), StoreError> {
    let mut after = 0_i64;
    loop {
        let row: Option<(i64, String)> = sqlx::query_as(
            "SELECT e.sequence, e.event_json FROM session_history_members h
             JOIN runtime_events e ON e.sequence = h.sequence
             WHERE h.session_id = ? AND e.sequence > ?
               AND (e.kind IN ('message_steered', 'tool_settled') OR
                    (e.kind = 'invocation_opened' AND json_extract(e.event_json,'$.fact.input.kind') = 'message'))
             ORDER BY e.sequence LIMIT 1",
        ).bind(target).bind(after).fetch_optional(&mut *tx).await?;
        let Some((sequence, json)) = row else { break };
        let event: RuntimeEvent = serde_json::from_str(&json)?;
        for (reference, attachment) in super::references::from_event(&event) {
            retain_one(tx, source, target, reference, attachment, now).await?;
        }
        after = sequence;
    }
    Ok(())
}

pub(crate) async fn retain_revision(
    tx: &mut SqliteConnection,
    source: &str,
    target: &str,
    now: u64,
) -> Result<(), StoreError> {
    let mut after = 0_i64;
    loop {
        let row: Option<(i64, String)> = sqlx::query_as(
            "SELECT e.sequence, e.event_json FROM session_revision_sources s
             JOIN runtime_events e ON e.sequence=s.sequence
             WHERE s.session_id=? AND s.sequence>? ORDER BY s.sequence LIMIT 1",
        )
        .bind(target)
        .bind(after)
        .fetch_optional(&mut *tx)
        .await?;
        let Some((sequence, json)) = row else { break };
        let event: RuntimeEvent = serde_json::from_str(&json)?;
        for attachment in super::references::revision(&event)? {
            retain_one(
                tx,
                source,
                target,
                &attachment.storage_ref,
                Some(attachment),
                now,
            )
            .await?;
        }
        after = sequence;
    }
    Ok(())
}

async fn retain_one(
    tx: &mut SqliteConnection,
    source: &str,
    target: &str,
    reference: &StorageRef,
    attachment: Option<&AttachmentRef>,
    now: u64,
) -> Result<(), StoreError> {
    let StorageRef::SessionFile {
        session_id,
        relative_path,
    } = reference
    else {
        // Workspace/external references are observations, not owned files.
        // Session context is immutable canonical evidence, not an Artifact.
        return Ok(());
    };
    let existing: Option<String> = sqlx::query_scalar(
        "SELECT artifact_id FROM session_history_artifacts
         WHERE session_id = ? AND source_session_id = ? AND source_artifact_id = ?",
    )
    .bind(target)
    .bind(session_id)
    .bind(relative_path)
    .fetch_optional(&mut *tx)
    .await?;
    if existing.is_some() {
        return Ok(());
    }
    let source_id = if session_id == source {
        relative_path.clone()
    } else {
        sqlx::query_scalar(
            "SELECT artifact_id FROM session_history_artifacts
             WHERE session_id = ? AND source_session_id = ? AND source_artifact_id = ?",
        )
        .bind(source)
        .bind(session_id)
        .bind(relative_path)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| invalid("history artifact is outside source ownership"))?
    };
    let (mut artifact, digest) = read_record(tx, source, &source_id)
        .await?
        .ok_or_else(|| invalid("history artifact no longer exists"))?;
    if let Some(attachment) = attachment {
        artifact.validate_attachment(attachment).map_err(invalid)?;
    }
    if artifact.source == maka_agent_facts::artifact::ArtifactSource::UserUpload
        && artifact.summary.as_ref() != Some(&digest)
    {
        return Err(StoreError::ArtifactConflict);
    }
    let id = maka_agent_facts::artifact::content_digest(&serde_json::to_vec(&(
        session_id,
        relative_path,
    ))?);
    let id = format!("history-{}", id.trim_start_matches("sha256:"));
    artifact.id = id.clone();
    artifact.session_id = target.into();
    artifact.created_at = now;
    artifact.validate().map_err(invalid)?;
    let metadata = serde_json::to_string(&artifact)?;
    let copied = sqlx::query(
        "INSERT INTO artifacts (session_id, id, created_at, record_json, content_sha256, payload, canonical_at, lookup_digest)
         SELECT ?3, ?4, ?5, ?6, content_sha256, payload, canonical_at, ?8 FROM artifacts
         WHERE session_id = ?1 AND id = ?2 AND length(payload) = ?7",
    )
    .bind(source)
    .bind(&source_id)
    .bind(target)
    .bind(&id)
    .bind(now as i64)
    .bind(metadata)
    .bind(artifact.size_bytes as i64)
    .bind(super::identity::artifact_lookup_digest(target, &id).as_slice())
    .execute(&mut *tx)
    .await?;
    if copied.rows_affected() != 1 {
        return Err(StoreError::ArtifactConflict);
    }
    sqlx::query("INSERT INTO session_history_artifacts (session_id,source_session_id,source_artifact_id,artifact_id,lookup_digest,target_digest) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(target)
        .bind(session_id)
        .bind(relative_path)
        .bind(&id)
        .bind(super::identity::history_lookup_digest(target, session_id, relative_path).as_slice())
        .bind(super::identity::artifact_lookup_digest(target, &id).as_slice())
        .execute(&mut *tx)
        .await?;
    advance(tx, target).await
}
