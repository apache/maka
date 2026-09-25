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

use crate::ProtocolError;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationMode {
    Command,
    Query,
    Control,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Availability {
    Bootstrap,
    Ready,
}

macro_rules! operations {
    ($($variant:ident => ($wire:literal, $mode:ident, $availability:ident)),+ $(,)?) => {
        /// Closed protocol vocabulary; registration is a separate
        /// implementation concern and never changes an operation's identity.
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum Operation { $(#[serde(rename = $wire)] $variant),+ }
impl Operation {
            pub const ALL: &'static [Self] = &[$(Self::$variant),+];
            pub const fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $wire),+ }
            }
            pub const fn mode(self) -> OperationMode {
                match self { $(Self::$variant => OperationMode::$mode),+ }
            }
            pub const fn availability(self) -> Availability {
                match self { $(Self::$variant => Availability::$availability),+ }
            }
        }
        impl std::str::FromStr for Operation {
            type Err = ProtocolError;
            fn from_str(value: &str) -> Result<Self, Self::Err> {
                match value {
                    $($wire => Ok(Self::$variant),)+
                    _ => Err(ProtocolError::invalid("Unknown operation key")),
                }
            }
        }
    }
}

impl std::fmt::Display for Operation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl Operation {
    /// Declared rejection code for a Host that does not implement this operation.
    pub const fn unavailable_error(self) -> crate::OperationErrorCode {
        use crate::OperationErrorCode;
        match self {
            Self::HostStatus | Self::HostDiagnosticsQuery | Self::HostResourcesQuery => {
                OperationErrorCode::InternalFailure
            }
            _ => OperationErrorCode::OperationUnavailable,
        }
    }
}

operations! {
    SandboxSetupQuery => ("sandbox.setup.query", Query, Ready),
    SandboxSetupInstall => ("sandbox.setup.install", Command, Ready),
    SandboxSetupRemove => ("sandbox.setup.remove", Command, Ready),
    AccessCredentialFinalize => ("access.credential.finalize", Command, Ready),
    AccessCredentialIssue => ("access.credential.issue", Command, Ready),
    AccessCredentialPrepare => ("access.credential.prepare", Command, Ready),
    AccessCredentialReplace => ("access.credential.replace", Command, Ready),
    AccessCredentialRevoke => ("access.credential.revoke", Command, Ready),
    AccessCredentialRotationPrepare => ("access.credential.rotation.prepare", Command, Ready),
    AccessCredentialRotationRevoke => ("access.credential.rotation.revoke", Command, Ready),
    AccessPrincipalRevoke => ("access.principal.revoke", Command, Ready),
    AgentGraphEpochsQuery => ("agent.graph.epochs.query", Query, Ready),
    AgentGraphOperatorQuery => ("agent.graph.operator.query", Query, Ready),
    AgentGraphQuery => ("agent.graph.query", Query, Ready),
    AgentGraphStop => ("agent.graph.stop", Control, Ready),
    ArtifactDelete => ("artifact.delete", Command, Ready),
    ArtifactIngest => ("artifact.ingest", Command, Ready),
    ArtifactQuery => ("artifact.query", Query, Ready),
    ClientCapabilityReplace => ("client.capability.replace", Command, Ready),
    ClientCapabilityUnregister => ("client.capability.unregister", Command, Ready),
    CollaborationAccessQuery => ("collaboration.access.query", Query, Ready),
    CollaborationGrantRevoke => ("collaboration.grant.revoke", Command, Ready),
    CollaborationInvitationPrepare => ("collaboration.invitation.prepare", Command, Ready),
    CollaborationPrincipalRename => ("collaboration.principal.rename", Command, Ready),
    CollaborationPrincipalRevoke => ("collaboration.principal.revoke", Command, Ready),
    CollaborationTurnRequestAcknowledge => ("collaboration.turn-request.acknowledge", Command, Ready),
    CollaborationTurnRequestCreate => ("collaboration.turn-request.create", Command, Ready),
    CollaborationTurnRequestDecide => ("collaboration.turn-request.decide", Command, Ready),
    CollaborationTurnRequestQuery => ("collaboration.turn-request.query", Query, Ready),
    CollaborationTurnRequestWithdraw => ("collaboration.turn-request.withdraw", Command, Ready),
    ConfigurationCredentialsExport => ("configuration.credentials.export", Query, Ready),
    ConnectionCatalogCreate => ("connection.catalog.create", Command, Ready),
    ConnectionCatalogQuery => ("connection.catalog.query", Query, Ready),
    ModelProviderCatalogQuery => ("model.provider.catalog.query", Query, Ready),
    ConnectionCatalogRemove => ("connection.catalog.remove", Command, Ready),
    ConnectionCatalogSetDefaultTarget => ("connection.catalog.set-default-target", Command, Ready),
    ConnectionCatalogUpdate => ("connection.catalog.update", Command, Ready),
    ConnectionModelsFetch => ("connection.models.fetch", Command, Ready),
    ConnectionOnboardingSave => ("connection.onboarding.save", Command, Ready),
    ConnectionOnboardingVerify => ("connection.onboarding.verify", Command, Ready),
    ConnectionRequestHeadersQuery => ("connection.request-headers.query", Query, Ready),
    ConnectionRequestHeadersReplace => ("connection.request-headers.replace", Command, Ready),
    ConnectionTestRun => ("connection.test.run", Command, Ready),
    ContextCompact => ("context.compact", Command, Ready),
    ContextDiagnosticsQuery => ("context.diagnostics.query", Query, Ready),
    CredentialVaultDelete => ("credential.vault.delete", Command, Ready),
    CredentialVaultQuery => ("credential.vault.query", Query, Ready),
    CredentialVaultSet => ("credential.vault.set", Command, Ready),
    DailyReviewMutate => ("daily-review.mutate", Command, Ready),
    DailyReviewQuery => ("daily-review.query", Query, Ready),
    ExecutionInspectQuery => ("execution.inspect.query", Query, Ready),
    ExternalSessionCatalogQuery => ("external-session.catalog.query", Query, Ready),
    ExternalAgentsSetupStart => ("external_agents.setup.start", Command, Ready),
    ExternalAgentsSetupQuery => ("external_agents.setup.query", Query, Ready),
    ExternalAgentsSetupCancel => ("external_agents.setup.cancel", Control, Ready),
    SessionBundlePreview => ("session-bundle.preview", Query, Ready),
    SessionBundleExport => ("session-bundle.export", Command, Ready),
    SessionBundleImport => ("session-bundle.import", Command, Ready),
    ExternalSessionImport => ("external-session.import", Command, Ready),
    ExternalSessionSourceQuery => ("external-session.source.query", Query, Ready),
    GoalArm => ("goal.arm", Control, Ready),
    GoalControl => ("goal.control", Control, Ready),
    GoalQuery => ("goal.query", Query, Ready),
    HostDiagnosticsQuery => ("host.diagnostics.query", Query, Bootstrap),
    HostResourcesQuery => ("host.resources.query", Query, Bootstrap),
    HostStatus => ("host.status", Query, Bootstrap),
    HostWake => ("host.wake", Command, Ready),
    HostUpgradePrepare => ("host.upgrade.prepare", Command, Ready),
    HostedExecutionCancel => ("hosted.execution.cancel", Control, Ready),
    HostedExecutionStart => ("hosted.execution.start", Command, Ready),
    InteractionAnswer => ("interaction.answer", Command, Ready),
    InteractionQuery => ("interaction.query", Query, Ready),
    MemoryMutate => ("memory.mutate", Command, Ready),
    MemoryQuery => ("memory.query", Query, Ready),
    NetworkProxyTest => ("network-proxy.test", Command, Ready),
    OauthEnrollmentQuery => ("oauth.enrollment.query", Query, Ready),
    OauthLoginCancel => ("oauth.login.cancel", Control, Ready),
    OauthLoginQuery => ("oauth.login.query", Query, Ready),
    OauthLoginStart => ("oauth.login.start", Command, Ready),
    PeerMeshClose => ("peer.mesh.close", Command, Ready),
    PeerMeshCreate => ("peer.mesh.create", Command, Ready),
    PeerMeshDisplayNameSet => ("peer.mesh.display-name.set", Command, Ready),
    PeerMeshInvite => ("peer.mesh.invite", Command, Ready),
    PeerMeshJoin => ("peer.mesh.join", Command, Ready),
    PeerMeshLeave => ("peer.mesh.leave", Command, Ready),
    PeerMeshQuery => ("peer.mesh.query", Query, Ready),
    PeerMeshReconcile => ("peer.mesh.reconcile", Command, Ready),
    PeerMeshRemove => ("peer.mesh.remove", Command, Ready),
    PeerMeshRename => ("peer.mesh.rename", Command, Ready),
    PeerMeshTransitSet => ("peer.mesh.transit.set", Command, Ready),
    PlanControl => ("plan.control", Control, Ready),
    PlanQuery => ("plan.query", Query, Ready),
    PlanTurnStart => ("plan.turn.start", Command, Ready),
    PluginClientQuery => ("plugin.client.query", Query, Ready),
    PluginRemote => ("plugin.remote", Command, Ready),
    PluginAuthorization => ("plugin.authorization", Command, Ready),
    PluginCompositionApply => ("plugin.composition.apply", Command, Ready),
    PluginPackageExport => ("plugin.package.export", Command, Ready),
    PluginPackageInstall => ("plugin.package.install", Command, Ready),
    PluginPackagePreview => ("plugin.package.preview", Query, Ready),
    PluginPackageReload => ("plugin.package.reload", Command, Ready),
    PluginPackageUninstall => ("plugin.package.uninstall", Command, Ready),
    PluginPlatformQuery => ("plugin.platform.query", Query, Ready),
    ExecutorCatalogQuery => ("executor.catalog.query", Query, Ready),
    PluginPlatformReconcile => ("plugin.platform.reconcile", Command, Ready),
    PricingMutate => ("pricing.mutate", Command, Ready),
    PricingQuery => ("pricing.query", Query, Ready),
    ProjectCatalogMutate => ("project.catalog.mutate", Command, Ready),
    ProjectCatalogQuery => ("project.catalog.query", Query, Ready),
    QueueEntriesReorder => ("queue.entries.reorder", Command, Ready),
    QueueEntryPromote => ("queue.entry.promote", Command, Ready),
    QueueEntryRetract => ("queue.entry.retract", Command, Ready),
    QueueEntryUpdate => ("queue.entry.update", Command, Ready),
    QueueRetract => ("queue.retract", Command, Ready),
    RuntimePolicyMutate => ("runtime.policy.mutate", Command, Ready),
    RuntimePolicyNetworkProxyUpdate => ("runtime.policy.network-proxy.update", Command, Ready),
    RuntimePolicyQuery => ("runtime.policy.query", Query, Ready),
    RuntimeResourceControllerAcquire => ("runtime.resource.controller.acquire", Control, Ready),
    RuntimeResourceControllerControl => ("runtime.resource.controller.control", Control, Ready),
    RuntimeResourceControllerRelease => ("runtime.resource.controller.release", Control, Ready),
    RuntimeResourceQuery => ("runtime.resource.query", Query, Ready),
    RuntimeResourceStart => ("runtime.resource.start", Command, Ready),
    RuntimeResourceStop => ("runtime.resource.stop", Control, Ready),
    SessionBranchCreate => ("session.branch.create", Command, Ready),
    SessionCatalogQuery => ("session.catalog.query", Query, Ready),
    SessionConfigurationUpdate => ("session.configuration.update", Command, Ready),
    SessionCopyQuery => ("session.copy.query", Query, Ready),
    SessionSourcesQuery => ("session.sources.query", Query, Ready),
    SessionCreate => ("session.create", Command, Ready),
    SessionExecutionBoundaryQuery => ("session.execution_boundary.query", Query, Ready),
    SessionLifecycleSet => ("session.lifecycle.set", Command, Ready),
    SessionMetadataUpdate => ("session.metadata.update", Command, Ready),
    SessionReadMarkerSet => ("session.read_marker.set", Command, Ready),
    SessionRecapGenerate => ("session.recap.generate", Command, Ready),
    SessionRemove => ("session.remove", Command, Ready),
    SessionRemovePreview => ("session.remove.preview", Query, Ready),
    SessionRemoveQuery => ("session.remove.query", Query, Ready),
    SessionRevisionAbandon => ("session.revision.abandon", Command, Ready),
    SessionRevisionCreate => ("session.revision.create", Command, Ready),
    SessionSharedQuery => ("session.shared.query", Query, Ready),
    SubscriptionReady => ("subscription.ready", Control, Ready),
    SessionTranscriptPage => ("session.transcript.page", Query, Ready),
    SessionTranscriptSearch => ("session.transcript.search", Query, Ready),
    SessionTurnLandmarksQuery => ("session.turn_landmarks.query", Query, Ready),
    SessionTurnsQuery => ("session.turns.query", Query, Ready),
    SessionWorkspaceRelocate => ("session.workspace.relocate", Command, Ready),
    SubscriptionClose => ("subscription.close", Control, Ready),
    SubscriptionOpen => ("subscription.open", Control, Ready),
    SubscriptionPtyInterestSet => ("subscription.pty_interest.set", Control, Ready),
    TurnInterrupt => ("turn.interrupt", Control, Ready),
    TurnMessageExecutionQuery => ("turn.message.execution.query", Query, Ready),
    TurnMessageQuery => ("turn.message.query", Query, Ready),
    TurnMessageSubmit => ("turn.message.submit", Command, Ready),
    TurnQuery => ("turn.query", Query, Ready),
    TurnResumeQuery => ("turn.resume.query", Query, Ready),
    TurnResumeStart => ("turn.resume.start", Command, Ready),
    TurnStart => ("turn.start", Command, Ready),
    TurnBatchStart => ("turn.batch.start", Command, Ready),
    TurnStop => ("turn.stop", Control, Ready),
    UsageQuery => ("usage.query", Query, Ready),
}
