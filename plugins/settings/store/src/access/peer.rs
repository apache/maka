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

use super::record::invalid;
use crate::{ConfigurationStore, Result, TransactionMode};
use rusqlite::params;

/// Canonical identity of the remote endpoint, as named by its transport.
/// Constructing this value does not authenticate the endpoint.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct PeerId(String);

impl PeerId {
    pub fn new(id: String) -> Result<Self> {
        if id.is_empty() {
            return Err(invalid("empty transport peer identity"));
        }
        Ok(Self(id))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl ConfigurationStore {
    pub async fn grant_host_peer_access(&self, peer: PeerId, host_grant: String) -> Result<()> {
        self.transaction(TransactionMode::Immediate, move |tx| {
            tx.prepare_cached(
                "INSERT INTO host_peer_access (peer_id, host_grant) VALUES (?, ?)
                 ON CONFLICT (peer_id) DO UPDATE SET host_grant = excluded.host_grant",
            )?
            .execute(params![peer.as_str(), host_grant])?;
            Ok(())
        })
        .await
    }

    pub async fn has_host_peer_access(&self, peer: PeerId, host_grant: String) -> Result<bool> {
        self.transaction(TransactionMode::Deferred, move |tx| {
            Ok(tx
                .prepare_cached(
                    "SELECT EXISTS(SELECT 1 FROM host_peer_access WHERE peer_id = ? AND host_grant = ?)",
                )?
                .query_row(params![peer.as_str(), host_grant], |row| row.get(0))?)
        })
        .await
    }

    pub async fn revoke_host_peer_access(&self, peer: PeerId) -> Result<bool> {
        self.transaction(TransactionMode::Immediate, move |tx| {
            Ok(tx
                .prepare_cached("DELETE FROM host_peer_access WHERE peer_id = ?")?
                .execute(params![peer.as_str()])?
                != 0)
        })
        .await
    }
}
