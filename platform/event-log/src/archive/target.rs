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

use super::ArchiveError;
use crate::{StoreError, sequence_number};
use maka_agent_facts::event::Invocation;
use maka_agent_facts::tool_call::ToolCallIdentity;
use maka_agent_facts::tool_call::ToolOrigin;
use maka_agent_facts::tool_output::DurableToolProjection;
use sqlx::{Row, SqliteConnection};

// Keep native and copied targets as separate ordered branches. Joining the
// combined history view makes SQLite sort the entire remainder on every page.
// The copied branch exposes h.sequence so its membership index supplies order.
pub(super) const SOURCES: [&str; 2] = [
    "SELECT e.sequence,e.event_id,e.invocation_id,e.operation_id,e.event_header,e.body_id,
       json_extract(e.event_header,'$.invocation.session_id') AS owner_session_id,
       0 AS inherited,NULL AS archive_sequence
     FROM runtime_events e WHERE e.kind='tool_settled'",
    "SELECT h.sequence,e.event_id,e.invocation_id,e.operation_id,e.event_header,e.body_id,
       h.session_id AS owner_session_id,1 AS inherited,h.archive_sequence
     FROM session_history_members h CROSS JOIN runtime_events e
     WHERE e.sequence=h.sequence AND e.kind='tool_settled'",
];

pub(super) struct Target {
    pub sequence: u64,
    pub event_id: String,
    pub invocation: Invocation,
    pub call: ToolCallIdentity,
    pub name: String,
    pub step_sequence: u64,
    pub projection: DurableToolProjection,
}

pub(super) async fn read(
    connection: &mut SqliteConnection,
    session: &str,
    id: &str,
) -> Result<Option<Target>, StoreError> {
    // Filter before SQLite materializes the compound acceptance query, so only
    // matching calls carry their full inputs into its temporary rows.
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(concat!("WITH ", crate::model_items::accepted_calls!(),
        " SELECT e.event_header,{columns},t.sequence, t.event_id, t.operation_id, json_extract(t.event_header, '$.invocation') AS ti,
         json_extract(d.event_header, '$.invocation') AS di, json_extract(d.event_header, '$.fact.call') AS call,
         json_extract(d.event_header, '$.fact.name') AS name,
         json_extract(t.event_header, '$.fact.outcome.kind') AS outcome,
         json_extract(t.event_header, '$.fact.outcome.message') AS message,
         c.sequence AS completed,
         (json_extract(t.event_header,'$.id')=t.event_id
           AND json_extract(t.event_header,'$.invocation.invocation_id')=t.invocation_id
           AND json_extract(t.event_header,'$.fact.operation_id')=t.operation_id
           AND json_extract(t.event_header,'$.fact.kind')='tool_settled'
           AND json_extract(d.event_header,'$.id')=d.event_id
           AND json_extract(d.event_header,'$.fact.operation_id')=d.operation_id
           AND json_extract(d.event_header,'$.fact.kind')='tool_dispatched'
           AND c.invocation_id=t.invocation_id
           AND json_extract(c.call,'$.name')=json_extract(d.event_header,'$.fact.name')
           AND json_extract(c.call,'$.provider_executed')=0
           AND c.sequence<d.sequence AND d.sequence<t.sequence) AS identities
         FROM session_history_events t LEFT JOIN runtime_events d ON d.invocation_id = t.invocation_id
           AND d.operation_id = t.operation_id AND d.kind = 'tool_dispatched'
         LEFT JOIN (
           SELECT * FROM accepted_calls
           WHERE invocation_id=(SELECT invocation_id FROM runtime_events WHERE event_id=?1)
             AND step_id=(SELECT json_extract(d.event_header,'$.fact.call.origin.step_id')
               FROM runtime_events t JOIN runtime_events d ON d.operation_id=t.operation_id
                 AND d.invocation_id=t.invocation_id AND d.kind='tool_dispatched'
               WHERE t.event_id=?1)
             AND json_extract(call,'$.id')=(SELECT json_extract(d.event_header,'$.fact.call.tool_call_id')
               FROM runtime_events t JOIN runtime_events d ON d.operation_id=t.operation_id
                 AND d.invocation_id=t.invocation_id AND d.kind='tool_dispatched'
               WHERE t.event_id=?1)
         ) c ON c.invocation_id = t.invocation_id
           AND c.step_id = json_extract(d.event_header, '$.fact.call.origin.step_id')
           AND json_extract(c.call,'$.id') = json_extract(d.event_header,'$.fact.call.tool_call_id')
         JOIN runtime_events e ON e.sequence=t.sequence {joins}
         WHERE t.event_id = ?1 AND t.kind = 'tool_settled' AND t.owner_session_id = ?2",
    ), columns=crate::canonical::COLUMNS, joins=crate::canonical::JOINS))).bind(id).bind(session).fetch_optional(&mut *connection).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let event: maka_agent_facts::event::RuntimeEvent =
        serde_json::from_str(&crate::canonical::json(&row)?)?;
    let mut durable = match event.fact {
        maka_agent_facts::event::Fact::ToolSettled {
            outcome:
                maka_agent_facts::event::ToolOutcome::Succeeded {
                    model_projection, ..
                },
            ..
        } => Some(model_projection),
        _ => None,
    };
    let decoded = (|| -> Option<Target> {
        if !row.try_get::<bool, _>("identities").ok()? {
            return None;
        }
        let invocation: Invocation =
            serde_json::from_str(row.try_get::<&str, _>("ti").ok()?).ok()?;
        let dispatch: Invocation = serde_json::from_str(row.try_get::<&str, _>("di").ok()?).ok()?;
        let call: ToolCallIdentity =
            serde_json::from_str(row.try_get::<&str, _>("call").ok()?).ok()?;
        if invocation != dispatch || !matches!(call.origin, ToolOrigin::Provider { .. }) {
            return None;
        }
        let outcome: &str = row.try_get("outcome").ok()?;
        let projection = match outcome {
            "succeeded" => durable.take()?,
            "failed" | "unknown" => DurableToolProjection::Text {
                text: row.try_get("message").ok()?,
            },
            _ => return None,
        };
        Some(Target {
            sequence: sequence_number(row.try_get("sequence").ok()?).ok()?,
            event_id: row.try_get("event_id").ok()?,
            invocation,
            call,
            name: row.try_get("name").ok()?,
            step_sequence: sequence_number(row.try_get("completed").ok()?).ok()?,
            projection,
        })
    })()
    .ok_or(ArchiveError::Corrupt)?;
    if decoded.step_sequence >= decoded.sequence {
        return Err(ArchiveError::Corrupt.into());
    }
    Ok(Some(decoded))
}
