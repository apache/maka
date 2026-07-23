import type { ExecutionEvidenceRef, WorkspaceRevisionRef } from '@maka/core/execution-evidence';
import type { ResultRecord, TaskVerification, VerifierSpec } from './contracts.js';

export type TaskRunStatus =
  | 'queued'
  | 'created'
  | 'running'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'incomplete'
  | 'blocked'
  | 'policy_denied'
  | 'budget_exhausted'
  | 'needs_approval'
  | 'aborted'
  | 'cancelled';
export type TaskAttemptStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'incomplete'
  | 'blocked'
  | 'policy_denied'
  | 'budget_exhausted'
  | 'needs_approval'
  | 'aborted'
  | 'cancelled';

export const TASK_RUN_TERMINAL_STATUSES = [
  'completed',
  'failed',
  'incomplete',
  'blocked',
  'policy_denied',
  'budget_exhausted',
  'aborted',
  'cancelled',
] as const;

export function isTerminalTaskRunStatus(status: TaskRunStatus): boolean {
  return (TASK_RUN_TERMINAL_STATUSES as readonly TaskRunStatus[]).includes(status);
}

export type AutonomousResultTaxonomy =
  | 'passed'
  | 'verification_failed'
  | 'verification_error'
  | 'agent_failed'
  | 'agent_incomplete'
  | 'invalid_setup'
  | 'unsupported_adapter'
  | 'isolation_required'
  | 'setup_failed'
  | 'infra_failed'
  | 'policy_denied'
  | 'budget_exhausted'
  | 'aborted'
  | 'blocked'
  | 'cancelled';

export type ResultTaxonomy = AutonomousResultTaxonomy;

export type HeadlessInterventionMode = 'fail_closed' | 'park';

export interface TaskInterventionPolicy {
  mode: HeadlessInterventionMode;
  approvalTimeoutMs?: number;
  allowBudgetExtensionRequests?: boolean;
  allowAmbiguousFailureTriage?: boolean;
}

export function taxonomyFromResultRecord(record: ResultRecord): AutonomousResultTaxonomy {
  if (record.status === 'completed') {
    if (record.passed) return 'passed';
    if (record.errorClass === 'unsupported_adapter') return 'unsupported_adapter';
    if (record.errorClass === 'invalid_setup') return 'invalid_setup';
    if (record.errorClass === 'isolation_required') return 'isolation_required';
    return record.exitCode === null ? 'verification_error' : 'verification_failed';
  }

  const errorClass = record.errorClass?.toLowerCase() ?? '';
  const error = record.error?.toLowerCase() ?? '';
  const failureText = `${errorClass} ${error}`;
  if (includesAny(failureText, ['cancelled', 'canceled'])) return 'cancelled';
  if (includesAny(failureText, ['abort', 'aborted'])) return 'aborted';
  if (includesAny(failureText, ['budget', 'limit', 'limits_exceeded', 'max_steps', 'max_tokens'])) {
    return 'budget_exhausted';
  }
  if (includesAny(failureText, ['blocked', 'waiting_for_user', 'waiting_permission']))
    return 'blocked';
  if (includesAny(failureText, ['policy', 'permission', 'denied'])) return 'policy_denied';
  if (
    includesAny(failureText, [
      'incomplete',
      'tool_calls',
      'tool_step_cap',
      'no_submit',
      'truncated',
    ])
  )
    return 'agent_incomplete';
  if (includesAny(failureText, ['verification_error'])) return 'verification_error';
  if (includesAny(failureText, ['verification_failed'])) return 'verification_failed';
  if (includesAny(failureText, ['unsupported_adapter'])) return 'unsupported_adapter';
  if (includesAny(failureText, ['invalid_setup'])) return 'invalid_setup';
  if (includesAny(failureText, ['isolation_required', 'isolated executor']))
    return 'isolation_required';
  if (includesAny(failureText, ['setup', 'fixture', 'config', 'preflight'])) return 'setup_failed';
  if (
    includesAny(failureText, [
      'infra',
      'infrastructure',
      'harbor',
      'container',
      'docker',
      'fetch',
      'materialize',
      'network',
    ])
  ) {
    return 'infra_failed';
  }
  if (
    errorClass.includes('backend') ||
    errorClass.includes('agent') ||
    errorClass.includes('runtime') ||
    record.sessionId ||
    record.runId
  ) {
    return 'agent_failed';
  }
  return 'setup_failed';
}

export function isFailureTaxonomy(taxonomy: AutonomousResultTaxonomy): boolean {
  return taxonomy !== 'passed';
}

function includesAny(value: string, needles: readonly string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

export interface TaskDefinition {
  id: string;
  instruction: string;
  workspaceDir: string;
  verification: TaskVerification;
  metadata?: Record<string, unknown>;
}

export interface TaskRunError {
  message: string;
  class?: string;
  details?: Record<string, unknown>;
}

export interface TaskRunResult {
  passed: boolean;
  taxonomy: AutonomousResultTaxonomy;
  verifierResultId?: string;
  scoreResultId?: string;
}

export interface TaskRun {
  taskRunId: string;
  taskId: string;
  configId: string;
  status: TaskRunStatus;
  startedAt?: number;
  finishedAt?: number;
  sessionId?: string;
  agentRunId?: string;
  result?: TaskRunResult;
  error?: TaskRunError;
}

export interface TaskAttempt {
  attemptId: string;
  taskRunId: string;
  startedAt: number;
  finishedAt?: number;
  status: TaskAttemptStatus;
  sessionId?: string;
  agentRunId?: string;
  /** Ordered references to every AgentRun that contributed to this attempt. */
  executionLineage: ExecutionEvidenceRef[];
  error?: TaskRunError;
}

export interface SelfCheckObservation {
  id: string;
  taskRunId: string;
  attemptId?: string;
  ts: number;
  summary: string;
  details?: Record<string, unknown>;
}

export interface FeedbackObservation {
  id: string;
  taskRunId: string;
  attemptId?: string;
  ts: number;
  source: 'verifier' | 'human' | 'runtime' | 'system';
  summary: string;
  details?: Record<string, unknown>;
}

export interface AutonomousDecision {
  id: string;
  taskRunId: string;
  attemptId?: string;
  ts: number;
  decision: 'continue' | 'retry' | 'stop' | 'abort';
  reason?: string;
  details?: Record<string, unknown>;
}

export type TaskRunArtifactKind =
  | 'container_workspace'
  | 'workspace_diff'
  | 'source_code'
  | 'generated_output'
  | 'benchmark_manifest'
  | 'benchmark_repro'
  | 'submitted_snapshot'
  | 'runtime_trace'
  | 'other';

export type TaskRunArtifactAuthoritySource =
  | 'official_harbor_verifier'
  | 'self_check'
  | 'container_capture'
  | 'runtime'
  | 'system';

export interface TaskRunArtifactAuthority {
  source: TaskRunArtifactAuthoritySource;
  authoritative: boolean;
  label?: string;
}

export interface TaskRunArtifact {
  schemaVersion: 1;
  artifactId: string;
  taskRunId: string;
  attemptId?: string;
  ts: number;
  kind: TaskRunArtifactKind;
  authority: TaskRunArtifactAuthority;
  label?: string;
  path?: string;
  workspacePath?: string;
  artifactRef?: string;
  hash?: string;
  mimeType?: string;
  metadata?: Record<string, unknown>;
}

export type TaskRunArtifactDescriptor = Omit<
  TaskRunArtifact,
  'schemaVersion' | 'artifactId' | 'taskRunId' | 'ts'
> & {
  artifactId?: string;
  taskRunId?: string;
  ts?: number;
};

export interface VerifierResult {
  id: string;
  taskRunId: string;
  attemptId?: string;
  ts: number;
  kind: VerifierSpec['kind'];
  passed: boolean;
  exitCode?: number | null;
  command?: string;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  error?: string;
  errorClass?: string;
  score?: number;
  maxScore?: number;
  authority?: TaskRunArtifactAuthority;
  artifacts?: TaskRunArtifact[];
  details?: Record<string, unknown>;
  submittedSnapshotId?: string;
  scoringWorkspaceId?: string;
}

export interface ScoreResult {
  id: string;
  taskRunId: string;
  attemptId?: string;
  ts: number;
  passed: boolean;
  scored?: boolean;
  eligible?: boolean;
  errorClass?: string;
  excludedReason?: string;
  score?: number;
  maxScore?: number;
  taxonomy: AutonomousResultTaxonomy;
  authority?: TaskRunArtifactAuthority;
  details?: Record<string, unknown>;
}

export interface HeavyTaskModeFacts {
  schemaVersion: 1;
  enabled: boolean;
  triggerSource: 'default' | 'config' | 'task_metadata';
  triggerReason: string;
  policyVersion: string;
}

export interface EconomyTaskModeFacts {
  schemaVersion: 1;
  enabled: boolean;
  triggerSource: 'default' | 'config' | 'task_metadata';
  triggerReason: string;
  policyVersion: string;
}

export interface HeavyTaskProgressSource {
  kind: 'model_tool';
  toolCallId: string;
  sessionId?: string;
  /** AgentRun that executed the tool. Optional only for legacy evidence. */
  agentRunId?: string;
  turnId?: string;
}

export interface HeavyTaskInventoryItem {
  path: string;
  kind: 'file' | 'directory' | 'artifact' | 'command' | 'unknown';
  status: 'observed' | 'planned' | 'unknown';
  purpose?: string;
  evidence?: string;
}

export interface HeavyTaskInventoryState {
  schemaVersion: 1;
  inventoryId: string;
  taskRunId: string;
  attemptId?: string;
  ts: number;
  summary: string;
  items: HeavyTaskInventoryItem[];
  openQuestions?: string[];
  source: HeavyTaskProgressSource;
}

export interface HeavyTaskTodoItem {
  id: string;
  content: string;
  kind?:
    | 'inspect'
    | 'implement'
    | 'runnable_artifact'
    | 'public_check'
    | 'repair'
    | 'final_self_check';
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority: 'high' | 'medium' | 'low';
  evidence?: string;
}

export interface HeavyTaskTodoState {
  schemaVersion: 1;
  todoSetId: string;
  taskRunId: string;
  attemptId?: string;
  ts: number;
  items: HeavyTaskTodoItem[];
  source: HeavyTaskProgressSource;
}

export type HeavyTaskSelfCheckStatus = 'pass' | 'fail' | 'inconclusive';

export interface HeavyTaskCommandEvidence {
  command: string;
  exitCode?: number | null;
  timedOut?: boolean;
  outputExcerpt?: string;
  artifactRefs?: string[];
}

export interface HeavyTaskArtifactEvidence {
  path: string;
  kind: 'file' | 'directory' | 'log' | 'build_output' | 'generated_output' | 'other';
  exists?: boolean;
  sizeBytes?: number;
  hash?: string;
  metadata?: Record<string, unknown>;
}

export interface HeavyTaskSelfCheckExecutionHygiene {
  sandbox?: {
    root: string;
    strategy?: 'scratch_dir' | 'copied_inputs' | 'read_only_deliverable_refs';
    inputPaths?: string[];
    commandCwd?: string;
    outputPolicy?: 'scratch_only' | 'read_only_deliverable_refs';
    publicReason?: string;
  };
  scratchUsed?: boolean;
  scratchPath?: string;
  cleanupPerformed?: boolean;
  workspaceSideEffects?: 'none' | 'cleaned' | 'present' | 'unknown';
  remainingSideEffectPaths?: string[];
  workspaceGuard?: {
    checked?: boolean;
    checkedPaths?: string[];
    beforeListingCommand?: string;
    afterListingCommand?: string;
    addedPaths?: string[];
    modifiedPaths?: string[];
    removedPaths?: string[];
    publicReason?: string;
  };
  publicReason?: string;
}

export interface HeavyTaskSourceGuardResult {
  status: 'accepted' | 'rejected';
  checkedAt: number;
  categories: string[];
  publicReason: string;
}

export interface HeavyTaskSelfCheckPlanArtifact {
  path: string;
  purpose: string;
  publicReason: string;
}

export interface HeavyTaskSelfCheckScratchPlan {
  root: string;
  expectedGeneratedPaths?: string[];
  publicReason: string;
}

export interface HeavyTaskSelfCheckWorkspaceGuardPlan {
  checkedPaths: string[];
  expectedAddedPaths?: string[];
  expectedGeneratedPathsOutsideScratch?: string[];
  publicReason: string;
}

export interface HeavyTaskSelfCheckPlanState {
  schemaVersion: 1;
  planId: string;
  taskRunId: string;
  attemptId?: string;
  ts: number;
  finalArtifacts: HeavyTaskSelfCheckPlanArtifact[];
  selfCheckScratch: HeavyTaskSelfCheckScratchPlan;
  workspaceGuardPlan: HeavyTaskSelfCheckWorkspaceGuardPlan;
  publicReason: string;
  guard: HeavyTaskSourceGuardResult & { status: 'accepted' };
  source: HeavyTaskProgressSource;
}

export type HeavyTaskSelfCheckPlanAuditStatus = 'pass' | 'fail' | 'unknown';

export type HeavyTaskSelfCheckPlanRiskFlag =
  | 'missing_self_check_plan'
  | 'planned_final_artifact_added'
  | 'unplanned_added_path'
  | 'scratch_escape'
  | 'plan_drift';

export interface HeavyTaskSelfCheckPlanAuditSummary {
  status: HeavyTaskSelfCheckPlanAuditStatus;
  riskFlags: HeavyTaskSelfCheckPlanRiskFlag[];
  diagnostics: string[];
}

export interface HeavyTaskWorkspaceObservationEntry {
  path: string;
  kind: 'file' | 'directory' | 'symlink' | 'other';
  symlinkTarget?: string;
  sizeBytes?: number;
  sha256?: string;
}

export interface HeavyTaskWorkspaceObservationState {
  schemaVersion: 1;
  observationId: string;
  taskRunId: string;
  ts: number;
  roots: string[];
  entries: HeavyTaskWorkspaceObservationEntry[];
  status: 'ok' | 'error';
  command: string;
  /** Deterministic digest of the public manifest when observation succeeded. */
  revision?: WorkspaceRevisionRef;
  errorExcerpt?: string;
  source: { kind: 'system'; label: string };
}

export interface HeavyTaskSemanticSelfCheckState {
  schemaVersion: 1;
  selfCheckId: string;
  taskRunId: string;
  attemptId?: string;
  ts: number;
  status: HeavyTaskSelfCheckStatus;
  publicReason: string;
  commandEvidence: HeavyTaskCommandEvidence[];
  artifactEvidence: HeavyTaskArtifactEvidence[];
  executionHygiene?: HeavyTaskSelfCheckExecutionHygiene;
  guard: HeavyTaskSourceGuardResult & { status: 'accepted' };
  source: HeavyTaskProgressSource;
}

export type HeavyTaskSelfCheckFreshness = 'current' | 'stale' | 'unknown';

export type HeavyTaskSelfCheckFreshnessReason =
  | 'source_binding_missing'
  | 'workspace_observation_missing'
  | 'workspace_revision_changed'
  | 'later_workspace_mutation';

/** Replay-derived Self-check state. Durable source facts remain separate events. */
export interface HeavyTaskSelfCheckProjection extends HeavyTaskSemanticSelfCheckState {
  provenance?: ExecutionEvidenceRef;
  workspaceObservationId?: string;
  freshness: HeavyTaskSelfCheckFreshness;
  freshnessReasons: HeavyTaskSelfCheckFreshnessReason[];
}

export interface HeavyTaskAcceptanceCheck {
  id: string;
  kind:
    | 'required_artifact'
    | 'artifact_parse'
    | 'public_command'
    | 'fresh_context'
    | 'workspace_hygiene'
    | 'task_family_hint';
  source:
    | 'task_instruction'
    | 'task_metadata'
    | 'todo'
    | 'self_check_plan'
    | 'terminal_bench_hint'
    | 'generic_heavy_task';
  description: string;
  evidenceRequired: 'command' | 'artifact' | 'command_or_artifact';
  path?: string;
  commandHint?: string;
}

export type HeavyTaskSelfCheckGateAction =
  | 'allow_finalize'
  | 'repair_prompt'
  | 'allow_official_verifier_after_bounded_attempt';

export interface HeavyTaskSelfCheckGateState {
  schemaVersion: 1;
  action: HeavyTaskSelfCheckGateAction;
  reason: string;
  attempt: number;
  maxAttempts: number;
  checklist: HeavyTaskAcceptanceCheck[];
  selfCheckId?: string;
  prompt?: string;
}

export type HeavyTaskEvidenceKind = 'tool' | 'check' | 'artifact';
export type HeavyTaskToolEvidenceName =
  | 'Bash'
  | 'Read'
  | 'Grep'
  | 'Write'
  | 'Edit'
  | 'Glob'
  | string;

export interface HeavyTaskTruncationRef {
  truncated: boolean;
  originalBytes?: number;
  visibleBytes?: number;
  omittedBytes?: number;
  ref?: string;
  refKind?: 'runtime_event' | 'artifact' | 'external' | 'future_storage';
}

export interface HeavyTaskOutputSummary {
  stream: 'stdout' | 'stderr' | 'output' | 'content' | 'matches' | 'diff';
  excerpt?: string;
  lineCount?: number;
  byteCount?: number;
  truncated: boolean;
  truncationRef?: HeavyTaskTruncationRef;
}

export interface HeavyTaskDiffSummary {
  status: 'not_applicable' | 'not_captured' | 'present';
  files?: Array<{ path: string; additions?: number; deletions?: number }>;
  excerpt?: string;
  truncationRef?: HeavyTaskTruncationRef;
}

export interface HeavyTaskCompactEvidenceEnvelope {
  schemaVersion: 1;
  evidenceId: string;
  taskRunId: string;
  attemptId?: string;
  ts: number;
  kind: HeavyTaskEvidenceKind;
  public: true;
  source: HeavyTaskProgressSource & {
    runtimeEventId?: string;
    toolName?: HeavyTaskToolEvidenceName;
  };
  /** Runtime source range that proves where this compact evidence came from. */
  provenance?: ExecutionEvidenceRef;
  tool?: {
    name: HeavyTaskToolEvidenceName;
    inputSummary: Record<string, unknown>;
    exitCode?: number | null;
    timedOut?: boolean;
    ok?: boolean;
    outputs: HeavyTaskOutputSummary[];
    diff?: HeavyTaskDiffSummary;
  };
  artifact?: {
    artifactId?: string;
    path?: string;
    workspacePath?: string;
    artifactRef?: string;
    kind?: string;
    exists?: boolean;
    sizeBytes?: number;
    hash?: string;
    mimeType?: string;
    metadata?: Record<string, unknown>;
    authority?: {
      source: string;
      authoritative: boolean;
      label?: string;
    };
  };
  check?: {
    checkId?: string;
    status?: 'pass' | 'fail' | 'inconclusive' | 'unknown';
    linkedSelfCheckId?: string;
  };
  links?: {
    todoIds?: string[];
    checkIds?: string[];
    artifactIds?: string[];
    runtimeEventIds?: string[];
  };
}

export interface EnvNetworkSecretPolicy {
  schemaVersion: 1;
  env: 'inherit_none' | 'allowlist';
  envAllowlist?: string[];
  network: 'disabled' | 'allowlist' | 'unrestricted_external_boundary';
  networkAllowlist?: string[];
  secrets: 'none' | 'brokered_by_executor' | 'explicit_allowlist';
  secretRefs?: string[];
}

export interface TaskIsolationFacts {
  schemaVersion: 1;
  backendKind: string;
  required: boolean;
  mode: 'inert_fake_backend' | 'external';
  label?: string;
  assertionSource: 'headless_deps' | 'test_fixture' | 'desktop' | 'ci';
  validatedAt: number;
}

export interface WorkspaceLeaseFacts {
  schemaVersion: 1;
  leaseId: string;
  taskRunId: string;
  attemptId?: string;
  sourceWorkspaceDir: string;
  workspaceDir: string;
  leaseKind: 'throwaway_copy';
  writable: boolean;
  cleanupPolicy: 'cleanup_on_finally';
  createdAt: number;
  releasedAt?: number;
}

export interface ToolExecutorIdentity {
  schemaVersion: 1;
  executorId: string;
  taskRunId: string;
  attemptId?: string;
  toolNames: string[];
  isolationMode: 'external' | 'inert_fake_backend';
  label: string;
  commandPolicy?: EnvNetworkSecretPolicy;
}

export type PermissionDecision = 'allow' | 'deny' | 'timeout' | 'expired';
export type PermissionDecisionSource =
  | 'ci_policy'
  | 'desktop_user'
  | 'test_fixture'
  | 'policy_engine';

export interface PermissionResourceScope {
  kind: 'workspace_path' | 'network' | 'secret' | 'command' | 'tool' | 'budget';
  value: string;
  mode?: 'read' | 'write' | 'execute' | 'connect' | 'reveal' | 'extend';
}

export interface TaskPermissionRequest {
  schemaVersion: 1;
  requestId: string;
  taskRunId: string;
  attemptId: string;
  toolCallId: string;
  toolName: string;
  normalizedArgsHash: string;
  resourceScope: PermissionResourceScope;
  reason: string;
  preview: Record<string, unknown>;
  requestedAt: number;
  expiresAt: number;
}

export interface TaskPermissionGrant {
  schemaVersion: 1;
  grantId: string;
  requestId: string;
  taskRunId: string;
  attemptId?: string;
  toolCallId?: string;
  toolName: string;
  normalizedArgsHash: string;
  resourceScope: PermissionResourceScope;
  decision: PermissionDecision;
  actor: { kind: 'user' | 'system' | 'test'; id?: string };
  source: PermissionDecisionSource;
  decidedAt: number;
  expiresAt: number;
  reason?: string;
}

export type TaskInboxKind =
  | 'approval_request'
  | 'ambiguous_failure_triage'
  | 'budget_extension'
  | 'claim_to_chat';

export type TaskInboxStatus = 'open' | 'claimed' | 'resolved' | 'dismissed' | 'expired';

export interface TaskInboxItem {
  schemaVersion: 1;
  inboxItemId: string;
  taskRunId: string;
  attemptId?: string;
  kind: TaskInboxKind;
  status: TaskInboxStatus;
  title: string;
  reason: string;
  createdAt: number;
  expiresAt?: number;
  relatedRequestId?: string;
  relatedGrantId?: string;
  relatedVerifierResultId?: string;
  relatedScoreResultId?: string;
  claim?: { actorId: string; claimedAt: number; chatRef?: string };
  resolution?: { decision: string; actorId?: string; resolvedAt: number; reason?: string };
  preview?: Record<string, unknown>;
}

export interface TaskRunParkedState {
  reason: 'approval' | 'ambiguous_failure' | 'budget_extension' | 'claim_to_chat';
  inboxItemId: string;
  since: number;
}

interface BaseTaskEvent {
  id: string;
  taskRunId: string;
  ts: number;
}

export interface TaskRunCreatedEvent extends BaseTaskEvent {
  type: 'task_run_created';
  taskId: string;
  configId: string;
  taskDefinition?: TaskDefinition;
  sourceResultRecord?: ResultRecord;
}

export interface TaskRunQueuedEvent extends BaseTaskEvent {
  type: 'task_run_queued';
  taskId: string;
  configId: string;
  taskDefinition?: TaskDefinition;
}

export interface TaskRunStartedEvent extends BaseTaskEvent {
  type: 'task_run_started';
  startedAt?: number;
  sessionId?: string;
  agentRunId?: string;
}

export interface TaskRunVerifyingEvent extends BaseTaskEvent {
  type: 'task_run_verifying';
  startedAt?: number;
}

export interface TaskAttemptStartedEvent extends BaseTaskEvent {
  type: 'task_attempt_started';
  attemptId: string;
  startedAt?: number;
  sessionId?: string;
  agentRunId?: string;
}

export interface TaskAttemptExecutionLinkedEvent extends BaseTaskEvent {
  type: 'task_attempt_execution_linked';
  attemptId: string;
  /** Cross-ledger identity and Runtime source coverage; never copied Runtime facts. */
  evidence: ExecutionEvidenceRef;
}

export interface SelfCheckObservedEvent extends BaseTaskEvent {
  type: 'self_check_observed';
  observation: SelfCheckObservation;
}

export interface FeedbackObservedEvent extends BaseTaskEvent {
  type: 'feedback_observed';
  observation: FeedbackObservation;
}

export interface AutonomousDecisionRecordedEvent extends BaseTaskEvent {
  type: 'autonomous_decision_recorded';
  decision: AutonomousDecision;
}

export interface VerifierResultRecordedEvent extends BaseTaskEvent {
  type: 'verifier_result_recorded';
  result: VerifierResult;
}

export interface TaskRunArtifactRecordedEvent extends BaseTaskEvent {
  type: 'task_run_artifact_recorded';
  artifact: TaskRunArtifact;
}

export interface ScoreResultRecordedEvent extends BaseTaskEvent {
  type: 'score_result_recorded';
  result: ScoreResult;
}

export interface IsolationPolicyRecordedEvent extends BaseTaskEvent {
  type: 'isolation_policy_recorded';
  facts: TaskIsolationFacts;
}

export interface HeavyTaskModeRecordedEvent extends BaseTaskEvent {
  type: 'heavy_task_mode_recorded';
  facts: HeavyTaskModeFacts;
}

export interface EconomyTaskModeRecordedEvent extends BaseTaskEvent {
  type: 'economy_task_mode_recorded';
  facts: EconomyTaskModeFacts;
}

export interface HeavyTaskInventoryRecordedEvent extends BaseTaskEvent {
  type: 'heavy_task_inventory_recorded';
  inventory: HeavyTaskInventoryState;
}

export interface HeavyTaskTodosRecordedEvent extends BaseTaskEvent {
  type: 'heavy_task_todos_recorded';
  todos: HeavyTaskTodoState;
}

export interface HeavyTaskSelfCheckRecordedEvent extends BaseTaskEvent {
  type: 'heavy_task_self_check_recorded';
  selfCheck: HeavyTaskSemanticSelfCheckState;
}

export interface HeavyTaskSelfCheckEvidenceLinkedEvent extends BaseTaskEvent {
  type: 'heavy_task_self_check_evidence_linked';
  selfCheckId: string;
  attemptId: string;
  workspaceObservationId: string;
  /** Canonical Runtime/Task coverage and the observed workspace revision. */
  provenance: ExecutionEvidenceRef;
}

export interface HeavyTaskSelfCheckPlanRecordedEvent extends BaseTaskEvent {
  type: 'heavy_task_self_check_plan_recorded';
  plan: HeavyTaskSelfCheckPlanState;
}

export interface HeavyTaskSelfCheckGateRecordedEvent extends BaseTaskEvent {
  type: 'heavy_task_self_check_gate_recorded';
  gate: HeavyTaskSelfCheckGateState;
}

export interface HeavyTaskWorkspaceObservationRecordedEvent extends BaseTaskEvent {
  type: 'heavy_task_workspace_observation_recorded';
  observation: HeavyTaskWorkspaceObservationState;
}

export interface HeavyTaskEvidenceRecordedEvent extends BaseTaskEvent {
  type: 'heavy_task_evidence_recorded';
  evidence: HeavyTaskCompactEvidenceEnvelope;
}

export interface HeavyTaskEvidenceProvenanceLinkedEvent extends BaseTaskEvent {
  type: 'heavy_task_evidence_provenance_linked';
  evidenceId: string;
  attemptId: string;
  /** Reference to canonical Runtime facts; never a copy of their payloads. */
  provenance: ExecutionEvidenceRef;
}

export interface WorkspaceLeaseRecordedEvent extends BaseTaskEvent {
  type: 'workspace_lease_recorded';
  lease: WorkspaceLeaseFacts;
}

export interface ToolExecutorIdentityRecordedEvent extends BaseTaskEvent {
  type: 'tool_executor_identity_recorded';
  identity: ToolExecutorIdentity;
}

export interface PermissionRequestRecordedEvent extends BaseTaskEvent {
  type: 'permission_request_recorded';
  request: TaskPermissionRequest;
}

export interface PermissionGrantRecordedEvent extends BaseTaskEvent {
  type: 'permission_grant_recorded';
  grant: TaskPermissionGrant;
}

export interface PermissionDecisionRecordedEvent extends BaseTaskEvent {
  type: 'permission_decision_recorded';
  requestId: string;
  grant?: TaskPermissionGrant;
  decision: PermissionDecision;
  source: PermissionDecisionSource;
  decidedAt: number;
  reason?: string;
}

export interface TaskInboxItemRecordedEvent extends BaseTaskEvent {
  type: 'task_inbox_item_recorded';
  item: TaskInboxItem;
}

export interface TaskInboxItemResolvedEvent extends BaseTaskEvent {
  type: 'task_inbox_item_resolved';
  inboxItemId: string;
  status: Exclude<TaskInboxStatus, 'open'>;
  resolution?: NonNullable<TaskInboxItem['resolution']>;
}

export interface TaskRunNeedsApprovalEvent extends BaseTaskEvent {
  type: 'task_run_needs_approval';
  attemptId?: string;
  reason: TaskRunParkedState['reason'];
  inboxItemId: string;
}

export interface TaskAttemptCompletedEvent extends BaseTaskEvent {
  type: 'task_attempt_completed';
  attemptId: string;
  finishedAt?: number;
  status: Exclude<TaskAttemptStatus, 'running'>;
  error?: TaskRunError;
}

export interface TaskRunCompletedEvent extends BaseTaskEvent {
  type: 'task_run_completed';
  finishedAt?: number;
  result?: TaskRunResult;
}

export interface TaskRunFailedEvent extends BaseTaskEvent {
  type: 'task_run_failed';
  finishedAt?: number;
  error: TaskRunError;
}

export interface TaskRunIncompleteEvent extends BaseTaskEvent {
  type: 'task_run_incomplete';
  finishedAt?: number;
  error?: TaskRunError;
}

export interface TaskRunBlockedEvent extends BaseTaskEvent {
  type: 'task_run_blocked';
  finishedAt?: number;
  error?: TaskRunError;
}

export interface TaskRunPolicyDeniedEvent extends BaseTaskEvent {
  type: 'task_run_policy_denied';
  finishedAt?: number;
  error?: TaskRunError;
}

export interface TaskRunBudgetExhaustedEvent extends BaseTaskEvent {
  type: 'task_run_budget_exhausted';
  finishedAt?: number;
  error?: TaskRunError;
}

export interface TaskRunAbortedEvent extends BaseTaskEvent {
  type: 'task_run_aborted';
  finishedAt?: number;
  error?: TaskRunError;
}

export interface TaskRunCancelledEvent extends BaseTaskEvent {
  type: 'task_run_cancelled';
  finishedAt?: number;
  error?: TaskRunError;
}

export interface TaskEventCorrupt extends BaseTaskEvent {
  type: 'event_corrupt';
  raw?: string;
  error: string;
}

export type TaskEvent =
  | TaskRunCreatedEvent
  | TaskRunQueuedEvent
  | TaskRunStartedEvent
  | TaskRunVerifyingEvent
  | TaskAttemptStartedEvent
  | TaskAttemptExecutionLinkedEvent
  | SelfCheckObservedEvent
  | FeedbackObservedEvent
  | AutonomousDecisionRecordedEvent
  | VerifierResultRecordedEvent
  | TaskRunArtifactRecordedEvent
  | ScoreResultRecordedEvent
  | HeavyTaskModeRecordedEvent
  | EconomyTaskModeRecordedEvent
  | HeavyTaskInventoryRecordedEvent
  | HeavyTaskTodosRecordedEvent
  | HeavyTaskSelfCheckPlanRecordedEvent
  | HeavyTaskSelfCheckRecordedEvent
  | HeavyTaskSelfCheckEvidenceLinkedEvent
  | HeavyTaskSelfCheckGateRecordedEvent
  | HeavyTaskWorkspaceObservationRecordedEvent
  | HeavyTaskEvidenceRecordedEvent
  | HeavyTaskEvidenceProvenanceLinkedEvent
  | IsolationPolicyRecordedEvent
  | WorkspaceLeaseRecordedEvent
  | ToolExecutorIdentityRecordedEvent
  | PermissionRequestRecordedEvent
  | PermissionGrantRecordedEvent
  | PermissionDecisionRecordedEvent
  | TaskInboxItemRecordedEvent
  | TaskInboxItemResolvedEvent
  | TaskRunNeedsApprovalEvent
  | TaskAttemptCompletedEvent
  | TaskRunCompletedEvent
  | TaskRunFailedEvent
  | TaskRunIncompleteEvent
  | TaskRunBlockedEvent
  | TaskRunPolicyDeniedEvent
  | TaskRunBudgetExhaustedEvent
  | TaskRunAbortedEvent
  | TaskRunCancelledEvent
  | TaskEventCorrupt;
