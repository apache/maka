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

//! `host.status`, `host.diagnostics.query`, and the Host lifecycle
//! vocabulary.
//!
//! Source: `packages/runtime-host/src/protocol/host-status.ts`
//! (`HOST_BOOTSTRAP_OPERATION_SPECS`, `decodeHostStatusResult`,
//! `decodeHostDiagnosticsResult`).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::Operation;

wire_enum! {
    /// `HostLifecycleState` (`requireHostLifecycleState`).
    pub enum HostLifecycleState {
        Starting = "starting",
        Containing = "containing",
        Recovering = "recovering",
        Ready = "ready",
        Draining = "draining",
    }
}

/// `HostStatusInput`: always the empty object (`decodeEmptyHostInput`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
pub struct HostStatusInput {}

/// `HostStatusResult` (`decodeHostStatusResult`, `decodeHostStatusFields`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct HostStatusResult {
    pub host_epoch: String,
    pub composition_id: String,
    pub composition_revision: String,
    pub state: HostLifecycleState,
    pub connections: u64,
    pub active_operations: u64,
    pub active_residencies: u64,
    /// A signed peer reachability lease (`SignedPeerReachabilityLeaseV1` in
    /// `peer-reachability/model.ts`). Kept opaque until a feature needs it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peer_endpoint: Option<Value>,
}

/// The `host.status` operation: a bootstrap query answered in every state
/// except `draining`.
#[derive(Debug)]
pub enum HostStatus {}

impl Operation for HostStatus {
    const NAME: &'static str = "host.status";
    type Input = HostStatusInput;
    type Output = HostStatusResult;
}

/// `HOST_DIAGNOSTIC_LOG_MAX_ENTRIES`: log lines a diagnostics answer holds
/// at most.
pub const HOST_DIAGNOSTIC_LOG_MAX_ENTRIES: usize = 256;

/// A residency the Host holds open (a running Turn, a subscription), by
/// its label.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct HostResidencyCount {
    pub label: String,
    pub count: u64,
}

/// `HostDiagnosticsResult` (`decodeHostDiagnosticsResult`): the status and
/// what a support report needs about the Host process.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct HostDiagnosticsResult {
    pub host_epoch: String,
    pub composition_id: String,
    pub composition_revision: String,
    pub state: HostLifecycleState,
    pub connections: u64,
    pub active_operations: u64,
    pub active_residencies: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peer_endpoint: Option<Value>,
    /// Whether a maintenance drain would interrupt active work now.
    pub upgrade_blocking_activity: bool,
    pub composition_modules: Vec<String>,
    pub residencies: Vec<HostResidencyCount>,
    pub protocol_version: u64,
    pub compatibility_epoch: u64,
    pub pid: u64,
    pub process_uptime_seconds: u64,
    pub node_version: String,
    /// `NodeJS.Platform`: `darwin`, `linux`, `win32`, ….
    pub platform: String,
    pub arch: String,
    pub os_release: String,
    /// The Host's recent log lines, oldest first.
    pub logs: Vec<String>,
}

/// `host.diagnostics.query`: a bootstrap query, answered in every state
/// except `draining` (errors `host_draining`, `internal_failure`).
#[derive(Debug)]
pub enum HostDiagnostics {}

impl Operation for HostDiagnostics {
    const NAME: &'static str = "host.diagnostics.query";
    type Input = HostStatusInput;
    type Output = HostDiagnosticsResult;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn input_encodes_as_empty_object() {
        assert_eq!(serde_json::to_value(HostStatusInput::default()).expect("encode"), json!({}));
    }

    #[test]
    fn result_decodes_optional_peer_endpoint() {
        let result: HostStatusResult = serde_json::from_value(json!({
            "hostEpoch": "e",
            "compositionId": "maka.interactive",
            "compositionRevision": "3",
            "state": "recovering",
            "connections": 1,
            "activeOperations": 0,
            "activeResidencies": 2,
            "peerEndpoint": {"peerId": "p"}
        }))
        .expect("decode");
        assert_eq!(result.state, HostLifecycleState::Recovering);
        assert_eq!(result.active_residencies, 2);
        assert_eq!(result.peer_endpoint, Some(json!({"peerId": "p"})));
    }

    #[test]
    fn diagnostics_decode_every_field() {
        let wire = json!({
            "hostEpoch": "e", "compositionId": "maka.interactive", "compositionRevision": "3",
            "state": "ready", "connections": 2, "activeOperations": 0, "activeResidencies": 1,
            "upgradeBlockingActivity": false, "compositionModules": ["core", "sessions"],
            "residencies": [{"label": "turn", "count": 1}], "protocolVersion": 0,
            "compatibilityEpoch": 197, "pid": 4242, "processUptimeSeconds": 61,
            "nodeVersion": "v24.18.0", "platform": "darwin", "arch": "arm64",
            "osRelease": "25.6.0", "logs": ["[info] ready"]
        });
        let result: HostDiagnosticsResult = serde_json::from_value(wire.clone()).expect("decode");
        assert_eq!(result.compatibility_epoch, 197);
        assert_eq!(result.residencies[0].label, "turn");
        assert_eq!(result.logs, ["[info] ready"]);
        assert_eq!(serde_json::to_value(&result).expect("encode"), wire);
    }
}
