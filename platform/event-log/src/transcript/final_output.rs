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
use sqlx::sqlite::SqliteWorkerConnection;

// Choose the latest logical state first, including a later running/failed state.
// A copied Session's directory and membership retain the same original evidence.
const TERMINAL: &str = "WITH latest AS (
    SELECT source_sequence, state_status FROM transcript_directory
    WHERE session_id = ?1 AND turn_id = ?2 AND source_sequence <= ?3
      AND role = 'turn_state'
    ORDER BY source_sequence DESC, item_index DESC LIMIT 1
) SELECT e.invocation_id, e.sequence FROM latest
JOIN runtime_events e ON e.sequence = latest.source_sequence
WHERE latest.state_status = 'completed' AND e.kind = 'invocation_ended'
  AND json_extract(e.event_header, '$.fact.outcome.kind') = 'completed'
  AND (e.event_session = ?1 OR EXISTS(
    SELECT 1 FROM session_history_members h WHERE h.session_id = ?1 AND h.sequence = e.sequence))";
const REQUESTED: &str = "SELECT e.operation_id FROM runtime_events e
WHERE e.invocation_id = ?2 AND e.kind = 'model_requested' AND e.sequence <= ?3
  AND json_extract(e.event_header, '$.fact.purpose') = 'main'
  AND (e.event_session = ?1 OR EXISTS(
    SELECT 1 FROM session_history_members h WHERE h.session_id = ?1 AND h.sequence = e.sequence))
ORDER BY e.sequence DESC LIMIT 1";
const COMPLETED: &str = "SELECT EXISTS(SELECT 1 FROM runtime_events e
WHERE e.operation_id = ?3 AND e.kind = 'model_completed' AND e.invocation_id = ?2
  AND e.sequence <= ?4 AND json_extract(e.event_header, '$.fact.step_id') = ?3
  AND (e.event_session = ?1 OR EXISTS(
    SELECT 1 FROM session_history_members h WHERE h.session_id = ?1 AND h.sequence = e.sequence)))";
const EXECUTOR: &str = "SELECT e.sequence FROM runtime_events e
WHERE e.invocation_id = ?2 AND e.kind = 'executor_completed' AND e.sequence <= ?3
  AND (e.event_session = ?1 OR EXISTS(
    SELECT 1 FROM session_history_members h WHERE h.session_id = ?1 AND h.sequence = e.sequence))
ORDER BY e.sequence DESC LIMIT 1";

/// One lookup per Turn in a history page; never hydrate model output bodies.
pub(super) async fn resolve_on_worker(
    tx: &mut SqliteWorkerConnection<'_>,
    session: &str,
    turn: &str,
    through: i64,
) -> Result<Option<Producer>, StoreError> {
    let terminal: Option<(String, i64)> = sqlx::query_as(TERMINAL)
        .bind(session)
        .bind(turn)
        .bind(through)
        .fetch_optional(&mut *tx)
        .await?;
    let Some((invocation, terminal)) = terminal else {
        return Ok(None);
    };
    let requested: Option<String> = sqlx::query_scalar(REQUESTED)
        .bind(session)
        .bind(&invocation)
        .bind(terminal)
        .fetch_optional(&mut *tx)
        .await?;
    if let Some(step) = requested {
        let completed: bool = sqlx::query_scalar(COMPLETED)
            .bind(session)
            .bind(&invocation)
            .bind(&step)
            .bind(terminal)
            .fetch_one(&mut *tx)
            .await?;
        // An interrupted/latest request must never fall back to an earlier answer.
        return Ok(completed.then_some(Producer::Model { invocation, step }));
    }
    let executor: Option<i64> = sqlx::query_scalar(EXECUTOR)
        .bind(session)
        .bind(&invocation)
        .bind(terminal)
        .fetch_optional(&mut *tx)
        .await?;
    Ok(executor.map(|_| Producer::Executor { invocation }))
}
