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

//! The line an operator prints after `activate --framed`:
//! `MAKA_RUNTIME_HOST_ACTIVATION_V1 <base64url JSON>`.
//!
//! Source: `packages/runtime-host/src/operator/activation-frame.ts`
//! (`activationResultSchema`, `activationErrorSchema`,
//! `decodeRuntimeHostActivationFrame`). An SSH-activated profile runs the
//! operator over `ssh -T`, reads this frame from its output, and tunnels to
//! the endpoint it names (`client/ssh-operator-activation.ts`).

use serde::Deserialize;

use super::connection_code::BASE64URL;
use super::{is_canonical_websocket_path, is_js_whitespace};
use crate::is_root_id;
use base64::Engine as _;

/// `RUNTIME_HOST_ACTIVATION_FRAME_PREFIX`, including its trailing space.
pub const ACTIVATION_FRAME_PREFIX: &str = "MAKA_RUNTIME_HOST_ACTIVATION_V1 ";

/// `RUNTIME_HOST_ACTIVATION_FRAME_MAX_BYTES`: the limit of the base64url part.
pub const ACTIVATION_FRAME_MAX_BYTES: usize = 16 * 1024;

/// `RUNTIME_HOST_ACTIVATION_ERROR_CODE_MAX_BYTES`.
const ERROR_CODE_MAX_BYTES: usize = 128;

/// `RUNTIME_HOST_ACTIVATION_ERROR_MESSAGE_MAX_BYTES`.
const ERROR_MESSAGE_MAX_BYTES: usize = 2 * 1024;

/// `boundedString(128)` for `hostEpoch`.
const HOST_EPOCH_MAX_BYTES: usize = 128;

/// `boundedString(2_048)` for `endpoint.websocketPath`.
const WEBSOCKET_PATH_FIELD_MAX_BYTES: usize = 2_048;

/// `Number.MAX_SAFE_INTEGER`, the bound of zod's `.safe()`.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// A decoded activation frame.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ActivationFrame {
    /// `kind: "result"`: the Host runs and listens at `endpoint`.
    Result(ActivationResult),
    /// `kind: "error"`: the operator could not activate the Host.
    Error(ActivationFailure),
}

/// `RuntimeHostActivationResult`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ActivationResult {
    pub deployment_id: String,
    pub config_revision: u64,
    pub root_id: String,
    pub host_epoch: String,
    pub pid: u64,
    pub protocol_version: u64,
    pub endpoint: ActivationEndpoint,
}

/// Where the activated Host listens, on the operator's machine.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ActivationEndpoint {
    /// Always `127.0.0.1`: reachable only through the SSH forward.
    pub host: String,
    pub port: u16,
    pub websocket_path: String,
}

/// The `error` of an error frame.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[non_exhaustive]
pub struct ActivationFailure {
    pub code: String,
    pub message: String,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum WireFrame {
    #[serde(rename_all = "camelCase")]
    Result {
        schema_version: u64,
        #[serde(flatten)]
        result: ActivationResult,
    },
    #[serde(rename_all = "camelCase")]
    Error { schema_version: u64, error: ActivationFailure },
}

/// `decodeRuntimeHostActivationFrame`: the frame on `line`, or `None` when
/// the line is not a valid frame.
pub fn decode_activation_frame(line: &str) -> Option<ActivationFrame> {
    let encoded = line.strip_prefix(ACTIVATION_FRAME_PREFIX)?.trim_matches(is_js_whitespace);
    if encoded.is_empty() || encoded.len() > ACTIVATION_FRAME_MAX_BYTES {
        return None;
    }
    let bytes = BASE64URL.decode(encoded).ok()?;
    match serde_json::from_slice(&bytes).ok()? {
        WireFrame::Result { schema_version: 1, result } => {
            valid_result(&result).then_some(ActivationFrame::Result(result))
        }
        WireFrame::Error { schema_version: 1, error } => {
            let valid = bounded(&error.code, ERROR_CODE_MAX_BYTES)
                && bounded(&error.message, ERROR_MESSAGE_MAX_BYTES);
            valid.then_some(ActivationFrame::Error(error))
        }
        _ => None,
    }
}

fn valid_result(result: &ActivationResult) -> bool {
    let positive_safe = |value: u64| (1..=MAX_SAFE_INTEGER).contains(&value);
    is_zod_uuid(&result.deployment_id)
        && positive_safe(result.config_revision)
        && is_root_id(&result.root_id)
        && bounded(&result.host_epoch, HOST_EPOCH_MAX_BYTES)
        && positive_safe(result.pid)
        && result.protocol_version <= MAX_SAFE_INTEGER
        && result.endpoint.host == "127.0.0.1"
        && result.endpoint.port != 0
        && bounded(&result.endpoint.websocket_path, WEBSOCKET_PATH_FIELD_MAX_BYTES)
        && is_canonical_websocket_path(&result.endpoint.websocket_path)
}

/// zod's `.string().min(1).refine(byteLength <= max)`.
fn bounded(value: &str, max_bytes: usize) -> bool {
    !value.is_empty() && value.len() <= max_bytes
}

/// zod 4's `z.string().uuid()`: an RFC 9562 UUID (version 1–8, variant
/// `10xx`) in either case, or the nil or max UUID.
fn is_zod_uuid(value: &str) -> bool {
    if value == "00000000-0000-0000-0000-000000000000"
        || value.eq_ignore_ascii_case("ffffffff-ffff-ffff-ffff-ffffffffffff")
    {
        return true;
    }
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
        && (b'1'..=b'8').contains(&bytes[14])
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B')
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use serde_json::{Value, json};

    const ROOT_ID: &str = "67d440f2c07d4cf4e9f56a52aa2bf8e435c71602ddda6244987e201de0c4fb8d";

    /// `encodeRuntimeHostActivationFrame` at the pin (Node 24.18).
    const RESULT_FRAME: &str = "MAKA_RUNTIME_HOST_ACTIVATION_V1 eyJzY2hlbWFWZXJzaW9uIjoxLCJraW5kIjoicmVzdWx0IiwiZGVwbG95bWVudElkIjoiOWMwYTNhNWUtMWY1ZC00YjhlLTlkM2MtMGU2ZjdhMWJiOTEyIiwiY29uZmlnUmV2aXNpb24iOjMsInJvb3RJZCI6IjY3ZDQ0MGYyYzA3ZDRjZjRlOWY1NmE1MmFhMmJmOGU0MzVjNzE2MDJkZGRhNjI0NDk4N2UyMDFkZTBjNGZiOGQiLCJob3N0RXBvY2giOiJlcG9jaC0xIiwicGlkIjo0MjQyLCJwcm90b2NvbFZlcnNpb24iOjAsImVuZHBvaW50Ijp7Imhvc3QiOiIxMjcuMC4wLjEiLCJwb3J0Ijo0ODEyMywid2Vic29ja2V0UGF0aCI6Ii9ydW50aW1lLWhvc3QifX0\n";
    const ERROR_FRAME: &str = "MAKA_RUNTIME_HOST_ACTIVATION_V1 eyJzY2hlbWFWZXJzaW9uIjoxLCJraW5kIjoiZXJyb3IiLCJlcnJvciI6eyJjb2RlIjoicm9vdF9taXNtYXRjaCIsIm1lc3NhZ2UiOiJUaGUgbWFuYWdlZCByb290IGRvZXMgbm90IG1hdGNoIn19\n";

    fn result_value() -> Value {
        json!({
            "schemaVersion": 1,
            "kind": "result",
            "deploymentId": "9c0a3a5e-1f5d-4b8e-9d3c-0e6f7a1bb912",
            "configRevision": 3,
            "rootId": ROOT_ID,
            "hostEpoch": "epoch-1",
            "pid": 4242,
            "protocolVersion": 0,
            "endpoint": {"host": "127.0.0.1", "port": 48123, "websocketPath": "/runtime-host"}
        })
    }

    fn frame(value: &Value) -> String {
        let json = serde_json::to_vec(value).expect("encode");
        format!("{ACTIVATION_FRAME_PREFIX}{}", URL_SAFE_NO_PAD.encode(json))
    }

    #[test]
    fn the_operators_frames_decode() {
        let Some(ActivationFrame::Result(result)) = decode_activation_frame(RESULT_FRAME) else {
            panic!("expected a result frame");
        };
        assert_eq!(result.root_id, ROOT_ID);
        assert_eq!(result.host_epoch, "epoch-1");
        assert_eq!(result.endpoint.port, 48123);
        assert_eq!(result.endpoint.websocket_path, "/runtime-host");

        let Some(ActivationFrame::Error(error)) = decode_activation_frame(ERROR_FRAME) else {
            panic!("expected an error frame");
        };
        assert_eq!(error.code, "root_mismatch");
        assert_eq!(error.message, "The managed root does not match");
    }

    #[test]
    fn anything_else_is_not_a_frame() {
        let with = |pointer: &str, replacement: Value| {
            let mut value = result_value();
            *value.pointer_mut(pointer).expect("field") = replacement;
            frame(&value)
        };
        for line in [
            String::new(),
            "hello".to_owned(),
            format!("MAKA_RUNTIME_HOST_ACTIVATION_V2 {}", &RESULT_FRAME[32..]),
            ACTIVATION_FRAME_PREFIX.to_owned(),
            format!("{ACTIVATION_FRAME_PREFIX}not base64!"),
            format!("{ACTIVATION_FRAME_PREFIX}{}", "A".repeat(ACTIVATION_FRAME_MAX_BYTES + 4)),
            with("/schemaVersion", json!(2)),
            with("/deploymentId", json!("9c0a3a5e-1f5d-0b8e-9d3c-0e6f7a1bb912")),
            with("/deploymentId", json!("9c0a3a5e-1f5d-4b8e-7d3c-0e6f7a1bb912")),
            with("/configRevision", json!(0)),
            with("/rootId", json!(ROOT_ID.to_uppercase())),
            with("/hostEpoch", json!("")),
            with("/hostEpoch", json!("e".repeat(129))),
            with("/pid", json!(0)),
            with("/pid", json!(MAX_SAFE_INTEGER + 1)),
            with("/protocolVersion", json!(-1)),
            with("/endpoint/host", json!("0.0.0.0")),
            with("/endpoint/port", json!(0)),
            with("/endpoint/port", json!(65536)),
            with("/endpoint/websocketPath", json!("/a/../b")),
        ] {
            assert_eq!(decode_activation_frame(&line), None, "{line:.80}");
        }
    }

    #[test]
    fn uuid_rules_follow_zod() {
        // `z.string().uuid()` in zod 4.6.5, recorded with Node 24.18.
        for (value, valid) in [
            ("9c0a3a5e-1f5d-4b8e-9d3c-0e6f7a1bb912", true),
            ("9c0a3a5e-1f5d-0b8e-9d3c-0e6f7a1bb912", false),
            ("9C0A3A5E-1F5D-4B8E-9D3C-0E6F7A1BB912", true),
            ("9c0a3a5e-1f5d-4b8e-7d3c-0e6f7a1bb912", false),
            ("00000000-0000-0000-0000-000000000000", true),
            ("ffffffff-ffff-ffff-ffff-ffffffffffff", true),
            ("9c0a3a5e1f5d4b8e9d3c0e6f7a1bb912", false),
        ] {
            assert_eq!(is_zod_uuid(value), valid, "{value}");
        }
    }

    #[test]
    fn padding_and_surrounding_whitespace_are_accepted() {
        let unpadded = frame(&result_value());
        let encoded_len = unpadded.len() - ACTIVATION_FRAME_PREFIX.len();
        let padded = format!("{unpadded}{}", "=".repeat((4 - encoded_len % 4) % 4));
        assert!(decode_activation_frame(&format!("{padded} \r")).is_some());
    }
}
