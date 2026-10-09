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

//! `credential.vault.query`, `credential.vault.set`, and
//! `credential.vault.delete`: the Host-owned secrets (API keys, the network
//! proxy's password), which the Host never sends back. A query answers
//! whether a secret is configured and at which revision; a write is checked
//! against the revision the caller read.
//!
//! Source: `packages/runtime-host/src/protocol/runtime-policy.ts`
//! (`RUNTIME_POLICY_OPERATION_SPECS`, `decodeCredentialQueryResult`,
//! `decodeSetCredentialResult`, `decodeDeleteCredentialResult`,
//! `credentialCommitted`, `credentialStale`); the shapes are
//! `CredentialLocator`, `CredentialStatus`, and `CredentialVersionBasis` in
//! `packages/core/src/runtime-policy.ts`, decoded by
//! `packages/core/src/runtime-policy/credential-vault-codec.ts`.
//!
//! The query fails with `host_not_ready`, `host_draining`,
//! `operation_unavailable`, `internal_failure`, `persistence_failed`, or
//! `invalid_request` (`CREDENTIAL_QUERY_ERRORS`); a write with those or
//! `commit_outcome_unknown` (`MUTATION_ERRORS`). A stale basis is not an
//! error: the result is a `credential_stale`.

use serde::{Deserialize, Serialize};

use crate::{ConnectionCredentialTarget, ConnectionVersionBasis, Operation};

wire_enum! {
    /// The `kind` of a [`CredentialLocator`]: which secret of its scope.
    pub enum CredentialKind {
        ApiKey = "api_key",
        OauthToken = "oauth_token",
        RequestHeaders = "request_headers",
        Password = "password",
    }
}

/// `CredentialLocator` (`decodeCredentialLocator`): where a secret lives.
/// Jev and web search keep an API key, a connection an API key, an OAuth
/// token, or its request headers, the network proxy its password.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "scope", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum CredentialLocator {
    Jev {
        kind: CredentialKind,
    },
    #[serde(rename_all = "camelCase")]
    Connection {
        connection_id: String,
        kind: CredentialKind,
    },
    /// `provider` is a `WebSearchCredentialProvider` (`tavily`).
    WebSearch {
        provider: String,
        kind: CredentialKind,
    },
    NetworkProxy {
        kind: CredentialKind,
    },
}

impl CredentialLocator {
    /// The network proxy's password.
    pub fn network_proxy_password() -> Self {
        Self::NetworkProxy { kind: CredentialKind::Password }
    }
}

/// `CredentialVersionBasis` (`decodeCredentialVersionBasis`): a configured
/// secret at the revision the caller read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct CredentialVersionBasis {
    pub locator: CredentialLocator,
    pub credential_id: String,
    pub revision: u64,
}

impl CredentialVersionBasis {
    pub fn new(
        locator: CredentialLocator,
        credential_id: impl Into<String>,
        revision: u64,
    ) -> Self {
        Self { locator, credential_id: credential_id.into(), revision }
    }
}

/// `CredentialStatus` (`decodeCredentialStatus`): whether a secret is
/// configured, never the secret. An unconfigured one carries no id,
/// revision, or time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct CredentialStatus {
    pub locator: CredentialLocator,
    pub configured: bool,
    pub credential_id: Option<String>,
    pub revision: Option<u64>,
    /// Milliseconds since the Unix epoch.
    pub updated_at: Option<u64>,
}

impl CredentialStatus {
    /// The basis a write to this secret expects: `None` while it is not
    /// configured.
    pub fn basis(&self) -> Option<CredentialVersionBasis> {
        match (self.configured, &self.credential_id, self.revision) {
            (true, Some(id), Some(revision)) => {
                Some(CredentialVersionBasis::new(self.locator.clone(), id.clone(), revision))
            }
            _ => None,
        }
    }
}

/// `CredentialVaultQueryInput` (`decodeCredentialQueryInput`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct CredentialVaultQueryInput {
    pub locator: CredentialLocator,
}

impl CredentialVaultQueryInput {
    pub fn new(locator: CredentialLocator) -> Self {
        Self { locator }
    }
}

/// `CredentialVaultQueryResult` (`decodeCredentialQueryResult`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum CredentialVaultQueryResult {
    Status {
        status: CredentialStatus,
    },
    /// A connection-scoped locator names no connection.
    ConnectionNotFound,
    /// A result kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// The basis a set expects (`normalizeSetCredentialInput`): the secret's id
/// and revision, without its locator.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct CredentialExpectation {
    pub credential_id: String,
    pub revision: u64,
}

/// `SetCredentialInput` (`normalizeSetCredentialInput`): `expected` is
/// always on the wire, `null` for a secret not configured yet; the secret
/// is not empty and at most 10 KiB (`CREDENTIAL_SECRET_MAX_BYTES`).
/// `expectedConnection`, a connection's target basis, is sent only by a
/// configuration import ([`Self::with_expected_connection`]). Its `Debug`
/// leaves the secret out.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct CredentialVaultSetInput {
    pub locator: CredentialLocator,
    pub expected: Option<CredentialExpectation>,
    #[serde(rename = "expectedConnection", default, skip_serializing_if = "Option::is_none")]
    pub expected_connection: Option<ConnectionCredentialTarget>,
    pub secret: String,
}

impl std::fmt::Debug for CredentialVaultSetInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CredentialVaultSetInput")
            .field("locator", &self.locator)
            .field("expected", &self.expected)
            .finish_non_exhaustive()
    }
}

impl CredentialVaultSetInput {
    /// Sets `secret` at `locator`, over the secret `current` describes.
    pub fn new(
        locator: CredentialLocator,
        current: Option<&CredentialVersionBasis>,
        secret: impl Into<String>,
    ) -> Self {
        let expected = current.map(|basis| CredentialExpectation {
            credential_id: basis.credential_id.clone(),
            revision: basis.revision,
        });
        Self { locator, expected, expected_connection: None, secret: secret.into() }
    }

    /// The set only while the connection is still the one `target` names.
    pub fn with_expected_connection(mut self, target: ConnectionCredentialTarget) -> Self {
        self.expected_connection = Some(target);
        self
    }
}

/// `DeleteCredentialInput` (`normalizeDeleteCredentialInput`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct CredentialVaultDeleteInput {
    pub expected: CredentialVersionBasis,
}

impl CredentialVaultDeleteInput {
    pub fn new(expected: CredentialVersionBasis) -> Self {
        Self { expected }
    }
}

/// `SetCredentialResult` and `DeleteCredentialResult`
/// (`decodeSetCredentialResult`, `decodeDeleteCredentialResult`). A delete
/// never answers `connection_stale`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum CredentialMutationResult {
    #[serde(rename_all = "camelCase")]
    Committed {
        vault_revision: u64,
        status: CredentialStatus,
    },
    ConnectionNotFound,
    /// The connection changed since it was read.
    ConnectionStale {
        expected: ConnectionVersionBasis,
        actual: Option<ConnectionVersionBasis>,
    },
    /// The secret changed since it was read: read its status again.
    CredentialStale {
        expected: Option<CredentialVersionBasis>,
        actual: Option<CredentialVersionBasis>,
    },
    /// A result kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// `credential.vault.query` (mode `query`).
#[derive(Debug)]
pub enum CredentialVaultQuery {}

impl Operation for CredentialVaultQuery {
    const NAME: &'static str = "credential.vault.query";
    type Input = CredentialVaultQueryInput;
    type Output = CredentialVaultQueryResult;
}

/// `credential.vault.set` (mode `command`).
#[derive(Debug)]
pub enum CredentialVaultSet {}

impl Operation for CredentialVaultSet {
    const NAME: &'static str = "credential.vault.set";
    type Input = CredentialVaultSetInput;
    type Output = CredentialMutationResult;
}

/// `credential.vault.delete` (mode `command`).
#[derive(Debug)]
pub enum CredentialVaultDelete {}

impl Operation for CredentialVaultDelete {
    const NAME: &'static str = "credential.vault.delete";
    type Input = CredentialVaultDeleteInput;
    type Output = CredentialMutationResult;
}

#[cfg(test)]
pub(crate) mod tests {
    use serde_json::{Value, json};

    use super::*;

    /// A configured proxy password, as the TS protocol test's committed
    /// `credentialStatus` writes it.
    pub(crate) fn configured_status() -> Value {
        json!({"locator": {"scope": "network_proxy", "kind": "password"}, "configured": true,
               "credentialId": "00000000-0000-4000-8000-000000000001", "revision": 2,
               "updatedAt": 1})
    }

    #[test]
    fn every_locator_scope_round_trips() {
        for (value, expected) in [
            (
                json!({"scope": "jev", "kind": "api_key"}),
                CredentialLocator::Jev { kind: CredentialKind::ApiKey },
            ),
            (
                json!({"scope": "connection", "connectionId": "c1", "kind": "request_headers"}),
                CredentialLocator::Connection {
                    connection_id: "c1".into(),
                    kind: CredentialKind::RequestHeaders,
                },
            ),
            (
                json!({"scope": "web_search", "provider": "tavily", "kind": "api_key"}),
                CredentialLocator::WebSearch {
                    provider: "tavily".into(),
                    kind: CredentialKind::ApiKey,
                },
            ),
            (
                json!({"scope": "network_proxy", "kind": "password"}),
                CredentialLocator::network_proxy_password(),
            ),
        ] {
            let decoded: CredentialLocator = serde_json::from_value(value.clone()).expect("decode");
            assert_eq!(decoded, expected);
            assert_eq!(serde_json::to_value(&decoded).expect("encode"), value);
        }
    }

    #[test]
    fn a_status_says_whether_a_secret_is_configured_and_its_basis() {
        let result: CredentialVaultQueryResult =
            serde_json::from_value(json!({"kind": "status", "status": configured_status()}))
                .expect("decode");
        let CredentialVaultQueryResult::Status { status } = result else {
            panic!("a status");
        };
        assert!(status.configured);
        assert_eq!(
            status.basis(),
            Some(CredentialVersionBasis::new(
                CredentialLocator::network_proxy_password(),
                "00000000-0000-4000-8000-000000000001",
                2
            ))
        );
        // Unconfigured, as the TS test writes it (without the stray secret
        // `decodeCredentialStatus` refuses).
        let unconfigured: CredentialStatus = serde_json::from_value(json!({
            "locator": {"scope": "network_proxy", "kind": "password"}, "configured": false,
            "credentialId": null, "revision": null, "updatedAt": null
        }))
        .expect("decode");
        assert_eq!(unconfigured.basis(), None);
        let missing: CredentialVaultQueryResult =
            serde_json::from_value(json!({"kind": "connection_not_found"})).expect("decode");
        assert_eq!(missing, CredentialVaultQueryResult::ConnectionNotFound);
        let query = CredentialVaultQueryInput::new(CredentialLocator::network_proxy_password());
        assert_eq!(
            serde_json::to_value(query).expect("encode"),
            json!({"locator": {"scope": "network_proxy", "kind": "password"}})
        );
    }

    #[test]
    fn writes_carry_the_basis_they_read_and_keep_the_secret_out_of_debug() {
        let basis: CredentialVersionBasis = serde_json::from_value(json!({
            "locator": {"scope": "web_search", "provider": "tavily", "kind": "api_key"},
            "credentialId": "k1", "revision": 3
        }))
        .expect("basis");
        let set = CredentialVaultSetInput::new(basis.locator.clone(), Some(&basis), "sk-secret");
        assert_eq!(
            serde_json::to_value(&set).expect("encode"),
            json!({"locator": {"scope": "web_search", "provider": "tavily", "kind": "api_key"},
                   "expected": {"credentialId": "k1", "revision": 3}, "secret": "sk-secret"})
        );
        assert!(!format!("{set:?}").contains("sk-secret"));
        let first =
            CredentialVaultSetInput::new(CredentialLocator::network_proxy_password(), None, "p");
        assert_eq!(serde_json::to_value(&first).expect("encode")["expected"], Value::Null);
        assert_eq!(
            serde_json::to_value(CredentialVaultDeleteInput::new(basis)).expect("encode"),
            json!({"expected": {"locator": {"scope": "web_search", "provider": "tavily",
                   "kind": "api_key"}, "credentialId": "k1", "revision": 3}})
        );
        for (value, check) in [
            (
                json!({"kind": "committed", "vaultRevision": 7, "status": configured_status()}),
                (|result: &CredentialMutationResult| {
                    matches!(result, CredentialMutationResult::Committed { vault_revision: 7, .. })
                }) as fn(&CredentialMutationResult) -> bool,
            ),
            (
                json!({"kind": "credential_stale", "expected": null, "actual": {
                "locator": {"scope": "network_proxy", "kind": "password"},
                "credentialId": "p1", "revision": 4}}),
                |result| {
                    matches!(
                        result,
                        CredentialMutationResult::CredentialStale {
                            expected: None,
                            actual: Some(_)
                        }
                    )
                },
            ),
            (
                json!({"kind": "connection_stale", "expected": {"connectionId": "c1", "revision": 4},
                    "actual": null}),
                |result| {
                    matches!(result, CredentialMutationResult::ConnectionStale { actual: None, .. })
                },
            ),
            (json!({"kind": "connection_not_found"}), |result| {
                *result == CredentialMutationResult::ConnectionNotFound
            }),
        ] {
            let decoded: CredentialMutationResult = serde_json::from_value(value).expect("decode");
            assert!(check(&decoded), "{decoded:?}");
        }
    }
}
