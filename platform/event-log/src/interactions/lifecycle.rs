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
use sqlx::{Connection, SqliteConnection};

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
        self.validate_root()?;
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
                Box::pin(async move {
                    let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
                    let count = close_in_transaction(&mut tx, scope.as_ref(), &outcome).await?;
                    if count > 0 {
                        tx.commit().await.map_err(StoreError::CommitUnknown)?;
                        // Interaction facts wake observers without advancing the execution cursor.
                        commits.metadata();
                    } else {
                        tx.rollback().await?;
                    }
                    Ok(count)
                })
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

pub(crate) async fn require_closed(
    connection: &mut SqliteConnection,
    invocation: &Invocation,
) -> Result<(), StoreError> {
    validate_scope(invocation)?;
    if visit_pending(connection, Some(invocation), None).await? > 0 {
        return Err(invalid("cannot seal a Run with pending interactions"));
    }
    Ok(())
}

pub(crate) async fn close_in_transaction(
    connection: &mut SqliteConnection,
    scope: Option<&Invocation>,
    outcome: &InteractionOutcome,
) -> Result<usize, StoreError> {
    if !matches!(outcome, InteractionOutcome::Closure { .. }) {
        return Err(invalid("interaction closure requires a closure outcome"));
    }
    outcome.validate().map_err(invalid)?;
    if let Some(scope) = scope {
        validate_scope(scope)?;
    }
    visit_pending(connection, scope, Some(outcome)).await
}

pub(super) const PENDING_SESSION_PAGE: &str = "SELECT request_id FROM interaction_pending
    WHERE session_id = ? AND request_id > ? ORDER BY request_id LIMIT 64";
pub(super) const PENDING_ROOT_PAGE: &str = "SELECT request_id FROM interaction_pending
    WHERE request_id > ? ORDER BY request_id LIMIT 64";
pub(super) const ALL_PENDING_SESSION_PAGE: &str = "SELECT request_id FROM interaction_pending
    WHERE session_id=?1 AND request_id>?2
    UNION ALL SELECT request_id FROM root_app_pending WHERE session_id=?1 AND request_id>?2
    ORDER BY request_id LIMIT 64";

/// Bound allocations independently of the number of requests in the root.
/// Decode and validate source facts before deciding Run membership or closing.
async fn visit_pending(
    connection: &mut SqliteConnection,
    scope: Option<&Invocation>,
    closure: Option<&InteractionOutcome>,
) -> Result<usize, StoreError> {
    let mut after = String::new();
    let mut count = 0;
    loop {
        // Separate statements keep Session closure an indexed Session seek,
        // while startup recovery pages the global active set only.
        let ids: Vec<String> = if let Some(scope) = scope {
            sqlx::query_scalar(if closure.is_some() {
                PENDING_SESSION_PAGE
            } else {
                ALL_PENDING_SESSION_PAGE
            })
            .bind(&scope.session_id)
            .bind(&after)
            .fetch_all(&mut *connection)
            .await?
        } else {
            sqlx::query_scalar(PENDING_ROOT_PAGE)
                .bind(&after)
                .fetch_all(&mut *connection)
                .await?
        };
        if ids.is_empty() {
            return Ok(count);
        }
        for id in &ids {
            let record = if closure.is_some() {
                read_local(connection, id).await?
            } else {
                read_scoped(connection, id, scope.map(|scope| scope.session_id.as_str())).await?
            }
            .ok_or_else(|| invalid("stored interaction disappeared"))?;
            if let Some(scope) = scope
                && (record.session_id != scope.session_id
                    || record.turn_id != scope.turn_id
                    || record.run_id != scope.run_id)
            {
                continue;
            }
            let Some(closure) = closure else { return Ok(1) };
            closure
                .validate_for_request(&record.request)
                .map_err(invalid)?;
            sqlx::query("INSERT INTO interaction_outcomes VALUES (?, ?)")
                .bind(id)
                .bind(encode(closure)?)
                .execute(&mut *connection)
                .await?;
            count += 1;
            crate::sessions::advance_revision(connection, &record.session_id).await?;
        }
        after = ids.last().expect("nonempty page").clone();
    }
}
