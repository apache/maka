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

use super::Inventory;
use crate::{StoreError, context::selection::Selection, sequence_number};
use maka_agent_facts::context::CheckpointMode;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::LogScope;
use maka_agent_facts::event::RuntimeEvent;
use sqlx::SqliteConnection;
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};

mod members;

/// Event identities and exact copied memberships, not additional catalog Sessions.
pub(super) struct Closure {
    pub events: BTreeSet<u64>,
    pub members: BTreeMap<(String, u64), Option<u64>>,
    pub copies: BTreeSet<String>,
    pub revisions: BTreeSet<(String, u64)>,
    queue: VecDeque<u64>,
    scopes: HashMap<String, u64>,
    runs: HashMap<String, u64>,
}

impl Closure {
    pub async fn capture(
        db: &mut SqliteConnection,
        inventory: &Inventory,
        through: u64,
    ) -> Result<Self, StoreError> {
        let mut selected = Self {
            events: BTreeSet::new(),
            members: BTreeMap::new(),
            copies: BTreeSet::new(),
            revisions: BTreeSet::new(),
            queue: VecDeque::new(),
            scopes: HashMap::new(),
            runs: HashMap::new(),
        };
        for session in &inventory.sessions {
            selected
                .scope(
                    db,
                    &LogScope::Session {
                        id: session.id.clone(),
                    },
                    through,
                )
                .await?;
            let revisions: Vec<i64> = sqlx::query_scalar(
                "SELECT sequence FROM session_revision_sources WHERE session_id=? ORDER BY sequence"
            ).bind(&session.id).fetch_all(&mut *db).await?;
            for sequence in revisions {
                let sequence = sequence_number(sequence)?;
                selected.add(sequence)?;
                selected.revisions.insert((session.id.clone(), sequence));
                let source: String = sqlx::query_scalar(
                    "SELECT source_session_id FROM session_history_copies WHERE session_id=?",
                )
                .bind(&session.id)
                .fetch_one(&mut *db)
                .await?;
                selected.member(db, &source, sequence).await?;
            }
        }
        while let Some(sequence) = selected.queue.pop_front() {
            let row=sqlx::query(sqlx::AssertSqlSafe(format!(
                "SELECT e.event_header,(SELECT length(payload) FROM tool_result_payloads WHERE event_id=e.event_id) AS tool_payload_bytes,{columns}
                 FROM runtime_events e {joins} WHERE e.sequence=?1",columns=crate::canonical::COLUMNS,joins=crate::canonical::JOINS,
            ))).bind(sequence as i64).fetch_optional(&mut *db).await?;
            let row = row.ok_or(StoreError::MaterialCollected)?;
            use sqlx::Row;
            let payload_bytes: Option<i64> = row.try_get("tool_payload_bytes")?;
            let json = crate::canonical::json(&row)?;
            let event: RuntimeEvent = serde_json::from_str(&json)?;
            crate::tool_payloads::verify_binding(&event, payload_bytes)?;
            if !matches!(event.fact, Fact::MessageImported { .. }) {
                selected
                    .run(db, &event.invocation.invocation_id, sequence)
                    .await?;
            }
            match &event.fact {
                Fact::ModelRequested {
                    source_scope,
                    source_high_water,
                    source_capture,
                    ..
                } => {
                    selected.scope(db, source_scope, *source_high_water).await?;
                    selected
                        .archives(
                            db,
                            source_scope,
                            *source_high_water,
                            source_capture
                                .publication_watermark
                                .checked_add(1)
                                .ok_or_else(|| {
                                    StoreError::InvalidTransition(
                                        "request publication watermark overflow".into(),
                                    )
                                })?,
                        )
                        .await?;
                }
                Fact::ContextCheckpointRecorded { checkpoint } => {
                    let selection = Selection::for_invocation(db, &event.invocation).await?;
                    selected
                        .scope(db, &selection.scope, checkpoint.covered_through)
                        .await?;
                    if matches!(checkpoint.mode, CheckpointMode::Standalone) {
                        let terminal: i64 = sqlx::query_scalar(
                            "SELECT sequence FROM runtime_events WHERE invocation_id=? AND kind='invocation_ended'"
                        ).bind(&event.invocation.invocation_id).fetch_one(&mut *db).await?;
                        selected.add(sequence_number(terminal)?)?;
                    }
                }
                Fact::InvocationOpened { input, .. } => {
                    if let Some(claim) = input.inherited_claim() {
                        let source = &claim.source.invocation;
                        let end: i64 = sqlx::query_scalar(
                            "SELECT sequence FROM runtime_events WHERE invocation_id=? AND kind='invocation_ended'"
                        ).bind(&source.invocation_id).fetch_one(&mut *db).await?;
                        selected
                            .run(db, &source.invocation_id, sequence_number(end)?)
                            .await?;
                        selected
                            .scope(
                                db,
                                &LogScope::Session {
                                    id: source.session_id.clone(),
                                },
                                claim.base.high_water,
                            )
                            .await?;
                    }
                }
                Fact::ToolResultArchived { placeholder } => {
                    let target: i64 =
                        sqlx::query_scalar("SELECT sequence FROM runtime_events WHERE event_id=?")
                            .bind(&placeholder.identity.runtime_event_id)
                            .fetch_one(&mut *db)
                            .await?;
                    let selection = Selection::for_invocation(db, &event.invocation).await?;
                    selected
                        .scope(db, &selection.scope, sequence_number(target)?)
                        .await?;
                }
                _ => {}
            }
        }
        Ok(selected)
    }

    fn add(&mut self, sequence: u64) -> Result<(), StoreError> {
        if self.events.insert(sequence) {
            self.queue.push_back(sequence);
        }
        Ok(())
    }

    async fn run(
        &mut self,
        db: &mut SqliteConnection,
        invocation: &str,
        through: u64,
    ) -> Result<(), StoreError> {
        let prior = self.runs.get(invocation).copied().unwrap_or(0);
        if through <= prior {
            return Ok(());
        }
        let rows: Vec<i64> = sqlx::query_scalar(
            "SELECT sequence FROM runtime_events WHERE invocation_id=? AND sequence>? AND sequence<=? ORDER BY sequence"
        ).bind(invocation).bind(prior as i64).bind(through as i64).fetch_all(db).await?;
        for row in rows {
            self.add(sequence_number(row)?)?;
        }
        self.runs.insert(invocation.into(), through);
        Ok(())
    }

    async fn scope(
        &mut self,
        db: &mut SqliteConnection,
        scope: &LogScope,
        through: u64,
    ) -> Result<(), StoreError> {
        if through > i64::MAX as u64 {
            return Err(StoreError::PrefixTooLarge);
        }
        if matches!(scope, LogScope::Root) {
            return Err(StoreError::InvalidTransition(
                "Root-scoped proof cannot be exported as a Session bundle".into(),
            ));
        }
        let key = serde_json::to_string(scope)?;
        let prior = self.scopes.get(&key).copied();
        if prior.is_some_and(|previous| through <= previous) {
            return Ok(());
        }
        let selection = Selection::resolve(db, scope).await?;
        let session = selection.session.as_ref().expect("non-root selection");
        let copy: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM session_history_copies WHERE session_id=?)",
        )
        .bind(session)
        .fetch_one(&mut *db)
        .await?;
        if copy {
            self.copies.insert(session.clone());
        }
        let filter = Selection::predicate("e", "?3");
        let collected: bool = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "SELECT EXISTS(SELECT 1 FROM context_source_prefixes p
               CROSS JOIN event_log e ON e.sequence=p.sequence
               WHERE p.kind='session' AND p.owner=?1 AND p.sequence<=?2
               AND e.invocation_id IS NOT NULL AND e.event_header IS NULL AND {filter}
             UNION ALL SELECT 1 FROM session_history_members h JOIN event_log e ON e.sequence=h.sequence
             WHERE h.session_id=?1 AND e.sequence<=?2 AND e.event_header IS NULL AND {filter})"
        ))).bind(session).bind(through as i64).bind(&selection.lineage).fetch_one(&mut *db).await?;
        if collected {
            return Err(StoreError::MaterialCollected);
        }
        let filter = Selection::predicate("e", "?4");
        let rows: Vec<(i64, bool)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT e.sequence,e.inherited FROM session_history_events e
             WHERE e.owner_session_id=?1 AND e.sequence>?2 AND e.sequence<=?3 AND {filter}
             ORDER BY e.sequence"
        )))
        .bind(session)
        .bind(prior.unwrap_or(0) as i64)
        .bind(through as i64)
        .bind(&selection.lineage)
        .fetch_all(&mut *db)
        .await?;
        for (sequence, inherited) in rows {
            let sequence = sequence_number(sequence)?;
            self.add(sequence)?;
            if inherited {
                self.member(db, session, sequence).await?;
            }
        }
        self.scopes.insert(key, through);
        Ok(())
    }

    async fn archives(
        &mut self,
        db: &mut SqliteConnection,
        scope: &LogScope,
        through: u64,
        before: u64,
    ) -> Result<(), StoreError> {
        let selection = Selection::resolve(db, scope).await?;
        let filter = Selection::archive_predicate("t", "a", "?3", "?4");
        let target = Selection::predicate("t", "?4");
        let rows: Vec<i64> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "SELECT a.sequence FROM session_history_events t JOIN runtime_events a
             ON a.kind='tool_result_archived' AND json_extract(a.event_header,'$.fact.placeholder.identity.runtime_event_id')=t.event_id
             WHERE t.owner_session_id=?1 AND t.sequence<=?2 AND {filter} AND {target}
             ORDER BY a.sequence"
        ))).bind(&selection.session).bind(through as i64).bind(before as i64).bind(&selection.lineage)
            .fetch_all(db).await?;
        for row in rows {
            self.add(sequence_number(row)?)?;
        }
        Ok(())
    }
}
