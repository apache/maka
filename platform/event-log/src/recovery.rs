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

mod startup;
pub use startup::{RecoveryError, recover_invocations};

use futures_util::TryStreamExt;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::model::ToolInput;
use sqlx::{Connection, Row, SqliteConnection};

use crate::{EventLog, StoreError};

macro_rules! unresolved {
    ($tail:literal) => { concat!(
        "WITH ", crate::model_items::accepted_calls!(), ", pending AS MATERIALIZED (
            SELECT kind, operation_id, opened_at FROM context_obligations
            WHERE invocation_id=?1 AND kind IN ('model','tool','call')
        ), pending_calls(step_id, call) AS (
            SELECT c.step_id,c.call FROM pending p JOIN accepted_calls c
              ON c.invocation_id=?1 AND c.sequence=p.opened_at
              AND c.step_id || ':' || json_extract(c.call,'$.id')=p.operation_id
            WHERE p.kind='call'
        ), unresolved(kind, id, name, input, call) AS (
            SELECT CASE kind WHEN 'model' THEN 0 ELSE 1 END, operation_id, '', 'null', 'null'
            FROM pending WHERE kind IN ('model','tool')
            UNION ALL
            SELECT 2, step_id || ':' || json_extract(call, '$.id'),
                json_extract(call, '$.name'), call -> '$.input',
                json_object('tool_call_id', json_extract(call, '$.id'),
                    'origin', json_object('kind', 'provider', 'step_id', step_id))
            FROM pending_calls
            UNION ALL
            SELECT 3, started.event_id, '', 'null', 'null'
            FROM runtime_events started
            WHERE started.invocation_id = ?1 AND started.kind = 'executor_started'
              AND NOT EXISTS(SELECT 1 FROM runtime_events done
                WHERE done.invocation_id = started.invocation_id
                  AND (done.kind = 'executor_completed' OR
                    (done.kind = 'invocation_ended' AND
                     COALESCE(json_extract(done.event_json, '$.fact.outcome.class'), '') != 'outcome_unknown')))
        )",
        $tail
    ) };
}
pub(crate) use unresolved;

pub(crate) async fn require_local(
    connection: &mut SqliteConnection,
    invocation: &str,
) -> Result<(), StoreError> {
    if sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM imported_invocations WHERE invocation_id=?)",
    )
    .bind(invocation)
    .fetch_one(connection)
    .await?
    {
        return Err(StoreError::ImportedInvocation);
    }
    Ok(())
}

pub struct InvocationRecovery {
    pub unfinished_executor: bool,
    pub unfinished_model_steps: Vec<String>,
    pub uncertain_operations: Vec<String>,
    pub undispatched_calls: Vec<UndispatchedCall>,
}

pub struct UndispatchedCall {
    pub operation_id: String,
    pub identity: maka_agent_facts::tool_call::ToolCallIdentity,
    pub name: String,
    pub input: ToolInput,
}

/// One bounded discovery page. The cursor is an immutable opening sequence,
/// so settling earlier pages cannot shift or skip later unfinished invocations.
pub struct UnfinishedInvocations {
    pub invocations: Vec<Invocation>,
    pub through_sequence: u64,
}

// Limit the indexed frontier before reading opening JSON. Imported roots are
// excluded before LIMIT so an imported-only page cannot hide later local work.
const UNFINISHED_INVOCATIONS: &str = "WITH pending AS MATERIALIZED (
                 SELECT invocation_id, opened_at FROM context_obligations
                 WHERE kind='invocation' AND opened_at>?1
                   AND NOT EXISTS(SELECT 1 FROM imported_invocations i
                       WHERE i.invocation_id=context_obligations.invocation_id)
                 ORDER BY opened_at LIMIT ?2
             )
             SELECT json_extract(opening.event_json, '$.invocation.session_id'),
                    json_extract(opening.event_json, '$.invocation.turn_id'),
                    json_extract(opening.event_json, '$.invocation.run_id'),
                    opening.invocation_id, pending.opened_at
             FROM pending CROSS JOIN runtime_events AS opening
             WHERE opening.sequence = pending.opened_at
             ORDER BY pending.opened_at";

// Session filtering belongs to the indexed frontier, before pagination.
const SESSION_UNFINISHED_INVOCATIONS: &str = "WITH pending AS MATERIALIZED (
                 SELECT invocation_id, opened_at FROM context_obligations
                 WHERE kind='invocation' AND session_id=?3 AND opened_at>?1
                   AND NOT EXISTS(SELECT 1 FROM imported_invocations i
                       WHERE i.invocation_id=context_obligations.invocation_id)
                 ORDER BY opened_at LIMIT ?2
             )
             SELECT json_extract(opening.event_json, '$.invocation.session_id'),
                    json_extract(opening.event_json, '$.invocation.turn_id'),
                    json_extract(opening.event_json, '$.invocation.run_id'),
                    opening.invocation_id, pending.opened_at
             FROM pending CROSS JOIN runtime_events AS opening
             WHERE opening.sequence = pending.opened_at
             ORDER BY pending.opened_at";

impl EventLog {
    /// Read only unresolved execution authority in one SQLite snapshot. Text,
    /// streamed observations, opening inputs and settled results are excluded.
    pub async fn invocation_recovery(
        &self,
        invocation: &Invocation,
    ) -> Result<InvocationRecovery, StoreError> {
        self.validate_root()?;
        let invocation = invocation.clone();
        self.connection
            .read(move |connection| {
                Box::pin(async move {
                    let mut transaction = connection.begin().await?;
                    require_local(&mut transaction, &invocation.invocation_id).await?;
                    let identity: String = sqlx::query_scalar(
                        "SELECT json_extract(event_json, '$.invocation') FROM runtime_events
             WHERE invocation_id = ? AND kind = 'invocation_opened'",
                    )
                    .bind(&invocation.invocation_id)
                    .fetch_one(&mut *transaction)
                    .await?;
                    if serde_json::from_str::<Invocation>(&identity)? != invocation {
                        return Err(StoreError::InvalidTransition(
                            "stored invocation identity changed".into(),
                        ));
                    }
                    let mut evidence = InvocationRecovery {
                        unfinished_executor: false,
                        unfinished_model_steps: Vec::new(),
                        uncertain_operations: Vec::new(),
                        undispatched_calls: Vec::new(),
                    };
                    {
                        let query =
                            unresolved!(" SELECT kind, id, name, input, call FROM unresolved");
                        let mut rows = sqlx::query(query)
                            .bind(&invocation.invocation_id)
                            .fetch(&mut *transaction);
                        while let Some(row) = rows.try_next().await? {
                            match row.try_get::<i64, _>(0)? {
                                0 => evidence.unfinished_model_steps.push(row.try_get(1)?),
                                1 => evidence.uncertain_operations.push(row.try_get(1)?),
                                2 => evidence.undispatched_calls.push(UndispatchedCall {
                                    operation_id: row.try_get(1)?,
                                    identity: serde_json::from_str(row.try_get(4)?)?,
                                    name: row.try_get(2)?,
                                    input: serde_json::from_str(row.try_get(3)?)?,
                                }),
                                3 => evidence.unfinished_executor = true,
                                _ => unreachable!("query emits only recovery fact kinds"),
                            }
                        }
                    }
                    transaction.commit().await?;
                    Ok(evidence)
                })
            })
            .await
    }

    /// Read a page of current unsealed local obligations after an opening cursor.
    /// A nonempty page advances `through_sequence`; an empty page completes the
    /// scan. Requires a positive page limit. Settling a page does not affect the
    /// cursor because event sequences are never reused.
    pub async fn unfinished_invocations(
        &self,
        after_sequence: u64,
        limit: usize,
    ) -> Result<UnfinishedInvocations, StoreError> {
        self.validate_root()?;
        let expected_session = self.expected_session.clone();
        if limit == 0 {
            return Err(StoreError::PrefixTooLarge);
        }
        let sql_limit = i64::try_from(limit).map_err(|_| StoreError::PrefixTooLarge)?;
        let cursor = i64::try_from(after_sequence).map_err(|_| StoreError::PrefixTooLarge)?;
        self.connection
            .read(move |connection| {
                Box::pin(async move {
                    let statement = if expected_session.is_some() {
                        SESSION_UNFINISHED_INVOCATIONS
                    } else {
                        UNFINISHED_INVOCATIONS
                    };
                    let mut query = sqlx::query(statement).bind(cursor).bind(sql_limit);
                    if let Some(session) = expected_session.as_deref() {
                        query = query.bind(session);
                    }
                    let mut rows = query.fetch(connection);
                    let mut page = UnfinishedInvocations {
                        invocations: Vec::new(),
                        through_sequence: after_sequence,
                    };
                    while let Some(row) = rows.try_next().await? {
                        page.through_sequence = u64::try_from(row.try_get::<i64, _>(4)?)
                            .map_err(|_| StoreError::PrefixTooLarge)?;
                        page.invocations.push(Invocation {
                            session_id: row.try_get(0)?,
                            turn_id: row.try_get(1)?,
                            run_id: row.try_get(2)?,
                            invocation_id: row.try_get(3)?,
                        });
                    }
                    Ok(page)
                })
            })
            .await
    }
}

#[cfg(test)]
mod tests;
