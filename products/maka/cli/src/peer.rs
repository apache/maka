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

//! CLI commands for P2P node identity, pairing tickets, SAS verification,
//! owner-signed mesh rosters, QUIC RTT probing, and mesh transit relaying.

use crate::{access, args::Root, host_client::HostClient};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use clap::{Args, Subcommand};
use maka_event_log::root;
use maka_host_runtime::HostError;
use maka_peer::{NodeIdentity, PeerId};
use maka_peer_mesh::{
    MeshId, MeshMemberEntry, MeshRole, MeshTransportNode, PeerMeshRosterV1, SignedPeerMeshRosterV1,
};
use serde::Serialize;
use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    num::NonZeroUsize,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const PAIRING_URI_PREFIX: &str = "maka://pair/v1?payload=";
const DEFAULT_TICKET_TTL_SECS: u64 = 300;

#[derive(Subcommand)]
pub(super) enum Command {
    /// Print or initialize this Root's persistent Ed25519 peer identity.
    Identity(IdentityArgs),
    /// Prepare a one-time remote Host pairing ticket (`maka://pair/v1?...`).
    PairTicket(PairTicketArgs),
    /// Compute the 6-digit Short Authentication String (SAS) for two peers and a nonce.
    Sas(SasArgs),
    /// Measure live mutual-Ed25519 QUIC round-trip latency to a remote peer.
    Ping(PingArgs),
    /// Create an owner-signed mesh roster authorizing active members and relays.
    RosterSign(RosterSignArgs),
    /// Run a fail-closed QUIC `A -> C -> B` mesh transit relay node.
    Relay(RelayArgs),
}

#[derive(Args)]
pub(super) struct IdentityArgs {
    #[command(flatten)]
    root: Root,
}

#[derive(Args)]
pub(super) struct PairTicketArgs {
    #[command(flatten)]
    root: Root,
    #[arg(long)]
    host_name: String,
    #[arg(long = "endpoint", required = true)]
    endpoints: Vec<String>,
    #[arg(long, default_value = "remote-client")]
    principal: String,
    #[arg(long, default_value_t = DEFAULT_TICKET_TTL_SECS)]
    ttl_secs: u64,
}

#[derive(Args)]
pub(super) struct SasArgs {
    #[arg(long)]
    local_peer_id: String,
    #[arg(long)]
    remote_peer_id: String,
    #[arg(long)]
    nonce: String,
}

#[derive(Args)]
pub(super) struct PingArgs {
    #[arg(long)]
    identity: PathBuf,
    #[arg(long)]
    peer_id: String,
    #[arg(long)]
    addr: SocketAddr,
}

#[derive(Args)]
pub(super) struct RosterSignArgs {
    #[arg(long)]
    identity: PathBuf,
    #[arg(long)]
    mesh_id: String,
    #[arg(long, default_value_t = 1)]
    revision: u64,
    #[arg(long = "member", required = true)]
    members: Vec<String>,
    #[arg(long)]
    output: Option<PathBuf>,
}

#[derive(Args)]
pub(super) struct RelayArgs {
    #[arg(long)]
    identity: PathBuf,
    #[arg(long)]
    listen: SocketAddr,
    #[arg(long)]
    roster: Option<PathBuf>,
    #[arg(long = "peer")]
    peers: Vec<String>,
    #[arg(long)]
    max_circuits: Option<NonZeroUsize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingTicketPayload<'a> {
    root_id: &'a str,
    host_name: &'a str,
    peer_id: &'a str,
    endpoints: &'a [String],
    pairing_token: &'a str,
    nonce: &'a str,
    expires_at_ms: u64,
}

impl Command {
    pub async fn run(self) -> Result<(), HostError> {
        match self {
            Self::Identity(args) => args.run().await,
            Self::PairTicket(args) => args.run().await,
            Self::Sas(args) => args.run(),
            Self::Ping(args) => args.run().await,
            Self::RosterSign(args) => args.run().await,
            Self::Relay(args) => args.run().await,
        }
    }
}

pub(crate) fn identity_file_path(root_dir: &Path) -> PathBuf {
    root_dir.join("peer").join("node-identity.json")
}

fn now_epoch_ms() -> Result<u64, HostError> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("system clock before UNIX epoch: {err}"))?
        .as_millis();
    u64::try_from(millis).map_err(|_| "system clock overflow".into())
}

fn encode_pairing_uri(payload: &PairingTicketPayload<'_>) -> Result<String, HostError> {
    let json = serde_json::to_vec(payload)?;
    Ok(format!("{PAIRING_URI_PREFIX}{}", URL_SAFE_NO_PAD.encode(json)))
}

fn parse_member_spec(raw: &str) -> Result<MeshMemberEntry, HostError> {
    let (peer_str, role, relay_allowed) = match raw.split_once(':') {
        Some((peer, "owner")) => (peer, MeshRole::Owner, true),
        Some((peer, "relay")) => (peer, MeshRole::RelayCapable, true),
        Some((peer, "member")) => (peer, MeshRole::Member, false),
        Some((_, other)) => {
            return Err(
                format!("unknown mesh member role `{other}` (expected `owner`, `relay`, or `member`)")
                    .into(),
            );
        }
        None => (raw, MeshRole::Member, false),
    };
    let peer_id = PeerId::parse(peer_str).map_err(|err| err.to_string())?;
    let display_name = peer_id.as_str().to_owned();
    MeshMemberEntry::new(peer_id, display_name, role, relay_allowed, false)
        .map_err(|err| err.to_string().into())
}

fn parse_peer_addr_spec(raw: &str) -> Result<(PeerId, SocketAddr), HostError> {
    let (peer_str, addr_str) = raw
        .split_once('=')
        .ok_or_else(|| format!("expected `<peer_id>=<ip:port>`, got `{raw}`"))?;
    let peer_id = PeerId::parse(peer_str).map_err(|err| err.to_string())?;
    let addr: SocketAddr = addr_str
        .parse()
        .map_err(|err| format!("invalid peer socket address `{addr_str}`: {err}"))?;
    Ok((peer_id, addr))
}

impl IdentityArgs {
    async fn run(self) -> Result<(), HostError> {
        let location = root::resolve(&self.root.root)?;
        let identity =
            NodeIdentity::load_or_create_async(identity_file_path(location.canonical_path()))
                .await
                .map_err(|err| err.to_string())?;
        println!(
            "{}",
            serde_json::json!({
                "rootId": location.root_id(),
                "peerId": identity.peer_id(),
                "publicKeyBase64": identity.public_key_base64(),
            })
        );
        Ok(())
    }
}

impl PairTicketArgs {
    async fn run(self) -> Result<(), HostError> {
        if self.host_name.trim().is_empty() {
            return Err("host_name must not be empty".into());
        }
        if self.endpoints.is_empty() || self.endpoints.iter().any(|ep| ep.trim().is_empty()) {
            return Err("at least one non-empty --endpoint is required".into());
        }
        let principal = access::pairing_input(self.principal)?;
        let location = root::resolve(&self.root.root)?;
        let identity =
            NodeIdentity::load_or_create_async(identity_file_path(location.canonical_path()))
                .await
                .map_err(|err| err.to_string())?;
        let mut client = HostClient::connect(&self.root.root, None).await?;
        let pairing = access::prepare(&mut client, principal).await?;
        let nonce = Uuid::new_v4().simple().to_string();
        let expires_at_ms = now_epoch_ms()?.saturating_add(self.ttl_secs.saturating_mul(1_000));
        let uri = encode_pairing_uri(&PairingTicketPayload {
            root_id: &pairing.root_id,
            host_name: &self.host_name,
            peer_id: identity.peer_id().as_str(),
            endpoints: &self.endpoints,
            pairing_token: &pairing.credential,
            nonce: &nonce,
            expires_at_ms,
        })?;
        println!(
            "{}",
            serde_json::json!({
                "uri": uri,
                "rootId": pairing.root_id,
                "peerId": identity.peer_id(),
                "credentialId": pairing.credential_id,
                "nonce": nonce,
                "expiresAtMs": expires_at_ms,
            })
        );
        Ok(())
    }
}

impl SasArgs {
    fn run(self) -> Result<(), HostError> {
        let local = PeerId::parse(self.local_peer_id).map_err(|err| err.to_string())?;
        let remote = PeerId::parse(self.remote_peer_id).map_err(|err| err.to_string())?;
        let code = local.short_auth_code(&remote, &self.nonce);
        println!("{}", serde_json::json!({ "sas": code }));
        Ok(())
    }
}

impl PingArgs {
    async fn run(self) -> Result<(), HostError> {
        let identity = NodeIdentity::load_or_create_async(self.identity)
            .await
            .map_err(|err| err.to_string())?;
        let remote_peer = PeerId::parse(self.peer_id).map_err(|err| err.to_string())?;
        let bind_addr = match self.addr.ip() {
            IpAddr::V4(_) => SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0),
            IpAddr::V6(_) => SocketAddr::new(IpAddr::V6(Ipv6Addr::UNSPECIFIED), 0),
        };
        let (node, _rx) =
            MeshTransportNode::bind(bind_addr, identity, None).map_err(|err| err.to_string())?;
        let rtt = node
            .measure_rtt(&remote_peer, self.addr)
            .await
            .map_err(|err| err.to_string())?;
        node.shutdown();
        println!(
            "{}",
            serde_json::json!({
                "localPeerId": node.peer_id(),
                "remotePeerId": remote_peer,
                "addr": self.addr.to_string(),
                "rttMs": rtt.as_secs_f64() * 1_000.0,
            })
        );
        Ok(())
    }
}

impl RosterSignArgs {
    async fn run(self) -> Result<(), HostError> {
        let owner = NodeIdentity::load_or_create_async(self.identity)
            .await
            .map_err(|err| err.to_string())?;
        let mesh_id = MeshId::parse(self.mesh_id).map_err(|err| err.to_string())?;
        let mut members = Vec::with_capacity(self.members.len() + 1);
        for raw in &self.members {
            members.push(parse_member_spec(raw)?);
        }
        if !members.iter().any(|entry| entry.peer_id() == owner.peer_id()) {
            members.push(
                MeshMemberEntry::new(
                    owner.peer_id().clone(),
                    owner.peer_id().as_str(),
                    MeshRole::Owner,
                    true,
                    false,
                )
                .map_err(|err| err.to_string())?,
            );
        }
        let roster = PeerMeshRosterV1::new(
            mesh_id,
            owner.peer_id().clone(),
            self.revision,
            now_epoch_ms()?,
            members,
        )
        .map_err(|err| err.to_string())?;
        let signed = SignedPeerMeshRosterV1::sign(roster, &owner).map_err(|err| err.to_string())?;
        let json = serde_json::to_string_pretty(&signed)?;
        if let Some(output) = self.output {
            tokio::fs::write(&output, json.as_bytes()).await?;
            println!(
                "{}",
                serde_json::json!({
                    "ownerPeerId": owner.peer_id(),
                    "output": output,
                })
            );
        } else {
            println!("{json}");
        }
        Ok(())
    }
}

impl RelayArgs {
    async fn run(self) -> Result<(), HostError> {
        let identity = NodeIdentity::load_or_create_async(self.identity)
            .await
            .map_err(|err| err.to_string())?;
        let (node, _rx) = MeshTransportNode::bind(self.listen, identity, self.max_circuits)
            .map_err(|err| err.to_string())?;
        let mut relay_authorized = false;
        if let Some(roster_path) = self.roster {
            let bytes = tokio::fs::read(&roster_path).await?;
            let signed: SignedPeerMeshRosterV1 = serde_json::from_slice(&bytes)?;
            relay_authorized = signed
                .roster()
                .member(node.peer_id())
                .is_some_and(MeshMemberEntry::can_transit);
            node.set_transit_roster(signed);
        }
        for raw in &self.peers {
            let (peer_id, addr) = parse_peer_addr_spec(raw)?;
            node.set_peer_address(peer_id, addr);
        }
        let cancellation = CancellationToken::new();
        let _signals = crate::signals::watch(cancellation.clone())?;
        println!(
            "{}",
            serde_json::json!({
                "kind": "ready",
                "peerId": node.peer_id(),
                "listen": node.local_addr().to_string(),
                "relayAuthorized": relay_authorized,
            })
        );
        cancellation.cancelled().await;
        node.shutdown();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_ticket_uri_decodes_fields_and_matches_sas() {
        let host = NodeIdentity::generate().unwrap();
        let client = NodeIdentity::generate().unwrap();
        let endpoints = vec!["ws://127.0.0.1:9443".into()];
        let uri = encode_pairing_uri(&PairingTicketPayload {
            root_id: "root-demo",
            host_name: "Mac Studio",
            peer_id: host.peer_id().as_str(),
            endpoints: &endpoints,
            pairing_token: "cred-123",
            nonce: "nonce-1",
            expires_at_ms: 1_700_000_300_000,
        })
        .unwrap();

        let raw = uri.strip_prefix(PAIRING_URI_PREFIX).unwrap();
        let decoded: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(raw).unwrap()).unwrap();
        assert_eq!(decoded["rootId"], "root-demo");
        assert_eq!(decoded["peerId"], host.peer_id().as_str());
        assert_eq!(decoded["pairingToken"], "cred-123");
        assert_eq!(
            host.peer_id().short_auth_code(client.peer_id(), "nonce-1"),
            client.peer_id().short_auth_code(host.peer_id(), "nonce-1")
        );
    }
}
