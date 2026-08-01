/**
 * @maka/runtime public exports.
 *
 * Keep supported cross-package integration on this barrel. See the
 * package README and root ARCHITECTURE.md for responsibility boundaries.
 */

export {
  SessionManager,
  BackendRegistry,
  SessionConfigurationRevisionConflictError,
  SessionConfigurationTransitionError,
  headerToSummary,
  changesBackendConfig,
} from './session-manager.js';
export type { ModelMessage, JSONValue } from './model-protocol.js';
export type {
  CompactSessionInput,
  PlanSafeBoundaryContinuationInput,
  SessionManagerDeps,
  RuntimeContinuationLifecycleEvent,
  SessionConfigurationStoreUpdate,
  SessionConfigurationTransitionRequest,
  SessionConfigurationTransitionErrorCode,
  SessionStore,
  StrictRecoveryAgentRunStore,
  StrictRecoverySessionStore,
  StrictRecoveryStores,
  BackendFactory,
  BackendFactoryContext,
  ClaimedAgentGraphIntentResult,
  PrepareChildAgentResumeResult,
  ResumeChildAgentInput,
  RunClaimedAgentGraphIntentInput,
  SpawnChildAgentInput,
  SpawnChildAgentResult,
  SpawnChildSessionInput,
  SpawnChildSessionResult,
  RetryChildAgentInput,
  AgentListItem,
  AgentListResult,
  SubagentExecutionListItem,
  AgentOutputCommittedResult,
  AgentOutputInput,
  AgentOutputResult,
  StopSessionInput,
} from './session-manager.js';
export {
  archivedToolResultContainsConversationOwnedReferences,
  cloneConversationRuntimeLedger,
  createConversationCopySlice,
  prepareConversationRuntimeLedgerCopy,
} from './conversation-copy.js';
export type {
  CloneConversationRuntimeLedgerInput,
  CloneConversationRuntimeLedgerResult,
  ConversationCopyArtifactReferenceMap,
  ConversationCopySlice,
  ConversationRuntimeLedgerCopyPlan,
} from './conversation-copy.js';
export type { SubagentExecutionRef } from './subagent-execution.js';
export {
  AGENT_GRAPH_RECORD_FACETS,
  AGENT_GRAPH_RECORD_SCHEMA_VERSION,
  projectAgentGraphRecords,
  readCommittedAgentGraphProjection,
  replayAgentGraphRecords,
} from './stream-graph-projection.js';
export type {
  AgentGraphActivationState,
  AgentGraphActivationStatus,
  AgentGraphOperatorBinding,
  AgentGraphOperatorState,
  AgentGraphProjection,
  AgentGraphRecord,
  AgentGraphRecordFacet,
  AgentGraphRecordOrderKey,
  AgentGraphReplayState,
  AgentGraphRunStream,
  AgentGraphRuntimeEventSource,
  AgentGraphSupervisorAttentionReason,
  AgentGraphSupervisorMetaRecord,
  AgentGraphSupervisorSignal,
  ProjectAgentGraphRecordsInput,
  ReadCommittedAgentGraphProjectionInput,
} from './stream-graph-projection.js';
export {
  AGENT_GRAPH_TIMELINE_DEFAULT_PAGE_SIZE,
  AGENT_GRAPH_TIMELINE_MAX_PAGE_SIZE,
  AGENT_GRAPH_TIMELINE_SCHEMA_VERSION,
  buildAgentGraphTimeline,
  buildAgentGraphTimelineCurrentState,
  decodeAgentGraphTimelineCursor,
  encodeAgentGraphTimelineCursor,
  paginateAgentGraphTimeline,
  readAgentGraphTimelinePage,
} from './agent-graph-timeline.js';
export type {
  AgentGraphTimelineCoverageLimitation,
  AgentGraphTimelineCurrentAdmission,
  AgentGraphTimelineCurrentState,
  AgentGraphTimelineCurrentSupervisorWake,
  AgentGraphTimelineEvent,
  AgentGraphTimelinePage,
  AgentGraphTimelinePageOptions,
  AgentGraphTimelineRunRef,
  BuildAgentGraphTimelineInput,
  ReadAgentGraphTimelinePageInput,
} from './agent-graph-timeline.js';
export {
  AGENT_GRAPH_TRACE_SCHEMA_VERSION,
  buildAgentGraphTraceSnapshot,
} from './stream-graph-trace.js';
export type {
  AgentGraphTraceEdge,
  AgentGraphTraceEdgeState,
  AgentGraphTraceOperatorState,
  AgentGraphTraceRoute,
  AgentGraphTraceSnapshot,
  AgentGraphTraceTopology,
  BuildAgentGraphTraceSnapshotInput,
} from './stream-graph-trace.js';
export {
  AGENT_GRAPH_READINESS_SCHEMA_VERSION,
  buildAgentGraphReadinessSnapshot,
} from './stream-graph-readiness.js';
export { claimAgentGraphRunnableIntent } from './stream-graph-admission.js';
export type { ClaimAgentGraphRunnableIntentInput } from './stream-graph-admission.js';
export { runAgentGraphToQuiescence } from './stream-graph-dispatch.js';
export type {
  AgentGraphDispatchFailure,
  AgentGraphDispatchedActivation,
  AgentGraphIntentExecutor,
  AgentGraphQuiescenceResult,
  AgentGraphSupervisorActivationReady,
  AgentGraphSupervisorObservation,
  AgentGraphSupervisorObserver,
  AgentGraphSupervisorRuntimeEvent,
  RenderAgentGraphIntentPromptInput,
  ResolveAgentGraphPoliciesInput,
  RunAgentGraphToQuiescenceInput,
} from './stream-graph-dispatch.js';
export { reconcileAgentGraphSchedule } from './stream-graph-schedule-reconcile.js';
export type {
  AgentGraphScheduleDeferredWork,
  AgentGraphScheduleReconciliationFailure,
  AgentGraphScheduleReconciliationResult,
  AgentGraphScheduleStopController,
  AgentGraphScheduleStopResult,
  ReconcileAgentGraphScheduleInput,
  RenderAgentGraphScheduledWorkPromptInput,
} from './stream-graph-schedule-reconcile.js';
export {
  AgentGraphSupervisorContextOverflowError,
  AgentGraphSupervisorWakeCoordinator,
} from './agent-graph-supervisor-wake.js';
export type {
  AgentGraphSupervisorContextRecoveryDiagnostic,
  AgentGraphSupervisorPartialResult,
  AgentGraphSupervisorWakeDiagnostic,
  AgentGraphSupervisorWakeInput,
} from './agent-graph-supervisor-wake.js';
export {
  AGENT_GRAPH_SUPERVISOR_TOOL_NAMES,
  UPDATE_AGENT_GRAPH_TOOL_NAME,
  VIEW_AGENT_GRAPH_TOOL_NAME,
  buildAgentGraphSupervisorTools,
  compileAgentGraphScheduleUpdate,
  projectAgentGraphSchedule,
} from './stream-graph-supervisor-tools.js';
export type {
  AgentGraphScheduleFinishView,
  AgentGraphScheduleProjection,
  AgentGraphScheduleWorkView,
  AgentGraphStoppedTargetView,
  AgentGraphToolActivityView,
  AgentGraphToolReadinessView,
  AgentGraphToolRuntimeOperatorView,
  AgentGraphToolRuntimeView,
  AgentGraphToolScheduleView,
  BuildAgentGraphSupervisorToolsInput,
  UpdateAgentGraphToolInput,
  UpdateAgentGraphToolResult,
  ViewAgentGraphToolInput,
  ViewAgentGraphToolResult,
} from './stream-graph-supervisor-tools.js';
export {
  AGENT_GRAPH_CLIENT_TERMINAL_PAGE_SIZE,
  AGENT_GRAPH_CLIENT_SNAPSHOT_SCHEMA_VERSION,
  advanceMaterializedAgentGraphClientProjection,
  buildAgentGraphClientSnapshot,
  decodeAgentGraphTerminalCursor,
  decodeMaterializedAgentGraphClientActivity,
  decodeMaterializedAgentGraphClientSnapshot,
  decodeMaterializedAgentGraphOperatorInspection,
  encodeAgentGraphTerminalCursor,
  inspectAgentGraphOperator,
  materializeAgentGraphClientProjection,
  materializedAgentGraphTerminalHistoryPage,
} from './stream-graph-read-model.js';
export type {
  AgentGraphClientActivity,
  AdvancedAgentGraphClientProjection,
  AgentGraphClientClaimRef,
  AgentGraphClientControlDecision,
  AgentGraphClientEdge,
  AgentGraphClientFinish,
  AgentGraphClientMaterialization,
  AgentGraphClientOperator,
  AgentGraphClientOperatorStatus,
  AgentGraphClientRunRef,
  AgentGraphClientScheduledWork,
  AgentGraphClientSnapshot,
  AgentGraphClientSnapshotOptions,
  AgentGraphClientStatus,
  AgentGraphClientStoppedTarget,
  AgentGraphClientTerminalHistoryPage,
  AgentGraphOperatorInspection,
  BuildAgentGraphClientReadModelInput,
} from './stream-graph-read-model.js';
export {
  AgentGraphCoordinator,
  agentGraphIdForRootSession,
  topologyFromProvisions,
} from './stream-graph-coordinator.js';
export type {
  AgentGraphClientChangedEvent,
  AgentGraphClientChangedListener,
  AgentGraphClientChangedReason,
  AgentGraphCoordinatorInput,
  AgentGraphCoordinatorRuntime,
  AgentGraphCoordinatorSessionStore,
} from './stream-graph-coordinator.js';
export type {
  AgentGraphAllSettledReadinessPolicy,
  AgentGraphMapReadinessPolicy,
  AgentGraphOperatorReadinessState,
  AgentGraphReadinessPolicy,
  AgentGraphReadinessSnapshot,
  AgentGraphReadinessWait,
  AgentGraphRunnableIntent,
  AgentGraphRunnableIntentPolicyKind,
  AgentGraphSealedActivationInput,
  AgentGraphSupervisorReadinessObservation,
  BuildAgentGraphReadinessSnapshotInput,
} from './stream-graph-readiness.js';

export { renderSwarmModePrompt } from './swarm-mode.js';
export { renderGraphModePrompt } from './graph-mode.js';
export {
  RuntimeHostedRootConflictError,
  RuntimeMessageAuthorityInvariantError,
} from './message-authority.js';
export type {
  RuntimeHostedRootAuthority,
  RuntimeHostedRootExecutionInput,
  RuntimeMessageAuthority,
  RuntimeMessageRunIdentity,
  RuntimeMessageRunOwner,
} from './message-authority.js';
export { isRuntimeHostedRootAuthority } from './message-authority.js';
export {
  RuntimeInteractionAdmissionRejectedError,
  RuntimeInteractionClosedError,
  RuntimeInteractionFailStopError,
  RuntimeInteractionInvariantError,
} from './interaction-authority.js';
export type {
  CanonicalPermissionOutcomeReader,
  CanonicalPermissionOutcomeRecord,
  RuntimeInteractionAdmissionRejectionReason,
  RuntimeInteractionAuthority,
  RuntimeInteractionClosureReason,
  RuntimeInteractionContinuationAuthority,
  RuntimeInteractionContinuationIdentity,
  RuntimeInteractionFatalError,
  RuntimeInteractionRunClosureReason,
  RuntimeInteractionRunFacet,
  RuntimeInteractionRunIdentity,
  RuntimeInteractionRunOwner,
  RuntimeUserQuestionAnswer,
  RuntimeUserQuestionClosureReason,
  RuntimeUserQuestionContinuation,
  RuntimeUserQuestionOutcome,
} from './interaction-authority.js';

export {
  FilesystemWorkerClient,
  FilesystemWorkerClientError,
  buildFilesystemWorkerEnv,
  createFilesystemWorkerLaunchSpecProvider,
} from './filesystem-worker/index.js';
export type {
  CreateFilesystemWorkerLaunchSpecProviderInput,
  FilesystemWorkerClientInput,
  FilesystemWorkerClientOperation,
  FilesystemWorkerExecuteInput,
  FilesystemWorkerLaunchSpec,
  FilesystemWorkerLaunchSpecProvider,
  FilesystemWorkerLaunchSpecResult,
  FilesystemWorkerResourceLocation,
} from './filesystem-worker/index.js';

export { AiSdkBackend } from './ai-sdk-backend.js';
export { isSupportedImagePath, validateImageBytes } from './image-file.js';
export { findFirstChangedCacheableSegment } from './request-shape.js';
export { createProviderRequestCaptureRecorder } from './provider-request-telemetry.js';
export { readLatestContextDiagnostics } from './context-diagnostics.js';
export type {
  ContextDiagnostics,
  ContextDiagnosticsCompaction,
  ContextDiagnosticsSegment,
  ContextDiagnosticsUnavailableReason,
} from './context-diagnostics.js';
export type {
  PreparedProviderRequestCapture,
  PreparedRequestSegment,
  PreparedRequestSegmentRef,
} from './request-shape.js';
export type {
  ProviderRequestAttemptRecord,
  ProviderRequestCaptureLedgerRecord,
  ProviderRequestCaptureRecord,
  ProviderRequestCaptureRecorderInput,
  ProviderRequestUsage,
} from './provider-request-telemetry.js';
export type { MakaTool, MakaToolContext } from './tool-runtime.js';
export { buildMcpTools, mcpProxyToolName } from './mcp-tools.js';
export type {
  McpToolProvider,
  McpToolInvocationContext,
  BuildMcpToolsOptions,
} from './mcp-tools.js';
export { buildAskUserQuestionTool } from './ask-user-question-tool.js';
export { buildRequestSandboxBoundaryTool } from './sandbox-boundary-tool.js';
export { buildSubmitPlanTool, buildUpdatePlanTool, buildCancelPlanTool } from './plan-tools.js';
export type { PlanToolResult } from './plan-tools.js';
export {
  selectCollaborationTools,
  renderPlanModePrompt,
  renderPlanExecutionPrompt,
  renderInterruptedPlanContext,
} from './plan-mode.js';
export { terminateChildProcessTree } from './process-tree-terminator.js';
export type { AttachmentByteReader } from '@maka/core/attachments';
export type {
  AgentBackend,
  BackendCompactHistoryInput,
  BackendCompactHistoryResult,
  AiSdkBackendInput,
  AppendMessageFn,
  ModelFactory,
  ModelFactoryInput,
  RunTraceEvent,
  RunTraceRecorder,
} from './ai-sdk-backend.js';
export type {
  HistoryCompactLoader,
  HistoryCompactLoadInput,
  HistoryCompactLoadResult,
  HistoryCompactWriter,
  HistoryCompactWriteInput,
  HistoryCompactWriteResult,
  HistoryCompactCheckpointLoader,
  HistoryCompactCheckpointRecorder,
  HistoryCompactSummarizer,
  HistoryCompactSummaryInput,
  SynthesisCacheLoader,
  SynthesisCacheLoadInput,
  SynthesisCacheLoadResult,
  SynthesisCacheWriter,
  SynthesisCacheWriteInput,
  SynthesisCacheWriteResult,
  ToolResultArchiveRecorder,
  ToolResultArchiveRecorderInput,
  SemanticCompactBlockRecorder,
} from './ai-sdk-compaction-contract.js';
export { PiAgentBackend, normalizePiAgentFrame } from './pi-agent-backend.js';
export type {
  PiAgentBackendInput,
  PiAgentFrame,
  PiAgentSendInput,
  PiAgentTransport,
} from './pi-agent-backend.js';

export { buildBuiltinTools } from './builtin-tools.js';
export type {
  BuildBuiltinToolsOptions,
  MakaTool as BuiltinMakaTool,
  MakaToolContext as BuiltinMakaToolContext,
} from './builtin-tools.js';
export {
  buildToolResultArchiveResourceRef,
  parseToolResultArchiveResourceRef,
  readToolResultArchiveResource,
  TOOL_RESULT_ARCHIVE_DEFAULT_LIMIT,
  TOOL_RESULT_ARCHIVE_MAX_BYTES,
  TOOL_RESULT_ARCHIVE_MAX_LIMIT,
  TOOL_RESULT_ARCHIVE_MAX_RESPONSE_CHARS,
  TOOL_RESULT_ARCHIVE_READ_INSTRUCTIONS,
} from './tool-result-archive-resource.js';
export type {
  ToolResultArchiveResourceIdentity,
  ToolResultArchiveResourceOperation,
  ToolResultArchiveResourceReader,
  ToolResultArchiveResourceReadInput,
  ToolResultArchiveResourceRequest,
} from './tool-result-archive-resource.js';
export { buildComputerUseTools, adaptToCuAction } from './computer-use-tools.js';
export {
  convertOpenAIComputerAction,
  openAIComputerActionSchema,
} from './openai-computer-actions.js';
export type {
  OpenAIComputerAction,
  OpenAIComputerActionConversion,
} from './openai-computer-actions.js';
export {
  createOpenAIComputerContinuationRequest,
  createOpenAIComputerInitialRequest,
  decodeOpenAIComputerResponse,
} from './openai-computer-codec.js';
export { OPENAI_COMPUTER_INSTRUCTIONS } from './openai-computer-policy.js';
export {
  createOpenAIStrictObjectSchema,
  projectOpenAIStrictFunctionArgs,
} from './openai-strict-function.js';
export type { OpenAIStrictFunctionProjection } from './openai-strict-function.js';
export type {
  OpenAIComputerCall,
  OpenAIComputerDialect,
  OpenAIComputerInputItem,
  OpenAIComputerRequest,
  OpenAIComputerResponse,
  OpenAIComputerSafetyCheck,
  OpenAIComputerScreenshot,
} from './openai-computer-codec.js';
export { runOpenAIComputerLoop } from './openai-computer-loop.js';
export type {
  OpenAIComputerExecutor,
  OpenAIComputerLoopResult,
  OpenAIComputerScreenshotProvider,
  OpenAIComputerTransport,
} from './openai-computer-loop.js';
export {
  OpenAIResponsesTransport,
  createOpenAIResponsesTransport,
} from './openai-responses-transport.js';
export type { OpenAIResponsesTransportOptions } from './openai-responses-transport.js';
export type { ComputerUseToolSet } from './computer-use-tools.js';
export type {
  CuAppSummary,
  CuDispatchBackend,
  CuDispatchEvidence,
  CuDispatchOutcome,
  CuObservedElement,
  CuObservation,
  CuOverlayHook,
  CuOverlayHookContext,
  CuPresentationFence,
  CuRunContext,
  CuRunResult,
  CuScreenshot,
  CuSemanticAction,
} from './computer-use-types.js';
export {
  bindCuaAction,
  bindCuaActionToObservation,
  bindCuaSemanticActionToObservation,
  CuaFrameState,
  fingerprintCuaAction,
  fingerprintCuaSemanticAction,
} from './cua-frame-state.js';
export type {
  CuaActionClaimResult,
  CuaActionConfirmationResult,
  CuaActionRejectionReason,
  CuaBoundAction,
  CuaFrameIdentity,
  CuaObservation,
  CuaObservationSnapshot,
} from './cua-frame-state.js';
export { CUA_SESSION_STATUSES, CuaSessionState } from './cua-session-state.js';
export type {
  CuaActionLease,
  CuaActionLeaseResult,
  CuaSessionActionBlockReason,
  CuaSessionSnapshot,
  CuaSessionStatus,
} from './cua-session-state.js';
export {
  buildManagedBashTool,
  buildForegroundBashTool,
  buildLocalForegroundBashTool,
  buildStopBackgroundTaskTool,
  buildWriteStdinTool,
  shapeTerminalResult,
} from './shell-tools.js';
export type {
  BuildForegroundBashToolOptions,
  ForegroundBashExecuteInput,
  ForegroundBashResult,
  ShellRunLauncher,
} from './shell-tools.js';
export {
  DEFAULT_BASH_TIMEOUT_MS,
  DEFAULT_MAX_LIVE_SHELL_RUNS,
  DEFAULT_MAX_LIVE_PTY_RUNS,
  DEFAULT_SHELL_RUN_FLUSH_BYTES,
  DEFAULT_SHELL_RUN_FLUSH_INTERVAL_MS,
  MAX_FOREGROUND_BASH_TIMEOUT_MS,
  MAX_PTY_COLS,
  MAX_PTY_ROWS,
  MAX_SHELL_RUN_RESOURCE_REF_CHARS,
  MAX_SHELL_RUN_TIMEOUT_MS,
  MAX_WRITE_STDIN_INPUT_BYTES,
  MIN_PTY_COLS,
  MIN_PTY_ROWS,
  SHELL_RUN_CONTEXT_SUMMARY_LIMIT,
  SHELL_RUN_RESOURCE_PREFIX,
  ShellRunPtyControlClosedError,
  isWellFormedTerminalInput,
  isShellRunResourceRef,
  shellRunResourceRef,
} from './shell-run-contract.js';
export type {
  BackgroundTaskStopper,
  PtyControlWriter,
  RuntimeResourceReader,
  ShellRunBashInput,
  ShellRunProcessManagerInput,
  ShellRunWriteInput,
} from './shell-run-contract.js';
export { ShellRunProcessManager } from './shell-run-manager.js';
export type { ShellRunUpdate } from '@maka/core';
export {
  LOCAL_WORKSPACE_EXECUTOR_FACTS,
  LocalWorkspaceExecutor,
  createLocalWorkspaceExecutor,
} from './workspace-executor.js';
export type {
  WorkspaceExecInput,
  WorkspaceExecResult,
  WorkspaceBashExecutor,
  WorkspaceCommandExecutor,
  WorkspaceEditExecutor,
  WorkspaceExistingPathResolver,
  WorkspaceExecutor,
  WorkspaceExecutorFacts,
  WorkspaceExecutorFactsProvider,
  WorkspaceGlobExecutor,
  WorkspaceGlobFilesExecutor,
  WorkspaceGlobInput,
  WorkspaceGlobResult,
  WorkspaceGrepExecutor,
  WorkspaceGrepFilesExecutor,
  WorkspaceGrepInput,
  WorkspaceGrepResult,
  WorkspaceIsolationKind,
  WorkspaceNetworkMode,
  WorkspaceReadExecutor,
  WorkspaceReadFileInput,
  WorkspaceReadFileExecutor,
  WorkspaceReadFileResult,
  WorkspaceResolvePathInput,
  WorkspaceResolvePathResult,
  WorkspaceSecretMode,
  WorkspaceSearchExecutor,
  WorkspaceWritablePathResolver,
  WorkspaceWriteExecutor,
  WorkspaceWriteBackMode,
  WorkspaceWriteFileInput,
  WorkspaceWriteFileExecutor,
  WorkspaceWriteFileResult,
  WorkspaceWriteLockKeyInput,
  WorkspaceWriteLockProvider,
  WorkspaceWriteLockKeyResult,
} from './workspace-executor.js';
export { computeEditedSource, COMPUTE_EDITED_SOURCE_FN_SOURCE } from './edit-replace.js';
export type { EditMatch, EditMatchStrategy } from './edit-replace.js';
export { truncateToolOutput } from './tool-output.js';
export type { TruncateToolOutputOptions, TruncatedToolOutput } from './tool-output.js';
export {
  runProcessWithBoundedTail,
  runShellWithBoundedTail,
  BASH_MAX_RETAINED_CHARS,
} from './shell-exec.js';
export type { BoundedShellOptions, BoundedShellResult } from './shell-exec.js';
export type { ChildFdInput } from './child-fd-input.js';
export {
  detectShell,
  defaultShellPlan,
  buildShellSpawnPlan,
  bashToolShellGuidance,
} from './shell-detect.js';
export type { ShellPlan, ShellKind, ShellSpawnPlan, DetectShellInput } from './shell-detect.js';
export {
  MACOS_SEATBELT_BASE_POLICY,
  MACOS_SEATBELT_EXECUTABLE,
  MACOS_SEATBELT_PLATFORM_DEFAULTS_POLICY,
  MacosSeatbeltBackend,
  LinuxBubblewrapBackend,
  SandboxManager,
  buildBubblewrapArgv,
  buildNetworkSeccompFilter,
  discoverNestedProtectedMetadataPaths,
  buildSeatbeltPolicy,
  createDefaultSandboxManager,
  createBuiltinSandboxManager,
  isBuiltinFilesystemWorkerSandboxAvailable,
  createSandboxDiagnosticsProvider,
  createSeatbeltExecArgs,
  escapeSeatbeltRegex,
  detectLinuxSandboxCapability,
  toSandboxRunTraceProjection,
} from './sandbox/index.js';
export type {
  BuildSeatbeltPolicyInput,
  BuildSeatbeltPolicyResult,
  BuildBubblewrapArgvInput,
  CreateSeatbeltExecArgsInput,
  DetectLinuxSandboxCapabilityInput,
  LinuxBubblewrapBackendOptions,
  LinuxSandboxCapability,
  CreateSandboxDiagnosticsProviderInput,
  ResolveSandboxDiagnosticsInput,
  SandboxDiagnosticCapability,
  SandboxDiagnosticCapabilityStatus,
  SandboxDiagnosticFailureReason,
  SandboxDiagnosticFailureStage,
  SandboxDiagnosticFileSystemMode,
  SandboxDiagnosticNetworkMode,
  SandboxDiagnosticsProvider,
  SandboxDiagnosticsSnapshot,
  SandboxRunTraceProjection,
} from './sandbox/index.js';
export type {
  SandboxBackend,
  SandboxCommand,
  SandboxExecRequest,
  SandboxPathContext,
  SandboxPlatform,
  SandboxSelectionInput,
  SandboxSelectionReason,
  SandboxSelectionResult,
  SandboxTransformFailureReason,
  SandboxTransformRequest,
  SandboxTransformResult,
  SandboxType,
  SandboxablePreference,
  SandboxErrorDomain,
  SandboxErrorMetadata,
  SandboxErrorStage,
  SandboxErrorWithMetadata,
} from './sandbox/index.js';
export {
  SandboxCommandError,
  sandboxErrorMetadata,
  serializeSandboxError,
} from './sandbox/index.js';
export {
  AGENT_CONTEXT_ISOLATED,
  AGENT_INVOCATION_FOREGROUND,
  AGENT_WORKSPACE_SAME_WORKSPACE,
  AGENT_WORKSPACE_WORKTREE,
  AGENT_WRITE_BACK_PATCH,
  AGENT_WRITE_BACK_SUMMARY,
  BUILTIN_AGENT_DEFINITIONS,
  BUILTIN_AGENT_PROFILES,
  IMPLEMENTATION_AGENT_DEFINITION,
  IMPLEMENTATION_AGENT_ID,
  IMPLEMENTATION_AGENT_PROFILE,
  LOCAL_READ_AGENT_DEFINITION,
  LOCAL_READ_AGENT_ID,
  LOCAL_READ_AGENT_PROFILE,
  WEB_RESEARCH_AGENT_DEFINITION,
  WEB_RESEARCH_AGENT_ID,
  WEB_RESEARCH_AGENT_PROFILE,
  assertAgentDefinitionRunnable,
  buildToolsForAgentDefinition,
  evaluateAgentDefinitionAvailability,
  evaluateAgentDefinitionToolAccess,
  getBuiltinAgentDefinition,
  getBuiltinAgentDefinitionByProfile,
  listBuiltinAgentDefinitions,
  requireBuiltinAgentDefinition,
  requireBuiltinAgentDefinitionByProfile,
} from './agent-catalog.js';
export type {
  AgentCapability,
  AgentDefinition,
  AgentDefinitionAvailability,
  AgentDefinitionListItem,
  AgentDefinitionListOptions,
  AgentContextMode,
  AgentInvocationMode,
  AgentProfile,
  AgentProfileContract,
  AgentWorkspaceMode,
  AgentWriteBackMode,
} from './agent-catalog.js';
export {
  AGENT_SWARM_DEFAULT_CONCURRENCY,
  AGENT_SWARM_MAX_CONCURRENCY,
  AGENT_SWARM_MAX_ITEMS,
  AGENT_SWARM_PROMPT_TEMPLATE_PLACEHOLDER,
  AGENT_SWARM_TOOL_NAME,
  buildAgentSwarmTool,
} from './agent-swarm-tools.js';
export type {
  AgentSwarmExplicitItemInput,
  AgentSwarmExplicitToolInput,
  AgentSwarmResumeToolInput,
  AgentSwarmTemplateToolInput,
  AgentSwarmToolInput,
  AgentSwarmToolResult,
} from './agent-swarm-tools.js';
export {
  AGENT_LIST_TOOL_NAME,
  AGENT_OUTPUT_TOOL_NAME,
  AGENT_SPAWN_TOOL_NAME,
  AGENT_TOOL_GROUP_ID,
  AGENT_TOOL_NAMES,
  CHILD_AGENT_TOOL_NAMES,
  buildChildAgentTools,
  buildSubagentListTool,
  buildSubagentOutputTool,
  buildParentAgentTools,
  buildSubagentProjectionTools,
  buildSubagentSpawnTool,
} from './subagent-tools.js';
export {
  LEGACY_TASK_CREATE_TOOL_NAME,
  LEGACY_TASK_UPDATE_TOOL_NAME,
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  buildTaskLedgerTools,
  isTaskLedgerToolsEnabled,
} from './task-ledger-tools.js';
export {
  DEEP_RESEARCH_ARTIFACT_CONTENT_MAX_CHARS,
  DEEP_RESEARCH_ARTIFACT_READ_DEFAULT_CHARS,
  DEEP_RESEARCH_ARTIFACT_READ_MAX_CHARS,
  DEEP_RESEARCH_STATUS_ARTIFACTS_MAX,
  DEEP_RESEARCH_CHECKPOINT_TOOL_NAME,
  DEEP_RESEARCH_COMPLETE_TOOL_NAME,
  DEEP_RESEARCH_READ_ARTIFACT_TOOL_NAME,
  DEEP_RESEARCH_RECORD_STEP_TOOL_NAME,
  DEEP_RESEARCH_SAVE_ARTIFACT_TOOL_NAME,
  DEEP_RESEARCH_START_TOOL_NAME,
  DEEP_RESEARCH_STATUS_TOOL_NAME,
  DEEP_RESEARCH_UPDATE_CHECKLIST_TOOL_NAME,
  buildDeepResearchTools,
  renderDeepResearchRunStatus,
} from './deep-research-tools.js';
export type {
  BuildDeepResearchToolsDeps,
  DeepResearchArtifactStore,
} from './deep-research-tools.js';
export {
  deriveToolArtifactCandidates,
  extractStdoutRedirectPath,
  recordToolArtifactsSafely,
} from './tool-artifacts.js';
export type {
  ToolArtifactCandidate,
  ToolArtifactDerivationInput,
  ToolArtifactRecorder,
  ToolArtifactRecorderInput,
} from './tool-artifacts.js';
export { createToolOutputDeltaEmitter } from './tool-output-delta.js';
export type { ToolOutputDeltaEmitter, ToolOutputDeltaEmitterInput } from './tool-output-delta.js';
export {
  DEFAULT_STREAM_CONNECT_TIMEOUT_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  StreamWatchdog,
  formatStreamWatchdogError,
} from './stream-watchdog.js';
export type {
  StreamWatchdogInput,
  StreamWatchdogPhase,
  StreamWatchdogTimeout,
} from './stream-watchdog.js';

export { getAIModel, buildProviderOptions } from './model-factory.js';
export { fallbackSessionTitle, generateSessionTitle, sessionTitleSource } from './session-title.js';
export type { ModelFactoryInput as GetAIModelInput } from './model-factory.js';
export {
  extractOAuthSubscriptionAccessToken,
  isOAuthSubscriptionProvider,
  parseOAuthSubscriptionTokens,
  refreshAndPersistOAuthSubscriptionTokens,
  refreshOAuthSubscriptionTokens,
  resolveAndPersistOAuthSubscriptionTokens,
  resolveOAuthSubscriptionAccessToken,
  resolveOAuthSubscriptionTokens,
  createGitHubCopilotAccountTokens,
  GITHUB_COPILOT_DEFAULT_API_ENDPOINT,
  isSupportedGitHubCopilotAccountToken,
  serializeOAuthSubscriptionTokens,
} from './subscription-credentials.js';
export type {
  OAuthSubscriptionCredentialStore,
  OAuthSubscriptionProvider,
  OAuthSubscriptionRefreshAndPersistOutcome,
  OAuthSubscriptionResolveAndPersistOutcome,
  OAuthSubscriptionTokens,
  RefreshAndPersistOAuthSubscriptionTokensInput,
  ResolveAndPersistOAuthSubscriptionTokensInput,
  ResolveOAuthSubscriptionAccessTokenInput,
} from './subscription-credentials.js';
export { buildSubscriptionModelFetch } from './subscription-model-fetch.js';
export type { SubscriptionModelFetchInput } from './subscription-model-fetch.js';
export { extractCodexAccountId, openAiCodexHeaders } from './subscription-auth.js';
export {
  compactionDecisionDiagnosticPatch,
  compactionDecisionToDiagnostic,
  historyCompactBlockToCompactionBoundary,
} from './compaction-boundary.js';
export type {
  CompactionArchiveRef,
  CompactionBoundary,
  CompactionBoundaryKind,
  CompactionCoverage,
  CompactionDecision,
  CompactionDecisionKind,
  CompactionSourceKind,
  CompactionStage,
} from './compaction-boundary.js';
export {
  buildDefaultContextBudgetPolicy,
  buildManualCompactLookupPolicy,
  resolveSelectedModelContextWindow,
} from './context-budget-policy.js';
export type {
  BuildDefaultContextBudgetPolicyOptions,
  BuildManualCompactLookupPolicyOptions,
} from './context-budget-policy.js';
export {
  loadHistoryCompactBlocksFromArtifacts,
  persistHistoryCompactBlocksToArtifacts,
} from './history-compact-artifacts.js';
export type {
  HistoryCompactArtifactStore,
  PersistHistoryCompactBlocksDeps,
} from './history-compact-artifacts.js';
export {
  HISTORY_COMPACT_SOURCE_POLICY_VERSION,
  buildHistoryCompactCheckpoint,
  canReplaceHistoryCompactCheckpoint,
  historyCompactCheckpointToRuntimeEvent,
  matchHistoryCompactCheckpointPrefix,
  midTurnHeadAnchorEvent,
  projectHistoryCompactCheckpointReplay,
  renderHistoryCompactCheckpoint,
  validateHistoryCompactCheckpointShape,
} from './history-compact-checkpoint.js';
export type {
  BuildHistoryCompactCheckpointInput,
  HistoryCompactCheckpoint,
  HistoryCompactCheckpointCoverage,
  HistoryCompactCheckpointHeadAnchor,
  HistoryCompactCheckpointPhase,
  HistoryCompactCheckpointPrefixMatch,
  HistoryCompactCheckpointSource,
} from './history-compact-checkpoint.js';
export {
  estimateNextRequestTokens,
  exceedsContextWindow,
  exceedsHighWater,
  planMidTurnCapacityCompaction,
  selectMidTurnSafeBoundary,
} from './mid-turn-capacity-compact.js';
export type {
  EstimateNextRequestTokensInput,
  MidTurnBoundary,
  MidTurnBoundaryOptions,
  MidTurnFailReason,
  MidTurnSummarizer,
  PlanMidTurnCapacityCompactionInput,
  PlanMidTurnCapacityCompactionResult,
} from './mid-turn-capacity-compact.js';
export { cleanupLegacyHistoryCompactArtifacts } from './history-compact-cleanup.js';
export type {
  HistoryCompactCleanupDiagnostic,
  HistoryCompactCleanupResult,
  HistoryCompactCleanupSkip,
} from './history-compact-cleanup.js';
export {
  buildLlmHistorySummarizer,
  HistoryCompactSummarizerError,
} from './history-compact-summarizer.js';
export type { BuildLlmHistorySummarizerOptions } from './history-compact-summarizer.js';
export type { HistoryCompactSummarizerFailureReason } from './history-compact-error.js';
export {
  ACTIVE_ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND,
  ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND,
  ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
  applyRuntimeEventHistoryCompact,
  applyRuntimeEventContextBudget,
  buildHistoryCompactBlockFromSummary,
  buildSynthesisCacheBlocksFromHydratedArchives,
  buildPromptSegmentEstimates,
  collectStaleToolResultArchiveCandidates,
  deriveSynthesisCoverageFromSourceRefs,
  estimateModelMessagesChars,
  estimateRuntimeEventsTokens,
  estimateTokens,
  isArchivedToolResultPlaceholder,
  rawEvidenceRequestReason,
  deserializeToolResultArchive,
  historyCompactBlockToRuntimeEvent,
  renderHistoryCompactBlock,
  retrieveArchivedToolResultsForReplay,
  retrieveRuntimeEventHistoryAround,
  searchRuntimeEventHistory,
  serializeToolResultForArchive,
  stableSynthesisBlockId,
  validateHistoryCompactBlockShape,
  validateSynthesisCacheBlockShape,
} from './context-budget.js';
export type {
  ArchivedToolResultReason,
  BudgetedRuntimeContext,
  ContextBudgetPolicy,
  ArchiveRetrievalMode,
  ArchiveRetrievalPolicy,
  ArchiveRetrievalResult,
  HistoryCompactBlock,
  HistoryCompactCoverage,
  HistoryCompactMidTurnPolicy,
  HistoryCompactPolicy,
  HistoryCompactReplayResult,
  HistoryCompactSourceArchiveRef,
  HistoryRewriteGatePolicy,
  RuntimeEventHistoryAroundResult,
  RuntimeEventHistorySearchHit,
  RuntimeEventHistorySearchPolicy,
  StaleToolResultPrunePolicy,
  StaleToolResultArchiveCandidate,
  SynthesisCacheBlock,
  SynthesisCacheCoverage,
  SynthesisCachePolicy,
  SynthesisSourceRef,
  ToolResultArchiveReader,
  ToolResultArchiveReaderInput,
  ToolResultArchiveReadFailureReason,
  ToolResultArchiveReadResult,
  ToolResultArchiveRef,
  ArchivedToolResultPlaceholder,
  ActiveArchivedToolResultPlaceholder,
  PromptSegmentInput,
} from './context-budget.js';
export {
  loadSynthesisCacheBlocksFromArtifacts,
  persistSynthesisCacheBlocksToArtifacts,
} from './synthesis-cache-artifacts.js';
export type {
  PersistSynthesisCacheBlocksDeps,
  SynthesisCacheArtifactStore,
} from './synthesis-cache-artifacts.js';
export {
  activeFullCompactBlockToCompactionBoundary,
  activeFullCompactCoverageFromEntries,
  activeFullCompactDecisionDiagnosticPatch,
  activeFullCompactBlockToModelMessage,
  buildDeterministicActiveFullCompactSummary,
  buildDeterministicProcessStateActiveFullCompactSummary,
  buildActiveFullCompactBlockFromSummary,
  buildActiveFullCompactSourceIndex,
  buildActiveCompactionHeadAnchor,
  activeCompactionMessageSignature,
  estimateActiveFullCompactTokens,
  renderActiveFullCompactBlock,
  rewriteActiveFullCompactInMessages,
  selectActiveFullCompactCoveredSpan,
  selectActiveCompactionSafeSpan,
  validateActiveFullCompactBlockForSourceIndex,
  validateActiveFullCompactBlockShape,
} from './active-full-compact.js';
export type {
  ActiveFullCompactArchiveRef,
  ActiveCompactionHeadAnchor,
  ActiveCompactionSafeSpanPolicy,
  ActiveCompactionSafeSpanSelection,
  ActiveFullCompactBlock,
  ActiveFullCompactContentKind,
  ActiveFullCompactCoverage,
  ActiveFullCompactFailOpenReason,
  ActiveFullCompactPolicy,
  ActiveFullCompactProviderRole,
  ActiveFullCompactRewriteDecision,
  ActiveFullCompactRewriteInput,
  ActiveFullCompactRewriteResult,
  ActiveFullCompactSelection,
  ActiveFullCompactSourceEntry,
  ActiveFullCompactSourceIndex,
  ActiveFullCompactSourceIndexInput,
  ActiveFullCompactSourceRef,
  ActiveFullCompactSummary,
  ActiveFullCompactValidationResult,
  BuildActiveFullCompactBlockInput,
} from './active-full-compact.js';
export {
  renderSemanticCompactBlock,
  rewriteSemanticCompactInMessages,
  semanticCompactBlockToModelMessage,
  semanticCompactBlockToCompactionBoundary,
} from './semantic-compact.js';
export type {
  SemanticCompactBlock,
  SemanticCompactDecision,
  SemanticCompactPolicy,
  SemanticCompactRewriteInput,
  SemanticCompactRewriteResult,
  SemanticCompactStateCard,
  SemanticCompactSummarizer,
  SemanticCompactSummaryRequest,
} from './semantic-compact.js';
export { runConnectionTestEffect, testConnection } from './test-connection.js';
export {
  fetchGitHubCopilotModels,
  fetchOpenAiCodexModels,
  fetchProviderModels,
  OpenAiCodexDiscoveryError,
  ProviderModelDiscoveryHttpError,
  runConnectionModelDiscoveryEffect,
} from './model-fetcher.js';
export type {
  ConnectionEffectFetch,
  ConnectionEffectFetchDependency,
  ConnectionEffectFetchOptions,
} from './connection-effect-fetch.js';
export type {
  ConnectionEffectConnection,
  ConnectionEffectError,
  ConnectionEffectErrorKind,
  ConnectionModelDiscoveryEffectOutcome,
  ConnectionTestEffectOutcome,
} from './connection-effect-outcome.js';
export {
  createConnectionEffectFetchTransport,
  createProxiedFetchTransport,
} from './network/scoped-fetch-transport.js';
export type {
  ConnectionEffectFetchTransport,
  ConnectionEffectProxySnapshot,
  ProxiedFetchProxy,
  ProxiedFetchTransport,
} from './network/scoped-fetch-transport.js';

export { materializeSession, applyAppendedMessage, setToolStatus } from './materializer.js';
export type { ToolActivityItem, ChatItem, SessionViewModel } from './materializer.js';

export { AsyncEventQueue } from './async-queue.js';
export {
  FAKE_ASK_USER_QUESTION_PROMPT,
  FAKE_WAIT_FOR_STEERING_PROMPT,
  FakeBackend,
} from './fake-backend.js';

export {
  BUILTIN_PRICING,
  buildPricingLookup,
  computeCost,
  getBuiltinPricing,
  recordLlmCall,
  recordToolInvocation,
} from './telemetry/index.js';
export type {
  LlmRecorderDeps,
  PersistedLlmCallRecord,
  PersistedToolInvocationRecord,
  TelemetryRepoLite,
  ToolRecorderDeps,
} from './telemetry/index.js';

export {
  BaseBotAdapter,
  BotRegistry,
  botReadinessFromSettings,
  botSettingsRequireRestart,
  getWechatBridgeQrCode,
  mapWechatIlinkMessage,
  normalizeWechatBridgeUrl,
  normalizeWechatIlinkBaseUrl,
  proxiedFetch,
  testBotChannel,
  testWechatBridge,
  testWechatIlinkCredentials,
  WechatBridge,
} from './bots/index.js';
export { setActiveProxy, resolveActiveProxy } from './network/active-proxy-state.js';
export type {
  BotBridge,
  BotIncomingMessage,
  BotPlatform,
  BotStatus,
  BotTestResult,
  WechatBridgeQrCodeResult,
  SendCapable,
} from './bots/index.js';

// ───────────────────────────────────────────────────────────────────────────
// Runtime event and recovery public seam.
//
// `InvocationContext` is the canonical runner/flow spine exported from
// `./invocation-context.js` and used by the formal `AgentFlow` seam.
// RuntimeRunner's normal-invocation API remains public through this barrel;
// its admitted-continuation capability is package-internal and intentionally
// has no package subpath or barrel export.
// ───────────────────────────────────────────────────────────────────────────

// invocation-context.ts — runner spine types + providers.
export type {
  InvocationContext,
  InvocationRequest,
  InvocationSource,
  InvocationLineage,
  InvocationProviders,
  InvocationResult,
  InvocationResultStatus,
  InvocationFailure,
} from './invocation-context.js';
export {
  INVOCATION_SOURCES,
  isInvocationSource,
  createDefaultInvocationProviders,
} from './invocation-context.js';

// runtime-runner.ts — RuntimeRunner shell + gate.
export { RuntimeRunner, runtimeGateFromCallback } from './runtime-runner.js';
export type {
  RuntimeGate,
  RuntimeGateDecision,
  AgentFlowLike,
  RuntimeRunnerDeps,
} from './runtime-runner.js';

// runtime-event-adapters.ts — legacy StoredMessage ↔ RuntimeEvent bridge.
export {
  storedMessageToRuntimeEvent,
  storedMessageToRuntimeEvents,
  runtimeEventToStoredMessageDraft,
  createRuntimeEventId,
} from './runtime-event-adapters.js';
export type {
  StoredMessageEventContext,
  RuntimeEventToDraftOptions,
} from './runtime-event-adapters.js';

// runtime-event-read-model.ts — side-by-side RuntimeEvent read projection.
export {
  projectRuntimeEventsToStoredMessages,
  projectRuntimeEventsToStoredMessagesWithArchiveStatuses,
  applyArchivedToolResultReadModelStatuses,
  compareRuntimeReadModelMessages,
  classifyRuntimeEventTerminalFact,
} from './runtime-event-read-model.js';
export type {
  ArchivedToolResultReadModelStatus,
  ProjectRuntimeEventsToStoredMessagesOptions,
  RuntimeEventReadModelDiagnostic,
  RuntimeEventReadModelDiagnosticCode,
  RuntimeEventReadModelProjection,
  RuntimeReadModelCompatibilityResult,
  RuntimeEventTerminalFact,
  RuntimeEventTerminalFactResult,
} from './runtime-event-read-model.js';
export {
  buildRecoveredTerminalRuntimeEvent,
  classifyTerminalRuntimeLedger,
  commitTerminalRunWithRuntimeFact,
} from './terminal-run-commit.js';
export type { TerminalRuntimeLedgerClassification } from './terminal-run-commit.js';
export { RuntimeReadModel, RuntimeReadModelError } from './runtime-read-model.js';
export type {
  RuntimeReadModelDeps,
  RuntimeReadModelProjectionCache,
  RuntimeReadModelSessionView,
} from './runtime-read-model.js';
export { RuntimeKernel, RuntimeOwnerCleanupError } from './runtime-kernel.js';
export type {
  RuntimeExecutionClaim,
  RuntimeKernelDeps,
  RuntimeKernelLike,
  TurnStartOptions,
} from './runtime-kernel.js';
export { AgentRun } from './agent-run.js';
export type { AgentRunActiveSession, AgentRunDurability, AgentRunLineage } from './agent-run.js';

// agent-run-inspect.ts — internal AgentRun/RuntimeEvent source-health view.
export { inspectAgentRunReadModel, inspectSessionRunReadModels } from './agent-run-inspect.js';
export type {
  AgentRunInspectDiagnostic,
  AgentRunInspectDiagnosticCode,
  AgentRunInspectReader,
  AgentRunInspectModel,
  AgentRunInspectProjectionSummary,
  AgentRunInspectSourceHealth,
  InspectAgentRunOptions,
  RuntimeEventInspectReader,
  SessionAgentRunInspectReader,
} from './agent-run-inspect.js';

// execution-inspect.ts — payload-safe, versioned CLI inspection documents.
export {
  AGENT_RUN_INSPECT_DOCUMENT_VERSION,
  SESSION_INSPECT_DOCUMENT_VERSION,
  inspectAgentRunDocument,
  inspectSessionDocument,
  renderAgentRunInspectTree,
  renderSessionInspectTree,
} from './execution-inspect.js';
export type {
  AgentRunInspectCompactionCheckpoint,
  AgentRunInspectDocument,
  AgentRunInspectIdentity,
  AgentRunInspectToolFact,
  AgentRunInspectToolSummary,
  ExecutionInspectDiagnostic,
  ExecutionInspectSeverity,
  InspectSessionDocumentOptions,
  SessionHeaderReader,
  SessionInspectDocument,
  SessionInspectSummary,
} from './execution-inspect.js';

// model-history.ts — policy-driven model-history projection.
export {
  buildModelHistoryFromRuntimeEvents,
  buildRuntimeEventModelReplayPlan,
} from './model-history.js';
export type {
  ModelHistoryEntry,
  BuildModelHistoryOptions,
  RuntimeEventModelReplayPlan,
  RuntimeEventModelReplayItem,
} from './model-history.js';

// runtime-resume.ts - Phase 0 replay projection + Phase 1 safe continuation gates.
export {
  INDETERMINATE_TOOL_RESULT_DIRECTIVE,
  RUNTIME_RESUME_FAILPOINTS,
  RuntimeContinuationRevalidationError,
  RuntimeContinuationPlanner,
  buildSafeBoundaryContinuationPlan,
  buildResumePlanFromRuntimeEvents,
  buildResumeReplayRuntimeEvents,
  projectToolOperationsFromRuntimeEvents,
} from './runtime-resume.js';
export type {
  BuildResumePlanOptions,
  ContinuationIdentity,
  ResumePlan,
  ResumePlanDiagnostic,
  ResumePlanDiagnosticCode,
  ResumePlanDisposition,
  ResumeRejectionReason,
  RuntimeResumeCommittedPrefix,
  RuntimeResumeFailpointId,
  RuntimeResumeFailpointSpec,
  RuntimeContinuation,
  RuntimeContinuationRevalidationCode,
  RuntimeContinuationPlannerDeps,
  RuntimeContinuationPlannerInput,
  RuntimeContinuationSafetyObservation,
  RuntimeContinuationSafetySnapshot,
  SafeBoundaryContinuationFacts,
  SafeBoundaryContinuationPlan,
  ToolOperation,
  ToolOperationStatus,
} from './runtime-resume.js';
export { buildContinuationReplaySegment } from './continuation-replay.js';
export type {
  ContinuationReplayBlockReason,
  ContinuationReplaySegmentPlanV1,
  ContinuationReplaySegmentResult,
  ContinuationReplaySegmentV1,
} from './continuation-replay.js';

export { resolveRuntimeRecovery } from './recovery-resolver.js';
export type {
  RuntimeRecoveryResolution,
  ToolRecoveryDecision,
  ToolRecoveryDecisionReason,
  ToolRecoveryDecisionStatus,
} from './recovery-resolver.js';

export { createLocalContinuationSafetyInspector } from './continuation-safety.js';
export type {
  LocalContinuationSafetyInspectorDeps,
  ResolvedWorkspaceIdentity,
} from './continuation-safety.js';
// history-compact-summarizer.ts — replay-plan → ModelMessage[] projection
// (issue #1055's session-recap generator reuses this authoritative slice
// instead of re-deriving a lossy projection of its own).
export { replayPlanItemsToModelMessages } from './history-compact-summarizer.js';

export { buildToolOperationId, canonicalToolArgsHash } from './runtime-commit-sink.js';
export type {
  RuntimeCommitResult,
  RuntimeCommitSink,
  ToolOperationIdInput,
  ToolOutcomeCommit,
  ToolPreparedCommit,
  ToolRecoveryMode,
} from './runtime-commit-sink.js';

// agent-flow.ts — formal Flow seam.
export type { AgentFlow, AgentFlowControl, FlowInput, RunnableAgentFlow } from './agent-flow.js';
export { flowSupportsControl } from './agent-flow.js';

// ai-sdk-flow.ts — default AgentFlow implementation over AiSdkBackend.
export {
  AiSdkFlow,
  mapSessionEventToRuntimeEvent,
  mapCompleteStopReason,
  createSessionEventMapMemory,
} from './ai-sdk-flow.js';
export type { AiSdkFlowInput, CompleteStopReason, SessionEventMapMemory } from './ai-sdk-flow.js';

// tool-availability.ts — unified tool-availability runtime (catalog, the
// `load_tools` connector, same-turn activation, gating, diagnostics).
export { ToolAvailabilityRuntime, LOAD_TOOLS_NAME } from './tool-availability.js';
export type {
  ToolAvailabilityConfig,
  ToolGroup,
  ToolAvailabilityPlan,
  StepLike,
  RuntimeEventLike,
} from './tool-availability.js';

// tool-catalog-derive.ts — HostCapabilities + deferred groups from catalog ∩ binding (#1099).
export {
  assertProductBindingCatalogClean,
  buildDeferredToolGroupsFromCatalog,
  buildHostCapabilitiesFromBinding,
  projectEffectiveProductToolSurface,
} from './tool-catalog-derive.js';
export type {
  EffectiveProductToolSurface,
  NormalizedProductToolSurfacePolicy,
  ProductToolSurfaceIdentity,
  ProductToolSurfacePolicy,
} from './tool-catalog-derive.js';

// ───────────────────────────────────────────────────────────────────────────
// System-prompt fragments (shared by the desktop app and the CLI/TUI).
// Read-only, stateless builders for project instructions, personalization, git
// context, and the per-turn environment tail. The stateful LocalMemoryService
// stays with the desktop app and is injected as a fragment by each caller.
// ───────────────────────────────────────────────────────────────────────────
export {
  buildWorkspaceInstructionsPromptFragment,
  getWorkspaceInstructionsState,
  WORKSPACE_INSTRUCTION_FILES,
  MAX_WORKSPACE_INSTRUCTION_FILE_CHARS,
  MAX_WORKSPACE_INSTRUCTIONS_PROMPT_CHARS,
} from './system-prompt/workspace-instructions.js';
export type {
  WorkspaceInstructionFileStatus,
  WorkspaceInstructionFileState,
  WorkspaceInstructionsState,
} from './system-prompt/workspace-instructions.js';
export {
  buildPersonalizationPromptFragment,
  sanitizeDisplayName,
  sanitizeAssistantTone,
  collectPersonalizationWarnings,
} from './system-prompt/personalization-prompt.js';
export type { PersonalizationPromptFragment } from './system-prompt/personalization-prompt.js';
export { resolveProjectGitInfo, resolveProjectRoot } from './system-prompt/project-context.js';
export type { ProjectGitInfo } from './system-prompt/project-context.js';
export { buildSessionEnvironmentPromptFragment } from './system-prompt/session-environment-prompt.js';
export type { SessionEnvironmentPromptInput } from './system-prompt/session-environment-prompt.js';

// ───────────────────────────────────────────────────────────────────────────
// Unified Automation (Codex-style: heartbeat + cron, single tool).
// ───────────────────────────────────────────────────────────────────────────
export {
  AutomationManager,
  computeNextCronFire,
  computeJitter,
  matchesCronField,
} from './automation-state.js';
export type {
  AutomationDefinition,
  AutomationKind,
  AutomationSchedule,
  AutomationStatus,
  AutomationManagerDeps,
} from './automation-state.js';
export {
  AutomationScheduler,
  FIRE_CHECK_INTERVAL_MS,
  DEFER_WINDOW_MS,
} from './automation-scheduler.js';
export type { AutomationSchedulerDeps, AutomationFireResult } from './automation-scheduler.js';
export { buildAutomationTool, AUTOMATION_TOOL_NAME } from './automation-tools.js';
export type { AutomationToolDeps } from './automation-tools.js';
export { evaluateAutomationCanFire, HEARTBEAT_IDLE_STATUSES } from './automation-can-fire.js';
export type { CanFireSessionHeader, EvaluateAutomationCanFireDeps } from './automation-can-fire.js';

// ───────────────────────────────────────────────────────────────────────────
// Goal execution (Issue #15 Primitive 6).
// ───────────────────────────────────────────────────────────────────────────
export {
  GoalManager,
  TERMINAL_GOAL_STATUSES,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_BLOCK_CAP,
} from './goal-state.js';
export type {
  GoalCheckpoint,
  GoalManagerDeps,
  GoalPauseOptions,
  GoalState,
  GoalStatus,
} from './goal-state.js';
export {
  evaluateGoal,
  buildGoalEvaluationPrompt,
  parseGoalEvaluation,
  DEFAULT_EVALUATOR_TIMEOUT_MS,
} from './goal-evaluator.js';
export type { GoalEvaluation, GoalEvaluatorDeps } from './goal-evaluator.js';
export {
  buildGoalTools,
  GOAL_SET_TOOL_NAME,
  GOAL_CLEAR_TOOL_NAME,
  GOAL_STATUS_TOOL_NAME,
  GOAL_PAUSE_TOOL_NAME,
  GOAL_RESUME_TOOL_NAME,
} from './goal-tools.js';
export type { GoalToolsDeps } from './goal-tools.js';
export {
  GoalContinuationCoordinator,
  GOAL_WAIT_BACKOFF_BASE_MS,
  GOAL_WAIT_BACKOFF_MAX_MS,
} from './goal-continuation.js';
export type {
  GoalContinuationDeps,
  GoalContinuationScheduler,
  GoalExternalTurnStart,
  GoalExternalTurnSettler,
  GoalSessionCloseOperation,
  GoalTaskGateDecision,
  GoalTaskGateDeps,
  GoalTaskGateTrace,
  GoalTurnAdmission,
  GoalTurnOutcome,
} from './goal-continuation.js';
export { SessionActivityRegistry, drainGoalTurn } from './goal-turn-lifecycle.js';
export type { DrainGoalTurnInput, SessionActivityLease } from './goal-turn-lifecycle.js';

export {
  // skills-metadata
  MAX_SKILL_BODY_CHARS,
  MAX_SKILL_TOOL_BODY_CHARS,
  parseSkillFrontMatter,
  validateSkillMetadata,
  // skills-state
  clearResolvedSkillPreferenceReviews,
  encodeSkillRuntimePreferences,
  getSkillRuntimePreference,
  isSkillPreferenceReviewPending,
  migrateSkillRuntimePreferences,
  patchSkillRuntimePreference,
  readSkillRuntimeState,
  resolveSkillPreferenceTarget,
  writeSkillRuntimeState,
  writeSkillRuntimePreferences,
  // managed skill sources
  listManagedSkillSources,
  MANAGED_SKILL_CATEGORIES,
  normalizeManagedSkillCategory,
  readManagedSkillSources,
  readManagedSkillSource,
  resolveManagedSkillSourcesRoot,
  toManagedSkillSourceEntry,
  // skill governance
  createBundledSkillLock,
  createManagedSkillLock,
  getBundledSkillSource,
  invalidSkillLockStatus,
  isCurrentBundledSkillLock,
  MANAGED_SKILL_BASELINE_RELATIVE_PATH,
  missingSkillLockStatus,
  validateSkillLock,
  BUNDLED_SKILL_CATALOG,
  // skills-discovery
  resolveSkillDiscoveryPaths,
  scanSkills,
  scanSkillsWithDiagnostics,
  scanWorkspaceSkills,
  scanWorkspaceSkillsWithDiagnostics,
  // skills-context
  MAX_SKILLS_PROMPT_CHARS,
  MIN_SKILLS_PROMPT_TOKENS,
  MAX_SKILLS_PROMPT_TOKENS,
  SKILLS_PROMPT_CONTEXT_RATIO,
  resolveSkillsPromptCharBudget,
  buildSkillsPromptFragment,
  buildSkillsPromptFragmentFromInventoryWithReport,
  buildSkillsPromptFragmentWithReport,
  selectSkillsForContext,
  selectSkillScanForContext,
  searchSkills,
  loadSkillInstructions,
  gateSkillsByHostCapabilities,
  // skills-agent-tools
  buildSkillAgentTool,
  buildSkillAgentToolFromInventory,
  buildSkillSearchAgentTool,
  buildSkillSearchAgentToolFromInventory,
  SkillShadowSelectionTracker,
  SKILL_TOOL_NAME,
  SKILL_SEARCH_TOOL_NAME,
  // skills-starter
  buildStarterSkillTemplate,
} from './skills.js';
export {
  // path-containment (contained I/O moved in #1408)
  readContainedRegularFile,
  readContainedRegularTextFile,
  writeContainedRegularTextFile,
  isRecord,
} from './path-containment.js';
export {
  listInvocableSkills,
  resolveSkillInvocations,
  composeSkillInvocationMessage,
  parseSkillInvocationTokens,
  prepareSkillInvocationMessage,
  SKILL_INVOCATION_TOKEN_SOURCE,
  stripSkillInvocationTokens,
} from './skill-invocation.js';
export type {
  InvocableSkillEntry,
  PreparedSkillInvocationMessage,
  SkillInvocationFailure,
  SkillInvocationResolution,
  SkillInvocationResult,
  SkillInvocationToken,
} from './skill-invocation.js';
export type {
  SkillInvocationFailureReason,
  SkillInvocationMode,
  SkillInvocationReceipt,
} from './skill-invocation-receipt.js';
export { isPathInside, isSafeSkillId, toRelative } from './path-containment.js';
export type { PathInsideApi } from './path-containment.js';
export type {
  // skills-state
  ResolveSkillPreferenceTargetResult,
  SkillPreferenceMigration,
  SkillPreferenceTarget,
  SkillRuntimeStatus,
  SkillRuntimePreference,
  SkillRuntimeStateReadResult,
  // managed skill sources
  ManagedSkillCategory,
  ManagedSkillSourceEntry,
  ManagedSkillSourceRecord,
  ReadManagedSkillSourcesResult,
  ReadManagedSkillSourceResult,
  // skill governance
  BundledSkillSource,
  ManagedSkillUpdateStatus,
  ManagedSourceSnapshot,
  SkillGovernanceStatus,
  SkillLockFile,
  SkillLockValidationCode,
  SkillSourceType,
  SkillValidationStatus,
  // skills-discovery
  SkillScope,
  SkillDiscoverySource,
  SkillDiscoveryEntry,
  SkillSource,
  SkillSourceResolver,
  RuntimeSkillDefinition,
  ScannedSkill,
  SkillScanDiagnostic,
  SkillScanResult,
  SkillDiscoveryDiagnostic,
  RejectedSkillDefinition,
  // skills-metadata
  SkillManifest,
  SkillValidationSeverity,
  SkillValidationCode,
  SkillValidationIssue,
  SkillMetadataValidationResult,
  // skills-context
  HostCapabilities,
  HostCapabilitiesResolver,
  SkillCatalogBudgetOptions,
  SkillContextDecisionReason,
  SkillContextDecision,
  SkillSelectionReport,
  SkillContextSelection,
  SkillsPromptFragmentResult,
  SkillSearchMatch,
  SkillSearchResult,
  SkillHostCompatibility,
  GatedSkill,
  LoadedSkillInstructions,
  LoadSkillInstructionsResult,
  // skills-agent-tools
  SkillInventoryResolver,
  SkillToolOptions,
} from './skills.js';
