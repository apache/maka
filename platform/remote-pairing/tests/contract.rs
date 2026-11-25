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

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use maka_remote_pairing::{
    DeviceIdentity, PairingError, PairingTicketPayload, RelayEndpoint, SignedPairingTicket,
    derive_handshake_sas, parse_peer_id,
};
use serde_json::{Value, json};
use zeroize::Zeroizing;

const PREFIX: &str = "maka://pair/v1?payload=";
const SECRET: &str = "maka_pi_fixture_secret";

fn identity(seed: u8) -> DeviceIdentity {
    DeviceIdentity::from_secret(Zeroizing::new([seed; 32]))
}

fn payload(host: &DeviceIdentity) -> PairingTicketPayload {
    PairingTicketPayload {
        version: 1,
        root_id: "test-root".into(),
        host_name: "Host".into(),
        host_peer_id: host.public_key().to_string(),
        relays: vec![RelayEndpoint {
            url: "https://relay.example".into(),
            quic_port: Some(443),
            cert_sha256: Some("ab".repeat(32)),
        }],
        direct_endpoints: vec!["wss://host.example".into(), "ws://127.0.0.1:8787".into()],
        invite_id: "invite".into(),
        invite_secret: SECRET.into(),
        expires_at_ms: 100,
    }
}

#[test]
fn ticket_verifies_only_for_exact_signed_payload_and_before_expiry() {
    let host = identity(1);
    let ticket = SignedPairingTicket::sign(payload(&host), &host).unwrap();
    let uri = ticket.to_uri().unwrap();
    let decoded = SignedPairingTicket::parse_and_verify_uri(&uri, 99).unwrap();
    assert_eq!(
        serde_json::to_value(decoded.payload()).unwrap(),
        serde_json::to_value(payload(&host)).unwrap(),
    );
    assert!(!format!("{decoded:?} {:?}", decoded.payload()).contains(SECRET));
    assert!(matches!(
        SignedPairingTicket::parse_and_verify_uri(&uri, 100),
        Err(PairingError::Expired)
    ));
    assert!(SignedPairingTicket::parse_and_verify_uri(&format!("{uri}&extra=1"), 99).is_err());
    assert!(SignedPairingTicket::parse_and_verify_uri(&uri.replace("/v1?", "/v2?"), 99).is_err());

    let envelope: Value = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(uri.strip_prefix(PREFIX).unwrap())
            .unwrap(),
    )
    .unwrap();
    let bytes = URL_SAFE_NO_PAD
        .decode(envelope["payload"].as_str().unwrap())
        .unwrap();
    let unsigned: Value = serde_json::from_slice(&bytes).unwrap();
    for (field, value) in [
        ("rootId", json!("other-root")),
        ("hostName", json!("Wrong host")),
        ("hostPeerId", json!(identity(2).public_key().to_string())),
        ("directEndpoints", json!(["wss://other.example"])),
        ("relays", json!([{"url":"https://other.example"}])),
        ("inviteId", json!("other-invite")),
        ("inviteSecret", json!("maka_pi_other_secret")),
        ("expiresAtMs", json!(101)),
    ] {
        let mut payload = unsigned.clone();
        payload[field] = value;
        let mut modified = envelope.clone();
        modified["payload"] = json!(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap()));
        let tampered = format!(
            "{PREFIX}{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&modified).unwrap())
        );
        assert!(
            matches!(
                SignedPairingTicket::parse_and_verify_uri(&tampered, 99),
                Err(PairingError::Signature)
            ),
            "{field}"
        );
    }
}

#[test]
fn invalid_dial_targets_cannot_be_signed() {
    let host = identity(1);
    for direct in [
        "ws://lan.example",
        "ws://127.1",
        "ws://localhost.example",
        "ws://localhost@lan.example",
        "wss://user:pass@host.example/path?next=https://other.example",
        "wss:user@host.example/path?next=https://other.example",
        "wss:///host.example",
        "wss://host.example:0",
        "wss://",
        "host.example",
    ] {
        let mut ticket = payload(&host);
        ticket.direct_endpoints = vec![direct.into()];
        assert!(
            SignedPairingTicket::sign(ticket, &host).is_err(),
            "{direct}"
        );
    }
    let mut ticket = payload(&host);
    ticket.direct_endpoints = vec![
        "ws://localhost:8080".into(),
        "ws://[::1]:8080".into(),
        "ws://127.0.0.2:8989".into(),
    ];
    assert!(SignedPairingTicket::sign(ticket, &host).is_ok());
    for (url, port, cert) in [
        ("ftp://relay.example", None, None),
        ("https://", None, None),
        ("https://-invalid.example", None, None),
        ("https://[::1]:3340", None, None),
        ("http://relay.example", None, Some("ab".repeat(32))),
        (
            "https:user:pass@relay.example/?next=http://other.example",
            None,
            None,
        ),
        ("http://relay.example", Some(0), None),
        ("https://relay.example", None, Some("not-a-pin".into())),
    ] {
        let mut ticket = payload(&host);
        ticket.relays = vec![RelayEndpoint {
            url: url.into(),
            quic_port: port,
            cert_sha256: cert,
        }];
        assert!(SignedPairingTicket::sign(ticket, &host).is_err());
    }
    let mut ticket = payload(&host);
    ticket.relays.clear();
    assert!(matches!(
        SignedPairingTicket::sign(ticket, &host),
        Err(PairingError::NoNativeRelay)
    ));
}

#[test]
fn both_sides_confirm_the_same_exported_handshake() {
    let host = identity(1);
    let client = identity(2);
    let remote_host = parse_peer_id(&host.public_key().to_string()).unwrap();
    let remote_client = parse_peer_id(&client.public_key().to_string()).unwrap();
    let mut exporter = [7; 32];
    let host_code = derive_handshake_sas(&host.public_key(), &remote_client, &exporter);
    assert_eq!(
        host_code,
        derive_handshake_sas(&remote_host, &client.public_key(), &exporter)
    );
    assert_eq!(host_code.len(), 6);
    assert!(host_code.bytes().all(|b| b.is_ascii_digit()));
    exporter[0] ^= 1;
    assert_ne!(
        host_code,
        derive_handshake_sas(&remote_host, &remote_client, &exporter)
    );
}

#[test]
fn identity_survives_restart_with_a_canonical_id_and_private_permissions() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("keys/device.ed25519");
    let key = DeviceIdentity::load_or_create(&path).unwrap().public_key();
    assert_eq!(
        DeviceIdentity::load_or_create(&path).unwrap().public_key(),
        key
    );
    assert_eq!(parse_peer_id(&key.to_string()).unwrap(), key);
    assert!(parse_peer_id(&key.to_string().to_uppercase()).is_err());
    assert!(parse_peer_id(&"00".repeat(32)).is_err());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = std::fs::metadata(&path).unwrap().permissions();
        assert_eq!(permissions.mode() & 0o777, 0o600);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(matches!(
            DeviceIdentity::load_or_create(&path),
            Err(PairingError::IdentityFile)
        ));
    }
}
