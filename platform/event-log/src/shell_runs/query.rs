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

use crate::{EventLog, StoreError};
use maka_presentation::shell::{ResourceUpdate, local_metadata, local_update};
use rusqlite::params;
use sha2::{Digest, Sha256};

/// A bounded page from one read transaction. The digest covers the projected
/// scope (one resource for get, the whole session for list), not OS handles.
pub struct ShellResourcePage {
    pub resources: Vec<ResourceUpdate>,
    pub revision: String,
    pub total: u64,
    pub next_offset: Option<u64>,
}

impl EventLog {
    pub async fn query_shell_resources(
        &self,
        session: &str,
        id: Option<&str>,
        offset: u64,
    ) -> Result<ShellResourcePage, StoreError> {
        self.query_shell_page(session, id, offset, None, false)
            .await
    }

    /// Provider filtering happens before counting, digesting and paging. The
    /// list projects metadata only; full canonical output belongs to detail reads.
    pub async fn query_shell_catalog(
        &self,
        session: &str,
        provider_prefix: &str,
        offset: u64,
    ) -> Result<ShellResourcePage, StoreError> {
        maka_agent_facts::interaction::entity_id(provider_prefix).map_err(super::invalid)?;
        self.query_shell_page(session, None, offset, Some(provider_prefix), true)
            .await
    }

    async fn query_shell_page(
        &self,
        session: &str,
        id: Option<&str>,
        offset: u64,
        provider_prefix: Option<&str>,
        compact: bool,
    ) -> Result<ShellResourcePage, StoreError> {
        maka_agent_facts::interaction::entity_id(session).map_err(super::invalid)?;
        if let Some(id) = id {
            maka_agent_facts::interaction::entity_id(id).map_err(super::invalid)?;
        }
        let (session, id) = (session.to_owned(), id.map(str::to_owned));
        let provider_prefix = provider_prefix.map(str::to_owned);
        self.connection
            .read(move |connection| {
                {
                    let tx = rusqlite::Transaction::new_unchecked(
                        connection,
                        rusqlite::TransactionBehavior::Deferred,
                    )?;
                    let exists: bool = tx.query_row(
                        "SELECT EXISTS(SELECT 1 FROM session_control WHERE id = ?)",
                        params![&session],
                        |row| row.get(0),
                    )?;
                    if !exists {
                        return Err(StoreError::SessionNotFound);
                    }
                    let mut statement = tx.prepare_cached(
                        "SELECT id, record_json FROM shell_runs \
                     WHERE session_id = ? AND (? IS NULL OR id = ?) \
                     AND (? IS NULL OR substr(id, 1, length(?)) = ?) ORDER BY id",
                    )?;
                    let mut rows = statement.query(params![
                        &session,
                        &id,
                        &id,
                        &provider_prefix,
                        &provider_prefix,
                        &provider_prefix
                    ])?;
                    let mut hash = Sha256::new();
                    hash.update(b"[");
                    let mut total = 0_u64;
                    let mut resources = Vec::new();
                    // The page envelope (IDs, digest, cursor and keys) is <512 bytes.
                    // JSON-escaped source tool IDs belong to each serialized resource.
                    let mut page_bytes = 512;
                    let mut page_full = false;
                    while let Some(row) = rows.next()? {
                        let record = super::decode(
                            &row.get::<_, String>("record_json")?,
                            &session,
                            &row.get::<_, String>("id")?,
                        )?;
                        let projected = if compact {
                            local_metadata(record)?
                        } else {
                            local_update(record)?
                        };
                        let bytes = serde_json::to_vec(&projected)?;
                        if total != 0 {
                            hash.update(b",");
                        }
                        hash.update(&bytes);
                        if total >= offset && !page_full {
                            if resources.len() == 64
                                || (!resources.is_empty()
                                    && page_bytes + bytes.len() + 1 > 52 * 1024)
                            {
                                page_full = true;
                            } else {
                                page_bytes += bytes.len() + 1;
                                resources.push(projected);
                            }
                        }
                        total += 1;
                    }
                    drop(rows);
                    drop(statement);
                    tx.rollback()?;
                    hash.update(b"]");
                    let next = offset.saturating_add(resources.len() as u64);
                    Ok(ShellResourcePage {
                        resources,
                        revision: format!("sha256:{}", hex::encode(hash.finalize())),
                        total,
                        next_offset: (next < total).then_some(next),
                    })
                }
            })
            .await
    }
}
