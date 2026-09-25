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

use maka_client_capability::{Identity, PrincipalKind};
use maka_config::{
    ConfigurationStore,
    access::{AccessCredential, CredentialState},
};
use maka_protocol::{Operation, Request};
use maka_runtime::access::ManagedPrincipalKind;
use serde_json::Value;

/// Transport-derived authority; a remote bearer can never become a local owner.
#[derive(Clone)]
pub(super) enum Authority {
    LocalOwner,
    Managed(Box<AccessCredential>),
}

pub(super) const CAPABILITY_PROVIDER_GRANTS: [Operation; 3] = [
    Operation::HostStatus,
    Operation::ClientCapabilityReplace,
    Operation::ClientCapabilityUnregister,
];

impl Authority {
    pub(super) fn credential(&self) -> Option<&AccessCredential> {
        match self {
            Self::LocalOwner => None,
            Self::Managed(credential) => Some(credential),
        }
    }

    pub(super) async fn validate_client(
        &self,
        configuration: &ConfigurationStore,
        client: &str,
    ) -> Result<(), super::HostError> {
        let Some(credential) = self.credential() else {
            return Ok(());
        };
        if credential
            .client_instance_id()
            .is_some_and(|bound| bound != client)
        {
            return Err("Access credential belongs to another Client".into());
        }
        if credential.principal_kind == ManagedPrincipalKind::RemoteOwner
            && credential.client_instance_id().is_none()
            && configuration
                .has_active_bound_client_identity(credential.principal_id.clone(), client.into())
                .await?
        {
            return Err("Client identity is bound to another access credential".into());
        }
        Ok(())
    }

    pub(super) fn capability_identity(&self, client_instance_id: String) -> Option<Identity> {
        // A restricted pairing transport cannot publish or start Turns. It
        // must not pin an unbound registry identity across the required reconnect.
        if self.credential().is_some_and(restricted_candidate) {
            return None;
        }
        let (principal_kind, principal_id) = match self {
            Self::LocalOwner => (PrincipalKind::LocalOwner, "local_os_user".into()),
            Self::Managed(credential) => (
                match credential.principal_kind {
                    ManagedPrincipalKind::RemoteOwner => PrincipalKind::RemoteOwner,
                    ManagedPrincipalKind::CapabilityProvider => PrincipalKind::CapabilityProvider,
                },
                credential.principal_id.clone(),
            ),
        };
        Some(Identity {
            principal_kind,
            principal_id,
            client_instance_id,
            credential_bound_client_instance_id: self
                .credential()
                .and_then(|c| c.client_instance_id())
                .map(str::to_owned),
            capability_owner: self.credential().and_then(|c| c.capability_owner.clone()),
        })
    }

    pub(super) fn can_publish_capabilities(&self) -> bool {
        match self {
            Self::LocalOwner => true,
            Self::Managed(credential) => {
                !restricted_candidate(credential) && credential.can_publish_client_capabilities
            }
        }
    }

    pub(super) fn has_grant(&self, operation: Operation) -> bool {
        match self {
            Self::LocalOwner => true,
            Self::Managed(credential) => {
                // Persisted grants never override the running principal policy.
                if credential.principal_kind == ManagedPrincipalKind::CapabilityProvider
                    && !CAPABILITY_PROVIDER_GRANTS.contains(&operation)
                {
                    return false;
                }
                if restricted_candidate(credential) {
                    return matches!(
                        operation,
                        Operation::HostStatus | Operation::AccessCredentialFinalize
                    );
                }
                if credential.client_instance_id().is_some()
                    && operation == Operation::AccessCredentialFinalize
                {
                    return true;
                }
                credential
                    .grants
                    .iter()
                    .any(|name| name == operation.as_str())
            }
        }
    }

    pub(super) fn authorizes(&self, request: &Request) -> bool {
        let Self::Managed(_) = self else {
            return true;
        };
        request.operation.allows_remote_owner()
            && self.has_grant(request.operation)
            && (self.can_publish_capabilities()
                || !matches!(
                    request.operation,
                    Operation::ClientCapabilityReplace | Operation::ClientCapabilityUnregister
                ))
            && (self.can_use_host_paths() || path_free(request))
    }

    pub(super) fn can_use_host_paths(&self) -> bool {
        match self {
            Self::LocalOwner => true,
            Self::Managed(credential) => {
                !restricted_candidate(credential) && credential.can_use_host_paths
            }
        }
    }

    pub(super) fn receives(&self, notice: &Value) -> bool {
        let operation = match notice["kind"].as_str() {
            Some("plugin.client.changed") => Operation::PluginClientQuery,
            Some("plugin.terminal.changed" | "plugin.platform.changed") => {
                Operation::PluginPlatformQuery
            }
            Some("model.provider.catalog.changed") => Operation::ModelProviderCatalogQuery,
            Some("configuration.changed") => Operation::RuntimePolicyQuery,
            Some("connection.catalog.changed") => Operation::ConnectionCatalogQuery,
            Some("project.catalog.changed") => Operation::ProjectCatalogQuery,
            Some("session.catalog.changed") => Operation::SessionCatalogQuery,
            _ => return false,
        };
        self.has_grant(operation)
    }
}

fn restricted_candidate(credential: &AccessCredential) -> bool {
    matches!(
        credential.state,
        CredentialState::Pending {
            bind_client_instance: true,
            ..
        }
    )
}

/// Explicitly reviewed installed operations. Adding an operation does not
/// silently grant host-path access to restricted remote credentials.
fn path_free(request: &Request) -> bool {
    match request.operation {
        // Remote endpoints declare additional path requirements; dispatch
        // checks those against the current transport authority before binding
        // or calling. Ordinary UI reads do not imply filesystem privileges.
        Operation::PluginClientQuery | Operation::PluginRemote => true,
        Operation::PluginAuthorization => serde_json::from_value::<
            maka_protocol::plugin::AuthorizationInput,
        >(request.input.clone())
        .is_ok_and(|input| !input.uses_host_paths()),
        Operation::ProjectCatalogQuery => maka_protocol::project::decode_query(&request.input)
            .is_ok_and(|input| !input.uses_host_paths()),
        Operation::ProjectCatalogMutate => maka_protocol::project::decode_mutation(&request.input)
            .is_ok_and(|input| !input.uses_host_paths()),
        Operation::ClientCapabilityReplace => request.input["offers"]
            .as_array()
            .is_some_and(|offers| offers.iter().all(|offer| offer["hostPathAccess"] != "cwd")),
        Operation::SessionCreate | Operation::SessionWorkspaceRelocate => {
            request.input["workspace"]["kind"] != "host_path"
        }
        Operation::ClientCapabilityUnregister
        | Operation::ArtifactIngest
        | Operation::ArtifactQuery
        | Operation::RuntimeResourceQuery
        | Operation::RuntimeResourceStart
        | Operation::RuntimeResourceStop
        | Operation::RuntimeResourceControllerAcquire
        | Operation::RuntimeResourceControllerControl
        | Operation::RuntimeResourceControllerRelease
        | Operation::ArtifactDelete
        | Operation::AccessCredentialFinalize
        | Operation::InteractionQuery
        | Operation::InteractionAnswer
        | Operation::HostStatus
        | Operation::ConnectionCatalogQuery
        | Operation::ExecutorCatalogQuery
        | Operation::ModelProviderCatalogQuery
        | Operation::PricingQuery
        | Operation::PricingMutate
        | Operation::ConnectionModelsFetch
        | Operation::ConnectionOnboardingVerify
        | Operation::ConnectionOnboardingSave
        | Operation::ConnectionTestRun
        | Operation::ConnectionCatalogCreate
        | Operation::ConnectionCatalogUpdate
        | Operation::ConnectionCatalogRemove
        | Operation::ConnectionCatalogSetDefaultTarget
        | Operation::CredentialVaultQuery
        | Operation::CredentialVaultSet
        | Operation::CredentialVaultDelete
        | Operation::SessionCatalogQuery
        | Operation::SessionBranchCreate
        | Operation::SessionRevisionCreate
        | Operation::SessionRevisionAbandon
        | Operation::SessionCopyQuery
        | Operation::SessionSourcesQuery
        | Operation::SessionExecutionBoundaryQuery
        | Operation::SessionTurnsQuery
        | Operation::SessionTurnLandmarksQuery
        | Operation::SessionLifecycleSet
        | Operation::SessionRemove
        | Operation::SessionRemovePreview
        | Operation::SessionRemoveQuery
        | Operation::SessionMetadataUpdate
        | Operation::SessionReadMarkerSet
        | Operation::SessionConfigurationUpdate
        | Operation::TurnStart
        | Operation::TurnBatchStart
        | Operation::TurnResumeQuery
        | Operation::TurnResumeStart
        | Operation::TurnMessageQuery
        | Operation::TurnMessageSubmit
        | Operation::TurnMessageExecutionQuery
        | Operation::QueueRetract
        | Operation::QueueEntryRetract
        | Operation::QueueEntryPromote
        | Operation::QueueEntryUpdate
        | Operation::QueueEntriesReorder
        | Operation::ContextCompact
        | Operation::ContextDiagnosticsQuery
        | Operation::TurnQuery
        | Operation::TurnStop
        | Operation::SubscriptionOpen
        | Operation::SubscriptionClose
        | Operation::SubscriptionPtyInterestSet
        | Operation::SessionTranscriptPage
        | Operation::SessionTranscriptSearch
        | Operation::SubscriptionReady => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn provider_policy_caps_persisted_grants_without_rewriting_evidence_or_owner_authority() {
        let mut credential = AccessCredential {
            credential_id: "provider-credential".into(),
            credential_hash: "a".repeat(64),
            principal_id: "provider-principal".into(),
            principal_kind: ManagedPrincipalKind::CapabilityProvider,
            grants: Operation::ALL.iter().map(|op| op.as_str().into()).collect(),
            can_publish_client_capabilities: true,
            can_use_host_paths: false,
            created_at: "2026-09-12T00:00:00Z".into(),
            state: CredentialState::Active {
                client_instance_id: None,
            },
            capability_owner: None,
        };
        credential.grants.push("future.operation".into());
        let provider = Authority::Managed(Box::new(credential.clone()));
        for &operation in Operation::ALL {
            let request = Request {
                request_id: "request".into(),
                operation,
                input: json!({"offers": []}),
            };
            assert_eq!(
                provider.authorizes(&request),
                CAPABILITY_PROVIDER_GRANTS.contains(&operation),
                "{operation}"
            );
        }
        let notice = json!({"kind": "connection.catalog.changed", "revision": 1});
        assert!(!provider.receives(&notice));
        let provider_identity = provider.capability_identity("client".into()).unwrap();
        assert!(provider_identity.trusted());
        assert!(provider_identity.capability_owner.is_none());
        assert!(
            provider_identity
                .credential_bound_client_instance_id
                .is_none()
        );
        let Authority::Managed(retained) = provider else {
            unreachable!()
        };
        assert_eq!(retained.grants, credential.grants);

        credential.principal_kind = ManagedPrincipalKind::RemoteOwner;
        let mut owner = Authority::Managed(Box::new(credential));
        assert!(owner.receives(&notice));
        for (input, allowed) in [
            (json!({"kind":"directory_roots"}), true),
            (
                json!({"kind":"directory_list_start","rootId":"root-1","segments":[]}),
                true,
            ),
            (
                json!({"kind":"directory_resolve","rootId":"root-1","segments":[]}),
                false,
            ),
        ] {
            let request = Request {
                request_id: "directory".into(),
                operation: Operation::ProjectCatalogQuery,
                input,
            };
            assert_eq!(owner.authorizes(&request), allowed);
            assert!(Authority::LocalOwner.authorizes(&request));
            let mut authorized = owner.clone();
            let Authority::Managed(credential) = &mut authorized else {
                unreachable!()
            };
            credential.can_use_host_paths = true;
            assert!(authorized.authorizes(&request));
            let Authority::Managed(credential) = &mut authorized else {
                unreachable!()
            };
            credential
                .grants
                .retain(|name| name != "project.catalog.query");
            assert!(!authorized.authorizes(&request));
        }
        let owner_identity = owner.capability_identity("client".into()).unwrap();
        assert!(!owner_identity.trusted());
        assert_ne!(
            owner_identity.provider_id(),
            provider_identity.provider_id()
        );
        for operation in [
            Operation::RuntimeResourceStart,
            Operation::RuntimeResourceStop,
            Operation::RuntimeResourceControllerAcquire,
            Operation::RuntimeResourceControllerControl,
            Operation::RuntimeResourceControllerRelease,
        ] {
            let request = Request {
                request_id: "resource".into(),
                operation,
                input: json!({}),
            };
            assert!(
                owner.authorizes(&request),
                "Session resource access selects no new host path"
            );
            let Authority::Managed(credential) = &mut owner else {
                unreachable!()
            };
            credential.grants.retain(|name| name != operation.as_str());
            assert!(
                !owner.authorizes(&request),
                "operation grants remain required"
            );
        }
    }
}
