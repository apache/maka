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

//! `runtime.policy.network-proxy.update` and `network-proxy.test`: the
//! proxy policy written together with its password, and a probe through a
//! proxy configuration.
//!
//! Source: `packages/runtime-host/src/protocol/runtime-policy.ts`
//! (`decodeRuntimePolicyNetworkProxyUpdate`,
//! `decodeRuntimePolicyNetworkProxyUpdateResult`) and
//! `packages/runtime-host/src/protocol/network-proxy.ts`
//! (`NETWORK_PROXY_OPERATION_SPECS`, `decodeNetworkProxyTestInput`,
//! `decodeNetworkProxyTestResult`); the update's shape is
//! `UpdateNetworkProxyInput` in `packages/core/src/runtime-policy.ts`,
//! normalized by `normalizeNetworkProxyUpdate` in
//! `packages/core/src/runtime-policy/policy-codec.ts`.
//!
//! The update fails with `MUTATION_ERRORS` (`host_not_ready`,
//! `host_draining`, `operation_unavailable`, `invalid_request`,
//! `internal_failure`, `persistence_failed`, `commit_outcome_unknown`); a
//! stale policy or password is a result, not an error. The test fails with
//! `host_not_ready`, `host_draining`, `operation_unavailable`,
//! `invalid_request`, or `internal_failure`; a proxy that does not answer is
//! an `ok: false` result.

use serde::{Deserialize, Serialize};

use crate::{
    CredentialStatus, CredentialVersionBasis, NetworkProxyPolicy, Operation, ProxyProtocol,
};

/// `NetworkProxyCredentialTarget` (`normalizeNetworkProxyCredentialTarget`):
/// the proxy a password belongs to, its host trimmed and lowercased.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct NetworkProxyCredentialTarget {
    pub protocol: ProxyProtocol,
    pub host: String,
    pub port: u16,
    pub username: String,
}

/// `NetworkProxyCredentialUpdate` (`normalizeNetworkProxyCredentialUpdate`):
/// what happens to the password. The Host refuses anything but `delete`
/// while authentication is off. Its `Debug` leaves the secret out.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum NetworkProxyCredentialUpdate {
    Keep,
    /// A new password, not empty; with `expected_target`, only for that
    /// proxy (else `proxy_target_mismatch`).
    #[serde(rename_all = "camelCase")]
    Replace {
        secret: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expected_target: Option<NetworkProxyCredentialTarget>,
    },
    Delete,
}

impl std::fmt::Debug for NetworkProxyCredentialUpdate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Keep => f.write_str("Keep"),
            Self::Replace { expected_target, .. } => f
                .debug_struct("Replace")
                .field("expected_target", expected_target)
                .finish_non_exhaustive(),
            Self::Delete => f.write_str("Delete"),
        }
    }
}

/// `UpdateNetworkProxyInput` (`normalizeNetworkProxyUpdate`): the whole proxy
/// policy and the password's fate, against the policy revision and the
/// password basis the caller read (`expectedCredential` is always on the
/// wire, `null` while no password is configured).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct NetworkProxyUpdateInput {
    pub expected_policy_revision: u64,
    pub expected_credential: Option<CredentialVersionBasis>,
    pub network_proxy: NetworkProxyPolicy,
    pub credential: NetworkProxyCredentialUpdate,
}

impl NetworkProxyUpdateInput {
    pub fn new(
        expected_policy_revision: u64,
        expected_credential: Option<CredentialVersionBasis>,
        network_proxy: NetworkProxyPolicy,
        credential: NetworkProxyCredentialUpdate,
    ) -> Self {
        Self { expected_policy_revision, expected_credential, network_proxy, credential }
    }
}

/// `RuntimePolicyNetworkProxyUpdateResult`
/// (`decodeRuntimePolicyNetworkProxyUpdateResult`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum NetworkProxyUpdateResult {
    /// Both committed: the policy at `revision`, the password as `credential_status`.
    #[serde(rename_all = "camelCase")]
    Committed { revision: u64, credential_status: CredentialStatus },
    /// The policy changed since it was read.
    #[serde(rename_all = "camelCase")]
    RevisionConflict { expected_revision: u64, actual_revision: u64 },
    /// A replacement's `expectedTarget` is not the proxy the policy names.
    ProxyTargetMismatch {
        expected: NetworkProxyCredentialTarget,
        actual: NetworkProxyCredentialTarget,
    },
    /// The password changed since it was read.
    CredentialStale {
        expected: Option<CredentialVersionBasis>,
        actual: Option<CredentialVersionBasis>,
    },
    /// A result kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// `runtime.policy.network-proxy.update` (mode `command`).
#[derive(Debug)]
pub enum NetworkProxyUpdate {}

impl Operation for NetworkProxyUpdate {
    const NAME: &'static str = "runtime.policy.network-proxy.update";
    type Input = NetworkProxyUpdateInput;
    type Output = NetworkProxyUpdateResult;
}

/// `NetworkProxyTestInput` (`decodeNetworkProxyTestInput`): the proxy to
/// probe (the stored one when absent, with its stored password either way),
/// an http(s) probe URL, and a timeout of 1 to 30000 ms.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct NetworkProxyTestInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network_proxy: Option<NetworkProxyPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u32>,
}

impl NetworkProxyTestInput {
    /// A probe through `network_proxy`.
    pub fn through(network_proxy: NetworkProxyPolicy) -> Self {
        Self { network_proxy: Some(network_proxy), url: None, timeout_ms: None }
    }
}

/// `TestProxyResult` (`decodeNetworkProxyTestResult`): whether the probe
/// got through, how long it took, and what the far side said.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct NetworkProxyTestResult {
    pub ok: bool,
    pub latency_ms: u64,
    /// The probe's HTTP status, 100 to 599.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    /// The address the probe was seen from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ip: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub country_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub country_flag: Option<String>,
    /// Why it failed, redacted by the Host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `network-proxy.test` (mode `command`).
#[derive(Debug)]
pub enum NetworkProxyTest {}

impl Operation for NetworkProxyTest {
    const NAME: &'static str = "network-proxy.test";
    type Input = NetworkProxyTestInput;
    type Output = NetworkProxyTestResult;
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    /// The input of the TS protocol test "keeps compound proxy credentials
    /// write-only on the protocol".
    fn update_sample() -> Value {
        json!({
            "expectedPolicyRevision": 4,
            "expectedCredential": null,
            "networkProxy": {"enabled": true, "protocol": "http", "host": "127.0.0.1",
                             "port": 7897, "authEnabled": true, "username": "proxy-user",
                             "bypassList": ["localhost"], "autoBypassDomains": ["127.0.0.1"]},
            "credential": {"kind": "replace", "secret": "write-only-secret",
                           "expectedTarget": {"protocol": "http", "host": "127.0.0.1",
                                              "port": 7897, "username": "proxy-user"}}
        })
    }

    #[test]
    fn an_update_encodes_as_the_host_reads_it() {
        let sample = update_sample();
        let decoded: NetworkProxyUpdateInput =
            serde_json::from_value(sample.clone()).expect("decode");
        assert_eq!(serde_json::to_value(&decoded).expect("encode"), sample);
        assert!(!format!("{decoded:?}").contains("write-only-secret"), "Debug hides it");
        for (credential, expected) in [
            (NetworkProxyCredentialUpdate::Keep, json!({"kind": "keep"})),
            (NetworkProxyCredentialUpdate::Delete, json!({"kind": "delete"})),
            (
                NetworkProxyCredentialUpdate::Replace { secret: "s".into(), expected_target: None },
                json!({"kind": "replace", "secret": "s"}),
            ),
        ] {
            assert_eq!(serde_json::to_value(credential).expect("encode"), expected);
        }
    }

    #[test]
    fn every_update_result_decodes() {
        let committed: NetworkProxyUpdateResult = serde_json::from_value(json!({
            "kind": "committed", "revision": 5,
            "credentialStatus": crate::credential_vault::tests::configured_status()
        }))
        .expect("committed");
        let NetworkProxyUpdateResult::Committed { revision: 5, credential_status } = committed
        else {
            panic!("committed");
        };
        assert!(credential_status.configured);
        let mismatch: NetworkProxyUpdateResult = serde_json::from_value(json!({
            "kind": "proxy_target_mismatch",
            "expected": {"protocol": "http", "host": "127.0.0.1", "port": 7897,
                         "username": "proxy-user"},
            "actual": {"protocol": "https", "host": "proxy.example", "port": 8443,
                       "username": "other-user"}
        }))
        .expect("mismatch");
        let NetworkProxyUpdateResult::ProxyTargetMismatch { actual, .. } = mismatch else {
            panic!("mismatch");
        };
        assert_eq!((actual.protocol, actual.port), (ProxyProtocol::Https, 8443));
        assert_eq!(
            serde_json::from_value::<NetworkProxyUpdateResult>(json!({
                "kind": "revision_conflict", "expectedRevision": 4, "actualRevision": 6
            }))
            .expect("conflict"),
            NetworkProxyUpdateResult::RevisionConflict { expected_revision: 4, actual_revision: 6 }
        );
        assert!(matches!(
            serde_json::from_value::<NetworkProxyUpdateResult>(json!({
                "kind": "credential_stale", "expected": null, "actual": null
            }))
            .expect("stale"),
            NetworkProxyUpdateResult::CredentialStale { expected: None, actual: None }
        ));
    }

    #[test]
    fn a_test_probes_the_proxy_given_and_reads_its_answer() {
        let proxy: NetworkProxyPolicy =
            serde_json::from_value(update_sample()["networkProxy"].take()).expect("proxy");
        let input = NetworkProxyTestInput::through(proxy);
        assert_eq!(
            serde_json::to_value(&input).expect("encode"),
            json!({"networkProxy": update_sample()["networkProxy"]})
        );
        assert_eq!(
            serde_json::to_value(NetworkProxyTestInput::default()).expect("encode"),
            json!({})
        );
        let reached: NetworkProxyTestResult = serde_json::from_value(json!({
            "ok": true, "latencyMs": 120, "status": 200, "ip": "203.0.113.4",
            "countryCode": "SG", "countryFlag": "🇸🇬"
        }))
        .expect("ok");
        assert_eq!((reached.ok, reached.latency_ms, reached.status), (true, 120, Some(200)));
        let failed: NetworkProxyTestResult = serde_json::from_value(json!({
            "ok": false, "latencyMs": 0, "error": "proxy test timeout"
        }))
        .expect("failed");
        assert_eq!(failed.error.as_deref(), Some("proxy test timeout"));
    }
}
