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

use crate::{ConfigError, Result};
use maka_agent_facts::access::CapabilityOwnerIdentity;
use maka_agent_facts::access::ManagedPrincipalKind;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CredentialState {
    Active {
        client_instance_id: Option<String>,
    },
    Pending {
        expires_at: u64,
        bind_client_instance: bool,
    },
    Revoked {
        revoked_at: String,
    },
}
/// Raw grants remain open so older builds cannot erase future grants.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccessCredential {
    pub credential_id: String,
    pub credential_hash: String,
    pub principal_id: String,
    pub principal_kind: ManagedPrincipalKind,
    pub grants: Vec<String>,
    pub can_publish_client_capabilities: bool,
    pub can_use_host_paths: bool,
    pub created_at: String,
    pub state: CredentialState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capability_owner: Option<CapabilityOwnerIdentity>,
}
impl AccessCredential {
    pub fn client_instance_id(&self) -> Option<&str> {
        match &self.state {
            CredentialState::Active { client_instance_id } => client_instance_id.as_deref(),
            _ => None,
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessCreateMode {
    Issue,
    Replace,
    Prepare,
}
pub struct AccessChange<T> {
    pub value: T,
    /// Returned only after the enclosing transaction commits.
    pub revoked: Vec<String>,
}
pub(super) fn invalid(message: &str) -> ConfigError {
    ConfigError::Invalid(message.into())
}
pub(super) fn valid_client(value: &str) -> bool {
    !value.is_empty()
}
fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.:-".contains(&c))
}
pub(super) fn validate(value: &AccessCredential) -> Result<()> {
    let date = |s: &str| !s.is_empty();
    let state_valid = match &value.state {
        CredentialState::Active { client_instance_id } => {
            client_instance_id.as_deref().is_none_or(valid_client)
                && (client_instance_id.is_none()
                    || value.principal_kind == ManagedPrincipalKind::RemoteOwner)
        }
        CredentialState::Pending { expires_at, .. } => {
            // JavaScript Date's supported Unix millisecond range.
            *expires_at <= 8_640_000_000_000_000
                && value.principal_kind == ManagedPrincipalKind::RemoteOwner
                && value
                    .grants
                    .iter()
                    .any(|g| g == "access.credential.finalize")
        }
        CredentialState::Revoked { revoked_at } => date(revoked_at),
    };
    if !valid_id(&value.credential_id)
        || !valid_id(&value.principal_id)
        || value.credential_hash.len() != 64
        || !value
            .credential_hash
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        || value.grants.iter().any(|g| g.is_empty())
        || value
            .grants
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != value.grants.len()
        || !date(&value.created_at)
        || !state_valid
        || value.capability_owner.as_ref().is_some_and(|o| {
            value.principal_kind != ManagedPrincipalKind::CapabilityProvider
                || !valid_id(&o.principal_id)
                || !valid_client(&o.client_instance_id)
        })
    {
        return Err(invalid("invalid access credential record"));
    }
    Ok(())
}
pub(super) fn load(tx: &Connection) -> Result<Vec<AccessCredential>> {
    let documents: Vec<String> = tx
        .prepare_cached("SELECT document FROM access_credentials ORDER BY credential_id")?
        .query_map(rusqlite::params![], |row| row.get(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    documents
        .iter()
        .map(|s| {
            let c = serde_json::from_str(s)?;
            validate(&c)?;
            Ok(c)
        })
        .collect()
}
/// Replaces the private document set inside the caller's immediate transaction.
pub(super) fn save(tx: &Connection, records: &[AccessCredential]) -> Result<()> {
    let documents: Vec<String> = records
        .iter()
        .map(|c| {
            validate(c)?;
            Ok(serde_json::to_string(c)?)
        })
        .collect::<Result<_>>()?;
    tx.execute("DELETE FROM access_credentials", rusqlite::params![])?;
    for document in documents {
        tx.execute(
            "INSERT INTO access_credentials (document) VALUES (?)",
            rusqlite::params![document],
        )?;
    }
    Ok(())
}
pub(super) fn same_principal(a: &AccessCredential, b: &AccessCredential) -> bool {
    a.principal_kind == b.principal_kind && a.principal_id == b.principal_id
}
