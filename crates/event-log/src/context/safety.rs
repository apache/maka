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

use super::{invalid, selection::Selection};
use crate::StoreError;
use maka_runtime::event::{Fact, RuntimeEvent};
use sqlx::SqliteConnection;

pub(crate) async fn current_opening(
    connection: &mut SqliteConnection,
    session: &str,
    current: Option<&str>,
) -> Result<Option<(i64, RuntimeEvent)>, StoreError> {
    let Some(id) = current else {
        return Ok(None);
    };
    let row: Option<(i64, String)> = sqlx::query_as(
        "SELECT sequence, event_json FROM runtime_events e WHERE invocation_id = ?
         AND kind = 'invocation_opened' AND json_extract(event_json, '$.invocation.session_id') = ?
         AND NOT EXISTS(SELECT 1 FROM runtime_events t WHERE t.invocation_id = e.invocation_id AND t.kind = 'invocation_ended')",
    ).bind(id).bind(session).fetch_optional(connection).await?;
    let (sequence, json) =
        row.ok_or_else(|| invalid("current invocation is not live in this Session"))?;
    Ok(Some((sequence, serde_json::from_str(&json)?)))
}

/// Checks all old effects, including hidden children and failed-but-unknown runs.
pub(crate) async fn require_safe(
    connection: &mut SqliteConnection,
    session: &str,
    current: Option<&str>,
) -> Result<(), StoreError> {
    require_safe_through(connection, session, current, i64::MAX as u64).await
}

/// Historical observations cannot borrow a later settlement or inherit later work.
/// NOT MATERIALIZED keeps the cut in the indexed queries rather than copying the ledger.
pub(crate) async fn require_safe_through(
    connection: &mut SqliteConnection,
    session: &str,
    current: Option<&str>,
    through: u64,
) -> Result<(), StoreError> {
    require_safe_through_policy(connection, session, current, through, false).await
}

/// An explicit new message may observe a sealed prior tool dispatch with no
/// result. This never authorizes replay, continuation, or a terminal outcome.
pub(crate) async fn require_manual_message_safe(
    connection: &mut SqliteConnection,
    session: &str,
    current: Option<&str>,
) -> Result<bool, StoreError> {
    require_safe_through_policy(connection, session, current, i64::MAX as u64, true).await?;
    let pending: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM runtime_events d JOIN runtime_events end
         ON end.invocation_id=d.invocation_id AND end.kind='invocation_ended'
         WHERE d.kind='tool_dispatched'
         AND json_extract(d.event_json, '$.invocation.session_id')=?
         AND json_extract(end.event_json, '$.fact.outcome.class')='outcome_unknown'
         AND NOT EXISTS(SELECT 1 FROM runtime_events t WHERE t.invocation_id=d.invocation_id
           AND t.operation_id=d.operation_id AND t.kind='tool_settled'))",
    )
    .bind(session)
    .fetch_one(connection)
    .await?;
    Ok(pending)
}

async fn require_safe_through_policy(
    connection: &mut SqliteConnection,
    session: &str,
    current: Option<&str>,
    through: u64,
    allow_sealed_unknown: bool,
) -> Result<(), StoreError> {
    let unsafe_history: bool = sqlx::query_scalar(
        "WITH runtime_events AS NOT MATERIALIZED (SELECT * FROM main.runtime_events WHERE sequence <= ?3)
         SELECT EXISTS(SELECT 1 FROM runtime_events e
         WHERE json_extract(e.event_json, '$.invocation.session_id') = ?1
         AND (?2 IS NULL OR e.invocation_id != ?2) AND (
           (e.kind = 'invocation_opened' AND NOT EXISTS(SELECT 1 FROM runtime_events t
              WHERE t.invocation_id = e.invocation_id AND t.kind = 'invocation_ended'))
           OR (e.kind = 'tool_dispatched' AND NOT EXISTS(SELECT 1 FROM runtime_events t
              WHERE t.invocation_id = e.invocation_id AND t.operation_id = e.operation_id AND t.kind = 'tool_settled')
              AND (?4 = 0 OR NOT EXISTS(SELECT 1 FROM runtime_events terminal
                WHERE terminal.invocation_id = e.invocation_id AND terminal.kind = 'invocation_ended'
                AND json_extract(terminal.event_json, '$.fact.outcome.class') = 'outcome_unknown')))
           OR (e.kind = 'model_requested' AND NOT EXISTS(SELECT 1 FROM runtime_events t
              WHERE t.invocation_id = e.invocation_id AND t.operation_id = e.operation_id AND t.kind IN ('model_completed','model_interrupted')))
           OR (e.kind = 'model_completed' AND EXISTS(SELECT 1 FROM json_each(e.event_json, '$.fact.output.parts') p
              WHERE json_extract(p.value, '$.kind') = 'tool_call' AND json_extract(p.value, '$.call.provider_executed') = 0
              AND NOT EXISTS(SELECT 1 FROM runtime_events d WHERE d.invocation_id = e.invocation_id
                AND d.operation_id = e.operation_id || ':' || json_extract(p.value, '$.call.id')
                AND d.kind IN ('tool_dispatched','tool_rejected'))))
           OR (e.kind = 'model_completed' AND EXISTS(SELECT 1 FROM json_each(e.event_json, '$.fact.output.parts') p
              WHERE json_extract(p.value, '$.kind') = 'tool_call' AND json_extract(p.value, '$.call.provider_executed') = 1
              AND NOT EXISTS(SELECT 1 FROM json_each(e.event_json, '$.fact.output.parts') result
                WHERE json_extract(result.value, '$.kind') = 'tool_result'
                  AND json_extract(result.value, '$.id') = json_extract(p.value, '$.call.id')
                  AND json_extract(result.value, '$.name') = json_extract(p.value, '$.call.name'))))))",
    ).bind(session).bind(current).bind(through as i64).bind(allow_sealed_unknown).fetch_one(&mut *connection).await?;
    if unsafe_history {
        return Err(invalid(
            "Session contains unsealed or unresolved prior execution",
        ));
    }
    // An interrupted model step closes the request, not an observed remote
    // effect. Only that step's durably observed matching result settles it.
    let unknown_provider_effect: bool = sqlx::query_scalar(
        "WITH runtime_events AS NOT MATERIALIZED (SELECT * FROM main.runtime_events WHERE sequence <= ?3)
         SELECT EXISTS(SELECT 1 FROM runtime_events interrupted JOIN runtime_events call
           ON call.invocation_id = interrupted.invocation_id AND call.kind = 'model_observed'
           AND json_extract(call.event_json, '$.fact.step_id') = json_extract(interrupted.event_json, '$.fact.step_id')
           AND call.sequence < interrupted.sequence
         WHERE interrupted.kind = 'model_interrupted'
           AND json_extract(interrupted.event_json, '$.invocation.session_id') = ?1
           AND (?2 IS NULL OR interrupted.invocation_id != ?2)
           AND json_extract(call.event_json, '$.fact.event.kind') = 'tool_call'
           AND json_extract(call.event_json, '$.fact.event.data.provider_executed') = 1
           AND NOT EXISTS(SELECT 1 FROM runtime_events result WHERE result.invocation_id = call.invocation_id
             AND result.kind = 'model_observed' AND result.sequence > call.sequence AND result.sequence < interrupted.sequence
             AND json_extract(result.event_json, '$.fact.step_id') = json_extract(call.event_json, '$.fact.step_id')
             AND json_extract(result.event_json, '$.fact.event.kind') = 'provider_tool_result'
             AND json_extract(result.event_json, '$.fact.event.data.id') = json_extract(call.event_json, '$.fact.event.data.id')
             AND json_extract(result.event_json, '$.fact.event.data.name') = json_extract(call.event_json, '$.fact.event.data.name')))",
    ).bind(session).bind(current).bind(through as i64).fetch_one(&mut *connection).await?;
    if unknown_provider_effect {
        return Err(invalid(
            "Session contains an unresolved prior provider tool effect",
        ));
    }
    let broken_payload: bool = sqlx::query_scalar(
        "WITH runtime_events AS NOT MATERIALIZED (SELECT * FROM main.runtime_events WHERE sequence <= ?2)
         SELECT EXISTS(SELECT 1 FROM runtime_events e LEFT JOIN tool_result_payloads p ON p.event_id = e.event_id
         WHERE json_extract(e.event_json, '$.invocation.session_id') = ?1
         AND e.kind = 'tool_settled' AND json_extract(e.event_json, '$.fact.outcome.kind') = 'succeeded'
         AND (p.event_id IS NULL OR length(p.payload) != COALESCE(json_extract(e.event_json, '$.fact.outcome.raw.bytes'), 0)))",
    ).bind(session).bind(through as i64).fetch_one(connection).await?;
    if broken_payload {
        return Err(invalid("source tool payload binding is broken"));
    }
    Ok(())
}

pub(super) async fn closed_boundary(
    connection: &mut SqliteConnection,
    session: &str,
    through: u64,
) -> Result<(), StoreError> {
    let closed: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM session_history_events WHERE sequence = ? AND kind IN ('invocation_ended','message_imported')
         AND owner_session_id = ?)",
    ).bind(i64::try_from(through).map_err(|_| invalid("coverage overflow"))?).bind(session).fetch_one(connection).await?;
    if !closed {
        return Err(invalid("coverage must end at a closed Session boundary"));
    }
    Ok(())
}

/// A live opening is allowed; covered effects must be settled.
pub(crate) async fn settled_boundary(
    connection: &mut SqliteConnection,
    invocation: &str,
    through: u64,
) -> Result<(), StoreError> {
    execution_boundary(connection, invocation, through, Boundary::Settled).await
}

/// Main-model control may observe independent cells without summarizing away
/// their unresolved effects. Direct calls and unfinished model steps still block.
pub(crate) async fn model_boundary(
    connection: &mut SqliteConnection,
    invocation: &str,
    through: u64,
) -> Result<(), StoreError> {
    execution_boundary(connection, invocation, through, Boundary::Model).await
}

enum Boundary {
    Settled,
    Model,
}

// Parameters 1/2/4 are invocation, upper cut, and whether independent work is allowed.
const INDEPENDENT_CELLS: &str = "WITH RECURSIVE independent(operation_id) AS (
  SELECT operation_id FROM runtime_events WHERE ?4 AND invocation_id=?1 AND sequence<=?2
    AND kind='tool_dispatched' AND json_extract(event_json,'$.fact.call.origin.kind')='code_cell'
  UNION ALL
  SELECT child.operation_id FROM runtime_events child JOIN independent parent
    ON json_extract(child.event_json,'$.fact.call.origin.parent_operation_id')=parent.operation_id
    WHERE child.invocation_id=?1 AND child.sequence<=?2
      AND child.kind IN ('tool_dispatched','tool_rejected')
)";

// Only admitted Summary requests without tool observations are private work.
// Recovery still sees them; foreground readiness may ignore them. Parameters
// 1 and 2 are invocation identity and the historical upper cut.
pub(crate) const PRIVATE_SUMMARIES: &str = "private_summaries(operation_id) AS (
  SELECT r.operation_id FROM runtime_events r WHERE r.invocation_id=?1 AND r.sequence<=?2
    AND r.kind='model_requested' AND json_extract(r.event_json,'$.fact.purpose')='summary'
    AND NOT EXISTS(SELECT 1 FROM runtime_events o WHERE o.invocation_id=r.invocation_id
      AND json_extract(o.event_json,'$.fact.step_id')=r.operation_id AND o.kind='model_observed' AND o.sequence<=?2
      AND json_extract(o.event_json,'$.fact.event.kind') IN ('tool_call','provider_tool_result'))
)";

/// Ordinary Message requests retain their existing trace-admission contract,
/// but may overlap only private Summary work, never observed summary tools.
pub(super) async fn summary_boundary(
    connection: &mut SqliteConnection,
    invocation: &str,
) -> Result<(), StoreError> {
    let unsafe_summary: bool = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "WITH {PRIVATE_SUMMARIES} SELECT EXISTS(SELECT 1 FROM runtime_events r
         WHERE r.invocation_id=?1 AND r.kind='model_requested'
           AND json_extract(r.event_json,'$.fact.purpose')='summary'
           AND r.operation_id NOT IN (SELECT operation_id FROM private_summaries))"
    )))
    .bind(invocation)
    .bind(i64::MAX)
    .fetch_one(connection)
    .await?;
    if unsafe_summary {
        return Err(invalid("summary contains tool observations"));
    }
    Ok(())
}

/// The prompt's immutable cut may lag only asynchronous cell events, not a new
/// model step, direct tool result, checkpoint, or other selected history.
pub(crate) async fn model_source_unchanged(
    connection: &mut SqliteConnection,
    selection: &Selection,
    request: &RuntimeEvent,
) -> Result<(), StoreError> {
    let Fact::ModelRequested {
        source_high_water: through,
        ..
    } = &request.fact
    else {
        return Err(invalid("expected model request"));
    };
    let invocation = &request.invocation.invocation_id;
    let filter = Selection::predicate("e", "?6");
    let changed: bool = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "{INDEPENDENT_CELLS}, {PRIVATE_SUMMARIES}, retryable AS (
           SELECT r.operation_id FROM runtime_events r WHERE r.invocation_id=?1 AND r.kind='model_requested' AND r.sequence>?3
             AND json_remove(json_extract(r.event_json,'$.fact'),'$.step_id')=json_remove(json(?7),'$.step_id')
             AND EXISTS(SELECT 1 FROM runtime_events t WHERE t.invocation_id=r.invocation_id AND t.operation_id=r.operation_id
                 AND t.kind='model_interrupted' AND json_extract(t.event_json,'$.fact.status')='retryable_failure')
             AND NOT EXISTS(SELECT 1 FROM runtime_events barrier WHERE barrier.invocation_id=r.invocation_id
                 AND barrier.kind='model_observed' AND json_extract(barrier.event_json,'$.fact.step_id')=r.operation_id
                 AND (json_extract(barrier.event_json,'$.fact.event.kind') IN ('provider_tool_result','finished')
                     OR (json_extract(barrier.event_json,'$.fact.event.kind')='tool_call'
                         AND json_extract(barrier.event_json,'$.fact.event.data.provider_executed')=1)
                     OR (json_extract(barrier.event_json,'$.fact.event.data.provider_options') IS NOT NULL
                         AND json_extract(barrier.event_json,'$.fact.event.data.provider_options') != '{{}}'))))
         SELECT EXISTS(SELECT 1 FROM runtime_events e WHERE e.sequence > ?3
           AND json_extract(e.event_json,'$.invocation.session_id')=?5 AND {filter}
           AND NOT (e.invocation_id=?1 AND e.kind IN ('tool_dispatched','tool_settled','tool_rejected')
             AND e.operation_id IN (SELECT operation_id FROM independent))
           AND NOT (e.invocation_id=?1 AND e.kind='tool_notified'
             AND json_extract(e.event_json,'$.fact.operation_id') IN (SELECT operation_id FROM independent))
           AND NOT (e.invocation_id=?1 AND e.kind IN ('model_requested','model_observed','model_interrupted')
             AND json_extract(e.event_json,'$.fact.step_id') IN (SELECT operation_id FROM retryable))
           AND NOT (e.invocation_id=?1 AND e.kind IN ('model_requested','model_observed','model_completed','model_interrupted')
             AND json_extract(e.event_json,'$.fact.step_id') IN (SELECT operation_id FROM private_summaries)))"
    )))
    .bind(invocation)
    .bind(i64::MAX)
    .bind(*through as i64)
    .bind(true)
    .bind(&selection.session)
    .bind(&selection.lineage)
    .bind(serde_json::to_string(&request.fact)?)
    .fetch_one(connection)
    .await?;
    if changed {
        return Err(invalid("model request source changed"));
    }
    Ok(())
}

async fn execution_boundary(
    connection: &mut SqliteConnection,
    invocation: &str,
    through: u64,
    boundary: Boundary,
) -> Result<(), StoreError> {
    let pending: bool = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "{INDEPENDENT_CELLS}, {PRIVATE_SUMMARIES}
        SELECT EXISTS(SELECT 1 FROM runtime_events e WHERE e.invocation_id = ?1 AND e.sequence <= ?2 AND (
          (e.kind = 'tool_dispatched' AND NOT EXISTS(SELECT 1 FROM runtime_events t
             WHERE t.invocation_id = e.invocation_id AND t.operation_id = e.operation_id AND t.kind = 'tool_settled' AND t.sequence <= ?2)
             AND e.operation_id NOT IN (SELECT operation_id FROM independent))
          OR (e.kind = 'model_requested'
             AND NOT (?4 AND e.operation_id IN (SELECT operation_id FROM private_summaries))
             AND NOT EXISTS(SELECT 1 FROM runtime_events t
             WHERE t.invocation_id = e.invocation_id AND t.operation_id = e.operation_id AND t.kind IN ('model_completed','model_interrupted') AND t.sequence <= ?2))
          OR (e.kind = 'model_completed' AND EXISTS(SELECT 1 FROM json_each(e.event_json, '$.fact.output.parts') p
             WHERE json_extract(p.value, '$.kind') = 'tool_call' AND json_extract(p.value, '$.call.provider_executed') = 0
             AND NOT EXISTS(SELECT 1 FROM runtime_events d WHERE d.invocation_id = e.invocation_id
               AND d.operation_id = e.operation_id || ':' || json_extract(p.value, '$.call.id')
               AND d.kind IN ('tool_dispatched','tool_rejected') AND d.sequence <= ?2)))
          OR (e.kind = 'model_interrupted'
             AND (json_extract(e.event_json, '$.fact.status') != 'retryable_failure'
               OR EXISTS(SELECT 1 FROM runtime_events barrier WHERE barrier.invocation_id=e.invocation_id
                 AND json_extract(barrier.event_json, '$.fact.step_id')=e.operation_id
                 AND barrier.kind='model_observed' AND barrier.sequence <= ?2
                 AND (json_extract(barrier.event_json, '$.fact.event.kind') IN ('provider_tool_result','finished')
                   OR (json_extract(barrier.event_json, '$.fact.event.kind')='tool_call'
                     AND json_extract(barrier.event_json, '$.fact.event.data.provider_executed')=1)
                   OR (json_extract(barrier.event_json, '$.fact.event.data.provider_options') IS NOT NULL
                     AND json_extract(barrier.event_json, '$.fact.event.data.provider_options') != '{{}}'))))
             AND NOT ((?3 OR ?4) AND e.operation_id IN (SELECT operation_id FROM private_summaries))
             AND EXISTS(SELECT 1 FROM runtime_events o
             WHERE o.invocation_id = e.invocation_id AND json_extract(o.event_json, '$.fact.step_id') = e.operation_id
             AND o.kind = 'model_observed' AND o.sequence <= ?2))
          OR (e.kind = 'model_completed' AND EXISTS(SELECT 1 FROM json_each(e.event_json, '$.fact.output.parts') p
             WHERE json_extract(p.value, '$.kind') = 'tool_call' AND json_extract(p.value, '$.call.provider_executed') = 1
             AND NOT EXISTS(SELECT 1 FROM json_each(e.event_json, '$.fact.output.parts') result
               WHERE json_extract(result.value, '$.kind') = 'tool_result'
                 AND json_extract(result.value, '$.id') = json_extract(p.value, '$.call.id')
                 AND json_extract(result.value, '$.name') = json_extract(p.value, '$.call.name'))))))",
    ))).bind(invocation).bind(through as i64).bind(matches!(boundary,Boundary::Settled))
        .bind(matches!(boundary,Boundary::Model)).fetch_one(connection).await?;
    if pending {
        return Err(invalid(
            "active source contains unresolved model or tool work",
        ));
    }
    Ok(())
}
