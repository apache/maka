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
    turns::{InvocationState, TurnBoundary},
};
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::InvocationInput;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::RuntimeEvent;
use rusqlite::OptionalExtension;
use std::collections::HashSet;

fn opening(tx: &rusqlite::Connection, id: &str) -> Result<Option<RuntimeEvent>, StoreError> {
    let json: Option<String> = tx
        .prepare_cached(
            "SELECT event_header
         FROM runtime_events WHERE invocation_id=? AND kind='invocation_opened'",
        )?
        .query_row(rusqlite::params![id], |row| row.get(0))
        .optional()?;
    json.map(|json| serde_json::from_str(&json).map_err(StoreError::from))
        .transpose()
}

/// Canonical append authenticates each immutable prefix. Control reads only
/// openings, seals and edge identity, keeping model-history size out of Stop.
pub(crate) fn read(
    tx: &rusqlite::Connection,
    source: &Invocation,
) -> Result<TurnBoundary, StoreError> {
    let mut current = opening(tx, &source.invocation_id)?
        .ok_or_else(|| super::invalid("handoff owner opening is missing"))?;
    if current.invocation != *source {
        return Err(super::invalid("handoff owner identity changed"));
    }
    let mut seen = HashSet::new();
    loop {
        if !seen.insert(current.invocation.run_id.clone()) {
            return Err(super::invalid("handoff owner cycle"));
        }
        let boundary = crate::turns::project(tx, current)?;
        let InvocationState::Ended {
            outcome: InvocationOutcome::HandoffPaused { pause },
            ..
        } = &boundary.state
        else {
            return Ok(boundary);
        };
        let Some(next) = opening(tx, &pause.intent.successor_invocation_id)? else {
            return Ok(boundary);
        };
        let Fact::InvocationOpened {
            input:
                InvocationInput::Handoff {
                    claim,
                    pause: inherited,
                },
            ..
        } = &next.fact
        else {
            return Err(super::invalid("handoff successor has no canonical claim"));
        };
        pause
            .validate_claim(claim, &next.invocation)
            .map_err(super::invalid)?;
        if inherited.as_ref() != pause || claim.source.invocation != boundary.invocation {
            return Err(super::invalid(
                "handoff successor changed its sealed source",
            ));
        }
        let count: i64 = tx
            .prepare_cached("SELECT COUNT(*) FROM runtime_events WHERE invocation_id=?")?
            .query_row(
                rusqlite::params![&boundary.invocation.invocation_id],
                |row| row.get(0),
            )?;
        if u64::try_from(count).ok() != Some(claim.source.high_water) {
            return Err(super::invalid(
                "handoff successor changed its source boundary",
            ));
        }
        current = next;
    }
}
