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

//! Scalar canonical evidence for an assistant row's model and output producer.
use crate::StoreError;
use maka_agent_facts::history::RowPosition;
use maka_agent_ports::session::history::HistoryModel;
use rusqlite::{Connection, OptionalExtension};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Producer {
    Model {
        invocation: String,
        step: String,
    },
    Executor {
        invocation: String,
        message_id: String,
    },
}

pub(super) struct Metadata {
    pub model: Option<HistoryModel>,
    pub producer: Option<Producer>,
}

// Drive each lookup from the canonical sequence/operation/step index. Membership
// validates each candidate; the history UNION must not drive a whole-session scan.
const PRODUCER: &str = "SELECT e.invocation_id, e.kind, e.operation_id
FROM runtime_events e WHERE e.sequence = ?2 AND e.sequence <= ?3
  AND (e.event_session=?1 OR EXISTS(SELECT 1 FROM session_history_members h WHERE h.session_id=?1 AND h.sequence=e.sequence) OR EXISTS(SELECT 1 FROM history_snapshot_sessions s JOIN history_snapshot_members m USING(capture_key,session_id) WHERE s.owner_key=?1 AND m.sequence=e.sequence))";
const REQUESTED: &str = "SELECT json_extract(e.event_header, '$.fact.model_id')
FROM runtime_events e WHERE e.operation_id = ?3 AND e.kind = 'model_requested'
  AND e.invocation_id = ?2 AND e.sequence <= ?4
  AND json_extract(e.event_header, '$.fact.step_id') = ?3
  AND (e.event_session=?1 OR EXISTS(SELECT 1 FROM session_history_members h WHERE h.session_id=?1 AND h.sequence=e.sequence) OR EXISTS(SELECT 1 FROM history_snapshot_sessions s JOIN history_snapshot_members m USING(capture_key,session_id) WHERE s.owner_key=?1 AND m.sequence=e.sequence))";
const OBSERVED: &str = "SELECT e.sequence, json_extract(e.event_header, '$.fact.event.data.model')
FROM runtime_events e WHERE e.invocation_id = ?2
  AND CAST(json_extract(e.event_header, '$.fact.step_id') AS TEXT) = ?3
  AND json_extract(e.event_header, '$.fact.step_id') = ?3
  AND e.sequence <= ?4 AND e.kind = 'model_observed' AND e.event_header IS NOT NULL
  AND json_extract(e.event_header, '$.fact.event.kind') = 'response_metadata'
  AND json_type(e.event_header, '$.fact.event.data.model') = 'text'
  AND (e.event_session=?1 OR EXISTS(SELECT 1 FROM session_history_members h WHERE h.session_id=?1 AND h.sequence=e.sequence) OR EXISTS(SELECT 1 FROM history_snapshot_sessions s JOIN history_snapshot_members m USING(capture_key,session_id) WHERE s.owner_key=?1 AND m.sequence=e.sequence))
ORDER BY e.sequence DESC LIMIT 1";
const COMPLETED: &str = "SELECT e.sequence, json_extract(e.event_header, '$.fact.output.model')
FROM runtime_events e WHERE e.operation_id = ?3 AND e.kind = 'model_completed'
  AND e.invocation_id = ?2 AND e.sequence <= ?4
  AND json_extract(e.event_header, '$.fact.step_id') = ?3
  AND json_type(e.event_header, '$.fact.output.model') = 'text'
  AND (e.event_session=?1 OR EXISTS(SELECT 1 FROM session_history_members h WHERE h.session_id=?1 AND h.sequence=e.sequence) OR EXISTS(SELECT 1 FROM history_snapshot_sessions s JOIN history_snapshot_members m USING(capture_key,session_id) WHERE s.owner_key=?1 AND m.sequence=e.sequence))";
const EXECUTOR: &str = "SELECT EXISTS(SELECT 1 FROM runtime_events e
WHERE e.invocation_id = ?2 AND e.kind = 'executor_started' AND e.sequence <= ?3
  AND (e.event_session=?1 OR EXISTS(SELECT 1 FROM session_history_members h WHERE h.session_id=?1 AND h.sequence=e.sequence) OR EXISTS(SELECT 1 FROM history_snapshot_sessions s JOIN history_snapshot_members m USING(capture_key,session_id) WHERE s.owner_key=?1 AND m.sequence=e.sequence)))";

pub(super) fn resolve(
    tx: &Connection,
    session: &str,
    position: RowPosition,
    through: i64,
) -> Result<Metadata, StoreError> {
    resolve_on_worker(tx, session, position, through)
}

pub(super) fn resolve_on_worker(
    tx: &rusqlite::Connection,
    session: &str,
    position: RowPosition,
    through: i64,
) -> Result<Metadata, StoreError> {
    let producer_sequence = super::read::sql_position(position)?.0;
    let producer = tx
        .query_row(
            PRODUCER,
            rusqlite::params![session, producer_sequence, through],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(invalid)?;
    let invocation: String = producer.0;
    let kind: String = producer.1;
    if kind == "message_imported" {
        let (content, model): (String, Option<String>) = tx.query_row(
            "SELECT json_extract(event_header, '$.fact.record.content.kind'),
                json_extract(event_header, '$.fact.record.content.model')
             FROM runtime_events WHERE sequence = ?",
            rusqlite::params![producer_sequence],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if content != "assistant" {
            return Err(invalid());
        }
        return Ok(Metadata {
            model: model.map(|model_id| HistoryModel::Imported { model_id }),
            producer: None,
        });
    }
    if matches!(kind.as_str(), "executor_observed" | "executor_completed") {
        return Ok(Metadata {
            model: None,
            producer: if kind == "executor_observed" {
                let message_id: Option<String> = tx.query_row("SELECT json_extract(event_header, '$.fact.output.messageId') FROM runtime_events WHERE sequence=?", rusqlite::params![producer_sequence], |row| row.get(0))?;
                message_id.map(|message_id| Producer::Executor {
                    invocation,
                    message_id,
                })
            } else {
                None
            },
        });
    }
    let step: Option<String> = if kind == "invocation_ended" {
        let executor: bool = tx.query_row(
            EXECUTOR,
            rusqlite::params![session, &invocation, producer_sequence],
            |row| row.get(0),
        )?;
        if executor {
            return Ok(Metadata {
                model: None,
                producer: None,
            });
        }
        // Resolve the unfinished step at the actual sealing fact, never from a
        // later public fence that may contain unrelated model steps.
        super::evidence::pending_step_on_worker(tx, &invocation, producer_sequence)?
    } else if kind == "model_observed" {
        tx.query_row("SELECT json_extract(event_header, '$.fact.step_id') FROM runtime_events WHERE sequence = ?", rusqlite::params![producer_sequence], |row| row.get(0))?
    } else if matches!(kind.as_str(), "model_completed" | "model_interrupted") {
        producer.2
    } else {
        return Err(invalid());
    };
    let step = step.ok_or_else(invalid)?;
    let requested: Option<String> = tx
        .query_row(
            REQUESTED,
            rusqlite::params![session, &invocation, &step, through],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    let requested_model_id = requested.ok_or_else(invalid)?;
    let observed: Option<(i64, String)> = tx
        .query_row(
            OBSERVED,
            rusqlite::params![session, &invocation, &step, through],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let completed: Option<(i64, String)> = tx
        .query_row(
            COMPLETED,
            rusqlite::params![session, &invocation, &step, through],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let reported_model_id = observed
        .into_iter()
        .chain(completed)
        .max_by_key(|(sequence, _)| *sequence)
        .map(|(_, model)| model);
    Ok(Metadata {
        model: Some(HistoryModel::Native {
            requested_model_id,
            reported_model_id,
        }),
        producer: matches!(kind.as_str(), "model_observed" | "model_completed")
            .then_some(Producer::Model { invocation, step }),
    })
}
fn invalid() -> StoreError {
    StoreError::InvalidTransition("invalid canonical history model evidence".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde_json::json;

    #[test]
    fn identity_queries_seek_scalar_candidates_instead_of_scanning_step_observations() {
        // Isolate these SQL selection/plan fixtures from admitted-fact reducers:
        // some rows intentionally omit fields or contain a numeric step ID.
        // Use the production ledger DDL and lookup indexes without writer triggers.
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute_batch(&crate::schema::fixture(|kind, _| kind != "trigger"))
            .unwrap();
        let result: Result<(), StoreError> = (|| {
            let db = &connection;
            // This SQL-plan fixture deliberately writes only columns used by the
            // scalar queries; canonical admission behavior is covered by history.
            let mut sequence = 0i64;
            for step in ["with-report", "without-report"] {
                sequence += 1;
                let requested = json!({"invocation":{"session_id":"source"},"fact":{"kind":"model_requested","step_id":step,"model_id":format!("alias-{step}")}});
                crate::canonical_insert::insert(
                    db,
                    crate::canonical_insert::Record {
                        sequence: Some(sequence),
                        event_id: &format!("event-{sequence}"),
                        invocation_id: Some("invocation"),
                        kind: "model_requested",
                        operation_id: Some(step),
                        json: &requested.to_string(),
                    },
                )?;
                for delta in 0..128 {
                    sequence += 1;
                    let event = if step == "with-report" && delta == 0 {
                        json!({"kind":"response_metadata","data":{"model":"reported-early"}})
                    } else {
                        json!({"kind":"provider_options","data":{"provider_part_id":"part","options":{"opaque":"metadata"}}})
                    };
                    let observed = json!({"invocation":{"session_id":"source"},"fact":{"kind":"model_observed","step_id":step,"event":event}});
                    crate::canonical_insert::insert(
                        db,
                        crate::canonical_insert::Record {
                            sequence: Some(sequence),
                            event_id: &format!("event-{sequence}"),
                            invocation_id: Some("invocation"),
                            kind: "model_observed",
                            operation_id: None,
                            json: &observed.to_string(),
                        },
                    )?;
                }
                sequence += 1;
                let completed = json!({"invocation":{"session_id":"source"},"fact":{"kind":"model_completed","step_id":step,"output":{"model":if step=="with-report" {Some("reported-final")} else {None},"parts":[{"text":"large output".repeat(16384)}]}}});
                crate::canonical_insert::insert(
                    db,
                    crate::canonical_insert::Record {
                        sequence: Some(sequence),
                        event_id: &format!("event-{sequence}"),
                        invocation_id: Some("invocation"),
                        kind: "model_completed",
                        operation_id: Some(step),
                        json: &completed.to_string(),
                    },
                )?;
            }
            for (query, expected_index) in [
                (REQUESTED, "operation_fact"),
                (OBSERVED, "model_response_identity"),
                (COMPLETED, "operation_fact"),
            ] {
                let explain = format!("EXPLAIN QUERY PLAN {query}");
                let plan = db
                    .prepare_cached(&explain)?
                    .query_map(
                        rusqlite::params!["source", "invocation", "with-report", sequence],
                        |row| row.get::<_, String>(3),
                    )?
                    .collect::<Result<Vec<_>, _>>()?
                    .join("\n");
                assert!(
                    plan.contains(&format!("USING INDEX {expected_index}")),
                    "{plan}"
                );
                assert!(
                    !plan.contains("SCAN event_log")
                        && !plan.contains("SCAN h")
                        && !plan.contains("USE TEMP B-TREE"),
                    "{plan}"
                );
            }
            let requested: String = db.query_row(
                REQUESTED,
                rusqlite::params!["source", "invocation", "with-report", sequence],
                |row| row.get(0),
            )?;
            assert_eq!(requested, "alias-with-report");
            let observed: (i64, String) = db.query_row(
                OBSERVED,
                rusqlite::params!["source", "invocation", "with-report", sequence],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(observed, (2, "reported-early".into()));
            let completed: (i64, String) = db.query_row(
                COMPLETED,
                rusqlite::params!["source", "invocation", "with-report", sequence],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(completed, (130, "reported-final".into()));
            let absent: Option<(i64, String)> = db
                .query_row(
                    OBSERVED,
                    rusqlite::params!["source", "invocation", "without-report", sequence],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            assert_eq!(absent, None);
            Ok(())
        })();
        result.unwrap();
    }
}
