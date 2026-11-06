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

use super::{MAX_SAFE_INTEGER, advance_catalog, invalid, number};
use crate::StoreError;
use maka_agent_facts::event::TerminalStatus;
use rusqlite::{OptionalExtension, params};
#[derive(Clone, Debug, PartialEq)]
pub struct SessionExecution {
    pub turn_id: String,
    pub state: SessionExecutionState,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CatalogMessage {
    pub recorded_at: u64,
    pub preview: Option<String>,
    /// Durable visible tail in sequence/ordinal order, independent of preview clocks.
    pub tail_message_id: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum SessionExecutionState {
    Live {
        recorded_at: u64,
    },
    Ended {
        status: TerminalStatus,
        recorded_at: u64,
    },
}

pub(crate) fn has_active_invocation(
    connection: &rusqlite::Connection,
    session: &str,
) -> Result<bool, StoreError> {
    // Local openings are admitted serially; bundle imports precede all local openings.
    // Thus only the latest canonical opening can own active local execution.
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM (
            SELECT invocation_id FROM event_log INDEXED BY catalog_message_facts
            WHERE invocation_id IS NOT NULL AND event_header IS NOT NULL
            AND kind IN ('invocation_opened', 'model_completed') AND kind = 'invocation_opened'
            AND json_extract(event_header, '$.invocation.session_id') = ?
            ORDER BY sequence DESC LIMIT 1
         ) AS opening
         WHERE NOT EXISTS(SELECT 1 FROM imported_invocations i
            WHERE i.invocation_id = opening.invocation_id)
         AND NOT EXISTS(SELECT 1 FROM runtime_events terminal
            WHERE terminal.invocation_id = opening.invocation_id
            AND terminal.kind = 'invocation_ended'))",
        params![session],
        |row| row.get(0),
    )?)
}

pub(super) fn read(
    connection: &rusqlite::Connection,
    id: &str,
) -> Result<Option<SessionExecution>, StoreError> {
    let opening = connection.query_row("SELECT invocation_id, json_extract(event_header, '$.invocation.turn_id'),
                catalog_time(json_extract(event_header, '$.recorded_at'))
         FROM event_log INDEXED BY catalog_message_facts
         WHERE invocation_id IS NOT NULL
         AND kind IN ('invocation_opened', 'model_completed') AND kind = 'invocation_opened'
         AND json_extract(event_header, '$.invocation.session_id') = ?
         AND NOT EXISTS(SELECT 1 FROM imported_invocations i WHERE i.invocation_id=event_log.invocation_id)
         ORDER BY sequence DESC LIMIT 1",params![id],|row| Ok((row.get::<_, String>(0)?,row.get::<_, String>(1)?,row.get::<_, i64>(2)?,))).optional()
    ?;
    let Some(opening) = opening else {
        return Ok(None);
    };
    let invocation_id: String = opening.0;
    let turn_id = opening.1;
    let opened_at = number(opening.2)?;
    let terminal = connection
        .query_row(
            "SELECT json_extract(event_header, '$.fact.outcome.kind'),
                catalog_time(json_extract(event_header, '$.recorded_at')),
                json_extract(event_header, '$.fact.outcome.outcome.kind') FROM event_log
                INDEXED BY invocation_boundary
         WHERE invocation_id = ? AND kind IN ('invocation_opened', 'invocation_ended')
         AND kind = 'invocation_ended' ORDER BY sequence DESC LIMIT 1",
            params![&invocation_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()?;
    let terminal = terminal
        .map(|row| -> Result<_, StoreError> {
            let kind: String = row.0;
            let recorded_at = number(row.1)?;
            Ok(SessionExecutionState::Ended {
                recorded_at,
                status: match kind.as_str() {
                    "context_compact_finished" if row.2.as_deref() == Some("failed") => {
                        Ok(TerminalStatus::Failed)
                    }
                    "completed" | "context_compact_finished" => Ok(TerminalStatus::Completed),
                    "failed" => Ok(TerminalStatus::Failed),
                    "cancelled" => Ok(TerminalStatus::Cancelled),
                    "handoff_paused" => Ok(TerminalStatus::Paused),
                    _ => Err(invalid("unknown stored invocation outcome")),
                }?,
            })
        })
        .transpose()?;
    Ok(Some(SessionExecution {
        turn_id,
        state: terminal.unwrap_or(SessionExecutionState::Live {
            recorded_at: opened_at,
        }),
    }))
}

pub(super) fn last_message(
    connection: &rusqlite::Connection,
    id: &str,
) -> Result<Option<CatalogMessage>, StoreError> {
    connection
        .query_row(
            "SELECT message_at, (
            SELECT preview FROM catalog_messages INDEXED BY catalog_latest_preview
            WHERE session_id = ?1 AND preview IS NOT NULL
            ORDER BY message_at DESC, sequence DESC, ordinal DESC LIMIT 1
         ), (
            SELECT message_id FROM catalog_messages INDEXED BY catalog_visible_tail
            WHERE session_id = ?1 ORDER BY sequence DESC, ordinal DESC LIMIT 1
         ) FROM catalog_messages INDEXED BY catalog_latest_message WHERE session_id = ?1
         ORDER BY message_at DESC, sequence DESC, ordinal DESC LIMIT 1",
            params![id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?
        .map(|row| -> Result<_, StoreError> {
            Ok(CatalogMessage {
                recorded_at: number(row.0)?,
                preview: row.1,
                tail_message_id: row.2,
            })
        })
        .transpose()
}

pub(crate) fn advance_revision(
    connection: &rusqlite::Connection,
    id: &str,
) -> Result<(), StoreError> {
    if crate::workspace_bindings::current_session_revision(connection, id)?
        .is_some_and(|revision| revision >= MAX_SAFE_INTEGER)
    {
        return Err(invalid("session revision exhausted"));
    }
    let changed = connection.execute(
        "UPDATE session_control SET revision = revision + 1 WHERE id = ? AND revision < ?",
        params![id, MAX_SAFE_INTEGER as i64],
    )?;
    if changed == 1 {
        advance_catalog(connection)?;
    } else if connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM session_control WHERE id = ?)",
        params![id],
        |row| row.get(0),
    )? {
        return Err(invalid("session revision exhausted"));
    }
    Ok(())
}
