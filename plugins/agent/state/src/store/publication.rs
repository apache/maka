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

use super::{DriverClaim, Head, Store, invalid};
use crate::sql;
use maka_agent_facts::durable::{FactId, RecordedFact, RunId};
use maka_event_log::{StoreError, connection::Query};
use rusqlite::{Connection, OptionalExtension};
use std::{
    collections::BTreeSet,
    sync::{Arc, Weak},
};

/// Original publication evidence from one Root snapshot, not a dispatch grant.
pub struct PublicationRead {
    pub head: Head,
    pub claim_current: bool,
    pub facts: Vec<RecordedFact>,
}

impl Store {
    pub async fn publication(
        &self,
        run: RunId,
        ids: Vec<FactId>,
        claim: Option<&DriverClaim>,
    ) -> Result<PublicationRead, StoreError> {
        if let Some(claim) = claim {
            if !Arc::ptr_eq(&self.domain.inner, &claim.ticket.domain) {
                return Err(invalid("foreign driver claim"));
            }
            if claim.run() != run {
                return Err(invalid("driver claim belongs to another Run"));
            }
            if !self.data.same_root(&claim.ticket.domain.data) {
                return Err(invalid("driver claim belongs to another Root owner"));
            }
        }
        if ids.is_empty() {
            return Err(invalid("publication requires at least one fact identity"));
        }
        let mut unique = BTreeSet::new();
        if ids.iter().any(|id| !unique.insert(*id)) {
            return Err(invalid("duplicate publication fact identity"));
        }
        self.data
            .query_barrier(ReadPublication {
                run,
                ids,
                claim: claim.cloned(),
            })
            .await
    }
}

struct ReadPublication {
    run: RunId,
    ids: Vec<FactId>,
    claim: Option<DriverClaim>,
}
impl Query for ReadPublication {
    type Output = PublicationRead;

    fn execute(self, connection: &Connection) -> Result<Self::Output, StoreError> {
        // Hold the actual driver slot across the first SQL read and every fact read.
        let drivers = self
            .claim
            .as_ref()
            .map(|claim| {
                claim
                    .ticket
                    .domain
                    .drivers
                    .lock()
                    .map_err(|_| invalid("poisoned driver domain"))
            })
            .transpose()?;
        let claim_current =
            self.claim
                .as_ref()
                .zip(drivers.as_ref())
                .is_some_and(|(claim, drivers)| {
                    drivers.get(&self.run).is_some_and(|current| {
                        Weak::ptr_eq(current, &Arc::downgrade(&claim.ticket))
                    })
                });
        let head = connection
            .prepare_cached("SELECT revision, control_version FROM agent_runs WHERE run=?")?
            .query_row([self.run.to_string()], |row| {
                Ok(Head {
                    revision: column_u64(row, 0)?,
                    control_version: column_u64(row, 1)?,
                })
            })
            .optional()?
            .ok_or_else(|| invalid("Run indexes are absent; explicit rebuild required"))?;
        let mut facts = Vec::with_capacity(self.ids.len());
        for id in self.ids {
            if let Some(fact) = sql::fact(connection, self.run, id)? {
                facts.push(fact);
            }
        }
        drop(drivers);
        Ok(PublicationRead {
            head,
            claim_current,
            facts,
        })
    }
}

fn column_u64(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<u64> {
    let value: i64 = row.get(index)?;
    u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(index, value))
}
