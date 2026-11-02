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

use crate::{EventLog, StoreError};
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::InvocationInput;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::RuntimeEvent;
use sqlx::{Connection, SqliteConnection};

mod evidence;
pub(crate) use evidence::validate as validate_history;
mod cancel;
mod owner;
pub(crate) use owner::read as owner;

/// Bounded discovery metadata. Only a canonical successor opening claims work.
pub struct PendingHandoff {
    pub sequence: u64,
    pub invocation: maka_agent_facts::event::Invocation,
    pub host_epoch: String,
}

impl EventLog {
    pub async fn pending_handoffs(&self, after: u64) -> Result<Vec<PendingHandoff>, StoreError> {
        self.validate_root()?;
        let after = i64::try_from(after).map_err(|_| invalid("invalid handoff cursor"))?;
        self.connection
            .run(move |tx| {
                Box::pin(async move {
                    let rows: Vec<(i64, String, String)> = sqlx::query_as(
                        "SELECT pause.sequence, json_extract(pause.event_header,'$.invocation'),
                   json_extract(pause.event_header,'$.fact.outcome.pause.intent.host_epoch')
                 FROM local_runtime_events pause
                 WHERE pause.sequence > ? AND pause.kind='invocation_ended'
                   AND NOT EXISTS (SELECT 1 FROM session_retirements r
                     WHERE r.session_id=json_extract(pause.event_header,'$.invocation.session_id'))
                   AND json_extract(pause.event_header,'$.fact.outcome.kind')='handoff_paused'
                   AND NOT EXISTS (SELECT 1 FROM runtime_events successor
                     WHERE successor.kind='invocation_opened'
                     AND successor.invocation_id=json_extract(pause.event_header,
                       '$.fact.outcome.pause.intent.successor_invocation_id'))
                 ORDER BY pause.sequence LIMIT 64",
                    )
                    .bind(after)
                    .fetch_all(tx)
                    .await?;
                    rows.into_iter()
                        .map(|(sequence, invocation, host_epoch)| {
                            Ok(PendingHandoff {
                                sequence: sequence as u64,
                                invocation: serde_json::from_str(&invocation)?,
                                host_epoch,
                            })
                        })
                        .collect()
                })
            })
            .await
    }

    /// Ordinary queued work cannot cross an unclaimed cooperative seal.
    pub async fn has_pending_handoff(&self, session: &str) -> Result<bool, StoreError> {
        self.validate_root()?;
        crate::sessions::validate_id(session)?;
        let session = session.to_owned();
        self.connection
            .run(move |tx| Box::pin(async move { Ok(reservation(tx, &session).await?.is_some()) }))
            .await
    }

    /// Eligibility only. The source still owns execution until its seal commits.
    pub async fn check_handoff(
        &self,
        invocation: &maka_agent_facts::event::Invocation,
        pause: &maka_agent_facts::handoff::HandoffPause,
    ) -> Result<(), StoreError> {
        self.validate_root()?;
        let event = RuntimeEvent::new(
            invocation.clone(),
            Fact::InvocationEnded {
                outcome: InvocationOutcome::HandoffPaused {
                    pause: pause.clone(),
                },
            },
        );
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    crate::recovery::require_local(&mut tx, &event.invocation.invocation_id)
                        .await?;
                    validate_history(&mut tx, &event).await?;
                    validate_admission(&mut tx, &event).await?;
                    tx.commit().await?;
                    Ok(())
                })
            })
            .await
    }
}

pub(crate) async fn validate_admission(
    tx: &mut SqliteConnection,
    event: &RuntimeEvent,
) -> Result<(), StoreError> {
    if let Fact::InvocationOpened { input, .. } = &event.fact {
        let source = match input {
            InvocationInput::Handoff { claim, .. } => {
                Some(claim.source.invocation.invocation_id.as_str())
            }
            _ => None,
        };
        if reservation_conflict(
            tx,
            &event.invocation.run_id,
            &event.invocation.invocation_id,
            input.inherited_claim().map(|claim| claim.id.as_str()),
            source,
        )
        .await?
        {
            return Err(invalid("opening would steal a reserved handoff identity"));
        }
        // Admission permits one physical owner per Session. A paused owner
        // blocks the next opening, so only the latest opening can reserve it.
        let reserved = reservation(tx, &event.invocation.session_id).await?;
        if let InvocationInput::Handoff { claim, .. } = input {
            crate::recovery::require_local(tx, &claim.source.invocation.invocation_id).await?;
            if reserved.as_deref() != Some(&claim.source.invocation.invocation_id) {
                return Err(invalid(
                    "handoff does not own the pending Session reservation",
                ));
            }
        } else if reserved.is_some() {
            return Err(invalid(
                "Session is reserved for its sealed handoff successor",
            ));
        }
        return Ok(());
    }
    let Fact::InvocationEnded {
        outcome: InvocationOutcome::HandoffPaused { pause },
    } = &event.fact
    else {
        return Ok(());
    };
    crate::interactions::lifecycle::require_closed(tx, &event.invocation).await?;
    if reservation_conflict(
        tx,
        &pause.intent.successor_run_id,
        &pause.intent.successor_invocation_id,
        Some(&pause.intent.claim_id),
        None,
    )
    .await?
    {
        return Err(invalid("handoff successor identity is already reserved"));
    }
    Ok(())
}

async fn reservation(
    tx: &mut SqliteConnection,
    session: &str,
) -> Result<Option<String>, StoreError> {
    Ok(sqlx::query_scalar(
        "SELECT pause.invocation_id FROM local_runtime_events pause
         WHERE pause.kind='invocation_ended' AND json_extract(pause.event_header,'$.fact.outcome.kind')='handoff_paused'
         AND pause.invocation_id=(SELECT invocation_id FROM local_runtime_events WHERE kind='invocation_opened'
           AND json_extract(event_header,'$.invocation.session_id')=? ORDER BY sequence DESC LIMIT 1)"
    ).bind(session).fetch_optional(tx).await?)
}

pub(crate) async fn reservation_conflict(
    tx: &mut SqliteConnection,
    run: &str,
    invocation: &str,
    claim: Option<&str>,
    source: Option<&str>,
) -> Result<bool, StoreError> {
    Ok(sqlx::query_scalar(
        "WITH reservations AS NOT MATERIALIZED (SELECT event_header FROM local_runtime_events
         WHERE kind='invocation_ended' AND json_extract(event_header,'$.fact.outcome.kind')='handoff_paused'
         AND (?4 IS NULL OR invocation_id != ?4))
         SELECT EXISTS(SELECT 1 FROM reservations WHERE json_extract(event_header,'$.fact.outcome.pause.intent.successor_run_id')=?1
           UNION ALL SELECT 1 FROM reservations WHERE json_extract(event_header,'$.fact.outcome.pause.intent.successor_invocation_id')=?2
           UNION ALL SELECT 1 FROM reservations WHERE json_extract(event_header,'$.fact.outcome.pause.intent.claim_id')=?3)",
    ).bind(run).bind(invocation).bind(claim).bind(source).fetch_one(tx).await?)
}

fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}
