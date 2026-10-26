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

use super::{ArchiveError, target};
use crate::{
    EventLog, StoreError,
    context::{ArchivedToolResult, read, selection::Selection},
    sequence_number,
};
use maka_agent_facts::archive::ArchiveIdentity;
use maka_agent_facts::archive::ArchivedPlaceholder;
use maka_agent_facts::archive::encode_projection;
use maka_agent_facts::archive::projection_digest;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::RuntimeEvent;
use sha2::{Digest, Sha256};
use sqlx::{Connection, SqliteConnection};

pub(super) fn validate(
    target: &target::Target,
    placeholder: &ArchivedPlaceholder,
) -> Result<Vec<u8>, StoreError> {
    placeholder.validate().map_err(|_| ArchiveError::Corrupt)?;
    target
        .projection
        .validate(&target.invocation.session_id)
        .map_err(|_| ArchiveError::Corrupt)?;
    let identity = &placeholder.identity;
    if identity.runtime_event_id != target.event_id
        || identity.tool_call_id != target.call.tool_call_id
        || identity.tool_name != target.name
    {
        return Err(ArchiveError::SourceMismatch.into());
    }
    let body = encode_projection(&target.projection).map_err(|_| ArchiveError::Corrupt)?;
    if body.len() as u64 != identity.original_bytes {
        return Err(ArchiveError::SizeMismatch.into());
    }
    if projection_digest(&target.projection).map_err(|_| ArchiveError::Corrupt)?
        != identity.source_projection_digest
        || hex::encode(Sha256::digest(&body)) != identity.body_sha256
    {
        return Err(ArchiveError::Corrupt.into());
    }
    let expected = ArchivedPlaceholder::prepare(
        target.event_id.clone(),
        target.call.tool_call_id.clone(),
        target.name.clone(),
        &target.projection,
    )
    .map_err(|_| ArchiveError::Corrupt)?
    .ok_or(ArchiveError::Corrupt)?;
    if expected != *placeholder {
        return Err(ArchiveError::Corrupt.into());
    }
    Ok(body)
}

pub(crate) async fn validate_append(
    connection: &mut SqliteConnection,
    event: &RuntimeEvent,
) -> Result<(), StoreError> {
    let Fact::ToolResultArchived { placeholder } = &event.fact else {
        return Ok(());
    };
    let target = target::read(
        connection,
        &event.invocation.session_id,
        &placeholder.identity.runtime_event_id,
    )
    .await?
    .ok_or(ArchiveError::SourceMismatch)?;
    validate(&target, placeholder)?;
    if selected(connection, &event.invocation.session_id, &target.event_id)
        .await?
        .is_some()
    {
        return Err(StoreError::EventConflict);
    }
    let selection = Selection::for_invocation(connection, &event.invocation).await?;
    validate_selection(connection, &selection, &target.event_id).await?;
    let baseline = read::latest_selected(connection, &selection, i64::MAX as u64).await?;
    if baseline
        .as_ref()
        .is_some_and(|b| target.sequence <= b.checkpoint.covered_through)
    {
        return Err(StoreError::InvalidTransition(
            "archive target is already covered by a checkpoint".into(),
        ));
    }
    Ok(())
}

pub(crate) async fn verify_replay(
    connection: &mut SqliteConnection,
    event: &RuntimeEvent,
) -> Result<(), StoreError> {
    if let Fact::ToolResultArchived { placeholder } = &event.fact {
        let (_, accepted) = find(
            connection,
            &event.invocation.session_id,
            &placeholder.identity.runtime_event_id,
            i64::MAX as u64,
        )
        .await?
        .ok_or(ArchiveError::Corrupt)?;
        if accepted != *placeholder {
            return Err(StoreError::EventConflict);
        }
    }
    Ok(())
}

pub(crate) async fn find(
    connection: &mut SqliteConnection,
    session: &str,
    target_id: &str,
    before: u64,
) -> Result<Option<(u64, ArchivedPlaceholder)>, StoreError> {
    let row: Option<(i64, String)> = sqlx::query_as(
        "SELECT sequence,placeholder_json FROM context_archive_records
        WHERE session_id=? AND target_event_id=? AND sequence<?",
    )
    .bind(session)
    .bind(target_id)
    .bind(before as i64)
    .fetch_optional(connection)
    .await?;
    row.map(|(sequence, json)| Ok((sequence_number(sequence)?, serde_json::from_str(&json)?)))
        .transpose()
}

async fn validate_selection(
    connection: &mut SqliteConnection,
    selection: &Selection,
    event_id: &str,
) -> Result<(), StoreError> {
    let filter = Selection::predicate("t", "?2");
    let visible: bool = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT EXISTS(SELECT 1 FROM runtime_events t WHERE t.event_id=?1 AND {filter})"
    )))
    .bind(event_id)
    .bind(&selection.lineage)
    .fetch_one(connection)
    .await?;
    if !visible {
        return Err(ArchiveError::SourceMismatch.into());
    }
    Ok(())
}

pub(crate) async fn archived(
    connection: &mut SqliteConnection,
    session: &str,
    target_id: &str,
    before: u64,
) -> Result<Option<ArchivedToolResult>, StoreError> {
    let Some((_, placeholder)) = find(connection, session, target_id, before).await? else {
        return Ok(None);
    };
    let (sequence,invocation,operation_id,is_error):(i64,String,String,bool)=sqlx::query_as(
        "SELECT target_sequence,target_invocation_json,operation_id,is_error FROM context_archive_records
         WHERE session_id=? AND target_event_id=? AND sequence<?")
        .bind(session).bind(target_id).bind(before as i64).fetch_one(connection).await?;
    Ok(Some(ArchivedToolResult {
        sequence: sequence_number(sequence)?,
        event_id: target_id.into(),
        invocation: serde_json::from_str(&invocation)?,
        operation_id,
        replacement: placeholder
            .to_canonical_projection()
            .map_err(|_| ArchiveError::Corrupt)?,
        is_error,
    }))
}

/// Select the owner's archive or its immutable inherited archive, then verify
/// against the actual writer. A copied archive may come from an intermediate copy.
async fn selected(
    connection: &mut SqliteConnection,
    session: &str,
    event_id: &str,
) -> Result<Option<ArchivedPlaceholder>, StoreError> {
    let filter = Selection::archive_predicate("t", "a", "9223372036854775807", "NULL");
    let rows: Vec<(Option<String>, Option<i64>, Option<i64>)> =
        sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT json_extract(a.event_json,'$.invocation.session_id'), a.sequence, t.archive_sequence
         FROM session_history_events t LEFT JOIN runtime_events a
           ON a.kind='tool_result_archived'
           AND CAST(json_extract(a.event_json,'$.fact.placeholder.identity.runtime_event_id') AS TEXT)=t.event_id
           AND {filter}
         WHERE t.owner_session_id=?1 AND t.event_id=?2 LIMIT 2"
    )))
        .bind(session)
        .bind(event_id)
        .fetch_all(&mut *connection)
        .await?;
    if rows.len() > 1 {
        return Err(ArchiveError::Corrupt.into());
    }
    let Some((writer, sequence, pinned)) = rows.into_iter().next() else {
        return Ok(None);
    };
    let (writer, sequence) = match (writer, sequence, pinned) {
        (Some(writer), Some(sequence), _) => (writer, sequence),
        (None, None, None) => return Ok(None),
        _ => return Err(ArchiveError::Corrupt.into()),
    };
    let (accepted_sequence, placeholder) = find(
        connection,
        &writer,
        event_id,
        sequence_number(sequence)? + 1,
    )
    .await?
    .ok_or(ArchiveError::Corrupt)?;
    if accepted_sequence != sequence_number(sequence)? {
        return Err(ArchiveError::Corrupt.into());
    }
    Ok(Some(placeholder))
}

impl EventLog {
    /// Read the committed model projection with or without a later archive replacement.
    pub async fn read_tool_result(
        &self,
        session: &str,
        event_id: &str,
    ) -> Result<Option<super::ToolResultResource>, StoreError> {
        self.validate_root()?;
        crate::sessions::validate_id(session)?;
        let (session, event_id) = (session.to_owned(), event_id.to_owned());
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    let Some(mut target) = target::read(&mut tx, &session, &event_id).await? else {
                        return Ok(None);
                    };
                    target
                        .projection
                        .validate(&target.invocation.session_id)
                        .map_err(|_| ArchiveError::Corrupt)?;
                    if let Some(placeholder) = selected(&mut tx, &session, &event_id).await? {
                        validate(&target, &placeholder)?;
                    }
                    // Verify original evidence before rendering typed media locators.
                    // Raw archive reads below retain the original digest and bytes.
                    if target.invocation.session_id != session
                        && let maka_agent_facts::tool_output::DurableToolProjection::Content {
                            parts,
                        } = &mut target.projection
                    {
                        for part in parts {
                            if let Some(reference) = part.reference_mut() {
                                let maka_agent_facts::attachment::StorageRef::SessionFile {
                                    session_id,
                                    relative_path,
                                } = &*reference
                                else {
                                    return Err(ArchiveError::Corrupt.into());
                                };
                                *reference = crate::artifacts::history::resolve(
                                    &mut tx,
                                    &session,
                                    session_id,
                                    relative_path,
                                )
                                .await?
                                .ok_or(ArchiveError::Corrupt)?;
                            }
                        }
                    }
                    let bytes = maka_agent_facts::archive::encode_projection(&target.projection)
                        .map_err(|_| ArchiveError::Corrupt)?;
                    let serialized_result =
                        String::from_utf8(bytes).map_err(|_| ArchiveError::Corrupt)?;
                    tx.commit().await?;
                    Ok(Some(super::ToolResultResource {
                        tool_name: target.name,
                        serialized_result,
                    }))
                })
            })
            .await
    }

    pub async fn read_archive(
        &self,
        session: &str,
        identity: &ArchiveIdentity,
    ) -> Result<Option<Vec<u8>>, StoreError> {
        identity
            .validate()
            .map_err(|_| ArchiveError::SourceMismatch)?;
        let Some((accepted, bytes)) = self
            .read_archive_by_event(session, &identity.runtime_event_id)
            .await?
        else {
            return Ok(None);
        };
        if accepted != *identity {
            return Err(ArchiveError::SourceMismatch.into());
        }
        Ok(Some(bytes))
    }

    /// Resolve a locator through accepted evidence in the caller's Session, never raw payload alone.
    pub async fn read_archive_by_event(
        &self,
        session: &str,
        event_id: &str,
    ) -> Result<Option<(ArchiveIdentity, Vec<u8>)>, StoreError> {
        self.validate_root()?;
        crate::sessions::validate_id(session)?;
        let (session, event_id) = (session.to_owned(), event_id.to_owned());
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    let Some(target) = target::read(&mut tx, &session, &event_id).await? else {
                        return Ok(None);
                    };
                    let Some(placeholder) = selected(&mut tx, &session, &event_id).await? else {
                        return Ok(None);
                    };
                    let body = validate(&target, &placeholder)?;
                    tx.commit().await?;
                    Ok(Some((placeholder.identity, body)))
                })
            })
            .await
    }
}
