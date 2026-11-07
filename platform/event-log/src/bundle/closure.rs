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
use rusqlite::{Connection, OptionalExtension, params};
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};

mod members;

/// Event identities and exact copied memberships, not additional catalog Sessions.
pub(crate) struct Closure {
    pub events: BTreeSet<u64>,
    pub members: BTreeMap<(String, u64), Option<u64>>,
    pub copies: BTreeSet<String>,
    pub revisions: BTreeSet<(String, u64)>,
    queue: VecDeque<u64>,
    scopes: HashMap<String, u64>,
    runs: HashMap<String, u64>,
}

impl Closure {
    pub fn capture(
        db: &Connection,
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
            selected.scope(
                db,
                &LogScope::Session {
                    id: session.id.clone(),
                },
                through,
            )?;
            let revisions: Vec<i64> = db.prepare_cached("SELECT sequence FROM session_revision_sources WHERE session_id=? ORDER BY sequence")?.query_map(params![&session.id], |row| row.get(0))?.collect::<Result<Vec<_>, _>>()?;
            for sequence in revisions {
                let sequence = sequence_number(sequence)?;
                selected.add(sequence)?;
                selected.revisions.insert((session.id.clone(), sequence));
                let source: String = db
                    .prepare_cached(
                        "SELECT source_session_id FROM session_history_copies WHERE session_id=?",
                    )?
                    .query_row(params![&session.id], |row| row.get(0))?;
                selected.member(db, &source, sequence)?;
            }
        }
        while let Some(sequence) = selected.queue.pop_front() {
            let (kind,invocation,header):(String,String,String)=db.prepare_cached("SELECT kind,invocation_id,event_header FROM runtime_events WHERE sequence=? AND event_header IS NOT NULL")?.query_row(params![sequence as i64], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional()?.ok_or(StoreError::MaterialCollected)?;
            if kind != "message_imported" {
                selected.run(db, &invocation, sequence)?;
            }
            if !matches!(
                kind.as_str(),
                "model_requested"
                    | "context_checkpoint_recorded"
                    | "invocation_opened"
                    | "tool_result_archived"
            ) {
                continue;
            }
            let event: RuntimeEvent = serde_json::from_str(&header)?;
            match &event.fact {
                Fact::ModelRequested {
                    source_scope,
                    source_high_water,
                    source_capture,
                    ..
                } => {
                    selected.scope(db, source_scope, *source_high_water)?;
                    selected.archives(
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
                    )?;
                }
                Fact::ContextCheckpointRecorded { checkpoint } => {
                    let selection = Selection::for_invocation(db, &event.invocation)?;
                    selected.scope(db, &selection.scope, checkpoint.covered_through)?;
                    if matches!(checkpoint.mode, CheckpointMode::Standalone) {
                        let terminal: i64 = db.prepare_cached("SELECT sequence FROM runtime_events WHERE invocation_id=? AND kind='invocation_ended'")?.query_row(params![&event.invocation.invocation_id], |row| row.get(0))?;
                        selected.add(sequence_number(terminal)?)?;
                    }
                }
                Fact::InvocationOpened { input, .. } => {
                    if let Some(claim) = input.inherited_claim() {
                        let source = &claim.source.invocation;
                        let end: i64 = db.prepare_cached("SELECT sequence FROM runtime_events WHERE invocation_id=? AND kind='invocation_ended'")?.query_row(params![&source.invocation_id], |row| row.get(0))?;
                        selected.run(db, &source.invocation_id, sequence_number(end)?)?;
                        selected.scope(
                            db,
                            &LogScope::Session {
                                id: source.session_id.clone(),
                            },
                            claim.base.high_water,
                        )?;
                    }
                }
                Fact::ToolResultArchived { placeholder } => {
                    let target: i64 = db
                        .prepare_cached("SELECT sequence FROM runtime_events WHERE event_id=?")?
                        .query_row(params![&placeholder.identity.runtime_event_id], |row| {
                            row.get(0)
                        })?;
                    let selection = Selection::for_invocation(db, &event.invocation)?;
                    selected.scope(db, &selection.scope, sequence_number(target)?)?;
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

    fn run(&mut self, db: &Connection, invocation: &str, through: u64) -> Result<(), StoreError> {
        let prior = self.runs.get(invocation).copied().unwrap_or(0);
        if through <= prior {
            return Ok(());
        }
        let rows: Vec<i64> = db.prepare_cached("SELECT sequence FROM runtime_events WHERE invocation_id=? AND sequence>? AND sequence<=? ORDER BY sequence")?.query_map(params![invocation, prior as i64, through as i64], |row| row.get(0))?.collect::<Result<Vec<_>, _>>()?;
        for row in rows {
            self.add(sequence_number(row)?)?;
        }
        self.runs.insert(invocation.into(), through);
        Ok(())
    }

    fn scope(&mut self, db: &Connection, scope: &LogScope, through: u64) -> Result<(), StoreError> {
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
        let selection = Selection::resolve(db, scope)?;
        let session = selection.session.as_ref().expect("non-root selection");
        let copy: bool = db
            .prepare_cached(
                "SELECT EXISTS(SELECT 1 FROM session_history_copies WHERE session_id=?)",
            )?
            .query_row(params![session], |row| row.get(0))?;
        if copy {
            self.copies.insert(session.clone());
        }
        let filter = Selection::predicate("e", "?3");
        let collected: bool = db.prepare_cached(&format!(
            "SELECT EXISTS(SELECT 1 FROM context_source_prefixes p
               CROSS JOIN event_log e ON e.sequence=p.sequence
               WHERE p.kind='session' AND p.owner=?1 AND p.sequence<=?2
               AND e.invocation_id IS NOT NULL AND e.event_header IS NULL AND {filter}
             UNION ALL SELECT 1 FROM session_history_members h JOIN event_log e ON e.sequence=h.sequence
             WHERE h.session_id=?1 AND e.sequence<=?2 AND e.event_header IS NULL AND {filter})"
        ))?.query_row(params![session, through as i64, &selection.lineage], |row| row.get(0))?;
        if collected {
            return Err(StoreError::MaterialCollected);
        }
        let filter = Selection::predicate("e", "?4");
        let rows: Vec<(i64, bool)> = db
            .prepare_cached(&format!(
                "SELECT e.sequence,e.inherited FROM session_history_events e
             WHERE e.owner_session_id=?1 AND e.sequence>?2 AND e.sequence<=?3 AND {filter}
             ORDER BY e.sequence"
            ))?
            .query_map(
                params![
                    session,
                    prior.unwrap_or(0) as i64,
                    through as i64,
                    &selection.lineage
                ],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        for (sequence, inherited) in rows {
            let sequence = sequence_number(sequence)?;
            self.add(sequence)?;
            if inherited {
                self.member(db, session, sequence)?;
            }
        }
        self.scopes.insert(key, through);
        Ok(())
    }

    fn archives(
        &mut self,
        db: &Connection,
        scope: &LogScope,
        through: u64,
        before: u64,
    ) -> Result<(), StoreError> {
        let selection = Selection::resolve(db, scope)?;
        let filter = Selection::archive_predicate("t", "a", "?3", "?4");
        let target = Selection::predicate("t", "?4");
        let rows: Vec<i64> = db.prepare_cached(&format!(
            "SELECT a.sequence FROM session_history_events t JOIN runtime_events a
             ON a.kind='tool_result_archived' AND json_extract(a.event_header,'$.fact.placeholder.identity.runtime_event_id')=t.event_id
             WHERE t.owner_session_id=?1 AND t.sequence<=?2 AND {filter} AND {target}
             ORDER BY a.sequence"
        ))?.query_map(params![&selection.session, through as i64, before as i64, &selection.lineage], |row| row.get(0))?.collect::<Result<Vec<_>, _>>()?;
        for row in rows {
            self.add(sequence_number(row)?)?;
        }
        Ok(())
    }
}
