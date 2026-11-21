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

//! Signed peer reachability leases and monotonic anti-rollback receipt cache.

use crate::identity::{IdentityError, NodeIdentity, PeerId, verify_signature};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};
use thiserror::Error;
use uuid::Uuid;

pub const DEFAULT_LEASE_TTL_MS: u64 = 5 * 60 * 1000;
pub const MAX_LEASE_LIFETIME_MS: u64 = 10 * 60 * 1000;
pub const MAX_CLOCK_SKEW_MS: u64 = 2 * 60 * 1000;
pub const MAX_RECOVERY_HORIZON_MS: u64 = 24 * 60 * 60 * 1000;
pub const MAX_ROUTES_PER_CLASS: usize = 16;
pub const MAX_SIGNED_LEASE_BYTES: usize = 48 * 1024;
const LEASE_SIGNING_DOMAIN: &[u8] = b"maka-peer-reachability-lease-v1\n";

#[derive(Debug, Error)]
pub enum LeaseError {
    #[error("signed reachability lease exceeds {MAX_SIGNED_LEASE_BYTES} bytes ({0} bytes)")]
    PayloadTooLarge(usize),
    #[error("reachability lease rootId must not be empty")]
    EmptyRootId,
    #[error("reachability lease epoch must not be nil")]
    NilEpoch,
    #[error("reachability lease must advertise at least one direct or relay route")]
    NoRoutes,
    #[error("reachability lease exceeds {MAX_ROUTES_PER_CLASS} routes in {class} ({count})")]
    TooManyRoutes {
        class: &'static str,
        count: usize,
    },
    #[error("reachability route endpoint must not be empty")]
    EmptyEndpoint,
    #[error("relay route cannot use target peer `{0}` as its own relay")]
    SelfRelay(PeerId),
    #[error("reachability lease expiresAtMs ({expires_at_ms}) must be greater than issuedAtMs ({issued_at_ms})")]
    InvalidLifetimeOrder {
        issued_at_ms: u64,
        expires_at_ms: u64,
    },
    #[error("reachability lease lifetime ({lifetime_ms}ms) exceeds maximum ({MAX_LEASE_LIFETIME_MS}ms)")]
    LifetimeTooLong { lifetime_ms: u64 },
    #[error("reachability lease issuedAtMs ({issued_at_ms}) exceeds clock skew (now={now_ms})")]
    IssuedInFuture { issued_at_ms: u64, now_ms: u64 },
    #[error("reachability lease expired at {expires_at_ms} (now={now_ms})")]
    Expired { expires_at_ms: u64, now_ms: u64 },
    #[error("reachability lease revision rollback: current={current}, incoming={incoming}")]
    RevisionRollback { current: u64, incoming: u64 },
    #[error("conflicting reachability lease with identical revision {0}")]
    ConflictingEqualRevision(u64),
    #[error("lease identity verification failed: {0}")]
    Identity(#[from] IdentityError),
    #[error("lease JSON serialization failed: {0}")]
    Serialization(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DirectTransport {
    Quic,
    WebSocket,
    WebRtc,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawDirectRoute {
    transport: DirectTransport,
    endpoint: String,
    priority: u16,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "RawDirectRoute", into = "RawDirectRoute")]
pub struct DirectRoute {
    transport: DirectTransport,
    endpoint: String,
    priority: u16,
}

impl DirectRoute {
    pub fn new(
        transport: DirectTransport,
        endpoint: impl Into<String>,
        priority: u16,
    ) -> Result<Self, LeaseError> {
        let endpoint = endpoint.into();
        if endpoint.is_empty() {
            return Err(LeaseError::EmptyEndpoint);
        }
        Ok(Self {
            transport,
            endpoint,
            priority,
        })
    }

    pub fn transport(&self) -> DirectTransport {
        self.transport
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub fn priority(&self) -> u16 {
        self.priority
    }
}

impl TryFrom<RawDirectRoute> for DirectRoute {
    type Error = LeaseError;

    fn try_from(raw: RawDirectRoute) -> Result<Self, Self::Error> {
        Self::new(raw.transport, raw.endpoint, raw.priority)
    }
}

impl From<DirectRoute> for RawDirectRoute {
    fn from(route: DirectRoute) -> Self {
        Self {
            transport: route.transport,
            endpoint: route.endpoint,
            priority: route.priority,
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawRelayRoute {
    relay_peer_id: PeerId,
    relay_endpoints: Vec<String>,
    priority: u16,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "RawRelayRoute", into = "RawRelayRoute")]
pub struct RelayRoute {
    relay_peer_id: PeerId,
    relay_endpoints: Vec<String>,
    priority: u16,
}

impl RelayRoute {
    pub fn new(
        relay_peer_id: PeerId,
        relay_endpoints: Vec<String>,
        priority: u16,
    ) -> Result<Self, LeaseError> {
        if relay_endpoints.is_empty() || relay_endpoints.iter().any(String::is_empty) {
            return Err(LeaseError::EmptyEndpoint);
        }
        if relay_endpoints.len() > MAX_ROUTES_PER_CLASS {
            return Err(LeaseError::TooManyRoutes {
                class: "relayEndpoints",
                count: relay_endpoints.len(),
            });
        }
        Ok(Self {
            relay_peer_id,
            relay_endpoints,
            priority,
        })
    }

    pub fn relay_peer_id(&self) -> &PeerId {
        &self.relay_peer_id
    }

    pub fn relay_endpoints(&self) -> &[String] {
        &self.relay_endpoints
    }

    pub fn priority(&self) -> u16 {
        self.priority
    }
}

impl TryFrom<RawRelayRoute> for RelayRoute {
    type Error = LeaseError;

    fn try_from(raw: RawRelayRoute) -> Result<Self, Self::Error> {
        Self::new(raw.relay_peer_id, raw.relay_endpoints, raw.priority)
    }
}

impl From<RelayRoute> for RawRelayRoute {
    fn from(route: RelayRoute) -> Self {
        Self {
            relay_peer_id: route.relay_peer_id,
            relay_endpoints: route.relay_endpoints,
            priority: route.priority,
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawPeerReachabilityLeaseV1 {
    root_id: String,
    peer_id: PeerId,
    epoch: Uuid,
    revision: u64,
    issued_at_ms: u64,
    expires_at_ms: u64,
    direct_routes: Vec<DirectRoute>,
    relay_routes: Vec<RelayRoute>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "RawPeerReachabilityLeaseV1", into = "RawPeerReachabilityLeaseV1")]
pub struct PeerReachabilityLeaseV1 {
    root_id: String,
    peer_id: PeerId,
    epoch: Uuid,
    revision: u64,
    issued_at_ms: u64,
    expires_at_ms: u64,
    direct_routes: Vec<DirectRoute>,
    relay_routes: Vec<RelayRoute>,
}

impl PeerReachabilityLeaseV1 {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        root_id: impl Into<String>,
        peer_id: PeerId,
        epoch: Uuid,
        revision: u64,
        issued_at_ms: u64,
        expires_at_ms: u64,
        direct_routes: Vec<DirectRoute>,
        relay_routes: Vec<RelayRoute>,
    ) -> Result<Self, LeaseError> {
        let root_id = root_id.into();
        if root_id.is_empty() {
            return Err(LeaseError::EmptyRootId);
        }
        if epoch.is_nil() {
            return Err(LeaseError::NilEpoch);
        }
        if direct_routes.is_empty() && relay_routes.is_empty() {
            return Err(LeaseError::NoRoutes);
        }
        if direct_routes.len() > MAX_ROUTES_PER_CLASS {
            return Err(LeaseError::TooManyRoutes {
                class: "directRoutes",
                count: direct_routes.len(),
            });
        }
        if relay_routes.len() > MAX_ROUTES_PER_CLASS {
            return Err(LeaseError::TooManyRoutes {
                class: "relayRoutes",
                count: relay_routes.len(),
            });
        }
        for route in &relay_routes {
            if route.relay_peer_id == peer_id {
                return Err(LeaseError::SelfRelay(peer_id));
            }
        }
        if expires_at_ms <= issued_at_ms {
            return Err(LeaseError::InvalidLifetimeOrder {
                issued_at_ms,
                expires_at_ms,
            });
        }
        let lifetime_ms = expires_at_ms - issued_at_ms;
        if lifetime_ms > MAX_LEASE_LIFETIME_MS {
            return Err(LeaseError::LifetimeTooLong { lifetime_ms });
        }
        Ok(Self {
            root_id,
            peer_id,
            epoch,
            revision,
            issued_at_ms,
            expires_at_ms,
            direct_routes,
            relay_routes,
        })
    }

    pub fn root_id(&self) -> &str {
        &self.root_id
    }

    pub fn peer_id(&self) -> &PeerId {
        &self.peer_id
    }

    pub fn epoch(&self) -> Uuid {
        self.epoch
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn issued_at_ms(&self) -> u64 {
        self.issued_at_ms
    }

    pub fn expires_at_ms(&self) -> u64 {
        self.expires_at_ms
    }

    pub fn direct_routes(&self) -> &[DirectRoute] {
        &self.direct_routes
    }

    pub fn relay_routes(&self) -> &[RelayRoute] {
        &self.relay_routes
    }

    pub fn canonical_signing_bytes(&self) -> Result<Vec<u8>, LeaseError> {
        let mut bytes = Vec::from(LEASE_SIGNING_DOMAIN);
        serde_json::to_writer(&mut bytes, self)
            .map_err(|err| LeaseError::Serialization(err.to_string()))?;
        if bytes.len() > MAX_SIGNED_LEASE_BYTES {
            return Err(LeaseError::PayloadTooLarge(bytes.len()));
        }
        Ok(bytes)
    }
}

impl TryFrom<RawPeerReachabilityLeaseV1> for PeerReachabilityLeaseV1 {
    type Error = LeaseError;

    fn try_from(raw: RawPeerReachabilityLeaseV1) -> Result<Self, Self::Error> {
        Self::new(
            raw.root_id,
            raw.peer_id,
            raw.epoch,
            raw.revision,
            raw.issued_at_ms,
            raw.expires_at_ms,
            raw.direct_routes,
            raw.relay_routes,
        )
    }
}

impl From<PeerReachabilityLeaseV1> for RawPeerReachabilityLeaseV1 {
    fn from(lease: PeerReachabilityLeaseV1) -> Self {
        Self {
            root_id: lease.root_id,
            peer_id: lease.peer_id,
            epoch: lease.epoch,
            revision: lease.revision,
            issued_at_ms: lease.issued_at_ms,
            expires_at_ms: lease.expires_at_ms,
            direct_routes: lease.direct_routes,
            relay_routes: lease.relay_routes,
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawSignedPeerReachabilityLeaseV1 {
    lease: PeerReachabilityLeaseV1,
    public_key_base64: String,
    signature_base64: String,
}

/// Cryptographically verified peer reachability lease.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "RawSignedPeerReachabilityLeaseV1", into = "RawSignedPeerReachabilityLeaseV1")]
pub struct SignedPeerReachabilityLeaseV1 {
    lease: PeerReachabilityLeaseV1,
    public_key_base64: String,
    signature_base64: String,
}

impl SignedPeerReachabilityLeaseV1 {
    pub fn sign(
        lease: PeerReachabilityLeaseV1,
        identity: &NodeIdentity,
        now_ms: u64,
    ) -> Result<Self, LeaseError> {
        if lease.peer_id() != identity.peer_id() {
            return Err(LeaseError::Identity(IdentityError::PeerIdMismatch {
                expected: lease.peer_id().clone(),
                actual: identity.peer_id().clone(),
            }));
        }
        let signing_bytes = lease.canonical_signing_bytes()?;
        let signed = Self {
            lease,
            public_key_base64: identity.public_key_base64().to_owned(),
            signature_base64: identity.sign_base64(&signing_bytes),
        };
        signed.verify_time(now_ms)?;
        Ok(signed)
    }

    pub fn decode_and_verify(bytes: &[u8], now_ms: u64) -> Result<Self, LeaseError> {
        if bytes.len() > MAX_SIGNED_LEASE_BYTES {
            return Err(LeaseError::PayloadTooLarge(bytes.len()));
        }
        let signed: Self = serde_json::from_slice(bytes)
            .map_err(|err| LeaseError::Serialization(err.to_string()))?;
        signed.verify_time(now_ms)?;
        Ok(signed)
    }

    pub fn verify_time(&self, now_ms: u64) -> Result<(), LeaseError> {
        if self.lease.issued_at_ms > now_ms.saturating_add(MAX_CLOCK_SKEW_MS) {
            return Err(LeaseError::IssuedInFuture {
                issued_at_ms: self.lease.issued_at_ms,
                now_ms,
            });
        }
        if now_ms > self.lease.expires_at_ms {
            return Err(LeaseError::Expired {
                expires_at_ms: self.lease.expires_at_ms,
                now_ms,
            });
        }
        Ok(())
    }

    pub fn lease(&self) -> &PeerReachabilityLeaseV1 {
        &self.lease
    }

    pub fn public_key_base64(&self) -> &str {
        &self.public_key_base64
    }

    pub fn signature_base64(&self) -> &str {
        &self.signature_base64
    }
}

impl TryFrom<RawSignedPeerReachabilityLeaseV1> for SignedPeerReachabilityLeaseV1 {
    type Error = LeaseError;

    fn try_from(raw: RawSignedPeerReachabilityLeaseV1) -> Result<Self, Self::Error> {
        let signing_bytes = raw.lease.canonical_signing_bytes()?;
        verify_signature(
            raw.lease.peer_id(),
            &raw.public_key_base64,
            &signing_bytes,
            &raw.signature_base64,
        )?;
        Ok(Self {
            lease: raw.lease,
            public_key_base64: raw.public_key_base64,
            signature_base64: raw.signature_base64,
        })
    }
}

impl From<SignedPeerReachabilityLeaseV1> for RawSignedPeerReachabilityLeaseV1 {
    fn from(signed: SignedPeerReachabilityLeaseV1) -> Self {
        Self {
            lease: signed.lease,
            public_key_base64: signed.public_key_base64,
            signature_base64: signed.signature_base64,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LeaseAcceptOutcome {
    Inserted,
    Updated,
    Unchanged,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UsableLease<'a> {
    Fresh(&'a SignedPeerReachabilityLeaseV1),
    StaleRecovery(&'a SignedPeerReachabilityLeaseV1),
}

impl<'a> UsableLease<'a> {
    pub fn signed(&self) -> &'a SignedPeerReachabilityLeaseV1 {
        match *self {
            Self::Fresh(signed) | Self::StaleRecovery(signed) => signed,
        }
    }

    pub fn is_fresh(&self) -> bool {
        matches!(self, Self::Fresh(_))
    }
}

#[derive(Clone, Debug)]
struct StoredLeaseReceipt {
    signed: SignedPeerReachabilityLeaseV1,
    fresh_until_monotonic: Instant,
    recovery_until_monotonic: Instant,
}

impl StoredLeaseReceipt {
    fn new(signed: SignedPeerReachabilityLeaseV1, now_ms: u64, monotonic_now: Instant) -> Self {
        let remaining_wall_ms = signed.lease.expires_at_ms.saturating_sub(now_ms);
        let total_lifetime_ms = signed.lease.expires_at_ms - signed.lease.issued_at_ms;
        let bounded_fresh_ms = remaining_wall_ms.min(total_lifetime_ms);
        let fresh_until_monotonic = monotonic_now
            .checked_add(Duration::from_millis(bounded_fresh_ms))
            .unwrap_or(monotonic_now);
        let recovery_until_monotonic = fresh_until_monotonic
            .checked_add(Duration::from_millis(MAX_RECOVERY_HORIZON_MS))
            .unwrap_or(fresh_until_monotonic);
        Self {
            signed,
            fresh_until_monotonic,
            recovery_until_monotonic,
        }
    }
}

/// Monotonic anti-rollback store of verified reachability leases keyed by
/// `root_id -> peer_id`.
#[derive(Clone, Debug, Default)]
pub struct LeaseReceiptStore {
    receipts: BTreeMap<String, BTreeMap<PeerId, StoredLeaseReceipt>>,
}

impl LeaseReceiptStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn accept(
        &mut self,
        signed: SignedPeerReachabilityLeaseV1,
        now_ms: u64,
    ) -> Result<LeaseAcceptOutcome, LeaseError> {
        self.accept_at(signed, now_ms, Instant::now())
    }

    pub fn accept_at(
        &mut self,
        signed: SignedPeerReachabilityLeaseV1,
        now_ms: u64,
        monotonic_now: Instant,
    ) -> Result<LeaseAcceptOutcome, LeaseError> {
        signed.verify_time(now_ms)?;
        let by_root = self
            .receipts
            .entry(signed.lease.root_id.clone())
            .or_default();
        if let Some(current) = by_root.get(&signed.lease.peer_id) {
            if signed.lease.revision < current.signed.lease.revision {
                return Err(LeaseError::RevisionRollback {
                    current: current.signed.lease.revision,
                    incoming: signed.lease.revision,
                });
            }
            if signed.lease.revision == current.signed.lease.revision {
                if signed == current.signed {
                    return Ok(LeaseAcceptOutcome::Unchanged);
                }
                return Err(LeaseError::ConflictingEqualRevision(signed.lease.revision));
            }
            let peer_id = signed.lease.peer_id.clone();
            by_root.insert(
                peer_id,
                StoredLeaseReceipt::new(signed, now_ms, monotonic_now),
            );
            return Ok(LeaseAcceptOutcome::Updated);
        }
        let peer_id = signed.lease.peer_id.clone();
        by_root.insert(
            peer_id,
            StoredLeaseReceipt::new(signed, now_ms, monotonic_now),
        );
        Ok(LeaseAcceptOutcome::Inserted)
    }

    pub fn resolve_usable<'a>(
        &'a self,
        root_id: &str,
        peer_id: &PeerId,
        now_ms: u64,
    ) -> Option<UsableLease<'a>> {
        self.resolve_usable_at(root_id, peer_id, now_ms, Instant::now())
    }

    pub fn resolve_usable_at<'a>(
        &'a self,
        root_id: &str,
        peer_id: &PeerId,
        now_ms: u64,
        monotonic_now: Instant,
    ) -> Option<UsableLease<'a>> {
        let stored = self.receipts.get(root_id)?.get(peer_id)?;
        let expires_at_ms = stored.signed.lease.expires_at_ms;
        if now_ms <= expires_at_ms && monotonic_now <= stored.fresh_until_monotonic {
            Some(UsableLease::Fresh(&stored.signed))
        } else if now_ms <= expires_at_ms.saturating_add(MAX_RECOVERY_HORIZON_MS)
            && monotonic_now <= stored.recovery_until_monotonic
        {
            Some(UsableLease::StaleRecovery(&stored.signed))
        } else {
            None
        }
    }
}
