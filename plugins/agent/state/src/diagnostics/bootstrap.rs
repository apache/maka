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

use super::*;
use std::collections::BTreeSet;

pub(crate) async fn ensure_owner(data: &DataWriter, owner: RunOwner) -> Result<(), StoreError> {
    if owner.deployment.is_nil() {
        return Err(invalid("nil diagnostics deployment"));
    }
    owner
        .namespace
        .validate()
        .map_err(|error| invalid(error.to_string()))?;
    data.write(EnsureOwner(owner)).await
}

struct EnsureOwner(RunOwner);
impl Statement for EnsureOwner {
    type Value = ();
    type Output = ();
    fn execute(self, c: &Connection) -> Result<Prepared<()>, StoreError> {
        let headers_changed = crate::sql::ensure_headers(c, &self.0)?;
        let mut sessions = BTreeSet::new();
        let mut statement=c.prepare_cached("SELECT s.run,s.session,s.schema_version,v.run,v.revision,v.sequence FROM agent_run_specs s INDEXED BY agent_run_specs_diagnostics_cover LEFT JOIN agent_diagnostic_coverage v ON v.run=s.run WHERE s.owner=?")?;
        let mut rows = statement.query([serde_json::to_string(&self.0)?])?;
        while let Some(row) = rows.next()? {
            let run: String = row.get(0)?;
            let _: RunId = identity(run.clone())?;
            let session: String = row.get(1)?;
            maka_agent_facts::interaction::entity_id(&session).map_err(invalid)?;
            let (revision, sequence, schema) = read::tail(c, &run)?
                .ok_or_else(|| invalid("diagnostic bootstrap has no canonical source head"))?;
            if row.get::<_, u32>(2)? != SCHEMA_VERSION
                || schema != SCHEMA_VERSION
                || revision <= 0
                || sequence <= 0
            {
                return Err(invalid(
                    "diagnostic bootstrap has an invalid canonical source head/schema",
                ));
            }
            let covered_run: Option<String> = row.get(3)?;
            let covered_revision: Option<i64> = row.get(4)?;
            let covered_sequence: Option<i64> = row.get(5)?;
            if covered_run.is_none() && covered_revision.is_none() && covered_sequence.is_none() {
                sessions.insert(session);
                continue;
            }
            if covered_run.as_ref() != Some(&run)
                || covered_revision.is_none_or(|value| value <= 0 || value > revision)
                || covered_sequence.is_none_or(|value| value <= 0 || value > sequence)
                || (covered_revision == Some(revision)) != (covered_sequence == Some(sequence))
            {
                return Err(invalid(
                    "diagnostic bootstrap coverage is not a valid canonical prefix",
                ));
            }
            if covered_revision != Some(revision) {
                let member:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_facts WHERE sequence=? AND run=? AND revision=? AND schema_version=?)",rusqlite::params![covered_sequence,run,covered_revision,SCHEMA_VERSION],|row|row.get(0))?;
                if !member {
                    return Err(invalid(
                        "diagnostic bootstrap coverage is not a valid canonical prefix",
                    ));
                }
                sessions.insert(session);
            }
        }
        drop(rows);
        drop(statement);
        // Validate every candidate before clearing any Session. A corrupt prefix
        // is not an old-version bootstrap and must remain an explicit failure.
        for session in &sessions {
            index::rebuild(
                c,
                &Scope {
                    owner: self.0.clone(),
                    session: session.clone(),
                },
            )?;
        }
        let changed = headers_changed || !sessions.is_empty();
        Ok(Prepared {
            value: (),
            changed,
            notification: if changed {
                Notification::METADATA.with_sessions(sessions)
            } else {
                Notification::NONE
            },
        })
    }
    fn committed(_: ()) {}
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(
            error,
            StoreError::InvalidTransition(_) | StoreError::EventConflict
        )
    }
}
