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
use rusqlite::{Connection, OptionalExtension};
use std::collections::BTreeSet;

pub(super) fn check(staged: &Connection, destination: &Connection) -> Result<(), StoreError> {
    let mut sessions = BTreeSet::new();
    let mut after = 0i64;
    loop {
        let row: Option<(i64, String)> = staged.prepare_cached(
            "SELECT number,record_json FROM frames WHERE kind IN ('session','copy','event') AND number>? ORDER BY number LIMIT 1",
        )?.query_row(rusqlite::params![after], |row| Ok((row.get(0)?,row.get(1)?,))).optional()?;
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
                let collision: bool = destination
                    .prepare_cached(
                        "SELECT EXISTS(SELECT 1 FROM event_log WHERE event_id=?1)
                     OR EXISTS(SELECT 1 FROM event_log WHERE invocation_id=?2)
                     OR (?3 IS NOT NULL AND EXISTS(SELECT 1 FROM event_log WHERE operation_id=?3))",
                    )?
                    .query_row(
                        rusqlite::params![
                            &event.id,
                            &event.invocation.invocation_id,
                            event.fact.operation_id()
                        ],
                        |row| row.get(0),
                    )?;
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
                )?;
                if let Fact::InvocationEnded {
                    outcome: InvocationOutcome::HandoffPaused { pause },
                } = &event.fact
                {
                    identities(
                        destination,
                        &pause.intent.successor_run_id,
                        &pause.intent.successor_invocation_id,
                        Some(&pause.intent.claim_id),
                    )?;
                }
                sessions.insert(event.invocation.session_id);
            }
            _ => unreachable!(),
        }
        after = number;
    }
    for session in sessions {
        let collision: bool = destination.prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM session_control WHERE id=?1)
             OR EXISTS(SELECT 1 FROM context_source_prefixes WHERE kind='session' AND owner=?1)
             OR EXISTS(SELECT 1 FROM session_history_copies WHERE session_id=?1 OR source_session_id=?1)
             OR EXISTS(SELECT 1 FROM session_retirements WHERE session_id=?1)
             OR EXISTS(SELECT 1 FROM plugin_sessions WHERE session_id=?1)
             OR EXISTS(SELECT 1 FROM session_imports WHERE session_id=?1)
             OR EXISTS(SELECT 1 FROM session_bundle_members WHERE session_id=?1)",
        )?.query_row(rusqlite::params![session], |row| row.get(0))?;
        if collision {
            return Err(StoreError::SessionConflict);
        }
    }
    Ok(())
}

fn identities(
    db: &Connection,
    run: &str,
    invocation: &str,
    claim: Option<&str>,
) -> Result<(), StoreError> {
    let occupied: bool = db
        .prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM event_log WHERE invocation_id=?1)
         OR EXISTS(SELECT 1 FROM event_log WHERE kind='invocation_opened' AND
           (json_extract(COALESCE(event_header,retained_json),'$.invocation.run_id')=?2
            OR json_extract(event_header,'$.fact.input.claim.id')=?3))",
        )?
        .query_row(rusqlite::params![invocation, run, claim], |row| row.get(0))?;
    if occupied || crate::handoff::reservation_conflict(db, run, invocation, claim, None)? {
        return Err(StoreError::SessionConflict);
    }
    Ok(())
}
