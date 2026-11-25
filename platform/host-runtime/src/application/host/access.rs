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

//! Credentials grant the exact published application source and endpoint set.
use super::{Host, PeerId, Result, Session};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use maka_agent_facts::access::ManagedPrincipalKind;
use maka_config::access::{AccessCreateMode, AccessCredential, CredentialState};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, sync::Arc};
use tokio::sync::broadcast;
use uuid::Uuid;

pub(super) enum Authority {
    Local,
    Remote { hash: String },
    AuthenticatedPeer { peer_id: PeerId },
}
impl Authority {
    pub(super) fn local(&self) -> Result<()> {
        matches!(self, Self::Local)
            .then_some(())
            .ok_or("Host control requires the local owner".into())
    }
}
#[derive(PartialEq, Eq)]
pub(super) enum Principal {
    Local,
    Credential(String),
    AuthenticatedPeer(PeerId),
}
/// Intended only for the importing client; never logged or formatted as Debug.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pairing {
    pub root_id: String,
    pub credential_id: String,
    pub credential: String,
}
pub(super) fn now() -> Result<u64> {
    u64::try_from(time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000)
        .map_err(|_| "clock precedes Unix epoch".into())
}
fn timestamp() -> Result<String> {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|error| error.to_string())
}
impl Session {
    fn revoke(&self) {
        self.peer.revoke();
        self.transport.request_close();
    }
}

impl Host {
    pub(super) async fn credential(&self, hash: &str) -> Result<AccessCredential> {
        self.access
            .authenticate_access_credential(hash.into(), now()?)
            .await
            .map_err(|error| error.to_string())?
            .filter(|value| {
                value.principal_kind == ManagedPrincipalKind::RemoteOwner
                    && value.grants.contains(&*self.access_grant.lock().unwrap())
            })
            .ok_or("credential does not grant this application source".into())
    }
    /// Call while holding access_gate through admission to close revocation races.
    pub(super) async fn identify(
        &self,
        authority: &Authority,
        client: Option<&str>,
    ) -> Result<Principal> {
        match authority {
            Authority::Local => Ok(Principal::Local),
            Authority::AuthenticatedPeer { peer_id } => {
                let grant = self.access_grant.lock().unwrap().clone();
                if !self
                    .access
                    .has_host_peer_access(peer_id.clone(), grant)
                    .await
                    .map_err(|error| error.to_string())?
                {
                    return Err("transport peer does not grant this application source".into());
                }
                Ok(Principal::AuthenticatedPeer(peer_id.clone()))
            }
            Authority::Remote { hash } => {
                let credential = self.credential(hash).await?;
                let client = client
                    .filter(|value| !value.is_empty())
                    .ok_or("remote client identity required")?;
                if !matches!(credential.state, CredentialState::Active { .. })
                    || credential.client_instance_id() != Some(client)
                {
                    return Err(
                        "finalize pairing with this client identity before opening a session"
                            .into(),
                    );
                }
                Ok(Principal::Credential(credential.credential_id))
            }
        }
    }
    fn revoked(&self, credentials: &[String]) {
        self.revoke_sessions(
            |principal| matches!(principal, Principal::Credential(id) if credentials.contains(id)),
        )
    }

    fn revoke_sessions(&self, revoked: impl Fn(&Principal) -> bool) {
        for session in self.sessions.lock().unwrap().values() {
            if revoked(&session.principal) {
                session.revoke();
            }
        }
    }

    /// Call under access_gate before publishing a different Host grant.
    pub(super) fn revoke_native_sessions(&self) {
        let peers = {
            let sessions = self.sessions.lock().unwrap();
            let mut peers = BTreeSet::new();
            for session in sessions.values() {
                if let Principal::AuthenticatedPeer(id) = &session.principal {
                    session.revoke();
                    peers.insert(id.clone());
                }
            }
            peers
        };
        for id in peers {
            let _ = self.revoked_peers.send(id);
        }
    }

    /// Trusted embedding only; grants this peer the current Host publication.
    pub async fn grant_peer_access(&self, peer_id: PeerId) -> Result<()> {
        let _gate = self.access_gate.lock().await;
        if self.stop.is_cancelled() {
            return Err("Host is closing".into());
        }
        let grant = self.access_grant.lock().unwrap().clone();
        self.access
            .grant_host_peer_access(peer_id, grant)
            .await
            .map_err(|error| error.to_string())
    }

    /// Subscribe before accepting authenticated transports. Close the named
    /// connection(s) on revocation. On `Lagged`, close all peer connections:
    /// their underlying transports may otherwise outlive a missed revocation.
    pub fn subscribe_revoked_peers(&self) -> broadcast::Receiver<PeerId> {
        self.revoked_peers.subscribe()
    }

    /// Trusted embedding only; removes the grant and fences all live sessions.
    pub async fn revoke_peer_access(self: &Arc<Self>, peer_id: PeerId) -> Result<bool> {
        let host = self.clone();
        // The durable mutation and live fence must finish together even if
        // the caller drops its acknowledgement future.
        tokio::spawn(async move {
            let _gate = host.access_gate.lock().await;
            let changed = host
                .access
                .revoke_host_peer_access(peer_id.clone())
                .await
                .map_err(|error| error.to_string())?;
            if changed {
                host.revoke_sessions(|principal| {
                    matches!(principal, Principal::AuthenticatedPeer(id) if id == &peer_id)
                });
                let _ = host.revoked_peers.send(peer_id);
            }
            Ok(changed)
        })
        .await
        .map_err(|error| error.to_string())?
    }

    pub async fn prepare_access(&self, principal: String) -> Result<Pairing> {
        let _gate = self.access_gate.lock().await;
        if self.stop.is_cancelled() {
            return Err("Host is closing".into());
        }
        let expired = self
            .access
            .expire_access_credentials(now()?)
            .await
            .map_err(|error| error.to_string())?;
        self.revoked(&expired);
        let mut bytes = [0; 32];
        getrandom::fill(&mut bytes).map_err(|_| "cannot generate access credential")?;
        let secret = format!("maka_rh_{}", URL_SAFE_NO_PAD.encode(bytes));
        let credential_id = Uuid::new_v4().to_string();
        let credential = AccessCredential {
            credential_id: credential_id.clone(),
            credential_hash: hex::encode(Sha256::digest(secret.as_bytes())),
            principal_id: principal,
            principal_kind: ManagedPrincipalKind::RemoteOwner,
            grants: vec![
                self.access_grant.lock().unwrap().clone(),
                "access.credential.finalize".into(),
            ],
            can_publish_client_capabilities: false,
            can_use_host_paths: false,
            created_at: timestamp()?,
            state: CredentialState::Pending {
                expires_at: now()?
                    .checked_add(15 * 60 * 1000)
                    .ok_or("credential expiry overflow")?,
                bind_client_instance: true,
            },
            capability_owner: None,
        };
        let changed = self
            .access
            .create_access_credential(credential, AccessCreateMode::Prepare, None)
            .await
            .map_err(|error| error.to_string())?;
        self.revoked(&changed.revoked);
        Ok(Pairing {
            root_id: self.source.state_domain.clone(),
            credential_id,
            credential: secret,
        })
    }
    pub async fn revoke_access(&self, credential: String) -> Result<bool> {
        let _gate = self.access_gate.lock().await;
        let changed = self
            .access
            .revoke_access_credential(credential, timestamp()?)
            .await
            .map_err(|error| error.to_string())?;
        self.revoked(&changed.revoked);
        Ok(changed.value)
    }
    pub(super) async fn finalize_access(
        &self,
        authority: &Authority,
        client: Option<String>,
    ) -> Result<()> {
        let Authority::Remote { hash } = authority else {
            return Err("pairing requires the remote credential".into());
        };
        let _gate = self.access_gate.lock().await;
        let credential = self.credential(hash).await?;
        let changed = self
            .access
            .finalize_access_credential(
                credential.credential_id.clone(),
                client.ok_or("client identity required")?,
                credential.client_instance_id().map(str::to_owned),
                now()?,
            )
            .await
            .map_err(|error| error.to_string())?;
        self.revoked(&changed.revoked);
        Ok(())
    }
}
