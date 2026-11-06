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
use rusqlite::OptionalExtension;

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
        let after = i64::try_from(after).map_err(|_| invalid("invalid handoff cursor"))?;
        self.connection
            .read(move |tx| {
                let rows: Vec<(i64, String, String)> = tx
                    .prepare_cached(
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
                    )?
                    .query_map(rusqlite::params![after], |row| {
                        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
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
            .await
    }

    /// Ordinary queued work cannot cross an unclaimed cooperative seal.
    pub async fn has_pending_handoff(&self, session: &str) -> Result<bool, StoreError> {
        crate::sessions::validate_id(session)?;
        let session = session.to_owned();
        self.connection
            .read(move |tx| Ok(reservation(tx, &session)?.is_some()))
            .await
    }

    /// Eligibility only. The source still owns execution until its seal commits.
    pub async fn check_handoff(
        &self,
        invocation: &maka_agent_facts::event::Invocation,
        pause: &maka_agent_facts::handoff::HandoffPause,
    ) -> Result<(), StoreError> {
        let event = RuntimeEvent::new(
            invocation.clone(),
            Fact::InvocationEnded {
                outcome: InvocationOutcome::HandoffPaused {
                    pause: pause.clone(),
                },
            },
        );
        self.connection
            .read(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                crate::recovery::require_local(&tx, &event.invocation.invocation_id)?;
                validate_history(&tx, &event)?;
                validate_admission(&tx, &event)?;
                tx.commit()?;
                Ok(())
            })
            .await
    }
}

pub(crate) fn validate_admission(
    tx: &rusqlite::Connection,
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
        )? {
            return Err(invalid("opening would steal a reserved handoff identity"));
        }
        // Admission permits one physical owner per Session. A paused owner
        // blocks the next opening, so only the latest opening can reserve it.
        let reserved = reservation(tx, &event.invocation.session_id)?;
        if let InvocationInput::Handoff { claim, .. } = input {
            crate::recovery::require_local(tx, &claim.source.invocation.invocation_id)?;
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
    crate::interactions::lifecycle::require_closed(tx, &event.invocation)?;
    if reservation_conflict(
        tx,
        &pause.intent.successor_run_id,
        &pause.intent.successor_invocation_id,
        Some(&pause.intent.claim_id),
        None,
    )? {
        return Err(invalid("handoff successor identity is already reserved"));
    }
    Ok(())
}

fn reservation(tx: &rusqlite::Connection, session: &str) -> Result<Option<String>, StoreError> {
    Ok(tx.prepare_cached("SELECT pause.invocation_id FROM local_runtime_events pause
         WHERE pause.kind='invocation_ended' AND json_extract(pause.event_header,'$.fact.outcome.kind')='handoff_paused'
         AND pause.invocation_id=(SELECT invocation_id FROM local_runtime_events WHERE kind='invocation_opened'
           AND json_extract(event_header,'$.invocation.session_id')=? ORDER BY sequence DESC LIMIT 1)")?.query_row(rusqlite::params![session], |row| row.get(0)).optional()?)
}

pub(crate) fn reservation_conflict(
    tx: &rusqlite::Connection,
    run: &str,
    invocation: &str,
    claim: Option<&str>,
    source: Option<&str>,
) -> Result<bool, StoreError> {
    Ok(tx.prepare_cached("WITH reservations AS NOT MATERIALIZED (SELECT event_header FROM local_runtime_events
         WHERE kind='invocation_ended' AND json_extract(event_header,'$.fact.outcome.kind')='handoff_paused'
         AND (?4 IS NULL OR invocation_id != ?4))
         SELECT EXISTS(SELECT 1 FROM reservations WHERE json_extract(event_header,'$.fact.outcome.pause.intent.successor_run_id')=?1
           UNION ALL SELECT 1 FROM reservations WHERE json_extract(event_header,'$.fact.outcome.pause.intent.successor_invocation_id')=?2
           UNION ALL SELECT 1 FROM reservations WHERE json_extract(event_header,'$.fact.outcome.pause.intent.claim_id')=?3)")?.query_row(rusqlite::params![run,invocation,claim,source], |row| row.get(0))?)
}

fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}
