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

mod identity;

pub use identity::{DeviceIdentity, DevicePublicKey, parse_peer_id};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::{fmt, io};
use url::Url;

const URI_PREFIX: &str = "maka://pair/v1?payload=";
const TICKET_DOMAIN: &[u8] = b"maka.remote.pairing.v1\0";
/// Export 32 bytes with this label and an empty exporter context on the
/// authenticated connection used for redemption.
pub const SAS_EXPORTER_LABEL: &[u8] = b"EXPORTER-maka-remote-pairing-v1";

/// Host transport adapters and local ticket issuance share this State Root key.
pub const HOST_IDENTITY_FILE: &str = "remote-host.ed25519";

#[derive(Debug, thiserror::Error)]
pub enum PairingError {
    #[error("invalid canonical Ed25519 peer ID")]
    PeerId,
    #[error("invalid identity file (expected a 32-byte private key with mode 0600 on Unix)")]
    IdentityFile,
    #[error("invalid pairing URI")]
    Uri,
    #[error("invalid pairing ticket field: {0}")]
    Field(&'static str),
    #[error("pairing requires at least one native relay route")]
    NoNativeRelay,
    #[error("HTTPS relay URLs require a DNS name or IPv4 literal, not an IPv6 literal")]
    HttpsRelayIpv6,
    #[error("a relay certificate pin requires https://")]
    RelayPinRequiresHttps,
    #[error("invalid Host pairing signature")]
    Signature,
    #[error("pairing ticket has expired")]
    Expired,
    #[error("pairing identity I/O failed")]
    Io(#[from] io::Error),
    #[error("could not generate an identity")]
    Random(#[source] getrandom::Error),
    #[error("invalid pairing JSON")]
    Json(#[from] serde_json::Error),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelayEndpoint {
    pub url: String,
    pub quic_port: Option<u16>,
    pub cert_sha256: Option<String>,
}

/// Parsed public relay settings, shared by ticket validation and native dialing.
pub struct ValidatedRelayEndpoint {
    pub url: Url,
    pub quic_port: Option<u16>,
    pub cert_sha256: Option<[u8; 32]>,
}

impl RelayEndpoint {
    pub fn validate(&self) -> Result<ValidatedRelayEndpoint, PairingError> {
        use PairingError::Field;
        let (url, _) = endpoint_url(&self.url).ok_or(Field("relay.url"))?;
        match (url.scheme(), url.host()) {
            ("https", Some(url::Host::Ipv6(_))) => return Err(PairingError::HttpsRelayIpv6),
            ("https" | "http", Some(url::Host::Domain(host))) => {
                rustls_pki_types::DnsName::try_from(host).map_err(|_| Field("relay.url"))?;
            }
            ("https" | "http", Some(_)) => {}
            _ => return Err(Field("relay.url")),
        }
        if self.quic_port == Some(0) {
            return Err(Field("relay.quicPort"));
        }
        let cert_sha256 = if let Some(cert) = &self.cert_sha256 {
            if url.scheme() != "https" {
                return Err(PairingError::RelayPinRequiresHttps);
            }
            let mut digest = [0; 32];
            hex::decode_to_slice(cert, &mut digest).map_err(|_| Field("relay.certSha256"))?;
            Some(digest)
        } else {
            None
        };
        Ok(ValidatedRelayEndpoint {
            url,
            quic_port: self.quic_port,
            cert_sha256,
        })
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairingTicketPayload {
    pub version: u8,
    pub root_id: String,
    pub host_name: String,
    pub host_peer_id: String,
    pub relays: Vec<RelayEndpoint>,
    #[serde(default)]
    pub direct_endpoints: Vec<String>,
    pub invite_id: String,
    pub invite_secret: String,
    pub expires_at_ms: u64,
}

impl fmt::Debug for PairingTicketPayload {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PairingTicketPayload")
            .field("invite_id", &self.invite_id)
            .field("expires_at_ms", &self.expires_at_ms)
            .finish_non_exhaustive()
    }
}

impl PairingTicketPayload {
    fn validate(&self) -> Result<DevicePublicKey, PairingError> {
        use PairingError::Field;
        if self.version != 1 {
            return Err(Field("version"));
        }
        if self.root_id.is_empty()
            || self.root_id == "."
            || self.root_id.contains("..")
            || self.root_id.contains(['/', '\\', ':'])
            || self.root_id.chars().any(char::is_control)
        {
            return Err(Field("rootId"));
        }
        if self.host_name.trim().is_empty() {
            return Err(Field("hostName"));
        }
        if self.invite_id.is_empty() || self.invite_secret.is_empty() {
            return Err(Field("invite"));
        }
        validate_endpoints(&self.relays, &self.direct_endpoints)?;
        parse_peer_id(&self.host_peer_id)
    }
}

fn validate_endpoints(relays: &[RelayEndpoint], direct: &[String]) -> Result<(), PairingError> {
    use PairingError::Field;
    if relays.is_empty() {
        return Err(PairingError::NoNativeRelay);
    }
    for relay in relays {
        relay.validate()?;
    }
    for endpoint in direct {
        let (url, authority) = endpoint_url(endpoint).ok_or(Field("directEndpoints"))?;
        match (url.scheme(), url.host()) {
            ("wss", _) => {}
            ("ws", Some(url::Host::Domain("localhost"))) => {}
            ("ws", Some(url::Host::Ipv4(ip))) if ip.is_loopback() => {
                // WHATWG normalizes non-canonical IPv4 forms like 127.1.
                if authority.split(':').next() != url.host_str() {
                    return Err(Field("directEndpoints"));
                }
            }
            ("ws", Some(url::Host::Ipv6(ip))) if ip.is_loopback() => {}
            _ => return Err(Field("directEndpoints")),
        }
    }
    Ok(())
}

fn endpoint_url(raw: &str) -> Option<(Url, &str)> {
    let (scheme, rest) = raw.split_once(':')?;
    let authority = rest.strip_prefix("//")?.split(['/', '?', '#']).next()?;
    if authority.is_empty()
        || authority.contains('@')
        || raw.contains('\\')
        || raw.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return None;
    }
    let url = Url::parse(raw).ok()?;
    (scheme.eq_ignore_ascii_case(url.scheme())
        && url.has_host()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && url.port() != Some(0))
    .then_some((url, authority))
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    payload: String,
    signature: String,
}

pub struct SignedPairingTicket {
    payload: PairingTicketPayload,
    envelope: Envelope,
}

impl fmt::Debug for SignedPairingTicket {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("SignedPairingTicket")
            .field(&self.payload)
            .finish()
    }
}

impl SignedPairingTicket {
    pub fn sign(
        payload: PairingTicketPayload,
        identity: &DeviceIdentity,
    ) -> Result<Self, PairingError> {
        if payload.validate()? != identity.public_key() {
            return Err(PairingError::Signature);
        }
        let bytes = serde_json::to_vec(&payload)?;
        let envelope = Envelope {
            payload: URL_SAFE_NO_PAD.encode(&bytes),
            signature: URL_SAFE_NO_PAD.encode(identity.sign(TICKET_DOMAIN, &bytes)),
        };
        Ok(Self { payload, envelope })
    }

    pub fn payload(&self) -> &PairingTicketPayload {
        &self.payload
    }

    pub fn to_uri(&self) -> Result<String, PairingError> {
        Ok(format!(
            "{URI_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&self.envelope)?)
        ))
    }

    pub fn parse_and_verify_uri(uri: &str, now_ms: u64) -> Result<Self, PairingError> {
        let encoded = uri.strip_prefix(URI_PREFIX).ok_or(PairingError::Uri)?;
        let envelope: Envelope = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(encoded)
                .map_err(|_| PairingError::Uri)?,
        )?;
        let bytes = URL_SAFE_NO_PAD
            .decode(&envelope.payload)
            .map_err(|_| PairingError::Uri)?;
        let mut signature = [0; 64];
        if URL_SAFE_NO_PAD
            .decode_slice(&envelope.signature, &mut signature)
            .ok()
            != Some(64)
        {
            return Err(PairingError::Signature);
        }
        let payload: PairingTicketPayload = serde_json::from_slice(&bytes)?;
        payload
            .validate()?
            .verify(TICKET_DOMAIN, &bytes, &signature)?;
        if payload.expires_at_ms <= now_ms {
            return Err(PairingError::Expired);
        }
        Ok(Self { payload, envelope })
    }
}

/// Both sides pass endpoint keys in Host/client order, not local/remote order.
pub fn derive_handshake_sas(
    host_peer_id: &DevicePublicKey,
    client_peer_id: &DevicePublicKey,
    handshake_exporter: &[u8; 32],
) -> String {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(handshake_exporter).expect("HMAC accepts any key length");
    mac.update(b"maka.remote.pairing.sas.v1\0");
    mac.update(host_peer_id.as_bytes());
    mac.update(client_peer_id.as_bytes());
    let digest = mac.finalize().into_bytes();
    let code = u64::from_be_bytes(digest[..8].try_into().unwrap()) % 1_000_000;
    format!("{code:06}")
}
