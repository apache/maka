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

//! Access credentials and pairing: `access.credential.prepare` and
//! `access.credential.finalize`.
//!
//! A remote client authenticates its WebSocket upgrade with a bearer access
//! credential. Pairing hands a new client a *pending* credential (prepared by
//! an owner, delivered out of band, for example inside a connection code)
//! that only allows `host.status` and `access.credential.finalize`; the
//! client connects with it and finalizes, which activates it, bound to that
//! client's instance id when the owner asked for that.
//!
//! Source: `packages/runtime-host/src/protocol/access-authority.ts`
//! (`ACCESS_AUTHORITY_OPERATION_SPECS`, `decodeAccessCredentialPrepareInput`,
//! `decodeAccessCredentialIssueResult`, `decodeAccessCredentialFinalizeInput`,
//! `decodeAccessCredentialFinalizeResult`); the Host side is
//! `RuntimeHostAccessAuthority` in `server/access-authority.ts`. Both
//! operations are commands, available once the Host is `ready`, and may fail
//! with `host_not_ready`, `host_draining`, `operation_unavailable`,
//! `invalid_request`, `persistence_failed`, `commit_outcome_unknown`, or
//! `internal_failure`.

use std::fmt;

use serde::{Deserialize, Deserializer, Serialize};
use thiserror::Error;

use super::is_js_whitespace;
use crate::Operation;

/// `RUNTIME_HOST_ACCESS_CREDENTIAL_MAX_BYTES` in `client/host-profile.ts`.
pub const ACCESS_CREDENTIAL_MAX_BYTES: usize = 8 * 1024;

/// A bearer access credential. `Debug` does not print it.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct AccessCredential(String);

/// A credential that is empty, contains whitespace, or exceeds
/// [`ACCESS_CREDENTIAL_MAX_BYTES`].
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("Runtime Host access credential is invalid")]
pub struct InvalidAccessCredential;

impl AccessCredential {
    /// `requireRuntimeHostAccessCredential`: non-empty, no whitespace, at
    /// most 8 KiB. The WebSocket upgrade sends it as
    /// `Authorization: Bearer <credential>`.
    pub fn new(value: impl Into<String>) -> Result<Self, InvalidAccessCredential> {
        let value = value.into();
        let valid = !value.is_empty()
            && value.len() <= ACCESS_CREDENTIAL_MAX_BYTES
            && !value.chars().any(is_js_whitespace);
        if valid { Ok(Self(value)) } else { Err(InvalidAccessCredential) }
    }

    /// The secret itself.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for AccessCredential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("AccessCredential(<redacted>)")
    }
}

impl<'de> Deserialize<'de> for AccessCredential {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

wire_enum! {
    /// `AccessCredentialPrincipalKind`.
    pub enum AccessPrincipalKind {
        RemoteOwner = "remote_owner",
        CapabilityProvider = "capability_provider",
        SessionGuest = "session_guest",
    }
}

/// `AccessCredentialPrepareInput` (`decodeAccessCredentialPrepareInput`).
///
/// The Host refuses a pairing candidate that is not a `remote_owner` or whose
/// grants lack `access.credential.finalize` (`#createCredential`); it always
/// adds `host.status`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct AccessCredentialPrepareInput {
    pub principal_kind: AccessPrincipalKind,
    /// `^[A-Za-z0-9_.:-]+$`, at most 128 bytes.
    pub principal_id: String,
    /// Exact operation names, at most 256, no duplicates.
    pub operation_grants: Vec<String>,
    pub can_publish_client_capabilities: bool,
    pub can_use_host_paths: bool,
    /// Bind the credential to the client instance id that finalizes it.
    /// Until then it allows only `host.status` and the finalize itself, and
    /// finalizing answers `reconnectRequired: true`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bind_client_instance: Option<bool>,
}

impl AccessCredentialPrepareInput {
    /// A pairing candidate for remote owner `principal_id` with
    /// `operation_grants` (which must include `access.credential.finalize`),
    /// no client capability publication, no Host paths, and not bound to a
    /// client instance.
    pub fn remote_owner(
        principal_id: impl Into<String>,
        operation_grants: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        Self {
            principal_kind: AccessPrincipalKind::RemoteOwner,
            principal_id: principal_id.into(),
            operation_grants: operation_grants.into_iter().map(Into::into).collect(),
            can_publish_client_capabilities: false,
            can_use_host_paths: false,
            bind_client_instance: None,
        }
    }

    /// Sets `bindClientInstance`.
    pub fn bind_client_instance(mut self, bind: bool) -> Self {
        self.bind_client_instance = Some(bind);
        self
    }

    /// Sets `canPublishClientCapabilities`.
    pub fn can_publish_client_capabilities(mut self, allowed: bool) -> Self {
        self.can_publish_client_capabilities = allowed;
        self
    }
}

/// `ClientCapabilityOwnerIdentity`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ClientCapabilityOwnerIdentity {
    pub principal_id: String,
    pub client_instance_id: String,
}

/// `AccessCredentialIssueResult` (`decodeAccessCredentialIssueResult`), the
/// result of `access.credential.issue`, `.replace`, `.prepare`, and
/// `.rotation.prepare`.
///
/// The credential itself is not in the result: the Host writes it to a
/// delivery file in the State Root's control directory,
/// `runtime-host-access-delivery-<deliveryId>.json`, which a process on the
/// Host's machine reads and deletes (`consumeAccessCredentialDelivery` in
/// `control/access-credential-delivery.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct AccessCredentialIssueResult {
    pub credential_id: String,
    /// A lowercase UUID v4.
    pub delivery_id: String,
    pub principal_kind: AccessPrincipalKind,
    pub principal_id: String,
    pub operation_grants: Vec<String>,
    pub can_publish_client_capabilities: bool,
    pub can_use_host_paths: bool,
    /// Only on a capability provider credential.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability_owner: Option<ClientCapabilityOwnerIdentity>,
}

/// `access.credential.prepare`: issues a pending pairing credential that
/// expires unless a client finalizes it. The caller must be able to read the
/// Host's control directory to obtain the secret (see
/// [`AccessCredentialIssueResult`]).
#[derive(Debug)]
pub enum AccessCredentialPrepare {}

impl Operation for AccessCredentialPrepare {
    const NAME: &'static str = "access.credential.prepare";
    type Input = AccessCredentialPrepareInput;
    type Output = AccessCredentialIssueResult;
}

/// `AccessCredentialFinalizeInput`: always the empty object.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
pub struct AccessCredentialFinalizeInput {}

/// `AccessCredentialFinalizeResult` (`decodeAccessCredentialFinalizeResult`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct AccessCredentialFinalizeResult {
    /// The credential is active now, but this connection still has the
    /// pending authority: close it and connect again with the same
    /// credential (`#finalize`: set when the credential binds to the client
    /// instance).
    pub reconnect_required: bool,
}

/// `access.credential.finalize`: activates the pending credential the
/// connection authenticated with. Idempotent for the current credential: a
/// repeat after the credential became active answers again (with
/// `reconnectRequired` only on a connection that still has the pending
/// authority), which is what makes retrying after `commit_outcome_unknown`
/// or a lost connection safe. `invalid_request` when the credential is gone,
/// expired, or was claimed by another client instance.
#[derive(Debug)]
pub enum AccessCredentialFinalize {}

impl Operation for AccessCredentialFinalize {
    const NAME: &'static str = "access.credential.finalize";
    type Input = AccessCredentialFinalizeInput;
    type Output = AccessCredentialFinalizeResult;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn credentials_are_validated_and_never_printed() {
        let credential = AccessCredential::new("mrha_secret").expect("valid");
        assert_eq!(credential.expose(), "mrha_secret");
        assert_eq!(format!("{credential:?}"), "AccessCredential(<redacted>)");
        for invalid in ["", "a b", "a\u{a0}b", "a\nb"] {
            assert_eq!(AccessCredential::new(invalid), Err(InvalidAccessCredential), "{invalid:?}");
        }
        assert!(AccessCredential::new("a".repeat(ACCESS_CREDENTIAL_MAX_BYTES)).is_ok());
        assert!(AccessCredential::new("a".repeat(ACCESS_CREDENTIAL_MAX_BYTES + 1)).is_err());
        assert!(serde_json::from_value::<AccessCredential>(json!("a b")).is_err());
    }

    #[test]
    fn prepare_input_matches_the_typescript_shape() {
        let input = AccessCredentialPrepareInput::remote_owner(
            "maka-gpui:test",
            ["access.credential.finalize", "session.catalog.query"],
        )
        .bind_client_instance(true);
        assert_eq!(
            serde_json::to_value(&input).expect("encode"),
            json!({
                "principalKind": "remote_owner",
                "principalId": "maka-gpui:test",
                "operationGrants": ["access.credential.finalize", "session.catalog.query"],
                "canPublishClientCapabilities": false,
                "canUseHostPaths": false,
                "bindClientInstance": true
            })
        );
    }

    /// Recorded from a 197 Host (`runtime-host serve`, apache/maka de4fc5ff9)
    /// for a pairing candidate with the grants above; the Host adds
    /// `host.status`.
    #[test]
    fn issue_and_finalize_results_decode() {
        let issued: AccessCredentialIssueResult = serde_json::from_value(json!({
            "credentialId": "ebcccbe7-2d31-4fe0-8065-9a5dbfd043da",
            "deliveryId": "07b3a90a-5440-4317-a674-93e37e4dadfd",
            "principalKind": "remote_owner",
            "principalId": "maka-gpui-live-test",
            "operationGrants": ["host.status", "access.credential.finalize", "session.catalog.query"],
            "canPublishClientCapabilities": false,
            "canUseHostPaths": false
        }))
        .expect("decode");
        assert_eq!(issued.principal_kind, AccessPrincipalKind::RemoteOwner);
        assert_eq!(issued.operation_grants[0], "host.status");
        assert_eq!(issued.capability_owner, None);

        assert_eq!(
            serde_json::to_value(AccessCredentialFinalizeInput {}).expect("encode"),
            json!({})
        );
        let finalized: AccessCredentialFinalizeResult =
            serde_json::from_value(json!({"reconnectRequired": true})).expect("decode");
        assert!(finalized.reconnect_required);
    }
}
