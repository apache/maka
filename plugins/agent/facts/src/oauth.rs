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

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Target {
    Create {
        provider: crate::provider::Identity,
        configuration: serde_json::Value,
        slug: String,
        name: String,
    },
    Existing {
        expected: crate::configuration::ConnectionCredentialTarget,
        configuration: serde_json::Value,
    },
}

/// Authentication input may contain secrets; it is never a public projection.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoginStart {
    pub attempt_id: String,
    pub target: Target,
    /// The caller's observed vault generation; null explicitly expects absence.
    #[serde(deserialize_with = "Option::deserialize")]
    pub expected_credential: Option<crate::configuration::CredentialVersionBasis>,
    pub authentication: crate::provider::AuthenticationInput,
}

impl LoginStart {
    pub fn recovery(&self) -> LoginRecovery {
        LoginRecovery {
            attempt_id: self.attempt_id.clone(),
            target: self.target.clone(),
        }
    }

    /// Bind the complete request without persisting secret-bearing form input.
    /// The attempt nonce domain-separates otherwise identical authentication.
    pub fn fingerprint(&self) -> Result<String, String> {
        use sha2::{Digest, Sha256};
        let mut value = serde_json::to_value(self).map_err(|_| "invalid authentication request")?;
        value.sort_all_objects();
        let bytes = serde_json::to_vec(&value).map_err(|_| "invalid authentication request")?;
        Ok(format!("sha256:{}", hex::encode(Sha256::digest(bytes))))
    }

    pub fn validate(&self) -> Result<(), String> {
        validate_attempt(&self.attempt_id, &self.target)?;
        if let Some(expected) = &self.expected_credential {
            use crate::configuration::{ConnectionCredentialKind, CredentialLocator, validation};
            validation::credential_basis(expected)?;
            let Target::Existing {
                expected: connection,
                ..
            } = &self.target
            else {
                return Err("new connection must expect no credential".into());
            };
            if expected.locator
                != (CredentialLocator::Connection {
                    connection_id: connection.connection_id.clone(),
                    kind: ConnectionCredentialKind::Provider,
                })
            {
                return Err("credential belongs to another connection".into());
            }
        }
        self.authentication.validate()
    }
}

/// Public recovery basis. Authentication input is never needed to observe or
/// cancel an admitted attempt, and must not enter client recovery storage.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoginRecovery {
    pub attempt_id: String,
    pub target: Target,
}
impl LoginRecovery {
    pub fn validate(&self) -> Result<(), String> {
        validate_attempt(&self.attempt_id, &self.target)
    }
}
fn validate_attempt(id: &str, target: &Target) -> Result<(), String> {
    target.validate_create_identity()?;
    if id.is_empty()
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
    {
        return Err("invalid authentication attempt".into());
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Attempt {
    pub attempt_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionIdentity {
    pub connection_id: String,
    pub slug: String,
    pub provider: crate::provider::Identity,
}
impl Target {
    pub fn validate_create_identity(&self) -> Result<(), String> {
        use crate::configuration::validation;
        if let Self::Create {
            provider,
            configuration,
            slug,
            ..
        } = self
        {
            provider.validate()?;
            validation::provider_configuration(configuration)?;
            validation::slug(slug)?;
        } else if let Self::Existing {
            expected,
            configuration,
        } = self
        {
            validation::credential_target(expected)?;
            validation::provider_configuration(configuration)?;
        }
        Ok(())
    }

    pub fn matches(&self, connection: &ConnectionIdentity) -> bool {
        match self {
            Self::Create { provider, slug, .. } => {
                *provider == connection.provider && *slug == connection.slug
            }
            Self::Existing { expected, .. } => {
                expected.connection_id == connection.connection_id
                    && expected.provider == connection.provider
                    && expected.slug == connection.slug
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Failure {
    CapabilityUnavailable,
    AuthorizationFailed,
    ProviderRejected,
    /// Bounded, caller-safe explanation supplied by the provider plugin.
    Provider {
        message: String,
    },
    SlugTaken,
    CredentialChanged,
    ConnectionChanged,
    PersistenceFailed,
    InternalFailure,
    OutcomeUnknown,
}

/// Failure cannot accompany a successful or pending login.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum Phase {
    AwaitingAuthorization,
    Exchanging,
    Committing,
    Authenticated,
    Cancelled,
    Failed { failure: Failure },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginProjection {
    pub attempt_id: String,
    pub connection: ConnectionIdentity,
    #[serde(flatten)]
    pub phase: Phase,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnrollmentQuery {
    pub provider: crate::provider::Identity,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnrollmentProjection {
    pub provider: crate::provider::Identity,
    pub enabled: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "method",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum PresentationRequest {
    OpenExternal {
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        state_hint: Option<String>,
    },
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PresentationResult {
    Presented,
}
