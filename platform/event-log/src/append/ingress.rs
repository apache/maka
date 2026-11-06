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

//! RuntimeEvent ingress and its derived projections share the caller's
//! transaction. No effect receipt can escape before that transaction commits.
use crate::{StoreError, sequence_number};
use maka_agent_facts::event::{RuntimeEvent, StoredEvent};

pub(crate) enum Position {
    /// Native admission retains its visible-message namespace guard.
    Admitted,
    /// Import validation owns identity admission and may preserve a sequence.
    Imported(Option<u64>),
}

pub(crate) fn insert(
    connection: &rusqlite::Connection,
    event: &RuntimeEvent,
    json: String,
    position: Position,
) -> Result<u64, StoreError> {
    let prepared = crate::canonical::PreparedCanonical::new(event, json)?;
    insert_prepared(connection, event, prepared, position)
}

pub(crate) fn insert_prepared(
    connection: &rusqlite::Connection,
    event: &RuntimeEvent,
    prepared: crate::canonical::PreparedCanonical,
    position: Position,
) -> Result<u64, StoreError> {
    let event = event.clone();
    let worker = connection;
    {
        if worker.is_autocommit() {
            return Err(StoreError::InvalidTransition(
                "canonical ingress requires an existing transaction".into(),
            ));
        }
        let requested_sequence = match position {
            Position::Admitted => {
                let claimed: bool = worker.prepare_cached("SELECT EXISTS(
                         SELECT 1 FROM session_message_sources WHERE owner_session_id=?1 AND message_id=?2
                         UNION ALL SELECT 1 FROM message_admissions WHERE session_id=?1 AND message_id=?2
                         UNION ALL SELECT 1 FROM model_part_records p WHERE p.message_id=?2
                         AND EXISTS(SELECT 1 FROM session_history_events e WHERE e.event_id=p.event_id AND e.owner_session_id=?1))")?.query_row(rusqlite::params![&event.invocation.session_id, &event.id], |row| row.get(0))?;
                if claimed {
                    return Err(StoreError::EventConflict);
                }
                None
            }
            Position::Imported(sequence) => sequence
                .map(i64::try_from)
                .transpose()
                .map_err(|_| StoreError::PrefixTooLarge)?,
        };
        let body = prepared.bind_body(worker)?;
        let json = &prepared.json;
        let inserted = crate::canonical_insert::insert_header(
            worker,
            crate::canonical_insert::Record {
                sequence: requested_sequence,
                event_id: &event.id,
                invocation_id: Some(&event.invocation.invocation_id),
                kind: event.fact.kind(),
                operation_id: event.fact.operation_id(),
                json: prepared.header.as_deref().unwrap_or(json),
            },
            json.len(),
            body,
        )?;
        if inserted != 1 {
            return Err(StoreError::EventConflict);
        }
        // Capture before the projections issue INSERTs on this same handle.
        let sequence = sequence_number(worker.last_insert_rowid())?;
        let stored = StoredEvent { sequence, event };
        crate::model_items::record(worker, &stored)?;
        crate::context::projection::record(worker, &stored, json)?;
        crate::context::evidence::record(worker, &stored, json)?;
        crate::context::semantic::record_prepared(worker, &stored, prepared.semantic)?;
        Ok(sequence)
    }
}

#[cfg(test)]
mod tests;
