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
use rusqlite::OptionalExtension;

pub(crate) fn current_opening(
    connection: &rusqlite::Connection,
    session: &str,
    current: Option<&str>,
) -> Result<Option<(i64, RuntimeEvent)>, StoreError> {
    let Some(id) = current else {
        return Ok(None);
    };
    let row: Option<(i64, String)> = connection.prepare_cached("SELECT sequence, event_header FROM runtime_events e WHERE invocation_id = ?
         AND kind = 'invocation_opened' AND json_extract(event_header, '$.invocation.session_id') = ?
         AND NOT EXISTS(SELECT 1 FROM runtime_events t WHERE t.invocation_id = e.invocation_id AND t.kind = 'invocation_ended')")?.query_row(rusqlite::params![id,session], |row| Ok((row.get(0)?,row.get(1)?,))).optional()?;
    let (sequence, json) =
        row.ok_or_else(|| invalid("current invocation is not live in this Session"))?;
    Ok(Some((sequence, serde_json::from_str(&json)?)))
}

/// Live execution remains a boundary; a closed run's uncertainty is model context.
pub(crate) fn require_safe(
    connection: &rusqlite::Connection,
    session: &str,
    current: Option<&str>,
) -> Result<bool, StoreError> {
    require_safe_through(connection, session, current, i64::MAX as u64)
}

/// Historical cuts use only settlements and closed runs within their fence.
pub(crate) fn require_safe_through(
    connection: &rusqlite::Connection,
    session: &str,
    current: Option<&str>,
    through: u64,
) -> Result<bool, StoreError> {
    // Durable obligations survive reopen. Only a genuinely older requested cut
    // needs historical derivation; ordinary current reads never rescan the ledger.
    let indexed: bool = connection
        .prepare_cached(
            "SELECT NOT EXISTS(SELECT 1 FROM context_safety_heads
         WHERE session_id=? AND through_sequence>?)",
        )?
        .query_row(
            rusqlite::params![
                session,
                i64::try_from(through).map_err(|_| invalid("coverage overflow"))?
            ],
            |row| row.get(0),
        )?;
    if indexed {
        let unsettled: bool = connection.prepare_cached("SELECT EXISTS(SELECT 1 FROM context_obligations
             WHERE session_id=?1 AND (?2 IS NULL OR invocation_id!=?2)
               AND kind!='interrupted_provider'
               AND NOT (kind='tool' AND sealed_unknown=1)
               AND NOT (kind='completed_provider' AND EXISTS(
                 SELECT 1 FROM runtime_events terminal WHERE terminal.invocation_id=context_obligations.invocation_id
                   AND terminal.kind='invocation_ended'
                   AND json_extract(terminal.event_header,'$.fact.outcome.kind') IN ('failed','cancelled'))))")?.query_row(rusqlite::params![session,current], |row| row.get(0))?;
        if unsettled {
            return Err(StoreError::HistoryUnsettled);
        }
        let unknown_provider_effect: bool = connection.prepare_cached("SELECT EXISTS(SELECT 1 FROM context_obligations
             WHERE session_id=?1 AND kind='interrupted_provider'
               AND (?2 IS NULL OR invocation_id!=?2)
               AND NOT EXISTS(SELECT 1 FROM runtime_events terminal
                 WHERE terminal.invocation_id=context_obligations.invocation_id AND terminal.kind='invocation_ended'
                   AND json_extract(terminal.event_header,'$.fact.outcome.kind') IN ('failed','cancelled')))")?.query_row(rusqlite::params![session,current], |row| row.get(0))?;
        if unknown_provider_effect {
            return Err(StoreError::HistoryProviderEffectUnresolved);
        }
        let unknown: bool = connection.prepare_cached("SELECT EXISTS(SELECT 1 FROM context_obligations o WHERE session_id=?1
             AND (kind='tool' AND sealed_unknown=1
               OR kind IN ('interrupted_provider','completed_provider') AND EXISTS(
                 SELECT 1 FROM runtime_events terminal WHERE terminal.invocation_id=o.invocation_id
                   AND terminal.kind='invocation_ended'
                   AND json_extract(terminal.event_header,'$.fact.outcome.kind') IN ('failed','cancelled'))))")?.query_row(rusqlite::params![session], |row| row.get(0))?;
        return Ok(unknown);
    }
    let unsafe_history: bool = connection.prepare_cached(concat!(
        "WITH runtime_events AS NOT MATERIALIZED (SELECT * FROM main.runtime_events WHERE sequence <= ?3), ",
        crate::model_items::accepted_calls!(), "
         SELECT EXISTS(SELECT 1 FROM runtime_events e
         WHERE json_extract(e.event_header, '$.invocation.session_id') = ?1
         AND (e.kind = 'invocation_opened' OR e.kind = 'tool_dispatched'
           OR e.kind = 'model_requested' OR e.kind = 'model_completed')
         AND (?2 IS NULL OR e.invocation_id != ?2) AND (
           (e.kind = 'invocation_opened' AND NOT EXISTS(SELECT 1 FROM runtime_events t
              WHERE t.invocation_id = e.invocation_id AND t.kind = 'invocation_ended'))
           OR (e.kind = 'tool_dispatched' AND NOT EXISTS(SELECT 1 FROM runtime_events t
              WHERE t.invocation_id = e.invocation_id AND t.operation_id = e.operation_id AND t.kind = 'tool_settled')
              AND NOT EXISTS(SELECT 1 FROM runtime_events terminal
                WHERE terminal.invocation_id = e.invocation_id AND terminal.kind = 'invocation_ended'
                AND json_extract(terminal.event_header, '$.fact.outcome.kind') IN ('failed','cancelled')))
           OR (e.kind = 'model_requested' AND NOT EXISTS(SELECT 1 FROM runtime_events t
              WHERE t.invocation_id = e.invocation_id AND t.operation_id = e.operation_id AND t.kind IN ('model_completed','model_interrupted')))
           OR (e.kind = 'model_requested' AND EXISTS(SELECT 1 FROM accepted_calls p
              WHERE p.invocation_id=e.invocation_id AND p.step_id=e.operation_id AND json_extract(p.call, '$.provider_executed') = 0
              AND NOT EXISTS(SELECT 1 FROM runtime_events d WHERE d.invocation_id = e.invocation_id
                AND d.operation_id = e.operation_id || ':' || json_extract(p.call, '$.id')
                AND d.kind IN ('tool_dispatched','tool_rejected'))))
           OR (e.kind='model_completed' AND NOT EXISTS(SELECT 1 FROM runtime_events terminal
             WHERE terminal.invocation_id=e.invocation_id AND terminal.kind='invocation_ended'
               AND json_extract(terminal.event_header,'$.fact.outcome.kind') IN ('failed','cancelled')) AND EXISTS(
             SELECT 1 FROM model_selected_parts s JOIN model_part_bodies p ON p.event_id=s.body_event_id AND p.ordinal=s.ordinal
             WHERE s.sequence=e.sequence AND json_extract(p.part,'$.kind')='tool_call' AND json_extract(p.part,'$.call.provider_executed')=1
               AND NOT EXISTS(SELECT 1 FROM model_selected_parts rs JOIN model_part_bodies result ON result.event_id=rs.body_event_id AND result.ordinal=rs.ordinal
                 WHERE rs.sequence=e.sequence AND json_extract(result.part,'$.kind')='tool_result'
                   AND json_extract(result.part,'$.id')=json_extract(p.part,'$.call.id')
                   AND json_extract(result.part,'$.name')=json_extract(p.part,'$.call.name'))))))",
    ))?.query_row(rusqlite::params![session,current,through as i64], |row| row.get(0))?;
    if unsafe_history {
        return Err(StoreError::HistoryUnsettled);
    }
    // An interrupted model step closes the request, not an observed remote
    // effect. Only that step's durably observed matching result settles it.
    let unknown_provider_effect: bool = connection.prepare_cached("SELECT EXISTS(SELECT 1 FROM runtime_events interrupted JOIN model_part_bodies call
           ON call.invocation_id=interrupted.invocation_id AND call.step_id=interrupted.operation_id
           AND call.source_kind='model_observed' AND call.source_sequence<interrupted.sequence
         WHERE interrupted.kind='model_interrupted' AND interrupted.event_session=?1
           AND interrupted.sequence<=?3 AND (?2 IS NULL OR interrupted.invocation_id!=?2)
           AND NOT EXISTS(SELECT 1 FROM runtime_events terminal
             WHERE terminal.invocation_id=interrupted.invocation_id AND terminal.kind='invocation_ended'
               AND terminal.sequence<=?3
               AND json_extract(terminal.event_header,'$.fact.outcome.kind') IN ('failed','cancelled'))
           AND json_extract(call.part,'$.kind')='tool_call' AND json_extract(call.part,'$.call.provider_executed')=1
           AND NOT EXISTS(SELECT 1 FROM model_part_bodies result WHERE result.invocation_id=call.invocation_id
             AND result.step_id=call.step_id AND result.source_kind='model_observed'
             AND result.source_sequence>call.source_sequence AND result.source_sequence<interrupted.sequence
             AND json_extract(result.part,'$.kind')='tool_result'
             AND json_extract(result.part,'$.id')=json_extract(call.part,'$.call.id')
             AND json_extract(result.part,'$.name')=json_extract(call.part,'$.call.name')))")?.query_row(rusqlite::params![session,current,through as i64], |row| row.get(0))?;
    if unknown_provider_effect {
        return Err(StoreError::HistoryProviderEffectUnresolved);
    }
    let unknown: bool = connection.prepare_cached("WITH events AS NOT MATERIALIZED (SELECT * FROM runtime_events WHERE sequence<=?2)
         SELECT EXISTS(SELECT 1 FROM events d
           WHERE d.event_session=?1 AND d.kind='tool_dispatched'
             AND EXISTS(SELECT 1 FROM events terminal WHERE terminal.invocation_id=d.invocation_id
               AND terminal.kind='invocation_ended'
               AND json_extract(terminal.event_header,'$.fact.outcome.kind') IN ('failed','cancelled'))
             AND NOT EXISTS(SELECT 1 FROM events result WHERE result.invocation_id=d.invocation_id
               AND result.operation_id=d.operation_id AND result.kind='tool_settled'))
           OR EXISTS(SELECT 1 FROM model_part_bodies call
             WHERE call.owner_session_id=?1 AND call.source_sequence<=?2
               AND json_extract(call.part,'$.kind')='tool_call'
               AND json_extract(call.part,'$.call.provider_executed')=1
               AND EXISTS(SELECT 1 FROM events terminal WHERE terminal.invocation_id=call.invocation_id
                 AND terminal.kind='invocation_ended'
                 AND json_extract(terminal.event_header,'$.fact.outcome.kind') IN ('failed','cancelled'))
               AND NOT EXISTS(SELECT 1 FROM model_part_bodies result
                 WHERE result.invocation_id=call.invocation_id AND result.step_id=call.step_id
                   AND result.source_sequence<=?2 AND json_extract(result.part,'$.kind')='tool_result'
                   AND json_extract(result.part,'$.id')=json_extract(call.part,'$.call.id')
                   AND json_extract(result.part,'$.name')=json_extract(call.part,'$.call.name')))")?.query_row(rusqlite::params![session,through as i64], |row| row.get(0))?;
    Ok(unknown)
}

pub(super) fn closed_boundary(
    connection: &rusqlite::Connection,
    session: &str,
    through: u64,
) -> Result<(), StoreError> {
    let closed: bool = connection.prepare_cached("SELECT EXISTS(SELECT 1 FROM session_history_events WHERE sequence = ? AND kind IN ('invocation_ended','message_imported')
         AND owner_session_id = ?)")?.query_row(rusqlite::params![i64::try_from(through).map_err(|_| invalid("coverage overflow"))?,session], |row| row.get(0))?;
    if !closed {
        return Err(invalid("coverage must end at a closed Session boundary"));
    }
    Ok(())
}

/// A live opening is allowed; covered effects must be settled.
pub(crate) fn settled_boundary(
    connection: &rusqlite::Connection,
    invocation: &str,
    through: u64,
) -> Result<(), StoreError> {
    execution_boundary(connection, invocation, through, Boundary::Settled)
}

/// Main-model control may observe cells and yielded calls without summarizing
/// away their unresolved effects. Unobserved calls and model steps still block.
pub(crate) fn model_boundary(
    connection: &rusqlite::Connection,
    invocation: &str,
    through: u64,
) -> Result<(), StoreError> {
    execution_boundary(connection, invocation, through, Boundary::Model)
}

enum Boundary {
    Settled,
    Model,
}

/// Ordinary Message requests retain their existing trace-admission contract,
/// but may overlap only private Summary work, never observed summary tools.
pub(super) fn summary_boundary(
    connection: &rusqlite::Connection,
    invocation: &str,
) -> Result<(), StoreError> {
    let unsafe_summary: bool = connection.prepare_cached("SELECT EXISTS(SELECT 1 FROM context_execution_steps INDEXED BY context_summary_tool_observed
         WHERE invocation_id=? AND purpose='summary' AND tool_observed_at IS NOT NULL)")?.query_row(rusqlite::params![invocation], |row| row.get(0))?;
    if unsafe_summary {
        return Err(invalid("summary contains tool observations"));
    }
    Ok(())
}

/// The prompt's immutable cut may lag only asynchronous cell events, not a new
/// model step, direct tool result, checkpoint, or other selected history.
pub(crate) fn model_source_unchanged(
    connection: &rusqlite::Connection,
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
    let changed: bool = connection.prepare_cached(&format!(
        "SELECT EXISTS(SELECT 1 FROM runtime_events e
         LEFT JOIN context_execution_steps s ON s.invocation_id=e.invocation_id
           AND s.operation_id=CAST(json_extract(e.event_header,'$.fact.step_id') AS TEXT)
         WHERE e.sequence > ?2
           AND (e.event_header IS NOT NULL AND e.event_session=?3) AND {filter}
           AND NOT (e.invocation_id=?1 AND e.kind IN ('tool_dispatched','tool_settled','tool_rejected','tool_notified')
             AND EXISTS(SELECT 1 FROM context_independent_tools i WHERE i.invocation_id=e.invocation_id
               AND i.operation_id=CASE WHEN e.kind='tool_notified'
                 THEN json_extract(e.event_header,'$.fact.operation_id') ELSE e.operation_id END))
           AND NOT (e.invocation_id=?1 AND e.kind IN ('model_requested','model_observed','model_interrupted')
             AND EXISTS(SELECT 1 FROM runtime_events r WHERE r.sequence=s.requested_at AND r.sequence>?2
               AND s.terminal_kind='model_interrupted' AND s.terminal_status='retryable_failure'
               AND (s.item_acceptance!=1 OR s.accepted_at IS NULL) AND s.barrier_at IS NULL
               AND json_remove(json_extract(r.event_header,'$.fact'),'$.step_id')=json_remove(json(?5),'$.step_id')))
           AND NOT (e.invocation_id=?1 AND e.kind IN ('model_requested','model_observed','model_completed','model_interrupted')
             AND COALESCE(s.purpose='summary' AND s.tool_observed_at IS NULL,0)))"
    ))?.query_row(rusqlite::params![invocation,*through as i64,&selection.session,&selection.lineage,serde_json::to_string(&request.fact)?], |row| row.get(0))?;
    if changed {
        return Err(invalid("model request source changed"));
    }
    Ok(())
}

const EXECUTION_BOUNDARY: &str = "WITH work AS (
           SELECT kind,operation_id FROM context_execution_work INDEXED BY context_execution_live
             WHERE invocation_id=?1 AND closed_at IS NULL AND opened_at<=?2 AND kind!='executor_tool'
           UNION ALL
           SELECT kind,operation_id FROM context_execution_work INDEXED BY context_execution_closed
             WHERE invocation_id=?1 AND closed_at>?2 AND opened_at<=?2 AND kind!='executor_tool')
         SELECT EXISTS(SELECT 1 FROM work w
           WHERE NOT (?3 AND w.kind='tool' AND EXISTS(
             SELECT 1 FROM context_independent_tools i WHERE i.invocation_id=?1
               AND i.operation_id=w.operation_id AND i.opened_at<=?2))
           AND NOT ((w.kind='interrupted' OR (?3 AND w.kind='model')) AND EXISTS(
             SELECT 1 FROM context_execution_steps s WHERE s.invocation_id=?1
               AND s.operation_id=w.operation_id AND s.requested_at<=?2 AND s.purpose='summary'
               AND (s.tool_observed_at IS NULL OR s.tool_observed_at>?2))))";

fn execution_boundary(
    connection: &rusqlite::Connection,
    invocation: &str,
    through: u64,
    boundary: Boundary,
) -> Result<(), StoreError> {
    let pending: bool = connection.prepare_cached(EXECUTION_BOUNDARY)?.query_row(
        rusqlite::params![
            invocation,
            i64::try_from(through).map_err(|_| invalid("coverage overflow"))?,
            matches!(boundary, Boundary::Model)
        ],
        |row| row.get(0),
    )?;
    if pending {
        return Err(invalid(
            "active source contains unresolved model or tool work",
        ));
    }
    Ok(())
}
