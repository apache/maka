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

use crate::{EventLog, StoreError, sequence_number};
use maka_agent_facts::configuration::validation::MAX_SAFE_INTEGER;
use maka_agent_facts::continuation::RunBoundary;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::event::StoredEvent;
use rusqlite::OptionalExtension;
use sha2::{Digest, Sha256};

/// Canonical evidence for one physical Run cut, retaining only its endpoints.
/// Boundary high-water counts Run-local events; endpoint sequences are root positions.
#[derive(Debug)]
pub struct RunSource {
    pub boundary: RunBoundary,
    pub opening: StoredEvent,
    pub last: StoredEvent,
}

impl EventLog {
    /// Read the admitted identity and exact Run-local cut in one snapshot.
    /// A requested cut must exist; it is never silently clamped to the latest event.
    /// An unsealed prefix is readable evidence, not proof that resuming it is safe.
    pub async fn run_source(
        &self,
        session: &str,
        run: &str,
        up_to: Option<u64>,
    ) -> Result<Option<RunSource>, StoreError> {
        crate::sessions::validate_id(session)?;
        crate::sessions::validate_id(run)?;
        if up_to.is_some_and(|n| n == 0 || n > MAX_SAFE_INTEGER) {
            return Err(invalid("Run high-water is not a positive safe integer"));
        }
        let (session, run) = (session.to_owned(), run.to_owned());
        self.connection
            .read(move |connection| {
                {
                    let tx = rusqlite::Transaction::new_unchecked(connection, rusqlite::TransactionBehavior::Deferred)?;
                    let Some(invocation) =
                        crate::turns::run_invocation(&tx, &session, &run)?
                    else {
                        return Ok(None);
                    };
                    let through = if let Some(up_to) = up_to {
                        tx.prepare_cached("SELECT sequence FROM context_source_prefixes WHERE kind='invocation' AND owner=? AND ordinal=?")?.query_row(rusqlite::params![&invocation,up_to as i64], |row| row.get(0)).optional()?
                        .ok_or_else(|| invalid("requested Run prefix is unavailable"))?
                    } else {
                        tx.prepare_cached("SELECT MAX(sequence) FROM runtime_events WHERE invocation_id = ?")?.query_row(rusqlite::params![&invocation], |row| row.get(0))?
                    };
                    let source = read(&tx, &session, &run, &invocation, through)?;
                    tx.commit()?;
                    Ok(Some(source))
                }
            })
            .await
    }
}

pub(crate) fn read(
    connection: &rusqlite::Connection,
    session: &str,
    run: &str,
    invocation_id: &str,
    through: i64,
) -> Result<RunSource, StoreError> {
    let (sequence, count, root): (i64, i64, Vec<u8>) = connection
        .prepare_cached(
            "SELECT sequence,ordinal,hash FROM context_source_prefixes
         WHERE kind='invocation' AND owner=? AND sequence<=? ORDER BY sequence DESC LIMIT 1",
        )?
        .query_row(rusqlite::params![invocation_id, through], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .optional()?
        .ok_or_else(|| invalid("Run source is empty"))?;
    if through != i64::MAX && sequence != through {
        return Err(invalid("requested Run prefix is unavailable"));
    }
    let through = sequence;
    let high_water = sequence_number(count)?;
    if high_water == 0 || high_water > MAX_SAFE_INTEGER {
        return Err(invalid(
            "Run source high-water is not a positive safe integer",
        ));
    }
    let (opened,json):(i64,String)=connection.prepare_cached("SELECT sequence,event_header FROM runtime_events WHERE invocation_id=? ORDER BY sequence LIMIT 1")?.query_row(rusqlite::params![invocation_id], |row| Ok((row.get(0)?,row.get(1)?,)))?;
    let opening = StoredEvent {
        sequence: sequence_number(opened)?,
        event: serde_json::from_str::<RuntimeEvent>(&json)?,
    };
    let json = crate::canonical::one(connection, sequence_number(through)?)?;
    let last = StoredEvent {
        sequence: sequence_number(through)?,
        event: serde_json::from_str::<RuntimeEvent>(&json)?,
    };
    if !matches!(opening.event.fact, Fact::InvocationOpened { .. })
        || opening.event.invocation.session_id != session
        || opening.event.invocation.run_id != run
        || opening.event.invocation.invocation_id != invocation_id
        || last.event.invocation != opening.event.invocation
    {
        return Err(invalid("Run prefix lacks its exact canonical identity"));
    }
    let identity = serde_json::to_vec(&opening.event.invocation)?;
    let mut digest = Sha256::new();
    digest.update(b"maka.run-prefix.v1\0");
    digest.update(high_water.to_be_bytes());
    digest.update((identity.len() as u64).to_be_bytes());
    digest.update(identity);
    digest.update(root);
    Ok(RunSource {
        boundary: RunBoundary {
            invocation: opening.event.invocation.clone(),
            high_water,
            digest: format!("sha256:{}", hex::encode(digest.finalize())),
        },
        opening,
        last,
    })
}

/// Read only writer-admitted relationship metadata for ordinary lineage views.
/// Explicit RunSource exports separately materialize their requested endpoints.
pub(crate) fn admitted_boundary(
    connection: &rusqlite::Connection,
    invocation: &str,
    through: i64,
) -> Result<(RunBoundary, u64), StoreError> {
    let (sequence,count,root,identity):(i64,i64,Vec<u8>,String)=connection.prepare_cached("SELECT p.sequence,p.ordinal,p.hash,l.identity_json FROM context_source_prefixes p
         JOIN context_source_lineages l ON l.invocation_id=p.owner
         WHERE p.kind='invocation' AND p.owner=? AND p.sequence<=? ORDER BY p.sequence DESC LIMIT 1")?.query_row(rusqlite::params![invocation,through], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,))).optional()?
        .ok_or_else(||invalid("Run source is empty"))?;
    if through != i64::MAX && through != sequence {
        return Err(invalid("requested Run prefix is unavailable"));
    }
    let invocation: maka_agent_facts::event::Invocation = serde_json::from_str(&identity)?;
    let bytes = serde_json::to_vec(&invocation)?;
    let count = sequence_number(count)?;
    let mut digest = Sha256::new();
    digest.update(b"maka.run-prefix.v1\0");
    digest.update(count.to_be_bytes());
    digest.update((bytes.len() as u64).to_be_bytes());
    digest.update(bytes);
    digest.update(root);
    Ok((
        RunBoundary {
            invocation,
            high_water: count,
            digest: format!("sha256:{}", hex::encode(digest.finalize())),
        },
        sequence_number(sequence)?,
    ))
}

fn invalid(reason: &str) -> StoreError {
    StoreError::InvalidTransition(reason.into())
}
