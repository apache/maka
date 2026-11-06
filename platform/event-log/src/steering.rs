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
use rusqlite::{Connection, OptionalExtension};

/// Executed inside the event transaction, after exact replay/identity/seal checks.
pub(crate) fn validate_append(tx: &Connection, event: &RuntimeEvent) -> Result<(), StoreError> {
    let Fact::MessageSteered { message, source } = &event.fact else {
        return Ok(());
    };
    maka_agent_facts::event::validate_steered_source(message, source, &event.invocation.session_id)
        .map_err(|error| StoreError::InvalidTransition(error.into()))?;
    let (eligible, executor): (bool, bool) = tx.query_row("SELECT EXISTS(SELECT 1 FROM runtime_events WHERE invocation_id = ?1
         AND kind = 'invocation_opened' AND json_extract(event_header, '$.fact.input.kind') IN ('message', 'continuation', 'handoff')),
         EXISTS(SELECT 1 FROM runtime_events WHERE invocation_id = ?1 AND kind = 'executor_started')", rusqlite::params![&event.invocation.invocation_id], |row| Ok((row.get(0)?, row.get(1)?,)))?;
    if !eligible {
        return Err(StoreError::InvalidTransition(
            "steering requires a message-capable invocation".into(),
        ));
    }
    // An executor cannot dispatch Maka model steps. Its Host SDK effects keep
    // their original custody through settlement; new input does not settle them.
    if !executor {
        crate::context::safety::model_boundary(
            tx,
            &event.invocation.invocation_id,
            i64::MAX as u64,
        )?;
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
        crate::sessions::validate_id(session_id)?;
        crate::sessions::validate_id(message_id)?;
        let session_id = session_id.to_owned();
        let message_id = message_id.to_owned();
        self.connection
            .read(move |tx| {
                {
                    let row: Option<(i64, String)> = tx.query_row("SELECT e.sequence, e.event_header FROM message_sources s JOIN runtime_events e ON e.event_id = s.event_id
                 WHERE e.kind = 'message_steered' AND s.session_id = ? AND s.message_id = ?", rusqlite::params![&session_id, &message_id], |row| Ok((row.get(0)?, row.get(1)?,))).optional()
                    ?;
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
                }
            })
            .await
    }
}

pub(crate) fn project_catalog(
    tx: &Connection,
    sequence: i64,
    session: &str,
) -> Result<(), StoreError> {
    tx.execute(
        "INSERT OR IGNORE INTO catalog_messages
         SELECT sequence, 0, ?2, catalog_time(json_extract(event_header, '$.recorded_at')),
             catalog_preview(COALESCE(
                 json_extract(event_header, '$.fact.message.content.display_text'),
                 json_extract(event_header, '$.fact.message.content.text'))),
             json_extract(event_header, '$.fact.message.message_id')
         FROM runtime_events WHERE sequence = ?1 AND kind = 'message_steered'",
        rusqlite::params![sequence, session],
    )?;
    Ok(())
}
