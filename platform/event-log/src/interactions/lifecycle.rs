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

use super::records::{encode, invalid, read_local, read_scoped};
use crate::{EventLog, StoreError};
use maka_agent_facts::event::Invocation;
use maka_agent_facts::interaction::ClosureReason;
use maka_agent_facts::interaction::InteractionOutcome;
use maka_agent_facts::interaction::entity_id;
use rusqlite::Connection;

impl EventLog {
    pub async fn close_run_interactions(
        &self,
        invocation: &Invocation,
        reason: ClosureReason,
        now: u64,
    ) -> Result<usize, StoreError> {
        validate_scope(invocation)?;
        self.close_interactions(Some(invocation.clone()), reason, now)
            .await
    }

    /// Startup only: requires exclusive Host ownership and no live producers.
    /// Includes pending requests whose execution Run has already been sealed.
    pub async fn close_abandoned_interactions(&self, now: u64) -> Result<usize, StoreError> {
        self.close_interactions(None, ClosureReason::HostRestarted, now)
            .await
    }

    async fn close_interactions(
        &self,
        scope: Option<Invocation>,
        reason: ClosureReason,
        now: u64,
    ) -> Result<usize, StoreError> {
        let outcome = InteractionOutcome::Closure {
            reason,
            committed_at: now,
        };
        outcome.validate().map_err(invalid)?;
        let commits = self.commits.sessions(
            scope
                .iter()
                .map(|invocation| invocation.session_id.as_str()),
        );
        self.connection
            .run(move |connection| {
                {
                    let tx = rusqlite::Transaction::new_unchecked(
                        connection,
                        rusqlite::TransactionBehavior::Immediate,
                    )?;
                    let (count, approval_ready) =
                        close_notified_in_transaction(&tx, scope.as_ref(), &outcome)?;
                    if count > 0 {
                        tx.commit().map_err(StoreError::CommitUnknown)?;
                        // Interaction facts wake observers without advancing the execution cursor.
                        commits.metadata();
                        if approval_ready {
                            commits.activations();
                        }
                    } else {
                        tx.rollback()?;
                    }
                    Ok(count)
                }
            })
            .await
    }
}

fn validate_scope(invocation: &Invocation) -> Result<(), StoreError> {
    for id in [
        &invocation.session_id,
        &invocation.turn_id,
        &invocation.run_id,
    ] {
        entity_id(id).map_err(invalid)?;
    }
    Ok(())
}

pub(crate) fn require_closed(
    connection: &Connection,
    invocation: &Invocation,
) -> Result<(), StoreError> {
    validate_scope(invocation)?;
    if visit_pending(connection, Some(invocation), None)?.0 > 0 {
        return Err(invalid("cannot seal a Run with pending interactions"));
    }
    Ok(())
}

pub(crate) fn close_in_transaction(
    connection: &Connection,
    scope: Option<&Invocation>,
    outcome: &InteractionOutcome,
) -> Result<usize, StoreError> {
    Ok(close_notified_in_transaction(connection, scope, outcome)?.0)
}

pub(crate) fn close_notified_in_transaction(
    connection: &Connection,
    scope: Option<&Invocation>,
    outcome: &InteractionOutcome,
) -> Result<(usize, bool), StoreError> {
    if !matches!(outcome, InteractionOutcome::Closure { .. }) {
        return Err(invalid("interaction closure requires a closure outcome"));
    }
    outcome.validate().map_err(invalid)?;
    if let Some(scope) = scope {
        validate_scope(scope)?;
    }
    visit_pending(connection, scope, Some(outcome))
}

pub(super) const PENDING_SESSION_PAGE: &str = "SELECT request_id FROM interaction_pending
    WHERE session_id = ? AND request_id > ? ORDER BY request_id LIMIT 64";
pub(super) const PENDING_ROOT_PAGE: &str = "SELECT request_id FROM interaction_pending
    WHERE request_id > ? ORDER BY request_id LIMIT 64";
pub(super) const ALL_PENDING_SESSION_PAGE: &str = "SELECT request_id FROM interaction_pending
    WHERE session_id=?1 AND request_id>?2
    ORDER BY request_id LIMIT 64";

/// Bound allocations independently of the number of requests in the root.
/// Decode and validate source facts before deciding Run membership or closing.
fn visit_pending(
    connection: &Connection,
    scope: Option<&Invocation>,
    closure: Option<&InteractionOutcome>,
) -> Result<(usize, bool), StoreError> {
    let mut after = String::new();
    let mut count = 0;
    let mut approval_ready = false;
    loop {
        // Separate statements keep Session closure an indexed Session seek,
        // while startup recovery pages the global active set only.
        let ids: Vec<String> = if let Some(scope) = scope {
            connection
                .prepare_cached(if closure.is_some() {
                    PENDING_SESSION_PAGE
                } else {
                    ALL_PENDING_SESSION_PAGE
                })?
                .query_map(rusqlite::params![&scope.session_id, &after], |row| {
                    row.get(0)
                })?
                .collect::<Result<Vec<_>, _>>()?
        } else {
            connection
                .prepare_cached(PENDING_ROOT_PAGE)?
                .query_map(rusqlite::params![&after], |row| row.get(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        if ids.is_empty() {
            return Ok((count, approval_ready));
        }
        for id in &ids {
            if scope.is_none() && closure.is_some() {
                let preserved:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM native_approval_operations o JOIN native_approval_checkpoints c ON c.id=o.checkpoint_id WHERE o.interaction_id=? AND c.active=1)", rusqlite::params![id], |row| row.get(0))?;
                if preserved {
                    continue;
                }
            }
            let record = if closure.is_some() {
                read_local(connection, id)?
            } else {
                read_scoped(connection, id, scope.map(|scope| scope.session_id.as_str()))?
            }
            .ok_or_else(|| invalid("stored interaction disappeared"))?;
            if let Some(scope) = scope
                && (record.session_id != scope.session_id
                    || record.turn_id != scope.turn_id
                    || record.run_id != scope.run_id)
            {
                continue;
            }
            let Some(closure) = closure else {
                return Ok((1, false));
            };
            closure
                .validate_for_request(&record.request)
                .map_err(invalid)?;
            connection.execute(
                "INSERT INTO interaction_outcomes VALUES (?, ?)",
                rusqlite::params![id, encode(closure)?],
            )?;
            approval_ready |= crate::native_approvals::waits_for_interaction(connection, id)?;
            count += 1;
            crate::sessions::advance_revision(connection, &record.session_id)?;
        }
        after = ids.last().expect("nonempty page").clone();
    }
}
