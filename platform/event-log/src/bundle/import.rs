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

use super::{BundleError, StagedBundle, relocation::Positions};
use crate::{EventLog, StoreError};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

mod collision;
mod publish;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportReceipt {
    pub bundle_digest: String,
    pub root_session_id: String,
    pub session_ids: Vec<String>,
}

impl EventLog {
    /// Probe the durable receipt before resolving current destination defaults.
    pub async fn bundle_import_receipt(
        &self,
        digest: &str,
        binding_fingerprint: &str,
    ) -> Result<Option<ImportReceipt>, StoreError> {
        let (digest, binding) = (digest.to_owned(), binding_fingerprint.to_owned());
        self.connection
            .read(move |db| receipt(db, &digest, &binding))
            .await
    }

    /// The caller authorizes every destination configuration. Source configuration
    /// is historical metadata, never a grant or destination execution policy.
    /// The fingerprint identifies the caller's binding request, not mutable Host defaults.
    pub async fn import_bundle<T: Serialize + Send + 'static>(
        &self,
        mut staged: StagedBundle,
        binding_fingerprint: &str,
        configurations: BTreeMap<String, T>,
    ) -> Result<ImportReceipt, BundleError> {
        if !maka_agent_facts::archive::valid_projection_digest(binding_fingerprint) {
            return Err(invalid("invalid bundle binding fingerprint").into());
        }
        let binding_digest = binding_fingerprint.to_owned();
        let configurations: BTreeMap<String, Value> = configurations
            .into_iter()
            .map(|(id, config)| Ok((id, serde_json::to_value(config)?)))
            .collect::<Result<_, serde_json::Error>>()
            .map_err(StoreError::from)?;
        if configurations
            .keys()
            .ne(staged.summary.inventory.sessions.iter().map(|s| &s.id))
        {
            return Err(invalid("bundle destination bindings differ from its inventory").into());
        }
        // Never repair hashes of unvalidated source history.
        staged.validate_history().await?;
        let commits = self
            .commits
            .sessions(configurations.keys().map(String::as_str));
        let source = staged.database.into_temporary_connection().await?;
        let summary = staged.summary;
        self.connection
            .run(move |db| {
                let result = (|| {
                    let tx = rusqlite::Transaction::new_unchecked(
                        db,
                        rusqlite::TransactionBehavior::Immediate,
                    )?;
                    if let Some(receipt) = receipt(&tx, &summary.digest, &binding_digest)? {
                        return Ok(receipt);
                    }
                    collision::check(&source, &tx)?;
                    let offset = crate::sequence_number(tx.query_row(
                        "SELECT COALESCE(MAX(sequence),0) FROM event_log",
                        [],
                        |row| row.get(0),
                    )?)?;
                    let positions = Positions::read(&source, offset)?;
                    let relocated = super::validation::prepare(&source, Some(&positions))?;
                    let receipt = ImportReceipt {
                        bundle_digest: summary.digest,
                        root_session_id: summary.inventory.root_session_id,
                        session_ids: summary
                            .inventory
                            .sessions
                            .into_iter()
                            .map(|s| s.id)
                            .collect(),
                    };
                    let published = publish::all(
                        &tx,
                        &source,
                        &relocated,
                        &receipt,
                        &binding_digest,
                        &configurations,
                        &positions,
                    );
                    relocated
                        .close()
                        .map_err(|(_, error)| StoreError::from(error))?;
                    published?;
                    tx.commit().map_err(StoreError::CommitUnknown)?;
                    commits.publish(positions.high_water());
                    Ok(receipt)
                })();
                let closed = source.close().map_err(|(_, error)| StoreError::from(error));
                match (result, closed) {
                    (Ok(receipt), Ok(())) => Ok(receipt),
                    (Err(error), _) | (_, Err(error)) => Err(error),
                }
            })
            .await
            .map_err(Into::into)
    }
}

fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}

fn receipt(
    db: &rusqlite::Connection,
    digest: &str,
    binding: &str,
) -> Result<Option<ImportReceipt>, StoreError> {
    let prior: Option<(String, String)> = db
        .prepare_cached(
            "SELECT binding_digest,receipt_json FROM session_bundle_imports WHERE digest=?",
        )?
        .query_row(rusqlite::params![digest], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .optional()?;
    prior
        .map(|(expected, json)| {
            if expected != binding {
                return Err(StoreError::SessionConflict);
            }
            serde_json::from_str(&json).map_err(Into::into)
        })
        .transpose()
}
