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
use rusqlite::{Connection as RawConnection, OptionalExtension, params};
use sqlx::SqliteConnection;
use sqlx::sqlite::SqliteWorkerConnection;

const HIGH: &str = r#"SELECT COALESCE(MAX(sequence), 0) FROM event_log"#;
const EXEC_BOUNDARY: &str = r#"SELECT sequence FROM runtime_events
             WHERE invocation_id = ?1 AND sequence <= ?2 AND kind = 'invocation_opened'
             UNION
             SELECT sequence FROM runtime_events
             WHERE invocation_id = ?1 AND sequence <= ?2 AND kind = 'executor_started'
             UNION
             SELECT sequence FROM runtime_events
             WHERE invocation_id = ?1 AND sequence <= ?2 AND ?3 AND sequence = ?2
             UNION
             SELECT sequence FROM runtime_events
             WHERE invocation_id = ?1 AND sequence <= ?2
               AND kind IN ('executor_observed','executor_completed')
               AND json_extract(event_json, '$.fact.output.toolCallId') =
                   (SELECT json_extract(event_json, '$.fact.output.toolCallId') FROM runtime_events WHERE sequence = ?2)
             ORDER BY sequence"#;
const EXEC_REST: &str = r#"SELECT sequence FROM runtime_events
             WHERE invocation_id = ?1 AND sequence <= ?2 AND (
                 kind IN ('invocation_opened','executor_started')
                 OR (?3 AND sequence = ?2)
                 OR (kind IN ('executor_observed','executor_completed') AND (
                     NOT ?3 OR NOT EXISTS(SELECT 1 FROM runtime_events boundary WHERE boundary.sequence = ?2 AND boundary.kind = 'executor_observed')
                     OR json_extract(event_json, '$.fact.output.toolCallId') =
                         (SELECT json_extract(event_json, '$.fact.output.toolCallId') FROM runtime_events WHERE sequence = ?2))))
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
  AND CAST(json_extract(event_json, '$.fact.step_id') AS TEXT) = ?2
  AND json_extract(event_json, '$.fact.step_id') = ?2
ORDER BY sequence"#;
const FACT: &str = r#"SELECT event_json FROM runtime_events WHERE sequence = ?"#;
const PENDING: &str = r#"SELECT operation_id FROM runtime_events AS request
         WHERE invocation_id = ?1 AND sequence <= ?2 AND kind = 'model_requested'
           AND EXISTS(SELECT 1 FROM runtime_events opening
               WHERE opening.invocation_id = request.invocation_id AND opening.kind = 'invocation_opened'
               AND json_extract(opening.event_json, '$.fact.input.kind') IN ('message', 'continuation', 'handoff'))
           AND json_extract(request.event_json, '$.fact.purpose') = 'main'
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

#[derive(sqlx::FromRow)]
struct Metadata {
    kind: Option<String>,
    tool: bool,
    external: bool,
}

/// Live and preparation readers use the same metadata and selection policy.
/// Both queries remain inside the reader's original transaction.
pub(super) async fn selected(
    tx: &mut SqliteConnection,
    invocation: &str,
    step: Option<&str>,
    through: i64,
    boundary: bool,
) -> Result<Vec<i64>, StoreError> {
    let invocation = invocation.to_owned();
    let step = step.map(str::to_owned);
    crate::connection::worker_query(tx, move |worker| {
        Box::pin(async move {
            selected_on_worker(worker, &invocation, step.as_deref(), through, boundary).await
        })
    })
    .await
}

pub(super) async fn selected_on_worker(
    tx: &mut SqliteWorkerConnection<'_>,
    invocation: &str,
    step: Option<&str>,
    through: i64,
    boundary: bool,
) -> Result<Vec<i64>, StoreError> {
    let metadata = sqlx::query_as::<_, Metadata>(PLAN)
        .bind(invocation)
        .bind(through)
        .bind(boundary)
        .fetch_one(&mut *tx)
        .await?;
    let mut selection =
        if let Some(selection) = plan(metadata, invocation, step, through, boundary)? {
            selection
        } else {
            // SAFETY: the worker exclusively owns this borrowed handle. All
            // temporary raw statements are dropped before SQLx resumes.
            let db = unsafe { RawConnection::from_handle(tx.as_raw_handle().as_ptr()) }?;
            db.set_prepared_statement_cache_capacity(100);
            super::tools::selection(&db, invocation, through)?
        };
    if let Some(slot) = selection.pending_step_slot() {
        *slot = match sqlx::query_scalar::<_, Option<String>>(PENDING)
            .bind(invocation)
            .bind(through)
            .fetch_optional(&mut *tx)
            .await?
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
    selection.read(tx).await
}

pub(super) async fn fence(tx: &mut SqliteConnection, through: u64) -> Result<i64, StoreError> {
    let through = i64::try_from(through).map_err(|_| ProjectionError::OutOfRange)?;
    let high: i64 = sqlx::query_scalar(HIGH).fetch_one(tx).await?;
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

pub(super) async fn fact(
    tx: &mut SqliteConnection,
    sequence: i64,
) -> Result<StoredEvent, StoreError> {
    let json: String = sqlx::query_scalar(FACT)
        .bind(sequence)
        .fetch_one(tx)
        .await?;
    decoded_fact(sequence, &json)
}

pub(super) fn fact_on_handle(db: &RawConnection, sequence: i64) -> Result<StoredEvent, StoreError> {
    let json: String = db
        .prepare_cached(FACT)?
        .query_row([sequence], |row| row.get(0))?;
    decoded_fact(sequence, &json)
}

fn decoded_fact(sequence: i64, json: &str) -> Result<StoredEvent, StoreError> {
    Ok(StoredEvent {
        sequence: sequence_number(sequence)?,
        event: serde_json::from_str(json)?,
    })
}

pub(super) async fn pending_step_on_worker(
    tx: &mut SqliteWorkerConnection<'_>,
    invocation: &str,
    through: i64,
) -> Result<Option<String>, StoreError> {
    Ok(sqlx::query_scalar(PENDING)
        .bind(invocation)
        .bind(through)
        .fetch_optional(tx)
        .await?)
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
/// results or borrowed connection state survive the worker callback.
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

    async fn read(&self, tx: &mut SqliteWorkerConnection<'_>) -> Result<Vec<i64>, StoreError> {
        // UNION removes overlaps; CAST uses the index while original JSON
        // equality preserves malformed non-string step-ID selection semantics.
        let query = sqlx::query_scalar(self.sql());
        Ok(match self {
            Self::Step {
                invocation,
                step,
                through,
                boundaries,
                completed,
            } => {
                query
                    .bind(invocation)
                    .bind(step)
                    .bind(through)
                    .bind(boundaries)
                    .bind(completed)
                    .fetch_all(tx)
                    .await?
            }
            Self::ExecutorBoundary {
                invocation,
                through,
                boundary,
            }
            | Self::ExecutorRest {
                invocation,
                through,
                boundary,
            } => {
                query
                    .bind(invocation)
                    .bind(through)
                    .bind(boundary)
                    .fetch_all(tx)
                    .await?
            }
        })
    }
}
