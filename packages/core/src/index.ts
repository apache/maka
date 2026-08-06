/**
 * @maka/core — barrel export.
 *
 * Convention: subpath imports (e.g. `@maka/core/permission`) are
 * the canonical form. The barrel below re-exports everything for convenience
 * but downstream code should prefer subpaths to keep the dependency graph
 * explicit.
 */

export * from './mcp.js';
export * from './collaboration.js';
export * from './orchestration.js';
export * from './tool-mode.js';
export * from './swarm-command.js';
export * from './graph-command.js';
export * from './plan.js';
export * from './agent-graph-control.js';
export * from './agent-graph-schedule.js';
export * from './agent-graph-topology.js';
export * from './agent-graph-client-projection.js';
export * from './agent-graph-supervisor-wake.js';
export * from './agent-graph-timeline.js';
export * from './runtime-policy.js';
export * from './goal.js';
export * from './execution-inspect.js';
export * from './interaction.js';
export * from './project.js';
export * from './subagent-workspace.js';

// events.ts
export type {
  SessionEvent,
  SessionCommand,
  TextDeltaEvent,
  TextCompleteEvent,
  ThinkingDeltaEvent,
  ThinkingCompleteEvent,
  ToolStartEvent,
  ToolActivityKind,
  ToolOutputDeltaEvent,
  ToolOutputStream,
  ToolProgressEvent,
  ToolResultEvent,
  ToolResultContent,
  ShellRunSnapshotResult,
  ShellRunCompactResult,
  ShellRunStateResult,
  ShellRunUpdateOwnership,
  ShellRunUpdate,
  SandboxDenialSignal,
  SandboxDenialRecovery,
  ActiveInteractionRequestEvent,
  SandboxBoundaryRequestEvent,
  SandboxBoundaryDecisionAckEvent,
  AdditionalPermissionRequestEvent,
  SandboxEscalationRequestEvent,
  AnyPermissionRequestEvent,
  PermissionRequestEvent,
  PermissionAnswerAckEvent,
  PermissionClosureAckEvent,
  PermissionClosureReason,
  PermissionDecisionAckEvent,
  UserQuestionRequestEvent,
  PlanSubmittedEvent,
  PlanStep,
  TokenUsageEvent,
  SteeringMessageEvent,
  QueueUpdateEvent,
  QueueEnqueueOutcome,
  ProviderRetryEvent,
  ProviderRetryScheduledEvent,
  ProviderRetryStartedEvent,
  ProviderRetryReason,
  ErrorEvent,
  CompleteEvent,
  AbortEvent,
  StorageRef,
  AttachmentRef,
  QuoteRef,
  InlineReference,
  MessageContent,
  AttachmentIngestItem,
  CompleteStopReason,
  ContextBudgetExhaustedDetail,
} from './events.js';
export type {
  UserQuestion,
  UserQuestionOption,
  UserQuestionRequest,
  UserQuestionResponse,
  UserQuestionResult,
} from './user-question.js';
export {
  decodeMessageContent,
  failureClassFromCompleteStopReason,
  isAttachmentRef,
  isCanonicalAttachmentRef,
  isCanonicalStorageRef,
  isInlineReference,
  isMessageContent,
  isStorageRef,
  INLINE_REFERENCE_LABEL_MAX_LENGTH,
  INLINE_REFERENCE_MAX_COUNT,
  messageContentsEqual,
  normalizeMessageContent,
  ToolOutcomeUnknownError,
  TOOL_ACTIVITY_KINDS,
  TOOL_OUTPUT_DELTA_MAX_CHARS,
  TOOL_OUTPUT_STREAMS,
} from './events.js';

// tool-result-status.ts — tool activity status from a result, or from its absence
export type {
  InFlightToolActivityStatus,
  SettledToolActivityStatus,
  ToolActivityStatus,
} from './tool-result-status.js';
export {
  isCancelledToolResultContent,
  isInFlightToolStatus,
  toolResultActivityStatus,
  unfinishedToolActivityStatus,
} from './tool-result-status.js';

// agent-swarm.ts — bounded projection over the canonical settled tool result.
export type {
  AgentSwarmResult,
  AgentSwarmResultProjection,
} from './agent-swarm.js';
export { projectAgentSwarmResult } from './agent-swarm.js';

// runtime-event.ts — canonical Runtime v2 event contract.
// Subpath `@maka/core/runtime-event` is the canonical import; these barrel
// re-exports are for convenience.
export type {
  RuntimeEvent,
  RuntimeEventRole,
  RuntimeEventAuthor,
  RuntimeEventStatus,
  RuntimeEventTextContent,
  RuntimeEventThinkingContent,
  RuntimeEventFunctionCallContent,
  RuntimeEventFunctionResponseContent,
  RuntimeEventErrorContent,
  RuntimeEventContent,
  RuntimeEventContentKind,
  RuntimeEventTokenUsage,
  RuntimeEventPermissionDecision,
  RuntimeEventPermissionAnswerAccepted,
  RuntimeEventPermissionClosureAccepted,
  RuntimeEventUserQuestionAnswerAccepted,
  RuntimeEventProtocolMarker,
  RuntimeEventContinuationStartV2,
  RuntimeEventToolDispatch,
  RuntimeEventActions,
  RuntimeEventRefs,
  ToolBoundaryProtocol,
  ToolRecoveryMode,
} from './runtime-event.js';
export {
  RUNTIME_EVENT_ROLES,
  RUNTIME_EVENT_AUTHORS,
  RUNTIME_EVENT_STATUSES,
  TERMINAL_RUNTIME_EVENT_STATUSES,
  RUNTIME_EVENT_CONTENT_KINDS,
  TOOL_BOUNDARY_PROTOCOL_V1,
  isRuntimeEventRole,
  isRuntimeEventAuthor,
  isRuntimeEventStatus,
  decodeRuntimeEvent,
  decodePersistedRuntimeEvent,
  isTerminalRuntimeEventStatus,
  isTerminalRuntimeEvent,
  isPartialRuntimeEvent,
  runtimeEventHasModelVisibleContent,
  createRuntimeEventId,
} from './runtime-event.js';

export type {
  RuntimeEventWorkspaceFactEnvelope,
  ScannedWorkspaceBaselineAuthority,
  WorkspaceAuthorityIdentity,
  WorkspaceAuthorityIssue,
  WorkspaceAuthorityIssueCode,
  WorkspaceAuthorityLedgerRow,
  WorkspaceBaselineAuthorityEvents,
  WorkspaceBaselineAuthorityInput,
  WorkspaceBaselineAuthorityScanResult,
  WorkspaceBaselineDescriptorV1,
  WorkspaceBaselineAcceptedV1,
  WorkspaceEpochDescriptorV1,
  WorkspaceEpochOpenedV1,
  WorkspaceEpochRecordV1,
  WorkspaceFactEventLaneValidation,
  WorkspaceGitObjectFormat,
  WorkspaceHeadRecordV1,
  WorkspaceBaselineCommitResult,
  WorkspaceProjectionRebuildResult,
  WorkspaceVersionRecordV1,
} from './workspace-version-authority.js';
export {
  WORKSPACE_AUTHORITY_SESSION_ID,
  WORKSPACE_EPOCH_OPENED_FACT_KIND,
  WORKSPACE_FACT_VERSION,
  WORKSPACE_MATERIALIZATION_SEMANTICS_V1,
  WORKSPACE_BASELINE_ACCEPTED_FACT_KIND,
  WORKSPACE_VERSION_AUTHORITY_CAPABILITY_V1,
  buildWorkspaceBaselineAuthorityEvents,
  isRuntimeEventWorkspaceFactEnvelope,
  scanWorkspaceBaselineAuthority,
  validateWorkspaceFactEventLane,
  workspaceAuthorityIdentity,
} from './workspace-version-authority.js';

// execution-evidence.ts — shared cross-ledger identity and source coverage.
// This contract references canonical facts; it does not create another fact
// authority. Subpath `@maka/core/execution-evidence` is preferred.
export type {
  ExecutionIdentityRef,
  TaskIdentityRef,
  ExecutionLogCursor,
  ExecutionLogCoverage,
  WorkspaceRevisionRef,
  TargetSnapshotRef,
  ExecutionEvidenceRef,
  ExecutionLogLedger,
  ExecutionLogCursorComparison,
  WorkspaceRevisionKind,
  ExecutionEvidenceValidationIssue,
  ExecutionEvidenceValidationResult,
} from './execution-evidence.js';
export {
  EXECUTION_EVIDENCE_REF_SCHEMA_VERSION,
  EXECUTION_LOG_LEDGERS,
  WORKSPACE_REVISION_KINDS,
  executionLogCursorsShareStream,
  compareExecutionLogCursors,
  validateExecutionEvidenceRef,
  isExecutionEvidenceRef,
} from './execution-evidence.js';

// runtime-event-store.ts
export type { RuntimeEventStore } from './runtime-event-store.js';
export { DurableStoreWriteError } from './runtime-event-store.js';
export type {
  ContinuationClaimResult,
  ContinuationClaimStateV1,
  RuntimeContinuationAuthorityStore,
  RuntimeRecoveryBundleCommit,
  RuntimeRecoveryBundleStore,
  RuntimeWorkspaceVersionAuthorityStore,
} from './runtime-event-store.js';
export {
  RUNTIME_CONTINUATION_AUTHORITY_V1,
  TOOL_RECOVERY_BUNDLE_CAPABILITY_V1,
} from './runtime-event-store.js';
export type {
  ToolLedgerIssue,
  ToolLedgerIssueCode,
  GenericToolLedgerAppendValidation,
  ToolLedgerLane,
  ToolLedgerLaneValidation,
  ToolLedgerRejectionCode,
  ToolLedgerScanOperation,
  ToolLedgerScanResult,
  ToolLedgerTransitionKind,
  ToolLedgerTransitionValidation,
} from './tool-ledger-scanner.js';
export {
  ToolLedgerCorruptionError,
  ToolLedgerRejectionError,
  scanToolLedger,
  validateGenericToolLedgerAppend,
  validateToolLedgerEventLane,
  validateToolLedgerTransition,
} from './tool-ledger-scanner.js';
export type {
  ToolReconcileObservation,
  ToolReconcileResultFact,
  ToolRecoveryCompletedDecisionFact,
  ToolRecoveryDecisionFact,
  ToolRecoveryFactEnvelope,
  ToolRecoveryParkedDecisionFact,
  ToolRecoveryParkReason,
} from './tool-recovery-fact.js';
export {
  TOOL_RECONCILE_RESULT_FACT_KIND,
  TOOL_RECOVERY_DECISION_FACT_KIND,
  TOOL_RECOVERY_FACT_VERSION,
  isToolReconcileResultFact,
  isToolRecoveryDecisionFact,
  isToolRecoveryFactEnvelope,
} from './tool-recovery-fact.js';
export type {
  ScannedToolRecoveryInterpretation,
  ToolRecoveryBundleValidationCode,
  ToolRecoveryBundleValidationResult,
  ToolRecoveryEventBundle,
  ToolRecoveryOperationIdentity,
} from './tool-recovery-bundle.js';
export {
  ToolRecoveryBundleValidationError,
  assertToolRecoveryEventBundle,
  interpretScannedToolRecovery,
  validateToolRecoveryEventBundle,
} from './tool-recovery-bundle.js';
export {
  canonicalToolArgsHash,
  stableJsonStringify,
  stripUndefinedDeep,
} from './tool-args-identity.js';
export {
  encodeCanonicalRuntimeEvent,
  type CanonicalRuntimeEventEncoding,
} from './canonical-runtime-event.js';
export type {
  ContinuationClaimV1,
  ImmutableRuntimePrefixV1,
  RuntimeBoundaryCursorV1,
  RuntimePrefixIdentityV1,
  RuntimePrefixPositionV1,
  RuntimePrefixRowV1,
  RuntimePrefixSegmentV1,
  RuntimeBoundaryDigest,
} from './runtime-boundary.js';
export {
  buildImmutableRuntimePrefix,
  createRuntimeBoundaryCursor,
  decodeContinuationClaim,
  decodeRuntimeBoundaryCursor,
  decodeRuntimePrefixSegment,
  digestRuntimeBoundaryManifest,
  digestRuntimePrefix,
  runtimePrefixSegment,
} from './runtime-boundary.js';

// session.ts
export type {
  SessionHeader,
  SessionSummary,
  LinkedSessionTree,
  LinkedSessionTreeProjectionOptions,
  SessionChangedEvent,
  SessionChangedReason,
  SessionStatus,
  SessionBlockedReason,
  SessionSubagentProjection,
  SubagentSessionLifecycle,
  SubagentSessionParent,
  SubagentSessionRuntime,
  SubagentSessionRuntimeSummary,
  SubagentSessionSpawn,
  SessionConversationCopy,
  TurnRecord,
  TurnStateMessage,
  TurnStatus,
  BackendKind,
  StoredMessage,
  UserMessage,
  AssistantMessage,
  AssistantStepContentKind,
  ToolCallMessage,
  ToolResultMessage,
  PermissionDecisionMessage,
  TokenUsageMessage,
  SystemNoteMessage,
} from './session.js';
export {
  SESSION_STATUSES,
  SESSION_BLOCKED_REASONS,
  SUBAGENT_SESSION_LIFECYCLES,
  SUBAGENT_SESSION_RUNTIME_SCHEMA_VERSION,
  SUBAGENT_SESSION_SPAWN_SCHEMA_VERSION,
  TURN_STATUSES,
  childSessionsForParent,
  filterLinkedSessionTree,
  projectLinkedSessionTree,
  STEP_LIMIT_NOTICE_TEXT,
  deriveTurnRecords,
  isSessionStatus,
  isSessionBlockedReason,
  isLinkedSubagentSession,
  isSubagentSessionParent,
  isSubagentSessionRuntime,
  isSubagentSessionSpawn,
  isSessionConversationCopy,
  subagentSessionRuntimeSummary,
  isTurnStatus,
  decodeStoredMessageForRead,
  decodeStoredMessageForRecovery,
  userFacingText,
} from './session.js';
export {
  decodeCanonicalToolResultContent,
  normalizeToolResultContentForRead,
} from './tool-result-record-schema.js';

// model-thinking.ts
export type { ThinkingLevel } from './model-thinking.js';
export {
  THINKING_LEVELS,
  isThinkingLevel,
  thinkingVariantsForModel,
} from './model-thinking.js';

export type { ChatModelChoice } from './chat-model-choice.js';

// agent-run.ts
export type {
  AgentRunEvent,
  AgentRunEventType,
  AgentRunHeader,
  AgentRunInputSummary,
  AgentRunStatus,
  AgentRunStore,
  EmittedAgentRunEvent,
  RootExecutionDescriptor,
} from './agent-run.js';
export {
  AGENT_RUN_STATUSES,
  decodeAgentRunEvent,
  decodeAgentRunHeader,
  isEmittedAgentRunEventType,
  isSessionInlineRun,
} from './agent-run.js';

// model-call-attempt.ts
export type {
  ModelCallAttempt,
  ModelCallAttemptStatus,
  ModelCallCostBasis,
  ModelCallCoverage,
  ModelCallGroup,
  ModelCallKind,
  ModelCallUsageBasis,
} from './model-call-attempt.js';
export {
  MODEL_CALL_ATTEMPT_EVENT_TYPE,
  MODEL_CALL_ATTEMPT_SCHEMA_VERSION,
  MODEL_CALL_ATTEMPT_STATUSES,
  MODEL_CALL_COST_BASES,
  MODEL_CALL_KINDS,
  MODEL_CALL_USAGE_BASES,
  decodeModelCallAttempt,
  dedupeModelCallAttempts,
  modelCallAttemptsFromRunEvents,
  groupModelCallAttempts,
  isModelCallAttempt,
  settledAttempt,
  sumModelCallCostUsd,
  summarizeModelCallCoverage,
} from './model-call-attempt.js';

// shell-run.ts
export type {
  PipeShellOutput,
  PtyShellOutput,
  ShellMode,
  ShellOutput,
  ShellRunOperation,
  ShellRunPatch,
  ShellRunRecord,
  ShellRunActiveStatus,
  ShellRunStatus,
  ShellRunStore,
  ShellRunTerminalStatus,
} from './shell-run.js';
export type {
  ShellRunMergeDiagnostic,
  ShellRunMergeDiagnosticReporter,
  ShellRunStateMerge,
  ShellRunUpdateBufferDrain,
  ShellRunUpdateMerge,
  ShellRunToolResult,
} from './shell-run-result.js';
export {
  SHELL_RUN_UPDATE_BUFFER_MAX_ENTRIES,
  ShellRunUpdateBuffer,
  mergeShellRunState,
  mergeShellRunStateWithDiagnostics,
  mergeShellRunUpdate,
  projectShellRunUpdateForSession,
  isValidLegacyShellRunState,
  normalizeShellToolResultContent,
  shellRunStateProjection,
} from './shell-run-result.js';
export type { ShellToolResultNormalization } from './shell-run-result.js';
export {
  ptyCompactTerminalLine,
  ptyHumanTerminalText,
  ptyTuiTerminalView,
  ptyTuiTerminalRows,
} from './pty-output-view.js';
export type { PtyTuiTerminalView } from './pty-output-view.js';
export {
  formatWriteStdinPermissionInspection,
  projectToolActivityArgs,
  projectWriteStdinPermissionSummary,
  projectWriteStdinInput,
  readWriteStdinInputPreview,
  WRITE_STDIN_INPUT_PREVIEW_MAX_CHARS,
  WRITE_STDIN_REF_PREVIEW_MAX_CHARS,
  type WriteStdinInputPreview,
  type WriteStdinPermissionSummary,
} from './tool-activity-args.js';
export {
  extractToolCommand,
  formatAsKeyValueLines,
  formatQuietJsonValue,
  formatToolInvocationLine,
  type QuietPreview,
  type ToolInvocationInput,
} from './tool-quiet-preview.js';
export {
  countDiffLineStats,
  parseUnifiedDiffRows,
  type UnifiedDiffRow,
  type UnifiedDiffRowKind,
} from './unified-diff.js';
export { redactSecrets as displayRedactSecrets } from './display-redaction.js';
export {
  SHELL_RUN_ID_MAX_CHARS,
  SHELL_RUN_SOURCE_TOOL_CALL_ID_MAX_BYTES,
  SHELL_RUN_ACTIVE_STATUSES,
  SHELL_RUN_STATUSES,
  SHELL_RUN_TERMINAL_STATUSES,
  assertShellRunIdentifier,
  assertShellRunPatch,
  assertShellRunSessionId,
  nextShellRunRecord,
  normalizeShellRunRecord,
  shellRunNotFoundError,
  isShellOutput,
  isActiveShellRunStatus,
  isShellRunId,
  isShellRunSourceToolCallId,
  isShellRunStatus,
  isValidShellRunState,
  isValidShellRunStatusTransition,
  isTerminalShellRunStatus,
} from './shell-run.js';

// browser.ts
export type {
  BrowserAddressInputFailureReason,
  BrowserAddressInputResult,
  BrowserState,
  BrowserViewRect,
} from './browser.js';
export { normalizeBrowserAddressInput } from './browser.js';

// session-event-health.ts
export type {
  SessionEventStreamSnapshot,
  SessionEventStreamStatus,
} from './session-event-health.js';
export {
  SESSION_EVENT_STREAM_REFRESH_COOLDOWN_MS,
  SESSION_EVENT_STREAM_STALE_AFTER_MS,
  SESSION_EVENT_STREAM_STATUSES,
  deriveSessionEventStreamStatus,
  isSessionEventStreamStatus,
  newestSessionStreamObservation,
  sessionExpectsEventStream,
  shouldRefreshStaleSessionEventStream,
} from './session-event-health.js';

// permission.ts
export type {
  PermissionMode,
  ApprovalsReviewer,
  ApprovalRiskLevel,
  ToolCategory,
  PolicyDecision,
  ToolExecutionFacts,
  ToolExecutionIsolation,
  ToolExecutionNetwork,
  ToolExecutionSecrets,
  ToolExecutionWriteBack,
  AdditionalPermissionRequest,
  SandboxEscalationRequest,
  SandboxEscalationRiskSummary,
  PermissionRequest,
  PermissionRequestPayload,
  PermissionResponse,
} from './permission.js';
export {
  PERMISSION_MODES,
  APPROVALS_REVIEWERS,
  APPROVAL_RISK_LEVELS,
  TOOL_CATEGORIES,
  BUILTIN_TOOL_CATEGORY,
  PRIVILEGED_SHELL_PREFIXES,
  PRIVILEGED_SHELL_PATTERNS,
  FS_DESTRUCTIVE_PATTERNS,
  DESTRUCTIVE_GIT_PATTERNS,
  categorizeBash,
  classifyToolUse,
  isPermissionMode,
  isPermissionModeWithinCeiling,
  isToolCategory,
} from './permission.js';

// computer-use.ts
export type {
  ComputerUseActionOutcome,
  ComputerUseApprovalClass,
  ComputerUseApprovalSummary,
  ComputerUseDispatchEvidence,
  ComputerUseDispatchTier,
  ComputerUseDisplayIdentity,
  ComputerUseEffect,
  ComputerUseErrorCode,
  ComputerUseBoundAction,
  ComputerUseFrameIdentity,
  ComputerUseFrameSourceKind,
  ComputerUseModelCallArgs,
  ComputerUseObservationIdentity,
  ComputerUsePageIdentity,
  ComputerUseRect,
  ComputerUseScreenFrame,
  ComputerUseWindowIdentity,
  CuAction,
  CuActionType,
  CuObservingActionType,
  CuPoint,
  CuRegion,
  CuScrollDirection,
  CuSemanticActionType,
  CuToolActionType,
} from './computer-use.js';
export {
  COMPUTER_USE_ACTION_TYPES,
  COMPUTER_USE_APPROVAL_CLASSES,
  COMPUTER_USE_SEMANTIC_ACTIONS,
  COMPUTER_USE_DISPATCH_TIERS,
  COMPUTER_USE_EFFECTS,
  COMPUTER_USE_ERROR_CODES,
  COMPUTER_USE_FRAME_SOURCE_KINDS,
  CU_ACTION_TYPES,
  CU_MUTATING_ACTION_TYPES,
  CU_OBSERVING_ACTION_TYPES,
  CU_SCROLL_DIRECTIONS,
  CU_SEMANTIC_ACTION_TYPES,
  CU_TOOL_ACTION_TYPES,
  COMPUTER_USE_WITHHELD_VALUE,
  computerUseApprovalScopeKey,
  computerUseApprovalSummary,
  computerUseModelCallArgs,
  isComputerUseErrorCode,
  isCuMutatingAction,
  isCuObservingAction,
  isCuToolAction,
} from './computer-use.js';

// permission-profile.ts
export type {
  PermissionProfile,
  PermissionProfileDisabled,
  PermissionProfileExternal,
  PermissionProfileManaged,
  PermissionProfileMatchContext,
  PermissionProfileName,
  FileSystemAccessMode,
  FileSystemProtectedMetadataPolicy,
  FileSystemPathMatch,
  FileSystemSandboxEntry,
  FileSystemSandboxKind,
  FileSystemSandboxPolicy,
  FileSystemSpecialPath,
  NetworkSandboxKind,
  NetworkSandboxPolicy,
  ProtectedMetadataName,
} from './permission-profile.js';
export {
  FILE_SYSTEM_ACCESS_MODES,
  FILE_SYSTEM_PATH_MATCHES,
  FILE_SYSTEM_SANDBOX_KINDS,
  FILE_SYSTEM_SPECIAL_PATHS,
  NETWORK_SANDBOX_KINDS,
  PROTECTED_METADATA_NAMES,
  canReadPath,
  canWritePath,
  createDangerFullAccessPermissionProfile,
  createExternalPermissionProfile,
  createReadOnlyPermissionProfile,
  createWorkspaceWritePermissionProfile,
  isDeniedPath,
  isProtectedMetadataPath,
  isReadOnlyPermissionProfile,
} from './permission-profile.js';

// sandbox-boundary.ts
export type {
  ExecutionBoundary,
  ExecutionBoundaryReadModel,
  ExecutionBoundarySummary,
  CreateSandboxBoundaryRequest,
  LegacyPermissionMode,
  SandboxBoundaryAccess,
  SandboxBoundaryExpansion,
  SandboxBoundaryExpansionAssessment,
  SandboxBoundaryExpansionValidationFailureReason,
  SandboxBoundaryExpansionValidationResult,
  SandboxBoundaryFilesystemEntry,
  SandboxBoundaryDecision,
  SandboxBoundaryClosureReason,
  SandboxBoundaryResponse,
  SandboxBoundaryRequest,
  SandboxBoundaryRequestStatus,
  SandboxBoundarySettlement,
  SandboxBoundaryScope,
  SandboxProfile,
  SettleSandboxBoundaryRequest,
} from './sandbox-boundary.js';
export {
  MAX_EXECUTION_BOUNDARY_SERIALIZED_BYTES,
  MAX_SANDBOX_BOUNDARY_FILESYSTEM_ENTRIES,
  MAX_SANDBOX_BOUNDARY_PATH_CHARS,
  MAX_SANDBOX_BOUNDARY_SERIALIZED_BYTES,
  SANDBOX_BOUNDARY_ACCESS_MODES,
  SANDBOX_BOUNDARY_CLOSURE_REASONS,
  SANDBOX_BOUNDARY_HOST_RESTART_CLOSURE_REASON,
  SANDBOX_BOUNDARY_REQUEST_STATUSES,
  SANDBOX_BOUNDARY_RESTART_CLOSURE_CLASS,
  SANDBOX_BOUNDARY_SCOPES,
  applySandboxBoundaryExpansion,
  assertExecutionBoundaryCapacity,
  assessSandboxBoundaryExpansion,
  compactSandboxBoundaryFilesystemEntries,
  createBypassExecutionBoundary,
  createExternalExecutionBoundary,
  createGenesisExecutionBoundary,
  createManagedExecutionBoundary,
  decodeExecutionBoundary,
  executionBoundaryContains,
  executionBoundaryDisplayMode,
  isSandboxBoundaryRestartClosure,
  sandboxBoundaryExpansionAllowsPath,
  validateSandboxBoundaryExpansion,
} from './sandbox-boundary.js';

// additional-permissions.ts
export type {
  AdditionalFileSystemPermission,
  AdditionalPermissionAccess,
  AdditionalPermissionProfile,
  AdditionalPermissionRiskSummary,
  AdditionalPermissionScope,
  AdditionalPermissionValidationFailureReason,
  AdditionalPermissionValidationResult,
} from './additional-permissions.js';
export {
  ADDITIONAL_PERMISSION_ACCESS_MODES,
  ADDITIONAL_PERMISSION_SCOPES,
  MAX_ADDITIONAL_FILESYSTEM_ENTRIES,
  MAX_ADDITIONAL_PERMISSION_PATH_CHARS,
  MAX_ADDITIONAL_PERMISSION_SERIALIZED_BYTES,
  compactAdditionalFileSystemPermissions,
  serializeAdditionalPermissionProfile,
  validateAdditionalPermissionProfile,
} from './additional-permissions.js';

// permission-profile-compiler.ts
export type {
  CompilePermissionProfileInput,
  CompiledPermissionProfile,
} from './permission-profile-compiler.js';
export { compilePermissionProfile } from './permission-profile-compiler.js';

// connections.ts
export type {
  ConnectionEvent,
  ConnectionCommand,
  ConnectionCredentialRequestEvent,
  ConnectionTestResultEvent,
  ConnectionListChangedEvent,
} from './connections.js';

// workspace.ts
export type { WorkspaceConfig } from './workspace.js';

// artifacts.ts
export type {
  ArtifactBinaryReadFailureReason,
  ArtifactBinaryReadResult,
  ArtifactChangedEvent,
  ArtifactChangedReason,
  ArtifactDescriptor,
  ArtifactKind,
  ArtifactReadFailureReason,
  ArtifactSaveFailureReason,
  ArtifactSaveResult,
  ArtifactRecord,
  ArtifactSource,
  ArtifactStatus,
  ArtifactTextReadResult,
} from './artifacts.js';

// runtime-inputs.ts
export type {
  AgentSpec,
  BranchFromTurnInput,
  ChildAgentTurnInput,
  CreateSessionInput,
  CreateSessionRequestInput,
  RegenerateTurnInput,
  ReviseBeforeTurnInput,
  TurnOrchestration,
  UserMessageInput,
  SessionListFilter,
} from './runtime-inputs.js';

export {
  collapseSessionRevisions,
  projectRevisionLinkedSessionTree,
  revisionFamilySessionIds,
  sessionRevisionFamilyId,
  visibleSessionRevisionMembers,
} from './session-revisions.js';

// e2e-fixture.ts
export type {
  E2eFixtureLiveTool,
  E2eFixtureScenario,
  E2eFixtureState,
} from './e2e-fixture.js';

// capabilities.ts
export type {
  ActionApprovalState,
  CapabilityActionApprovalSignal,
  CapabilityConfigurationSignal,
  CapabilityConfigurationState,
  CapabilityFeatureSignal,
  CapabilityId,
  CapabilityMemoryAcceptanceSignal,
  CapabilityPermissionRequirement,
  CapabilityReadinessState,
  CapabilityRuntimeProbeSignal,
  CapabilitySnapshot,
  CapabilitySnapshotCollection,
  DeriveCapabilityReadinessInput,
  FeatureEnablementState,
  MemoryAcceptanceState,
  DragGrantPermissionId,
  OsPermissionId,
  OsPermissionSnapshot,
  OsPermissionState,
  PermissionSnapshot,
  RuntimeProbeState,
} from './capabilities.js';
export {
  ACTION_APPROVAL_STATES,
  CAPABILITY_CONFIGURATION_STATES,
  CAPABILITY_READINESS_STATES,
  FEATURE_ENABLEMENT_STATES,
  MEMORY_ACCEPTANCE_STATES,
  DRAG_GRANT_PERMISSION_IDS,
  isDragGrantPermissionId,
  OS_PERMISSION_IDS,
  OS_PERMISSION_STATES,
  RUNTIME_PROBE_STATES,
  deriveCapabilityReadiness,
  isCapabilityReadinessState,
  isOsPermissionState,
  runtimeProbeFromBotReadiness,
} from './capabilities.js';

// capability-audit.ts
export type {
  AutomationLastRunStatus,
  AutomationRecord,
  AutomationRecordTrigger,
  CapabilityAuditPermissionMode,
  CapabilityAuditReport,
  CapabilityAuditSkillInput,
  CapabilityAuditSummary,
  DeriveCapabilityAuditReportInput,
  SkillAuditRecord,
  SourceAuthType,
  SourceRecord,
  SourceRecordStatus,
  SourceRecordType,
} from './capability-audit.js';
export {
  AUTOMATION_LAST_RUN_STATUSES,
  AUTOMATION_RECORD_TRIGGERS,
  CAPABILITY_AUDIT_PERMISSION_MODES,
  LOCAL_SKILL_SOURCE_SLUG,
  SOURCE_AUTH_TYPES,
  SOURCE_RECORD_STATUSES,
  SOURCE_RECORD_TYPES,
  deriveCapabilityAuditReport,
} from './capability-audit.js';

// health.ts
export type {
  HealthSignal,
  HealthSignalLayer,
  HealthSignalScope,
  HealthSignalSource,
  HealthSignalStatus,
  HealthSnapshot,
  HealthSnapshotSummary,
} from './health.js';
export {
  HEALTH_SIGNAL_LAYERS,
  HEALTH_SIGNAL_STATUSES,
  buildHealthSnapshot,
  healthSignalFromCapability,
  healthSignalFromConnection,
  healthSignalFromConnectionRuntime,
  isHealthSignalStatus,
} from './health.js';

// search.ts (PR-SEARCH-0 + PR-SEARCH-1.5)
export type {
  SearchError,
  SearchErrorReason,
  SearchNormalizeResult,
  SearchOk,
  SearchProviderKind,
  SearchRequest,
  SearchResult,
  SearchResultTarget,
  SearchSourceKind,
  SearchSourceSnapshot,
  WebFetchRequest,
} from './search.js';
export {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_DOMAIN_MAX_CHARS,
  SEARCH_MAX_LIMIT,
  SEARCH_QUERY_MAX_CHARS,
  SEARCH_URL_MAX_CHARS,
  normalizeSearchDomain,
  normalizeSearchDomainList,
  normalizeSearchLimit,
  normalizeSearchQuery,
  normalizeSearchUrl,
  rewriteSearchQueryForFreshness,
  searchDomainMatches,
  stripSearchTrackingParams,
} from './search.js';

// oauth-subscription.ts (PR-OAUTH-SUBSCRIPTION-0) — closed-state types
// + pure PKCE helpers for Claude subscription OAuth. No token-shaped
// fields exposed; main-process service owns tokens.
export type {
  AuthorizationUrlPayload,
  ClaudeAuthorizationConfig,
  OAuthSubscriptionProvider,
  OAuthSubscriptionRuntimeState,
  PastedAuthorization,
  QuotaSnapshot,
  QuotaWindow,
  Sha256Digest,
  SubscriptionAccountProfile,
  SubscriptionAccountState,
  SubscriptionActionFailureReason,
  SubscriptionActionResult,
} from './oauth-subscription.js';
export {
  PENDING_AUTHORIZATION_TTL_MS,
  PKCE_VERIFIER_LENGTH_BYTES,
  QUOTA_CACHE_TTL_MS,
  TOKEN_REFRESH_SKEW_MS,
  base64urlEncode,
  buildClaudeAuthorizationUrl,
  constantTimeStringEqual,
  parsePastedAuthorization,
  pkceCodeChallenge,
} from './oauth-subscription.js';

// incognito.ts — cross-cutting workspace privacy contract.
export type {
  WorkspacePrivacyContext,
  WorkspacePrivacyContextInvalidReason,
  WorkspacePrivacyContextResult,
} from './incognito.js';
export {
  WORKSPACE_PRIVACY_CONTEXT_INVALID_REASONS,
  defaultWorkspacePrivacyContext,
  isWorkspacePrivacyContext,
  validateWorkspacePrivacyContext,
} from './incognito.js';

// cron-expression.ts — shared five-field cron grammar and occurrence authority.
export type {
  CompiledCronExpression,
  CompileCronExpressionResult,
  CronCompatibilityProfile,
  CronCompileError,
  CronCompileErrorCode,
  CronFieldName,
  CronSearchBounds,
} from './cron-expression.js';
export {
  CRON_COMPATIBILITY_PROFILES,
  compileCronExpression,
  matchesCronField,
} from './cron-expression.js';

// plan-reminders.ts (PR-PLAN-REMINDER-MVP-0)
export type {
  CreatePlanReminderInput,
  PlanReminder,
  PlanReminderBlockReason,
  PlanReminderBotDeliveryTarget,
  PlanReminderCronSchedule,
  PlanReminderDeliveryTarget,
  PlanReminderLocalDeliveryTarget,
  PlanReminderNormalizeResult,
  PlanReminderOnceSchedule,
  PlanReminderRecurrence,
  PlanReminderRecurringFrequency,
  PlanReminderRecurringSchedule,
  PlanReminderRunRecord,
  PlanReminderRunStatus,
  PlanReminderSchedule,
  PlanReminderStatus,
  UpdatePlanReminderInput,
} from './plan-reminders.js';
export {
  PLAN_REMINDER_CRON_EXPRESSION_MAX_CHARS,
  PLAN_REMINDER_DELIVERY_CHAT_ID_MAX_CHARS,
  PLAN_REMINDER_MAX_DELAY_MS,
  PLAN_REMINDER_NOTE_MAX_CHARS,
  PLAN_REMINDER_RECURRENCES,
  PLAN_REMINDER_RUN_STATUSES,
  PLAN_REMINDER_STATUSES,
  PLAN_REMINDER_TITLE_MAX_CHARS,
  createPlanReminderSchedule,
  formatPlanReminderDeliveryMessage,
  formatPlanReminderDeliveryTarget,
  isPlanReminderDue,
  isPlanReminderStatus,
  nextPlanReminderRunAtAfter,
  nextPlanReminderStateAfterTrigger,
  normalizeCreatePlanReminderInput,
  normalizePlanReminderCronExpression,
  normalizePlanReminderDeliveryChatId,
  normalizePlanReminderDeliveryTarget,
  normalizePlanReminderNote,
  normalizePlanReminderRunAt,
  normalizePlanReminderTitle,
  normalizeUpdatePlanReminderInput,
} from './plan-reminders.js';
// foreign-session.ts (#1057) — untrusted Claude Code / Codex session
// contracts + defensive parsing. Subpath @maka/core/foreign-session preferred.
export type {
  ClaudeTitleCandidates,
  ClaudeTranscriptMeta,
  CodexThreadRow,
  DigestAccumulator,
  ForeignSessionDigest,
  ForeignSessionSource,
  ForeignSessionSummary,
} from './foreign-session.js';
export {
  CODEX_SUPPORTED_THREAD_SOURCES,
  FOREIGN_SESSION_HANDOFF_INSTRUCTION,
  buildForeignSessionHandoffMessage,
  foreignSessionHandoffDisplayText,
  foreignSourceLabel,
  FOREIGN_SESSION_DIGEST_MAX_FILES,
  FOREIGN_SESSION_DIGEST_MAX_MESSAGES,
  FOREIGN_SESSION_DIGEST_MAX_READ_BYTES,
  FOREIGN_SESSION_HEAD_BYTES,
  FOREIGN_SESSION_ID_MAX_CHARS,
  FOREIGN_SESSION_MIN_EPOCH_MS,
  FOREIGN_SESSION_SCAN_MAX_AGE_MS,
  FOREIGN_SESSION_SCAN_MAX_SESSIONS,
  FOREIGN_SESSION_SOURCES,
  FOREIGN_SESSION_TITLE_WINDOW_BYTES,
  claudeAssistantText,
  claudeFirstPromptCandidate,
  claudeToolFilePaths,
  claudeUserAuthoredText,
  claudeUserMessageText,
  codexRolloutMessage,
  codexRolloutSessionMeta,
  codexSourceToken,
  collectClaudeMeta,
  collectClaudeTitle,
  createDigestAccumulator,
  finishDigest,
  isSafeForeignId,
  isSyntheticClaudeUserText,
  normalizeCodexThreadRow,
  parseForeignJsonLine,
  pickClaudeTitle,
  pushDigestFile,
  pushDigestMessage,
  renderForeignSessionDigestForPrompt,
  sanitizeForeignMessage,
  sanitizeForeignText,
  sanitizeForeignTitle,
  stripEnvelopeTags,
} from './foreign-session.js';

// text-sanitize.ts (#1404)
export type { SanitizeUnicodeOptions } from './text-sanitize.js';
export { sanitizeUnicodeText } from './text-sanitize.js';

// task-ledger.ts (main agent session task tracking)
export type {
  CreateTaskInput,
  ResumeTrust,
  Task,
  TaskAgentOutcome,
  TaskAvailableClaimScope,
  TaskLedgerChangedEvent,
  TaskLedgerEvent,
  TaskLedgerEventTaskSnapshot,
  TaskLedgerEventRefs,
  TaskLedgerEventType,
  TaskLedgerListOptions,
  TaskLedgerMutationContext,
  TaskLedgerNormalizeResult,
  TaskLedgerProjection,
  TaskLedgerPromptRender,
  TaskLedgerStore,
  TaskOwner,
  TaskStatus,
  UpdateTaskInput,
} from './task-ledger.js';
export {
  TASK_EVIDENCE_MAX_CHARS,
  TASK_ARCHIVE_AFTER_MS,
  TASK_ID_MAX_CHARS,
  TASK_KEY_MAX_CHARS,
  TASK_LEDGER_EVENT_TYPES,
  TASK_LEDGER_MAX_TASKS,
  TASK_LEDGER_PROMPT_MAX_CHARS,
  TASK_LEDGER_PROMPT_RECENT_TERMINAL,
  TASK_RESUME_TRUST_LEVELS,
  TASK_STATUSES,
  TASK_TERMINAL_STATUSES,
  TASK_SUBJECT_MAX_CHARS,
  canTransitionTaskStatus,
  classifyTaskResumeTrust,
  filterModelVisibleTaskLedgerTasks,
  findTaskByRef,
  compareTaskKeys,
  isSafeTaskId,
  isResumeTrust,
  isTaskStatus,
  isTaskKey,
  isTerminalTaskStatus,
  normalizeCreateTaskInput,
  normalizeResumeTrust,
  normalizeTaskEvidenceText,
  normalizeTaskStatus,
  normalizeTaskSubject,
  normalizeUpdateTaskInput,
  projectTaskLedgerEvents,
  renderTaskLedgerDebugText,
  renderSafeTaskLedgerText,
  renderTaskLedgerPromptText,
  sanitizeTaskLedgerTask,
  taskLedgerEventTypeForCreate,
  taskLedgerEventTypeForUpdate,
  validateTaskEvidence,
  validateTaskUpdate,
} from './task-ledger.js';

// deep-research-run.ts — durable FS-Researcher-inspired workspace contract.
export type {
  DeepResearchActiveStage,
  DeepResearchArtifactRef,
  DeepResearchArtifactRole,
  DeepResearchChecklistItem,
  DeepResearchChecklistStatus,
  DeepResearchClientProgress,
  DeepResearchChangedEvent,
  DeepResearchCheckpoint,
  DeepResearchEvent,
  DeepResearchEventRefs,
  DeepResearchEventType,
  DeepResearchHandoff,
  DeepResearchInspectedRef,
  DeepResearchInspectedRefKind,
  DeepResearchMutationContext,
  DeepResearchProjection,
  DeepResearchReportSectionKey,
  DeepResearchReportSectionState,
  DeepResearchReportSectionStatus,
  DeepResearchRun,
  DeepResearchRunStatus,
  DeepResearchScopeLevel,
  DeepResearchStage,
  DeepResearchStep,
  DeepResearchStepKind,
  DeepResearchStepStatus,
  DeepResearchStore,
} from './deep-research-run.js';
export {
  DEEP_RESEARCH_ACTIVE_STAGES,
  DEEP_RESEARCH_ARTIFACT_NAME_MAX_CHARS,
  DEEP_RESEARCH_ARTIFACT_ROLES,
  DEEP_RESEARCH_ARTIFACTS_MAX,
  DEEP_RESEARCH_CHECKPOINT_ITEM_MAX_CHARS,
  DEEP_RESEARCH_CHECKPOINT_ITEMS_MAX,
  DEEP_RESEARCH_CHECKPOINT_TEXT_MAX_CHARS,
  DEEP_RESEARCH_CHECKPOINTS_MAX,
  DEEP_RESEARCH_CHECKLIST_ITEMS_MAX,
  DEEP_RESEARCH_CHECKLIST_STATUSES,
  DEEP_RESEARCH_CLIENT_IMPLEMENTATION_PROMPT_MAX_BYTES,
  DEEP_RESEARCH_CLIENT_OBJECTIVE_MAX_BYTES,
  DEEP_RESEARCH_CLIENT_PROGRESS_MAX_BYTES,
  DEEP_RESEARCH_CLIENT_RECENT_ITEMS_MAX,
  DEEP_RESEARCH_CLIENT_TEXT_MAX_BYTES,
  DEEP_RESEARCH_DEFAULT_CHECKLIST,
  DEEP_RESEARCH_EVENT_TYPES,
  DEEP_RESEARCH_INSPECTED_REFS_MAX,
  DEEP_RESEARCH_INSPECTED_REF_KINDS,
  DEEP_RESEARCH_LOCATOR_MAX_CHARS,
  DEEP_RESEARCH_OBJECTIVE_MAX_CHARS,
  DEEP_RESEARCH_REFS_MAX,
  DEEP_RESEARCH_REPORT_SECTION_KEYS,
  DEEP_RESEARCH_REPORT_SECTION_STATUSES,
  DEEP_RESEARCH_RUN_SCHEMA_VERSION,
  DEEP_RESEARCH_RUN_STATUSES,
  DEEP_RESEARCH_SCOPE_LEVELS,
  DEEP_RESEARCH_STAGES,
  DEEP_RESEARCH_STEPS_MAX,
  DEEP_RESEARCH_STEP_KINDS,
  DEEP_RESEARCH_STEP_LIST_ITEMS_MAX,
  DEEP_RESEARCH_STEP_STATUSES,
  DEEP_RESEARCH_STEP_TEXT_MAX_CHARS,
  isDeepResearchActiveStage,
  isDeepResearchArtifactRole,
  isDeepResearchChecklistStatus,
  isDeepResearchEvent,
  isDeepResearchReportSectionKey,
  isDeepResearchReportSectionStatus,
  isDeepResearchScopeLevel,
  isDeepResearchStepKind,
  isDeepResearchStepStatus,
  normalizeDeepResearchObjective,
  projectDeepResearchEvents,
} from './deep-research-run.js';
export { projectDeepResearchClientProgress } from './deep-research-client-progress.js';

// memory.ts (PR-MEMORY-1) — core contract; no IPC/storage/embedding/UI.
export type {
  DraftMemoryEntry,
  DurableMemoryEntry,
  MemoryBlockReason,
  MemoryCandidateSource,
  MemoryCapabilitySnapshot,
  MemoryEntry,
  MemoryMode,
  MemoryPersistenceState,
  MemoryResult,
  MemoryScope,
  MemorySource,
  MemorySourceResolution,
  MemoryUsePolicy,
  MemoryWriteRequest,
  MemoryWriteRequestContext,
} from './memory.js';
export {
  MEMORY_BLOCK_REASONS,
  MEMORY_CANDIDATE_SOURCES,
  MEMORY_CONTENT_MAX_CODE_POINTS,
  MEMORY_MODES,
  MEMORY_PERSISTENCE_STATES,
  MEMORY_SCOPES,
  MEMORY_SOURCES,
  MEMORY_USE_POLICIES,
  isMemoryCandidateSource,
  isMemoryMode,
  isMemoryPersistenceState,
  isMemoryScope,
  isMemorySource,
  isMemoryUsePolicy,
  normalizeMemoryContent,
  normalizeMemoryMode,
  normalizeMemoryPersistenceState,
  normalizeMemoryScope,
  normalizeMemorySource,
  validateMemoryWriteRequest,
} from './memory.js';

// long-term-memory.ts — atomic SQLite-backed memory contracts; no storage/runtime/UI.
export * from './long-term-memory.js';

// local-memory.ts — transparent user-visible MEMORY.md MVP.
export type {
  LocalMemoryEntryStatus,
  LocalMemoryEntryPreview,
  LocalMemoryEntryDraft,
  LocalMemoryEntryDraftRange,
  LocalMemoryBackupInfo,
  LocalMemoryOrigin,
  LocalMemoryParseResult,
  LocalMemoryPromptContext,
  LocalMemorySettings,
  LocalMemoryScope,
  LocalMemorySource,
  LocalMemoryState,
  AppendManualLocalMemoryEntryInput,
  AppendManualLocalMemoryEntryResult,
  AppendApprovedLocalMemoryEntryInput,
  AppendApprovedLocalMemoryEntryResult,
  AppendLocalMemoryProposalInput,
  AppendLocalMemoryProposalResult,
  ApproveLocalMemoryProposalInput,
  ApproveLocalMemoryProposalResult,
  RejectLocalMemoryProposalInput,
  RejectLocalMemoryProposalResult,
  SetLocalMemoryEntryStatusInput,
  SetLocalMemoryEntryStatusResult,
} from './local-memory.js';
export {
  LOCAL_MEMORY_MAX_BYTES,
  LOCAL_MEMORY_PROMPT_MAX_CHARS,
  LOCAL_MEMORY_PROMPT_TRUNCATION_MARKER,
  appendApprovedLocalMemoryEntryDraft,
  appendLocalMemoryProposalDraft,
  appendManualLocalMemoryEntryDraft,
  approveLocalMemoryProposalDraft,
  buildLocalMemoryPromptBody,
  defaultLocalMemoryMarkdown,
  defaultLocalMemorySettings,
  findLocalMemoryEntryDraft,
  findLocalMemoryEntryDraftRange,
  normalizeLocalMemorySettings,
  parseLocalMemoryMarkdown,
  rejectLocalMemoryProposalDraft,
  setLocalMemoryEntryStatusDraft,
  stableLocalMemoryEntryId,
  stableLocalMemoryProposalId,
} from './local-memory.js';

// voice.ts (PR-VOICE-0) — core contract; no IPC/storage/provider/runtime/UI.
export type {
  VoiceCapabilitySnapshot,
  VoiceCaptureCaps,
  VoiceCaptureRequest,
  VoiceInputMode,
  VoiceNormalizeResult,
  VoicePermissionStatus,
  VoicePrivacyFlags,
  VoiceReadinessReason,
  VoiceSttProvider,
  VoiceTranscriptPersistence,
  VoiceTranscriptRequest,
  VoiceTranscriptResult,
  VoiceTranscriptSource,
  VoiceTtsPolicy,
  VoiceTtsProvider,
  VoiceTtsRequest,
  VoiceIntent,
  VoiceAudioFormat,
  EphemeralVoiceAudio,
  VoiceModelRouteCapability,
  VoiceRecognitionConfig,
  VoiceRealtimeConfig,
  VoiceSettings,
  VoiceRoutePlan,
  ResolveVoiceRouteInput,
  VoiceBeginRequest,
  VoiceBeginResult,
  VoiceCapturedAudio,
  VoiceFinishCaptureResult,
  VoiceRealtimeClientSession,
  VoiceCoordinatorToolName,
  VoiceCoordinatorToolCall,
} from './voice.js';
export {
  VOICE_MAX_AUDIO_BYTES,
  VOICE_MAX_CAPTURE_DURATION_MS,
  VOICE_MAX_CHANNELS,
  VOICE_MAX_SAMPLE_RATE,
  VOICE_MAX_TRANSCRIPT_CHARS,
  VOICE_TTS_MAX_TEXT_CHARS,
  VOICE_INPUT_MARKER,
  defaultVoiceCapabilitySnapshot,
  defaultVoiceCaptureCaps,
  defaultVoicePrivacyFlags,
  defaultVoiceSettings,
  normalizeVoiceSettings,
  resolveVoiceRoute,
  normalizeVoiceCoordinatorToolCall,
  normalizeVoiceInputMode,
  normalizeVoiceTranscriptText,
  normalizeVoiceTtsPolicy,
  validateVoiceCaptureRequest,
  validateVoiceTranscriptResult,
  validateVoiceTtsRequest,
} from './voice.js';

// backend-types.ts
export type {
  BackendSendInput,
  RuntimeContinuationMetadata,
  AgentBackend,
  BackendCompactHistoryInput,
  BackendCompactHistoryResult,
} from './backend-types.js';

// llm-connections.ts
export type {
  ConnectionAuth,
  ConnectionLastTestStatus,
  ConnectionTestResult,
  ConnectionTestErrorClass,
  CreateConnectionInput,
  LlmConnection,
  ModelDiscoveryResult,
  ModelDiscoverySource,
  ModelInfo,
  ProviderCategory,
  ProviderCatalogGroup,
  ProviderDefaults,
  ProviderRuntimeAdapter,
  ProviderType,
  RuntimeExecutionConnection,
  UpdateConnectionInput,
} from './llm-connections.js';
export {
  CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS,
  PROVIDER_REGISTRY,
  PROVIDER_DEFAULTS,
  CATALOG_PROVIDER_TYPES,
  RECOMMENDED_PROVIDER_TYPES,
  READY_PROVIDER_TYPES,
  backendKindOf,
  connectionEnabledModelIds,
  deriveConnectionSlug,
  isWiredOAuthProvider,
  reconcileConnectionAfterEnabledModelsChange,
  reconcileConnectionAfterModelFetch,
  effectiveBaseUrl,
  migrateConnectionV1ToV2,
  normalizeConnectionBaseUrl,
  normalizeProviderType,
  persistedBaseUrl,
  providerSupportsModelDiscovery,
  validateConnectionBaseUrl,
  validateSlug,
} from './llm-connections.js';

// provider-contract-matrix.ts — registry-driven conformance matrix plan.
export type {
  ProviderContractCell,
  ProviderContractCellEntry,
  ProviderContractCellState,
  ProviderContractDimension,
  ProviderContractDiscoveryPlan,
  ProviderContractEdgeWireSample,
  ProviderContractGeneratedCell,
  ProviderContractMatrixPlan,
  ProviderContractNotApplicableCell,
  ProviderContractOverrideCell,
  ProviderContractReasoningReplayPlan,
  ProviderContractReverseAssertion,
  ProviderContractRow,
  ProviderContractWire,
} from './provider-contract-matrix.js';
export {
  PROVIDER_CONTRACT_DIMENSIONS,
  PROVIDER_CONTRACT_MATRIX_PLAN,
  SUBSCRIPTION_WIRE_ADAPTER_KINDS,
  buildProviderContractMatrixPlan,
  buildProviderContractRow,
  listProviderContractCells,
} from './provider-contract-matrix.js';

// connection-readiness.ts (PR110a)
export type {
  ChatConfigurationReason,
  IsConnectionReadyInput,
  IsConnectionReadyResult,
} from './connection-readiness.js';
export {
  isConnectionReady,
  isRealConnection,
  normalizeOpenAiCodexConnection,
  normalizeRequestedModelForReadiness,
} from './connection-readiness.js';

// session-send-projection.ts (#1038) — single "will the next send
// succeed / rebind / fail" decision shared by the desktop send gate and
// the renderer session health notice.
export type {
  SessionSendProjection,
  SessionSendProjectionInput,
  SessionSendProjectionSession,
} from './session-send-projection.js';
export {
  projectSessionSendOutcome,
  sessionOwnConnectionBlockReason,
  shouldRebindSessionToDefault,
} from './session-send-projection.js';

// connection-error-copy.ts — shared not-ready-connection fix copy
export {
  describeChatConfigurationReason,
  parseNoRealConnectionError,
} from './connection-error-copy.js';
export type { ParsedNoRealConnectionError } from './connection-error-copy.js';

// session-name.ts (PR-UI-IPC-2)
export type { NormalizeSessionNameResult } from './session-name.js';
export {
  DEFAULT_SESSION_NAME,
  SESSION_NAME_MAX_CODE_POINTS,
  normalizeUserSessionName,
} from './session-name.js';

// provider-auth.ts (PR-AUTH-0)
export type {
  ProviderAuthAction,
  ProviderAuthActionAvailability,
  ProviderAuthContract,
  ProviderAuthContractInput,
  ProviderAuthSetupMode,
  ProviderAuthState,
} from './provider-auth.js';
export {
  PROVIDER_AUTH_ACTIONS,
  PROVIDER_AUTH_SETUP_MODES,
  PROVIDER_AUTH_STATES,
  deriveProviderAuthContract,
  deriveProviderAuthContractFromConnection,
  isProviderAuthState,
} from './provider-auth.js';

// onboarding.ts (PR110a)
export type {
  DeriveOnboardingStateInput,
  OnboardingMilestone,
  OnboardingMilestoneId,
  OnboardingState,
} from './onboarding.js';
export {
  ONBOARDING_MILESTONE_IDS,
  deriveOnboardingState,
  hasSettledInitialOnboarding,
  isOnboardingMilestone,
  sanitizeOnboardingMilestones,
} from './onboarding.js';

// bootstrap-connections.ts
export type {
  BootstrapConnectionSeed,
  BootstrapEnv,
} from './bootstrap-connections.js';
export {
  OPENCODE_FREE_BOOTSTRAP_VERSION,
  OPENCODE_FREE_DEFAULT_MODEL,
  OPENCODE_FREE_LEGACY_DEFAULT_MODEL,
  resolveBootstrapConnections,
  resolveOpenCodeFreeBootstrapMigration,
} from './bootstrap-connections.js';

// model-catalog.ts
export type {
  BuildModelCatalogInput,
  BuildConnectionModelCatalogInput,
  KnownModelCapabilities,
  ModelCapabilitySource,
  ModelCatalogAvailability,
  ModelCatalogEntry,
  ModelCatalogLifecycle,
  ModelCatalogPricing,
  ModelCatalogProvenanceSources,
  ModelCatalogUserChoiceSource,
  ModelUnavailableReason,
  SavedModelChoice,
} from './model-catalog.js';
export {
  buildConnectionModelCatalogEntries,
  buildModelCatalogEntries,
  isModelExplicitlyUnsupportedForChat,
  validateChatDefaultModel,
} from './model-catalog.js';

// model-metadata.ts
export {
  modelMetadataIdsForProvider,
  resolveModelVisionSupport,
  resolveModelVoiceMetadata,
} from './model-metadata.js';
export type {
  HostedWebSearchAdapter,
  HostedWebSearchCapability,
} from './model-web-search.js';
export { resolveHostedWebSearchCapability } from './model-web-search.js';

// settings.ts
export type {
  AppearanceSettings,
  AppNetworkSettings,
  AppSettings,
  ChatDefaultPermissionMode,
  ChatDefaultsSettings,
  NetworkProxySettings,
  NetworkSettings,
  NotificationSettings,
  PrivacySettings,
  ProxyProtocol,
  SettingsSection,
  SettingsTestResult,
  SettingsTestResultCode,
  PersonalizationSettings,
  PersonalizationSettingsWarning,
  ThemePalette,
  ThemePreference,
  UpdateAppSettingsInput,
  UpdateAppSettingsResult,
  UpdateAppSettingsWarnings,
  UsageRange,
  UsageRequestLog,
  UsageSettings,
  UsageStats,
  UsageStatus,
  UsageSummary,
  UsageTab,
} from './settings.js';

export type {
  SubagentPreset,
  SubagentProfile,
  SubagentSettings,
} from './subagent-settings.js';
export {
  MAX_SUBAGENT_PRESETS,
  SUBAGENT_PRESET_DESCRIPTION_MAX_CHARS,
  SUBAGENT_PRESET_ID_MAX_CHARS,
  SUBAGENT_PRESET_NAME_MAX_CHARS,
  SUBAGENT_PROFILES,
  isSafeSubagentPresetId,
  isSubagentProfile,
  normalizeSubagentSettings,
} from './subagent-settings.js';
export {
  CHAT_DEFAULT_PERMISSION_MODES,
  DEFAULT_PROXY_BYPASS_DOMAINS,
  SETTINGS_SECTIONS,
  THEME_PALETTES,
  createDefaultSettings,
  isChatDefaultPermissionMode,
  isThemePalette,
  mergeSettings,
  normalizeSettings,
} from './settings.js';

// bot-chat-settings.ts
export type {
  BotChannelSettings,
  BotChatSettings,
  BotDeliveryProvider,
  BotProvider,
  BotReadinessState,
} from './bot-chat-settings.js';
export {
  BOT_DELIVERY_PROVIDERS,
  BOT_PROVIDERS,
  BOT_READINESS_STATES,
  MAX_ALLOWED_USER_IDS,
  createDefaultBotChannel,
  hasBotChannelCredentials,
  isBotDeliveryProvider,
  isBotReadinessState,
  normalizeAllowedUserIds,
  parseAllowedUserIdsFromText,
} from './bot-chat-settings.js';

// bot-onboarding.ts
export {
  BOT_ONBOARDING_PROVIDERS,
  BOT_ONBOARDING_STATES,
  isBotOnboardingBrand,
  isBotOnboardingProvider,
} from './bot-onboarding.js';
export type {
  BotOnboardingBrand,
  BotOnboardingProvider,
  BotOnboardingSnapshot,
  BotOnboardingStartInput,
  BotOnboardingState,
} from './bot-onboarding.js';

// ui-locale.ts
export type { UiCatalog, UiLocale, UiLocalePreference } from './ui-locale.js';
export {
  UI_LOCALES,
  UI_LOCALE_PREFERENCES,
  isUiLocale,
  isUiLocalePreference,
  resolveSystemUiLocale,
  resolveUiLocale,
  uiLocaleToIntlLocale,
} from './ui-locale.js';

// bot-platform-hints.ts
export type {
  BotFormattingProfile,
  BotPlatformPromptHint,
} from './bot-platform-hints.js';
export {
  botPlatformFromSessionLabels,
  buildBotPlatformPromptFragment,
  getBotPlatformPromptHint,
} from './bot-platform-hints.js';

// bot-events.ts
export type {
  BotAttachmentKind,
  BotAttachmentRef,
  BotMessageEvent,
  BotPlatform,
} from './bot-events.js';
export {
  BOT_PLAINTEXT_HELP_COMMANDS,
  BOT_PLAINTEXT_RESET_COMMANDS,
  botConversationKey,
  botDisplayLabel,
  botSourceEventKey,
  formatBotMessageForSession,
  humanizeBotStatusReason,
  isPlaintextHelpCommand,
  isPlaintextResetCommand,
  nonTextMessageAck,
  plaintextHelpReply,
} from './bot-events.js';

// redaction.ts
export {
  generalizedErrorMessage,
  generalizedErrorMessageChinese,
  isAuthenticationErrorText,
  redactSecrets,
} from './redaction.js';

// usage-stats/types.ts
export type {
  LlmCallRecord,
  ContextBudgetDiagnostic,
  PricingConfig,
  PromptSegmentEstimate,
  PromptSegmentKind,
  TimeRange,
  ToolInvocationRecord,
  ToolInvocationResultSummary,
  UsageBucket,
  UsageGroupBy,
  UsageLogRow,
  UsageQuery,
  UsageSummaryV2,
} from './usage-stats/types.js';

export {
  formatCompactTimestamp,
  formatRelativeTimestamp,
  nextRelativeRefreshDelay,
  resetRelativeTimeFormatters,
} from './relative-time.js';

// text-file-import.ts — pure prompt-context limits shared by main and renderer.
export type {
  DroppedTextFilePreflightInput,
  TextFileImportPreflightFailureReason,
  TextFileImportPreflightResult,
} from './text-file-import.js';
export {
  MAX_IMPORTED_FOLDER_COUNT,
  MAX_IMPORTED_FOLDER_DEPTH,
  MAX_IMPORTED_FOLDER_ENTRIES,
  MAX_IMPORTED_FOLDERS_ENTRIES,
  MAX_IMPORTED_TEXT_FILE_BYTES,
  MAX_IMPORTED_TEXT_FILE_CHARS,
  MAX_IMPORTED_TEXT_FILE_COUNT,
  MAX_IMPORTED_TEXT_FILE_SAMPLE_BYTES,
  MAX_IMPORTED_TEXT_FILES_CHARS,
  isDroppedTextFileImportCompatible,
  preflightDroppedTextFilesForPromptImport,
} from './text-file-import.js';

// daily-review.ts (PR-DAILY-REVIEW-MVP-0 + PR-DAILY-REVIEW-FULL-0)
export type {
  DailyReviewArchive,
  DailyReviewArchiveSectionContent,
  DailyReviewArchiveStatus,
  DailyReviewArchiveSummary,
  DailyReviewConfig,
  DailyReviewRange,
  ParsedDailyReviewArchiveId,
  DailyReviewSectionKey,
  DailyReviewSessionRow,
  DailyReviewSummary,
  DailyReviewTopEntry,
  DailyReviewTotals,
  DailyReviewTrigger,
  DayRangeMs,
} from './daily-review.js';
export {
  DAILY_REVIEW_ARCHIVE_STATUSES,
  DAILY_REVIEW_LIST_LIMIT,
  DAILY_REVIEW_RANGES,
  DAILY_REVIEW_SECTION_KEYS,
  DEFAULT_DAILY_REVIEW_CONFIG,
  buildDailyReviewSummary,
  dailyReviewArchiveId,
  dailyReviewArchiveToSummary,
  dailyUsageQuery,
  isDailyReviewExecuteTime,
  localDayBoundsAt,
  localDayBoundsForInstant,
  normalizeDailyReviewConfig,
  normalizeDailyReviewArchive,
  parseDailyReviewArchiveId,
  pickDailyReviewSessions,
  pickDailyReviewTopEntries,
} from './daily-review.js';

// web-search.ts (PR-WEB-SEARCH-TAVILY-0) — explicit user-triggered
// web search contract. Renderer never sees the API key.
export type {
  WebSearchErrorReason,
  WebSearchCredentialStatus,
  WebSearchCredentialSource,
  WebSearchCredentialProvider,
  WebSearchProvider,
  WebSearchProviderSettings,
  WebSearchResponse,
  WebSearchResultRow,
  WebSearchSettings,
} from './web-search.js';
export {
  MASKED_TOKEN_SENTINEL,
  WEB_SEARCH_DEFAULT_LIMIT,
  WEB_SEARCH_CREDENTIAL_STATUSES,
  WEB_SEARCH_CREDENTIAL_SOURCES,
  WEB_SEARCH_CREDENTIAL_PROVIDERS,
  WEB_SEARCH_MAX_LIMIT,
  WEB_SEARCH_PROVIDERS,
  WEB_SEARCH_QUERY_MAX_CHARS,
  defaultWebSearchSettings,
  isWebSearchCredentialStatus,
  isWebSearchCredentialSource,
  isWebSearchProvider,
  maskedTokenForDisplay,
  normalizeWebSearchLimit,
  normalizeWebSearchQuery,
  reconcileMaskedToken,
  webSearchCredentialStatusFromResponse,
  webSearchCredentialSourceFromStoredKey,
} from './web-search.js';

// explore-agent.ts — read-only deep research session profile.
export type {
  SessionStartMode,
  SessionStartModeSpec,
} from './explore-agent.js';
export {
  SESSION_START_MODES,
  SESSION_START_MODE_LABELS,
  SESSION_START_MODE_SPECS,
  DEEP_RESEARCH_EVIDENCE_CHECKLIST,
  DEEP_RESEARCH_IMPLEMENTATION_PROMPT_MAX_CHARS,
  DEEP_RESEARCH_PROGRESS_CHECKPOINTS,
  DEEP_RESEARCH_SESSION_LABEL,
  DEEP_RESEARCH_SESSION_NAME,
  DEEP_RESEARCH_REPORT_SECTIONS,
  DEEP_RESEARCH_SCOPE_OPTIONS,
  DEEP_RESEARCH_STARTER_PROMPTS,
  DEEP_RESEARCH_WORKFLOW_STEPS,
  buildDeepResearchSystemPromptFragment,
  buildDeepResearchImplementationPrompt,
  sessionStartModeSpec,
  isSessionStartMode,
  isSessionStartModeLabel,
  isDeepResearchSession,
} from './explore-agent.js';

// tool-catalog.ts — shared product tool vocabulary (#1099).
export type {
  CatalogSurfaceDef,
  CatalogToolDef,
  ToolEffect,
  ToolHostId,
  ToolHostSupport,
} from './tool-catalog.js';
export {
  MAKA_CATALOG_SURFACES,
  MAKA_CATALOG_TOOLS,
  TOOL_HOST_IDS,
  catalogSurfaceById,
  catalogToolByName,
  catalogToolNameSet,
  unknownBoundToolNames,
} from './tool-catalog.js';

// attachments.ts
export {
  ATTACHMENT_RESOURCE_PREFIX,
  attachmentKindFromMimeType,
  formatAttachmentResourceRef,
  guessMimeFromName,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  MAX_READ_IMAGE_BYTES,
  MAX_MODEL_IMAGE_EDGE,
  READ_IMAGE_TOO_LARGE_MESSAGE,
  MAX_PROVIDER_IMAGE_REQUEST_BYTES,
  parseAttachmentResourceRef,
  PROVIDER_IMAGE_BUDGET_EXCEEDED_MESSAGE,
} from './attachments.js';
export type { AttachmentByteReader } from './attachments.js';

export type {
  AutomationAuthoritySnapshot,
  AutomationDefinition,
  AutomationExecutionTemplate,
  AutomationKind,
  AutomationPendingFire,
  AutomationSchedule,
  AutomationStatus,
} from './automation.js';
export { SKILL_INVOCATION_TOKEN_SOURCE } from './skill-invocation-token.js';
