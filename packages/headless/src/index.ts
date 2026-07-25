// Public surface of @maka/headless. Deliberately curated — the workspace copy
// (sandbox.ts), the verification runner (evaluator.ts), backend wiring
// (backends.ts), Harbor cells, and RSI controller internals are owned by
// package-local entrypoints, not the root API. Minimal usage is
// `runExperiment(config, task, { storageRoot })`.
export { runPromptOptimizationRun } from './prompt-optimization-run.js';
export {
  assertProviderRequestTraceComplete,
  readProviderRequestTrace,
} from './provider-request-trace.js';
export type {
  AssertProviderRequestTraceCompleteOptions,
  ProviderRequestTraceAnalysis,
  ProviderRequestTraceAttemptAnalysis,
  ProviderRequestTraceCaptureAnalysis,
  ProviderRequestTraceDiagnostic,
  ProviderRequestTraceDiagnosticCode,
  ProviderRequestTraceIdentity,
} from './provider-request-trace.js';
export type { MakaChangeAuditRecord } from './change-audit.js';
export type {
  PromptOptimizationRunInput,
  PromptOptimizationRunResult,
} from './prompt-optimization-run.js';
export type {
  BenchmarkAdapter,
  BenchmarkAdapterRegistry,
  BenchmarkInstanceRef,
  BenchmarkVerifierInput,
  BenchmarkVerifierOutput,
} from './benchmark-adapters.js';
export { resolveBenchmarkAdapter } from './benchmark-adapters.js';
export {
  EXTERNAL_ISOLATED_WORKSPACE_EXECUTOR_FACTS,
  ISOLATED_WORKSPACE_EXECUTOR_FACTS,
  isolatedToolExecutorToWorkspaceExecutor,
} from './workspace-executor-adapter.js';
export type { IsolatedWorkspaceExecutorAdapter } from './workspace-executor-adapter.js';
export type {
  ArtifactFreezeResult,
  BenchmarkContract,
  CommandVerifierSpec,
  Config,
  ResultRecord,
  SubmittedSnapshot,
  SweBenchVerifierSpec,
  Task,
  TaskVerification,
  TerminalBenchVerifierSpec,
  VerifierSpec,
} from './contracts.js';
export type { FinalScore, FinalScorer, FinalScorerInput } from './scorer.js';
export type {
  AutonomousDecision,
  AutonomousResultTaxonomy,
  EnvNetworkSecretPolicy,
  FeedbackObservation,
  HeavyTaskAcceptanceCheck,
  HeavyTaskCompactEvidenceEnvelope,
  HeavyTaskDiffSummary,
  HeavyTaskEvidenceKind,
  HeavyTaskEvidenceProvenanceLinkedEvent,
  HeavyTaskEvidenceRecordedEvent,
  HeavyTaskOutputSummary,
  HeavyTaskInventoryItem,
  HeavyTaskInventoryRecordedEvent,
  HeavyTaskInventoryState,
  HeavyTaskModeRecordedEvent,
  HeavyTaskArtifactEvidence,
  HeavyTaskCommandEvidence,
  HeavyTaskProgressSource,
  HeavyTaskSelfCheckRecordedEvent,
  HeavyTaskSelfCheckEvidenceLinkedEvent,
  HeavyTaskSelfCheckFreshness,
  HeavyTaskSelfCheckFreshnessReason,
  HeavyTaskSelfCheckGateAction,
  HeavyTaskSelfCheckGateRecordedEvent,
  HeavyTaskSelfCheckGateState,
  HeavyTaskSelfCheckStatus,
  HeavyTaskSemanticSelfCheckState,
  HeavyTaskSelfCheckProjection,
  HeavyTaskSourceGuardResult,
  HeavyTaskToolEvidenceName,
  HeavyTaskTodoItem,
  HeavyTaskTodoState,
  HeavyTaskTodosRecordedEvent,
  HeavyTaskTruncationRef,
  HeadlessInterventionMode,
  IsolationPolicyRecordedEvent,
  PermissionDecision,
  PermissionDecisionRecordedEvent,
  PermissionDecisionSource,
  PermissionGrantRecordedEvent,
  PermissionRequestRecordedEvent,
  PermissionResourceScope,
  ResultTaxonomy,
  ScoreResult,
  SelfCheckObservation,
  TaskAttempt,
  TaskAttemptExecutionLinkedEvent,
  TaskAttemptStatus,
  TaskDefinition,
  TaskEvent,
  TaskEventCorrupt,
  TaskInboxItem,
  TaskInboxItemRecordedEvent,
  TaskInboxItemResolvedEvent,
  TaskInboxKind,
  TaskInboxStatus,
  TaskInterventionPolicy,
  TaskRunArtifact,
  TaskRunArtifactAuthority,
  TaskRunArtifactAuthoritySource,
  TaskRunArtifactDescriptor,
  TaskRunArtifactKind,
  TaskRunArtifactRecordedEvent,
  TaskIsolationFacts,
  TaskPermissionGrant,
  TaskPermissionRequest,
  TaskRunAbortedEvent,
  TaskRunBlockedEvent,
  TaskRunBudgetExhaustedEvent,
  TaskRunCancelledEvent,
  TaskRunCompletedEvent,
  TaskRunCreatedEvent,
  TaskRunFailedEvent,
  TaskRunIncompleteEvent,
  TaskRunNeedsApprovalEvent,
  TaskRunParkedState,
  TaskRunPolicyDeniedEvent,
  TaskRunQueuedEvent,
  TaskRunStartedEvent,
  TaskRunVerifyingEvent,
  TaskRun,
  TaskRunError,
  TaskRunResult,
  TaskRunStatus,
  ToolExecutorIdentity,
  ToolExecutorIdentityRecordedEvent,
  VerifierResult,
  WorkspaceLeaseRecordedEvent,
  WorkspaceLeaseFacts,
} from './task-contracts.js';
export {
  TASK_RUN_TERMINAL_STATUSES,
  isFailureTaxonomy,
  isTerminalTaskRunStatus,
  taxonomyFromResultRecord,
} from './task-contracts.js';
export {
  commandResourceScope,
  hashNormalizedArgs,
  matchPermissionGrant,
  normalizePermissionArgs,
  permissionPreview,
  resourceScopeEquals,
  type NormalizedPermissionArgs,
} from './permission-grants.js';
export type { TaskRunProjection } from './task-run-projection.js';
export { projectTaskRun } from './task-run-projection.js';
export type {
  TaskEventLedgerEntry,
  TaskRunReader,
  TaskRunWriter,
} from './task-run-store.js';
export { createInMemoryTaskRunStore } from './task-run-store.js';
export {
  openHeadlessStorageForRead,
  type HeadlessStorageReader,
} from './headless-storage.js';
export {
  TASK_RUN_INSPECT_SCHEMA_VERSION,
  inspectTaskRun,
  renderTaskRunInspectTree,
} from './task-run-inspect.js';
export type {
  InspectTaskRunDependencies,
  TaskRunInspectAgentRun,
  TaskRunInspectAttempt,
  TaskRunInspectCompactionCheckpoint,
  TaskRunInspectCoverageStatus,
  TaskRunInspectDiagnostic,
  TaskRunInspectDiagnosticCode,
  TaskRunInspectDocument,
  TaskRunInspectSelfCheck,
  TaskRunInspectSeverity,
  TaskRunInspectSummary,
  TaskRunInspectTaskEventSource,
  TaskRunInspectToolFact,
  TaskRunInspectToolSummary,
} from './task-run-inspect.js';
export type { TaskEventsFromResultRecordOptions } from './task-run-adapter.js';
export {
  resultRecordFromTaskRunProjection,
  taskDefinitionFromTask,
  taskEventsFromResultRecord,
} from './task-run-adapter.js';
export type { RunTaskOnceDeps, RunTaskOnceResult } from './task-agent-controller.js';
export { runTaskOnce, TaskAgentController } from './task-agent-controller.js';
export type { TaskAttemptExecutionEvidenceInput } from './task-execution-lineage.js';
export { taskAttemptExecutionEvidence } from './task-execution-lineage.js';
export type {
  TaskEvidenceRuntimeProvenanceInput,
  TaskEvidenceRuntimeProvenanceLink,
} from './task-evidence-provenance.js';
export {
  runtimeToolFactCoverage,
  taskEvidenceRuntimeProvenanceLinks,
} from './task-evidence-provenance.js';
export type {
  SelfCheckEvidenceBindingInput,
  SelfCheckEvidenceBindingResult,
} from './task-self-check-evidence.js';
export { bindSelfCheckEvidence } from './task-self-check-evidence.js';
export type {
  AutonomousDecisionInput,
  AutonomousDecisionPolicy,
  AutonomousDecisionPolicyResult,
  AutonomousLoopBudget,
  FeedbackPromptInput,
  LoopBudgetSnapshot,
  RunAutonomousTaskOptions,
  RunAutonomousTaskResult,
  SelfCheckInput,
  SelfCheckOutput,
  SelfCheckPolicy,
} from './autonomous-agent-loop.js';
export { AutonomousAgentLoop, runAutonomousTask } from './autonomous-agent-loop.js';
export { runExperiment, type RunExperimentDeps } from './runner.js';
export { runMatrix, type ExperimentSpec } from './matrix.js';
export {
  MATRIX_CELL_SEPARATOR,
  isRetryableTaxonomy,
  matrixCellKey,
  planMatrixRetry,
  readMatrixPriorRecords,
  readTaskRunStoreRecords,
  type MatrixCellDecision,
  type MatrixRetryPlanOptions,
} from './matrix-resume.js';
export { defaultFinalScorer } from './scorer.js';
export {
  readResults,
  summarizeMatrix,
  writeResults,
  toComparisonTable,
  type MatrixSummary,
} from './results.js';
export {
  classifyExternalHarborBenchmarkFailure,
  type ExternalHarborBenchmarkFailureClassification,
  type ExternalHarborBenchmarkFailureInput,
  type ExternalHarborBenchmarkFailureKind,
} from './harbor-failure-policy.js';
export {
  buildPierRunArgs,
  createPierProviderProxyHub,
  createPierTaskRunner,
  PierInfraError,
  PIER_PROVIDER_PROXY_DEFAULT_PORT,
  type BuildPierRunArgsInput,
  type PierAgent,
  type PierProcessRunner,
  type PierProviderProxyHub,
  type PierProviderProxyHubOptions,
  type PierRunRequest,
  type PierRunResult,
  type PierTaskPricing,
  type PierTaskRunnerOptions,
} from './pier-task-runner.js';
export type {
  BuildMakaAheTargetSnapshotOptions,
  MakaAheRunEvidence,
  MakaAheRunEvidenceOptions,
  MakaAheAgentRunEvidenceByTaskRun,
  MakaAheAgentRunEvidenceSource,
  MakaAheGeneratedRefsByTaskRun,
  MakaAheGeneratedTaskRefs,
  WriteMakaAheEvidenceExportOptions,
  WriteMakaAheEvidenceExportResult,
} from './ahe-evidence-export.js';
export {
  MAKA_AHE_EVIDENCE_EXPORT_SOURCE_LABEL,
  buildMakaAheTargetSnapshot,
  makaAheEvidenceFromTaskRunProjections,
  validateMakaAheSourceRefs,
  writeMakaAheEvidenceExport,
} from './ahe-evidence-export.js';
export type {
  MakaAheArtifactRef,
  MakaAheChangeEvaluation,
  MakaAheChangeEvaluationCell,
  MakaAheChangeManifest,
  MakaAheComponentCategory,
  MakaAheCurrentTargetProtocolVersion,
  MakaAheEvidenceCase,
  MakaAheExecutionLineage,
  MakaAheExecutionLineageAgentRun,
  MakaAheExecutionLineageAttempt,
  MakaAheExecutionLineageGap,
  MakaAheGitIdentity,
  MakaAheHarnessResults,
  MakaAheLegacyTargetProtocolVersion,
  MakaAheLegacyTargetSnapshot,
  MakaAheLegacyRunResult,
  MakaAheResultStatus,
  MakaAheRunResult,
  MakaAheRunResultDocument,
  MakaAheScoreAuthority,
  MakaAheSnapshotIdentity,
  MakaAheSourceManifest,
  MakaAheSourceManifestEntry,
  MakaAheSourceRef,
  MakaAheTargetComponent,
  MakaAheTargetProtocolVersion,
  MakaAheTargetSnapshot,
  MakaAheTargetSnapshotDocument,
  MakaAheTargetSourceLabel,
  MakaAheTraceIndex,
  MakaAheTraceIndexEntry,
  MakaAheTransitionStatus,
  MakaAheValidationIssue,
  MakaAheValidationResult,
} from './ahe-target-protocol.js';
export {
  MAKA_AHE_COMPONENT_CATEGORIES,
  MAKA_AHE_CURRENT_COMPONENTS,
  MAKA_AHE_EXECUTION_LINEAGE_SCHEMA_VERSION,
  MAKA_AHE_RESULT_STATUSES,
  MAKA_AHE_RUN_RESULT_SCHEMA_VERSION,
  MAKA_AHE_SCORE_AUTHORITIES,
  MAKA_AHE_SUPPORTED_TARGET_PROTOCOL_VERSIONS,
  MAKA_AHE_TARGET_PROTOCOL_VERSION,
  MAKA_AHE_TARGET_PROTOCOL_VERSION_V1,
  MAKA_AHE_TARGET_SOURCE_LABEL,
  MAKA_AHE_TRANSITION_STATUSES,
  makaAheSourceManifestDigest,
  makaAheTargetSnapshotId,
  validateMakaAheChangeManifest,
  validateMakaAheExecutionLineage,
  validateMakaAheRunResult,
  validateMakaAheTargetComponents,
  validateMakaAheTargetSnapshot,
} from './ahe-target-protocol.js';
export type {
  TaskRunExport,
  WriteTaskRunExportOptions,
  WriteTaskRunExportResult,
} from './result-export.js';
export {
  exportContentHash,
  renderTaskRunMarkdown,
  taskRunExportFromProjection,
  writeTaskRunExport,
} from './result-export.js';
export { normalizeVerifier } from './verifier.js';
export { DEFAULT_HEADLESS_SYSTEM_PROMPT } from './system-prompts.js';
export {
  appendHeavyTaskPolicyToSystemPrompt,
  buildHeavyTaskSystemPromptPolicy,
  FORBIDDEN_HEAVY_TASK_POLICY_TERMS,
  HEAVY_TASK_POLICY_VERSION,
  resolveHeavyTaskMode,
  type HeavyTaskModeSelection,
  type HeavyTaskModeTriggerSource,
} from './heavy-task-policy.js';
export {
  appendEconomyTaskPolicyToSystemPrompt,
  buildEconomyTaskSystemPromptPolicy,
  ECONOMY_TASK_POLICY_VERSION,
  resolveEconomyTaskMode,
  type EconomyTaskModeSelection,
  type EconomyTaskModeTriggerSource,
} from './economy-task-policy.js';
export type {
  HeavyTaskInventorySubmitInput,
  HeavyTaskProgressRecorder,
  HeavyTaskTodoUpdateInput,
} from './heavy-task-progress.js';
export {
  buildHeavyTaskProgressTools,
  createHeavyTaskProgressRecorder,
  heavyTaskInventoryItemSchema,
  heavyTaskInventorySubmitSchema,
  heavyTaskTodoItemSchema,
  heavyTaskTodoUpdateSchema,
  HEAVY_TASK_PROGRESS_TOOL_NAMES,
  renderHeavyTaskProgressForPrompt,
} from './heavy-task-progress.js';
export type {
  HeavyTaskPublicSelfCheckValidation,
  HeavyTaskSelfCheckPlanSubmitInput,
  HeavyTaskSelfCheckRecorder,
  HeavyTaskSelfCheckSubmitInput,
} from './heavy-task-self-check.js';
export {
  auditSelfCheckPlanConsistency,
  buildHeavyTaskSelfCheckTools,
  createHeavyTaskSelfCheckRecorder,
  HEAVY_TASK_SELF_CHECK_TOOL_NAMES,
  heavyTaskArtifactEvidenceSchema,
  heavyTaskCommandEvidenceSchema,
  heavyTaskSelfCheckPlanArtifactSchema,
  heavyTaskSelfCheckPlanSubmitSchema,
  heavyTaskSelfCheckSubmitSchema,
  isAcceptedHeavyTaskSelfCheck,
  renderHeavyTaskSelfCheckForPrompt,
  renderSelfCheckPlanAuditDiagnostic,
  validateHeavyTaskPublicSelfCheckPlan,
  validateHeavyTaskPublicSelfCheck,
} from './heavy-task-self-check.js';
export type {
  CompactTextEvidenceOptions,
  HeavyTaskCompactEvidenceInput,
  HeavyTaskEvidenceRecorder,
  HeavyTaskToolEvidenceInput,
} from './heavy-task-evidence.js';
export {
  compactArtifactEvidence,
  compactSelfCheckEvidence,
  compactTextEvidence,
  compactToolEvidence,
  createHeavyTaskEvidenceRecorder,
  DEFAULT_EXPORT_EVIDENCE_LIMIT,
  DEFAULT_PROMPT_EVIDENCE_LIMIT,
  DEFAULT_TEXT_EVIDENCE_LIMIT_CHARS,
  HEAVY_TASK_EVIDENCE_SCHEMA_VERSION,
  renderHeavyTaskEvidenceForPrompt,
} from './heavy-task-evidence.js';
export type {
  HeavyTaskCompletionInput,
  HeavyTaskCompletionStatus,
  HeavyTaskRuntimeCapKind,
  HeavyTaskSemanticStatus,
} from './heavy-task-finalization.js';
export { evaluateHeavyTaskCompletionStatus } from './heavy-task-finalization.js';
export type {
  HeadlessBackendContext,
  IsolatedCommandInput,
  IsolatedCommandResult,
  IsolatedGlobInput,
  IsolatedGlobResult,
  IsolatedGrepInput,
  IsolatedGrepResult,
  IsolatedReadFileInput,
  IsolatedReadFileResult,
  IsolatedToolExecutor,
  IsolatedToolExecutionControl,
  IsolatedWriteFileInput,
  IsolatedWriteFileResult,
  RealBackendIsolation,
} from './isolation.js';
export type { HeadlessSessionCapabilities } from './session-capabilities.js';
export { ISOLATED_HEADLESS_TOOL_NAMES } from './isolation.js';
export {
  buildIsolatedBashTool,
  buildIsolatedEditTool,
  buildIsolatedGlobTool,
  buildIsolatedGrepTool,
  buildIsolatedHeadlessToolAvailability,
  buildIsolatedHeadlessTools,
  buildIsolatedReadTool,
  buildIsolatedWriteTool,
} from './tools.js';
