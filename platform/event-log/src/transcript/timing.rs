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
use maka_agent_ports::session::history::TurnFinished;
use maka_agent_ports::session::history::TurnOutcome;
use maka_agent_ports::session::history::TurnTiming;
use sqlx::sqlite::SqliteWorkerConnection;

// Two scalar index seeks, regardless of the size of a Turn's transcript. Start
// follows original sequence order, not the wall clock (which can move backward).
const SQL: &str = "WITH first AS (
    SELECT timestamp AS at FROM transcript_directory
    WHERE session_id = ?1 AND turn_id = ?2 AND source_sequence <= ?3
      AND role = 'turn_state'
      AND state_status = 'running'
    ORDER BY source_sequence, item_index LIMIT 1
), last AS (
    SELECT timestamp AS at,
        state_status AS status FROM transcript_directory
    WHERE session_id = ?1 AND turn_id = ?2 AND source_sequence <= ?3
      AND role = 'turn_state'
    ORDER BY source_sequence DESC, item_index DESC LIMIT 1
) SELECT first.at, last.at, last.status FROM first, last";

pub(super) async fn read_on_worker(
    tx: &mut SqliteWorkerConnection<'_>,
    session: &str,
    turn: &str,
    through: i64,
) -> Result<Option<TurnTiming>, StoreError> {
    let row: Option<(Option<i64>, Option<i64>, String)> = sqlx::query_as(SQL)
        .bind(session)
        .bind(turn)
        .bind(through)
        .fetch_optional(tx)
        .await?;
    let Some((Some(start), Some(last), status)) = row else {
        return Ok(None);
    };
    const MAX: i64 = (1 << 53) - 1;
    if !(0..=MAX).contains(&start) || !(start..=MAX).contains(&last) {
        return Ok(None);
    }
    let outcome = match status.as_str() {
        "running" => None,
        "completed" => Some(TurnOutcome::Completed),
        "failed" => Some(TurnOutcome::Failed),
        "aborted" => Some(TurnOutcome::Aborted),
        _ => return Ok(None),
    };
    Ok(Some(TurnTiming {
        started_at: start as u64,
        finished: outcome.map(|outcome| TurnFinished {
            at: last as u64,
            outcome,
        }),
    }))
}
