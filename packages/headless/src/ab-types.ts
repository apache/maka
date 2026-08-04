import type { FixedPromptTask } from './fixed-prompt-controller.js';
import type { FixedPromptTaskWalEvent } from './fixed-prompt-wal-types.js';
import type { HarborCellContextBudgetPolicySnapshot } from './cell-output.js';

export type AbExperimentKind = 'prompt' | 'tools' | 'provider' | 'runtime' | 'harness';

export interface AbArmSpec {
  id: string;
  kind: AbExperimentKind;
  fingerprint: string;
  metadata?: Record<string, unknown>;
}

export interface SummarizeAbComparisonInput {
  runId: string;
  roundId: string;
  baselineArmId: string;
  candidateArmId: string;
  evaluationTaskIds: readonly string[];
  baselineRuns: readonly (readonly FixedPromptTaskWalEvent[])[];
  candidateRuns: readonly (readonly FixedPromptTaskWalEvent[])[];
  budgetMs?: number;
  nonInferiorityMargin?: number;
}

export interface RunArmCohortInput {
  runId: string;
  arms: readonly AbArmSpec[];
  evaluationTasks: readonly FixedPromptTask[];
  reps?: number;
  maxConcurrency?: number;
  armExecution?: 'parallel' | 'sequential';
  observedCostStopUsd?: number;
  roundIdPrefix?: string;
  /** Events already present when this invocation began. They remain
   * in the summary but must not re-trigger live stop guards on explicit resume. */
  preexistingEventIds?: ReadonlySet<string>;
  runArm: AbArmRunner;
}

export interface RunAbComparisonInput extends Omit<RunArmCohortInput, 'arms'> {
  arms: readonly [AbArmSpec, AbArmSpec];
  budgetMs?: number;
  nonInferiorityMargin?: number;
}

export interface ArmCohortResult {
  runId: string;
  armIds: readonly string[];
  evaluationTaskIds: readonly string[];
  reps: number;
  runsByArmId: Readonly<Record<string, readonly (readonly FixedPromptTaskWalEvent[])[]>>;
  stopReason?: 'observed_cost_stop_reached' | 'systemic_provider_failure';
}

export interface AbArmRunInput {
  runId: string;
  roundId: string;
  arm: AbArmSpec;
  task: FixedPromptTask;
  rep: number;
}

export type AbArmRunner = (input: AbArmRunInput) => Promise<FixedPromptTaskWalEvent>;

export type AbDecision = 'non_inferior' | 'inferior' | 'not_cleared' | 'diagnostic' | 'invalid';

export interface AbArmSummary {
  attempts: number;
  observed: number;
  valid: number;
  passed: number;
  passRate: number | null;
  completed: number;
  budgetExhausted: number;
  infraFailed: number;
  plumbingFailed: number;
  missingFinalUsage: number;
  attestationWarnings: number;
  missing: number;
  coverageRate: number;
  totalCostUsd: number;
  meanDurationMs: number | null;
  tokenCostSummary: AbTokenCostSummary;
  contextBudgetPolicy?: AbContextBudgetPolicySummary;
  contextBudget?: AbContextBudgetSummary;
  continuation?: AbContinuationSummary;
  taskTools?: AbTaskToolSummary;
  activePruneSubset?: AbActivePruneSubsetSummary;
}

export interface AbActivePruneSubsetSummary {
  taskCount: number;
  attempts: number;
  observed: number;
  valid: number;
  passed: number;
  passRate: number | null;
  completed: number;
  budgetExhausted: number;
  infraFailed: number;
  plumbingFailed: number;
  attestationWarnings: number;
  missing: number;
  coverageRate: number;
  totalCostUsd: number;
  meanDurationMs: number | null;
  tokenCostSummary: AbTokenCostSummary;
  contextBudget?: AbContextBudgetSummary;
}

export interface AbTokenCostSummary {
  input: number;
  cachedInput: number;
  cacheHitInput: number;
  cacheMissInput: number;
  cacheWriteInput: number;
  output: number;
  reasoning: number;
  total: number;
  costUsd: number;
  meanDurationMs: number | null;
}

export interface AbContextBudgetPolicySummary {
  attempts: number;
  enabledAttempts: number;
  snapshots: HarborCellContextBudgetPolicySnapshot[];
}

export interface AbContextBudgetSummary {
  diagnosticAttempts: number;
  activatedAttempts: number;
  activatedAttemptIds: string[];
  diagnosticEvents: number;
  prunedToolResults: number;
  activePrunedToolResults: number;
  activeEstimatedTokensSaved: number;
  activeArchiveFailures: number;
  archivePlaceholders: number;
  archivePlaceholderReasonCounts: Record<string, number>;
  archiveWriteFailures: number;
  retrievedArchiveToolResults: number;
  retrievedArchiveEstimatedTokens: number;
  archiveRetrievalSkipped: number;
  archiveRetrievalSkippedReasonCounts: Record<string, number>;
  archiveRetrievalFailures: number;
  archiveRetrievalFailureReasonCounts: Record<string, number>;
}

export interface AbContinuationSummary {
  attempts: number;
  enabledAttempts: number;
  wallTimeoutMs: number | null;
  turnsUsed: number;
  continuedTurns: number;
  stepCapHits: number;
  capExhaustedAttempts: number;
  totalRuntimeSteps: number;
  perTurnStepCapHits: boolean[];
  maxTurns: number | null;
  maxTotalRuntimeSteps: number | null;
}

export interface AbTaskToolSummary {
  attempts: number;
  activatedAttempts: number;
  activatedAttemptIds: string[];
  todoWriteCalls: number;
}

export interface AbTaskArmSummary {
  observed: number;
  valid: number;
  passed: number;
  passRate: number | null;
  completed: number;
  budgetExhausted: number;
  infraFailed: number;
  plumbingFailed: number;
  attestationWarnings: number;
  missing: number;
}

export interface AbTaskComparison {
  taskId: string;
  baseline: AbTaskArmSummary;
  candidate: AbTaskArmSummary;
  passRateDelta: number | null;
  outcome: 'candidate_win' | 'baseline_win' | 'tie' | 'missing' | 'excluded';
}

export interface AbTaskLevelSummary {
  comparableTasks: number;
  wins: number;
  losses: number;
  ties: number;
  signTestNonTieTasks: number;
  signTestPValue: number | null;
  missingTaskIds: string[];
  excludedTaskIds: string[];
  meanPassRateDelta: number | null;
  medianPassRateDelta: number | null;
  tasks: AbTaskComparison[];
}

export interface AbAttemptPairSummary {
  pairs: number;
  observedPairs: number;
  evaluatedPairs: number;
  baselinePassed: number;
  candidatePassed: number;
  nonBudgetEvaluatedPairs: number;
  baselineNonBudgetPassed: number;
  candidateNonBudgetPassed: number;
  budgetExcludedPairIds: string[];
  fullyMeteredPairs: number;
  baselineMeteredPassed: number;
  candidateMeteredPassed: number;
  baselineTokenCostSummary: AbTokenCostSummary;
  candidateTokenCostSummary: AbTokenCostSummary;
  wins: number;
  losses: number;
  ties: number;
  missingPairIds: string[];
  excludedPairIds: string[];
  missingUsagePairIds: string[];
  budgetDiscordantPairIds: string[];
  infraOrPlumbingDiscordantPairIds: string[];
}

export type AbArmLabel = 'A' | 'B';

export interface AbAttemptRef {
  arm: AbArmLabel;
  attemptId: string;
  taskId: string;
  rep: number;
  roundId: string;
  runtimeEventsPath?: string;
  traceEventsPath?: string;
  runtimeEventsUnavailableReason?: string;
}

export interface AbPairInvestigationRef {
  pairId: string;
  baseline?: AbAttemptRef;
  candidate?: AbAttemptRef;
}

export interface AbInvestigationRefs {
  activatedAttempts: AbAttemptRef[];
  candidateLosses: AbPairInvestigationRef[];
  budgetDiscordantPairs: AbPairInvestigationRef[];
  infraOrPlumbingDiscordantPairs: AbPairInvestigationRef[];
}

export interface AbNonInferioritySummary {
  method: 'paired_bonferroni_wilson' | 'unavailable';
  confidenceLevel: number;
  lowerBound: number | null;
}

export interface AbComparisonSummary {
  runId: string;
  roundId: string;
  baselineArmId: string;
  candidateArmId: string;
  taskCount: number;
  reps: number;
  budgetMs?: number;
  nonInferiorityMargin: number;
  passRateDelta: number | null;
  nonInferiority: AbNonInferioritySummary;
  decision: AbDecision;
  reason: string;
  baseline: AbArmSummary;
  candidate: AbArmSummary;
  taskLevel: AbTaskLevelSummary;
  pairedAttempts: AbAttemptPairSummary;
  investigationRefs: AbInvestigationRefs;
  stopReason?: 'observed_cost_stop_reached' | 'systemic_provider_failure';
}

export interface AbRunManifestInput {
  experimentKind: AbExperimentKind;
  arms: readonly AbArmSpec[];
  metadata?: Record<string, unknown>;
  taskBudgetSec: number | null;
  harborTimeoutMs: number | null;
  subjectFingerprint: string;
  taskSourceFingerprint: string;
  toolchainFingerprint: string;
  evaluationTaskIds: readonly string[];
  reps: number;
  candidateLimit: number | null;
  maxConcurrency: number;
  maxConcurrentAttempts?: number;
  observedCostStopUsd?: number;
  selectionMode?: 'explicit' | 'metadata';
  candidateTaskIds?: readonly string[];
  pilotTaskIds?: readonly string[];
  maxExpertTimeEstimateMin?: number | null;
  targetEvaluationTaskCount?: number | null;
  nonInferiorityMargin?: number;
}

export type AbRunManifest = AbRunManifestInput & {
  schemaVersion: 'maka.ab.run_manifest.v1';
  fingerprint: string;
  arms: AbArmSpec[];
  evaluationTaskIds: string[];
  candidateTaskIds?: string[];
  pilotTaskIds?: string[];
};
