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

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sqlx::{Connection, SqliteConnection};

use super::{MAX_SAFE_INTEGER, SessionRecord, advance_catalog, invalid, validate_id};
use crate::{EventLog, StoreError};

/// Mutable control authority, independent of disposable execution projections.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionReadState {
    pub has_unread: bool,
    pub last_read_message_id: Option<String>,
}

pub(super) async fn read(
    connection: &mut SqliteConnection,
    id: &str,
) -> Result<SessionReadState, StoreError> {
    let state: Option<(bool, Option<String>)> = sqlx::query_as(
        "SELECT has_unread, last_read_message_id FROM session_read_state WHERE session_id = ?",
    )
    .bind(id)
    .fetch_optional(connection)
    .await?;
    Ok(state.map_or_else(
        SessionReadState::default,
        |(has_unread, last_read_message_id)| SessionReadState {
            has_unread,
            last_read_message_id,
        },
    ))
}

/// Called only for newly inserted terminal facts, in their append transaction.
pub(crate) async fn mark_unread(
    connection: &mut SqliteConnection,
    id: &str,
    invocation: &str,
) -> Result<(), StoreError> {
    sqlx::query(
        "INSERT INTO session_read_state (session_id, has_unread, last_read_message_id)
         SELECT id, 1, NULL FROM session_control WHERE id = ?1
         AND NOT EXISTS (SELECT 1 FROM runtime_events
             WHERE invocation_id = ?2 AND kind = 'invocation_opened'
             AND json_extract(event_json, '$.fact.input.kind') = 'context_compact')
         ON CONFLICT(session_id) DO UPDATE SET has_unread = 1",
    )
    .bind(id)
    .bind(invocation)
    .execute(connection)
    .await?;
    Ok(())
}

impl EventLog {
    /// Acknowledge only the durable visible tail, including during active execution.
    pub async fn set_session_read_marker<T: DeserializeOwned + Send + 'static>(
        &self,
        id: &str,
        message_id: &str,
    ) -> Result<SessionRecord<T>, StoreError> {
        self.validate_root()?;
        validate_id(id)?;
        validate_id(message_id)?;
        let (id, message_id) = (id.to_owned(), message_id.to_owned());
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
                let record: SessionRecord<T> = super::read(&mut tx, &id)
                    .await?.ok_or(StoreError::SessionNotFound)?;
                let latest = super::activity::latest_visible_message(&mut tx, &id).await?;
                if latest.as_deref() != Some(message_id.as_str())
                    || (!record.read_state.has_unread
                        && record.read_state.last_read_message_id.as_deref() == Some(message_id.as_str()))
                {
                    return Ok(record);
                }
                if record.revision >= MAX_SAFE_INTEGER {
                    return Err(invalid("session revision exhausted"));
                }
                sqlx::query(
                    "INSERT INTO session_read_state (session_id, has_unread, last_read_message_id)
                     VALUES (?, 0, ?) ON CONFLICT(session_id) DO UPDATE
                     SET has_unread = 0, last_read_message_id = excluded.last_read_message_id",
                ).bind(&id).bind(&message_id).execute(&mut *tx).await?;
                if sqlx::query(
                    "UPDATE session_control SET revision = revision + 1 WHERE id = ? AND revision < ?",
                ).bind(&id).bind(MAX_SAFE_INTEGER as i64).execute(&mut *tx).await?.rows_affected() != 1 {
                    return Err(invalid("session revision exhausted"));
                }
                advance_catalog(&mut tx).await?;
                let record = super::read(&mut tx, &id).await?.ok_or(StoreError::SessionNotFound)?;
                tx.commit().await.map_err(StoreError::CommitUnknown)?;
                Ok(record)
                })
            })
            .await
    }
}
