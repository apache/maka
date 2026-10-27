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
use maka_agent_facts::model::ModelEvent;
use sqlx::sqlite::SqliteWorkerConnection;

/// Record both projections after the ledger INSERT, inside its original transaction.
pub(crate) async fn record(
    db: &mut SqliteWorkerConnection<'_>,
    stored: &StoredEvent,
    json: &str,
) -> Result<(), StoreError> {
    obligations(db, stored).await?;
    execution(db, stored, json).await
}

async fn obligations(
    db: &mut SqliteWorkerConnection<'_>,
    stored: &StoredEvent,
) -> Result<(), StoreError> {
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
            | Fact::ModelObserved {
                event: ModelEvent::ToolCall(_),
                ..
            }
    ) {
        return Ok(());
    }
    sqlx::query(r#"INSERT INTO context_safety_heads VALUES(?1, ?2)
      ON CONFLICT(session_id) DO UPDATE SET through_sequence=MAX(through_sequence, excluded.through_sequence)"#).bind(session).bind(sequence).execute(&mut *db).await?;
    match &event.fact {
        Fact::InvocationOpened { .. } => {
            sqlx::query(r#"INSERT INTO context_obligations
    SELECT e.event_session, e.invocation_id, 'invocation', '', e.sequence,
           0
    FROM runtime_events e
    WHERE e.sequence=?1 AND e.kind='invocation_opened'
      AND NOT EXISTS(SELECT 1 FROM runtime_events t WHERE t.invocation_id=e.invocation_id AND t.kind='invocation_ended')"#).bind(sequence).execute(&mut *db).await?;
        }
        Fact::InvocationEnded { outcome } => {
            sqlx::query(
                r#"DELETE FROM context_obligations WHERE invocation_id=?1 AND kind='invocation'"#,
            )
            .bind(invocation)
            .execute(&mut *db)
            .await?;
            if matches!(outcome, InvocationOutcome::Failed { class, .. } if class == "outcome_unknown")
            {
                sqlx::query("UPDATE context_obligations SET sealed_unknown=1 WHERE invocation_id=? AND kind='tool'")
                    .bind(invocation).execute(&mut *db).await?;
            }
        }
        Fact::ModelRequested { .. } => {
            sqlx::query(r#"INSERT INTO context_obligations
    SELECT e.event_session, e.invocation_id, 'model', e.operation_id, e.sequence,
           0
    FROM runtime_events e
    WHERE e.sequence=?1 AND e.kind='model_requested'
      AND NOT EXISTS(SELECT 1 FROM runtime_events t WHERE t.invocation_id=e.invocation_id AND t.operation_id=e.operation_id AND t.kind IN ('model_completed','model_interrupted'))"#).bind(sequence).execute(&mut *db).await?;
        }
        Fact::ModelCompleted { .. } => {
            sqlx::query(r#"DELETE FROM context_obligations WHERE invocation_id=?1 AND kind='model' AND operation_id=?2"#).bind(invocation).bind(operation).execute(&mut *db).await?;
            sqlx::query(r#"INSERT INTO context_obligations
    SELECT e.event_session, e.invocation_id, 'call', e.operation_id || ':' || json_extract(p.value,'$.call.id'), e.sequence,
           0
    FROM runtime_events e, json_each(e.event_json,'$.fact.output.parts') p
    WHERE e.sequence=?1 AND e.kind='model_completed' AND json_extract(p.value,'$.kind')='tool_call'
      AND json_extract(p.value,'$.call.provider_executed')=0
      AND NOT EXISTS(SELECT 1 FROM runtime_events r WHERE r.invocation_id=e.invocation_id AND r.operation_id=e.operation_id AND r.kind='model_requested' AND json_extract(r.event_json,'$.fact.item_acceptance')=1)
      AND NOT EXISTS(SELECT 1 FROM runtime_events d WHERE d.invocation_id=e.invocation_id
        AND d.operation_id=e.operation_id || ':' || json_extract(p.value,'$.call.id') AND d.kind IN ('tool_dispatched','tool_rejected'))"#).bind(sequence).execute(&mut *db).await?;
            sqlx::query(r#"INSERT INTO context_obligations
    SELECT e.event_session, e.invocation_id, 'completed_provider', e.operation_id, e.sequence,
           0
    FROM runtime_events e
    WHERE e.sequence=?1 AND e.kind='model_completed'
      AND EXISTS(SELECT 1 FROM json_each(e.event_json,'$.fact.output.parts') p
        WHERE json_extract(p.value,'$.kind')='tool_call' AND json_extract(p.value,'$.call.provider_executed')=1
        AND NOT EXISTS(SELECT 1 FROM json_each(e.event_json,'$.fact.output.parts') result
          WHERE json_extract(result.value,'$.kind')='tool_result'
            AND json_extract(result.value,'$.id')=json_extract(p.value,'$.call.id')
            AND json_extract(result.value,'$.name')=json_extract(p.value,'$.call.name')))"#).bind(sequence).execute(&mut *db).await?;
        }
        Fact::ModelInterrupted { .. } => {
            sqlx::query(r#"DELETE FROM context_obligations WHERE invocation_id=?1 AND kind='model' AND operation_id=?2"#).bind(invocation).bind(operation).execute(&mut *db).await?;
            sqlx::query(r#"INSERT INTO context_obligations
    SELECT e.event_session, e.invocation_id, 'interrupted_provider', e.operation_id, e.sequence,
           0
    FROM runtime_events e
    WHERE e.sequence=?1 AND e.kind='model_interrupted'
      AND EXISTS(SELECT 1 FROM runtime_events call WHERE call.invocation_id=e.invocation_id AND call.kind='model_observed'
        AND CAST(json_extract(call.event_json,'$.fact.step_id') AS TEXT)=e.operation_id
        AND call.sequence<e.sequence AND json_extract(call.event_json,'$.fact.event.kind')='tool_call'
        AND json_extract(call.event_json,'$.fact.event.data.provider_executed')=1
        AND NOT EXISTS(SELECT 1 FROM runtime_events result WHERE result.invocation_id=call.invocation_id
          AND result.kind='model_observed' AND result.sequence>call.sequence AND result.sequence<e.sequence
          AND CAST(json_extract(result.event_json,'$.fact.step_id') AS TEXT)=e.operation_id
          AND json_extract(result.event_json,'$.fact.event.kind')='provider_tool_result'
          AND json_extract(result.event_json,'$.fact.event.data.id')=json_extract(call.event_json,'$.fact.event.data.id')
          AND json_extract(result.event_json,'$.fact.event.data.name')=json_extract(call.event_json,'$.fact.event.data.name')))"#).bind(sequence).execute(&mut *db).await?;
        }
        Fact::ToolDispatched { .. } => {
            sqlx::query(r#"DELETE FROM context_obligations WHERE invocation_id=?1 AND kind='call' AND operation_id=?2"#).bind(invocation).bind(operation).execute(&mut *db).await?;
            sqlx::query(r#"INSERT INTO context_obligations
    SELECT e.event_session, e.invocation_id, 'tool', e.operation_id, e.sequence,
           EXISTS(SELECT 1 FROM runtime_events terminal
             WHERE terminal.invocation_id=e.invocation_id AND terminal.kind='invocation_ended'
               AND json_extract(terminal.event_json,'$.fact.outcome.class')='outcome_unknown')
    FROM runtime_events e
    WHERE e.sequence=?1 AND e.kind='tool_dispatched'
      AND NOT EXISTS(SELECT 1 FROM runtime_events t WHERE t.invocation_id=e.invocation_id AND t.operation_id=e.operation_id AND t.kind='tool_settled')"#).bind(sequence).execute(&mut *db).await?;
        }
        Fact::ToolRejected { .. } => {
            sqlx::query(r#"DELETE FROM context_obligations WHERE invocation_id=?1 AND kind='call' AND operation_id=?2"#).bind(invocation).bind(operation).execute(&mut *db).await?;
        }
        Fact::ToolSettled { .. } => {
            sqlx::query(r#"DELETE FROM context_obligations WHERE invocation_id=?1 AND kind='tool' AND operation_id=?2"#).bind(invocation).bind(operation).execute(&mut *db).await?;
        }
        Fact::ModelObserved {
            event: ModelEvent::ToolCall(call),
            ..
        } if !call.provider_executed => {
            sqlx::query(r#"INSERT INTO context_obligations
    SELECT e.event_session, e.invocation_id, 'call', json_extract(e.event_json,'$.fact.step_id') || ':' || json_extract(e.event_json,'$.fact.event.data.id'), e.sequence,
           0
    FROM runtime_events e
    WHERE e.sequence=?1 AND e.kind='model_observed' AND json_extract(e.event_json,'$.fact.event.kind')='tool_call'
      AND json_extract(e.event_json,'$.fact.event.data.provider_executed')=0
      AND EXISTS(SELECT 1 FROM runtime_events r WHERE r.invocation_id=e.invocation_id
        AND r.operation_id=json_extract(e.event_json,'$.fact.step_id') AND r.kind='model_requested' AND json_extract(r.event_json,'$.fact.item_acceptance')=1)
      AND NOT EXISTS(SELECT 1 FROM runtime_events d WHERE d.invocation_id=e.invocation_id
        AND d.operation_id=json_extract(e.event_json,'$.fact.step_id') || ':' || json_extract(e.event_json,'$.fact.event.data.id') AND d.kind IN ('tool_dispatched','tool_rejected'))"#).bind(sequence).execute(&mut *db).await?;
        }
        _ => {}
    }
    Ok(())
}

async fn execution(
    db: &mut SqliteWorkerConnection<'_>,
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
            sqlx::query(r#"INSERT INTO context_execution_steps(invocation_id,operation_id,requested_at,purpose,item_acceptance)
    VALUES(?1,?2,?3,json_extract(?4,'$.fact.purpose'),
        COALESCE(json_extract(?4,'$.fact.item_acceptance'),0))"#).bind(invocation).bind(operation).bind(sequence).bind(json).execute(&mut *db).await?;
            sqlx::query(r#"INSERT INTO context_execution_work(invocation_id,kind,operation_id,opened_at,closed_at)
SELECT e.invocation_id,'model',e.operation_id,e.sequence,
    (SELECT MIN(t.sequence) FROM runtime_events t WHERE t.invocation_id=e.invocation_id
       AND t.operation_id=e.operation_id AND t.kind IN ('model_completed','model_interrupted'))
FROM runtime_events e WHERE e.kind='model_requested' AND e.sequence=?1"#).bind(sequence).execute(&mut *db).await?;
        }
        Fact::ModelObserved {
            event: observation, ..
        } => {
            if !matches!(
                observation,
                ModelEvent::ToolCall(_) | ModelEvent::ProviderToolResult { .. }
            ) {
                let relevant: bool = sqlx::query_scalar(r#"SELECT EXISTS(SELECT 1 FROM context_execution_steps
      WHERE invocation_id=?1
        AND operation_id=CAST(json_extract(?2,'$.fact.step_id') AS TEXT)
        AND (observed_at IS NULL OR terminal_kind='model_interrupted'
          OR (barrier_at IS NULL AND (json_extract(?2,'$.fact.event.kind')='finished'
            OR (json_extract(?2,'$.fact.event.data.provider_options') IS NOT NULL
              AND json_extract(?2,'$.fact.event.data.provider_options')!='{}')))
          OR (accepted_at IS NULL AND json_extract(?2,'$.fact.event.kind') IN ('source','part_finished'))))"#).bind(invocation).bind(json).fetch_one(&mut *db).await?;
                if !relevant {
                    return Ok(());
                }
            }
            sqlx::query(r#"UPDATE context_execution_steps SET
        observed_at=COALESCE(observed_at,?1),
        tool_observed_at=COALESCE(tool_observed_at,CASE WHEN json_extract(?2,'$.fact.event.kind') IN ('tool_call','provider_tool_result') THEN ?1 END),
        barrier_at=COALESCE(barrier_at,CASE WHEN (json_extract(?2,'$.fact.event.kind') IN ('provider_tool_result','finished')
    OR (json_extract(?2,'$.fact.event.kind')='tool_call' AND json_extract(?2,'$.fact.event.data.provider_executed')=1)
    OR (json_extract(?2,'$.fact.event.data.provider_options') IS NOT NULL
        AND json_extract(?2,'$.fact.event.data.provider_options')!='{}')) THEN ?1 END),
        accepted_at=COALESCE(accepted_at,CASE WHEN json_extract(?2,'$.fact.event.kind') IN ('source','part_finished','tool_call','provider_tool_result') THEN ?1 END)
    WHERE invocation_id=?3
      AND operation_id=CAST(json_extract(?2,'$.fact.step_id') AS TEXT)
      AND (observed_at IS NULL OR (tool_observed_at IS NULL AND json_extract(?2,'$.fact.event.kind') IN ('tool_call','provider_tool_result'))
        OR (barrier_at IS NULL AND (json_extract(?2,'$.fact.event.kind') IN ('provider_tool_result','finished')
    OR (json_extract(?2,'$.fact.event.kind')='tool_call' AND json_extract(?2,'$.fact.event.data.provider_executed')=1)
    OR (json_extract(?2,'$.fact.event.data.provider_options') IS NOT NULL
        AND json_extract(?2,'$.fact.event.data.provider_options')!='{}'))) OR (accepted_at IS NULL AND json_extract(?2,'$.fact.event.kind') IN ('source','part_finished','tool_call','provider_tool_result')))"#).bind(sequence).bind(json).bind(invocation).execute(&mut *db).await?;
            match observation {
                ModelEvent::ToolCall(call) => {
                    if !call.provider_executed {
                        sqlx::query(r#"INSERT INTO context_execution_work(invocation_id,kind,operation_id,opened_at,closed_at)
SELECT e.invocation_id,'call',s.operation_id || ':' || json_extract(e.event_json,'$.fact.event.data.id'),e.sequence,
    (SELECT MIN(d.sequence) FROM runtime_events d WHERE d.invocation_id=e.invocation_id
       AND d.operation_id=s.operation_id || ':' || json_extract(e.event_json,'$.fact.event.data.id')
       AND d.kind IN ('tool_dispatched','tool_rejected'))
FROM runtime_events e JOIN context_execution_steps s ON s.invocation_id=e.invocation_id
    AND s.operation_id=CAST(json_extract(e.event_json,'$.fact.step_id') AS TEXT) AND s.item_acceptance=1
WHERE e.kind='model_observed' AND e.sequence=?1 AND json_extract(e.event_json,'$.fact.event.kind')='tool_call'
  AND json_extract(e.event_json,'$.fact.event.data.provider_executed')=0"#).bind(sequence).execute(&mut *db).await?;
                    } else {
                        sqlx::query(r#"INSERT INTO context_execution_work(invocation_id,kind,operation_id,call_id,call_name,opened_at,closed_at)
SELECT e.invocation_id,'accepted_provider',s.operation_id,
    json_extract(e.event_json,'$.fact.event.data.id'),json_extract(e.event_json,'$.fact.event.data.name'),e.sequence,
    (SELECT MIN(t.sequence) FROM runtime_events t WHERE t.invocation_id=e.invocation_id AND t.kind='model_observed'
       AND CAST(json_extract(t.event_json,'$.fact.step_id') AS TEXT)=s.operation_id
       AND json_extract(t.event_json,'$.fact.event.kind')='provider_tool_result'
       AND json_extract(t.event_json,'$.fact.event.data.id')=json_extract(e.event_json,'$.fact.event.data.id')
       AND json_extract(t.event_json,'$.fact.event.data.name')=json_extract(e.event_json,'$.fact.event.data.name'))
FROM runtime_events e JOIN context_execution_steps s ON s.invocation_id=e.invocation_id
    AND s.operation_id=CAST(json_extract(e.event_json,'$.fact.step_id') AS TEXT) AND s.item_acceptance=1
WHERE e.kind='model_observed' AND e.sequence=?1 AND json_extract(e.event_json,'$.fact.event.kind')='tool_call'
  AND json_extract(e.event_json,'$.fact.event.data.provider_executed')=1"#).bind(sequence).execute(&mut *db).await?;
                    }
                }
                ModelEvent::ProviderToolResult { .. } => {
                    sqlx::query(
                        r#"UPDATE context_execution_work SET closed_at=?1
    WHERE invocation_id=?2 AND kind='accepted_provider'
      AND operation_id=CAST(json_extract(?3,'$.fact.step_id') AS TEXT)
      AND call_id=json_extract(?3,'$.fact.event.data.id')
      AND call_name=json_extract(?3,'$.fact.event.data.name') AND closed_at IS NULL"#,
                    )
                    .bind(sequence)
                    .bind(invocation)
                    .bind(json)
                    .execute(&mut *db)
                    .await?;
                }
                _ => {}
            }
            sqlx::query(r#"INSERT OR IGNORE INTO context_execution_work(invocation_id,kind,operation_id,opened_at)
SELECT s.invocation_id,'interrupted',s.operation_id,
    MAX(s.terminal_at,s.observed_at,CASE WHEN s.terminal_status='retryable_failure' THEN s.barrier_at ELSE s.observed_at END)
FROM context_execution_steps s WHERE s.terminal_kind='model_interrupted' AND s.observed_at IS NOT NULL
  AND (s.terminal_status!='retryable_failure' OR (s.item_acceptance!=1 AND s.barrier_at IS NOT NULL))
  AND NOT COALESCE(s.purpose='summary' AND s.tool_observed_at IS NULL,0) AND s.invocation_id=?1 AND s.operation_id=CAST(json_extract(?2,'$.fact.step_id') AS TEXT)"#).bind(invocation).bind(json).execute(&mut *db).await?;
        }
        Fact::ModelCompleted { .. } | Fact::ModelInterrupted { .. } => {
            sqlx::query(
                r#"UPDATE context_execution_steps SET terminal_at=?1,terminal_kind=?2,
        terminal_status=json_extract(?3,'$.fact.status')
    WHERE invocation_id=?4 AND operation_id=?5"#,
            )
            .bind(sequence)
            .bind(kind)
            .bind(json)
            .bind(invocation)
            .bind(operation)
            .execute(&mut *db)
            .await?;
            sqlx::query(r#"UPDATE context_execution_work SET closed_at=?1 WHERE invocation_id=?2 AND kind='model' AND operation_id=?3 AND closed_at IS NULL"#).bind(sequence).bind(invocation).bind(operation).execute(&mut *db).await?;
            if matches!(&event.fact, Fact::ModelCompleted { .. }) {
                sqlx::query(r#"INSERT INTO context_execution_work(invocation_id,kind,operation_id,opened_at,closed_at)
SELECT e.invocation_id,'call',e.operation_id || ':' || json_extract(p.value,'$.call.id'),e.sequence,
    (SELECT MIN(d.sequence) FROM runtime_events d WHERE d.invocation_id=e.invocation_id
       AND d.operation_id=e.operation_id || ':' || json_extract(p.value,'$.call.id')
       AND d.kind IN ('tool_dispatched','tool_rejected'))
FROM runtime_events e,json_each(e.event_json,'$.fact.output.parts') p
WHERE e.kind='model_completed' AND e.sequence=?1 AND json_extract(p.value,'$.kind')='tool_call'
  AND json_extract(p.value,'$.call.provider_executed')=0
  AND NOT EXISTS(SELECT 1 FROM context_execution_steps s WHERE s.invocation_id=e.invocation_id
    AND s.operation_id=e.operation_id AND s.item_acceptance=1)"#).bind(sequence).execute(&mut *db).await?;
                sqlx::query(r#"INSERT INTO context_execution_work(invocation_id,kind,operation_id,opened_at)
SELECT e.invocation_id,'completed_provider',e.operation_id,e.sequence
FROM runtime_events e WHERE e.kind='model_completed' AND e.sequence=?1
  AND EXISTS(SELECT 1 FROM json_each(e.event_json,'$.fact.output.parts') p
    WHERE json_extract(p.value,'$.kind')='tool_call' AND json_extract(p.value,'$.call.provider_executed')=1
      AND NOT EXISTS(SELECT 1 FROM json_each(e.event_json,'$.fact.output.parts') result
        WHERE json_extract(result.value,'$.kind')='tool_result'
          AND json_extract(result.value,'$.id')=json_extract(p.value,'$.call.id')
          AND json_extract(result.value,'$.name')=json_extract(p.value,'$.call.name')))"#).bind(sequence).execute(&mut *db).await?;
            } else {
                sqlx::query(r#"INSERT OR IGNORE INTO context_execution_work(invocation_id,kind,operation_id,opened_at)
SELECT s.invocation_id,'interrupted',s.operation_id,
    MAX(s.terminal_at,s.observed_at,CASE WHEN s.terminal_status='retryable_failure' THEN s.barrier_at ELSE s.observed_at END)
FROM context_execution_steps s WHERE s.terminal_kind='model_interrupted' AND s.observed_at IS NOT NULL
  AND (s.terminal_status!='retryable_failure' OR (s.item_acceptance!=1 AND s.barrier_at IS NOT NULL))
  AND NOT COALESCE(s.purpose='summary' AND s.tool_observed_at IS NULL,0) AND s.invocation_id=?1 AND s.operation_id=CAST(json_extract(?2,'$.fact.step_id') AS TEXT)"#).bind(invocation).bind(json).execute(&mut *db).await?;
            }
        }
        Fact::ToolDispatched { .. } | Fact::ToolRejected { .. } => {
            sqlx::query(r#"INSERT INTO context_independent_tools
    SELECT ?1,?2,?3
    WHERE ((?4='tool_dispatched' AND (
          json_extract(?5,'$.fact.call.origin.kind')='code_cell'
          OR (json_extract(?5,'$.fact.call.origin.kind')='host_sdk'
            AND json_extract(?5,'$.fact.call.origin.parent_relationship.kind')='evaluation_observer')))
        OR EXISTS(SELECT 1 FROM context_independent_tools p WHERE p.invocation_id=?1
          AND p.operation_id=json_extract(?5,'$.fact.call.origin.parent_operation_id')))"#).bind(invocation).bind(operation).bind(sequence).bind(kind).bind(json).execute(&mut *db).await?;
            sqlx::query(r#"UPDATE context_execution_work SET closed_at=?1 WHERE invocation_id=?2 AND kind='call' AND operation_id=?3 AND closed_at IS NULL"#).bind(sequence).bind(invocation).bind(operation).execute(&mut *db).await?;
            if matches!(&event.fact, Fact::ToolDispatched { .. }) {
                sqlx::query(r#"INSERT INTO context_execution_work(invocation_id,kind,operation_id,opened_at,closed_at)
SELECT e.invocation_id,'tool',e.operation_id,e.sequence,
    (SELECT MIN(t.sequence) FROM runtime_events t WHERE t.invocation_id=e.invocation_id
       AND t.operation_id=e.operation_id AND t.kind='tool_settled')
FROM runtime_events e WHERE e.kind='tool_dispatched' AND e.sequence=?1"#).bind(sequence).execute(&mut *db).await?;
            }
        }
        Fact::ToolSettled { .. } => {
            sqlx::query(r#"UPDATE context_execution_work SET closed_at=?1 WHERE invocation_id=?2 AND kind='tool' AND operation_id=?3 AND closed_at IS NULL"#).bind(sequence).bind(invocation).bind(operation).execute(&mut *db).await?;
        }
        _ => {}
    }
    Ok(())
}
