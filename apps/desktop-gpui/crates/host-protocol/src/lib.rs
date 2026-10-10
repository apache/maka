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

//! Wire types and framing for the Maka Runtime Host protocol.
//!
//! This crate owns no I/O and no UI. It mirrors the TypeScript protocol in
//! `packages/runtime-host/src/protocol/` of the Maka monorepo; every type names
//! the decoder it was traced from. Response-side types tolerate unknown fields
//! so a newer Host does not break decoding. Unit tests in this crate compile
//! the same types with `deny_unknown_fields`, so the golden fixtures captured
//! from a real Host fail loudly when the Host adds a field we do not model.

#[macro_use]
mod wire_enum;

mod access;
mod artifact;
mod compat;
mod configuration;
mod connection_catalog;
mod connection_effects;
mod context;
mod credential_vault;
mod daily_review;
mod envelope;
mod execution_inspect;
mod frame;
mod handshake;
mod host_frame;
mod host_status;
mod identity;
mod interaction;
mod memory;
mod message;
mod model_override;
mod network_proxy;
mod operation;
mod project_catalog;
mod provider_registry;
mod recall;
mod registration;
mod request_headers;
mod runtime_policy;
mod runtime_resource;
mod scheduled_task;
mod serde_util;
mod session;
mod session_catalog;
mod session_continuity;
mod session_retirement;
mod session_revision;
mod session_transcript;
mod session_turns;
mod session_update;
mod skill_catalog;
mod stored_message;
mod task_transfer;
mod turn;
mod usage;
mod web_search;
mod workspace;

pub use access::{
    ACCESS_CREDENTIAL_MAX_BYTES, ACTIVATION_FRAME_MAX_BYTES, ACTIVATION_FRAME_PREFIX,
    AccessCredential, AccessCredentialFinalize, AccessCredentialFinalizeInput,
    AccessCredentialFinalizeResult, AccessCredentialIssueResult, AccessCredentialPrepare,
    AccessCredentialPrepareInput, AccessPrincipalKind, ActivationEndpoint, ActivationFailure,
    ActivationFrame, ActivationResult, ClientCapabilityOwnerIdentity, DEFAULT_WEBSOCKET_PATH,
    DirectPeerTransport, InvalidAccessCredential, InvalidConnectionCode,
    OWNER_CONNECTION_CODE_PREFIX, OperatorCommand, OperatorPlatform, OwnerConnectionCode,
    PLAINTEXT_ACKNOWLEDGEMENT, REMOTE_OWNER_OPERATION_GRANTS, RemoteHostUrl, RemoteTransport,
    RemoteTransportKind, SshEndpoint, SshTransport, TransportError, WEBSOCKET_PATH_MAX_BYTES,
    decode_activation_frame, decode_owner_connection_code, is_canonical_websocket_path,
    normalize_ssh_destination, operation_allows_remote_owner,
};
pub use artifact::{
    ARTIFACT_CURSOR_MAX_BYTES, ARTIFACT_INGEST_CHUNK_MAX_BYTES, ARTIFACT_MIME_TYPE_MAX_BYTES,
    ARTIFACT_NAME_MAX_BYTES, ARTIFACT_PAGE_MAX_ITEMS, ARTIFACT_PREVIEW_MAX_BYTES,
    ARTIFACT_READ_CHUNK_MAX_BYTES, ARTIFACT_RESULT_MAX_BYTES, ARTIFACT_SUMMARY_MAX_BYTES,
    ArtifactBinaryPreview, ArtifactDelete, ArtifactDeleteInput, ArtifactDeleteResult,
    ArtifactIngest, ArtifactIngestInput, ArtifactIngestResult, ArtifactKind, ArtifactProjection,
    ArtifactQuery, ArtifactQueryInput, ArtifactQueryResult, ArtifactReadFailureReason,
    ArtifactSource, ArtifactTextPreview, AttachmentKind, AttachmentRef, MAX_ATTACHMENT_BYTES,
    MAX_ATTACHMENT_COUNT, StorageRef,
};
pub use compat::{
    COMPOSITION_ID, MAKA_PIN_COMMIT, MAX_IN_FLIGHT_DOMAIN_REQUESTS, MAX_MESSAGE_BYTES,
    PROTOCOL_VERSION, ProtocolRange, REGISTRATION_SCHEMA_VERSION, RUNTIME_HOST_COMPATIBILITY_EPOCH,
    SUPPORTED_PROTOCOLS,
};
pub use configuration::{
    ConfigurationCredentialExportInput, ConfigurationCredentialExportResult,
    ConfigurationCredentialsExport, ConnectionCredentialTarget, ConnectionStale,
    ExportedConfigurationCredential, canonical_effective_base_url, canonical_url,
};
pub use connection_catalog::{
    CatalogEntryItem, ConnectionCatalogCreate, ConnectionCatalogCreateInput,
    ConnectionCatalogCursor, ConnectionCatalogEntryDraft, ConnectionCatalogEntryUpdate,
    ConnectionCatalogItem, ConnectionCatalogPart, ConnectionCatalogQuery,
    ConnectionCatalogQueryInput, ConnectionCatalogQueryResult, ConnectionCatalogRemove,
    ConnectionCatalogRemoveInput, ConnectionCatalogSetDefaultTarget,
    ConnectionCatalogSetDefaultTargetInput, ConnectionCatalogUpdate, ConnectionCatalogUpdateInput,
    ConnectionHeader, ConnectionModelItem, ConnectionTarget, ConnectionTestStatus,
    ConnectionTestSummary, ConnectionVersionBasis, CreateCatalogConnectionResult,
    EnabledModelIdItem, ModelCatalogEntry, ModelSource, RemoveCatalogConnectionResult,
    SetDefaultConnectionTargetResult, UpdateCatalogConnectionResult,
};
pub use connection_effects::{
    ConnectionEffectChangedDomain, ConnectionEffectFailureClass, ConnectionEffectRejection,
    ConnectionModelsFetch, ConnectionModelsFetchInput, ConnectionModelsFetchResult,
    ConnectionOnboardingRejection, ConnectionOnboardingSave, ConnectionOnboardingSaveInput,
    ConnectionOnboardingSaveResult, ConnectionOnboardingTarget, ConnectionOnboardingVerify,
    ConnectionOnboardingVerifyInput, ConnectionOnboardingVerifyResult, ConnectionTestProjection,
    ConnectionTestRun, ConnectionTestRunInput, ConnectionTestRunResult, DiscoveredModel,
    SavedConnection,
};
pub use context::{
    CONTEXT_COMPOSITION_MAX_TOOLS, ContextCompaction, ContextCompactionKind,
    ContextCompactionPhase, ContextComposition, ContextDiagnostics, ContextDiagnosticsQuery,
    ContextDiagnosticsQueryInput, ContextDiagnosticsResult, ContextDiagnosticsUnavailable,
    ContextSegment, ContextSegmentKind, ContextTool, ContextToolRemainder,
    ContextUnavailableReason,
};
pub use credential_vault::{
    CredentialExpectation, CredentialKind, CredentialLocator, CredentialMutationResult,
    CredentialStatus, CredentialVaultDelete, CredentialVaultDeleteInput, CredentialVaultQuery,
    CredentialVaultQueryInput, CredentialVaultQueryResult, CredentialVaultSet,
    CredentialVaultSetInput, CredentialVersionBasis,
};
pub use daily_review::{
    DAILY_REVIEW_DAY_SPAN_MAX, DAILY_REVIEW_OFFSET_DAYS_MAX, DAILY_REVIEW_PAGE_MAX_ITEMS,
    DailyReviewArchive, DailyReviewArchiveStatus, DailyReviewArchiveSummary, DailyReviewConfig,
    DailyReviewDay, DailyReviewMutate, DailyReviewMutateInput, DailyReviewMutateResult,
    DailyReviewQuery, DailyReviewQueryInput, DailyReviewQueryResult, DailyReviewRange,
    DailyReviewSections, DailyReviewSessionRow, DailyReviewSummary, DailyReviewTopEntry,
    DailyReviewTotals, DailyReviewTrigger,
};
pub use envelope::{
    HostOperationError, HostOperationErrorCode, Outcome, RequestFrame, ResponseFrame,
};
pub use execution_inspect::{
    CostBasis, EXECUTION_INSPECT_CURSOR_MAX_BYTES, EXECUTION_INSPECT_RESULT_MAX_BYTES,
    EXECUTION_INSPECT_TRACE_PAGE_MAX_TURNS, ExecutionInspectQuery, ExecutionInspectQueryInput,
    ExecutionInspectQueryResult, HistoryCompactRoute, ModelCallCoverage, ModelCallKind,
    ModelCallStatus, SESSION_TRACE_SCHEMA_VERSION, SessionTraceCoverage, SessionTracePage,
    ToolRecoveryDisposition, ToolStepStatus, TraceCompactionStep, TraceErrorStep,
    TraceFailureAttribution, TraceModelAttempt, TraceModelCallStep, TracePermissionStep, TraceStep,
    TraceToolRecovery, TraceToolStep, TraceTurnIdentity, TurnTrace, UsageBasis,
};
pub use frame::{FrameDecoder, FrameError, decode_frame_json, encode_frame};
pub use handshake::{
    ClientHello, HandshakeResult, HostAccepted, HostActivitySnapshot, HostDraining,
    HostIncompatible, HostResidency, ReplacementDisposition, Takeover,
};
pub use host_frame::{
    ChangeNotice, FrameDecodeError, HostFrame, PushFrame, ScheduledTaskChangedReason,
    SessionAttention, SessionAttentionKind, SubscriptionFrame,
};
pub use host_status::{
    HOST_DIAGNOSTIC_LOG_MAX_ENTRIES, HostDiagnostics, HostDiagnosticsResult, HostLifecycleState,
    HostResidencyCount, HostStatus, HostStatusInput, HostStatusResult,
};
pub use identity::{ClientInstanceId, InvalidClientInstanceId, is_root_id};
pub use interaction::{
    ClosureOutcome, CommandReview, GenericToolReview, InteractionAnswer, InteractionAnswerCommand,
    InteractionAnswerInput, InteractionClosureReason, InteractionOutcome, InteractionQuery,
    InteractionQueryInput, InteractionQuestion, InteractionQuestionOption, InteractionRequest,
    InteractionSnapshot, InteractionStatus, PathReview, PermissionDecision, PermissionOutcome,
    PermissionPrompt, PermissionRequest, PermissionReview, QuestionOutcome, QuestionRequest,
    ReviewTextPreview, SandboxBoundaryAccess, SandboxBoundaryExpansion, SandboxBoundaryFilesystem,
    SandboxBoundaryFilesystemEntry, SandboxBoundaryNetwork, SandboxBoundaryOutcome,
    SandboxBoundaryRequest, SandboxBoundaryScope, SandboxBoundaryStatus, SandboxEscalationPrompt,
    SearchReview, SessionInteractionProjection, ToolPermissionPrompt, WebReview,
};
pub use memory::{
    MEMORY_CONTENT_MAX_BYTES, MEMORY_DOCUMENT_CHUNK_MAX_BYTES, MEMORY_DOCUMENT_MAX_BYTES,
    MEMORY_ENTRY_PAGE_MAX_ITEMS, MEMORY_TITLE_MAX_BYTES, MemoryBackup, MemoryBackupKind,
    MemoryBlockReason, MemoryDocumentName, MemoryDocumentPage, MemoryDocumentStatus,
    MemoryEntriesPage, MemoryEntriesView, MemoryEntry, MemoryEntryScope, MemoryEntrySource,
    MemoryEntryStatus, MemoryMutate, MemoryMutateInput, MemoryMutateResult, MemoryQuery,
    MemoryQueryInput, MemoryQueryResult, MemoryRejectionReason, MemorySafeModeReason, MemoryScope,
    MemoryState, memory_content_revision,
};
pub use message::{
    MESSAGE_QUEUE_MAX_ENTRIES, MessageContent, MessagePlacement, MessageQueueEntrySnapshot,
    MessageQueueEntryState, QUOTE_COMMENT_MAX_LENGTH, QUOTE_LABEL_MAX_LENGTH, QUOTE_MAX_COUNT,
    QUOTE_TEXT_MAX_LENGTH, QueueEntriesReorder, QueueEntriesReorderInput, QueueEntryPromote,
    QueueEntryPromoteInput, QueueEntryRetract, QueueEntryRetractInput, QueueEntryUpdate,
    QueueEntryUpdateInput, QueueMutationResult, QueueRetract, QueueRetractInput,
    QueueRetractResult, QuoteRef, SessionMessageQueueProjection, TurnMessageSubmit,
    TurnMessageSubmitInput, TurnMessageSubmitResult,
};
pub use model_override::{
    DECLARABLE_THINKING_LEVELS, FAST_SERVICE_TIER, ModelOverride, ModelOverrides,
    apply_patch_by_default, parse_token_count, supports_fast_service_tier,
};
pub use network_proxy::{
    NetworkProxyCredentialTarget, NetworkProxyCredentialUpdate, NetworkProxyTest,
    NetworkProxyTestInput, NetworkProxyTestResult, NetworkProxyUpdate, NetworkProxyUpdateInput,
    NetworkProxyUpdateResult,
};
pub use operation::Operation;
pub use project_catalog::{
    ProjectCatalogLocation, ProjectCatalogMutate, ProjectCatalogMutateInput,
    ProjectCatalogMutateResult, ProjectCatalogPageItem, ProjectCatalogProject, ProjectCatalogQuery,
    ProjectCatalogQueryInput, ProjectCatalogQueryResult, ProjectCatalogView, ProjectDirectoryEntry,
    ProjectDirectoryRoot,
};
pub use provider_registry::{
    CUSTOM_PROVIDER_TYPE, ModelApiProtocol, PROVIDER_REGISTRY, ProviderAuth, ProviderDefinition,
    ProviderGroup,
};
pub use recall::{
    RECALL_DEFAULT_LIMIT, RECALL_MAX_LIMIT, RECALL_MAX_TERMS, RECALL_MESSAGE_MAX_BYTES,
    RECALL_PASSAGE_MAX_BYTES, RECALL_PASSAGE_NEIGHBOURS, RECALL_QUERY_QUESTION_MAX_BYTES,
    RECALL_QUERY_TERM_MAX_CHARS, RECALL_QUESTION_MAX_UTF16, RECALL_TOTAL_PAYLOAD_CAP_BYTES,
    RecallFact, RecallFailureReason, RecallMatchKind, RecallMaterial, RecallPassage,
    RecallPassageMessage, RecallQuery, RecallQueryError, RecallQueryInput, RecallQueryResult,
    RecallRole, recall_terms_for,
};
pub use registration::{HostLifecycleMode, HostRegistration, InvalidRegistration};
pub use request_headers::{
    ConnectionRequestHeadersQuery, ConnectionRequestHeadersQueryInput,
    ConnectionRequestHeadersQueryResult, ConnectionRequestHeadersReplace,
    ConnectionRequestHeadersReplaceInput, ConnectionRequestHeadersReplaceResult,
    RequestHeaderUpdate,
};
pub use runtime_policy::{
    AgentRuntimeSettingsPatch, AntigravityPolicy, ChatDefaultPermissionMode, ChatDefaults,
    EnabledPatch, ExternalAgentsPolicy, JevPolicy, MemoryPatch, MemoryPolicy, NetworkProxyPolicy,
    PersonalizationPatch, PersonalizationPolicy, PrivacyPatch, PrivacyPolicy, ProxyProtocol,
    RuntimePolicy, RuntimePolicyMutate, RuntimePolicyMutateInput, RuntimePolicyMutateResult,
    RuntimePolicyMutation, RuntimePolicyQuery, RuntimePolicyQueryInput, RuntimePolicySnapshot,
    ShellPolicy, ShellPreference, SubagentPreset, SubagentProfile, SubagentSettings,
    WebSearchPolicy, WebSearchProvider, WorkspaceInstructionsPolicy,
};
pub use runtime_resource::{
    DESKTOP_TERMINAL_LAUNCH_PREFIX, MAX_LIVE_PTY_RUNS, PipeShellOutput, PtyControl, PtyCursor,
    PtyShellOutput, PtySize, PtySnapshot, RUNTIME_RESOURCE_COMMAND_MAX_BYTES,
    RUNTIME_RESOURCE_CONTROL_INPUT_MAX_BYTES, RUNTIME_RESOURCE_CONTROLLER_ACQUIRE_RESULT_MAX_BYTES,
    RUNTIME_RESOURCE_CURSOR_MAX_BYTES, RUNTIME_RESOURCE_MAX_CONTROL_SEQUENCE,
    RUNTIME_RESOURCE_MAX_PTY_COLS, RUNTIME_RESOURCE_MAX_PTY_ROWS, RUNTIME_RESOURCE_MIN_PTY_COLS,
    RUNTIME_RESOURCE_MIN_PTY_ROWS, RUNTIME_RESOURCE_PAGE_MAX_ITEMS,
    RUNTIME_RESOURCE_PTY_BUFFER_MAX_BYTES, RUNTIME_RESOURCE_REF_MAX_BYTES,
    RUNTIME_RESOURCE_RESULT_MAX_BYTES, RuntimeResource, RuntimeResourceAcquireResult,
    RuntimeResourceControlInput, RuntimeResourceControlResult, RuntimeResourceControllerAcquire,
    RuntimeResourceControllerControl, RuntimeResourceControllerInput,
    RuntimeResourceControllerRelease, RuntimeResourceFailure, RuntimeResourceInputError,
    RuntimeResourceOwnership, RuntimeResourceQuery, RuntimeResourceQueryInput,
    RuntimeResourceQueryResult, RuntimeResourceReleaseResult, RuntimeResourceStart,
    RuntimeResourceStartInput, RuntimeResourceStartResult, RuntimeResourceStop,
    RuntimeResourceStopInput, RuntimeResourceStopResult, SandboxDenial, ShellMode, ShellOutput,
    ShellRunState, ShellRunStatus,
};
pub use scheduled_task::{
    SCHEDULED_TASK_CATALOG_MAX_ITEMS, SCHEDULED_TASK_CHAT_ID_MAX_CHARS,
    SCHEDULED_TASK_CRON_MAX_CHARS, SCHEDULED_TASK_INTENT_MAX_CHARS, SCHEDULED_TASK_MAX_DELAY_MS,
    SCHEDULED_TASK_PAGE_MAX_ITEMS, SCHEDULED_TASK_RUN_HISTORY_LIMIT,
    SCHEDULED_TASK_TITLE_MAX_CHARS, ScheduledTask, ScheduledTaskBotPlatform,
    ScheduledTaskCalendarRecurrence, ScheduledTaskCreatedBy, ScheduledTaskCreatorKind,
    ScheduledTaskDraft, ScheduledTaskEffect, ScheduledTaskExecutionTemplate, ScheduledTaskIntent,
    ScheduledTaskMutate, ScheduledTaskMutateInput, ScheduledTaskMutateResult, ScheduledTaskNotify,
    ScheduledTaskPatch, ScheduledTaskQuery, ScheduledTaskQueryInput, ScheduledTaskQueryResult,
    ScheduledTaskRun, ScheduledTaskRunOutcome, ScheduledTaskSchedule, ScheduledTaskStatus,
    ToolMode,
};
pub use serde_util::Nullable;
pub use session::{
    CollaborationMode, OrchestrationMode, PermissionMode, PersistedBackendKind,
    SessionBlockedReason, SessionStatus, ThinkingLevel,
};
pub use session_catalog::{
    SessionCatalogItem, SessionCatalogLiveRunState, SessionCatalogProjection, SessionCatalogQuery,
    SessionCatalogQueryInput, SessionCatalogQueryResult, SessionRevisionState,
    SessionSubagentProjection, UnsupportedLegacySessionCatalogRecord,
};
pub use session_continuity::{
    AgentGraphChangedFrame, AgentGraphChangedReason, AssistantStreamKind, PTY_INTEREST_MAX_REFS,
    PtyInterestInput, SESSION_CONTINUITY_SCHEMA_VERSION,
    SESSION_RUNTIME_RESOURCE_PTY_DATA_MAX_BYTES, SessionAssistantDelta,
    SessionAssistantStreamIdentity, SessionContinuityIdentity, SessionContinuitySnapshot,
    SessionDeltaFrame, SessionDomain, SessionDomainChangedFrame, SessionEventFrame, SessionFrame,
    SessionFrameEvent, SessionProjectionFrame, SessionRuntimeResourceChange,
    SessionRuntimeResourcePtyDataFrame, SessionSteeringEvent, SessionToolOutputDelta,
    SessionToolProgress, SessionToolResult, SessionToolResultPreview, SessionToolResultStatus,
    SessionToolStart, SessionTranscriptAdvancedFrame, SubscriptionClose, SubscriptionClosedFrame,
    SubscriptionClosedReason, SubscriptionIdInput, SubscriptionIdResult, SubscriptionOpen,
    SubscriptionOpenInput, SubscriptionOpenResult, SubscriptionPtyInterestSet, SubscriptionReady,
    ToolOutputStream, TranscriptPolicy,
};
pub use session_retirement::{
    SessionLifecycleSet, SessionLifecycleSetInput, SessionLifecycleState, SessionRemove,
    SessionRemoveInput, SessionRemovePreview, SessionRemovePreviewInput,
    SessionRemovePreviewResult, SessionRemoveResult,
};
pub use session_revision::{
    ConversationCopyIntent, SIDE_CONVERSATION_SESSION_LABEL, SessionBranchCreate,
    SessionConversationCopyInput, SessionConversationCopyResult, is_side_conversation,
};
pub use session_transcript::{
    SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES, SESSION_TRANSCRIPT_PAGE_MAX_BYTES,
    SessionTranscriptBootstrap, SessionTranscriptFragment, SessionTranscriptPage,
    SessionTranscriptPageInput, SessionTranscriptPageQuery, TranscriptAssembler,
    TranscriptAssemblyError, TranscriptDirection, TranscriptEntry,
};
pub use session_turns::{
    SESSION_TURNS_QUERY_MAX_CONTRIBUTIONS, SessionTurnContribution, SessionTurnState,
    SessionTurnsQuery, SessionTurnsQueryInput, SessionTurnsQueryResult, latest_completed_turn,
};
pub use session_update::{
    SessionConfigurationPatch, SessionConfigurationUpdate, SessionConfigurationUpdateInput,
    SessionCreate, SessionCreateInput, SessionExecutorTarget, SessionMetadataPatch,
    SessionMetadataUpdate, SessionMetadataUpdateInput, SessionModelTarget, SessionUpdateResult,
};
pub use skill_catalog::{
    SkillCatalogBundledItem, SkillCatalogContextStatus, SkillCatalogDiscoverySource,
    SkillCatalogGovernanceItem, SkillCatalogManagedSourceItem, SkillCatalogManagedSourceType,
    SkillCatalogManagedUpdateStatus, SkillCatalogMutate, SkillCatalogMutateInput,
    SkillCatalogMutateResult, SkillCatalogMutation, SkillCatalogMutationRejectedReason,
    SkillCatalogPageItem, SkillCatalogPreview, SkillCatalogPreviewLineSummary,
    SkillCatalogPreviewRejectedReason, SkillCatalogPreviewUpdate, SkillCatalogPreviewUpdateInput,
    SkillCatalogPreviewUpdateResult, SkillCatalogQuery, SkillCatalogQueryInput,
    SkillCatalogQueryResult, SkillCatalogRuntimeStatus, SkillCatalogScope, SkillCatalogSourceType,
    SkillCatalogValidationCode, SkillCatalogValidationStatus, SkillCatalogView,
    SkillCatalogWorkspaceContext, SkillInstallSourceType,
};
pub use stored_message::{
    AssistantMessage, AssistantStepContentKind, PermissionDecisionMessage, StoredMessage,
    ToolCallMessage, ToolResultMessage, TurnStateMessage, TurnStatus, UserMessage,
};
pub use task_transfer::{
    EXTERNAL_SESSION_PAGE_MAX_ITEMS, EXTERNAL_SESSION_QUERY_TEXT_MAX_BYTES,
    ExternalSessionCatalogItem, ExternalSessionCatalogQuery, ExternalSessionCatalogQueryInput,
    ExternalSessionCatalogQueryResult, ExternalSessionImport, ExternalSessionImportInput,
    ExternalSessionImportResult, ExternalSessionImportState, ExternalSessionLimit,
    ExternalSessionLimitKind, ExternalSessionSourceQuery, ExternalSessionSourceQueryInput,
    ExternalSessionSourceQueryResult, SessionBundleExport, SessionBundleExportInput,
    SessionBundleExportResult, SessionBundleImport, SessionBundleImportInput,
    SessionBundleImportResult,
};
pub use turn::{
    ProviderRetryPhase, ProviderRetryReason, TurnInterrupt, TurnInterruptInput,
    TurnInterruptResult, TurnOrchestration, TurnProviderRetry, TurnQuery, TurnQueryInput,
    TurnRunStatus, TurnSnapshot, TurnStart, TurnStartInput, TurnStartResult, TurnStop,
    TurnStopInput,
};
pub use usage::{
    LlmUsageLog, LlmUsageQuery, ToolUsageTotals, USAGE_PAGE_MAX_ITEMS,
    USAGE_SCREEN_SEARCH_MAX_BYTES, UsageActivityPage, UsageCoverage, UsageLogSource, UsageModelRow,
    UsageOutcome, UsagePricingRow, UsageProvenance, UsageProviderRow, UsageQuery, UsageQueryInput,
    UsageQueryResult, UsageRangeBounds, UsageRequestLog, UsageRowKind, UsageScreen,
    UsageScreenQuery, UsageStatusFilter, UsageSummary, UsageSummaryV2, UsageTokenTotals,
    UsageToolRow,
};
pub use web_search::{
    WEB_SEARCH_DEFAULT_LIMIT, WEB_SEARCH_MAX_LIMIT, WEB_SEARCH_QUERY_MAX_CHARS,
    WebSearchErrorReason, WebSearchExecute, WebSearchExecuteInput, WebSearchExecuteResult,
    WebSearchResultRow,
};
pub use workspace::{WorkspaceProjection, WorkspaceTarget};

#[cfg(test)]
mod fixture_tests;
