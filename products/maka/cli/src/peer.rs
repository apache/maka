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

//! CLI commands for P2P node identity, pairing ticket generation, and SAS verification.

use crate::{access, args::Root, host_client::HostClient};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use clap::{Args, Subcommand};
use maka_event_log::root;
use maka_host_runtime::HostError;
use maka_peer::{NodeIdentity, PeerId};
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
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
        }
    }
}

fn identity_file_path(root_dir: &Path) -> PathBuf {
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
