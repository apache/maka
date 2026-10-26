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

//! Native Session transfer. Inventory is an observation, never an export fence
//! or permission to import the source Host's work and grants.

use crate::{EventLog, StoreError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Connection, SqliteConnection};
use std::collections::HashSet;

mod accounting;
mod blobs;
mod closure;
mod export;
mod format;
mod import;
pub use import::ImportReceipt;
mod reader;
mod relocation;
mod stage;
mod validation;
pub use export::BundleSummary;
pub use reader::inspect;
pub use stage::StagedBundle;

#[derive(Debug, thiserror::Error)]
pub enum BundleError {
    #[error("the confirmed Session subtree changed")]
    CandidateSetStale,
    #[error(transparent)]
    Store(#[from] StoreError),
}

/// Exact, sorted catalog membership observed with all revisions in one snapshot.
/// Historical dependencies outside this set are not additional catalog Sessions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Inventory {
    pub root_session_id: String,
    pub subtree_digest: String,
    pub sessions: Vec<Session>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Session {
    pub id: String,
    pub revision: u64,
}

impl EventLog {
    /// Preview only. Export must resolve this again inside its material snapshot;
    /// this result cannot authorize a later read or reserve a mutable subtree.
    pub async fn preview_bundle(&self, root: &str) -> Result<Inventory, BundleError> {
        self.validate_root()?;
        crate::sessions::validate_id(root)?;
        let root = root.to_owned();
        self.connection
            .read(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    let result = inventory(&mut tx, &root).await;
                    tx.rollback().await?;
                    Ok(result)
                })
            })
            .await?
    }
}

impl Inventory {
    pub fn verify_confirmation(&self, expected: &str) -> Result<(), BundleError> {
        if self.subtree_digest == expected {
            Ok(())
        } else {
            Err(BundleError::CandidateSetStale)
        }
    }
}

async fn inventory(
    connection: &mut SqliteConnection,
    root: &str,
) -> Result<Inventory, BundleError> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM session_control WHERE id=? AND NOT EXISTS(
            SELECT 1 FROM session_retirements WHERE session_id=id AND remove_session=1))",
    )
    .bind(root)
    .fetch_one(&mut *connection)
    .await
    .map_err(StoreError::from)?;
    if !exists {
        return Err(StoreError::SessionNotFound.into());
    }
    let mut seen = HashSet::from([root.to_owned()]);
    let mut frontier = vec![root.to_owned()];
    while !frontier.is_empty() {
        // Deduplicate all parent-edge kinds before expanding the next frontier.
        let children: Vec<String> = sqlx::query_scalar(
            "SELECT live.id FROM session_history_copies c
               JOIN session_control live ON live.id=c.session_id
             WHERE c.source_session_id IN (SELECT value FROM json_each(?1))
               AND NOT EXISTS(SELECT 1 FROM session_retirements
                 WHERE session_id=live.id AND remove_session=1)
             UNION ALL
             SELECT live.id FROM plugin_sessions p
               JOIN session_control live ON live.id=p.session_id
             WHERE p.authority_session_id IN (SELECT value FROM json_each(?1))
               AND NOT EXISTS(SELECT 1 FROM session_retirements
                 WHERE session_id=live.id AND remove_session=1)
             UNION ALL
             SELECT live.id FROM session_bundle_members b
               JOIN session_control live ON live.id=b.session_id
             WHERE b.parent_session_id IN (SELECT value FROM json_each(?1))
               AND NOT EXISTS(SELECT 1 FROM session_retirements
                 WHERE session_id=live.id AND remove_session=1)
",
        )
        .bind(serde_json::to_string(&frontier).map_err(StoreError::from)?)
        .fetch_all(&mut *connection)
        .await
        .map_err(StoreError::from)?;
        frontier.clear();
        for id in children {
            if seen.insert(id.clone()) {
                frontier.push(id);
            }
        }
    }
    // Session IDs are ASCII; this also matches Desktop's confirmation ordering.
    let mut rows: Vec<_> = seen.into_iter().collect();
    rows.sort_unstable();
    let mut digest = Sha256::new();
    let mut sessions = Vec::with_capacity(rows.len());
    for id in rows {
        if !sessions.is_empty() {
            digest.update(b"\n");
        }
        digest.update(id.as_bytes());
        let revision = crate::workspace_bindings::current_session_revision(connection, &id)
            .await?
            .ok_or(StoreError::SessionNotFound)?;
        sessions.push(Session { id, revision });
    }
    Ok(Inventory {
        root_session_id: root.into(),
        subtree_digest: hex::encode(digest.finalize()),
        sessions,
    })
}
