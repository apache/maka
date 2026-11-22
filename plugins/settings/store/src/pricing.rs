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

mod catalog;
pub(crate) use catalog::initialize;

use crate::{ConfigError, ConfigurationStore, Result, TransactionMode, database::unsigned};
use maka_agent_facts::pricing::Entry;
use maka_agent_facts::pricing::Mutation;
use maka_agent_facts::pricing::Page;
use maka_agent_facts::pricing::Pricing;
use maka_agent_facts::pricing::Query;
use maka_agent_facts::pricing::ResetEffect;
use maka_agent_facts::pricing::Update;
use maka_agent_facts::pricing::Updated;
use rusqlite::{Connection, OptionalExtension};

const MAX_REVISION: u64 = 9_007_199_254_740_991;
const PAGE_ITEMS: usize = 128;
// A packing target; one complete larger entry still advances the cursor.
const PAGE_ENTRY_BYTES: usize = 47 * 1024;

impl ConfigurationStore {
    /// Provider identity comes from the selected connection, never its wire adapter.
    pub async fn quote_model(
        &self,
        provider_id: String,
        model: String,
    ) -> Result<maka_agent_facts::pricing::Quote> {
        let key = format!("{provider_id}:{model}");
        self.transaction(TransactionMode::Deferred, move |connection| {
            let revision = revision(connection)?;
            let record: Option<String> = connection
                .prepare_cached("SELECT record_json FROM effective_pricing WHERE model_key = ?")?
                .query_row(rusqlite::params![key], |row| row.get(0))
                .optional()?;
            let quote = maka_agent_facts::pricing::Quote {
                provider_id,
                revision,
                pricing: record
                    .map(|record| serde_json::from_str(&record))
                    .transpose()?,
            };
            quote.validate(&model).map_err(invalid)?;
            Ok(quote)
        })
        .await
    }

    /// Continuations are valid only while both bundled and custom rates are unchanged.
    pub async fn query_pricing(&self, query: Query) -> Result<Page> {
        self.transaction(TransactionMode::Deferred, move |connection| {
            let revision = revision(connection)?;
            let offset = match query {
                Query::Start => 0,
                Query::Continue { revision: expected, offset } => {
                    if expected > MAX_REVISION || offset > i64::MAX as u64 {
                        return Err(invalid("invalid pricing continuation"));
                    }
                    if expected != revision {
                        return Ok(Page::RevisionChanged { expected_revision: expected, actual_revision: revision });
                    }
                    let count: i64 = connection.prepare_cached("SELECT COUNT(*) FROM effective_pricing")?.query_row(rusqlite::params![], |row| row.get(0))?;
                    if offset >= unsigned(count)? {
                        return Err(invalid("pricing offset is outside the catalog"));
                    }
                    offset
                }
            };
            let rows: Vec<(String, bool, bool)> = connection.prepare_cached("SELECT record_json, custom, builtin FROM effective_pricing ORDER BY sort_key LIMIT ? OFFSET ?")?.query_map(rusqlite::params![(PAGE_ITEMS + 1) as i64, offset as i64], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?,)))?.collect::<std::result::Result<Vec<_>, _>>()?;
            let mut entries = Vec::new();
            let mut bytes = 0;
            let mut more = false;
            for (record_json, custom, builtin) in rows {
                let pricing = serde_json::from_str(&record_json)?;
                let entry = if custom {
                    Entry::Custom { pricing, reset_effect: if builtin {
                        ResetEffect::RestoreBuiltin
                    } else { ResetEffect::BecomeUnpriced } }
                } else { Entry::Builtin { pricing } };
                let size = serde_json::to_vec(&entry)?.len() + 1;
                if entries.len() == PAGE_ITEMS || (!entries.is_empty() && bytes + size > PAGE_ENTRY_BYTES) {
                    more = true;
                    break;
                }
                bytes += size;
                entries.push(entry);
            }
            let next_offset = more.then_some(offset + entries.len() as u64);
            Ok(Page::Page { revision, offset, entries, next_offset })
        }).await
    }

    pub async fn update_pricing(&self, update: Update) -> Result<Updated> {
        if update.expected_revision > MAX_REVISION {
            return Err(invalid("invalid pricing revision"));
        }
        match &update.mutation {
            Mutation::Upsert { pricing } => pricing.validate().map_err(invalid)?,
            Mutation::Delete { model_key } => {
                maka_agent_facts::pricing::validate_key(model_key).map_err(invalid)?
            }
        }
        self.transaction(TransactionMode::Immediate, move |connection| {
            let current = revision(connection)?;
            if current != update.expected_revision {
                return Ok(Updated::RevisionConflict {
                    expected_revision: update.expected_revision, actual_revision: current,
                });
            }
            let changed = match update.mutation {
                Mutation::Upsert { pricing } => {
                    let old: Option<String> = connection.prepare_cached("SELECT record_json FROM pricing_overrides WHERE model_key = ?")?.query_row(rusqlite::params![&pricing.model_key], |row| row.get(0)).optional()?;
                    if old.as_deref().map(serde_json::from_str::<Pricing>).transpose()?.as_ref() == Some(&pricing) {
                        false
                    } else {
                        let record = serde_json::to_string(&pricing)?;
                        connection.execute("INSERT INTO pricing_overrides(model_key, sort_key, record_json) VALUES(?, ?, ?)
                             ON CONFLICT(model_key) DO UPDATE SET record_json = excluded.record_json", rusqlite::params![&pricing.model_key, sort_key(&pricing.model_key), record])?;
                        true
                    }
                }
                Mutation::Delete { model_key } => connection.execute("DELETE FROM pricing_overrides WHERE model_key = ?", rusqlite::params![model_key])? != 0,
            };
            if !changed { return Ok(Updated::Unchanged { revision: current }); }
            let revision = current.checked_add(1).filter(|revision| *revision <= MAX_REVISION)
                .ok_or_else(|| invalid("pricing revision exhausted"))?;
            connection.execute("UPDATE pricing_authority SET revision = ? WHERE singleton = 1", rusqlite::params![revision as i64])?;
            Ok(Updated::Committed { revision })
        }).await
    }
}

fn revision(connection: &Connection) -> Result<u64> {
    unsigned(
        connection
            .prepare_cached("SELECT revision FROM pricing_authority WHERE singleton = 1")?
            .query_row(rusqlite::params![], |row| row.get(0))?,
    )
}

fn invalid(message: impl Into<String>) -> ConfigError {
    ConfigError::Invalid(message.into())
}

// Big-endian UTF-16 preserves the client's exact, locale-independent key ordering.
fn sort_key(key: &str) -> Vec<u8> {
    key.encode_utf16().flat_map(u16::to_be_bytes).collect()
}
