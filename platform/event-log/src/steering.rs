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

use crate::{EventLog, StoreError, sequence_number};
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::event::StoredEvent;
use sqlx::SqliteConnection;

/// Executed inside the event transaction, after exact replay/identity/seal checks.
pub(crate) async fn validate_append(
    tx: &mut SqliteConnection,
    event: &RuntimeEvent,
) -> Result<(), StoreError> {
    let Fact::MessageSteered { message, source } = &event.fact else {
        return Ok(());
    };
    maka_agent_facts::event::validate_steered_source(message, source, &event.invocation.session_id)
        .map_err(|error| StoreError::InvalidTransition(error.into()))?;
    let eligible: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM runtime_events WHERE invocation_id = ?
         AND kind = 'invocation_opened' AND json_extract(event_header, '$.fact.input.kind') IN ('message', 'continuation', 'handoff'))"
    ).bind(&event.invocation.invocation_id).fetch_one(&mut *tx).await?;
    if !eligible {
        return Err(StoreError::InvalidTransition(
            "steering requires an inline model invocation".into(),
        ));
    }
    let pending: bool = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "{} SELECT EXISTS(SELECT 1 FROM unresolved u WHERE kind != 0
          OR NOT EXISTS(SELECT 1 FROM context_execution_steps s WHERE s.invocation_id=?1
            AND s.operation_id=u.id AND s.purpose='summary' AND s.tool_observed_at IS NULL))",
        crate::recovery::unresolved!(""),
    )))
    .bind(&event.invocation.invocation_id)
    .fetch_one(&mut *tx)
    .await?;
    if pending {
        return Err(StoreError::InvalidTransition(
            "steering requires settled model and tool boundaries".into(),
        ));
    }
    // The unique canonical index rejects a different event claiming this same
    // Session/message identity. Exact event replay was already handled by append.
    Ok(())
}

impl EventLog {
    /// One immutable delivery proof, never a queue revision or guessed retry result.
    pub async fn steering_message(
        &self,
        session_id: &str,
        message_id: &str,
    ) -> Result<Option<StoredEvent>, StoreError> {
        self.validate_root()?;
        crate::sessions::validate_id(session_id)?;
        crate::sessions::validate_id(message_id)?;
        let session_id = session_id.to_owned();
        let message_id = message_id.to_owned();
        self.connection
            .run(move |tx| {
                Box::pin(async move {
                    let row: Option<(i64, String)> = sqlx::query_as(
                        "SELECT e.sequence, e.event_header FROM message_sources s JOIN runtime_events e ON e.event_id = s.event_id
                 WHERE e.kind = 'message_steered' AND s.session_id = ? AND s.message_id = ?",
                    )
                    .bind(&session_id)
                    .bind(&message_id)
                    .fetch_optional(tx)
                    .await?;
                    row.map(|(sequence, json)| {
                        let event: RuntimeEvent = serde_json::from_str(&json)?;
                        let Fact::MessageSteered { message, source } = &event.fact else {
                            return Err(StoreError::InvalidTransition(
                                "invalid steering proof".into(),
                            ));
                        };
                        maka_agent_facts::event::validate_steered_source(
                            message, source, &event.invocation.session_id,
                        )
                            .map_err(|error| StoreError::InvalidTransition(error.into()))?;
                        if event.invocation.session_id != session_id
                            || message.message_id != message_id
                        {
                            return Err(StoreError::InvalidTransition(
                                "steering proof identity changed".into(),
                            ));
                        }
                        Ok(StoredEvent {
                            sequence: sequence_number(sequence)?,
                            event,
                        })
                    })
                    .transpose()
                })
            })
            .await
    }
}

pub(crate) async fn project_catalog(
    tx: &mut SqliteConnection,
    sequence: i64,
    session: &str,
) -> Result<(), StoreError> {
    sqlx::query(
        "INSERT OR IGNORE INTO catalog_messages
         SELECT sequence, 0, ?2, catalog_time(json_extract(event_header, '$.recorded_at')),
             catalog_preview(COALESCE(
                 json_extract(event_header, '$.fact.message.content.display_text'),
                 json_extract(event_header, '$.fact.message.content.text'))),
             json_extract(event_header, '$.fact.message.message_id')
         FROM runtime_events WHERE sequence = ?1 AND kind = 'message_steered'",
    )
    .bind(sequence)
    .bind(session)
    .execute(tx)
    .await?;
    Ok(())
}
