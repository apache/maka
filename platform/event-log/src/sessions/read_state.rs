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

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use super::{MAX_SAFE_INTEGER, SessionRecord, advance_catalog, invalid, validate_id};
use crate::{EventLog, StoreError};

/// Mutable control authority, independent of disposable execution projections.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionReadState {
    pub has_unread: bool,
    pub last_read_message_id: Option<String>,
}

pub(super) fn read(
    connection: &rusqlite::Connection,
    id: &str,
) -> Result<SessionReadState, StoreError> {
    let state: Option<(bool, Option<String>)> = connection
        .query_row(
            "SELECT has_unread, last_read_message_id FROM session_read_state WHERE session_id = ?",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    Ok(state.map_or_else(
        SessionReadState::default,
        |(has_unread, last_read_message_id)| SessionReadState {
            has_unread,
            last_read_message_id,
        },
    ))
}

/// Called only for newly inserted terminal facts, in their append transaction.
pub(crate) fn mark_unread(
    connection: &rusqlite::Connection,
    id: &str,
    invocation: &str,
) -> Result<(), StoreError> {
    connection.execute(
        "INSERT INTO session_read_state (session_id, has_unread, last_read_message_id)
         SELECT id, 1, NULL FROM session_control WHERE id = ?1
         AND NOT EXISTS (SELECT 1 FROM runtime_events
             WHERE invocation_id = ?2 AND kind = 'invocation_opened'
             AND json_extract(event_header, '$.fact.input.kind') = 'context_compact')
         ON CONFLICT(session_id) DO UPDATE SET has_unread = 1",
        params![id, invocation],
    )?;
    Ok(())
}

impl EventLog {
    /// Acknowledge only the durable visible tail, including during active execution.
    pub async fn set_session_read_marker<T: DeserializeOwned + Send + 'static>(
        &self,
        id: &str,
        message_id: &str,
    ) -> Result<SessionRecord<T>, StoreError> {
        validate_id(id)?;
        validate_id(message_id)?;
        let (id, message_id) = (id.to_owned(), message_id.to_owned());
        self.connection
            .run(move |connection| {
                {
                let tx = rusqlite::Transaction::new_unchecked(connection, rusqlite::TransactionBehavior::Immediate)?;
                let record: SessionRecord<T> = super::read(&tx, &id)
                    ?.ok_or(StoreError::SessionNotFound)?;
                let latest = super::activity::latest_visible_message(&tx, &id)?;
                if latest.as_deref() != Some(message_id.as_str())
                    || (!record.read_state.has_unread
                        && record.read_state.last_read_message_id.as_deref() == Some(message_id.as_str()))
                {
                    return Ok(record);
                }
                if record.revision >= MAX_SAFE_INTEGER {
                    return Err(invalid("session revision exhausted"));
                }
                tx.execute("INSERT INTO session_read_state (session_id, has_unread, last_read_message_id)
                     VALUES (?, 0, ?) ON CONFLICT(session_id) DO UPDATE
                     SET has_unread = 0, last_read_message_id = excluded.last_read_message_id", params![&id, &message_id])?;
                if tx.execute("UPDATE session_control SET revision = revision + 1 WHERE id = ? AND revision < ?", params![&id, MAX_SAFE_INTEGER as i64])? != 1 {
                    return Err(invalid("session revision exhausted"));
                }
                advance_catalog(&tx)?;
                let record = super::read(&tx, &id)?.ok_or(StoreError::SessionNotFound)?;
                tx.commit().map_err(StoreError::CommitUnknown)?;
                Ok(record)
                }
            })
            .await
    }
}
