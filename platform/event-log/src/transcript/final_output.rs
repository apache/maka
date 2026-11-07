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

//! Final output membership from a logical Turn's original successful terminal.
use super::model::Producer;
use crate::StoreError;
use rusqlite::OptionalExtension;

// Choose the latest logical state first, including a later running/failed state.
// A copied Session's directory and membership retain the same original evidence.
const TERMINAL: &str = "WITH latest AS (
    SELECT source_sequence, state_status FROM transcript_directory
    WHERE owner_key = ?1 AND turn_id = ?2 AND source_sequence <= ?3
      AND role = 'turn_state'
    ORDER BY source_sequence DESC, item_index DESC LIMIT 1
) SELECT e.invocation_id, e.sequence FROM latest
JOIN runtime_events e ON e.sequence = latest.source_sequence
WHERE latest.state_status = 'completed' AND e.kind = 'invocation_ended'
  AND json_extract(e.event_header, '$.fact.outcome.kind') = 'completed'
  AND (e.event_session=?1 OR EXISTS(SELECT 1 FROM session_history_members h WHERE h.session_id=?1 AND h.sequence=e.sequence) OR EXISTS(SELECT 1 FROM history_snapshot_sessions s JOIN history_snapshot_members m USING(capture_key,session_id) WHERE s.owner_key=?1 AND m.sequence=e.sequence))";
const REQUESTED: &str = "SELECT e.operation_id FROM runtime_events e
WHERE e.invocation_id = ?2 AND e.kind = 'model_requested' AND e.sequence <= ?3
  AND json_extract(e.event_header, '$.fact.purpose') = 'main'
  AND (e.event_session=?1 OR EXISTS(SELECT 1 FROM session_history_members h WHERE h.session_id=?1 AND h.sequence=e.sequence) OR EXISTS(SELECT 1 FROM history_snapshot_sessions s JOIN history_snapshot_members m USING(capture_key,session_id) WHERE s.owner_key=?1 AND m.sequence=e.sequence))
ORDER BY e.sequence DESC LIMIT 1";
const COMPLETED: &str = "SELECT EXISTS(SELECT 1 FROM runtime_events e
WHERE e.operation_id = ?3 AND e.kind = 'model_completed' AND e.invocation_id = ?2
  AND e.sequence <= ?4 AND json_extract(e.event_header, '$.fact.step_id') = ?3
  AND (e.event_session=?1 OR EXISTS(SELECT 1 FROM session_history_members h WHERE h.session_id=?1 AND h.sequence=e.sequence) OR EXISTS(SELECT 1 FROM history_snapshot_sessions s JOIN history_snapshot_members m USING(capture_key,session_id) WHERE s.owner_key=?1 AND m.sequence=e.sequence)))";
const EXECUTOR: &str =
    "SELECT json_extract(e.event_header, '$.fact.message_id') FROM runtime_events e
WHERE e.invocation_id = ?2 AND e.kind = 'executor_completed' AND e.sequence <= ?3
  AND (e.event_session=?1 OR EXISTS(SELECT 1 FROM session_history_members h WHERE h.session_id=?1 AND h.sequence=e.sequence) OR EXISTS(SELECT 1 FROM history_snapshot_sessions s JOIN history_snapshot_members m USING(capture_key,session_id) WHERE s.owner_key=?1 AND m.sequence=e.sequence))
ORDER BY e.sequence DESC LIMIT 1";

/// One lookup per Turn in a history page; never hydrate model output bodies.
pub(super) fn resolve_on_worker(
    tx: &rusqlite::Connection,
    session: &str,
    turn: &str,
    through: i64,
) -> Result<Option<Producer>, StoreError> {
    let terminal: Option<(String, i64)> = tx
        .query_row(TERMINAL, rusqlite::params![session, turn, through], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .optional()?;
    let Some((invocation, terminal)) = terminal else {
        return Ok(None);
    };
    let requested: Option<String> = tx
        .query_row(
            REQUESTED,
            rusqlite::params![session, &invocation, terminal],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(step) = requested {
        let completed: bool = tx.query_row(
            COMPLETED,
            rusqlite::params![session, &invocation, &step, terminal],
            |row| row.get(0),
        )?;
        // An interrupted/latest request must never fall back to an earlier answer.
        return Ok(completed.then_some(Producer::Model { invocation, step }));
    }
    let executor: Option<Option<String>> = tx
        .query_row(
            EXECUTOR,
            rusqlite::params![session, &invocation, terminal],
            |row| row.get(0),
        )
        .optional()?;
    Ok(executor.flatten().map(|message_id| Producer::Executor {
        invocation,
        message_id,
    }))
}
