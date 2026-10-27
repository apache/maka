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

use crate::{
    StoreError,
    turns::{InvocationState, TurnBoundary},
};
use maka_agent_facts::model::TextKind;
use sqlx::Row;

/// Active stream identity and replay start, without reading accumulated text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssistantStreamSeed {
    pub start_sequence: u64,
    pub step_id: String,
    pub part_id: String,
    /// Canonical PartStarted event ID; provider IDs may repeat across steps.
    pub message_id: String,
    pub text_kind: TextKind,
}

pub(super) async fn read(
    connection: &mut sqlx::SqliteConnection,
    root: Option<&TurnBoundary>,
) -> Result<Vec<AssistantStreamSeed>, StoreError> {
    let Some(root) = root else {
        return Ok(Vec::new());
    };
    if matches!(root.state, InvocationState::Ended { .. })
        || matches!(
            root.input,
            maka_agent_facts::input::InvocationInput::ContextCompact { .. }
        )
    {
        return Ok(Vec::new());
    }
    let external: Option<(i64, String)> = sqlx::query_as(
        "SELECT sequence, event_id FROM runtime_events started WHERE invocation_id = ?1 AND kind = 'executor_started'
         AND NOT EXISTS(SELECT 1 FROM runtime_events done WHERE done.invocation_id = started.invocation_id AND done.kind = 'executor_completed')"
    ).bind(&root.invocation.invocation_id).fetch_optional(&mut *connection).await?;
    if let Some((sequence, message)) = external {
        let sequence = crate::sequence_number(sequence)?;
        return Ok([TextKind::Text, TextKind::Thinking]
            .into_iter()
            .map(|text_kind| AssistantStreamSeed {
                start_sequence: sequence,
                step_id: root.invocation.invocation_id.clone(),
                part_id: if text_kind == TextKind::Text {
                    "text"
                } else {
                    "thinking"
                }
                .into(),
                message_id: message.clone(),
                text_kind,
            })
            .collect());
    }
    // Select only identities. Neither finished output bodies nor accumulated text
    // cross the SQL boundary. The invocation_sequence index scopes scans.
    let rows = sqlx::query(
        "WITH seeds AS MATERIALIZED (
         SELECT s.sequence, json_extract(s.event_json, '$.fact.step_id') AS step_id, s.event_id,
                json_extract(s.event_json, '$.fact.event.data.id') AS part_id,
                json_extract(s.event_json, '$.fact.event.data.text_kind') AS text_kind
         FROM runtime_events s WHERE s.invocation_id = ?1 AND s.kind = 'model_observed'
         AND EXISTS (SELECT 1 FROM runtime_events request
             JOIN runtime_events opening ON opening.invocation_id = request.invocation_id
             AND opening.kind = 'invocation_opened'
             WHERE request.kind = 'model_requested' AND request.invocation_id = s.invocation_id
             AND request.operation_id = json_extract(s.event_json, '$.fact.step_id')
                     AND json_extract(opening.event_json, '$.fact.input.kind') IN ('message', 'continuation', 'handoff')
             AND json_extract(request.event_json, '$.fact.purpose') = 'main')
         AND json_extract(s.event_json, '$.fact.event.kind') = 'part_started'
         AND NOT EXISTS (
             SELECT 1 FROM runtime_events e
             WHERE e.invocation_id = s.invocation_id
             AND json_extract(e.event_json, '$.fact.step_id') = json_extract(s.event_json, '$.fact.step_id')
             AND (e.kind IN ('model_interrupted', 'model_completed') OR
                 (e.sequence > s.sequence AND e.kind = 'model_observed'
                  AND json_extract(e.event_json, '$.fact.event.kind') = 'part_started'
                  AND json_extract(e.event_json, '$.fact.event.data.id') =
                      json_extract(s.event_json, '$.fact.event.data.id'))))
         ORDER BY s.sequence)
         SELECT sequence, step_id, event_id, part_id, text_kind
         FROM seeds ORDER BY sequence",
    ).bind(&root.invocation.invocation_id).fetch_all(&mut *connection).await?;
    let mut result = Vec::new();
    for row in rows {
        let sequence: i64 = row.try_get(0)?;
        let step_id: String = row.try_get(1)?;
        let part_id: String = row.try_get(3)?;
        let text_kind = match row.try_get::<String, _>(4)?.as_str() {
            "text" => TextKind::Text,
            "thinking" => TextKind::Thinking,
            _ => {
                return Err(StoreError::InvalidTransition(
                    "invalid stored text kind".into(),
                ));
            }
        };
        result.push(AssistantStreamSeed {
            start_sequence: crate::sequence_number(sequence)?,
            step_id,
            part_id,
            message_id: row.try_get(2)?,
            text_kind,
        });
    }
    Ok(result)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompactionProgress {
    pub id: String,
    pub started_at: u64,
}

/// Display status from the same committed snapshot as the session observation.
pub(super) async fn compacting(
    connection: &mut sqlx::SqliteConnection,
    root: Option<&TurnBoundary>,
) -> Result<Option<CompactionProgress>, StoreError> {
    let Some(root) = root else {
        return Ok(None);
    };
    if matches!(root.state, InvocationState::Ended { .. }) {
        return Ok(None);
    }
    let progress: Option<(String, i64)> = if matches!(
        root.input,
        maka_agent_facts::input::InvocationInput::ContextCompact { .. }
    ) {
        sqlx::query_as(
            "SELECT opening.event_id, catalog_time(json_extract(opening.event_json, '$.recorded_at'))
             FROM runtime_events opening WHERE opening.event_id = ?
             AND NOT EXISTS (SELECT 1 FROM runtime_events checkpoint
                 WHERE checkpoint.invocation_id = opening.invocation_id
                 AND checkpoint.kind = 'context_checkpoint_recorded')",
        )
        .bind(&root.opening_event_id)
        .fetch_optional(connection)
        .await?
    } else {
        sqlx::query_as(
            "WITH waiting AS MATERIALIZED (
                 SELECT sequence FROM event_log INDEXED BY context_compaction_waiting
                 WHERE invocation_id = ?1 AND kind = 'context_compaction_waiting'
                 AND event_json IS NOT NULL
                 ORDER BY sequence DESC LIMIT 1
             ), latest AS MATERIALIZED (
                 SELECT sequence, event_json FROM event_log INDEXED BY context_summary_sequence
                 WHERE invocation_id = ?1 AND kind = 'model_requested'
                 AND json_extract(event_json, '$.fact.purpose') = 'summary'
                 ORDER BY sequence DESC LIMIT 1
             )
             SELECT first.event_id, catalog_time(json_extract(first.event_json, '$.recorded_at'))
             FROM waiting, latest JOIN event_log first INDEXED BY context_summary_round
               ON first.invocation_id = ?1 AND first.kind = 'model_requested'
               AND json_extract(first.event_json, '$.fact.purpose') = 'summary'
               AND json_extract(first.event_json, '$.fact.source_high_water') = json_extract(latest.event_json, '$.fact.source_high_water')
               AND json_extract(first.event_json, '$.fact.source_digest') = json_extract(latest.event_json, '$.fact.source_digest')
               AND first.sequence <= latest.sequence
             WHERE first.event_json IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM runtime_events boundary
                   WHERE boundary.invocation_id = ?1 AND boundary.sequence > waiting.sequence
                   AND (boundary.kind = 'context_checkpoint_recorded'
                       OR (boundary.kind = 'model_requested' AND json_extract(boundary.event_json, '$.fact.purpose') = 'main')
                       OR (boundary.kind = 'model_interrupted' AND json_extract(boundary.event_json, '$.fact.status') = 'cancelled')))
               AND NOT EXISTS (SELECT 1 FROM runtime_events boundary
                   WHERE boundary.invocation_id = ?1 AND boundary.sequence > first.sequence
                   AND boundary.kind = 'context_checkpoint_recorded')
             ORDER BY first.sequence LIMIT 1",
        )
        .bind(&root.invocation.invocation_id)
        .fetch_optional(connection)
        .await?
    };
    progress
        .map(|(id, started)| {
            Ok(CompactionProgress {
                id,
                started_at: crate::sequence_number(started)?,
            })
        })
        .transpose()
}
