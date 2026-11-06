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

use super::MAX_SAFE_INTEGER;
use crate::StoreError;
use rusqlite::{OptionalExtension, params};
use std::time::{SystemTime, UNIX_EPOCH};

mod partial;

pub(crate) fn register_functions(connection: &rusqlite::Connection) -> Result<(), StoreError> {
    use rusqlite::functions::FunctionFlags;
    let flags = FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC;
    connection.create_scalar_function("catalog_time", 1, flags, |ctx| {
        let time: SystemTime = serde_json::from_str(ctx.get_raw(0).as_str()?)
            .map_err(|error| rusqlite::Error::UserFunctionError(Box::new(error)))?;
        time.duration_since(UNIX_EPOCH)
            .ok()
            .and_then(|duration| u64::try_from(duration.as_millis()).ok())
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .map(|value| value as i64)
            .ok_or(rusqlite::Error::InvalidQuery)
    })?;
    partial::register_function(connection)
}

pub(crate) fn initialize_execution(connection: &rusqlite::Connection) -> Result<(), StoreError> {
    // Only derived data is disposable. Rebuild a cleared cache
    // or watermark in the same transaction before exposing catalog readers.
    let tx =
        rusqlite::Transaction::new_unchecked(connection, rusqlite::TransactionBehavior::Deferred)?;
    let complete: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM catalog_messages)
            AND EXISTS(SELECT 1 FROM catalog_message_watermark WHERE singleton = 1)",
        params![],
        |row| row.get(0),
    )?;
    if !complete {
        tx.execute_batch(
            "DELETE FROM catalog_messages;
             DELETE FROM catalog_message_watermark;
             UPDATE session_control SET catalog_activity_at = 0;",
        )?;
    }
    tx.execute(
        "INSERT OR IGNORE INTO catalog_message_watermark VALUES (1, 0)",
        params![],
    )?;
    let mut through: i64 = tx.query_row(
        "SELECT sequence FROM catalog_message_watermark WHERE singleton = 1",
        params![],
        |row| row.get(0),
    )?;
    loop {
        // Startup only: at most 128 small row identifiers, never event JSON in Rust.
        let rows = tx.prepare_cached("SELECT sequence FROM runtime_events WHERE sequence > ?
             AND kind IN ('message_imported', 'invocation_opened', 'message_steered', 'model_completed', 'model_interrupted', 'invocation_ended')
             AND NOT EXISTS(SELECT 1 FROM session_retirements r
                 WHERE r.session_id=runtime_events.event_session AND r.remove_session=1 AND r.completed=1)
             ORDER BY sequence LIMIT 128")?.query_map(params![through], |row| row.get(0))?.collect::<std::result::Result<Vec<_>, _>>()?;
        if rows.is_empty() {
            break;
        }
        for sequence in rows {
            project_execution(&tx, sequence as u64)?;
            through = sequence;
        }
    }
    tx.execute(
        "UPDATE catalog_message_watermark SET sequence =
            (SELECT COALESCE(max(sequence), 0) FROM runtime_events)",
        params![],
    )?;
    tx.commit()?;
    Ok(())
}

/// Called only for committed catalog boundaries, in the event append transaction.
/// This is a rebuildable index of message facts, not another execution authority.
pub(crate) fn project_execution(
    connection: &rusqlite::Connection,
    sequence: u64,
) -> Result<(), StoreError> {
    let sequence = sequence as i64;
    let (session, invocation, step, kind): (String, String, Option<String>, String) = connection
        .prepare_cached(
            "SELECT json_extract(event_header, '$.invocation.session_id'), invocation_id,
                operation_id, kind FROM runtime_events WHERE sequence = ?",
        )?
        .query_row(params![sequence], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?;
    // Both accepted and interrupted summary text belong to context evidence,
    // not the visible message tail used by previews and read markers.
    let compact: bool = connection
        .prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM runtime_events WHERE invocation_id = ?
         AND kind = 'invocation_opened'
         AND json_extract(event_header, '$.fact.input.kind') = 'context_compact')",
        )?
        .query_row(params![&invocation], |row| row.get(0))?;
    let hidden_step = if matches!(kind.as_str(), "model_completed" | "model_interrupted") {
        !connection.prepare_cached("SELECT EXISTS (SELECT 1 FROM runtime_events request
             JOIN runtime_events opening ON opening.invocation_id = request.invocation_id
             AND opening.kind = 'invocation_opened'
             WHERE request.kind = 'model_requested' AND request.invocation_id = ?1
             AND request.operation_id = ?2
             AND json_extract(opening.event_header, '$.fact.input.kind') IN ('message', 'continuation', 'handoff')
             AND json_extract(request.event_header, '$.fact.purpose') = 'main')")?.query_row( params![&invocation, &step], |row| row.get::<_, bool>(0))
        ?
    } else {
        false
    };
    if compact || hidden_step {
        connection.prepare_cached(
            "UPDATE catalog_message_watermark SET sequence = max(sequence, ?) WHERE singleton = 1")?.execute(
            params![sequence],
        )?;
        return Ok(());
    }
    let prior_clock: i64 = connection
        .prepare_cached(
            "SELECT message_at FROM catalog_messages INDEXED BY catalog_latest_message
         WHERE session_id = ? ORDER BY message_at DESC, sequence DESC, ordinal DESC LIMIT 1",
        )?
        .query_row(params![&session], |row| row.get(0))
        .optional()?
        .unwrap_or(0);
    if kind == "message_imported" {
        connection
            .prepare_cached(
                "INSERT OR IGNORE INTO catalog_messages
             SELECT sequence,0,?2,catalog_time(json_extract(event_header,'$.recorded_at')),
                catalog_preview(json_extract(event_header,'$.fact.record.content.text')),event_id
             FROM runtime_events WHERE sequence=?1
               AND json_extract(event_header,'$.fact.record.content.kind') IN ('user','assistant')",
            )?
            .execute(params![sequence, &session])?;
    } else if kind == "invocation_opened" {
        connection.prepare_cached("INSERT OR IGNORE INTO catalog_messages
             SELECT sequence, 0, ?2, catalog_time(json_extract(event_header, '$.recorded_at')),
                catalog_preview(COALESCE(
                    json_extract(event_header, '$.fact.input.content.display_text'),
                    json_extract(event_header, '$.fact.input.content.text'))),
                CASE WHEN json_array_length(event_header, '$.fact.input.source_messages') = 1
                    THEN json_extract(event_header, '$.fact.input.source_messages[0].message_id') ELSE event_id END
             FROM runtime_events WHERE sequence = ?1
             AND json_extract(event_header, '$.fact.input.kind') = 'message'")?.execute( params![sequence, &session])
        ?;
    } else if kind == "message_steered" {
        crate::steering::project_catalog(connection, sequence, &session)?;
    } else if kind == "model_completed" {
        connection.prepare_cached("INSERT OR IGNORE INTO catalog_messages
             SELECT ?1,b.ordinal+1,?2,catalog_time(json_extract(b.record,'$.started_at')),
               CASE WHEN json_extract(b.part,'$.text_kind')='text' THEN catalog_preview(json_extract(b.part,'$.text')) END,
               b.message_id
             FROM model_selected_parts s JOIN model_part_bodies b ON b.event_id=s.body_event_id AND b.ordinal=s.ordinal
             WHERE s.sequence=?1 AND json_extract(b.part,'$.kind')='text'")?.execute( params![sequence, &session])?;
    }
    if kind == "model_interrupted" || kind == "invocation_ended" {
        partial::project(connection, sequence, &session, &invocation, step.as_deref())?;
    }
    // TS rejects preview updates older than the previous message clock, even if
    // that clock came from a thinking-only message without any preview. Apply the
    // same guard in commit/part order, scanning only this boundary's new rows.
    connection
        .prepare_cached(
            "UPDATE catalog_messages AS current SET preview = NULL
         WHERE sequence = ?1 AND message_at < max(?2, COALESCE((
            SELECT max(earlier.message_at) FROM catalog_messages AS earlier
            WHERE earlier.sequence = ?1 AND earlier.ordinal < current.ordinal
         ), 0))",
        )?
        .execute(params![sequence, prior_clock])?;
    connection
        .prepare_cached(
            "UPDATE session_control SET catalog_activity_at = COALESCE((
            SELECT message_at FROM catalog_messages INDEXED BY catalog_latest_message
            WHERE session_id = ?1 ORDER BY message_at DESC, sequence DESC, ordinal DESC LIMIT 1
         ), 0) WHERE id = ?1",
        )?
        .execute(params![&session])?;
    connection
        .prepare_cached(
            "UPDATE catalog_message_watermark SET sequence = max(sequence, ?) WHERE singleton = 1",
        )?
        .execute(params![sequence])?;
    Ok(())
}

/// Durable user/assistant tail in presentation order, independent of preview clocks.
pub(crate) fn latest_visible_message(
    connection: &rusqlite::Connection,
    session: &str,
) -> Result<Option<String>, StoreError> {
    Ok(connection
        .query_row(
            "SELECT message_id FROM catalog_messages INDEXED BY catalog_visible_tail
         WHERE session_id = ? ORDER BY sequence DESC, ordinal DESC LIMIT 1",
            params![session],
            |row| row.get(0),
        )
        .optional()?)
}
