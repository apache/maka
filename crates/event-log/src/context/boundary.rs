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
use maka_runtime::{
    context::CheckpointMode,
    event::{Fact, InvocationInput, RuntimeEvent},
};
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
    scope: &maka_runtime::event::LogScope,
    high: u64,
    through: u64,
) -> Result<Option<u64>, StoreError> {
    let first: Option<i64> = sqlx::query_scalar(
        "SELECT MIN(sequence) FROM runtime_events WHERE invocation_id = ?1
         AND kind = 'model_requested' AND sequence < ?2
         AND json_extract(event_json, '$.fact.purpose') = 'summary'
         AND json_extract(event_json, '$.fact.source_high_water') = ?3
         AND json_extract(event_json, '$.fact.source_scope') = json(?4)",
    )
    .bind(invocation)
    .bind(through as i64)
    .bind(high as i64)
    .bind(serde_json::to_string(scope)?)
    .fetch_one(connection)
    .await?;
    first.map(crate::sequence_number).transpose()
}

/// Renewal must be Main progress covered by the new source. A fast Main can
/// finish before the prior Summary request commits; request arrival order is
/// not a progress fence, and late repairs must not roll that fence backward.
pub(super) async fn admit_summary(
    connection: &mut SqliteConnection,
    invocation: &str,
    first: Option<u64>,
    high: u64,
) -> Result<(), StoreError> {
    let (pending, attempts, renewed): (bool, i64, bool) = sqlx::query_as(
        "WITH summaries AS (
           SELECT * FROM runtime_events WHERE invocation_id = ?1 AND kind = 'model_requested'
             AND json_extract(event_json, '$.fact.purpose') = 'summary')
         SELECT EXISTS(SELECT 1 FROM summaries s WHERE NOT EXISTS(
           SELECT 1 FROM runtime_events t WHERE t.invocation_id=s.invocation_id
             AND t.operation_id=s.operation_id AND t.kind IN ('model_completed','model_interrupted'))),
           (SELECT COUNT(*) FROM summaries WHERE sequence >= ?2),
           NOT EXISTS(SELECT 1 FROM summaries) OR EXISTS(
             SELECT 1 FROM runtime_events c JOIN runtime_events r
               ON r.invocation_id=c.invocation_id AND r.operation_id=c.operation_id AND r.kind='model_requested'
             WHERE c.invocation_id=?1 AND c.kind='model_completed'
               AND json_extract(r.event_json, '$.fact.purpose')='main'
               AND c.sequence <= ?3 AND c.sequence > (
                 SELECT MAX(json_extract(event_json,'$.fact.source_high_water')) FROM summaries))",
    ).bind(invocation).bind(first.map(|v| v as i64)).bind(high as i64).fetch_one(connection).await?;
    if pending || (first.is_some() && attempts >= 3) || (first.is_none() && !renewed) {
        return Err(invalid(
            "summary requires settled work and a bounded repair budget",
        ));
    }
    Ok(())
}
