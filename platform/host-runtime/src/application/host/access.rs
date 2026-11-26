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
use maka_config::access::{
    AccessCreateMode, AccessCredential, CredentialState, HostPeerAccess, NewHostPeerPairingInvite,
};
use maka_remote_pairing::{PairingTicketPayload, RelayEndpoint, SignedPairingTicket};
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
                if !self.peer_has_current_grant(peer_id).await? {
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

    /// Check whether a transport's pairing window can end without closing it.
    pub async fn has_peer_access(&self, peer_id: &PeerId) -> Result<bool> {
        let _gate = self.access_gate.lock().await;
        self.peer_has_current_grant(peer_id).await
    }

    async fn peer_has_current_grant(&self, peer_id: &PeerId) -> Result<bool> {
        let grant = self.access_grant.lock().unwrap().clone();
        self.access
            .has_host_peer_access(peer_id.clone(), grant)
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

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerPairingInvite {
    pub uri: String,
    pub host_peer_id: String,
    pub root_id: String,
    pub invite_id: String,
    pub expires_at_ms: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PeerPairingOptions {
    pub host_name: String,
    pub label: Option<String>,
    pub ttl_secs: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerPairingReceipt {
    pub root_id: String,
    pub peer_id: String,
}

impl Host {
    /// Replace the active public routes. Transport authentication stays with the adapter.
    /// An empty list withdraws all routes and disables invite issuance.
    pub fn set_native_relays(&self, relays: Vec<RelayEndpoint>) -> Result<()> {
        for relay in &relays {
            relay.validate().map_err(|error| error.to_string())?;
        }
        *self.native_relays.lock().unwrap() = relays;
        Ok(())
    }

    pub fn native_relays(&self) -> Vec<RelayEndpoint> {
        self.native_relays.lock().unwrap().clone()
    }

    pub async fn prepare_peer_pairing(
        &self,
        options: PeerPairingOptions,
    ) -> Result<PeerPairingInvite> {
        let _gate = self.access_gate.lock().await;
        if self.stop.is_cancelled() {
            return Err("Host is closing".into());
        }
        let relays = self.native_relays();
        if relays.is_empty() {
            return Err("running Host has no active native relay routes; connect it to a native relay before issuing an invite".into());
        }
        let ttl = options.ttl_secs.unwrap_or(300);
        if ttl == 0 {
            return Err("pairing invite TTL must be positive".into());
        }
        let now_ms = now()?;
        let expires_at_ms = ttl
            .checked_mul(1_000)
            .and_then(|ttl_ms| now_ms.checked_add(ttl_ms))
            .ok_or("pairing invite expiry overflow")?;
        let mut bytes = [0; 32];
        getrandom::fill(&mut bytes).map_err(|_| "cannot generate pairing invite")?;
        let invite_secret = format!("maka_pi_{}", URL_SAFE_NO_PAD.encode(bytes));
        let ticket = SignedPairingTicket::sign(
            PairingTicketPayload {
                version: 1,
                root_id: self.root_id().into(),
                host_name: options.host_name,
                host_peer_id: self.identity.public_key().to_string(),
                relays,
                direct_endpoints: Vec::new(),
                invite_id: Uuid::new_v4().to_string(),
                invite_secret,
                expires_at_ms,
            },
            &self.identity,
        )
        .map_err(|error| error.to_string())?;
        let uri = ticket.to_uri().map_err(|error| error.to_string())?;
        let payload = ticket.payload();
        let host_grant = self.access_grant.lock().unwrap().clone();
        self.access
            .create_host_peer_pairing_invite(
                NewHostPeerPairingInvite {
                    invite_id: payload.invite_id.clone(),
                    secret_hash: Sha256::digest(payload.invite_secret.as_bytes()).into(),
                    host_grant,
                    label: options.label,
                    expires_at_ms,
                    created_at: timestamp()?,
                },
                now_ms,
            )
            .await
            .map_err(|error| error.to_string())?;
        Ok(PeerPairingInvite {
            uri,
            host_peer_id: payload.host_peer_id.clone(),
            root_id: payload.root_id.clone(),
            invite_id: payload.invite_id.clone(),
            expires_at_ms,
        })
    }

    pub async fn list_peer_access(&self) -> Result<Vec<HostPeerAccess>> {
        let _gate = self.access_gate.lock().await;
        let grant = self.access_grant.lock().unwrap().clone();
        let mut peers = self
            .access
            .list_host_peer_access()
            .await
            .map_err(|error| error.to_string())?;
        peers.retain(|peer| peer.grant == grant);
        Ok(peers)
    }

    pub(super) async fn redeem_peer_pairing(
        &self,
        authority: &Authority,
        invite_secret: String,
        device_label: Option<String>,
    ) -> Result<PeerPairingReceipt> {
        let Authority::AuthenticatedPeer { peer_id } = authority else {
            return Err("pairing requires an authenticated native peer".into());
        };
        maka_remote_pairing::parse_peer_id(peer_id.as_str()).map_err(|error| error.to_string())?;
        let hash = Sha256::digest(invite_secret.as_bytes()).into();
        let _gate = self.access_gate.lock().await;
        if self.stop.is_cancelled() {
            return Err("Host is closing".into());
        }
        let grant = self.access_grant.lock().unwrap().clone();
        if !self
            .access
            .redeem_host_peer_pairing_invite(hash, peer_id.clone(), grant, device_label)
            .await
            .map_err(|error| error.to_string())?
        {
            return Err("pairing invite is invalid, expired, or already redeemed".into());
        }
        Ok(PeerPairingReceipt {
            root_id: self.root_id().into(),
            peer_id: peer_id.as_str().into(),
        })
    }
}
