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
use rusqlite::OptionalExtension;

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
        for id in [session, source_session, source_artifact] {
            crate::sessions::validate_id(id)?;
        }
        let (session, source_session, source_artifact) = (
            session.to_owned(),
            source_session.to_owned(),
            source_artifact.to_owned(),
        );
        self.connection
            .read(move |connection| {
                resolve(connection, &session, &source_session, &source_artifact)
            })
            .await
    }
}

pub(crate) fn resolve(
    connection: &rusqlite::Connection,
    session: &str,
    source_session: &str,
    source_artifact: &str,
) -> Result<Option<StorageRef>, StoreError> {
    let id: Option<String> = connection
        .prepare_cached(RESOLVE_SQL)?
        .query_row(
            rusqlite::params![session, source_session, source_artifact],
            |row| row.get(0),
        )
        .optional()?;
    Ok(id.map(|relative_path| StorageRef::SessionFile {
        session_id: session.into(),
        relative_path,
    }))
}

/// Only typed canonical references convey resource ownership. Never interpret
/// plugin JSON or strings containing an attachment URI as an access grant.
pub(crate) fn retain(
    tx: &rusqlite::Connection,
    source: &str,
    target: &str,
    now: u64,
) -> Result<(), StoreError> {
    let mut after = 0_i64;
    loop {
        let row = tx.prepare_cached(&(format!(
            "SELECT e.sequence, e.event_header,{} FROM session_history_members h
             JOIN runtime_events e ON e.sequence = h.sequence {}
             WHERE h.session_id = ? AND e.sequence > ?
               AND (e.kind IN ('message_steered', 'tool_settled') OR
                    (e.kind = 'invocation_opened' AND json_extract(e.event_header,'$.fact.input.kind') = 'message'))
             ORDER BY e.sequence LIMIT 1",
            crate::canonical::COLUMNS, crate::canonical::JOINS
        )))?.query_row(rusqlite::params![target, after], |row| Ok((row.get::<_,i64>("sequence")?, crate::canonical::json(row).map(|v|v.into_owned())))).optional()?;
        let Some((sequence, json)) = row else { break };
        let event: RuntimeEvent = serde_json::from_str(&json?)?;
        for (reference, attachment) in super::references::from_event(&event) {
            retain_one(tx, source, target, reference, attachment, now)?;
        }
        after = sequence;
    }
    Ok(())
}

pub(crate) fn retain_revision(
    tx: &rusqlite::Connection,
    source: &str,
    target: &str,
    now: u64,
) -> Result<(), StoreError> {
    let mut after = 0_i64;
    loop {
        let row = tx
            .prepare_cached(
                &(format!(
                    "SELECT e.sequence, e.event_header,{} FROM session_revision_sources s
             JOIN runtime_events e ON e.sequence=s.sequence {}
             WHERE s.session_id=? AND s.sequence>? ORDER BY s.sequence LIMIT 1",
                    crate::canonical::COLUMNS,
                    crate::canonical::JOINS
                )),
            )?
            .query_row(rusqlite::params![target, after], |row| {
                Ok((
                    row.get::<_, i64>("sequence")?,
                    crate::canonical::json(row).map(|v| v.into_owned()),
                ))
            })
            .optional()?;
        let Some((sequence, json)) = row else { break };
        let event: RuntimeEvent = serde_json::from_str(&json?)?;
        for attachment in super::references::revision(&event)? {
            retain_one(
                tx,
                source,
                target,
                &attachment.storage_ref,
                Some(attachment),
                now,
            )?;
        }
        after = sequence;
    }
    Ok(())
}

fn retain_one(
    tx: &rusqlite::Connection,
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
    let existing: Option<String> = tx
        .prepare_cached(
            "SELECT artifact_id FROM session_history_artifacts
         WHERE session_id = ? AND source_session_id = ? AND source_artifact_id = ?",
        )?
        .query_row(
            rusqlite::params![target, session_id, relative_path],
            |row| row.get(0),
        )
        .optional()?;
    if existing.is_some() {
        return Ok(());
    }
    let source_id = if session_id == source {
        relative_path.clone()
    } else {
        tx.prepare_cached(
            "SELECT artifact_id FROM session_history_artifacts
             WHERE session_id = ? AND source_session_id = ? AND source_artifact_id = ?",
        )?
        .query_row(
            rusqlite::params![source, session_id, relative_path],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| invalid("history artifact is outside source ownership"))?
    };
    let (mut artifact, digest) = read_record(tx, source, &source_id)?
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
    let copied = tx.prepare_cached("INSERT INTO artifacts (session_id, id, created_at, record_json, content_sha256, canonical_at, lookup_digest)
         SELECT ?3, ?4, ?5, ?6, content_sha256, canonical_at, ?8 FROM artifacts JOIN contents USING(content_sha256)
         WHERE session_id = ?1 AND artifacts.id = ?2 AND length(payload) = ?7")?.execute(rusqlite::params![source, &source_id, target, &id, now as i64, metadata, artifact.size_bytes as i64, super::identity::artifact_lookup_digest(target, &id).as_slice()])?;
    if copied != 1 {
        return Err(StoreError::ArtifactConflict);
    }
    tx.prepare_cached("INSERT INTO session_history_artifacts (session_id,source_session_id,source_artifact_id,artifact_id,lookup_digest,target_digest) VALUES (?, ?, ?, ?, ?, ?)")?.execute(rusqlite::params![target, session_id, relative_path, &id, super::identity::history_lookup_digest(target, session_id, relative_path).as_slice(), super::identity::artifact_lookup_digest(target, &id).as_slice()])?;
    advance(tx, target)
}
