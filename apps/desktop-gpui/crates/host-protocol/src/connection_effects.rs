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

//! `connection.onboarding.verify` and `connection.onboarding.save`: add a
//! connection with an API key once the Host has discovered its models; and
//! the effects on a connection that exists, `connection.models.fetch` (list
//! its models again) and `connection.test.run` (send it one request).
//!
//! Source: `packages/runtime-host/src/protocol/connection-effects.ts`
//! (`CONNECTION_EFFECT_OPERATION_SPECS`, `decodeConnectionOnboardingVerifyInput`,
//! `decodeConnectionOnboardingSaveInput`, `decodeConnectionOnboardingVerifyResult`,
//! `decodeConnectionOnboardingSaveResult`, `decodeConnectionModelFetchInput`,
//! `decodeConnectionModelFetchResult`, `decodeConnectionTestRunInput`,
//! `decodeConnectionTestRunResult`, `decodeConnectionTestProjection`). The target is
//! `ConnectionOnboardingTarget` in `packages/core/src/runtime-policy.ts`; a
//! discovered model is `decodeConnectionModel` in
//! `packages/core/src/runtime-policy/connection-catalog-codec.ts`.
//!
//! Both operations run model discovery against the provider with the given
//! key and endpoint (`ConnectionEffectCoordinator` in
//! `packages/runtime-host/src/server/connection-effect-coordinator.ts`);
//! `save` discovers again and commits. Verification persists nothing.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{ConnectionVersionBasis, ModelApiProtocol, ModelSource, Operation};

/// `ConnectionOnboardingTarget`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum ConnectionOnboardingTarget {
    /// A new connection. Without `slug` and `name` the Host derives them
    /// (`custom`, `custom-2`, …, and the provider's label); a requested
    /// `slug` that another connection owns is rejected with `slug_taken`
    /// rather than changed.
    #[serde(rename_all = "camelCase")]
    Create {
        /// A `providerType` (see [`crate::PROVIDER_REGISTRY`]).
        provider_type: String,
        /// Lowercase letters, digits, and inner hyphens, at most 64
        /// characters (`validateSlug` in packages/core/src/llm-connections.ts).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        slug: Option<String>,
        /// At most 256 characters (`CONNECTION_NAME_MAX_LENGTH`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        /// Required with `providerType` `custom`, refused with any other
        /// (`decodeDefaultApiProtocol` in
        /// packages/core/src/runtime-policy/connection-catalog-codec.ts).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        default_api_protocol: Option<ModelApiProtocol>,
    },
    /// An existing connection, to rediscover its models with a new key.
    #[serde(rename_all = "camelCase")]
    Existing { connection_id: String },
}

/// `ConnectionOnboardingVerifyInput`. `apiKey` and `baseUrl` are always on
/// the wire; `null` means the stored key or the registry's (or the stored)
/// endpoint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ConnectionOnboardingVerifyInput {
    pub target: ConnectionOnboardingTarget,
    /// The raw key, at most 64 KiB. Used by the Host, never projected back.
    pub api_key: Option<String>,
    /// An `http`/`https` URL without credentials, query, or fragment, at
    /// most 2048 bytes; the registry default when equal to it.
    pub base_url: Option<String>,
}

impl ConnectionOnboardingVerifyInput {
    pub fn new(
        target: ConnectionOnboardingTarget,
        api_key: Option<String>,
        base_url: Option<String>,
    ) -> Self {
        Self { target, api_key, base_url }
    }

    /// The same connection, saved with `enabled_model_ids`.
    pub fn save(self, enabled_model_ids: Vec<String>) -> ConnectionOnboardingSaveInput {
        let Self { target, api_key, base_url } = self;
        ConnectionOnboardingSaveInput { target, api_key, base_url, enabled_model_ids }
    }
}

/// `ConnectionOnboardingSaveInput`: the verify input plus the models to
/// enable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ConnectionOnboardingSaveInput {
    pub target: ConnectionOnboardingTarget,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    /// Unique ids from the discovered models; empty enables all of them.
    /// The Host reads the first as the connection's default model.
    pub enabled_model_ids: Vec<String>,
}

wire_enum! {
    /// Why onboarding was refused before anything was committed (the
    /// `rejected` reasons of both results; verification never answers
    /// `model_unavailable` or `superseded`).
    pub enum ConnectionOnboardingRejection {
        ProviderUnsupported = "provider_unsupported",
        ConnectionNotFound = "connection_not_found",
        CredentialNotConfigured = "credential_not_configured",
        BaseUrlNotConfigured = "base_url_not_configured",
        SlugTaken = "slug_taken",
        CatalogFull = "catalog_full",
        /// Save only: a chosen model is no longer offered, or discovery
        /// found none.
        ModelUnavailable = "model_unavailable",
        /// Save only: the connection changed between discovery and commit.
        Superseded = "superseded",
    }
}

wire_enum! {
    /// `CONNECTION_EFFECT_FAILURE_CLASSES`: why talking to the provider failed.
    pub enum ConnectionEffectFailureClass {
        Auth = "auth",
        Timeout = "timeout",
        ProviderUnavailable = "provider_unavailable",
        Network = "network",
        InvalidResponse = "invalid_response",
        Unknown = "unknown",
    }
}

/// A model discovery found (`ConnectionModel`, decoded by
/// `decodeConnectionModel`). Only the id and name are read; the other
/// facts are kept as the Host sent them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct DiscoveredModel {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// `description`, `contextWindow`, `capabilities`, and the rest.
    #[serde(flatten)]
    pub facts: Map<String, Value>,
}

impl DiscoveredModel {
    /// The name to show: `displayName`, else the id.
    pub fn label(&self) -> &str {
        self.display_name.as_deref().unwrap_or(&self.id)
    }
}

/// `ConnectionOnboardingVerifyResult`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum ConnectionOnboardingVerifyResult {
    /// The key works; at least one model was found.
    Verified {
        models: Vec<DiscoveredModel>,
    },
    Rejected {
        reason: ConnectionOnboardingRejection,
    },
    /// The provider could not be reached or refused; an empty model list
    /// answers `invalid_response`.
    #[serde(rename_all = "camelCase")]
    Failed {
        error_class: ConnectionEffectFailureClass,
    },
    /// A result kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// The identity of a saved connection (`ConnectionVersionBasis` plus its
/// slug and provider).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SavedConnection {
    pub connection_id: String,
    pub revision: u64,
    pub slug: String,
    pub provider_type: String,
}

/// `ConnectionOnboardingSaveResult`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum ConnectionOnboardingSaveResult {
    Saved {
        connection: SavedConnection,
    },
    Rejected {
        reason: ConnectionOnboardingRejection,
    },
    #[serde(rename_all = "camelCase")]
    Failed {
        error_class: ConnectionEffectFailureClass,
    },
    /// A result kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// `connection.onboarding.verify` (mode `command`, availability `ready`).
#[derive(Debug)]
pub enum ConnectionOnboardingVerify {}

impl Operation for ConnectionOnboardingVerify {
    const NAME: &'static str = "connection.onboarding.verify";
    type Input = ConnectionOnboardingVerifyInput;
    type Output = ConnectionOnboardingVerifyResult;
}

wire_enum! {
    /// `CONNECTION_EFFECT_REJECTION_REASONS`: why an effect on a connection
    /// was not run.
    pub enum ConnectionEffectRejection {
        ConnectionNotFound = "connection_not_found",
        ConnectionDisabled = "connection_disabled",
        ProviderActionUnavailable = "provider_action_unavailable",
        CredentialNotConfigured = "credential_not_configured",
    }
}

wire_enum! {
    /// `CONNECTION_EFFECT_CHANGED_DOMAINS`: what changed under an effect,
    /// so its outcome was not committed.
    pub enum ConnectionEffectChangedDomain {
        Connection = "connection",
        Credential = "credential",
        NetworkProxy = "network_proxy",
    }
}

/// `ConnectionModelFetchInput`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ConnectionModelsFetchInput {
    pub connection_id: String,
}

impl ConnectionModelsFetchInput {
    pub fn new(connection_id: impl Into<String>) -> Self {
        Self { connection_id: connection_id.into() }
    }
}

/// `ConnectionModelFetchResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum ConnectionModelsFetchResult {
    /// The stored models were replaced: `model_count` of them, from the
    /// provider (`fetched`) or the registry's list (`fallback`), at
    /// `fetched_at` (milliseconds since the Unix epoch).
    #[serde(rename_all = "camelCase")]
    Committed {
        catalog_revision: u64,
        connection: ConnectionVersionBasis,
        model_count: u64,
        source: ModelSource,
        fetched_at: u64,
    },
    Rejected {
        reason: ConnectionEffectRejection,
    },
    /// The connection, its key, or the proxy changed while the models were
    /// listed.
    Superseded {
        changed: Vec<ConnectionEffectChangedDomain>,
    },
    #[serde(rename_all = "camelCase")]
    Failed {
        error_class: ConnectionEffectFailureClass,
    },
    /// A result kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// `connection.models.fetch` (mode `command`, availability `ready`).
#[derive(Debug)]
pub enum ConnectionModelsFetch {}

impl Operation for ConnectionModelsFetch {
    const NAME: &'static str = "connection.models.fetch";
    type Input = ConnectionModelsFetchInput;
    type Output = ConnectionModelsFetchResult;
}

/// `ConnectionTestRunInput`: `modelId` is always on the wire; `null` lets
/// the Host pick one (the enabled models first, then the provider's).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ConnectionTestRunInput {
    pub connection_id: String,
    pub model_id: Option<String>,
}

impl ConnectionTestRunInput {
    pub fn new(connection_id: impl Into<String>, model_id: Option<String>) -> Self {
        Self { connection_id: connection_id.into(), model_id }
    }
}

/// `ConnectionTestProjection`: what the test found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum ConnectionTestProjection {
    /// `model_id` answered in `latency_ms`.
    #[serde(rename_all = "camelCase")]
    Verified { checked_at: String, model_id: String, latency_ms: u64 },
    #[serde(rename_all = "camelCase")]
    Failed {
        checked_at: String,
        model_id: Option<String>,
        latency_ms: Option<u64>,
        /// The provider's HTTP status, 100 to 599.
        status_code: Option<u16>,
        error_class: ConnectionEffectFailureClass,
    },
    /// A result kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// `ConnectionTestRunResult`: a test that ran is committed (its outcome is
/// the connection's last test) whether it passed or not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum ConnectionTestRunResult {
    #[serde(rename_all = "camelCase")]
    Committed {
        catalog_revision: u64,
        connection: ConnectionVersionBasis,
        test: ConnectionTestProjection,
    },
    Rejected {
        reason: ConnectionEffectRejection,
    },
    Superseded {
        changed: Vec<ConnectionEffectChangedDomain>,
    },
    /// A result kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// `connection.test.run` (mode `command`, availability `ready`).
#[derive(Debug)]
pub enum ConnectionTestRun {}

impl Operation for ConnectionTestRun {
    const NAME: &'static str = "connection.test.run";
    type Input = ConnectionTestRunInput;
    type Output = ConnectionTestRunResult;
}

/// `connection.onboarding.save` (mode `command`, availability `ready`).
/// `commit_outcome_unknown` means the connection may or may not exist.
#[derive(Debug)]
pub enum ConnectionOnboardingSave {}

impl Operation for ConnectionOnboardingSave {
    const NAME: &'static str = "connection.onboarding.save";
    type Input = ConnectionOnboardingSaveInput;
    type Output = ConnectionOnboardingSaveResult;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn create(slug: Option<&str>) -> ConnectionOnboardingTarget {
        ConnectionOnboardingTarget::Create {
            provider_type: "custom".into(),
            slug: slug.map(str::to_owned),
            name: None,
            default_api_protocol: Some(ModelApiProtocol::OpenaiChat),
        }
    }

    #[test]
    fn inputs_always_carry_the_key_and_the_endpoint() {
        let verify = ConnectionOnboardingVerifyInput::new(create(None), None, None);
        assert_eq!(
            serde_json::to_value(&verify).expect("encode"),
            json!({"target": {"kind": "create", "providerType": "custom",
                              "defaultApiProtocol": "openai-chat"},
                   "apiKey": null, "baseUrl": null})
        );
        let save = ConnectionOnboardingVerifyInput::new(
            create(Some("ollama-test")),
            Some("ollama".into()),
            Some("http://127.0.0.1:11434/v1".into()),
        )
        .save(vec!["qwen2.5:7b".into()]);
        assert_eq!(
            serde_json::to_value(&save).expect("encode"),
            json!({"target": {"kind": "create", "providerType": "custom",
                              "slug": "ollama-test", "defaultApiProtocol": "openai-chat"},
                   "apiKey": "ollama", "baseUrl": "http://127.0.0.1:11434/v1",
                   "enabledModelIds": ["qwen2.5:7b"]})
        );
        let existing = ConnectionOnboardingTarget::Existing { connection_id: "c1".into() };
        assert_eq!(
            serde_json::to_value(existing).expect("encode"),
            json!({"kind": "existing", "connectionId": "c1"})
        );
    }

    #[test]
    fn results_decode_every_kind() {
        let verified: ConnectionOnboardingVerifyResult = serde_json::from_value(json!({
            "kind": "verified",
            "models": [{"id": "qwen2.5:7b"}, {"id": "m", "displayName": "M", "contextWindow": 8}]
        }))
        .expect("decode");
        let ConnectionOnboardingVerifyResult::Verified { models } = &verified else {
            panic!("expected verified");
        };
        assert_eq!(models[0].label(), "qwen2.5:7b");
        assert_eq!(models[1].label(), "M");
        assert_eq!(
            serde_json::to_value(&verified).expect("encode")["models"][1],
            json!({"id": "m", "displayName": "M", "contextWindow": 8}),
            "facts round-trip"
        );
        let rejected: ConnectionOnboardingVerifyResult =
            serde_json::from_value(json!({"kind": "rejected", "reason": "slug_taken"}))
                .expect("decode");
        assert_eq!(
            rejected,
            ConnectionOnboardingVerifyResult::Rejected {
                reason: ConnectionOnboardingRejection::SlugTaken
            }
        );
        let failed: ConnectionOnboardingSaveResult =
            serde_json::from_value(json!({"kind": "failed", "errorClass": "network"}))
                .expect("decode");
        assert_eq!(
            failed,
            ConnectionOnboardingSaveResult::Failed {
                error_class: ConnectionEffectFailureClass::Network
            }
        );
        let saved: ConnectionOnboardingSaveResult = serde_json::from_value(json!({
            "kind": "saved",
            "connection": {"connectionId": "c9", "revision": 1, "slug": "ollama-test",
                           "providerType": "custom"}
        }))
        .expect("decode");
        assert!(matches!(
            saved,
            ConnectionOnboardingSaveResult::Saved { connection } if connection.slug == "ollama-test"
        ));
        let future: ConnectionOnboardingSaveResult =
            serde_json::from_value(json!({"kind": "future"})).expect("decode");
        assert_eq!(future, ConnectionOnboardingSaveResult::Unknown);
    }

    #[test]
    fn a_model_fetch_decodes_every_kind() {
        assert_eq!(
            serde_json::to_value(ConnectionModelsFetchInput::new("c1")).expect("encode"),
            json!({"connectionId": "c1"})
        );
        let basis = json!({"connectionId": "c1", "revision": 4});
        for (value, expected) in [
            (
                json!({"kind": "committed", "catalogRevision": 9, "connection": basis,
                       "modelCount": 12, "source": "fetched", "fetchedAt": 1759052400000_u64}),
                ConnectionModelsFetchResult::Committed {
                    catalog_revision: 9,
                    connection: ConnectionVersionBasis::new("c1", 4),
                    model_count: 12,
                    source: ModelSource::Fetched,
                    fetched_at: 1_759_052_400_000,
                },
            ),
            (
                json!({"kind": "rejected", "reason": "connection_disabled"}),
                ConnectionModelsFetchResult::Rejected {
                    reason: ConnectionEffectRejection::ConnectionDisabled,
                },
            ),
            (
                json!({"kind": "superseded", "changed": ["credential", "network_proxy"]}),
                ConnectionModelsFetchResult::Superseded {
                    changed: vec![
                        ConnectionEffectChangedDomain::Credential,
                        ConnectionEffectChangedDomain::NetworkProxy,
                    ],
                },
            ),
            (
                json!({"kind": "failed", "errorClass": "timeout"}),
                ConnectionModelsFetchResult::Failed {
                    error_class: ConnectionEffectFailureClass::Timeout,
                },
            ),
        ] {
            assert_eq!(
                serde_json::from_value::<ConnectionModelsFetchResult>(value).expect("decode"),
                expected
            );
        }
    }

    #[test]
    fn a_test_run_sends_a_null_model_and_decodes_both_projections() {
        assert_eq!(
            serde_json::to_value(ConnectionTestRunInput::new("c1", None)).expect("encode"),
            json!({"connectionId": "c1", "modelId": null})
        );
        let verified: ConnectionTestRunResult = serde_json::from_value(json!({
            "kind": "committed", "catalogRevision": 3,
            "connection": {"connectionId": "c1", "revision": 2},
            "test": {"kind": "verified", "checkedAt": "2026-09-28T10:00:00.000Z",
                     "modelId": "deepseek-flash", "latencyMs": 812}
        }))
        .expect("decode");
        assert!(matches!(
            verified,
            ConnectionTestRunResult::Committed {
                test: ConnectionTestProjection::Verified { latency_ms: 812, .. },
                ..
            }
        ));
        let failed: ConnectionTestRunResult = serde_json::from_value(json!({
            "kind": "committed", "catalogRevision": 3,
            "connection": {"connectionId": "c1", "revision": 2},
            "test": {"kind": "failed", "checkedAt": "2026-09-28T10:00:00.000Z",
                     "modelId": null, "latencyMs": null, "statusCode": 401,
                     "errorClass": "auth"}
        }))
        .expect("decode");
        let ConnectionTestRunResult::Committed {
            test: ConnectionTestProjection::Failed { status_code, error_class, .. },
            ..
        } = failed
        else {
            panic!("expected a failed test");
        };
        assert_eq!((status_code, error_class), (Some(401), ConnectionEffectFailureClass::Auth));
        let rejected: ConnectionTestRunResult = serde_json::from_value(
            json!({"kind": "rejected", "reason": "credential_not_configured"}),
        )
        .expect("decode");
        assert_eq!(
            rejected,
            ConnectionTestRunResult::Rejected {
                reason: ConnectionEffectRejection::CredentialNotConfigured
            }
        );
    }
}
