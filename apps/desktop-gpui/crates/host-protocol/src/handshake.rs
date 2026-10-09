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

//! The connection handshake: `hello` → `accepted | incompatible | draining`.
//!
//! Source: `ClientHello`, `HostAccepted`, `HostIncompatible`, `HostDraining`,
//! `decodeClientFrame` and `decodeHostFrame` in
//! `packages/runtime-host/src/protocol/index.ts`; the client's hello is built
//! by `exchangeRuntimeHostHandshake` in `client/connection.ts`.

use serde::{Deserialize, Serialize};

use crate::compat::{default_composition_id, legacy_composition_revision};
use crate::{
    COMPOSITION_ID, ClientInstanceId, HostLifecycleState, RUNTIME_HOST_COMPATIBILITY_EPOCH,
    SUPPORTED_PROTOCOLS,
};

wire_tag! {
    /// `ClientHello.kind`.
    HelloKind = "hello"
}

/// The first frame a client sends (`ClientHello`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ClientHello {
    kind: HelloKind,
    pub client_instance_id: ClientInstanceId,
    pub protocol_min: u32,
    pub protocol_max: u32,
    pub compatibility_epoch: u32,
    pub composition_id: String,
    /// Host generation for ephemeral takeover flows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation: Option<String>,
    /// Requires `generation` (`decodeClientFrame` rejects it otherwise).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub takeover: Option<Takeover>,
    /// `2` opts in to maintenance evidence in the activity snapshot and to the
    /// `cooperativeHandoff` capability on `accepted`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity_snapshot_version: Option<u32>,
    /// `LegacySurfaceClientHello.surface` in `client/connection.ts`: released
    /// Hosts through v0.1.11 require it to decode the hello at all, so the TS
    /// client always sends `"desktop"`. Current Hosts ignore it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface: Option<String>,
}

impl ClientHello {
    /// A hello equivalent to the one the TS desktop and CLI clients send:
    /// the supported protocol range, the current compatibility epoch, the
    /// interactive composition, activity snapshot version 2, and the legacy
    /// `surface: "desktop"` sentinel.
    pub fn new(client_instance_id: ClientInstanceId) -> Self {
        Self {
            kind: HelloKind,
            client_instance_id,
            protocol_min: SUPPORTED_PROTOCOLS.min,
            protocol_max: SUPPORTED_PROTOCOLS.max,
            compatibility_epoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
            composition_id: COMPOSITION_ID.to_owned(),
            generation: None,
            takeover: None,
            activity_snapshot_version: Some(2),
            surface: Some("desktop".to_owned()),
        }
    }
}

/// `ClientHello.takeover` (`decodeTakeover`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct Takeover {
    pub expected_host_epoch: String,
}

impl Takeover {
    /// A takeover request for the Host with `expected_host_epoch`.
    pub fn new(expected_host_epoch: impl Into<String>) -> Self {
        Self { expected_host_epoch: expected_host_epoch.into() }
    }
}

/// The Host's answer to `hello` (`HostHandshakeResult`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
pub enum HandshakeResult {
    Accepted(HostAccepted),
    Incompatible(HostIncompatible),
    Draining(HostDraining),
}

impl HandshakeResult {
    /// The Host epoch every handshake result carries.
    pub fn host_epoch(&self) -> &str {
        match self {
            Self::Accepted(accepted) => &accepted.host_epoch,
            Self::Incompatible(incompatible) => &incompatible.host_epoch,
            Self::Draining(draining) => &draining.host_epoch,
        }
    }
}

/// `HostAccepted` (`decodeHostFrame`, `kind: "accepted"`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct HostAccepted {
    pub root_id: String,
    pub host_epoch: String,
    pub connection_id: String,
    pub selected_protocol: u32,
    /// Absent means epoch 0 (`decodeCompatibilityEpoch`).
    #[serde(default)]
    pub compatibility_epoch: u32,
    #[serde(default = "default_composition_id")]
    pub composition_id: String,
    #[serde(default = "legacy_composition_revision")]
    pub composition_revision: String,
    /// Never `draining` on a well-formed frame (`requireAcceptedState`).
    pub state: HostLifecycleState,
    /// Present (always `true`) when the Host supports cooperative handoff and
    /// the hello opted in with `activitySnapshotVersion: 2`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cooperative_handoff: Option<bool>,
}

wire_enum! {
    /// `HostIncompatible.replacement` (`requireReplacement`).
    pub enum ReplacementDisposition {
        BlockedByResidency = "blocked_by_residency",
        WaitForIdleExit = "wait_for_idle_exit",
    }
}

/// `HostIncompatible` (`decodeHostFrame`, `kind: "incompatible"`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct HostIncompatible {
    pub host_epoch: String,
    pub protocol_min: u32,
    pub protocol_max: u32,
    #[serde(default)]
    pub compatibility_epoch: u32,
    #[serde(default = "default_composition_id")]
    pub composition_id: String,
    #[serde(default = "legacy_composition_revision")]
    pub composition_revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation: Option<String>,
    pub state: HostLifecycleState,
    pub replacement: ReplacementDisposition,
    /// Sent to local owners that opted in with `activitySnapshotVersion: 2`
    /// or requested a generation takeover.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity: Option<HostActivitySnapshot>,
}

/// `HostDraining` (`decodeHostFrame`, `kind: "draining"`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct HostDraining {
    pub host_epoch: String,
    #[serde(default = "default_composition_id")]
    pub composition_id: String,
    #[serde(default = "legacy_composition_revision")]
    pub composition_revision: String,
}

/// `HostActivitySnapshot` (`decodeHostActivitySnapshot` in `host-status.ts`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct HostActivitySnapshot {
    pub connections: u64,
    pub active_operations: u64,
    pub process_uptime_seconds: u64,
    pub residencies: Vec<HostResidency>,
    /// Negotiated maintenance evidence; absent on released Hosts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drain_residencies: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cooperative_handoff: Option<bool>,
}

/// One labelled residency count inside [`HostActivitySnapshot`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct HostResidency {
    pub label: String,
    pub count: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn hello() -> ClientHello {
        ClientHello::new(ClientInstanceId::new("client-1").expect("valid id"))
    }

    #[test]
    fn hello_matches_the_ts_client_shape() {
        assert_eq!(
            serde_json::to_value(hello()).expect("encode"),
            json!({
                "kind": "hello",
                "clientInstanceId": "client-1",
                "protocolMin": 0,
                "protocolMax": 0,
                "compatibilityEpoch": RUNTIME_HOST_COMPATIBILITY_EPOCH,
                "compositionId": "maka.interactive",
                "activitySnapshotVersion": 2,
                "surface": "desktop"
            })
        );
    }

    #[test]
    fn hello_round_trips() {
        let mut hello = hello();
        hello.generation = Some("g1".into());
        hello.takeover = Some(Takeover::new("epoch-1"));
        let value = serde_json::to_value(&hello).expect("encode");
        assert_eq!(value["takeover"], json!({"expectedHostEpoch": "epoch-1"}));
        let decoded: ClientHello = serde_json::from_value(value).expect("decode");
        assert_eq!(decoded, hello);
    }

    #[test]
    fn accepted_applies_legacy_defaults() {
        let result: HandshakeResult = serde_json::from_value(json!({
            "kind": "accepted",
            "rootId": "r",
            "hostEpoch": "e",
            "connectionId": "c",
            "selectedProtocol": 0,
            "state": "starting"
        }))
        .expect("decode");
        let HandshakeResult::Accepted(accepted) = result else {
            panic!("expected accepted");
        };
        assert_eq!(accepted.compatibility_epoch, 0);
        assert_eq!(accepted.composition_id, "maka.interactive");
        assert_eq!(accepted.composition_revision, "legacy");
        assert_eq!(accepted.cooperative_handoff, None);
    }

    #[test]
    fn incompatible_decodes_activity() {
        let result: HandshakeResult = serde_json::from_value(json!({
            "kind": "incompatible",
            "hostEpoch": "e",
            "protocolMin": 1,
            "protocolMax": 2,
            "compatibilityEpoch": 178,
            "compositionId": "maka.interactive",
            "compositionRevision": "4",
            "state": "ready",
            "replacement": "wait_for_idle_exit",
            "activity": {
                "connections": 2,
                "activeOperations": 0,
                "processUptimeSeconds": 30,
                "residencies": [{"label": "turn", "count": 1}],
                "drainResidencies": 0
            }
        }))
        .expect("decode");
        let HandshakeResult::Incompatible(incompatible) = result else {
            panic!("expected incompatible");
        };
        assert_eq!(incompatible.replacement, ReplacementDisposition::WaitForIdleExit);
        let activity = incompatible.activity.expect("activity");
        assert_eq!(activity.residencies[0].label, "turn");
        assert_eq!(activity.drain_residencies, Some(0));
    }

    #[test]
    fn draining_decodes() {
        let result: HandshakeResult =
            serde_json::from_value(json!({"kind": "draining", "hostEpoch": "e"})).expect("decode");
        assert_eq!(result.host_epoch(), "e");
        assert!(matches!(result, HandshakeResult::Draining(_)));
    }
}
