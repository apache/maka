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

use crate::{StoreError, sequence_number};
use maka_presentation::{Content, Message, Row};
use rusqlite::Connection as RawConnection;

const COMPACTION: &str = r#"SELECT c.event_id, json_extract(c.event_json, '$.invocation.turn_id') AS turn_id,
           catalog_time(json_extract(c.event_json, '$.recorded_at')) AS adopted_at,
           CASE WHEN json_extract(opening.event_json, '$.fact.input.kind') = 'context_compact'
           THEN catalog_time(json_extract(opening.event_json, '$.recorded_at'))
           ELSE (SELECT catalog_time(json_extract(r.event_json, '$.recorded_at'))
            FROM event_log r INDEXED BY context_summary_round
            WHERE r.event_json IS NOT NULL AND r.invocation_id = c.invocation_id AND r.kind = 'model_requested'
              AND json_extract(r.event_json, '$.fact.purpose') = 'summary'
              AND r.sequence <= adopted.sequence
              AND json_extract(r.event_json, '$.fact.source_high_water') = json_extract(adopted.event_json, '$.fact.source_high_water')
              AND json_extract(r.event_json, '$.fact.source_digest') = json_extract(adopted.event_json, '$.fact.source_digest')
              AND NOT EXISTS (SELECT 1 FROM runtime_events boundary
                WHERE boundary.invocation_id = c.invocation_id AND boundary.sequence > r.sequence AND boundary.sequence < c.sequence
                  AND boundary.kind = 'context_checkpoint_recorded')
            ORDER BY r.sequence LIMIT 1) END AS started_at
         FROM runtime_events c JOIN runtime_events adopted
           ON adopted.invocation_id = c.invocation_id AND adopted.kind = 'model_requested'
           AND adopted.operation_id = json_extract(c.event_json, '$.fact.checkpoint.summary_step_id')
         LEFT JOIN runtime_events opening
           ON opening.invocation_id = c.invocation_id AND opening.kind = 'invocation_opened'
         WHERE c.sequence = ? AND c.kind = 'context_checkpoint_recorded'"#;

/// Project adoption metadata without hydrating the private summary body.
pub(super) fn project(db: &RawConnection, sequence: i64) -> Result<Row, StoreError> {
    use maka_agent_facts::history::RowPosition;
    let (id, turn, adopted, started): (String, String, i64, i64) =
        db.prepare_cached(COMPACTION)?
            .query_row([sequence], |row| {
                Ok((
                    row.get("event_id")?,
                    row.get("turn_id")?,
                    row.get("adopted_at")?,
                    row.get("started_at")?,
                ))
            })?;
    let ts = sequence_number(adopted)?;
    let started = sequence_number(started)?;
    Ok(Row {
        position: RowPosition {
            source_sequence: sequence_number(sequence)?,
            item_index: 0,
        },
        message: Message {
            id,
            turn_id: turn,
            ts,
            content: Content::ContextCompacted {
                duration_ms: ts.saturating_sub(started),
            },
        },
    })
}
