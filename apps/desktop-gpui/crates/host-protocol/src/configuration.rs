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

//! `configuration.credentials.export`: one Host-kept secret read back for a
//! configuration backup the person asked for, and the connection credential
//! target a backup's secret is bound to.
//!
//! Source: `packages/runtime-host/src/protocol/configuration.ts`
//! (`CONFIGURATION_OPERATION_SPECS`,
//! `decodeConfigurationCredentialExportInput`,
//! `decodeConfigurationCredentialExportResult`) and
//! `packages/core/src/runtime-policy/connection-catalog-codec.ts`
//! (`decodeConnectionCredentialTarget`, `connectionCredentialTarget`,
//! `canonicalConnectionEffectiveBaseUrl`). Errors: `host_not_ready`,
//! `host_draining`, `operation_unavailable`, `invalid_request`,
//! `internal_failure`.
//!
//! A connection export names the connection's target basis; when the
//! connection moved on since it was read, the answer carries
//! `connectionStale` and no secret, and the caller reads the catalog again.

use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::{
    ConnectionVersionBasis, CredentialLocator, NetworkProxyCredentialTarget, Operation,
    ProviderDefinition,
};

/// `ConnectionCredentialTarget`: the connection a secret belongs to, at the
/// revision read, with its provider and canonical effective endpoint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ConnectionCredentialTarget {
    pub connection_id: String,
    pub revision: u64,
    pub slug: String,
    pub provider_type: String,
    /// `new URL(endpoint).toString()` of the connection's endpoint.
    pub effective_base_url: String,
}

impl ConnectionCredentialTarget {
    /// `connectionCredentialTarget`: `None` when the connection has no
    /// valid endpoint.
    pub fn new(
        connection_id: impl Into<String>,
        revision: u64,
        slug: impl Into<String>,
        provider_type: impl Into<String>,
        base_url: Option<&str>,
    ) -> Option<Self> {
        let provider_type = provider_type.into();
        let effective_base_url = canonical_effective_base_url(&provider_type, base_url)?;
        Some(Self {
            connection_id: connection_id.into(),
            revision,
            slug: slug.into(),
            provider_type,
            effective_base_url,
        })
    }
}

/// `canonicalConnectionEffectiveBaseUrl`: the connection's own service URL
/// (trimmed) or its provider's, as WHATWG `URL` serializes it; `None` when
/// there is none or it does not parse.
pub fn canonical_effective_base_url(provider_type: &str, base_url: Option<&str>) -> Option<String> {
    let own = base_url.map(str::trim).filter(|url| !url.is_empty());
    let endpoint = own.or_else(|| ProviderDefinition::find(provider_type)?.base_url)?;
    canonical_url(endpoint)
}

/// `new URL(value).toString()`, or `None` when it does not parse.
pub fn canonical_url(value: &str) -> Option<String> {
    url::Url::parse(value).ok().map(|url| url.to_string())
}

/// `ConfigurationCredentialExportInput`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ConfigurationCredentialExportInput {
    pub locator: CredentialLocator,
    /// Only with a connection locator.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_connection: Option<ConnectionCredentialTarget>,
}

impl ConfigurationCredentialExportInput {
    pub fn new(
        locator: CredentialLocator,
        expected_connection: Option<ConnectionCredentialTarget>,
    ) -> Self {
        Self { locator, expected_connection }
    }
}

/// A secret read back. Its `Debug` leaves the secret out.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ExportedConfigurationCredential {
    pub locator: CredentialLocator,
    /// The secret's UTF-8 bytes, canonical padded base64.
    pub secret_base64: String,
    /// Only on the network proxy's password: the proxy it belongs to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_target: Option<NetworkProxyCredentialTarget>,
}

impl std::fmt::Debug for ExportedConfigurationCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExportedConfigurationCredential")
            .field("locator", &self.locator)
            .field("proxy_target", &self.proxy_target)
            .finish_non_exhaustive()
    }
}

impl ExportedConfigurationCredential {
    /// The secret, when it is base64 of UTF-8 text as the Host sends it.
    pub fn secret(&self) -> Option<String> {
        let bytes = base64::engine::general_purpose::STANDARD.decode(&self.secret_base64).ok()?;
        String::from_utf8(bytes).ok()
    }
}

/// `connectionStale`: the connection the caller named, and what it is now
/// (`None` when it is gone).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ConnectionStale {
    pub expected: ConnectionVersionBasis,
    pub actual: Option<ConnectionVersionBasis>,
}

/// `ConfigurationCredentialExportResult`: the secret (`None` when none is
/// saved), or the connection that moved on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ConfigurationCredentialExportResult {
    pub credential: Option<ExportedConfigurationCredential>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_stale: Option<ConnectionStale>,
}

/// `configuration.credentials.export` (mode `query`).
#[derive(Debug)]
pub enum ConfigurationCredentialsExport {}

impl Operation for ConfigurationCredentialsExport {
    const NAME: &'static str = "configuration.credentials.export";
    type Input = ConfigurationCredentialExportInput;
    type Output = ConfigurationCredentialExportResult;
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;
    use crate::CredentialKind;

    fn round_trip<T: Serialize + serde::de::DeserializeOwned>(wire: &Value) -> T {
        let decoded: T = serde_json::from_value(wire.clone()).expect("decode");
        assert_eq!(&serde_json::to_value(&decoded).expect("encode"), wire);
        decoded
    }

    #[test]
    fn an_endpoint_is_canonical_as_node_writes_it() {
        assert_eq!(
            canonical_effective_base_url("custom", Some(" http://127.0.0.1:11434/v1 ")).as_deref(),
            Some("http://127.0.0.1:11434/v1")
        );
        assert_eq!(
            canonical_effective_base_url("custom", Some("HTTPS://Example.COM")).as_deref(),
            Some("https://example.com/")
        );
        assert_eq!(
            canonical_effective_base_url("deepseek", None).as_deref(),
            Some("https://api.deepseek.com/"),
            "the provider's"
        );
        assert_eq!(canonical_effective_base_url("custom", None), None);
    }

    #[test]
    fn an_export_names_its_target_and_decodes_the_secret() {
        let target = ConnectionCredentialTarget::new(
            "c1",
            4,
            "relay",
            "custom",
            Some("https://r.example/v1"),
        )
        .expect("target");
        let input = ConfigurationCredentialExportInput::new(
            CredentialLocator::Connection {
                connection_id: "c1".into(),
                kind: CredentialKind::ApiKey,
            },
            Some(target),
        );
        assert_eq!(
            serde_json::to_value(&input).expect("encode"),
            json!({"locator": {"scope": "connection", "connectionId": "c1", "kind": "api_key"},
                   "expectedConnection": {"connectionId": "c1", "revision": 4, "slug": "relay",
                       "providerType": "custom", "effectiveBaseUrl": "https://r.example/v1"}})
        );
        let result: ConfigurationCredentialExportResult = round_trip(&json!({
            "credential": {"locator": {"scope": "network_proxy", "kind": "password"},
                           "secretBase64": "c2VjcmV0",
                           "proxyTarget": {"protocol": "http", "host": "proxy.local",
                                           "port": 8080, "username": "ada"}}
        }));
        assert_eq!(result.credential.expect("credential").secret().as_deref(), Some("secret"));
        let stale: ConfigurationCredentialExportResult = round_trip(&json!({
            "credential": null,
            "connectionStale": {"expected": {"connectionId": "c1", "revision": 4},
                                "actual": {"connectionId": "c1", "revision": 5}}
        }));
        assert!(stale.connection_stale.is_some());
        let none: ConfigurationCredentialExportResult = round_trip(&json!({"credential": null}));
        assert_eq!(none.credential, None);
    }
}
