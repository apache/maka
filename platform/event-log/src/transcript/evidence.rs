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
use maka_agent_facts::event::StoredEvent;
use maka_presentation::ProjectionError;
use rusqlite::{Connection, OptionalExtension};

use rusqlite::{Connection as RawConnection, params};

const HIGH: &str = r#"SELECT COALESCE(MAX(sequence), 0) FROM event_log"#;
const EXEC_BOUNDARY: &str = r#"SELECT sequence FROM runtime_events
WHERE invocation_id=?1 AND sequence<=?2 AND kind='invocation_opened'
UNION SELECT sequence FROM runtime_events WHERE invocation_id=?1 AND sequence<=?2 AND kind='executor_started'
UNION SELECT sequence FROM runtime_events WHERE invocation_id=?1 AND sequence=?2 AND ?3
UNION SELECT sequence FROM runtime_events WHERE invocation_id=?1 AND sequence<=?2
    AND kind='executor_observed'
    AND json_extract(event_header, '$.fact.output.messageId') =
        (SELECT json_extract(event_header, '$.fact.output.messageId') FROM runtime_events WHERE sequence=?2)
UNION SELECT sequence FROM runtime_events WHERE invocation_id=?1 AND sequence<=?2
    AND kind IN ('executor_observed','executor_completed')
    AND json_extract(event_header, '$.fact.output.toolCallId') =
        (SELECT json_extract(event_header, '$.fact.output.toolCallId') FROM runtime_events WHERE sequence=?2)
ORDER BY sequence"#;
const EXEC_REST: &str = r#"SELECT sequence FROM runtime_events
WHERE invocation_id=?1 AND sequence<=?2 AND kind='invocation_opened'
UNION SELECT sequence FROM runtime_events WHERE invocation_id=?1 AND sequence<=?2 AND kind='executor_started'
UNION SELECT sequence FROM runtime_events WHERE invocation_id=?1 AND sequence=?2 AND ?3
UNION SELECT e.sequence FROM runtime_events e
WHERE e.invocation_id=?1 AND e.sequence<=?2 AND e.kind='executor_observed'
    AND json_extract(e.event_header, '$.fact.output.messageId') IN (
        SELECT json_extract(start.event_header, '$.fact.output.messageId') FROM runtime_events start
        WHERE start.invocation_id=?1 AND start.sequence<=?2 AND start.kind='executor_observed'
            AND json_extract(start.event_header, '$.fact.output.type')='message_start'
            AND NOT EXISTS(SELECT 1 FROM runtime_events done
                WHERE done.invocation_id=?1 AND done.sequence<=?2 AND done.kind='executor_observed'
                    AND json_extract(done.event_header, '$.fact.output.messageId')=json_extract(start.event_header, '$.fact.output.messageId')
                    AND json_extract(done.event_header, '$.fact.output.type')='message_end'))
UNION SELECT start.sequence FROM runtime_events start
WHERE start.invocation_id=?1 AND start.sequence<=?2
    AND start.kind='executor_observed'
    AND json_extract(start.event_header, '$.fact.output.type')='tool_start'
    AND NOT EXISTS(SELECT 1 FROM runtime_events done
        WHERE done.invocation_id=?1 AND done.sequence<=?2 AND done.kind IN ('executor_observed','executor_completed')
            AND json_extract(done.event_header, '$.fact.output.toolCallId')=json_extract(start.event_header, '$.fact.output.toolCallId')
            AND json_extract(done.event_header, '$.fact.output.type')='tool_result')
    AND NOT EXISTS(SELECT 1 FROM runtime_events done
        WHERE done.invocation_id=?1 AND done.sequence<?2 AND done.kind='executor_completed')
ORDER BY sequence"#;
const STEP: &str = r#"SELECT sequence FROM runtime_events
WHERE invocation_id = ?1 AND sequence <= ?3 AND kind = 'invocation_opened'
UNION
SELECT sequence FROM runtime_events
WHERE invocation_id = ?1 AND sequence <= ?3
  AND sequence IN (SELECT value FROM json_each(?4))
UNION
SELECT sequence FROM runtime_events
WHERE invocation_id = ?1 AND sequence <= ?3
  AND ?2 IS NOT NULL AND kind = 'model_requested' AND operation_id = ?2
UNION
SELECT sequence FROM runtime_events
WHERE invocation_id = ?1 AND sequence <= ?3
  AND ?5 AND ?2 IS NOT NULL AND kind = 'model_completed' AND operation_id = ?2
UNION
SELECT sequence FROM runtime_events
WHERE invocation_id = ?1 AND sequence <= ?3 AND ?2 IS NOT NULL
  AND kind = 'model_observed'
  AND CAST(json_extract(event_header, '$.fact.step_id') AS TEXT) = ?2
  AND json_extract(event_header, '$.fact.step_id') = ?2
ORDER BY sequence"#;

const PENDING: &str = r#"SELECT operation_id FROM runtime_events AS request
         WHERE invocation_id = ?1 AND sequence <= ?2 AND kind = 'model_requested'
           AND EXISTS(SELECT 1 FROM runtime_events opening
               WHERE opening.invocation_id = request.invocation_id AND opening.kind = 'invocation_opened'
               AND json_extract(opening.event_header, '$.fact.input.kind') IN ('message', 'continuation', 'handoff'))
           AND json_extract(request.event_header, '$.fact.purpose') = 'main'
           AND NOT EXISTS(SELECT 1 FROM runtime_events AS boundary
               WHERE boundary.invocation_id = request.invocation_id
                 AND boundary.operation_id = request.operation_id
                 AND boundary.kind IN ('model_completed', 'model_interrupted')
                 AND boundary.sequence <= ?2)
         ORDER BY sequence DESC LIMIT 1"#;

// Tool boundaries keep their original ancestry path and do not inspect
// external execution or unresolved model requests.
const PLAN: &str = r#"WITH boundary(kind) AS (
    SELECT CASE WHEN ?3 THEN (
        SELECT kind FROM runtime_events WHERE sequence=?2 AND invocation_id=?1
    ) END
), classified AS (
    SELECT kind, COALESCE(kind IN ('tool_dispatched','tool_rejected','tool_settled'),0) AS tool
    FROM boundary
)
SELECT kind, tool, CASE WHEN tool THEN 0 ELSE EXISTS(
    SELECT 1 FROM runtime_events WHERE invocation_id=?1 AND sequence<=?2 AND kind='executor_started'
) END AS external FROM classified"#;

struct Metadata {
    kind: Option<String>,
    tool: bool,
    external: bool,
}

/// Live and preparation readers use the same metadata and selection policy.
/// Both queries remain inside the reader's original transaction.
pub(super) fn selected(
    tx: &Connection,
    invocation: &str,
    step: Option<&str>,
    through: i64,
    boundary: bool,
) -> Result<Vec<i64>, StoreError> {
    selected_on_worker(tx, invocation, step, through, boundary)
}

pub(super) fn selected_on_worker(
    tx: &rusqlite::Connection,
    invocation: &str,
    step: Option<&str>,
    through: i64,
    boundary: bool,
) -> Result<Vec<i64>, StoreError> {
    let metadata = tx.query_row(
        PLAN,
        rusqlite::params![invocation, through, boundary],
        |row| {
            Ok(Metadata {
                kind: row.get(0)?,
                tool: row.get(1)?,
                external: row.get(2)?,
            })
        },
    )?;
    let mut selection =
        if let Some(selection) = plan(metadata, invocation, step, through, boundary)? {
            selection
        } else {
            super::tools::selection(tx, invocation, through)?
        };
    if let Some(slot) = selection.pending_step_slot() {
        *slot = match tx
            .query_row(PENDING, rusqlite::params![invocation, through], |row| {
                row.get(0)
            })
            .optional()?
        {
            Some(Some(step)) => Some(step),
            None => None,
            Some(None) => {
                return Err(rusqlite::Error::InvalidColumnType(
                    0,
                    "operation_id".into(),
                    rusqlite::types::Type::Null,
                )
                .into());
            }
        };
    }
    selection.read(tx)
}

pub(super) fn fence(tx: &Connection, through: u64) -> Result<i64, StoreError> {
    let through = i64::try_from(through).map_err(|_| ProjectionError::OutOfRange)?;
    let high: i64 = tx.query_row(HIGH, rusqlite::params![], |row| row.get(0))?;
    checked_fence(through, high)
}

fn checked_fence(through: i64, high: i64) -> Result<i64, StoreError> {
    if through > high {
        return Err(StoreError::InvalidTransition(
            "transcript fence exceeds committed log".into(),
        ));
    }
    Ok(through)
}

pub(super) fn fact(tx: &Connection, sequence: i64) -> Result<StoredEvent, StoreError> {
    fact_on_handle(tx, sequence)
}

pub(super) fn fact_on_handle(db: &RawConnection, sequence: i64) -> Result<StoredEvent, StoreError> {
    let query = format!(
        "SELECT e.event_header,{columns} FROM runtime_events e {joins} WHERE e.sequence=?",
        columns = crate::canonical::COLUMNS,
        joins = crate::canonical::JOINS
    );
    db.prepare_cached(&query)?.query_row([sequence], |row| {
        // Decode failures keep their storage cause after the raw SQLite callback.
        Ok(crate::canonical::json_on_handle(row).and_then(|json| decoded_fact(sequence, &json)))
    })?
}

fn decoded_fact(sequence: i64, json: &str) -> Result<StoredEvent, StoreError> {
    Ok(StoredEvent {
        sequence: sequence_number(sequence)?,
        event: serde_json::from_str(json)?,
    })
}

pub(super) fn pending_step_on_worker(
    tx: &rusqlite::Connection,
    invocation: &str,
    through: i64,
) -> Result<Option<String>, StoreError> {
    Ok(tx
        .query_row(PENDING, rusqlite::params![invocation, through], |row| {
            row.get(0)
        })
        .optional()?)
}

fn pending_step_on_handle(
    db: &RawConnection,
    invocation: &str,
    through: i64,
) -> Result<Option<String>, StoreError> {
    Ok(db
        .prepare_cached(PENDING)?
        .query_row(params![invocation, through], |row| row.get(0))
        .optional()?)
}

fn ids(
    db: &RawConnection,
    sql: &str,
    parameters: impl rusqlite::Params,
) -> Result<Vec<i64>, StoreError> {
    Ok(db
        .prepare_cached(sql)?
        .query_map(parameters, |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?)
}
/// Select the actual opening, one step and its exact boundary evidence.
/// This is the only selection policy for both preparation and live readers.
pub(super) fn selected_on_handle(
    db: &RawConnection,
    invocation: &str,
    step: Option<&str>,
    through: i64,
    boundary: bool,
) -> Result<Vec<i64>, StoreError> {
    let metadata =
        db.prepare_cached(PLAN)?
            .query_row(params![invocation, through, boundary], |row| {
                Ok(Metadata {
                    kind: row.get(0)?,
                    tool: row.get(1)?,
                    external: row.get(2)?,
                })
            })?;
    let mut selection = match plan(metadata, invocation, step, through, boundary)? {
        Some(selection) => selection,
        None => super::tools::selection(db, invocation, through)?,
    };
    if let Some(slot) = selection.pending_step_slot() {
        *slot = pending_step_on_handle(db, invocation, through)?;
    }
    selection.read_on_handle(db)
}

/// None requests the existing tool ancestry planner; all other branches own
/// their complete query inputs without retaining a connection or evidence.
fn plan(
    metadata: Metadata,
    invocation: &str,
    step: Option<&str>,
    through: i64,
    boundary: bool,
) -> Result<Option<Selection>, StoreError> {
    if boundary && metadata.kind.is_none() {
        return Err(rusqlite::Error::QueryReturnedNoRows.into());
    }
    if metadata.tool {
        return Ok(None);
    }
    if metadata.external {
        return Ok(Some(
            if metadata.kind.as_deref() == Some("executor_observed") {
                Selection::ExecutorBoundary {
                    invocation: invocation.to_owned(),
                    through,
                    boundary,
                }
            } else {
                Selection::ExecutorRest {
                    invocation: invocation.to_owned(),
                    through,
                    boundary,
                }
            },
        ));
    }
    let boundaries = serde_json::to_string(if boundary {
        std::slice::from_ref(&through)
    } else {
        &[]
    })?;
    Ok(Some(Selection::Step {
        invocation: invocation.to_owned(),
        step: step.map(str::to_owned),
        through,
        boundaries,
        completed: false,
    }))
}

/// Owned query inputs selected under the current transaction. No evidence
/// results or borrowed connection state survive the database operation.
pub(super) enum Selection {
    Step {
        invocation: String,
        step: Option<String>,
        through: i64,
        boundaries: String,
        completed: bool,
    },
    ExecutorBoundary {
        invocation: String,
        through: i64,
        boundary: bool,
    },
    ExecutorRest {
        invocation: String,
        through: i64,
        boundary: bool,
    },
}

impl Selection {
    // A standalone tool deliberately has no model step. Only ordinary step
    // selection may resolve a pending request, retaining NULL/error semantics.
    fn pending_step_slot(&mut self) -> Option<&mut Option<String>> {
        match self {
            Self::Step {
                step,
                completed: false,
                ..
            } if step.is_none() => Some(step),
            _ => None,
        }
    }

    fn sql(&self) -> &'static str {
        match self {
            Self::Step { .. } => STEP,
            Self::ExecutorBoundary { .. } => EXEC_BOUNDARY,
            Self::ExecutorRest { .. } => EXEC_REST,
        }
    }

    fn read_on_handle(&self, db: &RawConnection) -> Result<Vec<i64>, StoreError> {
        match self {
            Self::Step {
                invocation,
                step,
                through,
                boundaries,
                completed,
            } => ids(
                db,
                self.sql(),
                params![invocation, step, through, boundaries, completed],
            ),
            Self::ExecutorBoundary {
                invocation,
                through,
                boundary,
            }
            | Self::ExecutorRest {
                invocation,
                through,
                boundary,
            } => ids(db, self.sql(), params![invocation, through, boundary]),
        }
    }

    fn read(&self, tx: &rusqlite::Connection) -> Result<Vec<i64>, StoreError> {
        self.read_on_handle(tx)
    }
}

#[cfg(test)]
mod executor_tests {
    use super::*;

    fn boundary_cost(prior_deltas: usize) -> [usize; 2] {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch(&crate::schema::fixture(|kind, _| kind != "trigger"))
            .unwrap();
        db.execute("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<?1)
            INSERT INTO event_log(event_id,invocation_id,kind,event_header)
            SELECT printf('delta-%08d',x),'invocation','executor_observed',
                json_object('fact',json_object('output',json_object('type','output_delta','messageId','old','text','chunk')))
            FROM n", rusqlite::params![prior_deltas as i64]).unwrap();
        let mut boundaries = Vec::new();
        for output in [
            serde_json::json!({"type":"message_start","messageId":"current"}),
            serde_json::json!({"type":"output_delta","messageId":"current","text":"current"}),
            serde_json::json!({"type":"message_end","messageId":"current"}),
            serde_json::json!({"type":"tool_start","toolCallId":"current-tool"}),
        ] {
            let index = boundaries.len();
            db.execute("INSERT INTO event_log(event_id,invocation_id,kind,event_header) VALUES(?1,'invocation','executor_observed',?2)", rusqlite::params![format!("boundary-{index}"), serde_json::json!({"fact":{"output":output}}).to_string()]).unwrap();
            let sequence = db.last_insert_rowid();
            boundaries.push(sequence);
        }
        let mut costs = [0; 2];
        for (index, (sequence, expected)) in [(boundaries[2], 3), (boundaries[3], 1)]
            .into_iter()
            .enumerate()
        {
            let mut statement = db.prepare_cached(EXEC_BOUNDARY).unwrap();
            statement.reset_status(rusqlite::StatementStatus::VmStep);
            let selected: Vec<i64> = statement
                .query_map(rusqlite::params!["invocation", sequence, true], |row| {
                    row.get(0)
                })
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            costs[index] = statement.get_status(rusqlite::StatementStatus::VmStep) as usize;
            assert_eq!(selected.len(), expected);
        }
        costs
    }

    #[test]
    fn message_and_tool_rows_do_not_replay_prior_executor_text() {
        let small = boundary_cost(256);
        let large = boundary_cost(16_384);
        for (small, large) in small.into_iter().zip(large) {
            assert!(
                small > 0 && large < small * 2,
                "prior unrelated output caused a sweep: {small} -> {large}"
            );
        }
    }
}
