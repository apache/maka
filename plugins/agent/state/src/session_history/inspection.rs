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

//! Bounded canonical inspection through an already-owned physical Root writer.
use super::{HistoryItem, HistoryNamespace, HistoryScope, sql};
use crate::store::invalid;
use maka_agent_facts::durable::{ContentRef, RecordedFact, RunId, RunOwner, SCHEMA_VERSION};
use maka_event_log::{StoreError, connection::Query, root_store::DataWriter};
use rusqlite::{Connection, params};
use serde::Serialize;
use std::{collections::BTreeMap, io::Write};

const MAX_FACTS: usize = 10_000;
const MAX_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub session: String,
    /// Canonical session tail in this read snapshot, not the last included fact.
    pub through: Option<u64>,
    pub truncated: bool,
    pub facts: Vec<InspectedFact>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectedFact {
    pub owner: RunOwner,
    pub item: HistoryItem,
}

/// The caller resolves the existing Root session. This does not create one,
/// acquire execution authority, or expand imported history and payload refs.
pub async fn read(data: &DataWriter, session: &str) -> Result<Inspection, StoreError> {
    maka_agent_facts::interaction::entity_id(session).map_err(invalid)?;
    data.query_barrier(Read(session.to_owned())).await
}

struct Read(String);

impl Query for Read {
    type Output = Inspection;

    fn execute(self, c: &Connection) -> Result<Inspection, StoreError> {
        let (tail, missing_admission): (Option<i64>, bool) = c.query_row(
            "SELECT MAX((SELECT f.sequence FROM agent_facts f INDEXED BY agent_facts_diagnostics_tail WHERE f.run=s.run ORDER BY f.revision DESC LIMIT 1)),COALESCE(MAX(NOT EXISTS(SELECT 1 FROM agent_facts a WHERE a.run=s.run AND a.revision=1)),0) FROM agent_run_specs s INDEXED BY agent_run_specs_session WHERE s.session=?",
            [&self.0],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if missing_admission {
            return Err(invalid("inspection Run is missing its canonical admission"));
        }
        let through = tail
            .map(|value| {
                u64::try_from(value)
                    .ok()
                    .filter(|value| *value > 0)
                    .ok_or_else(|| invalid("invalid canonical inspection tail"))
            })
            .transpose()?;
        let mut output = Inspection {
            session: self.0,
            through,
            truncated: false,
            facts: Vec::new(),
        };
        // false is one byte longer than true: reserving it bounds either result.
        let mut bytes = json_bytes(&output)?;
        if bytes > MAX_BYTES {
            return Err(invalid("inspection envelope exceeds its JSON budget"));
        }
        let Some(through) = through else {
            return Ok(output);
        };
        let mut runs = BTreeMap::<String, RunOwner>::new();
        let mut prefixes = BTreeMap::<String, String>::new();
        // CROSS JOIN fixes the session-indexed outer relation; ORDER BY sorts
        // only this session's metadata, never Root-wide facts or Blob payloads.
        let mut statement = c.prepare_cached(
            "SELECT s.run,s.owner,f.sequence,f.id,f.revision,f.schema_version,b.id,b.content_sha256,length(b.payload),h.run,h.fact_id,h.admission_sequence,h.step,h.attempt,h.prefix_digest FROM agent_run_specs s INDEXED BY agent_run_specs_session CROSS JOIN agent_facts f INDEXED BY agent_facts_diagnostics_tail LEFT JOIN contents b ON b.id=f.body_content_id LEFT JOIN agent_session_history h ON h.sequence=f.sequence WHERE s.session=? AND f.run=s.run AND f.sequence<=? ORDER BY f.sequence LIMIT ?",
        )?;
        let mut rows = statement.query(params![
            output.session,
            sql::bind_u64(through)?,
            MAX_FACTS as i64 + 1
        ])?;
        while let Some(row) = rows.next()? {
            if output.facts.len() == MAX_FACTS {
                output.truncated = true;
                break;
            }
            let length = sql::read_u64(row, 8)?;
            if length > MAX_BYTES as u64 {
                output.truncated = true;
                break;
            }
            let run_key: String = row.get(0)?;
            let run: RunId = sql::identity(run_key.clone())?;
            if !runs.contains_key(&run_key) {
                let (spec_bytes, admission_bytes): (u64, u64) = c.query_row(
                    "SELECT length(b.payload),length(ab.payload) FROM agent_run_specs s LEFT JOIN contents b ON b.id=s.spec_content_id LEFT JOIN agent_facts a ON a.run=s.run AND a.revision=1 LEFT JOIN contents ab ON ab.id=a.body_content_id WHERE s.run=?",
                    [&run_key],
                    |row| Ok((sql::read_u64(row,0)?, sql::read_u64(row,1)?)),
                )?;
                // Oversized unobserved metadata is not loaded or claimed valid.
                if spec_bytes > MAX_BYTES as u64 || admission_bytes > MAX_BYTES as u64 {
                    output.truncated = true;
                    break;
                }
                let namespace = HistoryNamespace {
                    owner: serde_json::from_str(&row.get::<_, String>(1)?)?,
                    session: output.session.clone(),
                };
                let source = sql::run_source(c, &namespace, run)?;
                runs.insert(run_key.clone(), source.spec.owner);
            }
            let owner = &runs[&run_key];
            let sequence = sql::read_u64(row, 2)?;
            let version: u32 = row.get(5)?;
            if version != SCHEMA_VERSION {
                return Err(invalid("unsupported inspection fact schema"));
            }
            let reference = ContentRef {
                digest: row.get(7)?,
                bytes: length,
            };
            let recorded: RecordedFact = sql::decode_original(c, row.get(6)?, &reference)?;
            if recorded.run != run
                || recorded.id.to_string() != row.get::<_, String>(3)?
                || recorded.revision != sql::read_u64(row, 4)?
            {
                return Err(invalid(
                    "inspection canonical fact identity differs from its original bytes",
                ));
            }
            let cached_run: Option<String> = row.get(9)?;
            let cached_fact: Option<String> = row.get(10)?;
            let admission: Option<i64> = row.get(11)?;
            let expected: Option<String> = row.get(14)?;
            let (Some(cached_run), Some(cached_fact), Some(admission), Some(expected)) =
                (cached_run, cached_fact, admission, expected)
            else {
                return Err(invalid(
                    "inspection history cache missing; explicit rebuild required",
                ));
            };
            let admission = u64::try_from(admission)
                .map_err(|_| invalid("invalid inspection admission sequence"))?;
            let scope = HistoryScope {
                step: row
                    .get::<_, Option<String>>(12)?
                    .map(sql::identity)
                    .transpose()?,
                attempt: row
                    .get::<_, Option<String>>(13)?
                    .map(sql::identity)
                    .transpose()?,
            };
            sql::validate_source_record(
                c,
                sql::identity(cached_run)?,
                sql::identity(cached_fact)?,
                admission,
                &scope,
                &recorded,
            )?;
            let owner_key = serde_json::to_string(owner)?;
            let prior = match prefixes.get(&owner_key) {
                Some(prefix) => prefix.clone(),
                None => sql::seed(owner, &output.session)?,
            };
            let prefix = sql::chain(&prior, sequence, &reference.digest)?;
            if prefix != expected {
                return Err(invalid(
                    "inspection history prefix differs; explicit rebuild required",
                ));
            }
            prefixes.insert(owner_key, prefix);
            let fact = InspectedFact {
                owner: owner.clone(),
                item: HistoryItem {
                    sequence,
                    admission_sequence: admission,
                    scope,
                    recorded,
                },
            };
            let addition = json_bytes(&fact)? + usize::from(!output.facts.is_empty());
            if addition > MAX_BYTES - bytes {
                output.truncated = true;
                break;
            }
            bytes += addition;
            output.facts.push(fact);
        }
        Ok(output)
    }
}

fn json_bytes(value: &impl Serialize) -> Result<usize, StoreError> {
    struct Counter(usize);
    impl Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter(0);
    serde_json::to_writer(&mut counter, value)?;
    Ok(counter.0)
}
