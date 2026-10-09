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

//! Desktop's owner connection code:
//! `maka-runtime-host:connect:v2:<base64url JSON>`.
//!
//! Source: `decodeRuntimeHostOwnerConnectionCode` and `payloadSchema` in
//! `packages/runtime-host/src/client/owner-connection-code.ts`. The payload is
//! `{ schemaVersion: 2, name, rootId, transport, credential }`, the credential
//! a pending pairing credential (see [`crate::AccessCredentialFinalize`]).
//!
//! Maka issues codes only for a Direct peer (libp2p) transport, and its
//! decoder refuses any other. This decoder accepts every transport a profile
//! may name and leaves the choice to the caller, which reports the transport
//! and can use it when it is not Direct peer.

use base64::Engine as _;
use base64::alphabet::URL_SAFE;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use serde::Deserialize;
use thiserror::Error;

use super::{AccessCredential, RemoteTransport};
use crate::is_root_id;

/// The text every owner connection code starts with.
pub const OWNER_CONNECTION_CODE_PREFIX: &str = "maka-runtime-host:connect:v2:";

/// `ENCODED_MAX_BYTES`: the limit of the base64url part.
const ENCODED_MAX_BYTES: usize = 48 * 1024;

/// `nameSchema`: 1–128 bytes.
const NAME_MAX_BYTES: usize = 128;

/// Node's `Buffer.from(text, 'base64url')` accepts the text with or without
/// padding.
pub(crate) const BASE64URL: GeneralPurpose = GeneralPurpose::new(
    &URL_SAFE,
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

/// A decoded owner connection code.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct OwnerConnectionCode {
    /// The name the sharing Host suggested for itself.
    pub name: String,
    /// The State Root the Host must serve.
    pub root_id: String,
    pub transport: RemoteTransport,
    /// A pending pairing credential.
    pub credential: AccessCredential,
}

/// A string that is not an owner connection code. `reason` says what is
/// wrong, for logs; the TypeScript decoder reports only that it is invalid.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("Runtime Host connection code is invalid: {reason}")]
pub struct InvalidConnectionCode {
    reason: String,
}

impl InvalidConnectionCode {
    fn new(reason: impl Into<String>) -> Self {
        Self { reason: reason.into() }
    }

    /// What is wrong with the code.
    pub fn reason(&self) -> &str {
        &self.reason
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Payload {
    schema_version: u64,
    name: String,
    root_id: String,
    transport: RemoteTransport,
    credential: AccessCredential,
}

/// `decodeRuntimeHostOwnerConnectionCode`, except that any valid transport is
/// accepted (see the module docs).
pub fn decode_owner_connection_code(
    value: &str,
) -> Result<OwnerConnectionCode, InvalidConnectionCode> {
    let encoded = value
        .strip_prefix(OWNER_CONNECTION_CODE_PREFIX)
        .ok_or_else(|| InvalidConnectionCode::new("it does not start with the v2 prefix"))?;
    if encoded.is_empty() || encoded.len() > ENCODED_MAX_BYTES {
        return Err(InvalidConnectionCode::new("its payload is empty or too large"));
    }
    let bytes = BASE64URL
        .decode(encoded)
        .map_err(|_| InvalidConnectionCode::new("its payload is not base64url"))?;
    let payload: Payload = serde_json::from_slice(&bytes)
        .map_err(|error| InvalidConnectionCode::new(error.to_string()))?;
    if payload.schema_version != 2 {
        return Err(InvalidConnectionCode::new("its schema version is not 2"));
    }
    if payload.name.is_empty() || payload.name.len() > NAME_MAX_BYTES {
        return Err(InvalidConnectionCode::new("its name is empty or longer than 128 bytes"));
    }
    if !is_root_id(&payload.root_id) {
        return Err(InvalidConnectionCode::new("its rootId is not a State Root id"));
    }
    Ok(OwnerConnectionCode {
        name: payload.name,
        root_id: payload.root_id,
        transport: payload.transport,
        credential: payload.credential,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::RemoteTransportKind;
    use serde_json::json;

    const ROOT_ID: &str = "67d440f2c07d4cf4e9f56a52aa2bf8e435c71602ddda6244987e201de0c4fb8d";

    /// `encodeRuntimeHostOwnerConnectionCode` at the pin (Node 24.18) for a
    /// Direct peer transport, the only kind Maka issues codes for.
    const DESKTOP_CODE: &str = "maka-runtime-host:connect:v2:eyJzY2hlbWFWZXJzaW9uIjoyLCJuYW1lIjoiU3R1ZGlvIE1hYyIsInJvb3RJZCI6IjY3ZDQ0MGYyYzA3ZDRjZjRlOWY1NmE1MmFhMmJmOGU0MzVjNzE2MDJkZGRhNjI0NDk4N2UyMDFkZTBjNGZiOGQiLCJ0cmFuc3BvcnQiOnsia2luZCI6ImxpYnAycC1kaXJlY3QiLCJyZWFjaGFiaWxpdHkiOnsibGVhc2UiOnsidmVyc2lvbiI6MSwicGVlcklkIjoiMTJEM0tvb1dHekJiREpoYlkyWTRuQjFoQ0tkazlvUzhaMnhDbVQ0cGozdXF2RzFYM29ZdSIsInJldmlzaW9uIjoyLCJpc3N1ZWRBdCI6MTc5MDAwMDAwMDAwMCwiZXhwaXJlc0F0IjoxNzkwMDAwNjAwMDAwLCJkaXJlY3RSb3V0ZXMiOlsiL2lwNC8xOTIuMTY4LjEuMjAvdWRwLzQwMDEvcXVpYy12MSJdLCJjb29yZGluYXRpb25Sb3V0ZXMiOltdfSwicHVibGljS2V5IjoiQ0FFU0lDMCIsInNpZ25hdHVyZSI6ImMybG5ibUYwZFhKbCJ9fSwiY3JlZGVudGlhbCI6Im1yaGFfQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQSJ9";

    fn code_for(payload: serde_json::Value) -> String {
        let json = serde_json::to_vec(&payload).expect("encode");
        format!(
            "{OWNER_CONNECTION_CODE_PREFIX}{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json)
        )
    }

    #[test]
    fn desktops_code_decodes_and_reports_a_direct_peer() {
        let code = decode_owner_connection_code(DESKTOP_CODE).expect("decode");
        assert_eq!(code.name, "Studio Mac");
        assert_eq!(code.root_id, ROOT_ID);
        assert_eq!(code.transport.kind(), RemoteTransportKind::DirectPeer);
        assert_eq!(code.credential.expose(), format!("mrha_{}", "A".repeat(43)));
    }

    #[test]
    fn a_code_for_a_websocket_transport_decodes_too() {
        let code = code_for(json!({
            "schemaVersion": 2,
            "name": "Build box",
            "rootId": ROOT_ID,
            "transport": {"kind": "tls", "url": "wss://build.example.com/runtime-host"},
            "credential": "mrha_pending"
        }));
        let decoded = decode_owner_connection_code(&code).expect("decode");
        assert_eq!(decoded.transport.kind(), RemoteTransportKind::Tls);
        // Padding is optional, as for Node's base64url decoder.
        let encoded_len = code.len() - OWNER_CONNECTION_CODE_PREFIX.len();
        let padded = format!("{code}{}", "=".repeat((4 - encoded_len % 4) % 4));
        assert_eq!(decode_owner_connection_code(&padded), Ok(decoded));
    }

    #[test]
    fn malformed_codes_are_refused() {
        let valid = json!({
            "schemaVersion": 2,
            "name": "Build box",
            "rootId": ROOT_ID,
            "transport": {"kind": "tls", "url": "wss://build.example.com/runtime-host"},
            "credential": "mrha_pending"
        });
        let with = |field: &str, value: serde_json::Value| {
            let mut payload = valid.clone();
            payload[field] = value;
            code_for(payload)
        };
        for code in [
            String::new(),
            "maka-runtime-host:connect:v1:e30".to_owned(),
            OWNER_CONNECTION_CODE_PREFIX.to_owned(),
            format!("{OWNER_CONNECTION_CODE_PREFIX}!!!"),
            format!("{OWNER_CONNECTION_CODE_PREFIX}{}", "A".repeat(ENCODED_MAX_BYTES + 4)),
            with("schemaVersion", json!(3)),
            with("name", json!("")),
            with("name", json!("n".repeat(NAME_MAX_BYTES + 1))),
            with("rootId", json!("ABC")),
            with("credential", json!("has space")),
            with("transport", json!({"kind": "tls", "url": "ws://127.0.0.1/x"})),
        ] {
            assert!(decode_owner_connection_code(&code).is_err(), "{code:.60}");
        }
    }
}
