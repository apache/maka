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

use super::{invalid, safety, selection::Selection};
use crate::StoreError;
use maka_agent_facts::context::CheckpointMode;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::InvocationInput;
use maka_agent_facts::event::RuntimeEvent;
use sqlx::SqliteConnection;

pub(super) async fn source_fence(
    connection: &mut SqliteConnection,
    selection: &Selection,
    opening: Option<&(i64, RuntimeEvent)>,
    mode: &CheckpointMode,
    through: u64,
) -> Result<u64, StoreError> {
    let session = selection
        .session
        .as_deref()
        .ok_or_else(|| invalid("context requires a Session"))?;
    let Some((opened, event)) = opening else {
        if !matches!(mode, CheckpointMode::Standalone) {
            return Err(invalid(
                "automatic compaction requires a live model invocation",
            ));
        }
        let high = selection
            .high_water(connection, i64::MAX as u64 - 1)
            .await?;
        if high > 0 {
            safety::closed_boundary(connection, session, high).await?;
        }
        return Ok(high);
    };
    let Fact::InvocationOpened { input, .. } = &event.fact else {
        return Err(invalid("missing canonical opening"));
    };
    let before = match (mode, input) {
        (CheckpointMode::Standalone, InvocationInput::ContextCompact { .. })
        | (
            CheckpointMode::PreTurn,
            InvocationInput::Message { .. }
            | InvocationInput::Continuation { .. }
            | InvocationInput::Handoff { .. },
        ) => *opened,
        (
            CheckpointMode::MidTurn { anchor_event_id },
            InvocationInput::Message { .. }
            | InvocationInput::Continuation { .. }
            | InvocationInput::Handoff { .. },
        ) => {
            if anchor_event_id != &event.id {
                return Err(invalid(
                    "mid-turn anchor is not the exact canonical opening",
                ));
            }
            through as i64
        }
        _ => return Err(invalid("checkpoint mode does not match its opening")),
    };
    let high = selection.high_water(connection, before as u64 - 1).await?;
    if matches!(mode, CheckpointMode::MidTurn { .. }) {
        if high <= *opened as u64 {
            return Err(invalid(
                "mid-turn source has no completed work after its anchor",
            ));
        }
        safety::settled_boundary(connection, &event.invocation.invocation_id, high).await?;
    } else if high > 0 {
        safety::closed_boundary(connection, session, high).await?;
    }
    Ok(high)
}

/// The frozen source key owns a round. Route/digest changes cannot create a new
/// repair budget; the first request's existing step identity is the round root.
pub(super) async fn summary_start(
    connection: &mut SqliteConnection,
    invocation: &str,
    scope: &maka_agent_facts::event::LogScope,
    high: u64,
    through: u64,
) -> Result<Option<u64>, StoreError> {
    let first: Option<i64> = sqlx::query_scalar(
        "SELECT sequence FROM event_log INDEXED BY context_summary_round
         WHERE invocation_id = ?1 AND event_json IS NOT NULL
         AND kind = 'model_requested' AND sequence < ?2
         AND json_extract(event_json, '$.fact.purpose') = 'summary'
         AND json_extract(event_json, '$.fact.source_high_water') = ?3
         AND json_extract(event_json, '$.fact.source_scope') = json(?4)
         ORDER BY sequence LIMIT 1",
    )
    .bind(invocation)
    .bind(through as i64)
    .bind(high as i64)
    .bind(serde_json::to_string(scope)?)
    .fetch_optional(connection)
    .await?;
    first.map(crate::sequence_number).transpose()
}

pub(super) const SUMMARY_ADMISSION: &str = "WITH covered AS (
           SELECT json_extract(event_json,'$.fact.source_high_water') AS high
           FROM event_log INDEXED BY context_summary_round
           WHERE invocation_id=?1 AND event_json IS NOT NULL AND kind='model_requested'
             AND json_extract(event_json,'$.fact.purpose')='summary'
           ORDER BY json_extract(event_json,'$.fact.source_high_water') DESC LIMIT 1)
         SELECT EXISTS(SELECT 1 FROM context_execution_work w INDEXED BY context_execution_live
           JOIN context_execution_steps s ON s.invocation_id=w.invocation_id AND s.operation_id=w.operation_id
           WHERE w.invocation_id=?1 AND w.closed_at IS NULL AND w.kind='model' AND s.purpose='summary'),
           (SELECT COUNT(*) FROM (SELECT 1 FROM event_log INDEXED BY context_summary_sequence
             WHERE invocation_id=?1 AND event_json IS NOT NULL AND kind='model_requested'
               AND json_extract(event_json,'$.fact.purpose')='summary' AND sequence>=?2 LIMIT 3)),
           NOT EXISTS(SELECT 1 FROM covered) OR EXISTS(
             SELECT 1 FROM runtime_events c JOIN runtime_events r
               ON r.invocation_id=c.invocation_id AND r.kind='model_requested'
                 AND r.operation_id=CASE WHEN c.kind='model_observed'
                   THEN CAST(json_extract(c.event_json,'$.fact.step_id') AS TEXT) ELSE c.operation_id END
             WHERE c.invocation_id=?1 AND (c.kind='model_completed' OR
               (c.kind='model_observed' AND json_extract(r.event_json,'$.fact.item_acceptance')=1
                 AND json_extract(c.event_json,'$.fact.event.kind') IN
                   ('part_finished','tool_call','provider_tool_result','source')))
               AND json_extract(r.event_json, '$.fact.purpose')='main'
               AND c.sequence <= ?3 AND c.sequence > (SELECT high FROM covered))";

/// Renewal must be Main progress covered by the new source. A fast Main can
/// finish before the prior Summary request commits; request arrival order is
/// not a progress fence, and late repairs must not roll that fence backward.
pub(super) async fn admit_summary(
    connection: &mut SqliteConnection,
    invocation: &str,
    first: Option<u64>,
    high: u64,
) -> Result<(), StoreError> {
    let (pending, attempts, renewed): (bool, i64, bool) = sqlx::query_as(SUMMARY_ADMISSION)
        .bind(invocation)
        .bind(first.map(|v| v as i64))
        .bind(high as i64)
        .fetch_one(connection)
        .await?;
    if pending || (first.is_some() && attempts >= 3) || (first.is_none() && !renewed) {
        return Err(invalid(
            "summary requires settled work and a bounded repair budget",
        ));
    }
    Ok(())
}
