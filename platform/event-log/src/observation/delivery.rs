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

use super::{high_water, invalid};
use crate::{EventLog, StoreError, sessions};
use futures_util::TryStreamExt;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::model::TextKind;
use serde::{Deserialize, Serialize};
use sqlx::{Connection, Row};

/// Delivery projection of committed facts, never model replay material.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoreStreamEvent {
    pub sequence: u64,
    pub id: String,
    pub invocation: Invocation,
    pub root_run_id: String,
    pub recorded_at: std::time::SystemTime,
    pub fact: StreamFact,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StreamFact {
    ContextChanged,
    ExecutorStarted,
    ExecutorDelta {
        text_kind: TextKind,
        text: String,
    },
    ExecutorCompleted,
    ExecutorToolStart {
        tool_call_id: String,
        name: String,
    },
    ExecutorToolProgress {
        tool_call_id: String,
        /// The latest at most 2048 codepoints; the original observation remains in the log.
        text: String,
    },
    ExecutorToolResult {
        tool_call_id: String,
        is_error: bool,
    },
    InvocationOpened,
    MessageSteered,
    ModelPartCommitted {
        step_id: String,
        message_id: String,
        ordinal: u64,
    },
    ToolInputReady {
        step_id: String,
        tool_call_id: String,
        name: String,
        provider_executed: bool,
    },
    ProviderToolResult {
        step_id: String,
        tool_call_id: String,
        is_error: bool,
    },
    StepEnded {
        step_id: String,
        completed: bool,
        failed: bool,
        #[serde(default)]
        interrupted: Vec<String>,
    },
    InvocationEnded {
        failed: bool,
        #[serde(default)]
        interrupted: Vec<String>,
    },
    ToolDispatched {
        #[serde(default)]
        title: Option<maka_agent_facts::display::Text>,
        operation_id: String,
        name: String,
    },
    ToolRejected {
        operation_id: String,
        name: String,
    },
    ToolSettled {
        operation_id: String,
        outcome: ToolSettlement,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolSettlement {
    Succeeded,
    Failed,
    Unknown,
}

#[derive(Debug)]
pub struct StreamEventPage {
    pub events: Vec<StoreStreamEvent>,
    /// Stable log fence against which this page was read.
    pub through_sequence: u64,
    /// Continue strictly after this sequence; None means the fence is exhausted.
    pub next_after: Option<u64>,
}

impl EventLog {
    /// Read only stream delivery fields in (after, through]. Unrelated facts and
    /// provider payloads consume no page budget. The byte budget counts projected
    /// JSON, including identities and escaping; the first complete item always advances.
    pub async fn session_stream_events(
        &self,
        session_id: &str,
        after: u64,
        through: u64,
        max_events: usize,
        max_bytes: usize,
    ) -> Result<StreamEventPage, StoreError> {
        self.validate_root()?;
        sessions::validate_id(session_id)?;
        if after > through || max_events == 0 || max_events > 512 || max_bytes == 0 {
            return Err(invalid("invalid stream page bounds"));
        }
        let after = i64::try_from(after).map_err(|_| invalid("invalid stream cursor"))?;
        let fence = i64::try_from(through).map_err(|_| invalid("invalid stream fence"))?;
        let session_id = session_id.to_owned();
        self.connection
            .read(move |connection| {
                Box::pin(async move {
                    let mut transaction = connection.begin().await?;
                    if through > high_water(&mut transaction).await? {
                        return Err(invalid("stream fence is beyond committed history"));
                    }
                    let mut events: Vec<StoreStreamEvent> = Vec::new();
                    let mut bytes = 0usize;
                    let mut next_after = None;
                    {
                        let mut rows = sqlx::query(STREAM_EVENTS)
                            .bind(&session_id)
                            .bind(after)
                            .bind(fence)
                            .bind(max_events as i64 + 1)
                            .fetch(&mut *transaction);
                        while let Some(row) = rows.try_next().await? {
                            // Check projected JSON before decoding identities or delta text.
                            // No complete RuntimeEvent is deserialized.
                            let json: &str = row.try_get(0)?;
                            if events.len() == max_events
                                || (!events.is_empty()
                                    && json.len() > max_bytes.saturating_sub(bytes))
                            {
                                next_after = events.last().map(|event| event.sequence);
                                break;
                            }
                            let event: StoreStreamEvent = serde_json::from_str(json)?;
                            if event.invocation.session_id != session_id {
                                return Err(invalid("stored stream scope changed"));
                            }
                            bytes += json.len();
                            events.push(event);
                        }
                    }
                    // Only failed boundaries need their canonical presentation verdict.
                    // Reuse its bounded reconstruction; provider metadata never enters delivery.
                    let mut enriched = Vec::new();
                    bytes = 0;
                    for mut event in events {
                        let step = match &event.fact {
                            StreamFact::StepEnded {
                                step_id,
                                failed: true,
                                ..
                            } => Some(Some(step_id.as_str())),
                            StreamFact::InvocationEnded { failed: true, .. } => Some(None),
                            _ => None,
                        };
                        if let Some(step) = step {
                            let ids = crate::transcript::interrupted_messages(
                                &mut transaction,
                                &event.invocation.invocation_id,
                                step,
                                event.sequence,
                            )
                            .await?;
                            match &mut event.fact {
                                StreamFact::StepEnded { interrupted, .. }
                                | StreamFact::InvocationEnded { interrupted, .. } => {
                                    *interrupted = ids
                                }
                                _ => unreachable!(),
                            }
                        }
                        let size = serde_json::to_vec(&event)?.len();
                        if !enriched.is_empty() && size > max_bytes.saturating_sub(bytes) {
                            next_after = enriched
                                .last()
                                .map(|event: &StoreStreamEvent| event.sequence);
                            break;
                        }
                        bytes += size;
                        enriched.push(event);
                    }
                    transaction.commit().await?;
                    Ok(StreamEventPage {
                        events: enriched,
                        through_sequence: through,
                        next_after,
                    })
                })
            })
            .await
    }
}

// CASE evaluates only the selected arm: model bodies and provider options never
// enter delivery. Canonical parts replace their preview by stable message identity.
const STREAM_EVENTS: &str = "
WITH events AS MATERIALIZED (
SELECT json_object(
    'sequence', sequence, 'id', event_id,
    'recorded_at', json_extract(event_header, '$.recorded_at'),
    'invocation', json_object(
        'session_id', json_extract(event_header, '$.invocation.session_id'),
        'turn_id', json_extract(event_header, '$.invocation.turn_id'),
        'run_id', json_extract(event_header, '$.invocation.run_id'),
        'invocation_id', invocation_id),
    'fact', json(CASE
        WHEN kind IN ('model_requested', 'context_checkpoint_recorded', 'context_compaction_waiting') OR
             (kind IN ('model_completed', 'model_interrupted') AND EXISTS (
                SELECT 1 FROM runtime_events request WHERE request.invocation_id = runtime_events.invocation_id
                AND request.kind = 'model_requested' AND request.operation_id = runtime_events.operation_id
                AND json_extract(request.event_header, '$.fact.purpose') = 'summary'))
            THEN json_object('kind', 'context_changed')
        WHEN kind IN ('executor_started', 'executor_completed') THEN json_object('kind', kind)
        WHEN kind = 'executor_observed' AND json_extract(event_header, '$.fact.output.type') IN ('output_delta','thinking_delta') THEN
            json_object('kind', 'executor_delta',
                'text_kind', CASE WHEN json_extract(event_header, '$.fact.output.type') = 'thinking_delta' THEN 'thinking' ELSE 'text' END,
                'text', json_extract(event_header, '$.fact.output.text'))
        WHEN kind = 'executor_observed' AND json_extract(event_header, '$.fact.output.type') = 'tool_start' THEN
            json_object('kind', 'executor_tool_start', 'tool_call_id', json_extract(event_header, '$.fact.output.toolCallId'), 'name', json_extract(event_header, '$.fact.output.name'))
        WHEN kind = 'executor_observed' AND json_extract(event_header, '$.fact.output.type') = 'tool_progress' THEN
            json_object('kind', 'executor_tool_progress', 'tool_call_id', json_extract(event_header, '$.fact.output.toolCallId'), 'text', substr(json_extract(event_header, '$.fact.output.text'), -2048))
        WHEN kind = 'executor_observed' THEN
            json_object('kind', 'executor_tool_result', 'tool_call_id', json_extract(event_header, '$.fact.output.toolCallId'),
                'is_error', json(CASE WHEN json_extract(event_header, '$.fact.output.isError') THEN 'true' ELSE 'false' END))
        WHEN kind = 'tool_dispatched' THEN
            json_object('kind', kind, 'operation_id', operation_id,
                'name', json_extract(event_header, '$.fact.name'),
                'title', json_extract(event_header, '$.fact.title'))
        WHEN kind = 'tool_rejected' THEN
            json_object('kind', kind, 'operation_id', operation_id,
                'name', json_extract(event_header, '$.fact.name'))
        WHEN kind = 'tool_settled' THEN
            json_object('kind', kind, 'operation_id', operation_id,
                'outcome', json_extract(event_header, '$.fact.outcome.kind'))
        WHEN kind IN ('invocation_opened', 'message_steered') THEN json_object('kind', kind)
        WHEN kind = 'invocation_ended' THEN json_object('kind', kind,
            'failed', json(CASE WHEN json_extract(event_header, '$.fact.outcome.kind') = 'failed'
                OR (json_extract(event_header, '$.fact.outcome.kind') = 'context_compact_finished'
                    AND json_extract(event_header, '$.fact.outcome.outcome.kind') = 'failed')
                OR (json_extract(event_header, '$.fact.outcome.kind') = 'cancelled' AND EXISTS (
                    SELECT 1 FROM runtime_events started WHERE started.invocation_id = runtime_events.invocation_id AND started.kind = 'executor_started'))
                THEN 'true' ELSE 'false' END))
        WHEN kind IN ('model_completed', 'model_interrupted') THEN
            json_object('kind', 'step_ended',
                'step_id', json_extract(event_header, '$.fact.step_id'),
                'completed', json(CASE WHEN kind='model_completed' THEN 'true' ELSE 'false' END),
                'failed', json(CASE WHEN kind = 'model_interrupted' AND json_extract(event_header, '$.fact.status') != 'cancelled' THEN 'true' ELSE 'false' END))
        WHEN json_extract(event_header, '$.fact.event.data.part.kind') = 'tool_call' THEN
            json_object('kind', 'tool_input_ready',
                'step_id', json_extract(event_header, '$.fact.step_id'),
                'tool_call_id', json_extract(event_header, '$.fact.event.data.part.call.id'),
                'name', json_extract(event_header, '$.fact.event.data.part.call.name'),
                'provider_executed', json(CASE WHEN json_extract(event_header, '$.fact.event.data.part.call.provider_executed') THEN 'true' ELSE 'false' END))
        WHEN json_extract(event_header, '$.fact.event.data.part.kind') = 'tool_result' THEN
            json_object('kind', 'provider_tool_result',
                'step_id', json_extract(event_header, '$.fact.step_id'),
                'tool_call_id', json_extract(event_header, '$.fact.event.data.part.id'),
                'is_error', json(CASE WHEN json_extract(event_header, '$.fact.event.data.part.is_error') THEN 'true' ELSE 'false' END))
        ELSE json_object('kind', 'model_part_committed',
                'step_id', json_extract(event_header, '$.fact.step_id'),
                'message_id', json_extract(event_header, '$.fact.event.data.message_id'),
                'ordinal', json_extract(event_header, '$.fact.event.data.ordinal'))
    END)) AS projected, invocation_id AS owner, sequence
FROM runtime_events
WHERE sequence > ?2 AND sequence <= ?3
AND (event_header IS NOT NULL AND event_session=?1)
AND (kind IN ('invocation_ended', 'model_requested', 'model_completed', 'model_interrupted', 'context_checkpoint_recorded', 'context_compaction_waiting') OR NOT EXISTS (
    SELECT 1 FROM runtime_events opening
    WHERE opening.invocation_id = runtime_events.invocation_id
      AND opening.kind = 'invocation_opened'
      AND json_extract(opening.event_header, '$.fact.input.kind') = 'context_compact'))
AND (kind != 'model_observed' OR
     EXISTS (SELECT 1 FROM runtime_events request
             JOIN runtime_events opening ON opening.invocation_id = request.invocation_id
             AND opening.kind = 'invocation_opened'
             WHERE request.kind = 'model_requested' AND request.invocation_id = runtime_events.invocation_id
             AND request.operation_id = json_extract(runtime_events.event_header, '$.fact.step_id')
             AND json_extract(opening.event_header, '$.fact.input.kind') IN ('message', 'continuation', 'handoff')
             AND json_extract(request.event_header, '$.fact.purpose') = 'main'))
AND (kind != 'model_observed' OR json_extract(event_header, '$.fact.event.data.part.kind') != 'tool_result'
     OR EXISTS (SELECT 1 FROM runtime_events call WHERE call.invocation_id=runtime_events.invocation_id
         AND call.kind='model_observed' AND call.sequence<runtime_events.sequence
         AND json_extract(call.event_header,'$.fact.step_id')=json_extract(runtime_events.event_header,'$.fact.step_id')
         AND json_extract(call.event_header,'$.fact.event.kind')='part'
         AND json_extract(call.event_header,'$.fact.event.data.part.kind')='tool_call'
         AND json_extract(call.event_header,'$.fact.event.data.part.call.id')=json_extract(runtime_events.event_header,'$.fact.event.data.part.id')
         AND json_extract(call.event_header,'$.fact.event.data.part.call.provider_executed')))
AND (kind IN ('invocation_opened', 'message_steered', 'invocation_ended', 'model_requested', 'model_completed', 'model_interrupted',
             'tool_dispatched', 'tool_rejected', 'tool_settled', 'executor_started', 'executor_observed', 'executor_completed', 'context_checkpoint_recorded', 'context_compaction_waiting')
     OR (kind = 'model_observed'
         AND json_extract(event_header, '$.fact.event.kind') = 'part'))
ORDER BY sequence LIMIT ?4
), roots AS MATERIALIZED (
 SELECT opening.invocation_id,
   CASE WHEN json_extract(opening.event_header,'$.fact.input.kind')='handoff'
     THEN json_extract(opening.event_header,'$.fact.input.pause.intent.root_run_id')
     ELSE json_extract(opening.event_header,'$.invocation.run_id') END AS run_id
 FROM runtime_events opening
 JOIN (SELECT DISTINCT owner FROM events) owners ON owners.owner=opening.invocation_id
 WHERE opening.kind='invocation_opened'
)
SELECT json_set(events.projected, '$.root_run_id', roots.run_id)
FROM events LEFT JOIN roots ON roots.invocation_id=events.owner
ORDER BY events.sequence";
