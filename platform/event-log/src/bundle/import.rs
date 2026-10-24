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
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::Connection;
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
        self.validate_root()?;
        let (digest, binding) = (digest.to_owned(), binding_fingerprint.to_owned());
        self.connection
            .run(move |db| Box::pin(async move { receipt(db, &digest, &binding).await }))
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
        self.validate_root()?;
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
        self.connection
            .run(move |db| {
                Box::pin(async move {
                    let result = async {
                        let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
                        if let Some(receipt) =
                            receipt(&mut tx, &staged.summary.digest, &binding_digest).await?
                        {
                            return Ok(receipt);
                        }
                        collision::check(&mut staged.database, &mut tx).await?;
                        let offset = crate::sequence_number(
                            sqlx::query_scalar::<_, i64>(
                                "SELECT COALESCE(MAX(sequence),0) FROM event_log",
                            )
                            .fetch_one(&mut *tx)
                            .await?,
                        )?;
                        let positions = Positions::read(&mut staged.database, offset).await?;
                        let mut relocated =
                            super::validation::prepare(&mut staged.database, Some(&positions))
                                .await?;
                        let receipt = ImportReceipt {
                            bundle_digest: staged.summary.digest.clone(),
                            root_session_id: staged.summary.inventory.root_session_id.clone(),
                            session_ids: staged
                                .summary
                                .inventory
                                .sessions
                                .iter()
                                .map(|s| s.id.clone())
                                .collect(),
                        };
                        let published = publish::all(
                            &mut tx,
                            &mut staged.database,
                            &mut relocated,
                            &receipt,
                            &binding_digest,
                            &configurations,
                            &positions,
                        )
                        .await;
                        relocated.close().await?;
                        published?;
                        tx.commit().await.map_err(StoreError::CommitUnknown)?;
                        commits.publish(positions.high_water());
                        Ok(receipt)
                    }
                    .await;
                    let closed = staged.database.close().await;
                    // A close failure after commit is recoverable by the same receipt;
                    // it cannot trigger a second publication.
                    match (result, closed) {
                        (Ok(receipt), Ok(())) => Ok(receipt),
                        (Err(error), _) => Err(error),
                        (_, Err(error)) => Err(error.into()),
                    }
                })
            })
            .await
            .map_err(Into::into)
    }
}

fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}

async fn receipt(
    db: &mut sqlx::SqliteConnection,
    digest: &str,
    binding: &str,
) -> Result<Option<ImportReceipt>, StoreError> {
    let prior: Option<(String, String)> = sqlx::query_as(
        "SELECT binding_digest,receipt_json FROM session_bundle_imports WHERE digest=?",
    )
    .bind(digest)
    .fetch_optional(db)
    .await?;
    prior
        .map(|(expected, json)| {
            if expected != binding {
                return Err(StoreError::SessionConflict);
            }
            serde_json::from_str(&json).map_err(Into::into)
        })
        .transpose()
}
