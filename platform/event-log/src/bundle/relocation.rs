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

use crate::{
    StoreError,
    context::{self, selection::Selection},
};
use maka_agent_facts::continuation::ContinuationClaim;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::InvocationInput;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::handoff::HandoffPause;
use rusqlite::{Connection, params};

/// Relocation concerns root positions only; Run-local ordinals and provider
/// replay identities belong to different contracts and are never translated.
pub(super) struct Positions {
    source: Vec<u64>,
    offset: u64,
}

impl Positions {
    pub fn high_water(&self) -> u64 {
        self.offset + self.source.len() as u64
    }

    pub fn read(staged: &Connection, offset: u64) -> Result<Self, StoreError> {
        let rows: Vec<i64> = staged
            .prepare_cached(
                "SELECT source_sequence FROM frames WHERE kind='event' ORDER BY source_sequence",
            )?
            .query_map(params![], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        if offset
            .checked_add(rows.len() as u64)
            .is_none_or(|n| n >= i64::MAX as u64)
        {
            return Err(StoreError::PrefixTooLarge);
        }
        Ok(Self {
            source: rows
                .into_iter()
                .map(crate::sequence_number)
                .collect::<Result<_, _>>()?,
            offset,
        })
    }

    pub fn event(&self, source: u64) -> Result<u64, StoreError> {
        self.source
            .binary_search(&source)
            .map(|index| self.offset + index as u64 + 1)
            .map_err(|_| invalid("relocation lacks a referenced event"))
    }

    pub fn fence(&self, source: u64) -> u64 {
        let rank = self.source.partition_point(|sequence| *sequence <= source);
        if rank == 0 {
            0
        } else {
            self.offset + rank as u64
        }
    }

    /// Called in chronological order against already relocated predecessors.
    /// Unaffected facts retain their exact source bytes.
    pub fn json(&self, db: &Connection, json: String) -> Result<String, StoreError> {
        let mut event: RuntimeEvent = serde_json::from_str(&json)?;
        match &mut event.fact {
            Fact::InvocationOpened { input, .. } => match input {
                InvocationInput::Continuation { claim, .. } => self.claim(db, claim)?,
                InvocationInput::Handoff { claim, pause } => {
                    self.claim(db, claim)?;
                    self.pause(pause);
                }
                _ => return Ok(json),
            },
            Fact::InvocationEnded {
                outcome: InvocationOutcome::HandoffPaused { pause },
            } => {
                self.pause(pause);
            }
            Fact::ModelRequested {
                source_scope,
                source_high_water,
                source_capture,
                source_digest,
                effective_source_digest,
                ..
            } => {
                *source_high_water = self.event_or_zero(*source_high_water)?;
                source_capture.publication_watermark =
                    self.fence(source_capture.publication_watermark);
                let selection = Selection::resolve(db, source_scope)?;
                let evidence = context::evidence::selected(db, &selection, *source_high_water)?;
                *source_digest = evidence.digest.clone();
                *effective_source_digest = Some(crate::archive::digest_selected(
                    db,
                    &selection,
                    &evidence,
                    source_capture.publication_watermark + 1,
                )?);
            }
            Fact::ContextCheckpointRecorded { checkpoint } => {
                checkpoint.covered_through = self.event_or_zero(checkpoint.covered_through)?;
                let selection = Selection::for_invocation(db, &event.invocation)?;
                checkpoint.source_digest =
                    context::evidence::selected(db, &selection, checkpoint.covered_through)?.digest;
            }
            _ => return Ok(json),
        }
        Ok(serde_json::to_string(&event)?)
    }

    fn event_or_zero(&self, source: u64) -> Result<u64, StoreError> {
        if source == 0 {
            Ok(0)
        } else {
            self.event(source)
        }
    }

    fn pause(&self, pause: &mut HandoffPause) {
        pause.execution.replay_base = pause.execution.replay_base.map(|n| self.fence(n));
    }

    fn claim(&self, db: &Connection, claim: &mut ContinuationClaim) -> Result<(), StoreError> {
        claim.base.high_water = self.event_or_zero(claim.base.high_water)?;
        claim.base.digest = context::evidence::selected(
            db,
            &Selection::session(&claim.source.invocation.session_id),
            claim.base.high_water,
        )?
        .digest;
        let source = &claim.source.invocation;
        let through: i64 = db.prepare_cached("SELECT sequence FROM runtime_events WHERE invocation_id=? ORDER BY sequence LIMIT 1 OFFSET ?")?.query_row(params![&source.invocation_id, (claim.source.high_water - 1) as i64], |row| row.get(0))?;
        claim.source.digest = crate::run_source::read(
            db,
            &source.session_id,
            &source.run_id,
            &source.invocation_id,
            through,
        )?
        .boundary
        .digest;
        Ok(())
    }
}

fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}
