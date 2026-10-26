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
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::RuntimeEvent;
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
/// Current cuts use durable obligations; older cuts derive only the requested state.
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
        "SELECT EXISTS(SELECT 1 FROM context_obligations
         WHERE session_id=? AND kind='tool' AND sealed_unknown=1)",
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
    // Durable obligations survive reopen. Only a genuinely older requested cut
    // needs historical derivation; ordinary current reads never rescan the ledger.
    let indexed: bool = sqlx::query_scalar(
        "SELECT NOT EXISTS(SELECT 1 FROM context_safety_heads
         WHERE session_id=? AND through_sequence>?)",
    )
    .bind(session)
    .bind(i64::try_from(through).map_err(|_| invalid("coverage overflow"))?)
    .fetch_one(&mut *connection)
    .await?;
    if indexed {
        let unsettled: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM context_obligations
             WHERE session_id=?1 AND (?2 IS NULL OR invocation_id!=?2)
               AND kind!='interrupted_provider'
               AND NOT (?3 AND kind='tool' AND sealed_unknown=1))",
        )
        .bind(session)
        .bind(current)
        .bind(allow_sealed_unknown)
        .fetch_one(&mut *connection)
        .await?;
        if unsettled {
            return Err(StoreError::HistoryUnsettled);
        }
        let unknown_provider_effect: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM context_obligations
             WHERE session_id=?1 AND kind='interrupted_provider'
               AND (?2 IS NULL OR invocation_id!=?2))",
        )
        .bind(session)
        .bind(current)
        .fetch_one(connection)
        .await?;
        if unknown_provider_effect {
            return Err(StoreError::HistoryProviderEffectUnresolved);
        }
        return Ok(());
    }
    let unsafe_history: bool = sqlx::query_scalar(concat!(
        "WITH runtime_events AS NOT MATERIALIZED (SELECT * FROM main.runtime_events WHERE sequence <= ?3), ",
        crate::model_items::accepted_calls!(), "
         SELECT EXISTS(SELECT 1 FROM runtime_events e
         WHERE json_extract(e.event_json, '$.invocation.session_id') = ?1
         AND (e.kind = 'invocation_opened' OR e.kind = 'tool_dispatched'
           OR e.kind = 'model_requested' OR e.kind = 'model_completed')
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
           OR (e.kind = 'model_requested' AND EXISTS(SELECT 1 FROM accepted_calls p
              WHERE p.invocation_id=e.invocation_id AND p.step_id=e.operation_id AND json_extract(p.call, '$.provider_executed') = 0
              AND NOT EXISTS(SELECT 1 FROM runtime_events d WHERE d.invocation_id = e.invocation_id
                AND d.operation_id = e.operation_id || ':' || json_extract(p.call, '$.id')
                AND d.kind IN ('tool_dispatched','tool_rejected'))))
           OR (e.kind = 'model_completed' AND EXISTS(SELECT 1 FROM json_each(e.event_json, '$.fact.output.parts') p
              WHERE json_extract(p.value, '$.kind') = 'tool_call' AND json_extract(p.value, '$.call.provider_executed') = 1
              AND NOT EXISTS(SELECT 1 FROM json_each(e.event_json, '$.fact.output.parts') result
                WHERE json_extract(result.value, '$.kind') = 'tool_result'
                  AND json_extract(result.value, '$.id') = json_extract(p.value, '$.call.id')
                  AND json_extract(result.value, '$.name') = json_extract(p.value, '$.call.name'))))))",
    )).bind(session).bind(current).bind(through as i64).bind(allow_sealed_unknown).fetch_one(&mut *connection).await?;
    if unsafe_history {
        return Err(StoreError::HistoryUnsettled);
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
        return Err(StoreError::HistoryProviderEffectUnresolved);
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

/// Ordinary Message requests retain their existing trace-admission contract,
/// but may overlap only private Summary work, never observed summary tools.
pub(super) async fn summary_boundary(
    connection: &mut SqliteConnection,
    invocation: &str,
) -> Result<(), StoreError> {
    let unsafe_summary: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM context_execution_steps INDEXED BY context_summary_tool_observed
         WHERE invocation_id=? AND purpose='summary' AND tool_observed_at IS NOT NULL)",
    )
    .bind(invocation)
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
    let filter = Selection::predicate("e", "?4");
    let changed: bool = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT EXISTS(SELECT 1 FROM runtime_events e
         LEFT JOIN context_execution_steps s ON s.invocation_id=e.invocation_id
           AND s.operation_id=CAST(json_extract(e.event_json,'$.fact.step_id') AS TEXT)
         WHERE e.sequence > ?2
           AND (e.event_json IS NOT NULL AND e.event_session=?3) AND {filter}
           AND NOT (e.invocation_id=?1 AND e.kind IN ('tool_dispatched','tool_settled','tool_rejected','tool_notified')
             AND EXISTS(SELECT 1 FROM context_independent_tools i WHERE i.invocation_id=e.invocation_id
               AND i.operation_id=CASE WHEN e.kind='tool_notified'
                 THEN json_extract(e.event_json,'$.fact.operation_id') ELSE e.operation_id END))
           AND NOT (e.invocation_id=?1 AND e.kind IN ('model_requested','model_observed','model_interrupted')
             AND EXISTS(SELECT 1 FROM runtime_events r WHERE r.sequence=s.requested_at AND r.sequence>?2
               AND s.terminal_kind='model_interrupted' AND s.terminal_status='retryable_failure'
               AND (s.item_acceptance!=1 OR s.accepted_at IS NULL) AND s.barrier_at IS NULL
               AND json_remove(json_extract(r.event_json,'$.fact'),'$.step_id')=json_remove(json(?5),'$.step_id')))
           AND NOT (e.invocation_id=?1 AND e.kind IN ('model_requested','model_observed','model_completed','model_interrupted')
             AND COALESCE(s.purpose='summary' AND s.tool_observed_at IS NULL,0)))"
    )))
    .bind(invocation)
    .bind(*through as i64)
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

const EXECUTION_BOUNDARY: &str = "WITH work AS (
           SELECT kind,operation_id FROM context_execution_work INDEXED BY context_execution_live
             WHERE invocation_id=?1 AND closed_at IS NULL AND opened_at<=?2
           UNION ALL
           SELECT kind,operation_id FROM context_execution_work INDEXED BY context_execution_closed
             WHERE invocation_id=?1 AND closed_at>?2 AND opened_at<=?2)
         SELECT EXISTS(SELECT 1 FROM work w
           WHERE NOT (?3 AND w.kind='tool' AND EXISTS(
             SELECT 1 FROM context_independent_tools i WHERE i.invocation_id=?1
               AND i.operation_id=w.operation_id AND i.opened_at<=?2))
           AND NOT ((w.kind='interrupted' OR (?3 AND w.kind='model')) AND EXISTS(
             SELECT 1 FROM context_execution_steps s WHERE s.invocation_id=?1
               AND s.operation_id=w.operation_id AND s.requested_at<=?2 AND s.purpose='summary'
               AND (s.tool_observed_at IS NULL OR s.tool_observed_at>?2))))";

async fn execution_boundary(
    connection: &mut SqliteConnection,
    invocation: &str,
    through: u64,
    boundary: Boundary,
) -> Result<(), StoreError> {
    let pending: bool = sqlx::query_scalar(EXECUTION_BOUNDARY)
        .bind(invocation)
        .bind(i64::try_from(through).map_err(|_| invalid("coverage overflow"))?)
        .bind(matches!(boundary, Boundary::Model))
        .fetch_one(connection)
        .await?;
    if pending {
        return Err(invalid(
            "active source contains unresolved model or tool work",
        ));
    }
    Ok(())
}

#[cfg(test)]
#[path = "safety/tests.rs"]
mod tests;
