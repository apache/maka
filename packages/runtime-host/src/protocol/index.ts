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

import { requireCount, requireId, requireRecord, requireString } from './codec.js';
import { invalidProtocolFrame, RuntimeHostProtocolError } from './errors.js';
import {
  decodeHostActivitySnapshot,
  requireHostLifecycleState,
  type HostActivitySnapshot,
} from './host-status.js';
import {
  decodeSubscriptionFrame,
  isSubscriptionFrameKind,
  type SubscriptionFrame,
} from './session-continuity.js';
import {
  decodeClientCapabilityClientFrame,
  decodeClientCapabilityHostFrame,
  isClientCapabilityClientFrameKind,
  isClientCapabilityHostFrameKind,
  type ClientCapabilityClientFrame,
  type ClientCapabilityHostFrame,
} from './client-capability.js';
import {
  decodeConfigurationChangedFrame,
  type ConfigurationChangedFrame,
} from './configuration-change.js';
import {
  decodeSessionCatalogChangedFrame,
  type SessionCatalogChangedFrame,
} from './session-catalog-change.js';
import {
  decodeScheduledTaskChangedFrame,
  type ScheduledTaskChangedFrame,
} from './scheduled-task-change.js';
import {
  decodeProjectCatalogChangedFrame,
  type ProjectCatalogChangedFrame,
} from './project-catalog-change.js';
import {
  decodeConnectionCatalogChangedFrame,
  type ConnectionCatalogChangedFrame,
} from './connection-catalog-change.js';
import {
  decodeRequestFrame,
  decodeResponseFrame,
  type HostLifecycleState,
  type RequestFrame,
  type ResponseFrame,
} from './operations.js';
import { isCanonicalRuntimeHostWebSocketPath } from './websocket-path.js';

export {
  ACCESS_AUTHORITY_OPERATION_SPECS,
  ACCESS_CREDENTIAL_MAX_GRANTS,
  decodeAccessCredentialFinalizeInput,
  decodeAccessCredentialFinalizeResult,
  decodeAccessCredentialIssueInput,
  decodeAccessCredentialIssueResult,
  decodeAccessCredentialPrepareInput,
  decodeAccessCredentialRevokeInput,
  decodeAccessCredentialRevokeResult,
  decodeAccessCredentialRotationPrepareInput,
  decodeAccessCredentialRotationRevokeInput,
  decodeAccessPrincipalRevokeInput,
  decodeAccessPrincipalRevokeResult,
} from './access-authority.js';
export type {
  AccessCredentialFinalizeInput,
  AccessCredentialFinalizeResult,
  AccessCredentialIssueInput,
  AccessCredentialIssueResult,
  AccessCredentialPrepareInput,
  AccessCredentialPrepareResult,
  AccessCredentialPrincipalKind,
  AccessCredentialReplaceInput,
  AccessCredentialReplaceResult,
  AccessCredentialRevokeInput,
  AccessCredentialRevokeResult,
  AccessCredentialRotationPrepareInput,
  AccessCredentialRotationPrepareResult,
  AccessCredentialRotationRevokeInput,
  AccessCredentialRotationRevokeResult,
  AccessPrincipalRevokeInput,
  AccessPrincipalRevokeResult,
  ClientCapabilityOwnerIdentity,
  ManagedAccessCredentialPrincipalKind,
} from './access-authority.js';
export {
  AGENT_GRAPH_CLIENT_SCHEMA_VERSION,
  AGENT_GRAPH_EPOCH_PAGE_SIZE,
  AGENT_GRAPH_MAX_ACTIVITY,
  AGENT_GRAPH_MAX_CLAIMS,
  AGENT_GRAPH_MAX_CONTROL_DECISIONS,
  AGENT_GRAPH_MAX_CONTROL_REFS,
  AGENT_GRAPH_MAX_EDGES,
  AGENT_GRAPH_MAX_INPUT_ROUTE_OPERATORS,
  AGENT_GRAPH_MAX_INSPECTION_ACTIVATIONS,
  AGENT_GRAPH_MAX_INSPECTION_CLAIMS,
  AGENT_GRAPH_MAX_INSPECTION_EDGES,
  AGENT_GRAPH_MAX_INSPECTION_RECORDS,
  AGENT_GRAPH_MAX_INSPECTION_WORK,
  AGENT_GRAPH_MAX_OPERATORS,
  AGENT_GRAPH_MAX_OPERATOR_READINESS,
  AGENT_GRAPH_MAX_OPERATOR_REFS,
  AGENT_GRAPH_MAX_READINESS_WAITS,
  AGENT_GRAPH_MAX_RECONCILIATION_FAILURES,
  AGENT_GRAPH_MAX_STOPPED_TARGETS,
  AGENT_GRAPH_MAX_TERMINAL_ACTIVITY,
  AGENT_GRAPH_MAX_WORK,
  AGENT_GRAPH_MAX_WORK_INPUTS,
  AGENT_GRAPH_OPERATION_SPECS,
  AGENT_GRAPH_RESULT_MAX_BYTES,
  AGENT_GRAPH_TERMINAL_CURSOR_MAX_BYTES,
  decodeAgentGraphClientSnapshot,
  decodeAgentGraphEpochListInput,
  decodeAgentGraphEpochListResult,
  decodeAgentGraphOperatorInspection,
  decodeAgentGraphOperatorQueryInput,
  decodeAgentGraphQueryInput,
  decodeAgentGraphStopInput,
  decodeAgentGraphStopResult,
} from './agent-graph.js';
export type {
  AgentGraphActivationStatus,
  AgentGraphClientActivity,
  AgentGraphClientClaimRef,
  AgentGraphClientControlDecision,
  AgentGraphClientEdge,
  AgentGraphClientFinish,
  AgentGraphClientOperator,
  AgentGraphClientOperatorStatus,
  AgentGraphClientReconciliationFailure,
  AgentGraphClientRunRef,
  AgentGraphClientScheduledWork,
  AgentGraphClientSnapshot,
  AgentGraphClientStatus,
  AgentGraphClientStoppedTarget,
  AgentGraphEpochListInput,
  AgentGraphEpochListResult,
  AgentGraphEpochSummary,
  AgentGraphOperatorInspection,
  AgentGraphOperatorQueryInput,
  AgentGraphQueryInput,
  AgentGraphReadinessWait,
  AgentGraphRecordFacet,
  AgentGraphStopInput,
  AgentGraphStopResult,
  AgentGraphSupervisorSignal,
} from './agent-graph.js';
export {
  INTERACTION_MAX_PENDING_PER_SESSION,
  INTERACTION_OPERATION_SPECS,
  INTERACTION_PENDING_REVISION,
  INTERACTION_RESOLVED_REVISION,
  INTERACTION_SCHEMA_VERSION,
  decodeInteractionAnswer,
  decodeInteractionAnsweredSnapshot,
  decodeInteractionCanonicalOutcome,
  decodeInteractionRequest,
  decodeInteractionSnapshot,
  decodeSessionInteractionProjection,
} from './interaction.js';
export type {
  InteractionAnswer,
  InteractionAnswerInput,
  InteractionAnsweredSnapshot,
  InteractionCanonicalOutcome,
  InteractionClosedSnapshot,
  InteractionClosureReason,
  InteractionPendingSnapshot,
  InteractionPermissionAnswer,
  InteractionPermissionDecisionFields,
  InteractionPermissionPrompt,
  InteractionQueryInput,
  InteractionQuestion,
  InteractionQuestionOption,
  InteractionRequest,
  InteractionResolvedSnapshot,
  InteractionRevision,
  InteractionSandboxBoundaryAnswer,
  InteractionSandboxBoundaryRequest,
  InteractionSnapshot,
  SessionInteractionProjection,
} from './interaction.js';
export {
  DAILY_REVIEW_MODEL_KEY_MAX_BYTES,
  DAILY_REVIEW_OFFSET_DAYS_MAX,
  DAILY_REVIEW_OPERATION_SPECS,
  DAILY_REVIEW_PAGE_MAX_ITEMS,
  DAILY_REVIEW_RESULT_MAX_BYTES,
  decodeDailyReviewMutateInput,
  decodeDailyReviewMutateResult,
  decodeDailyReviewQueryInput,
  decodeDailyReviewQueryResult,
} from './daily-review.js';
export type {
  DailyReviewMutateInput,
  DailyReviewMutateResult,
  DailyReviewQueryInput,
  DailyReviewQueryResult,
} from './daily-review.js';
export {
  CLIENT_CAPABILITY_MAX_MANIFEST_BYTES,
  CLIENT_CAPABILITY_MAX_OFFERS,
  CLIENT_CAPABILITY_MAX_PROGRESS_TOTAL,
  CLIENT_CAPABILITY_MAX_RESULT_BYTES,
  CLIENT_CAPABILITY_MAX_RESULT_CHUNKS,
  CLIENT_CAPABILITY_MAX_SERVICES,
  CLIENT_CAPABILITY_MAX_TOOLS,
  CLIENT_CAPABILITY_MAX_TOOLS_PER_OFFER,
  CLIENT_CAPABILITY_OPERATION_SPECS,
  CLIENT_CAPABILITY_RESULT_CHUNK_MAX_BYTES,
  decodeClientCapabilityClientFrame,
  decodeClientCapabilityHostFrame,
  decodeClientCapabilityReplaceInput,
  decodeClientCapabilityReplaceResult,
  decodeClientCapabilityResult,
  decodeClientCapabilityUnregisterInput,
  decodeClientCapabilityUnregisterResult,
  isClientCapabilityClientFrameKind,
  isClientCapabilityHostFrameKind,
} from './client-capability.js';
export type {
  ClientCapabilityAcceptedFrame,
  ClientCapabilityAdmissionEvidence,
  ClientCapabilityAdmittedFrame,
  ClientCapabilityAffinity,
  ClientCapabilityCallFrame,
  ClientCapabilityCallResult,
  ClientCapabilityCancelFrame,
  ClientCapabilityClientFrame,
  ClientCapabilityContentBlock,
  ClientCapabilityFailedFrame,
  ClientCapabilityHostFrame,
  ClientCapabilityHostPathAccess,
  ClientCapabilityOffer,
  ClientCapabilityProgressFrame,
  ClientCapabilityRegistrationReleaseFrame,
  ClientCapabilityRejectedFrame,
  ClientCapabilityReleaseFrame,
  ClientCapabilityReplaceInput,
  ClientCapabilityReplaceResult,
  ClientCapabilityResultChunkFrame,
  ClientCapabilityResultFrame,
  ClientCapabilityResultStartFrame,
  ClientCapabilityServiceCallFrame,
  ClientCapabilityServiceOffer,
  ClientCapabilityToolAnnotations,
  ClientCapabilityToolDescriptor,
  ClientCapabilityUnregisterInput,
  ClientCapabilityUnregisterResult,
} from './client-capability.js';
export { decodeConfigurationChangedFrame } from './configuration-change.js';
export type { ConfigurationChangedFrame } from './configuration-change.js';
export { decodeConnectionCatalogChangedFrame } from './connection-catalog-change.js';
export type { ConnectionCatalogChangedFrame } from './connection-catalog-change.js';
export {
  GOAL_OPERATION_SPECS,
  GOAL_RESULT_MAX_BYTES,
  decodeGoalProjection,
} from './goal.js';
export type {
  GoalArmInput,
  GoalArmResult,
  GoalControlAction,
  GoalControlInput,
  GoalControlResult,
  GoalProjection,
  GoalQueryInput,
  GoalQueryResult,
} from './goal.js';
export {
  HOSTED_EXECUTION_OPERATION_SPECS,
  decodeHostedExecutionProjection,
  decodeHostedExecutionReferenceInput,
  decodeHostedExecutionStartInput,
  preservesHostedExecutionEnvironment,
} from './hosted-execution.js';
export type {
  HostedExecutionProjection,
  HostedExecutionReferenceInput,
  HostedExecutionStartInput,
  HostedExecutionUsage,
} from './hosted-execution.js';
export {
  PLAN_OPERATION_SPECS,
  PLAN_PAGE_MAX_ITEMS,
  PLAN_RESULT_MAX_BYTES,
  decodePlanControlInput,
  decodePlanControlResult,
  decodePlanQueryInput,
  decodePlanQueryResult,
  decodePlanTurnStartInput,
  decodePlanTurnStartResult,
  planTurnControlInput,
} from './plan.js';
export type {
  PlanControlInput,
  PlanControlResult,
  PlanProjectionItem,
  PlanQueryInput,
  PlanQueryResult,
  PlanTurnStartInput,
  PlanTurnStartResult,
} from './plan.js';
export {
  PEER_MESH_OPERATION_SPECS,
  decodePeerMeshInvitation,
  decodePeerMeshInvitationResult,
  decodePeerMeshProjection,
  decodePeerMeshQueryResult,
} from './peer-mesh.js';
export type {
  PeerMeshDisplayNameSetInput,
  PeerMeshInvitationResult,
  PeerMeshInvitationV1,
  PeerMeshInviteInput,
  PeerMeshJoinInput,
  PeerMeshMemberProjection,
  PeerMeshProjection,
  PeerMeshQueryResult,
  PeerMeshRemoveInput,
  PeerMeshRenameInput,
  PeerMeshTargetInput,
  PeerMeshTransitProjection,
  PeerMeshTransitSetInput,
} from './peer-mesh.js';
export {
  PROJECT_CATALOG_CURSOR_MAX_BYTES,
  PROJECT_CATALOG_NAME_MAX_BYTES,
  PROJECT_CATALOG_OPERATION_SPECS,
  PROJECT_CATALOG_PAGE_MAX_BYTES,
  PROJECT_CATALOG_PAGE_MAX_ITEMS,
  PROJECT_CATALOG_PATH_MAX_BYTES,
  PROJECT_DIRECTORY_MAX_ENTRIES,
  PROJECT_DIRECTORY_MAX_ROOTS,
  PROJECT_DIRECTORY_MAX_SEGMENTS,
  PROJECT_DIRECTORY_PAGE_MAX_BYTES,
  PROJECT_DIRECTORY_PAGE_MAX_ITEMS,
  PROJECT_DIRECTORY_ROOT_LABEL_MAX_BYTES,
  PROJECT_DIRECTORY_ROOT_PATH_MAX_BYTES,
  PROJECT_DIRECTORY_SEGMENT_MAX_BYTES,
  canonicalProjectDirectoryRootSpec,
  decodeProjectCatalogMutateInput,
  decodeProjectCatalogMutateResult,
  decodeProjectCatalogProject,
  decodeProjectCatalogProjectDetails,
  decodeProjectCatalogQueryInput,
  decodeProjectCatalogQueryResult,
  decodeProjectDirectoryQueryInput,
  decodeProjectDirectoryQueryResult,
  decodeProjectDirectoryRegisterInput,
  projectDirectoryPosixRootSpecValid,
  projectDirectoryRootSpecValid,
} from './project-catalog.js';
export type {
  ProjectCatalogLocation,
  ProjectCatalogMutateInput,
  ProjectCatalogMutateResult,
  ProjectCatalogPageItem,
  ProjectCatalogProject,
  ProjectCatalogProjectDetails,
  ProjectCatalogQueryInput,
  ProjectCatalogQueryResult,
  ProjectCatalogRevision,
  ProjectCatalogView,
  ProjectDirectoryEntry,
  ProjectDirectoryQueryInput,
  ProjectDirectoryQueryResult,
  ProjectDirectoryRegisterInput,
  ProjectDirectoryRoot,
  ProjectDirectoryRootSpec,
} from './project-catalog.js';
export { decodeProjectCatalogChangedFrame } from './project-catalog-change.js';
export type { ProjectCatalogChangedFrame } from './project-catalog-change.js';
export {
  EXECUTION_INSPECT_EVIDENCE_MAX_BYTES,
  EXECUTION_INSPECT_EVIDENCE_MAX_RECORDS,
  EXECUTION_INSPECT_OPERATION_SPECS,
  EXECUTION_INSPECT_RESULT_MAX_BYTES,
  EXECUTION_INSPECT_SESSION_MAX_RUNS,
  EXECUTION_INSPECT_TRACE_PAGE_MAX_TURNS,
  decodeExecutionInspectQueryInput,
  decodeExecutionInspectQueryResult,
} from './execution-inspect.js';
export type {
  ExecutionInspectQueryInput,
  ExecutionInspectQueryResult,
} from './execution-inspect.js';
export {
  EXTERNAL_SESSION_CWD_MAX_BYTES,
  EXTERNAL_SESSION_IMPORTED_SESSION_IDS_MAX_ITEMS,
  EXTERNAL_SESSION_NAME_MAX_BYTES,
  EXTERNAL_SESSION_OPERATION_SPECS,
  EXTERNAL_SESSION_PAGE_MAX_ITEMS,
  EXTERNAL_SESSION_QUERY_TEXT_MAX_BYTES,
  EXTERNAL_SESSION_RESULT_MAX_BYTES,
  EXTERNAL_SESSION_SOURCE_MAX_ITEMS,
  EXTERNAL_SESSION_SOURCE_SESSION_ID_MAX_BYTES,
  decodeExternalSessionCatalogQueryInput,
  decodeExternalSessionCatalogQueryResult,
  decodeExternalSessionImportInput,
  decodeExternalSessionImportResult,
  decodeExternalSessionSourceQueryInput,
  decodeExternalSessionSourceQueryResult,
} from './external-session.js';
export type {
  ExternalSessionCatalogItem,
  ExternalSessionCatalogQueryInput,
  ExternalSessionCatalogQueryResult,
  ExternalSessionImportInput,
  ExternalSessionImportResult,
  ExternalSessionSourceQueryInput,
  ExternalSessionSourceQueryResult,
} from './external-session.js';
export {
  MESSAGE_OPERATION_RESULT_MAX_BYTES,
  MESSAGE_OPERATION_SPECS,
  MESSAGE_QUEUE_MAX_ENTRIES,
  MESSAGE_QUEUE_PROJECTION_MAX_BYTES,
  decodeSessionMessageQueueProjection,
} from './message.js';
export type {
  InFlightMessageSnapshot,
  MessagePlacement,
  MessageQueueEntrySnapshot,
  QueueEntriesReorderInput,
  QueueEntryPromoteInput,
  QueueEntryRetractInput,
  QueueEntryUpdateInput,
  QueueMutationResult,
  QueueRetractInput,
  QueueRetractResult,
  QueuedMessageSnapshot,
  RetractedMessageSnapshot,
  SessionMessageQueueProjection,
  SteeringMessageSnapshot,
  TurnInterruptInput,
  TurnInterruptResult,
  TurnMessageExecutionQueryInput,
  TurnMessageExecutionQueryResult,
  TurnMessageExecutionResolution,
  TurnMessageQueryInput,
  TurnMessageQueryResult,
  TurnMessageSubmitInput,
  TurnMessageSubmitResult,
} from './message.js';
export {
  ARTIFACT_CURSOR_MAX_BYTES,
  ARTIFACT_INGEST_CHUNK_MAX_BYTES,
  ARTIFACT_INGEST_MIME_TYPE_MAX_BYTES,
  ARTIFACT_MIME_TYPE_MAX_BYTES,
  ARTIFACT_NAME_MAX_BYTES,
  ARTIFACT_PAGE_MAX_ITEMS,
  ARTIFACT_PREVIEW_MAX_BYTES,
  ARTIFACT_READ_CHUNK_MAX_BYTES,
  ARTIFACT_RESULT_MAX_BYTES,
  ARTIFACT_SUMMARY_MAX_BYTES,
  CONFIGURATION_OPERATION_SPECS,
  CONNECTION_CATALOG_PAGE_MAX_BYTES,
  CONNECTION_CATALOG_PAGE_MAX_ITEMS,
  CONNECTION_EFFECT_CHANGED_DOMAINS,
  CONNECTION_EFFECT_FAILURE_CLASSES,
  CONNECTION_EFFECT_OPERATION_SPECS,
  CONNECTION_EFFECT_REJECTION_REASONS,
  CONTEXT_OPERATION_SPECS,
  CREDENTIAL_SECRET_MAX_BYTES,
  DEEP_RESEARCH_CLIENT_OBJECTIVE_MAX_BYTES,
  DEEP_RESEARCH_CLIENT_TEXT_MAX_BYTES,
  DEEP_RESEARCH_IMPLEMENTATION_PROMPT_MAX_BYTES,
  DEEP_RESEARCH_OPERATION_SPECS,
  DEEP_RESEARCH_RECENT_REFS_MAX,
  DEEP_RESEARCH_RESULT_MAX_BYTES,
  HOST_OPERATION_SPECS,
  MEMORY_DOCUMENT_CHUNK_MAX_BYTES,
  MEMORY_ENTRY_PAGE_MAX_ITEMS,
  MEMORY_OPERATION_SPECS,
  MEMORY_RESULT_MAX_BYTES,
  MEMORY_SEMANTIC_CONTENT_MAX_BYTES,
  NETWORK_PROXY_OPERATION_SPECS,
  OAUTH_LOGIN_FAILURE_CODES,
  OAUTH_LOGIN_PHASES,
  OAUTH_LOGIN_PROVIDERS,
  OAUTH_OPERATION_SPECS,
  OAUTH_PRESENTATION_SERVICE_ID,
  OAUTH_PRESENTATION_SERVICE_VERSION,
  OAUTH_PRESENTATION_STATE_HINT_MAX_LENGTH,
  OAUTH_PRESENTATION_URL_MAX_LENGTH,
  PLUGIN_PLATFORM_OPERATION_SPECS,
  PLUGIN_PLATFORM_QUERY_RESULT_MAX_BYTES,
  PRICING_PAGE_MAX_BYTES,
  PRICING_PAGE_MAX_ITEMS,
  REMOTE_OWNER_OPERATION_GRANTS,
  RUNTIME_POLICY_OPERATION_SPECS,
  RUNTIME_POLICY_SNAPSHOT_MAX_BYTES,
  SCHEDULED_TASK_CATALOG_MAX_ITEMS,
  SCHEDULED_TASK_OPERATION_SPECS,
  SCHEDULED_TASK_PAGE_MAX_ITEMS,
  SCHEDULED_TASK_RESULT_MAX_BYTES,
  SESSION_CATALOG_CONNECTION_SLUG_MAX_BYTES,
  SESSION_CATALOG_CURSOR_MAX_BYTES,
  SESSION_CATALOG_CWD_MAX_BYTES,
  SESSION_CATALOG_LABEL_MAX_BYTES,
  SESSION_CATALOG_LABEL_MAX_ITEMS,
  SESSION_CATALOG_LIVE_RUN_STATE_SCHEMA_VERSION,
  SESSION_CATALOG_MODEL_MAX_BYTES,
  SESSION_CATALOG_NAME_MAX_BYTES,
  SESSION_CATALOG_OPERATION_SPECS,
  SESSION_CATALOG_PAGE_MAX_ITEMS,
  SESSION_CATALOG_PREVIEW_MAX_BYTES,
  SESSION_CATALOG_RESULT_MAX_BYTES,
  SESSION_CATALOG_RUNNING_TURN_MAX_ITEMS,
  SESSION_EFFECT_OPERATION_SPECS,
  SESSION_RECAP_RAW_MAX_BYTES,
  SESSION_RECAP_TEXT_MAX_BYTES,
  SESSION_REVISION_OPERATION_SPECS,
  SKILL_CATALOG_CATEGORY_MAX_BYTES,
  SKILL_CATALOG_DESCRIPTION_MAX_BYTES,
  SKILL_CATALOG_DISPLAY_ID_MAX_BYTES,
  SKILL_CATALOG_NAME_MAX_BYTES,
  SKILL_CATALOG_OPERATION_SPECS,
  SKILL_CATALOG_PAGE_MAX_BYTES,
  SKILL_CATALOG_PAGE_MAX_ITEMS,
  SKILL_CATALOG_PREVIEW_RESULT_MAX_BYTES,
  SKILL_CATALOG_REF_MAX_BYTES,
  SKILL_CATALOG_STRING_ARRAY_ITEM_MAX_BYTES,
  SKILL_CATALOG_STRING_ARRAY_MAX_ITEMS,
  TURN_FAILURE_MESSAGE_MAX_BYTES,
  TURN_MESSAGE_CONTENT_MAX_BYTES,
  TURN_MESSAGE_TEXT_MAX_BYTES,
  TURN_RESUME_PARK_REASONS,
  USAGE_PAGE_MAX_BYTES,
  USAGE_PAGE_MAX_ITEMS,
  USAGE_PRICING_OPERATION_SPECS,
  USAGE_PROJECTION_TEXT_MAX_BYTES,
  WEB_SEARCH_OPERATION_SPECS,
  decodeArtifactDeleteInput,
  decodeArtifactDeleteResult,
  decodeArtifactIngestInput,
  decodeArtifactIngestResult,
  decodeArtifactQueryInput,
  decodeArtifactQueryResult,
  decodeConnectionModelFetchInput,
  decodeConnectionModelFetchResult,
  decodeConnectionOnboardingSaveInput,
  decodeConnectionOnboardingSaveResult,
  decodeConnectionOnboardingVerifyInput,
  decodeConnectionOnboardingVerifyResult,
  decodeConnectionTestRunInput,
  decodeConnectionTestRunResult,
  decodeDeepResearchQueryInput,
  decodeDeepResearchQueryResult,
  decodeExecutionBoundarySummary,
  decodeMemoryMutateInput,
  decodeMemoryMutateResult,
  decodeMemoryQueryInput,
  decodeMemoryQueryResult,
  decodeOAuthLoginAttemptInput,
  decodeOAuthLoginProjection,
  decodeOAuthLoginStartInput,
  decodeOAuthPresentationRequest,
  decodeOAuthPresentationResult,
  decodeOperationOutcome,
  decodePluginCompositionApplyInput,
  decodePricingMutateInput,
  decodePricingMutateResult,
  decodePricingQueryInput,
  decodePricingQueryResult,
  decodeRequestFrame,
  decodeResponseFrame,
  decodeScheduledTask,
  decodeScheduledTaskMutateInput,
  decodeScheduledTaskMutateResult,
  decodeScheduledTaskQueryInput,
  decodeScheduledTaskQueryResult,
  decodeSessionCatalogItem,
  decodeSessionCatalogProjection,
  decodeSessionCatalogQueryInput,
  decodeSessionCatalogQueryResult,
  decodeSessionConfigurationUpdateInput,
  decodeSessionConversationCopyInput,
  decodeSessionConversationCopyResult,
  decodeSessionCreateInput,
  decodeSessionExecutionBoundaryQueryInput,
  decodeSessionMetadataUpdateInput,
  decodeSessionReadMarkerSetInput,
  decodeSessionRecapGenerateInput,
  decodeSessionRecapGenerateResult,
  decodeSessionUpdateResult,
  decodeSessionWorkspaceRelocateInput,
  decodeSharedSessionCatalogProjection,
  decodeUsageQueryInput,
  decodeUsageQueryResult,
  encodeArtifactDeleteResult,
  encodeArtifactQueryResult,
  encodeDeepResearchSnapshot,
  encodePricingQueryResult,
  encodeUsageQueryResult,
  isOperationKey,
  isSkillCatalogProjectRootLexicallyAbsolute,
  operationAllowsRemoteOwner,
  operationUsesHostPaths,
} from './operations.js';
export type {
  ArtifactBinaryPreview,
  ArtifactDeleteInput,
  ArtifactDeleteResult,
  ArtifactIngestInput,
  ArtifactIngestResult,
  ArtifactProjection,
  ArtifactQueryInput,
  ArtifactQueryResult,
  ArtifactRevision,
  ArtifactTextPreview,
  ConfigurationCredentialExportInput,
  ConfigurationCredentialExportResult,
  ConnectionCatalogCreateInput,
  ConnectionCatalogCursor,
  ConnectionCatalogHeaderItem,
  ConnectionCatalogPageItem,
  ConnectionCatalogQueryInput,
  ConnectionCatalogQueryResult,
  ConnectionCatalogRemoveInput,
  ConnectionCatalogSetDefaultTargetInput,
  ConnectionCatalogUpdateInput,
  ConnectionEffectChangedDomain,
  ConnectionEffectFailureClass,
  ConnectionEffectRejectionReason,
  ConnectionModelFetchInput,
  ConnectionModelFetchResult,
  ConnectionOnboardingSaveInput,
  ConnectionOnboardingSaveResult,
  ConnectionOnboardingVerifyInput,
  ConnectionOnboardingVerifyResult,
  ConnectionRequestHeadersQueryInput,
  ConnectionRequestHeadersQueryResult,
  ConnectionRequestHeadersReplaceInput,
  ConnectionRequestHeadersReplaceResult,
  ConnectionTestProjection,
  ConnectionTestRunInput,
  ConnectionTestRunResult,
  ContextCompactInput,
  ContextCompactResult,
  ContextDiagnosticsComposition,
  ContextDiagnosticsQueryInput,
  ContextDiagnosticsResult,
  ContextDiagnosticsSegment,
  ContextDiagnosticsTool,
  CreateCatalogConnectionResult,
  CredentialVaultDeleteInput,
  CredentialVaultQueryInput,
  CredentialVaultQueryResult,
  CredentialVaultSetInput,
  DeepResearchChecklistProjection,
  DeepResearchInspectedRefProjection,
  DeepResearchQueryInput,
  DeepResearchQueryResult,
  DeepResearchReportSectionProjection,
  DeleteCredentialResult,
  EffectivePricingEntry,
  ExecutionBoundarySummary,
  HostActivitySnapshot,
  HostDiagnosticsInput,
  HostDiagnosticsResult,
  HostLifecycleState,
  HostOperationError,
  HostOperationErrorCode,
  HostStatusInput,
  HostStatusResult,
  HostUpgradePrepareInput,
  HostUpgradePrepareResult,
  LiveTurnSnapshot,
  LlmUsageLogProjection,
  LlmUsageQuery,
  MemoryBackupKind,
  MemoryBackupProjection,
  MemoryDocumentName,
  MemoryDocumentPage,
  MemoryEntriesPage,
  MemoryEntriesView,
  MemoryEntryProjection,
  MemoryMutateInput,
  MemoryMutateResult,
  MemoryMutationRejectionReason,
  MemoryQueryInput,
  MemoryQueryResult,
  MemoryRevision,
  MemoryScopeInput,
  MemoryStateProjection,
  ModelCatalogEntry,
  NetworkProxyTestInput,
  NetworkProxyTestResult,
  OAuthConnectionIdentity,
  OAuthLoginAttemptInput,
  OAuthLoginFailureCode,
  OAuthLoginPhase,
  OAuthLoginProjection,
  OAuthLoginProvider,
  OAuthLoginStartInput,
  OAuthLoginTarget,
  OAuthPresentationMethod,
  OAuthPresentationRequest,
  OAuthPresentationResult,
  OperationError,
  OperationInput,
  OperationKey,
  OperationOutcome,
  OperationOutput,
  OperationSpecMap,
  PluginCompositionApplyResult,
  PluginMutationReceipt,
  PluginPackageExportInput,
  PluginPackageExportResult,
  PluginPackageInstallInput,
  PluginPackageInstallResult,
  PluginPackageMutationResult,
  PluginPackageProjection,
  PluginPackageUninstallInput,
  PluginPlatformConvergence,
  PluginPlatformFailureProjection,
  PluginPlatformPhase,
  PluginPlatformQueryInput,
  PluginPlatformQueryResult,
  PricingMutateInput,
  PricingMutateResult,
  PricingMutation,
  PricingQueryInput,
  PricingQueryResult,
  RelayModelProfile,
  RelayModelProfiles,
  RemoveCatalogConnectionResult,
  RequestFrame,
  RequestFrameFor,
  ResponseFrame,
  ResponseFrameFor,
  RuntimePolicyMutateInput,
  RuntimePolicyMutateResult,
  RuntimePolicyQueryInput,
  RuntimePolicyQueryResult,
  ScheduledTaskMutateInput,
  ScheduledTaskMutateResult,
  ScheduledTaskQueryInput,
  ScheduledTaskQueryResult,
  SessionCatalogItem,
  SessionCatalogLiveRunState,
  SessionCatalogProjection,
  SessionCatalogQueryInput,
  SessionCatalogQueryResult,
  SessionCatalogRevision,
  SessionConfigurationPatch,
  SessionConfigurationUpdateInput,
  SessionConversationCopyInput,
  SessionConversationCopyResult,
  SessionCreateInput,
  SessionExecutionBoundaryQueryInput,
  SessionMetadataPatch,
  SessionMetadataUpdateInput,
  SessionModelTarget,
  SessionReadMarkerSetInput,
  SessionRecapFailureClass,
  SessionRecapGenerateInput,
  SessionRecapGenerateResult,
  SessionRecapReason,
  SessionRevisionAbandonInput,
  SessionRevisionAbandonResult,
  SessionSubagentProjection,
  SessionUpdateResult,
  SessionWorkspaceRelocateInput,
  SetCredentialResult,
  SetDefaultConnectionTargetResult,
  SharedSessionCatalogProjection,
  SharedSessionCatalogQueryInput,
  SharedSessionCatalogQueryResult,
  SkillCatalogBundledItem,
  SkillCatalogContextStatus,
  SkillCatalogDiscoverySource,
  SkillCatalogEntryKind,
  SkillCatalogGovernanceItem,
  SkillCatalogInvocableItem,
  SkillCatalogInvocableQueryInput,
  SkillCatalogInvocableQueryResult,
  SkillCatalogInvocableTarget,
  SkillCatalogManagedSourceItem,
  SkillCatalogManagedUpdateMutation,
  SkillCatalogManagedUpdateStatus,
  SkillCatalogMutateInput,
  SkillCatalogMutateResult,
  SkillCatalogMutation,
  SkillCatalogMutationOutcome,
  SkillCatalogMutationRejectedReason,
  SkillCatalogPageItem,
  SkillCatalogPreviewLineSummary,
  SkillCatalogPreviewRejectedReason,
  SkillCatalogPreviewUpdateInput,
  SkillCatalogPreviewUpdateOutcome,
  SkillCatalogPreviewUpdateResult,
  SkillCatalogQueryInput,
  SkillCatalogQueryProjection,
  SkillCatalogQueryResult,
  SkillCatalogRevision,
  SkillCatalogRevisionChanged,
  SkillCatalogRevisionConflict,
  SkillCatalogRuntimeStatus,
  SkillCatalogScope,
  SkillCatalogSourceType,
  SkillCatalogValidationCode,
  SkillCatalogValidationStatus,
  SkillCatalogView,
  SkillCatalogWorkspaceContext,
  SkillContentSha256,
  ToolUsageLogProjection,
  ToolUsageQuery,
  TurnProviderRetry,
  TurnQueryInput,
  TurnRegenerateInput,
  TurnResumeParkReason,
  TurnResumePlan,
  TurnResumeQueryInput,
  TurnResumeStartInput,
  TurnResumeStartResult,
  TurnRunStatus,
  TurnSnapshot,
  TurnStartInput,
  TurnStartResult,
  TurnStopInput,
  UnsupportedLegacySessionCatalogRecord,
  UpdateCatalogConnectionResult,
  UsageLogProjection,
  UsageQueryInput,
  UsageQueryResult,
  WebSearchExecuteInput,
  WebSearchExecuteResult,
} from './operations.js';
export {
  RUNTIME_RESOURCE_COMMAND_MAX_BYTES,
  RUNTIME_RESOURCE_CONTROLLER_ACQUIRE_RESULT_MAX_BYTES,
  RUNTIME_RESOURCE_CONTROL_INPUT_MAX_BYTES,
  RUNTIME_RESOURCE_CURSOR_MAX_BYTES,
  RUNTIME_RESOURCE_MAX_CONTROL_SEQUENCE,
  RUNTIME_RESOURCE_MAX_PTY_COLS,
  RUNTIME_RESOURCE_MAX_PTY_ROWS,
  RUNTIME_RESOURCE_MIN_PTY_COLS,
  RUNTIME_RESOURCE_MIN_PTY_ROWS,
  RUNTIME_RESOURCE_OPERATION_SPECS,
  RUNTIME_RESOURCE_PAGE_MAX_ITEMS,
  RUNTIME_RESOURCE_REF_MAX_BYTES,
  RUNTIME_RESOURCE_RESULT_MAX_BYTES,
  decodeRuntimeResourceControllerAcquireInput,
  decodeRuntimeResourceControllerAcquireResult,
  decodeRuntimeResourceControllerControlInput,
  decodeRuntimeResourceControllerControlResult,
  decodeRuntimeResourceControllerReleaseInput,
  decodeRuntimeResourceControllerReleaseResult,
  decodeRuntimeResourceQueryInput,
  decodeRuntimeResourceQueryResult,
  decodeRuntimeResourceRef,
  decodeRuntimeResourceSnapshot,
  decodeRuntimeResourceStartInput,
  decodeRuntimeResourceStartResult,
  decodeRuntimeResourceState,
  decodeRuntimeResourceStopInput,
  decodeRuntimeResourceStopResult,
  decodeRuntimeResourceUpdate,
} from './runtime-resource.js';
export type {
  RuntimeResourceControllerAcquireInput,
  RuntimeResourceControllerAcquireResult,
  RuntimeResourceControllerControlInput,
  RuntimeResourceControllerControlResult,
  RuntimeResourceControllerReleaseInput,
  RuntimeResourceControllerReleaseResult,
  RuntimeResourcePtyControl,
  RuntimeResourcePtySnapshot,
  RuntimeResourceQueryInput,
  RuntimeResourceQueryResult,
  RuntimeResourceRevision,
  RuntimeResourceStartInput,
  RuntimeResourceStartResult,
  RuntimeResourceStopInput,
  RuntimeResourceStopResult,
} from './runtime-resource.js';
export {
  SESSION_CONTINUITY_OPERATION_SPECS,
  SESSION_CONTINUITY_SCHEMA_VERSION,
  SESSION_CONTINUITY_SNAPSHOT_MAX_BYTES,
  SESSION_DOMAINS,
  SESSION_LIVE_DELTA_MAX_BYTES,
  SESSION_RUNTIME_RESOURCE_CHANGES_MAX,
  SESSION_RUNTIME_RESOURCE_PTY_DATA_MAX_BYTES,
  SESSION_SUBSCRIPTION_FRAME_MAX_BYTES,
  SESSION_TOOL_ARGS_PREVIEW_MAX_BYTES,
  SESSION_TOOL_INTENT_MAX_BYTES,
  SESSION_TOOL_NAME_MAX_BYTES,
  SESSION_TOOL_OUTPUT_DELTA_MAX_BYTES,
  SUBSCRIPTION_OPEN_RESULT_MAX_BYTES,
  decodeSessionContinuitySnapshot,
  decodeSubscriptionFrame,
  isSubscriptionFrameKind,
} from './session-continuity.js';
export type {
  AgentGraphChangedFrame,
  AgentGraphChangedReason,
  SessionAssistantDelta,
  SessionAssistantStreamIdentity,
  SessionContinuityIdentity,
  SessionContinuitySnapshot,
  SessionDeltaFrame,
  SessionDomain,
  SessionDomainChange,
  SessionDomainChangedFrame,
  SessionEventFrame,
  SessionLifecycleStatus,
  SessionProjectionFrame,
  SessionRuntimeResourceChange,
  SessionRuntimeResourcePtyDataFrame,
  SessionSteeringEvent,
  SessionToolEvent,
  SessionTranscriptAdvancedFrame,
  SubscriptionCloseInput,
  SubscriptionCloseResult,
  SubscriptionClosedFrame,
  SubscriptionFrame,
  SubscriptionOpenInput,
  SubscriptionOpenResult,
} from './session-continuity.js';
export { decodeSessionCatalogChangedFrame } from './session-catalog-change.js';
export type { SessionCatalogChangedFrame } from './session-catalog-change.js';
export {
  COLLABORATION_INVITATION_CODE_MAX_BYTES,
  COLLABORATION_INVITATION_SCHEMA_VERSION,
  SESSION_COLLABORATION_MAX_GRANTS_PER_INVITATION,
  SESSION_COLLABORATION_OPERATION_SPECS,
  decodeCollaborationInvitationCode,
  decodeSessionCollaborationGrant,
  decodeSessionTurnAccessRequest,
  encodeCollaborationInvitationCode,
} from './session-collaboration.js';
export type {
  CollaborationAccessQueryInput,
  CollaborationAccessQueryResult,
  CollaborationGrantRevokeInput,
  CollaborationGrantRevokeResult,
  CollaborationInvitationPayload,
  CollaborationInvitationPrepareInput,
  CollaborationInvitationPrepareResult,
  CollaborationPrincipalRevokeInput,
  CollaborationPrincipalRevokeResult,
  CollaborationTurnRequestAcknowledgeInput,
  CollaborationTurnRequestAcknowledgeResult,
  CollaborationTurnRequestCreateInput,
  CollaborationTurnRequestDecideInput,
  CollaborationTurnRequestDecideResult,
  CollaborationTurnRequestQueryInput,
  CollaborationTurnRequestQueryResult,
  SessionCollaborationGrant,
  SessionCollaborationGrantKind,
  SessionGuestPrincipalProjection,
  SessionObservationGrant,
  SessionTurnAccessRequest,
  SessionTurnAccessRequestState,
  SessionTurnRequestGrant,
  SessionTurnRequestIntent,
} from './session-collaboration.js';
export { decodeScheduledTaskChangedFrame } from './scheduled-task-change.js';
export type {
  ScheduledTaskChangedFrame,
  ScheduledTaskChangedReason,
} from './scheduled-task-change.js';
export {
  SESSION_RETIREMENT_OPERATION_SPECS,
  decodeSessionLifecycleSetInput,
  decodeSessionRemoveInput,
  decodeSessionRemovePreviewInput,
  decodeSessionRemovePreviewResult,
  decodeSessionRemoveResult,
} from './session-retirement.js';
export type {
  SessionLifecycleSetInput,
  SessionLifecycleState,
  SessionRemoveInput,
  SessionRemovePreviewInput,
  SessionRemovePreviewResult,
  SessionRemoveResult,
} from './session-retirement.js';
export {
  SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES,
  SESSION_TRANSCRIPT_CURSOR_MAX_BYTES,
  SESSION_TRANSCRIPT_OPERATION_SPECS,
  SESSION_TRANSCRIPT_OVERLAY_MAX_MESSAGES,
  SESSION_TRANSCRIPT_PAGE_MAX_BYTES,
  SESSION_TRANSCRIPT_PAGE_MAX_MESSAGES,
  SESSION_TRANSCRIPT_PAGE_RESULT_MAX_BYTES,
  SESSION_TRANSCRIPT_RANGE_MAX_BYTES,
  SESSION_TRANSCRIPT_RANGE_MAX_MESSAGES,
  decodeSessionTranscriptBootstrap,
  decodeSessionTranscriptPage,
  decodeSessionTranscriptPageInput,
} from './session-transcript.js';
export type {
  SessionTranscriptBootstrap,
  SessionTranscriptFragment,
  SessionTranscriptOverlayReleaseInput,
  SessionTranscriptOverlayReleaseResult,
  SessionTranscriptPage,
  SessionTranscriptPageDirection,
  SessionTranscriptPageInput,
  SessionTranscriptPageSource,
} from './session-transcript.js';
export {
  SESSION_TURNS_OPERATION_SPECS,
  SESSION_TURN_DIAGNOSTIC_MAX_BYTES,
  SESSION_TURN_LANDMARK_LABEL_MAX_BYTES,
  SESSION_TURN_LANDMARK_MAX_ITEMS,
  SESSION_TURN_LANDMARK_RESULT_MAX_BYTES,
  SESSION_TURN_PROMPT_PREVIEW_MAX_BYTES,
  SESSION_TURN_QUERY_MAX_CONTRIBUTIONS,
  SESSION_TURN_QUERY_RESULT_MAX_BYTES,
  decodeSessionTurnLandmarksQueryInput,
  decodeSessionTurnLandmarksQueryResult,
  decodeSessionTurnsQueryInput,
  decodeSessionTurnsQueryResult,
  mergeSessionTurnContributions,
  projectSessionTurnContribution,
  projectSessionTurnContributionForWire,
  projectSessionTurnLandmarkForWire,
} from './session-turns.js';
export type {
  SessionTurnContribution,
  SessionTurnLandmark,
  SessionTurnLandmarksQueryInput,
  SessionTurnLandmarksQueryResult,
  SessionTurnsQueryInput,
  SessionTurnsQueryResult,
} from './session-turns.js';
export {
  SESSION_TODO_OPERATION_SPECS,
  decodeSessionTodoQueryInput,
  decodeSessionTodoQueryResult,
} from './session-todo.js';
export type {
  SessionTodoQueryInput,
  SessionTodoQueryResult,
} from './session-todo.js';
export {
  WORKSPACE_HOST_PATH_MAX_BYTES,
  decodeHostPath,
  decodeWorkspaceProjection,
  decodeWorkspaceTarget,
} from './workspace.js';
export type {
  WorkspaceProjection,
  WorkspaceTarget,
} from './workspace.js';
export {
  WORKHUB_COORDINATION_CANDIDATE_MAX_ITEMS,
  WORKHUB_COORDINATION_OPERATION_SPECS,
  WORKHUB_COORDINATION_SUMMARY_MAX_BYTES,
  WORKHUB_COORDINATION_TEXT_MAX_BYTES,
  decodeWorkHubCoordinationActInput,
  decodeWorkHubCoordinationActResult,
  decodeWorkHubCoordinationAnswerInput,
  decodeWorkHubCoordinationCandidatesInput,
  decodeWorkHubCoordinationCandidatesResult,
  decodeWorkHubCoordinationRecordInput,
  decodeWorkHubCoordinationResolveInput,
  decodeWorkHubCoordinationResolveResult,
  decodeWorkHubCoordinationTurnResult,
} from './workhub-coordination.js';
export type {
  WorkHubCoordinationActInput,
  WorkHubCoordinationActResult,
  WorkHubCoordinationAnswerInput,
  WorkHubCoordinationCandidate,
  WorkHubCoordinationCandidateState,
  WorkHubCoordinationCandidatesInput,
  WorkHubCoordinationCandidatesResult,
  WorkHubCoordinationCreateContext,
  WorkHubCoordinationDestructiveConfirmation,
  WorkHubCoordinationProposal,
  WorkHubCoordinationRecordInput,
  WorkHubCoordinationResolveInput,
  WorkHubCoordinationResolveResult,
  WorkHubCoordinationTurnResult,
} from './workhub-coordination.js';
export {
  RUNTIME_HOST_WEBSOCKET_PATH_MAX_BYTES,
  isCanonicalRuntimeHostWebSocketPath,
} from './websocket-path.js';

export const RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION = 1 as const;
export const RUNTIME_HOST_PROTOCOL_VERSION = 0 as const;
// Increment when the same protocol version no longer guarantees safe Client-Host
// interoperability. Mismatches are rejected before domain commands are admitted.
export const RUNTIME_HOST_COMPATIBILITY_EPOCH = 90 as const;
// 90: `session.create.mode` accepts the Bot session mode. A Host that predates
// it rejects the value as an invalid Session start mode.
// 89: The Host refreshes its models.dev catalog at startup and announces the
// swap with a `connection.catalog.changed` frame, which an older client's
// strict frame decoder rejects as an unknown kind.
// 88: Catalog model modalities admit video on either side and pdf as output.
// models.dev declares both, and the modality decoder rejects any value it does
// not name, so a newer Host describing such a model fails an older client's
// catalog decode outright rather than losing one field. The handshake keeps
// that pairing from forming; a newer client simply never sees the new values
// from an older Host.
// 87: The connection catalog projects each model as the Host resolved it —
// a `catalog_entry` item per model, counted by the connection header. Clients
// render those entries instead of merging the stored row against their own
// bundled model metadata, so a Desktop and a TUI attached to one Host cannot
// describe the same model differently. An older client ignores the new items
// but would still resolve locally; an older Host sends none, leaving a newer
// client with an empty catalog. Both are rejected at the handshake.
// 86: Client Capability accepted frames carry typed admission evidence used to
// enforce Session Grant scopes. Older peers cannot preserve that boundary.
// 85: Plugin package and Entry composition operations become Host-owned protocol
// surfaces. Older peers cannot safely exchange these strict operation shapes.
// 84: Message content carries Host-bound directory references. Older peers
// reject this field and cannot preserve its identity through admission/replay.
// 83: WorkHub Coordination actions add linked replacement proposals,
// destructive user confirmation, and replacement results. Older peers reject
// these closed action and result shapes.
// 82: Session removal reports how many linked subtasks it archived, and adds a
// `session.remove.preview` query for that count before the delete. Older peers
// reject the extra removed-result field and the unknown operation.
// 81: SessionTodo replaces the Task Ledger protocol and continuity domain with
// one bounded current-state snapshot. Older peers cannot decode the operation
// or preserve the new invalidation vocabulary.
// 80: Runtime Policy catalog models gained validated user-overridden fact
// provenance. Older peers reject this projected model shape, so they must be
// refused during the handshake before catalog admission.
// 79: Every `turn.message.submit` disposition carries the exact Skill
// invocation outcome. Durable queued replays may omit the previous Host
// Epoch's transient queue revision; older strict peers reject either shape.
// 78: OAuth login targets explicit create/existing Connection entities and
// returns their canonical identity. Older peers reject both closed wire shapes.
// 77: LLM and tool usage-log projections carry an optional `sessionTitle` (the
// Host-resolved session name for the usage Task column). Older Clients reject
// the unknown field, so a newer Host's usage logs are unreadable to them.
// 76: Peer Mesh endpoint and Mesh display names are signed, persisted facts
// managed through Host operations rather than local-only Client labels.
// 75: Peer Mesh routes identify whether a peer is a Client or Runtime Host so
// management surfaces can present the endpoint authority boundary accurately.
// 74: Capability-provider credentials may carry one Host-authenticated owner
// identity. Older peers cannot preserve the association and could select an
// unrelated provider for an interactive Session.
// 73: Transcript pages carry a Host-owned Turn range boundary. Older peers
// cannot preserve both the complete edge Turn and the bounded projection.
// 72: Collaboration Turn request query results require `canRequestTurns`.
// Older peers reject the new closed result shape.
// 71: Session Guests can submit durable exact Turn access requests and Owners
// can decide them. Older peers do not understand this execution-authority flow.
// 70: Session Guest connections receive resource-scoped shared catalog and
// continuity projections. Older peers cannot enforce the Session grant fence.
// 69: Runtime Host access authority recognizes restricted Session Guest
// principals and typed Session collaboration grants. Older Hosts would either
// reject the new operations or misclassify the authenticated principal.
// 68: Connection onboarding replaces nullable canonical-slug targeting with
// explicit create/existing identity and returns the committed Connection.
// Older peers reject the closed target and saved-result shapes.
// 67: Message lifecycle queries expose durable execution ownership and
// cancellation. Older peers cannot decode or provide the closed proof list.
// 66: Peer Mesh queries expose one canonical transit selection and runtime metrics.
// 65: live `tool_start` frames may carry optional `intent` / `argsPreview`
// keys. Older Clients decode the event with a strict allowed-key list and tear
// the connection down on unknown keys, so the pair must be refused up front.
// The strict decoder's allowed-key union also retains `shellRunRef`.
// 64: execution.inspect drops the retired resolve operation. Older peers still
// know execution.inspect.resolve and would send it only to fail mid-connection,
// so removing it needs its own handshake boundary.
// 63: Connection updates accept the full canonical enabled-model limit.
// Older peers reject valid catalogs containing more than 64 enabled models.
// 62: A Direct peer listener can expose owner-only Peer Mesh management
// operations. Older peers do not have this closed operation vocabulary.
// 61: Session explicit model targets carry immutable Connection identity,
// configuration updates are Host-merged patches, and projections expose the
// required nullable binding ID. Older peers cannot preserve these invariants.
// 60: WorkHub stores a canonical delegation assignment record. Older peers
// cannot decode this message during transcript recovery.
// 59: Scheduled Turn provider-retry frames may carry an optional host-clock
// `ts`, letting a mid-wait re-projection recompute the authoritative
// remaining duration. Older peers decode the frame with an exact key list
// and reject the added field, so mixed peers must fail the handshake.
// 58: `runtime.resource.start` accepts an optional one-shot `command`, and the
// durable Shell Run record carries a `visibility` field. An epoch-57 Host
// rejects the widened closed input, while an epoch-57 binary cannot safely
// interpret the widened durable record.
// 57: Parked safe-boundary resume plans preserve feature-disabled, missing
// continuation authority, and unavailable safety-observation reasons.
// Older peers collapse these causes and can misclassify recovery failures.
// 56: Failed Turn snapshots preserve the structured context-budget exhaustion
// detail. Epoch-55 peers reject the optional field on the closed snapshot shape.
// 55: Local owners can atomically revoke every credential for one access
// principal, closing pairing-finalize races that credential-by-ID revocation cannot.
// 54: Client-bound pairing candidates restrict pre-claim authority and bind
// their durable credential to the claiming Client identity; it is also reserved
// by concurrent protocol changes in #3390.
// 53: Message admission answers `turn.message.submit` with an explicit
// disposition, and queued Messages can be proven cancelled. Older peers read the
// answer as a bare acknowledgement and cannot reconcile their own projection.
// 52: Session subscriptions can forward durable steering-message echoes and
// preserve their identity across queue and transcript projection.
// Older peers cannot safely de-duplicate the two authoritative paths.
// 51: WorkHub exposes bounded coordination candidates and admits only typed
// actions through the deterministic Runtime Host Action Gate.
// 50: WorkHub can append durable coordination summaries and admit tool-free
// answers through its reserved Coordination Session authority.
// 49: WorkHub resolves one durable Coordination Session per Runtime Host.
// Older peers do not know the operation or the hidden Session role.
// 48: Session branch creation accepts an explicit Side Conversation intent.
// Older peers reject the strict input shape or cannot apply its snapshot semantics.
// 47: Project registration can carry an explicit location preference. Epoch-46
// hosts reject that optional field on the closed registration input.
// 46: Queued message content can be edited in place (queue.entry.update).
// 45: Connection onboarding inputs require `baseUrl` and `connectionId`, and
// results can carry the `base_url_not_configured` / `connection_not_found`
// rejections. Older peers reject all of these shapes.
// 44: Session continuity and inspection stop carrying the retired Session
// last-used timestamp. Older peers reject those strict projection shapes.
// 43: Session tool-start events correlate hidden shell polls with `shellRunRef`.
// Older peers reject that added closed-union field.
// 42: Turn provider retry progress adds `provider_capacity`. Older peers reject
// that strict retry-reason enum value, so mixed versions must fail handshake.
// 41: Context compaction returns a typed terminal outcome on both Turn
// snapshots and context.compact results. Epoch-40 peers reject these closed
// shapes after admission, so mixed peers must fail during the handshake.
// 40: The message queue gains per-entry mutation operations
// (queue.entry.promote, queue.entry.retract, queue.entries.reorder).
// 39: Client Capability tool descriptors carry trusted activity semantics and
// invocations can stream bounded progress frames.
// 38: `execute` is no longer a permission mode. Frame decoders reject it, so a
// peer that still sends it would fail mid-Session rather than at connect.
// 37: External Session catalog queries carry a search term.
// 36: Session trace inspection no longer transports aggregate TraceTotals.
// 35: Session trace inspection uses cursor pages and Session usage has its own
// invalidation domain. Older peers cannot safely exchange those frames.
// 34: ScheduledTask execution templates no longer emit `backend`. Epoch-33
// Clients require that closed-shape response field, so a newer Host must reject
// them during the handshake instead of failing on the first Automation read.
// 33: Live tool results may carry the bounded sandbox failure reason. Older
// Clients reject that closed-frame addition, so mixed peers must not connect.
// 32: `request_authorization_code` leaves the OAuth presentation wire. An older
// Client still offers it and an older Host still asks for it, and neither side
// can carry the authorization code the other expects.
// 31: `claude-subscription` leaves `OAUTH_LOGIN_PROVIDERS` and the
// `oauth.account.usage.fetch` operation is removed with the provider that
// needed its client identity. An older peer still offers both.
// 30: Access credential pairing adds prepare/finalize operations. Older Hosts
// cannot complete the staged credential handoff used by managed onboarding.
// 29: `goal.arm` is a new wire operation. An older Host decodes it as unknown
// and tears the connection down, so the pair must be refused up front.
// 28: Relay model profiles carry the Fast service-tier declaration. Older
// peers cannot safely preserve that Runtime Policy field.
// 27: Runtime Policy carries the Host-owned shell preference used by tool,
// PTY, and prompt composition. Older peers cannot safely preserve that field.
// Transcript pages amortize storage and network round trips with a 512 KiB raw
// payload. Base64 expansion plus the bounded fragment envelope must still fit in
// one transport message; narrower domains retain their own encoded limits.
export const RUNTIME_HOST_MAX_MESSAGE_BYTES = 768 * 1024;
export const RUNTIME_HOST_MAX_IN_FLIGHT_DOMAIN_REQUESTS = 64;
export const INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID = 'maka.interactive' as const;

declare const encodedProtocolMessageBrand: unique symbol;

export type EncodedProtocolMessage = Buffer & {
  readonly [encodedProtocolMessageBrand]: true;
};

export interface ProtocolRange {
  min: number;
  max: number;
}

export interface ClientHello {
  kind: 'hello';
  clientInstanceId: string;
  protocolMin: number;
  protocolMax: number;
  compatibilityEpoch: number;
  compositionId: string;
  generation?: string;
  takeover?: { expectedHostEpoch: string };
}

export interface HostAccepted {
  kind: 'accepted';
  rootId: string;
  hostEpoch: string;
  connectionId: string;
  selectedProtocol: number;
  compatibilityEpoch: number;
  compositionId: string;
  compositionRevision: string;
  state: Exclude<HostLifecycleState, 'draining'>;
}

export interface HostIncompatible {
  kind: 'incompatible';
  hostEpoch: string;
  protocolMin: number;
  protocolMax: number;
  compatibilityEpoch: number;
  compositionId: string;
  compositionRevision: string;
  generation?: string;
  state: HostLifecycleState;
  replacement: 'blocked_by_residency' | 'wait_for_idle_exit';
  activity?: HostActivitySnapshot;
}

export interface HostDraining {
  kind: 'draining';
  hostEpoch: string;
  compositionId: string;
  compositionRevision: string;
}

export type HostHandshakeResult = HostAccepted | HostIncompatible | HostDraining;

export type ClientFrame = ClientHello | RequestFrame | ClientCapabilityClientFrame;
export type HostFrame =
  | HostHandshakeResult
  | ResponseFrame
  | SubscriptionFrame
  | ClientCapabilityHostFrame
  | ConfigurationChangedFrame
  | ConnectionCatalogChangedFrame
  | ProjectCatalogChangedFrame
  | SessionCatalogChangedFrame
  | ScheduledTaskChangedFrame;

export interface HostRegistration {
  kind: 'maka-runtime-host';
  schemaVersion: typeof RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION;
  rootId: string;
  hostEpoch: string;
  endpoint: string;
  websocketEndpoints?: readonly string[];
  protocolMin: number;
  protocolMax: number;
  compatibilityEpoch: number;
  compositionId: string;
  compositionRevision: string;
  lifecycleMode?: 'ephemeral' | 'service';
  generation?: string;
  state: HostLifecycleState;
  pid: number;
  createdAt: string;
}

export function negotiateProtocol(client: ProtocolRange, host: ProtocolRange): number | undefined {
  validateProtocolRange(client);
  validateProtocolRange(host);
  const selected = Math.min(client.max, host.max);
  return selected >= Math.max(client.min, host.min) ? selected : undefined;
}

export function validateProtocolRange(range: ProtocolRange): void {
  if (
    !Number.isSafeInteger(range.min) ||
    !Number.isSafeInteger(range.max) ||
    range.min < 0 ||
    range.max < range.min
  ) {
    throw invalidProtocolFrame('Invalid protocol range');
  }
}

export function requireClientInstanceId(value: unknown): string {
  return requireId(value, 'clientInstanceId');
}

export function requireHostGeneration(value: unknown): string {
  return requireId(value, 'generation');
}

export function decodeClientFrame(value: unknown): ClientFrame {
  const frame = requireRecord(value, 'client frame');
  if (frame.kind === 'hello') {
    const protocolMin = requireProtocolVersion(frame.protocolMin, 'protocolMin');
    const protocolMax = requireProtocolVersion(frame.protocolMax, 'protocolMax');
    validateProtocolRange({ min: protocolMin, max: protocolMax });
    const generation =
      frame.generation === undefined ? undefined : requireHostGeneration(frame.generation);
    const takeover = decodeTakeover(frame.takeover);
    if (takeover !== undefined && generation === undefined) {
      throw invalidProtocolFrame('Runtime Host takeover requires a generation');
    }
    return {
      kind: 'hello',
      clientInstanceId: requireClientInstanceId(frame.clientInstanceId),
      protocolMin,
      protocolMax,
      compatibilityEpoch: decodeCompatibilityEpoch(frame.compatibilityEpoch),
      compositionId: decodeCompositionId(frame.compositionId),
      ...(generation === undefined ? {} : { generation }),
      ...(takeover === undefined ? {} : { takeover }),
    } satisfies ClientHello;
  }
  if (isClientCapabilityClientFrameKind(frame.kind)) {
    return decodeClientCapabilityClientFrame(frame);
  }
  return decodeRequestFrame(frame);
}

export function decodeHostFrame(value: unknown): HostFrame {
  const frame = requireRecord(value, 'host frame');
  if (frame.kind === 'accepted') {
    return {
      kind: 'accepted',
      rootId: requireHostRootId(frame.rootId),
      hostEpoch: requireId(frame.hostEpoch, 'hostEpoch'),
      connectionId: requireId(frame.connectionId, 'connectionId'),
      selectedProtocol: requireProtocolVersion(frame.selectedProtocol, 'selectedProtocol'),
      compatibilityEpoch: decodeCompatibilityEpoch(frame.compatibilityEpoch),
      compositionId: decodeCompositionId(frame.compositionId),
      compositionRevision: decodeCompositionRevision(frame.compositionRevision),
      state: requireAcceptedState(frame.state),
    } satisfies HostAccepted;
  }
  if (frame.kind === 'incompatible') {
    const protocolMin = requireProtocolVersion(frame.protocolMin, 'protocolMin');
    const protocolMax = requireProtocolVersion(frame.protocolMax, 'protocolMax');
    validateProtocolRange({ min: protocolMin, max: protocolMax });
    return {
      kind: 'incompatible',
      hostEpoch: requireId(frame.hostEpoch, 'hostEpoch'),
      protocolMin,
      protocolMax,
      compatibilityEpoch: decodeCompatibilityEpoch(frame.compatibilityEpoch),
      compositionId: decodeCompositionId(frame.compositionId),
      compositionRevision: decodeCompositionRevision(frame.compositionRevision),
      ...(frame.generation === undefined
        ? {}
        : { generation: requireHostGeneration(frame.generation) }),
      state: requireHostLifecycleState(frame.state),
      replacement: requireReplacement(frame.replacement),
      ...(frame.activity === undefined
        ? {}
        : { activity: decodeHostActivitySnapshot(frame.activity) }),
    } satisfies HostIncompatible;
  }
  if (frame.kind === 'draining') {
    return {
      kind: 'draining',
      hostEpoch: requireId(frame.hostEpoch, 'hostEpoch'),
      compositionId: decodeCompositionId(frame.compositionId),
      compositionRevision: decodeCompositionRevision(frame.compositionRevision),
    };
  }
  if (isSubscriptionFrameKind(frame.kind)) return decodeSubscriptionFrame(frame);
  if (isClientCapabilityHostFrameKind(frame.kind)) {
    return decodeClientCapabilityHostFrame(frame);
  }
  if (frame.kind === 'configuration.changed') return decodeConfigurationChangedFrame(frame);
  if (frame.kind === 'connection.catalog.changed') {
    return decodeConnectionCatalogChangedFrame(frame);
  }
  if (frame.kind === 'project.catalog.changed') return decodeProjectCatalogChangedFrame(frame);
  if (frame.kind === 'session.catalog.changed') return decodeSessionCatalogChangedFrame(frame);
  if (frame.kind === 'scheduled-task.changed') return decodeScheduledTaskChangedFrame(frame);
  return decodeResponseFrame(frame);
}

export function decodeHostRegistration(value: unknown): HostRegistration {
  const registration = requireRecord(value, 'host registration');
  if (registration.kind !== 'maka-runtime-host') {
    throw invalidProtocolFrame('Invalid registration kind');
  }
  if (registration.schemaVersion !== RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION) {
    throw invalidProtocolFrame('Unsupported registration schema');
  }
  const protocolMin = requireProtocolVersion(registration.protocolMin, 'protocolMin');
  const protocolMax = requireProtocolVersion(registration.protocolMax, 'protocolMax');
  validateProtocolRange({ min: protocolMin, max: protocolMax });
  const rootId = requireHostRootId(registration.rootId);
  const websocketEndpoints = decodeRegistrationWebSocketEndpoints(registration.websocketEndpoints);
  const pid = requireCount(registration.pid, 'pid');
  if (pid === 0) throw invalidProtocolFrame('Invalid pid');
  return {
    kind: 'maka-runtime-host',
    schemaVersion: RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
    rootId,
    hostEpoch: requireId(registration.hostEpoch, 'hostEpoch'),
    endpoint: requireString(registration.endpoint, 'endpoint', 512),
    ...(websocketEndpoints === undefined ? {} : { websocketEndpoints }),
    protocolMin,
    protocolMax,
    compatibilityEpoch:
      registration.compatibilityEpoch === undefined
        ? 0
        : requireCompatibilityEpoch(registration.compatibilityEpoch),
    compositionId: decodeCompositionId(registration.compositionId),
    compositionRevision: decodeCompositionRevision(registration.compositionRevision),
    ...(registration.lifecycleMode === undefined
      ? {}
      : {
          lifecycleMode: requireHostLifecycleMode(registration.lifecycleMode),
        }),
    ...(registration.generation === undefined
      ? {}
      : { generation: requireHostGeneration(registration.generation) }),
    state: requireHostLifecycleState(registration.state),
    pid,
    createdAt: requireString(registration.createdAt, 'createdAt', 64),
  };
}

function decodeRegistrationWebSocketEndpoints(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) {
    throw invalidProtocolFrame('Invalid Runtime Host registration WebSocket endpoints');
  }
  const endpoints = value.map((entry) => {
    const endpoint = requireString(entry, 'Runtime Host WebSocket endpoint', 2_048);
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw invalidProtocolFrame('Invalid Runtime Host registration WebSocket endpoint');
    }
    if (
      url.protocol !== 'ws:' ||
      url.hostname !== '127.0.0.1' ||
      url.username ||
      url.password ||
      url.port === '' ||
      url.search ||
      url.hash ||
      !isCanonicalRuntimeHostWebSocketPath(url.pathname)
    ) {
      throw invalidProtocolFrame('Invalid Runtime Host registration WebSocket endpoint');
    }
    return url.toString();
  });
  if (new Set(endpoints).size !== endpoints.length) {
    throw invalidProtocolFrame('Duplicate Runtime Host registration WebSocket endpoint');
  }
  return Object.freeze(endpoints);
}

function requireHostLifecycleMode(value: unknown): 'ephemeral' | 'service' {
  if (value === 'ephemeral' || value === 'service') return value;
  throw invalidProtocolFrame('Invalid Runtime Host lifecycle mode');
}

function decodeTakeover(value: unknown): ClientHello['takeover'] {
  if (value === undefined) return undefined;
  const takeover = requireRecord(value, 'Runtime Host takeover');
  return {
    expectedHostEpoch: requireId(takeover.expectedHostEpoch, 'expectedHostEpoch'),
  };
}

export function encodeProtocolMessage(value: ClientFrame | HostFrame): EncodedProtocolMessage {
  const encoded = Buffer.from(JSON.stringify(value), 'utf8');
  if (encoded.byteLength > RUNTIME_HOST_MAX_MESSAGE_BYTES) {
    throw new RuntimeHostProtocolError(
      'frame_too_large',
      'Runtime Host message exceeds the byte limit',
    );
  }
  return encoded as EncodedProtocolMessage;
}

function requireProtocolVersion(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value as number;
}

function requireCompatibilityEpoch(value: unknown): number {
  const epoch = requireProtocolVersion(value, 'compatibilityEpoch');
  if (epoch > 1_000_000) throw invalidProtocolFrame('Invalid compatibilityEpoch');
  return epoch;
}

export function requireHostCompositionId(value: unknown): string {
  const id = requireString(value, 'compositionId', 128);
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(id)) {
    throw invalidProtocolFrame('Invalid compositionId');
  }
  return id;
}

export function requireHostRootId(value: unknown): string {
  const rootId = requireString(value, 'rootId', 64);
  if (!/^[a-f0-9]{64}$/.test(rootId)) throw invalidProtocolFrame('Invalid rootId');
  return rootId;
}

function requireCompositionRevision(value: unknown): string {
  const revision = requireString(value, 'compositionRevision', 128);
  if (revision.length === 0 || /[\u0000-\u001f\u007f]/u.test(revision)) {
    throw invalidProtocolFrame('Invalid compositionRevision');
  }
  return revision;
}

function decodeCompositionId(value: unknown): string {
  return value === undefined
    ? INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID
    : requireHostCompositionId(value);
}

function decodeCompositionRevision(value: unknown): string {
  return value === undefined ? 'legacy' : requireCompositionRevision(value);
}

function decodeCompatibilityEpoch(value: unknown): number {
  // Epoch 0 represents peers and registrations that do not publish this field.
  return value === undefined ? 0 : requireCompatibilityEpoch(value);
}

function requireAcceptedState(value: unknown): Exclude<HostLifecycleState, 'draining'> {
  const state = requireHostLifecycleState(value);
  if (state === 'draining') throw invalidProtocolFrame('Accepted Host cannot be draining');
  return state;
}

function requireReplacement(value: unknown): HostIncompatible['replacement'] {
  if (value === 'blocked_by_residency' || value === 'wait_for_idle_exit') return value;
  throw invalidProtocolFrame('Invalid replacement disposition');
}
