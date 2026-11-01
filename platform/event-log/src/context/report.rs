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

//! Original prepared inputs, without reconstructing a prompt from current state.
use crate::{EventLog, StoreError, sequence_number};
use maka_agent_facts::{
    context::PreparedContextBreakdown,
    event::{Fact, RuntimeEvent},
};
use sqlx::{Connection, Row};
use std::time::SystemTime;

#[derive(Clone, Debug, PartialEq)]
pub struct ContextReport {
    pub through: u64,
    pub request: Option<ContextRequest>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ContextRequest {
    pub invocation_id: String,
    pub step_id: String,
    pub sequence: u64,
    pub source_through: u64,
    pub recorded_at: SystemTime,
    pub model_id: String,
    pub context_window: Option<u64>,
    pub input_limit: Option<u64>,
    pub state: ContextRequestState,
    pub breakdown: Option<PreparedContextBreakdown>,
    pub reported_input_tokens: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContextRequestState {
    Requested,
    Completed,
    Interrupted,
}

impl EventLog {
    /// Latest Main request executed by this Session, at one immutable read fence.
    /// Copied history does not assert that a source request ran in its new owner.
    pub async fn context_report(
        &self,
        session: &str,
        through: Option<u64>,
    ) -> Result<ContextReport, StoreError> {
        self.validate_root()?;
        crate::sessions::validate_id(session)?;
        if let Some(through) = through {
            safe_number(through)?;
        }
        let session = session.to_owned();
        self.connection
            .read_interruptible(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    let head: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(sequence),0) FROM event_log")
                        .fetch_one(&mut *tx)
                        .await?;
                    let head = safe_number(sequence_number(head)?)?;
                    let through = through.unwrap_or(head);
                    if through > head {
                        return Err(invalid("fence exceeds committed history"));
                    }
                    let row = sqlx::query(
                        "SELECT sequence, event_header FROM runtime_events
                         WHERE json_extract(event_header,'$.invocation.session_id')=?1
                           AND kind='model_requested' AND sequence<=?2
                           AND json_extract(event_header,'$.fact.purpose')='main'
                         ORDER BY sequence DESC LIMIT 1",
                    )
                    .bind(&session)
                    .bind(through as i64)
                    .fetch_optional(&mut *tx)
                    .await?;
                    let request = if let Some(row) = row {
                        let sequence = safe_number(sequence_number(row.try_get("sequence")?)?)?;
                        let event: RuntimeEvent = serde_json::from_str(row.try_get("event_header")?)?;
                        let Fact::ModelRequested {
                            step_id,
                            model_id,
                            source_high_water,
                            context,
                            context_breakdown,
                            ..
                        } = event.fact
                        else {
                            return Err(invalid("expected model request"));
                        };
                        if let Some(context) = &context {
                            context.validate().map_err(invalid)?;
                        }
                        if let Some(breakdown) = &context_breakdown {
                            breakdown.validate().map_err(invalid)?;
                        }
                        let terminal = sqlx::query(
                            "SELECT kind, json_extract(event_header,'$.fact.output.usage.input_tokens') AS input_tokens
                             FROM runtime_events WHERE invocation_id=?1 AND operation_id=?2
                               AND kind IN ('model_completed','model_interrupted')
                               AND sequence>?3 AND sequence<=?4
                               AND json_extract(event_header,'$.invocation.session_id')=?5
                             ORDER BY sequence LIMIT 1"
                        )
                        .bind(&event.invocation.invocation_id)
                        .bind(&step_id)
                        .bind(sequence as i64)
                        .bind(through as i64)
                        .bind(&session)
                        .fetch_optional(&mut *tx)
                        .await?;
                        let (state, reported_input_tokens) = match terminal {
                            None => (ContextRequestState::Requested, None),
                            Some(row) => match row.try_get::<&str, _>("kind")? {
                                "model_completed" => (
                                    ContextRequestState::Completed,
                                    row.try_get::<Option<i64>, _>("input_tokens")?
                                        .map(|value| safe_number(sequence_number(value)?))
                                        .transpose()?,
                                ),
                                "model_interrupted" => (ContextRequestState::Interrupted, None),
                                _ => return Err(invalid("unexpected model terminal")),
                            },
                        };
                        Some(ContextRequest {
                            invocation_id: event.invocation.invocation_id,
                            step_id,
                            sequence,
                            source_through: safe_number(source_high_water)?,
                            recorded_at: event.recorded_at,
                            model_id,
                            context_window: context
                                .as_ref()
                                .and_then(|value| value.model_context_window),
                            input_limit: context.as_ref().and_then(|value| value.context_window),
                            state,
                            breakdown: context_breakdown,
                            reported_input_tokens,
                        })
                    } else {
                        None
                    };
                    tx.commit().await?;
                    Ok(ContextReport { through, request })
                })
            })
            .await
    }
}

fn safe_number(value: u64) -> Result<u64, StoreError> {
    if value > 9_007_199_254_740_991 {
        return Err(invalid("number exceeds public integer range"));
    }
    Ok(value)
}

fn invalid(reason: &str) -> StoreError {
    StoreError::InvalidTransition(format!("invalid context report: {reason}"))
}
