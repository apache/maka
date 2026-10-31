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
use sqlx::{Connection, SqliteConnection};
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

pub(crate) async fn initialize_execution(
    connection: &mut SqliteConnection,
) -> Result<(), StoreError> {
    // Only data is disposable; SQLx owns the schema. Rebuild a cleared cache
    // or watermark in the same transaction before exposing catalog readers.
    let mut tx = connection.begin().await?;
    let complete: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM catalog_messages)
            AND EXISTS(SELECT 1 FROM catalog_message_watermark WHERE singleton = 1)",
    )
    .fetch_one(&mut *tx)
    .await?;
    if !complete {
        sqlx::raw_sql(
            "DELETE FROM catalog_messages;
             DELETE FROM catalog_message_watermark;
             UPDATE session_control SET catalog_activity_at = 0;",
        )
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query("INSERT OR IGNORE INTO catalog_message_watermark VALUES (1, 0)")
        .execute(&mut *tx)
        .await?;
    let mut through: i64 =
        sqlx::query_scalar("SELECT sequence FROM catalog_message_watermark WHERE singleton = 1")
            .fetch_one(&mut *tx)
            .await?;
    loop {
        // Startup only: at most 128 small row identifiers, never event JSON in Rust.
        let rows = sqlx::query_scalar::<_, i64>(
                "SELECT sequence FROM runtime_events WHERE sequence > ?
             AND kind IN ('message_imported', 'invocation_opened', 'message_steered', 'model_completed', 'model_interrupted', 'invocation_ended')
             AND NOT EXISTS(SELECT 1 FROM session_retirements r
                 WHERE r.session_id=runtime_events.event_session AND r.remove_session=1 AND r.completed=1)
             ORDER BY sequence LIMIT 128",
            ).bind(through).fetch_all(&mut *tx).await?;
        if rows.is_empty() {
            break;
        }
        for sequence in rows {
            project_execution(&mut tx, sequence as u64).await?;
            through = sequence;
        }
    }
    sqlx::query(
        "UPDATE catalog_message_watermark SET sequence =
            (SELECT COALESCE(max(sequence), 0) FROM runtime_events)",
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

/// Called only for committed catalog boundaries, in the event append transaction.
/// This is a rebuildable index of message facts, not another execution authority.
pub(crate) async fn project_execution(
    connection: &mut SqliteConnection,
    sequence: u64,
) -> Result<(), StoreError> {
    let sequence = sequence as i64;
    let (session, invocation, step, kind): (String, String, Option<String>, String) =
        sqlx::query_as(
            "SELECT json_extract(event_json, '$.invocation.session_id'), invocation_id,
                operation_id, kind FROM runtime_events WHERE sequence = ?",
        )
        .bind(sequence)
        .fetch_one(&mut *connection)
        .await?;
    // Both accepted and interrupted summary text belong to context evidence,
    // not the visible message tail used by previews and read markers.
    let compact: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM runtime_events WHERE invocation_id = ?
         AND kind = 'invocation_opened'
         AND json_extract(event_json, '$.fact.input.kind') = 'context_compact')",
    )
    .bind(&invocation)
    .fetch_one(&mut *connection)
    .await?;
    let hidden_step = if matches!(kind.as_str(), "model_completed" | "model_interrupted") {
        !sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS (SELECT 1 FROM runtime_events request
             JOIN runtime_events opening ON opening.invocation_id = request.invocation_id
             AND opening.kind = 'invocation_opened'
             WHERE request.kind = 'model_requested' AND request.invocation_id = ?1
             AND request.operation_id = ?2
             AND json_extract(opening.event_json, '$.fact.input.kind') IN ('message', 'continuation', 'handoff')
             AND json_extract(request.event_json, '$.fact.purpose') = 'main')",
        )
        .bind(&invocation)
        .bind(&step)
        .fetch_one(&mut *connection)
        .await?
    } else {
        false
    };
    if compact || hidden_step {
        sqlx::query(
            "UPDATE catalog_message_watermark SET sequence = max(sequence, ?) WHERE singleton = 1",
        )
        .bind(sequence)
        .execute(connection)
        .await?;
        return Ok(());
    }
    let prior_clock: i64 = sqlx::query_scalar(
        "SELECT message_at FROM catalog_messages INDEXED BY catalog_latest_message
         WHERE session_id = ? ORDER BY message_at DESC, sequence DESC, ordinal DESC LIMIT 1",
    )
    .bind(&session)
    .fetch_optional(&mut *connection)
    .await?
    .unwrap_or(0);
    if kind == "message_imported" {
        sqlx::query(
            "INSERT OR IGNORE INTO catalog_messages
             SELECT sequence,0,?2,catalog_time(json_extract(event_json,'$.recorded_at')),
                catalog_preview(json_extract(event_json,'$.fact.record.content.text')),event_id
             FROM runtime_events WHERE sequence=?1
               AND json_extract(event_json,'$.fact.record.content.kind') IN ('user','assistant')",
        )
        .bind(sequence)
        .bind(&session)
        .execute(&mut *connection)
        .await?;
    } else if kind == "invocation_opened" {
        sqlx::query(
            "INSERT OR IGNORE INTO catalog_messages
             SELECT sequence, 0, ?2, catalog_time(json_extract(event_json, '$.recorded_at')),
                catalog_preview(COALESCE(
                    json_extract(event_json, '$.fact.input.content.display_text'),
                    json_extract(event_json, '$.fact.input.content.text'))),
                CASE WHEN json_array_length(event_json, '$.fact.input.source_messages') = 1
                    THEN json_extract(event_json, '$.fact.input.source_messages[0].message_id') ELSE event_id END
             FROM runtime_events WHERE sequence = ?1
             AND json_extract(event_json, '$.fact.input.kind') = 'message'",
        )
        .bind(sequence)
        .bind(&session)
        .execute(&mut *connection)
        .await?;
    } else if kind == "message_steered" {
        crate::steering::project_catalog(connection, sequence, &session).await?;
    } else if kind == "model_completed" {
        sqlx::query(
            "INSERT OR IGNORE INTO catalog_messages
             SELECT ?1,b.ordinal+1,?2,catalog_time(json_extract(b.record,'$.started_at')),
               CASE WHEN json_extract(b.part,'$.text_kind')='text' THEN catalog_preview(json_extract(b.part,'$.text')) END,
               b.message_id
             FROM model_selected_parts s JOIN model_part_bodies b ON b.event_id=s.body_event_id AND b.ordinal=s.ordinal
             WHERE s.sequence=?1 AND json_extract(b.part,'$.kind')='text'",
        ).bind(sequence).bind(&session).execute(&mut *connection).await?;
    }
    if kind == "model_interrupted" || kind == "invocation_ended" {
        partial::project(connection, sequence, &session, &invocation, step.as_deref()).await?;
    }
    // TS rejects preview updates older than the previous message clock, even if
    // that clock came from a thinking-only message without any preview. Apply the
    // same guard in commit/part order, scanning only this boundary's new rows.
    sqlx::query(
        "UPDATE catalog_messages AS current SET preview = NULL
         WHERE sequence = ?1 AND message_at < max(?2, COALESCE((
            SELECT max(earlier.message_at) FROM catalog_messages AS earlier
            WHERE earlier.sequence = ?1 AND earlier.ordinal < current.ordinal
         ), 0))",
    )
    .bind(sequence)
    .bind(prior_clock)
    .execute(&mut *connection)
    .await?;
    sqlx::query(
        "UPDATE session_control SET catalog_activity_at = COALESCE((
            SELECT message_at FROM catalog_messages INDEXED BY catalog_latest_message
            WHERE session_id = ?1 ORDER BY message_at DESC, sequence DESC, ordinal DESC LIMIT 1
         ), 0) WHERE id = ?1",
    )
    .bind(&session)
    .execute(&mut *connection)
    .await?;
    sqlx::query(
        "UPDATE catalog_message_watermark SET sequence = max(sequence, ?) WHERE singleton = 1",
    )
    .bind(sequence)
    .execute(&mut *connection)
    .await?;
    Ok(())
}

/// Durable user/assistant tail in presentation order, independent of preview clocks.
pub(crate) async fn latest_visible_message(
    connection: &mut SqliteConnection,
    session: &str,
) -> Result<Option<String>, StoreError> {
    Ok(sqlx::query_scalar(
        "SELECT message_id FROM catalog_messages INDEXED BY catalog_visible_tail
         WHERE session_id = ? ORDER BY sequence DESC, ordinal DESC LIMIT 1",
    )
    .bind(session)
    .fetch_optional(connection)
    .await?)
}
