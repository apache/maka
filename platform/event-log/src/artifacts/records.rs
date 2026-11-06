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

use crate::StoreError;
use maka_agent_facts::artifact::Artifact;
use maka_agent_facts::artifact::content_digest;
use maka_agent_facts::interaction::entity_id;
use rusqlite::OptionalExtension;

pub(super) fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.to_owned())
}

pub(super) fn ids(session: &str, artifact: Option<&str>) -> Result<(), StoreError> {
    entity_id(session).map_err(invalid)?;
    if let Some(id) = artifact {
        entity_id(id).map_err(invalid)?;
    }
    Ok(())
}

pub(super) fn require_session(
    connection: &rusqlite::Connection,
    id: &str,
) -> Result<(), StoreError> {
    let exists: bool = connection
        .prepare_cached("SELECT EXISTS(SELECT 1 FROM session_control WHERE id = ?)")?
        .query_row(rusqlite::params![id], |row| row.get(0))?;
    if !exists {
        return Err(StoreError::SessionNotFound);
    }
    Ok(())
}

pub(super) fn decode(
    raw: &str,
    session_id: &str,
    artifact_id: &str,
) -> Result<Artifact, StoreError> {
    let artifact: Artifact = serde_json::from_str(raw)?;
    artifact.validate().map_err(invalid)?;
    if artifact.session_id != session_id || artifact.id != artifact_id {
        return Err(invalid("Stored artifact identity mismatch"));
    }
    Ok(artifact)
}

pub(super) fn read_record(
    connection: &rusqlite::Connection,
    session_id: &str,
    artifact_id: &str,
) -> Result<Option<(Artifact, String)>, StoreError> {
    let row: Option<(Option<String>, Option<String>)> = connection
        .prepare_cached(
            "SELECT record_json,
         CASE WHEN length(CAST(content_sha256 AS BLOB)) = 71 THEN content_sha256 END
         FROM artifacts WHERE session_id = ? AND id = ?",
        )?
        .query_row(rusqlite::params![session_id, artifact_id], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .optional()?;
    row.map(|(raw, digest)| {
        let raw = raw.ok_or_else(|| invalid("Stored artifact metadata is missing"))?;
        let digest = digest.ok_or_else(|| invalid("Stored artifact digest exceeds limit"))?;
        Ok((decode(&raw, session_id, artifact_id)?, digest))
    })
    .transpose()
}

pub(super) fn revision(
    connection: &rusqlite::Connection,
    session_id: &str,
) -> Result<String, StoreError> {
    let counter: Option<i64> = connection
        .prepare_cached("SELECT revision FROM artifact_catalog WHERE session_id = ?")?
        .query_row(rusqlite::params![session_id], |row| row.get(0))
        .optional()?;
    Ok(content_digest(
        format!("artifact-catalog:{session_id}:{}", counter.unwrap_or(0)).as_bytes(),
    ))
}

pub(super) fn advance(
    connection: &rusqlite::Connection,
    session_id: &str,
) -> Result<(), StoreError> {
    let changed = connection.prepare_cached("INSERT INTO artifact_catalog (session_id, revision) VALUES (?, 1)
        ON CONFLICT(session_id) DO UPDATE SET revision = revision + 1 WHERE revision < 9007199254740991")?.execute(rusqlite::params![session_id])?;
    if changed != 1 {
        return Err(invalid("Artifact revision exhausted"));
    }
    Ok(())
}
