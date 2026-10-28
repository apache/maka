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
use sqlx::SqliteConnection;

pub(crate) enum Position {
    /// Native admission retains its visible-message namespace guard.
    Admitted,
    /// Import validation owns identity admission and may preserve a sequence.
    Imported(Option<u64>),
}

pub(crate) async fn insert(
    connection: &mut SqliteConnection,
    event: &RuntimeEvent,
    json: String,
    position: Position,
) -> Result<u64, StoreError> {
    let event = event.clone();
    crate::connection::worker_query(connection, move |worker| Box::pin(async move {
        // SAFETY: this callback exclusively borrows the original SQLite worker;
        // inspect its actual state, including externally established transactions.
        if unsafe { rusqlite::ffi::sqlite3_get_autocommit(worker.as_raw_handle().as_ptr()) } != 0 {
            return Err(StoreError::InvalidTransition(
                "canonical ingress requires an existing transaction".into(),
            ));
        }
        let inserted = match position {
            Position::Admitted => {
                let claimed: bool = sqlx::query_scalar(
                    "SELECT EXISTS(
                         SELECT 1 FROM session_message_sources WHERE owner_session_id=?1 AND message_id=?2
                         UNION ALL SELECT 1 FROM message_admissions WHERE session_id=?1 AND message_id=?2)",
                ).bind(&event.invocation.session_id).bind(&event.id)
                    .fetch_one(&mut *worker).await?;
                if claimed {
                    return Err(StoreError::EventConflict);
                }
                sqlx::query(
                    "INSERT INTO event_log (event_id, invocation_id, kind, operation_id, event_json) VALUES(?,?,?,?,?)",
                ).bind(&event.id).bind(&event.invocation.invocation_id).bind(event.fact.kind())
                    .bind(event.fact.operation_id()).bind(&json)
                    .execute(&mut *worker).await?
            },
            Position::Imported(sequence) => sqlx::query(
                "INSERT INTO event_log(sequence,event_id,invocation_id,kind,operation_id,event_json) VALUES(?,?,?,?,?,?)",
            ).bind(sequence.map(i64::try_from).transpose().map_err(|_| StoreError::PrefixTooLarge)?)
                .bind(&event.id).bind(&event.invocation.invocation_id).bind(event.fact.kind())
                .bind(event.fact.operation_id()).bind(&json)
                .execute(&mut *worker).await?,
        };
        if inserted.rows_affected() != 1 {
            return Err(StoreError::EventConflict);
        }
        // Capture before the projections issue INSERTs on this same handle.
        let sequence = sequence_number(inserted.last_insert_rowid())?;
        let stored = StoredEvent { sequence, event };
        crate::context::projection::record(worker, &stored, &json).await?;
        crate::context::evidence::record(worker, &stored, &json).await?;
        crate::context::semantic::record(worker, &stored).await?;
        Ok(sequence)
    })).await
}

#[cfg(test)]
mod tests;
