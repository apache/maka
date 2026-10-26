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

use crate::{StoreError, bundle::format::Record};
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::session::Lineage;
use sqlx::SqliteConnection;
use std::collections::BTreeSet;

pub(super) async fn check(
    staged: &mut SqliteConnection,
    destination: &mut SqliteConnection,
) -> Result<(), StoreError> {
    let mut sessions = BTreeSet::new();
    let mut after = 0i64;
    loop {
        let row: Option<(i64, String)> = sqlx::query_as(
            "SELECT number,record_json FROM frames WHERE kind IN ('session','copy','event') AND number>? ORDER BY number LIMIT 1",
        ).bind(after).fetch_optional(&mut *staged).await?;
        let Some((number, json)) = row else { break };
        match serde_json::from_str(&json)? {
            Record::Session { id, .. } => {
                sessions.insert(id);
            }
            Record::Copy(copy) => {
                sessions.insert(copy.request.source_session_id);
                sessions.insert(copy.request.target_session_id);
                match copy.lineage {
                    Lineage::Branch { origin } => {
                        sessions.insert(origin.parent_session_id);
                    }
                    Lineage::Revision {
                        root_session_id,
                        parent_session_id,
                        branch,
                        ..
                    } => {
                        sessions.insert(root_session_id);
                        sessions.insert(parent_session_id);
                        if let Some(branch) = branch {
                            sessions.insert(branch.parent_session_id);
                        }
                    }
                }
            }
            Record::Event { json, .. } => {
                let event: RuntimeEvent = serde_json::from_str(&json)?;
                let collision: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM event_log WHERE event_id=?1)
                     OR EXISTS(SELECT 1 FROM event_log WHERE invocation_id=?2)
                     OR (?3 IS NOT NULL AND EXISTS(SELECT 1 FROM event_log WHERE operation_id=?3))",
                )
                .bind(&event.id)
                .bind(&event.invocation.invocation_id)
                .bind(event.fact.operation_id())
                .fetch_one(&mut *destination)
                .await?;
                if collision {
                    return Err(StoreError::SessionConflict);
                }
                let claim = match &event.fact {
                    Fact::InvocationOpened { input, .. } => {
                        input.inherited_claim().map(|c| c.id.as_str())
                    }
                    _ => None,
                };
                identities(
                    destination,
                    &event.invocation.run_id,
                    &event.invocation.invocation_id,
                    claim,
                )
                .await?;
                if let Fact::InvocationEnded {
                    outcome: InvocationOutcome::HandoffPaused { pause },
                } = &event.fact
                {
                    identities(
                        destination,
                        &pause.intent.successor_run_id,
                        &pause.intent.successor_invocation_id,
                        Some(&pause.intent.claim_id),
                    )
                    .await?;
                }
                sessions.insert(event.invocation.session_id);
            }
            _ => unreachable!(),
        }
        after = number;
    }
    for session in sessions {
        let collision: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM session_control WHERE id=?1)
             OR EXISTS(SELECT 1 FROM context_source_prefixes WHERE kind='session' AND owner=?1)
             OR EXISTS(SELECT 1 FROM session_history_copies WHERE session_id=?1 OR source_session_id=?1)
             OR EXISTS(SELECT 1 FROM session_retirements WHERE session_id=?1)
             OR EXISTS(SELECT 1 FROM plugin_sessions WHERE session_id=?1)
             OR EXISTS(SELECT 1 FROM session_imports WHERE session_id=?1)
             OR EXISTS(SELECT 1 FROM session_bundle_members WHERE session_id=?1)",
        ).bind(session).fetch_one(&mut *destination).await?;
        if collision {
            return Err(StoreError::SessionConflict);
        }
    }
    Ok(())
}

async fn identities(
    db: &mut SqliteConnection,
    run: &str,
    invocation: &str,
    claim: Option<&str>,
) -> Result<(), StoreError> {
    let occupied: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM event_log WHERE invocation_id=?1)
         OR EXISTS(SELECT 1 FROM event_log WHERE kind='invocation_opened' AND
           (json_extract(COALESCE(event_json,retained_json),'$.invocation.run_id')=?2
            OR json_extract(event_json,'$.fact.input.claim.id')=?3))",
    )
    .bind(invocation)
    .bind(run)
    .bind(claim)
    .fetch_one(&mut *db)
    .await?;
    if occupied || crate::handoff::reservation_conflict(db, run, invocation, claim, None).await? {
        return Err(StoreError::SessionConflict);
    }
    Ok(())
}
