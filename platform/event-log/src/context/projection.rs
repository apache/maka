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

//! Canonical safety projections share ingress's original worker and transaction.
use crate::StoreError;
use maka_agent_facts::event::{Fact, InvocationOutcome, StoredEvent};
use maka_agent_facts::model::{ModelPart, recorded::ModelObservation};

/// Record both projections after the ledger INSERT, inside its original transaction.
pub(crate) fn record(
    db: &rusqlite::Connection,
    stored: &StoredEvent,
    json: &str,
) -> Result<(), StoreError> {
    obligations(db, stored)?;
    execution(db, stored, json)
}

fn obligations(db: &rusqlite::Connection, stored: &StoredEvent) -> Result<(), StoreError> {
    let event = &stored.event;
    let invocation = event.invocation.invocation_id.as_str();
    let operation = event.fact.operation_id();
    let sequence = i64::try_from(stored.sequence).map_err(|_| StoreError::PrefixTooLarge)?;
    let session = event.invocation.session_id.as_str();
    if !matches!(
        &event.fact,
        Fact::InvocationOpened { .. }
            | Fact::InvocationEnded { .. }
            | Fact::ToolDispatched { .. }
            | Fact::ToolRejected { .. }
            | Fact::ToolSettled { .. }
            | Fact::ModelRequested { .. }
            | Fact::ModelCompleted { .. }
            | Fact::ModelInterrupted { .. }
            | Fact::ModelObserved { .. }
    ) {
        return Ok(());
    }
    db.prepare_cached(r#"INSERT INTO context_safety_heads VALUES(?1, ?2)
      ON CONFLICT(session_id) DO UPDATE SET through_sequence=MAX(through_sequence, excluded.through_sequence)"#)?.execute(rusqlite::params![session,sequence])?;
    match &event.fact {
        Fact::InvocationOpened { .. } => {
            db.prepare_cached(r#"INSERT INTO context_obligations
    SELECT e.event_session, e.invocation_id, 'invocation', '', e.sequence,
           0
    FROM runtime_events e
    WHERE e.sequence=?1 AND e.kind='invocation_opened'
      AND NOT EXISTS(SELECT 1 FROM runtime_events t WHERE t.invocation_id=e.invocation_id AND t.kind='invocation_ended')"#)?.execute(rusqlite::params![sequence])?;
        }
        Fact::InvocationEnded { outcome } => {
            db.prepare_cached(
                r#"DELETE FROM context_obligations WHERE invocation_id=?1 AND kind='invocation'"#,
            )?
            .execute(rusqlite::params![invocation])?;
            if matches!(
                outcome,
                InvocationOutcome::Failed { .. } | InvocationOutcome::Cancelled { .. }
            ) {
                db.prepare_cached("UPDATE context_obligations SET sealed_unknown=1 WHERE invocation_id=? AND kind='tool'")?.execute(rusqlite::params![invocation])?;
            }
        }
        Fact::ModelRequested { .. } => {
            db.prepare_cached(r#"INSERT INTO context_obligations
    SELECT e.event_session, e.invocation_id, 'model', e.operation_id, e.sequence,
           0
    FROM runtime_events e
    WHERE e.sequence=?1 AND e.kind='model_requested'
      AND NOT EXISTS(SELECT 1 FROM runtime_events t WHERE t.invocation_id=e.invocation_id AND t.operation_id=e.operation_id AND t.kind IN ('model_completed','model_interrupted'))"#)?.execute(rusqlite::params![sequence])?;
        }
        Fact::ModelCompleted { .. } => {
            db.prepare_cached("DELETE FROM context_obligations WHERE invocation_id=? AND kind='model' AND operation_id=?")?.execute(rusqlite::params![invocation,operation])?;
            db.prepare_cached(concat!("WITH ", crate::model_items::accepted_calls!(),
                " INSERT INTO context_obligations SELECT ?1,c.invocation_id,'call',c.step_id || ':' || json_extract(c.call,'$.id'),c.sequence,0
                 FROM accepted_calls c WHERE c.sequence=?2 AND json_extract(c.call,'$.provider_executed')=0
                 AND NOT EXISTS(SELECT 1 FROM runtime_events d WHERE d.invocation_id=c.invocation_id
                    AND d.operation_id=c.step_id || ':' || json_extract(c.call,'$.id') AND d.kind IN ('tool_dispatched','tool_rejected'))"))?.execute(rusqlite::params![session,sequence])?;
            db.prepare_cached("INSERT INTO context_obligations SELECT ?1,?2,'completed_provider',?3,?4,0
                WHERE EXISTS(SELECT 1 FROM model_selected_parts s JOIN model_part_bodies b ON b.event_id=s.body_event_id AND b.ordinal=s.ordinal
                  WHERE s.sequence=?4 AND json_extract(b.part,'$.kind')='tool_call' AND json_extract(b.part,'$.call.provider_executed')=1
                  AND NOT EXISTS(SELECT 1 FROM model_selected_parts rs JOIN model_part_bodies rb ON rb.event_id=rs.body_event_id AND rb.ordinal=rs.ordinal
                    WHERE rs.sequence=?4 AND json_extract(rb.part,'$.kind')='tool_result'
                    AND json_extract(rb.part,'$.id')=json_extract(b.part,'$.call.id') AND json_extract(rb.part,'$.name')=json_extract(b.part,'$.call.name'))) ")?.execute(rusqlite::params![session,invocation,operation,sequence])?;
        }
        Fact::ModelInterrupted { .. } => {
            db.prepare_cached("DELETE FROM context_obligations WHERE invocation_id=? AND kind='model' AND operation_id=?")?.execute(rusqlite::params![invocation,operation])?;
            db.prepare_cached("INSERT INTO context_obligations SELECT ?1,?2,'interrupted_provider',?3,?4,0
                WHERE EXISTS(SELECT 1 FROM model_part_bodies call WHERE call.invocation_id=?2 AND call.step_id=?3
                  AND call.source_kind='model_observed' AND json_extract(call.part,'$.kind')='tool_call'
                  AND json_extract(call.part,'$.call.provider_executed')=1
                  AND NOT EXISTS(SELECT 1 FROM model_part_bodies result WHERE result.invocation_id=?2 AND result.step_id=?3
                    AND result.source_kind='model_observed' AND json_extract(result.part,'$.kind')='tool_result'
                    AND json_extract(result.part,'$.id')=json_extract(call.part,'$.call.id')
                    AND json_extract(result.part,'$.name')=json_extract(call.part,'$.call.name'))) ")?.execute(rusqlite::params![session,invocation,operation,sequence])?;
        }
        Fact::ToolDispatched { .. } => {
            db.prepare_cached(r#"DELETE FROM context_obligations WHERE invocation_id=?1 AND kind='call' AND operation_id=?2"#)?.execute(rusqlite::params![invocation,operation])?;
            db.prepare_cached(r#"INSERT INTO context_obligations
    SELECT e.event_session, e.invocation_id, 'tool', e.operation_id, e.sequence,
           EXISTS(SELECT 1 FROM runtime_events terminal
             WHERE terminal.invocation_id=e.invocation_id AND terminal.kind='invocation_ended'
               AND json_extract(terminal.event_header,'$.fact.outcome.kind') IN ('failed','cancelled'))
    FROM runtime_events e
    WHERE e.sequence=?1 AND e.kind='tool_dispatched'
      AND NOT EXISTS(SELECT 1 FROM runtime_events t WHERE t.invocation_id=e.invocation_id AND t.operation_id=e.operation_id AND t.kind='tool_settled')"#)?.execute(rusqlite::params![sequence])?;
        }
        Fact::ToolRejected { .. } => {
            db.prepare_cached(r#"DELETE FROM context_obligations WHERE invocation_id=?1 AND kind='call' AND operation_id=?2"#)?.execute(rusqlite::params![invocation,operation])?;
        }
        Fact::ToolSettled { .. } => {
            db.prepare_cached(r#"DELETE FROM context_obligations WHERE invocation_id=?1 AND kind='tool' AND operation_id=?2"#)?.execute(rusqlite::params![invocation,operation])?;
        }
        Fact::ModelObserved {
            event: ModelObservation::Part(record),
            ..
        } if matches!(record.part.as_ref(), ModelPart::ToolCall { call } if !call.provider_executed) =>
        {
            db.prepare_cached(concat!("WITH ", crate::model_items::accepted_calls!(),
                " INSERT INTO context_obligations SELECT ?1,c.invocation_id,'call',c.step_id || ':' || json_extract(c.call,'$.id'),c.sequence,0
                 FROM accepted_calls c WHERE c.sequence=?2 AND json_extract(c.call,'$.provider_executed')=0
                 AND NOT EXISTS(SELECT 1 FROM runtime_events d WHERE d.invocation_id=c.invocation_id
                  AND d.operation_id=c.step_id || ':' || json_extract(c.call,'$.id') AND d.kind IN ('tool_dispatched','tool_rejected'))"))?.execute(rusqlite::params![session,sequence])?;
        }
        _ => {}
    }
    Ok(())
}

fn execution(
    db: &rusqlite::Connection,
    stored: &StoredEvent,
    json: &str,
) -> Result<(), StoreError> {
    let event = &stored.event;
    let invocation = event.invocation.invocation_id.as_str();
    let operation = event.fact.operation_id();
    let sequence = i64::try_from(stored.sequence).map_err(|_| StoreError::PrefixTooLarge)?;
    let kind = event.fact.kind();
    match &event.fact {
        Fact::ModelRequested { .. } => {
            db.prepare_cached(r#"INSERT INTO context_execution_steps(invocation_id,operation_id,requested_at,purpose,item_acceptance)
    VALUES(?1,?2,?3,json_extract(?4,'$.fact.purpose'),
        COALESCE(json_extract(?4,'$.fact.item_acceptance'),0))"#)?.execute(rusqlite::params![invocation,operation,sequence,json])?;
            db.prepare_cached(r#"INSERT INTO context_execution_work(invocation_id,kind,operation_id,opened_at,closed_at)
SELECT e.invocation_id,'model',e.operation_id,e.sequence,
    (SELECT MIN(t.sequence) FROM runtime_events t WHERE t.invocation_id=e.invocation_id
       AND t.operation_id=e.operation_id AND t.kind IN ('model_completed','model_interrupted'))
FROM runtime_events e WHERE e.kind='model_requested' AND e.sequence=?1"#)?.execute(rusqlite::params![sequence])?;
        }
        Fact::ModelObserved {
            step_id,
            event: observation,
        } => {
            let (tool, barrier, complete) = match observation {
                ModelObservation::Part(record) => {
                    let (tool, effect, options) = match record.part.as_ref() {
                        ModelPart::Text {
                            provider_options, ..
                        } => (false, false, provider_options.as_deref()),
                        ModelPart::Source { .. } => (false, false, None),
                        ModelPart::ToolCall { call } => {
                            (true, call.provider_executed, call.provider_options.as_ref())
                        }
                        ModelPart::ToolResult {
                            provider_options, ..
                        } => (true, true, provider_options.as_ref()),
                    };
                    (
                        tool,
                        effect
                            || options.is_some_and(|value| {
                                value.as_object().is_none_or(|object| !object.is_empty())
                            }),
                        true,
                    )
                }
                ModelObservation::ProviderOptions { options, .. } => (
                    false,
                    options.as_object().is_none_or(|object| !object.is_empty()),
                    false,
                ),
                ModelObservation::Finished { .. } => (false, true, false),
                ModelObservation::ResponseMetadata { .. } => (false, false, false),
            };
            db.prepare_cached(
                "UPDATE context_execution_steps SET
                observed_at=COALESCE(observed_at,?1),
                tool_observed_at=COALESCE(tool_observed_at,CASE WHEN ?2 THEN ?1 END),
                barrier_at=COALESCE(barrier_at,CASE WHEN ?3 THEN ?1 END),
                accepted_at=COALESCE(accepted_at,CASE WHEN ?4 AND item_acceptance=1 THEN ?1 END)
                WHERE invocation_id=?5 AND operation_id=?6",
            )?
            .execute(rusqlite::params![
                sequence, tool, barrier, complete, invocation, step_id
            ])?;
            if let ModelObservation::Part(record) = observation {
                match record.part.as_ref() {
                    ModelPart::ToolCall { call } if !call.provider_executed => {
                        db.prepare_cached(concat!("WITH ", crate::model_items::accepted_calls!(),
                            " INSERT INTO context_execution_work(invocation_id,kind,operation_id,opened_at,closed_at)
                              SELECT c.invocation_id,'call',c.step_id || ':' || json_extract(c.call,'$.id'),c.sequence,
                                (SELECT MIN(d.sequence) FROM runtime_events d WHERE d.invocation_id=c.invocation_id AND d.operation_id=c.step_id || ':' || json_extract(c.call,'$.id') AND d.kind IN ('tool_dispatched','tool_rejected'))
                              FROM accepted_calls c WHERE c.sequence=?1 AND json_extract(c.call,'$.provider_executed')=0"))?.execute(rusqlite::params![sequence])?;
                    }
                    ModelPart::ToolCall { call } => {
                        db.prepare_cached("INSERT INTO context_execution_work(invocation_id,kind,operation_id,call_id,call_name,opened_at,closed_at)
                            SELECT ?1,'accepted_provider',?2,?3,?4,?5,
                            (SELECT MIN(result.source_sequence) FROM model_part_bodies result
                             WHERE result.invocation_id=?1 AND result.step_id=?2 AND result.source_kind='model_observed'
                               AND json_extract(result.part,'$.kind')='tool_result' AND json_extract(result.part,'$.id')=?3 AND json_extract(result.part,'$.name')=?4)
                            WHERE EXISTS(SELECT 1 FROM context_execution_steps WHERE invocation_id=?1 AND operation_id=?2 AND item_acceptance=1)")?.execute(rusqlite::params![invocation,step_id,&call.id,&call.name,sequence])?;
                    }
                    ModelPart::ToolResult { id, name, .. } => {
                        db.prepare_cached("UPDATE context_execution_work SET closed_at=?1 WHERE invocation_id=?2 AND operation_id=?3 AND kind='accepted_provider' AND call_id=?4 AND call_name=?5 AND closed_at IS NULL")?.execute(rusqlite::params![sequence,invocation,step_id,id,name])?;
                    }
                    _ => {}
                }
            }
            record_interrupted(db, invocation, step_id)?;
        }
        Fact::ModelCompleted { .. } | Fact::ModelInterrupted { .. } => {
            if let Fact::ModelInterrupted {
                partial: Some(partial),
                ..
            } = &event.fact
            {
                let observed = !partial.parts.is_empty() || !partial.tool_inputs.is_empty();
                let tool = partial.parts.iter().any(|part| matches!(part,
                    maka_agent_facts::model::recorded::CompletionPart::Own(record)
                    if matches!(record.part.as_ref(), ModelPart::ToolCall { .. } | ModelPart::ToolResult { .. })));
                db.prepare_cached(
                    "UPDATE context_execution_steps SET
                    observed_at=COALESCE(observed_at,CASE WHEN ?1 THEN ?2 END),
                    tool_observed_at=COALESCE(tool_observed_at,CASE WHEN ?3 THEN ?2 END)
                    WHERE invocation_id=?4 AND operation_id=?5",
                )?
                .execute(rusqlite::params![
                    observed, sequence, tool, invocation, operation
                ])?;
            }
            db.prepare_cached(
                r#"UPDATE context_execution_steps SET terminal_at=?1,terminal_kind=?2,
        terminal_status=json_extract(?3,'$.fact.status')
    WHERE invocation_id=?4 AND operation_id=?5"#,
            )?
            .execute(rusqlite::params![
                sequence, kind, json, invocation, operation
            ])?;
            db.prepare_cached(r#"UPDATE context_execution_work SET closed_at=?1 WHERE invocation_id=?2 AND kind='model' AND operation_id=?3 AND closed_at IS NULL"#)?.execute(rusqlite::params![sequence,invocation,operation])?;
            if matches!(&event.fact, Fact::ModelCompleted { .. }) {
                db.prepare_cached("UPDATE context_execution_steps SET accepted_at=COALESCE(accepted_at,?1) WHERE invocation_id=?2 AND operation_id=?3")?.execute(rusqlite::params![sequence,invocation,operation])?;
                db.prepare_cached(concat!("WITH ", crate::model_items::accepted_calls!(),
                    " INSERT INTO context_execution_work(invocation_id,kind,operation_id,opened_at,closed_at)
                      SELECT c.invocation_id,'call',c.step_id || ':' || json_extract(c.call,'$.id'),c.sequence,
                        (SELECT MIN(d.sequence) FROM runtime_events d WHERE d.invocation_id=c.invocation_id AND d.operation_id=c.step_id || ':' || json_extract(c.call,'$.id') AND d.kind IN ('tool_dispatched','tool_rejected'))
                      FROM accepted_calls c WHERE c.sequence=?1 AND json_extract(c.call,'$.provider_executed')=0"))?.execute(rusqlite::params![sequence])?;
                db.prepare_cached("INSERT INTO context_execution_work(invocation_id,kind,operation_id,opened_at)
                    SELECT invocation_id,'completed_provider',operation_id,opened_at FROM context_obligations
                    WHERE invocation_id=?1 AND kind='completed_provider' AND operation_id=?2")?.execute(rusqlite::params![invocation,operation])?;
            } else {
                record_interrupted(
                    db,
                    invocation,
                    operation.expect("model terminal carries its step identity"),
                )?;
            }
        }

        Fact::ToolDispatched { .. } | Fact::ToolRejected { .. } => {
            db.prepare_cached(r#"INSERT INTO context_independent_tools
    SELECT ?1,?2,?3
    WHERE ((?4='tool_dispatched' AND (
          json_extract(?5,'$.fact.call.origin.kind')='code_cell'
          OR (json_extract(?5,'$.fact.call.origin.kind')='host_sdk'
            AND json_extract(?5,'$.fact.call.origin.parent_relationship.kind')='evaluation_observer')))
        OR EXISTS(SELECT 1 FROM context_independent_tools p WHERE p.invocation_id=?1
          AND p.operation_id=json_extract(?5,'$.fact.call.origin.parent_operation_id')))"#)?.execute(rusqlite::params![invocation,operation,sequence,kind,json])?;
            db.prepare_cached(r#"UPDATE context_execution_work SET closed_at=?1 WHERE invocation_id=?2 AND kind='call' AND operation_id=?3 AND closed_at IS NULL"#)?.execute(rusqlite::params![sequence,invocation,operation])?;
            if matches!(&event.fact, Fact::ToolDispatched { .. }) {
                db.prepare_cached(r#"INSERT INTO context_execution_work(invocation_id,kind,operation_id,opened_at,closed_at)
SELECT e.invocation_id,'tool',e.operation_id,e.sequence,
    (SELECT MIN(t.sequence) FROM runtime_events t WHERE t.invocation_id=e.invocation_id
       AND t.operation_id=e.operation_id AND t.kind='tool_settled')
FROM runtime_events e WHERE e.kind='tool_dispatched' AND e.sequence=?1"#)?.execute(rusqlite::params![sequence])?;
            }
        }
        Fact::ToolYielded { .. } => {
            db.prepare_cached("WITH RECURSIVE children AS MATERIALIZED (
                SELECT w.operation_id,json_extract(d.event_header,'$.fact.call.origin.parent_operation_id') AS parent
                FROM context_execution_work w JOIN runtime_events d ON d.sequence=w.opened_at
                WHERE w.invocation_id=?1 AND w.kind='tool' AND w.closed_at IS NULL),
                observed(operation_id) AS (
                SELECT ?2 UNION ALL SELECT d.operation_id FROM children d JOIN observed p ON d.parent=p.operation_id)
                INSERT OR IGNORE INTO context_independent_tools
                    SELECT ?1,operation_id,?3 FROM observed")?.execute(rusqlite::params![invocation,operation,sequence])?;
        }
        Fact::ToolSettled { .. } => {
            db.prepare_cached(r#"UPDATE context_execution_work SET closed_at=?1 WHERE invocation_id=?2 AND kind='tool' AND operation_id=?3 AND closed_at IS NULL"#)?.execute(rusqlite::params![sequence,invocation,operation])?;
        }
        Fact::ExecutorObserved {
            output: maka_agent_facts::executor::Output::ToolStart { tool_call_id, .. },
        } => {
            db.prepare_cached("INSERT OR IGNORE INTO context_execution_work(invocation_id,kind,operation_id,opened_at,closed_at)
                SELECT ?1,'executor_tool',?2,?3,
                    (SELECT MIN(e.sequence) FROM event_log e INDEXED BY executor_tool_observations
                     WHERE e.invocation_id=?1 AND e.event_header IS NOT NULL
                       AND e.kind IN ('executor_observed','executor_completed')
                       AND json_extract(e.event_header,'$.fact.output.toolCallId')=?2
                       AND json_extract(e.event_header,'$.fact.output.type')='tool_result')
                WHERE NOT EXISTS(SELECT 1 FROM context_execution_work
                    WHERE invocation_id=?1 AND kind='executor_tool' AND operation_id=?2
                      AND call_id='' AND call_name='')")?.execute(rusqlite::params![invocation,tool_call_id,sequence])?;
        }
        Fact::ExecutorObserved {
            output: maka_agent_facts::executor::Output::ToolResult { tool_call_id, .. },
        } => {
            db.prepare_cached(
                "UPDATE context_execution_work SET closed_at=?1
                WHERE invocation_id=?2 AND kind='executor_tool' AND operation_id=?3
                  AND call_id='' AND call_name='' AND closed_at IS NULL",
            )?
            .execute(rusqlite::params![sequence, invocation, tool_call_id])?;
        }
        Fact::ExecutorCompleted { .. } | Fact::InvocationEnded { .. } => {
            db.prepare_cached(
                "UPDATE context_execution_work INDEXED BY context_execution_live SET closed_at=?1
                WHERE invocation_id=?2 AND closed_at IS NULL AND kind='executor_tool'",
            )?
            .execute(rusqlite::params![sequence, invocation])?;
        }
        _ => {}
    }
    Ok(())
}

fn record_interrupted(
    db: &rusqlite::Connection,
    invocation: &str,
    step: &str,
) -> Result<(), StoreError> {
    db.prepare_cached("INSERT OR IGNORE INTO context_execution_work(invocation_id,kind,operation_id,opened_at)
        SELECT invocation_id,'interrupted',operation_id,
          MAX(terminal_at,observed_at,CASE WHEN terminal_status='retryable_failure' THEN barrier_at ELSE observed_at END)
        FROM context_execution_steps WHERE terminal_kind='model_interrupted' AND observed_at IS NOT NULL
          AND terminal_status!='steered'
          AND (terminal_status!='retryable_failure' OR (item_acceptance!=1 AND barrier_at IS NOT NULL))
          AND NOT COALESCE(purpose='summary' AND tool_observed_at IS NULL,0) AND invocation_id=?1 AND operation_id=?2")?.execute(rusqlite::params![invocation,step])?;
    Ok(())
}
