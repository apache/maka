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

//! Signed autonomous mesh roster, member advertisements, and latency-aware
//! route resolution (`A -> B` direct vs `A -> C -> B` approved transit).

use maka_peer::{
    DirectTransport, IdentityError, LeaseError, LeaseReceiptStore, MAX_CLOCK_SKEW_MS,
    NodeIdentity, PeerId, SignedPeerReachabilityLeaseV1, verify_signature,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    time::{Duration, Instant},
};
use thiserror::Error;

pub const MAX_MESH_MEMBERS: usize = 64;
pub const MAX_ROSTER_BYTES: usize = 64 * 1024;
pub const MAX_AD_BYTES: usize = 64 * 1024;
const MESH_ID_PREFIX: &str = "mesh_";
const ROSTER_SIGNING_DOMAIN: &[u8] = b"maka-peer-mesh-roster-v1\n";
const AD_SIGNING_DOMAIN: &[u8] = b"maka-peer-mesh-ad-v1\n";

#[derive(Debug, Error)]
pub enum MeshError {
    #[error("invalid mesh id `{0}`: expected `mesh_<32..=64 lowercase hex chars>`")]
    InvalidMeshId(String),
    #[error("member display name must not be empty")]
    EmptyDisplayName,
    #[error("mesh roster must contain 1..={MAX_MESH_MEMBERS} unique members")]
    InvalidMemberSet,
    #[error("mesh owner `{0}` must be present as an active Owner member in the roster")]
    OwnerNotActiveMember(PeerId),
    #[error("mesh payload exceeds limit ({0} bytes)")]
    PayloadTooLarge(usize),
    #[error("mesh advertisement RTT hints must not contain self")]
    SelfRttHint,
    #[error("mesh advertisement lease peer `{lease_peer}` does not match member `{member_peer}`")]
    AdvertisementLeasePeerMismatch {
        member_peer: PeerId,
        lease_peer: PeerId,
    },
    #[error("mesh id mismatch: expected `{expected}`, incoming `{incoming}`")]
    MeshIdMismatch { expected: MeshId, incoming: MeshId },
    #[error("mesh owner mismatch: pinned `{expected}`, incoming `{incoming}`")]
    OwnerMismatch { expected: PeerId, incoming: PeerId },
    #[error("mesh roster revision rollback: current={current}, incoming={incoming}")]
    RosterRollback { current: u64, incoming: u64 },
    #[error("conflicting mesh roster at identical revision {0}")]
    ConflictingRosterRevision(u64),
    #[error("mesh advertisement revision rollback for `{peer_id}`: current={current}, incoming={incoming}")]
    AdvertisementRollback {
        peer_id: PeerId,
        current: u64,
        incoming: u64,
    },
    #[error("conflicting mesh advertisement for `{peer_id}` at identical revision {revision}")]
    ConflictingAdvertisementRevision { peer_id: PeerId, revision: u64 },
    #[error("peer `{0}` is not an active member of mesh `{1}`")]
    UnauthorizedMember(PeerId, MeshId),
    #[error("mesh timestamp {issued_at_ms} exceeds allowed future clock skew (now={now_ms})")]
    IssuedInFuture { issued_at_ms: u64, now_ms: u64 },
    #[error("mesh identity verification failed: {0}")]
    Identity(#[from] IdentityError),
    #[error("reachability lease error: {0}")]
    Lease(#[from] LeaseError),
    #[error("mesh serialization error: {0}")]
    Serialization(String),
}

/// Canonical mesh identifier: `mesh_` followed by 32..=64 lowercase hex chars.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Debug, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct MeshId(String);

impl MeshId {
    pub fn parse(raw: impl Into<String>) -> Result<Self, MeshError> {
        let raw = raw.into();
        let Some(hex_part) = raw.strip_prefix(MESH_ID_PREFIX) else {
            return Err(MeshError::InvalidMeshId(raw));
        };
        if !(32..=64).contains(&hex_part.len())
            || !hex_part
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(MeshError::InvalidMeshId(raw));
        }
        Ok(Self(raw))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for MeshId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl TryFrom<String> for MeshId {
    type Error = MeshError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(value)
    }
}

impl From<MeshId> for String {
    fn from(value: MeshId) -> Self {
        value.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeshRole {
    Owner,
    Member,
    RelayCapable,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawMeshMemberEntry {
    peer_id: PeerId,
    display_name: String,
    role: MeshRole,
    relay_allowed: bool,
    revoked: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "RawMeshMemberEntry", into = "RawMeshMemberEntry")]
pub struct MeshMemberEntry {
    peer_id: PeerId,
    display_name: String,
    role: MeshRole,
    relay_allowed: bool,
    revoked: bool,
}

impl MeshMemberEntry {
    pub fn new(
        peer_id: PeerId,
        display_name: impl Into<String>,
        role: MeshRole,
        relay_allowed: bool,
        revoked: bool,
    ) -> Result<Self, MeshError> {
        let display_name = display_name.into();
        if display_name.trim().is_empty() {
            return Err(MeshError::EmptyDisplayName);
        }
        Ok(Self {
            peer_id,
            display_name,
            role,
            relay_allowed,
            revoked,
        })
    }

    pub fn peer_id(&self) -> &PeerId {
        &self.peer_id
    }

    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    pub fn role(&self) -> MeshRole {
        self.role
    }

    pub fn relay_allowed(&self) -> bool {
        self.relay_allowed
    }

    pub fn is_revoked(&self) -> bool {
        self.revoked
    }

    pub fn is_active(&self) -> bool {
        !self.revoked
    }

    pub fn can_transit(&self) -> bool {
        !self.revoked && self.relay_allowed
    }
}

impl TryFrom<RawMeshMemberEntry> for MeshMemberEntry {
    type Error = MeshError;

    fn try_from(raw: RawMeshMemberEntry) -> Result<Self, Self::Error> {
        Self::new(
            raw.peer_id,
            raw.display_name,
            raw.role,
            raw.relay_allowed,
            raw.revoked,
        )
    }
}

impl From<MeshMemberEntry> for RawMeshMemberEntry {
    fn from(entry: MeshMemberEntry) -> Self {
        Self {
            peer_id: entry.peer_id,
            display_name: entry.display_name,
            role: entry.role,
            relay_allowed: entry.relay_allowed,
            revoked: entry.revoked,
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawPeerMeshRosterV1 {
    mesh_id: MeshId,
    owner_peer_id: PeerId,
    revision: u64,
    issued_at_ms: u64,
    members: Vec<MeshMemberEntry>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "RawPeerMeshRosterV1", into = "RawPeerMeshRosterV1")]
pub struct PeerMeshRosterV1 {
    mesh_id: MeshId,
    owner_peer_id: PeerId,
    revision: u64,
    issued_at_ms: u64,
    members: Vec<MeshMemberEntry>,
}

impl PeerMeshRosterV1 {
    pub fn new(
        mesh_id: MeshId,
        owner_peer_id: PeerId,
        revision: u64,
        issued_at_ms: u64,
        members: Vec<MeshMemberEntry>,
    ) -> Result<Self, MeshError> {
        if members.is_empty() || members.len() > MAX_MESH_MEMBERS {
            return Err(MeshError::InvalidMemberSet);
        }
        let mut seen = BTreeSet::new();
        let mut owner_ok = false;
        for member in &members {
            if !seen.insert(member.peer_id()) {
                return Err(MeshError::InvalidMemberSet);
            }
            if member.peer_id() == &owner_peer_id
                && member.role() == MeshRole::Owner
                && member.is_active()
            {
                owner_ok = true;
            }
        }
        if !owner_ok {
            return Err(MeshError::OwnerNotActiveMember(owner_peer_id));
        }
        Ok(Self {
            mesh_id,
            owner_peer_id,
            revision,
            issued_at_ms,
            members,
        })
    }

    pub fn mesh_id(&self) -> &MeshId {
        &self.mesh_id
    }

    pub fn owner_peer_id(&self) -> &PeerId {
        &self.owner_peer_id
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn issued_at_ms(&self) -> u64 {
        self.issued_at_ms
    }

    pub fn members(&self) -> &[MeshMemberEntry] {
        &self.members
    }

    pub fn member(&self, peer_id: &PeerId) -> Option<&MeshMemberEntry> {
        self.members.iter().find(|entry| entry.peer_id() == peer_id)
    }

    pub fn canonical_signing_bytes(&self) -> Result<Vec<u8>, MeshError> {
        let mut bytes = Vec::from(ROSTER_SIGNING_DOMAIN);
        serde_json::to_writer(&mut bytes, self)
            .map_err(|err| MeshError::Serialization(err.to_string()))?;
        if bytes.len() > MAX_ROSTER_BYTES {
            return Err(MeshError::PayloadTooLarge(bytes.len()));
        }
        Ok(bytes)
    }
}

impl TryFrom<RawPeerMeshRosterV1> for PeerMeshRosterV1 {
    type Error = MeshError;

    fn try_from(raw: RawPeerMeshRosterV1) -> Result<Self, Self::Error> {
        Self::new(
            raw.mesh_id,
            raw.owner_peer_id,
            raw.revision,
            raw.issued_at_ms,
            raw.members,
        )
    }
}

impl From<PeerMeshRosterV1> for RawPeerMeshRosterV1 {
    fn from(roster: PeerMeshRosterV1) -> Self {
        Self {
            mesh_id: roster.mesh_id,
            owner_peer_id: roster.owner_peer_id,
            revision: roster.revision,
            issued_at_ms: roster.issued_at_ms,
            members: roster.members,
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawSignedPeerMeshRosterV1 {
    roster: PeerMeshRosterV1,
    public_key_base64: String,
    signature_base64: String,
}

/// Cryptographically signed mesh membership roster verified against
/// `roster.owner_peer_id()` upon construction and deserialization.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "RawSignedPeerMeshRosterV1", into = "RawSignedPeerMeshRosterV1")]
pub struct SignedPeerMeshRosterV1 {
    roster: PeerMeshRosterV1,
    public_key_base64: String,
    signature_base64: String,
}

impl SignedPeerMeshRosterV1 {
    pub fn sign(roster: PeerMeshRosterV1, owner: &NodeIdentity) -> Result<Self, MeshError> {
        if roster.owner_peer_id() != owner.peer_id() {
            return Err(MeshError::Identity(IdentityError::PeerIdMismatch {
                expected: roster.owner_peer_id().clone(),
                actual: owner.peer_id().clone(),
            }));
        }
        let signing_bytes = roster.canonical_signing_bytes()?;
        Ok(Self {
            roster,
            public_key_base64: owner.public_key_base64().to_owned(),
            signature_base64: owner.sign_base64(&signing_bytes),
        })
    }

    pub fn roster(&self) -> &PeerMeshRosterV1 {
        &self.roster
    }

    pub fn public_key_base64(&self) -> &str {
        &self.public_key_base64
    }

    pub fn signature_base64(&self) -> &str {
        &self.signature_base64
    }
}

impl TryFrom<RawSignedPeerMeshRosterV1> for SignedPeerMeshRosterV1 {
    type Error = MeshError;

    fn try_from(raw: RawSignedPeerMeshRosterV1) -> Result<Self, Self::Error> {
        let signing_bytes = raw.roster.canonical_signing_bytes()?;
        verify_signature(
            raw.roster.owner_peer_id(),
            &raw.public_key_base64,
            &signing_bytes,
            &raw.signature_base64,
        )?;
        Ok(Self {
            roster: raw.roster,
            public_key_base64: raw.public_key_base64,
            signature_base64: raw.signature_base64,
        })
    }
}

impl From<SignedPeerMeshRosterV1> for RawSignedPeerMeshRosterV1 {
    fn from(signed: SignedPeerMeshRosterV1) -> Self {
        Self {
            roster: signed.roster,
            public_key_base64: signed.public_key_base64,
            signature_base64: signed.signature_base64,
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawPeerMeshMemberAdvertisementV1 {
    mesh_id: MeshId,
    member_peer_id: PeerId,
    revision: u64,
    issued_at_ms: u64,
    accepts_transit: bool,
    reachability_lease: SignedPeerReachabilityLeaseV1,
    peer_rtt_ms: BTreeMap<PeerId, u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "RawPeerMeshMemberAdvertisementV1", into = "RawPeerMeshMemberAdvertisementV1")]
pub struct PeerMeshMemberAdvertisementV1 {
    mesh_id: MeshId,
    member_peer_id: PeerId,
    revision: u64,
    issued_at_ms: u64,
    accepts_transit: bool,
    reachability_lease: SignedPeerReachabilityLeaseV1,
    peer_rtt_ms: BTreeMap<PeerId, u32>,
}

impl PeerMeshMemberAdvertisementV1 {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        mesh_id: MeshId,
        member_peer_id: PeerId,
        revision: u64,
        issued_at_ms: u64,
        accepts_transit: bool,
        reachability_lease: SignedPeerReachabilityLeaseV1,
        peer_rtt_ms: BTreeMap<PeerId, u32>,
    ) -> Result<Self, MeshError> {
        if reachability_lease.lease().peer_id() != &member_peer_id {
            return Err(MeshError::AdvertisementLeasePeerMismatch {
                member_peer: member_peer_id,
                lease_peer: reachability_lease.lease().peer_id().clone(),
            });
        }
        if peer_rtt_ms.contains_key(&member_peer_id) {
            return Err(MeshError::SelfRttHint);
        }
        Ok(Self {
            mesh_id,
            member_peer_id,
            revision,
            issued_at_ms,
            accepts_transit,
            reachability_lease,
            peer_rtt_ms,
        })
    }

    pub fn mesh_id(&self) -> &MeshId {
        &self.mesh_id
    }

    pub fn member_peer_id(&self) -> &PeerId {
        &self.member_peer_id
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn issued_at_ms(&self) -> u64 {
        self.issued_at_ms
    }

    pub fn accepts_transit(&self) -> bool {
        self.accepts_transit
    }

    pub fn reachability_lease(&self) -> &SignedPeerReachabilityLeaseV1 {
        &self.reachability_lease
    }

    pub fn peer_rtt_ms(&self) -> &BTreeMap<PeerId, u32> {
        &self.peer_rtt_ms
    }

    pub fn canonical_signing_bytes(&self) -> Result<Vec<u8>, MeshError> {
        let mut bytes = Vec::from(AD_SIGNING_DOMAIN);
        serde_json::to_writer(&mut bytes, self)
            .map_err(|err| MeshError::Serialization(err.to_string()))?;
        if bytes.len() > MAX_AD_BYTES {
            return Err(MeshError::PayloadTooLarge(bytes.len()));
        }
        Ok(bytes)
    }
}

impl TryFrom<RawPeerMeshMemberAdvertisementV1> for PeerMeshMemberAdvertisementV1 {
    type Error = MeshError;

    fn try_from(raw: RawPeerMeshMemberAdvertisementV1) -> Result<Self, Self::Error> {
        Self::new(
            raw.mesh_id,
            raw.member_peer_id,
            raw.revision,
            raw.issued_at_ms,
            raw.accepts_transit,
            raw.reachability_lease,
            raw.peer_rtt_ms,
        )
    }
}

impl From<PeerMeshMemberAdvertisementV1> for RawPeerMeshMemberAdvertisementV1 {
    fn from(ad: PeerMeshMemberAdvertisementV1) -> Self {
        Self {
            mesh_id: ad.mesh_id,
            member_peer_id: ad.member_peer_id,
            revision: ad.revision,
            issued_at_ms: ad.issued_at_ms,
            accepts_transit: ad.accepts_transit,
            reachability_lease: ad.reachability_lease,
            peer_rtt_ms: ad.peer_rtt_ms,
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawSignedPeerMeshMemberAdvertisementV1 {
    advertisement: PeerMeshMemberAdvertisementV1,
    public_key_base64: String,
    signature_base64: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "RawSignedPeerMeshMemberAdvertisementV1", into = "RawSignedPeerMeshMemberAdvertisementV1")]
pub struct SignedPeerMeshMemberAdvertisementV1 {
    advertisement: PeerMeshMemberAdvertisementV1,
    public_key_base64: String,
    signature_base64: String,
}

impl SignedPeerMeshMemberAdvertisementV1 {
    pub fn sign(
        advertisement: PeerMeshMemberAdvertisementV1,
        member: &NodeIdentity,
    ) -> Result<Self, MeshError> {
        if advertisement.member_peer_id() != member.peer_id() {
            return Err(MeshError::Identity(IdentityError::PeerIdMismatch {
                expected: advertisement.member_peer_id().clone(),
                actual: member.peer_id().clone(),
            }));
        }
        let signing_bytes = advertisement.canonical_signing_bytes()?;
        Ok(Self {
            advertisement,
            public_key_base64: member.public_key_base64().to_owned(),
            signature_base64: member.sign_base64(&signing_bytes),
        })
    }

    pub fn advertisement(&self) -> &PeerMeshMemberAdvertisementV1 {
        &self.advertisement
    }

    pub fn public_key_base64(&self) -> &str {
        &self.public_key_base64
    }

    pub fn signature_base64(&self) -> &str {
        &self.signature_base64
    }
}

impl TryFrom<RawSignedPeerMeshMemberAdvertisementV1> for SignedPeerMeshMemberAdvertisementV1 {
    type Error = MeshError;

    fn try_from(raw: RawSignedPeerMeshMemberAdvertisementV1) -> Result<Self, Self::Error> {
        let signing_bytes = raw.advertisement.canonical_signing_bytes()?;
        verify_signature(
            raw.advertisement.member_peer_id(),
            &raw.public_key_base64,
            &signing_bytes,
            &raw.signature_base64,
        )?;
        Ok(Self {
            advertisement: raw.advertisement,
            public_key_base64: raw.public_key_base64,
            signature_base64: raw.signature_base64,
        })
    }
}

impl From<SignedPeerMeshMemberAdvertisementV1> for RawSignedPeerMeshMemberAdvertisementV1 {
    fn from(signed: SignedPeerMeshMemberAdvertisementV1) -> Self {
        Self {
            advertisement: signed.advertisement,
            public_key_base64: signed.public_key_base64,
            signature_base64: signed.signature_base64,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MeshRosterAcceptOutcome {
    Updated,
    Unchanged,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MeshAdAcceptOutcome {
    Inserted,
    Updated,
    Unchanged,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DirectDialCandidate {
    pub transport: DirectTransport,
    pub endpoint: String,
    pub priority: u16,
    pub measured_rtt_ms: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TransitDialCandidate {
    pub relay_peer_id: PeerId,
    pub relay_endpoints: Vec<String>,
    pub estimated_rtt_ms: Option<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DialStrategy {
    Unavailable,
    DirectOnly,
    TransitOnly,
    HedgedDirectThenTransit { hedge_delay: Duration },
    PreferTransitWithDirectFallback { hedge_delay: Duration },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PeerRouteResolution {
    pub target_peer_id: PeerId,
    pub direct_candidates: Vec<DirectDialCandidate>,
    pub transit_candidates: Vec<TransitDialCandidate>,
    pub strategy: DialStrategy,
}

#[derive(Clone, Debug)]
pub struct MeshStateStore {
    roster: SignedPeerMeshRosterV1,
    advertisements: BTreeMap<PeerId, SignedPeerMeshMemberAdvertisementV1>,
    leases: LeaseReceiptStore,
}

impl MeshStateStore {
    pub fn new(initial_roster: SignedPeerMeshRosterV1) -> Self {
        Self {
            roster: initial_roster,
            advertisements: BTreeMap::new(),
            leases: LeaseReceiptStore::new(),
        }
    }

    pub fn roster(&self) -> &SignedPeerMeshRosterV1 {
        &self.roster
    }

    pub fn apply_roster(
        &mut self,
        incoming: SignedPeerMeshRosterV1,
        now_ms: u64,
    ) -> Result<MeshRosterAcceptOutcome, MeshError> {
        if incoming.roster().mesh_id() != self.roster.roster().mesh_id() {
            return Err(MeshError::MeshIdMismatch {
                expected: self.roster.roster().mesh_id().clone(),
                incoming: incoming.roster().mesh_id().clone(),
            });
        }
        if incoming.roster().owner_peer_id() != self.roster.roster().owner_peer_id() {
            return Err(MeshError::OwnerMismatch {
                expected: self.roster.roster().owner_peer_id().clone(),
                incoming: incoming.roster().owner_peer_id().clone(),
            });
        }
        if incoming.roster().issued_at_ms() > now_ms.saturating_add(MAX_CLOCK_SKEW_MS) {
            return Err(MeshError::IssuedInFuture {
                issued_at_ms: incoming.roster().issued_at_ms(),
                now_ms,
            });
        }
        let current_rev = self.roster.roster().revision();
        let incoming_rev = incoming.roster().revision();
        if incoming_rev < current_rev {
            return Err(MeshError::RosterRollback {
                current: current_rev,
                incoming: incoming_rev,
            });
        }
        if incoming_rev == current_rev {
            if incoming == self.roster {
                return Ok(MeshRosterAcceptOutcome::Unchanged);
            }
            return Err(MeshError::ConflictingRosterRevision(incoming_rev));
        }
        self.roster = incoming;
        self.advertisements.retain(|peer_id, _| {
            self.roster
                .roster()
                .member(peer_id)
                .is_some_and(MeshMemberEntry::is_active)
        });
        Ok(MeshRosterAcceptOutcome::Updated)
    }

    pub fn apply_advertisement(
        &mut self,
        incoming: SignedPeerMeshMemberAdvertisementV1,
        now_ms: u64,
        monotonic_now: Instant,
    ) -> Result<MeshAdAcceptOutcome, MeshError> {
        let ad = incoming.advertisement();
        if ad.mesh_id() != self.roster.roster().mesh_id() {
            return Err(MeshError::MeshIdMismatch {
                expected: self.roster.roster().mesh_id().clone(),
                incoming: ad.mesh_id().clone(),
            });
        }
        let member_peer = ad.member_peer_id().clone();
        let is_active = self
            .roster
            .roster()
            .member(&member_peer)
            .is_some_and(MeshMemberEntry::is_active);
        if !is_active {
            return Err(MeshError::UnauthorizedMember(
                member_peer,
                self.roster.roster().mesh_id().clone(),
            ));
        }
        if ad.issued_at_ms() > now_ms.saturating_add(MAX_CLOCK_SKEW_MS) {
            return Err(MeshError::IssuedInFuture {
                issued_at_ms: ad.issued_at_ms(),
                now_ms,
            });
        }
        if let Some(current) = self.advertisements.get(&member_peer) {
            let cur_rev = current.advertisement().revision();
            let inc_rev = ad.revision();
            if inc_rev < cur_rev {
                return Err(MeshError::AdvertisementRollback {
                    peer_id: member_peer,
                    current: cur_rev,
                    incoming: inc_rev,
                });
            }
            if inc_rev == cur_rev {
                if &incoming == current {
                    return Ok(MeshAdAcceptOutcome::Unchanged);
                }
                return Err(MeshError::ConflictingAdvertisementRevision {
                    peer_id: member_peer,
                    revision: inc_rev,
                });
            }
        }
        self.leases
            .accept_at(ad.reachability_lease().clone(), now_ms, monotonic_now)?;
        let existed = self.advertisements.insert(member_peer, incoming).is_some();
        Ok(if existed {
            MeshAdAcceptOutcome::Updated
        } else {
            MeshAdAcceptOutcome::Inserted
        })
    }

    pub fn resolve_routes(
        &self,
        local_peer_id: &PeerId,
        target_peer_id: &PeerId,
        local_rtt_ms: &BTreeMap<PeerId, u32>,
        hedge_delay: Duration,
        now_ms: u64,
        monotonic_now: Instant,
    ) -> PeerRouteResolution {
        let mut direct_candidates = Vec::new();
        let mut transit_candidates = Vec::new();

        let local_active = self
            .roster
            .roster()
            .member(local_peer_id)
            .is_some_and(MeshMemberEntry::is_active);
        let target_active = self
            .roster
            .roster()
            .member(target_peer_id)
            .is_some_and(MeshMemberEntry::is_active);
        if !local_active || !target_active || local_peer_id == target_peer_id {
            return PeerRouteResolution {
                target_peer_id: target_peer_id.clone(),
                direct_candidates,
                transit_candidates,
                strategy: DialStrategy::Unavailable,
            };
        }

        let direct_rtt = local_rtt_ms.get(target_peer_id).copied();
        if let Some(target_ad) = self.advertisements.get(target_peer_id) {
            let root_id = target_ad.advertisement().reachability_lease().lease().root_id();
            if let Some(usable) = self
                .leases
                .resolve_usable_at(root_id, target_peer_id, now_ms, monotonic_now)
            {
                for route in usable.signed().lease().direct_routes() {
                    direct_candidates.push(DirectDialCandidate {
                        transport: route.transport(),
                        endpoint: route.endpoint().to_owned(),
                        priority: route.priority(),
                        measured_rtt_ms: direct_rtt,
                    });
                }
                direct_candidates.sort_by(|a, b| {
                    a.priority
                        .cmp(&b.priority)
                        .then_with(|| a.transport.cmp(&b.transport))
                        .then_with(|| a.endpoint.cmp(&b.endpoint))
                });
            }
        }

        for member in self.roster.roster().members() {
            let relay_id = member.peer_id();
            if !member.can_transit() || relay_id == local_peer_id || relay_id == target_peer_id {
                continue;
            }
            let Some(relay_ad) = self.advertisements.get(relay_id) else {
                continue;
            };
            if !relay_ad.advertisement().accepts_transit() {
                continue;
            }
            let relay_root = relay_ad.advertisement().reachability_lease().lease().root_id();
            let Some(relay_usable) = self
                .leases
                .resolve_usable_at(relay_root, relay_id, now_ms, monotonic_now)
            else {
                continue;
            };
            let relay_endpoints: Vec<String> = relay_usable
                .signed()
                .lease()
                .direct_routes()
                .iter()
                .map(|r| r.endpoint().to_owned())
                .collect();
            if relay_endpoints.is_empty() {
                continue;
            }
            let rtt_ac = local_rtt_ms.get(relay_id).copied();
            let rtt_cb = relay_ad
                .advertisement()
                .peer_rtt_ms()
                .get(target_peer_id)
                .copied();
            let estimated_rtt_ms = match (rtt_ac, rtt_cb) {
                (Some(ac), Some(cb)) => Some(ac.saturating_add(cb)),
                _ => None,
            };
            transit_candidates.push(TransitDialCandidate {
                relay_peer_id: relay_id.clone(),
                relay_endpoints,
                estimated_rtt_ms,
            });
        }

        transit_candidates.sort_by(|a, b| match (a.estimated_rtt_ms, b.estimated_rtt_ms) {
            (Some(ra), Some(rb)) => ra.cmp(&rb).then_with(|| a.relay_peer_id.cmp(&b.relay_peer_id)),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => a.relay_peer_id.cmp(&b.relay_peer_id),
        });

        let strategy = match (direct_candidates.is_empty(), transit_candidates.is_empty()) {
            (true, true) => DialStrategy::Unavailable,
            (false, true) => DialStrategy::DirectOnly,
            (true, false) => DialStrategy::TransitOnly,
            (false, false) => {
                let prefer_transit = matches!(
                    (direct_rtt, transit_candidates[0].estimated_rtt_ms),
                    (Some(d_rtt), Some(t_rtt)) if t_rtt < d_rtt
                );
                if prefer_transit {
                    DialStrategy::PreferTransitWithDirectFallback { hedge_delay }
                } else {
                    DialStrategy::HedgedDirectThenTransit { hedge_delay }
                }
            }
        };

        PeerRouteResolution {
            target_peer_id: target_peer_id.clone(),
            direct_candidates,
            transit_candidates,
            strategy,
        }
    }
}
