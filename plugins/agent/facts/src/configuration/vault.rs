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
use super::*;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionCredentialKind {
    Provider,
    RequestHeaders,
    Usage,
}

/// The cloud access key used only to read this connection's usage.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageAccessKey {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub team_id: Option<String>,
}

impl UsageAccessKey {
    pub fn parse(value: &str) -> Result<Self, String> {
        const INVALID: &str = "invalid usage access key";
        let key: Self = serde_json::from_str(value).map_err(|_| INVALID)?;
        let valid_id = |value: &str| {
            !value.is_empty()
                && value.len() <= 512
                && value
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
        };
        if !valid_id(&key.access_key_id)
            || !key.team_id.as_deref().is_none_or(valid_id)
            || key.secret_access_key.is_empty()
            || key.secret_access_key.len() > 512
            || key
                .secret_access_key
                .chars()
                .any(|c| c.is_whitespace() || c.is_control())
        {
            return Err(INVALID.into());
        }
        Ok(key)
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PasswordKind {
    Password,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "scope",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CredentialLocator {
    Connection {
        connection_id: String,
        kind: ConnectionCredentialKind,
    },
    NetworkProxy {
        kind: PasswordKind,
    },
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialIdentityBasis {
    pub credential_id: String,
    pub revision: u64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialVersionBasis {
    pub locator: CredentialLocator,
    pub credential_id: String,
    pub revision: u64,
}
#[derive(Debug, Clone, PartialEq)]
pub struct CredentialStatus {
    pub locator: CredentialLocator,
    pub state: CredentialState,
}
impl CredentialStatus {
    pub fn basis(&self) -> Option<CredentialVersionBasis> {
        let CredentialState::Configured {
            credential_id,
            revision,
            ..
        } = &self.state
        else {
            return None;
        };
        Some(CredentialVersionBasis {
            locator: self.locator.clone(),
            credential_id: credential_id.clone(),
            revision: *revision,
        })
    }
}
#[derive(Debug, Clone, PartialEq)]
pub enum CredentialState {
    Absent,
    Configured {
        credential_id: String,
        revision: u64,
        updated_at: u64,
    },
}
impl Serialize for CredentialStatus {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let (configured, credential_id, revision, updated_at) = match &self.state {
            CredentialState::Absent => (false, None, None, None),
            CredentialState::Configured {
                credential_id,
                revision,
                updated_at,
            } => (true, Some(credential_id), Some(revision), Some(updated_at)),
        };
        let mut wire = serializer.serialize_struct("CredentialStatus", 5)?;
        wire.serialize_field("locator", &self.locator)?;
        wire.serialize_field("configured", &configured)?;
        wire.serialize_field("credentialId", &credential_id)?;
        wire.serialize_field("revision", &revision)?;
        wire.serialize_field("updatedAt", &updated_at)?;
        wire.end()
    }
}
#[derive(Deserialize, schemars::JsonSchema)]
#[schemars(rename = "CredentialStatus")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CredentialStatusWire {
    locator: CredentialLocator,
    configured: bool,
    // The wire requires these keys even when their values are null.
    #[serde(deserialize_with = "Option::deserialize")]
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<String>")]
    credential_id: Option<String>,
    #[serde(deserialize_with = "Option::deserialize")]
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<u64>")]
    revision: Option<u64>,
    #[serde(deserialize_with = "Option::deserialize")]
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<u64>")]
    updated_at: Option<u64>,
}
impl schemars::JsonSchema for CredentialStatus {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        <CredentialStatusWire as schemars::JsonSchema>::schema_name()
    }
    fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
        <CredentialStatusWire as schemars::JsonSchema>::json_schema(generator)
    }
}
impl<'de> Deserialize<'de> for CredentialStatus {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let wire = CredentialStatusWire::deserialize(deserializer)?;
        let state = match (
            wire.configured,
            wire.credential_id,
            wire.revision,
            wire.updated_at,
        ) {
            (false, None, None, None) => CredentialState::Absent,
            (true, Some(credential_id), Some(revision), Some(updated_at)) => {
                CredentialState::Configured {
                    credential_id,
                    revision,
                    updated_at,
                }
            }
            _ => {
                return Err(serde::de::Error::custom(
                    "credential status metadata contradicts configured",
                ));
            }
        };
        Ok(Self {
            locator: wire.locator,
            state,
        })
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialVaultSnapshot {
    pub revision: u64,
    pub entries: Vec<CredentialStatus>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialVaultQueryInput {
    pub locator: CredentialLocator,
}
/// Secret material deliberately has no Debug or public serialization.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetCredentialInput {
    pub locator: CredentialLocator,
    pub expected: Option<CredentialIdentityBasis>,
    pub expected_connection: Option<ConnectionCredentialTarget>,
    pub secret: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteCredentialInput {
    pub expected: CredentialVersionBasis,
    /// Required for connection credentials; null for network credentials.
    #[serde(deserialize_with = "Option::deserialize")]
    #[schemars(
        with = "maka_plugin_core::wire_schema::RequiredNullable<ConnectionCredentialTarget>"
    )]
    pub expected_connection: Option<ConnectionCredentialTarget>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CredentialVaultQueryResult {
    Status { status: CredentialStatus },
    ConnectionNotFound,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CredentialMutationResult {
    Rejected {
        reason: super::ConfigurationRejection,
    },
    Committed {
        vault_revision: u64,
        status: CredentialStatus,
    },
    ConnectionNotFound,
    ConnectionStale {
        expected: ConnectionVersionBasis,
        #[schemars(
            with = "maka_plugin_core::wire_schema::RequiredNullable<ConnectionVersionBasis>"
        )]
        actual: Option<ConnectionVersionBasis>,
    },
    CredentialStale {
        #[schemars(
            with = "maka_plugin_core::wire_schema::RequiredNullable<CredentialVersionBasis>"
        )]
        expected: Option<CredentialVersionBasis>,
        #[schemars(
            with = "maka_plugin_core::wire_schema::RequiredNullable<CredentialVersionBasis>"
        )]
        actual: Option<CredentialVersionBasis>,
    },
}
pub type SetCredentialResult = CredentialMutationResult;
pub type DeleteCredentialResult = CredentialMutationResult;
