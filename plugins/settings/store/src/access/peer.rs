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
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

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

    pub async fn record_host_peer_activity(
        &self,
        peer: PeerId,
        host_grant: String,
        at: String,
    ) -> Result<bool> {
        self.transaction(TransactionMode::Immediate, move |tx| {
            Ok(tx.prepare_cached(
                "UPDATE host_peer_access SET last_active_at = ? WHERE peer_id = ? AND host_grant = ?",
            )?.execute(params![at, peer.as_str(), host_grant])? != 0)
        }).await
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

pub struct NewHostPeerPairingInvite {
    pub invite_id: String,
    pub secret_hash: [u8; 32],
    pub host_grant: String,
    pub label: Option<String>,
    pub expires_at_ms: u64,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostPeerAccess {
    pub peer_id: String,
    pub grant: String,
    pub label: String,
    pub created_at: String,
    pub last_active_at: Option<String>,
}

fn sqlite_ms(ms: u64) -> Result<i64> {
    i64::try_from(ms).map_err(|_| invalid("pairing timestamp overflows SQLite INTEGER"))
}

impl ConfigurationStore {
    pub async fn create_host_peer_pairing_invite(
        &self,
        invite: NewHostPeerPairingInvite,
        now_ms: u64,
    ) -> Result<()> {
        let expires_at = sqlite_ms(invite.expires_at_ms)?;
        let now_ms = sqlite_ms(now_ms)?;
        if expires_at <= now_ms {
            return Err(invalid("pairing invite must expire in the future"));
        }
        self.transaction(TransactionMode::Immediate, move |tx| {
            tx.prepare_cached("DELETE FROM host_peer_pairing_invites WHERE expires_at_ms <= ?")?
                .execute([now_ms])?;
            tx.prepare_cached(
                "INSERT INTO host_peer_pairing_invites
                   (invite_id, secret_hash, host_grant, label, expires_at_ms, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)",
            )?
            .execute(params![
                invite.invite_id,
                invite.secret_hash.as_slice(),
                invite.host_grant,
                invite.label,
                expires_at,
                invite.created_at,
            ])?;
            Ok(())
        })
        .await
    }

    pub async fn redeem_host_peer_pairing_invite(
        &self,
        secret_hash: [u8; 32],
        peer: PeerId,
        expected_grant: String,
        device_label: Option<String>,
    ) -> Result<bool> {
        if device_label.as_ref().is_some_and(|label| label.len() > 128) {
            return Err(invalid("device label must be at most 128 bytes"));
        }
        self.transaction(TransactionMode::Immediate, move |tx| {
            let now = OffsetDateTime::now_utc();
            let now_ms = u64::try_from(now.unix_timestamp_nanos().div_euclid(1_000_000))
                .map_err(|_| invalid("pairing timestamp is outside the Unix clock range"))?;
            let now_ms = sqlite_ms(now_ms)?;
            let label = tx
                .prepare_cached(
                    "DELETE FROM host_peer_pairing_invites
                     WHERE secret_hash = ? AND host_grant = ? AND expires_at_ms > ?
                     RETURNING label",
                )?
                .query_row(
                    params![secret_hash.as_slice(), expected_grant, now_ms],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?;
            let Some(label) = label else {
                return Ok(false);
            };
            let created_at = now
                .format(&Rfc3339)
                .map_err(|error| invalid(&error.to_string()))?;
            tx.prepare_cached(
                "INSERT INTO host_peer_access (peer_id, host_grant, label, created_at, last_active_at)
                 VALUES (?1, ?2, ?3, ?4, ?4)
                 ON CONFLICT (peer_id) DO UPDATE SET
                    host_grant = excluded.host_grant, label = excluded.label,
                    created_at = excluded.created_at, last_active_at = excluded.last_active_at",
            )?
            .execute(params![
                peer.as_str(),
                expected_grant,
                label.or(device_label).unwrap_or_default(),
                created_at,
            ])?;
            Ok(true)
        })
        .await
    }

    pub async fn list_host_peer_access(&self) -> Result<Vec<HostPeerAccess>> {
        self.transaction(TransactionMode::Deferred, |tx| {
            Ok(tx
                .prepare_cached(
                    "SELECT peer_id, host_grant, label, created_at, last_active_at
                     FROM host_peer_access ORDER BY peer_id",
                )?
                .query_map([], |row| {
                    Ok(HostPeerAccess {
                        peer_id: row.get(0)?,
                        grant: row.get(1)?,
                        label: row.get(2)?,
                        created_at: row.get(3)?,
                        last_active_at: row.get(4)?,
                    })
                })?
                .collect::<rusqlite::Result<_>>()?)
        })
        .await
    }

    pub async fn prune_host_peer_pairing_invites(&self, current_grant: String) -> Result<()> {
        self.transaction(TransactionMode::Immediate, move |tx| {
            tx.execute(
                "DELETE FROM host_peer_pairing_invites WHERE host_grant <> ?",
                [current_grant],
            )?;
            Ok(())
        })
        .await
    }
}
