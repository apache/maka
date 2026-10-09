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

//! `registration.json`: how a running Host announces its endpoint.
//!
//! Source: `HostRegistration` and `decodeHostRegistration` in
//! `packages/runtime-host/src/protocol/index.ts`; the file is read by
//! `readHostRegistration` in `packages/runtime-host/src/control/registration.ts`.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::compat::{default_composition_id, legacy_composition_revision};
use crate::{HostLifecycleState, ProtocolRange, REGISTRATION_SCHEMA_VERSION, is_root_id};

wire_enum! {
    /// `HostRegistration.lifecycleMode`.
    pub enum HostLifecycleMode {
        /// Exits after its idle grace period once no client is connected.
        Ephemeral = "ephemeral",
        /// Runs until stopped (`maka runtime-host serve`).
        Service = "service",
    }
}

/// The contents of `registration.json` in a State Root's control directory.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct HostRegistration {
    /// Always `maka-runtime-host`.
    pub kind: String,
    /// Always [`REGISTRATION_SCHEMA_VERSION`].
    pub schema_version: u32,
    pub root_id: String,
    pub host_epoch: String,
    /// Local IPC endpoint: a Unix domain socket path, or a named pipe on
    /// Windows. At most 512 characters.
    pub endpoint: String,
    /// 1–4 loopback `ws://127.0.0.1:<port>/…` URLs when the Host also serves
    /// WebSocket.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub websocket_endpoints: Option<Vec<String>>,
    pub protocol_min: u32,
    pub protocol_max: u32,
    /// Absent means epoch 0.
    #[serde(default)]
    pub compatibility_epoch: u32,
    #[serde(default = "default_composition_id")]
    pub composition_id: String,
    #[serde(default = "legacy_composition_revision")]
    pub composition_revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifecycle_mode: Option<HostLifecycleMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation: Option<String>,
    pub state: HostLifecycleState,
    pub pid: u32,
    /// ISO-8601 timestamp written by the Host.
    pub created_at: String,
}

/// A registration that parsed but violates `decodeHostRegistration`.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum InvalidRegistration {
    #[error("registration is not valid JSON for its schema")]
    Json(#[source] serde_json::Error),
    #[error("invalid registration kind {0:?}")]
    Kind(String),
    #[error("unsupported registration schema version {0}")]
    SchemaVersion(u32),
    #[error("invalid registration rootId")]
    RootId,
    #[error("invalid registration protocol range")]
    ProtocolRange,
    #[error("invalid registration endpoint")]
    Endpoint,
    #[error("invalid registration pid")]
    Pid,
}

impl HostRegistration {
    const KIND: &'static str = "maka-runtime-host";

    /// Parses and validates the bytes of `registration.json`.
    pub fn decode(bytes: &[u8]) -> Result<Self, InvalidRegistration> {
        let registration: Self =
            serde_json::from_slice(bytes).map_err(InvalidRegistration::Json)?;
        registration.validate()?;
        Ok(registration)
    }

    /// Checks the invariants `decodeHostRegistration` enforces beyond shape.
    pub fn validate(&self) -> Result<(), InvalidRegistration> {
        if self.kind != Self::KIND {
            return Err(InvalidRegistration::Kind(self.kind.clone()));
        }
        if self.schema_version != REGISTRATION_SCHEMA_VERSION {
            return Err(InvalidRegistration::SchemaVersion(self.schema_version));
        }
        if !is_root_id(&self.root_id) {
            return Err(InvalidRegistration::RootId);
        }
        if self.protocol_max < self.protocol_min {
            return Err(InvalidRegistration::ProtocolRange);
        }
        if self.endpoint.is_empty() || self.endpoint.chars().count() > 512 {
            return Err(InvalidRegistration::Endpoint);
        }
        if self.pid == 0 {
            return Err(InvalidRegistration::Pid);
        }
        Ok(())
    }

    /// The protocol range the Host advertises.
    pub fn protocol_range(&self) -> ProtocolRange {
        ProtocolRange::new(self.protocol_min, self.protocol_max)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn registration_json() -> serde_json::Value {
        json!({
            "kind": "maka-runtime-host",
            "schemaVersion": 1,
            "rootId": "67d440f2c07d4cf4e9f56a52aa2bf8e435c71602ddda6244987e201de0c4fb8d",
            "hostEpoch": "9c0a30d0-c11f-411d-8ff2-db277595b912",
            "endpoint": "/tmp/m-501-abc/h.sock",
            "protocolMin": 0,
            "protocolMax": 0,
            "state": "ready",
            "pid": 11501,
            "createdAt": "2026-09-24T16:39:46.703Z"
        })
    }

    #[test]
    fn minimal_registration_applies_defaults() {
        let bytes = serde_json::to_vec(&registration_json()).expect("encode");
        let registration = HostRegistration::decode(&bytes).expect("decode");
        assert_eq!(registration.compatibility_epoch, 0);
        assert_eq!(registration.composition_id, "maka.interactive");
        assert_eq!(registration.composition_revision, "legacy");
        assert_eq!(registration.lifecycle_mode, None);
        assert_eq!(registration.protocol_range(), ProtocolRange::new(0, 0));
    }

    #[test]
    fn invariant_violations_are_rejected() {
        let cases = [
            ("kind", json!("other")),
            ("schemaVersion", json!(2)),
            ("rootId", json!("ABC")),
            ("protocolMin", json!(3)),
            ("endpoint", json!("")),
            ("pid", json!(0)),
        ];
        for (field, value) in cases {
            let mut registration = registration_json();
            registration[field] = value;
            let bytes = serde_json::to_vec(&registration).expect("encode");
            assert!(HostRegistration::decode(&bytes).is_err(), "{field} should be rejected");
        }
    }
}
