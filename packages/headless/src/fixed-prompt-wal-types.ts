import type {
  HarborCellContextBudgetPolicySnapshot,
  HarborCellContextBudgetSummary,
  HarborCellContinuationSummary,
  HarborCellDeadlineSettlement,
  HarborCellExecutionIdentity,
  HarborCellOutput,
  HarborCellRuntimeRefs,
  HarborCellTaskToolSummary,
  HarborCellTokenSummary,
} from './cell-output.js';
import type { MakaChangeAuditRecord } from './change-audit.js';

export const FIXED_PROMPT_WAL_SCHEMA_VERSION = 1;

export type UnscoredCellFailureClass = 'infra_failed' | 'setup_failed' | 'verification_error';

export interface HarborVerifierAttempt {
  attempt: number;
  classification: 'passed' | 'failed' | 'timeout' | 'infra_setup_failed' | 'infra_failed';
  durationMs: number;
  reward?: number;
}

export interface HarborVerifierOutcome {
  outcome: 'passed' | 'failed' | 'candidate_timeout';
  attempts: HarborVerifierAttempt[];
}

/** What the harness's verifier wrote about a trial. One shape from the runner's
 * read of the trial directory through to the WAL, so the grade contract cannot
 * drift along the way. Whether it amounts to a score is decided in one place,
 * by structuredVerifierGrade. */
export interface HarborTrialGrade {
  reward: number;
  verifier?: HarborVerifierOutcome;
}

export interface FixedPromptTaskCompletedEvent {
  schemaVersion: typeof FIXED_PROMPT_WAL_SCHEMA_VERSION;
  type: 'task_completed';
  id: string;
  ts: number;
  runId: string;
  roundId: string;
  resumeFingerprint?: string;
  taskId: string;
  status: HarborCellOutput['status'];
  passed: boolean;
  scored: boolean;
  eligible: boolean;
  errorClass?: string;
  promptHash?: string;
  executionIdentity?: HarborCellExecutionIdentity;
  runtimeRefs?: HarborCellRuntimeRefs;
  deadlineSettlement?: HarborCellDeadlineSettlement;
  tokenSummary?: HarborCellTokenSummary;
  contextBudgetPolicy?: HarborCellContextBudgetPolicySnapshot;
  contextBudgetSummary?: HarborCellContextBudgetSummary;
  continuationSummary?: HarborCellContinuationSummary;
  taskToolSummary?: HarborCellTaskToolSummary;
  steps: number;
  durationMs: number;
  runtimeEventsPath: string;
  traceEventsPath?: string;
  providerTelemetryPath?: string;
  harbor: {
    reward: number;
    verifierFailureSummary?: string;
    verifier?: HarborVerifierOutcome;
  };
}

export interface FixedPromptTaskAttemptStartedEvent {
  schemaVersion: typeof FIXED_PROMPT_WAL_SCHEMA_VERSION;
  type: 'task_attempt_started';
  id: string;
  ts: number;
  runId: string;
  roundId: string;
  resumeFingerprint?: string;
  taskId: string;
  promptHash: string;
}

export interface FixedPromptTaskInfraFailedEvent {
  schemaVersion: typeof FIXED_PROMPT_WAL_SCHEMA_VERSION;
  type: 'task_infra_failed';
  id: string;
  ts: number;
  runId: string;
  roundId: string;
  resumeFingerprint?: string;
  taskId: string;
  status: 'infra_failed';
  passed: false;
  scored: false;
  eligible: false;
  errorClass:
    | 'infra_error'
    | 'provider_billing'
    | 'auth'
    | 'rate_limit'
    | 'provider_unavailable'
    | 'network';
  error: string;
  providerTelemetryPath?: string;
}

export interface FixedPromptTaskBudgetExhaustedEvent {
  schemaVersion: typeof FIXED_PROMPT_WAL_SCHEMA_VERSION;
  type: 'task_budget_exhausted';
  id: string;
  ts: number;
  runId: string;
  roundId: string;
  resumeFingerprint?: string;
  taskId: string;
  status: 'budget_exhausted';
  /** A trial can exhaust its budget and still be graded: the harness runs the
   * verifier after the agent-phase exception. `scored` is the authority — it is
   * true only when the verifier's artifacts agreed on a verdict. `harbor` also
   * travels with a verdict that was rejected, so its presence alone says
   * nothing; read `scored` before trusting the reward. */
  passed: boolean;
  scored: boolean;
  eligible: boolean;
  errorClass: 'budget_exhausted';
  error: string;
  evidenceErrorClass?:
    | FixedPromptTaskPlumbingFailedEvent['errorClass']
    | UnscoredCellFailureClass
    | FixedPromptTaskInfraFailedEvent['errorClass'];
  evidenceError?: string;
  expectedPromptHash: string;
  runtimeEventsPath?: string;
  traceEventsPath?: string;
  providerTelemetryPath?: string;
  runtimeEventsUnavailableReason?: string;
  tokenSummary?: HarborCellTokenSummary;
  tokenSummarySource?: 'final' | 'checkpoint';
  executionIdentity?: HarborCellExecutionIdentity;
  runtimeRefs?: HarborCellRuntimeRefs;
  contextBudgetPolicy?: HarborCellContextBudgetPolicySnapshot;
  contextBudgetSummary?: HarborCellContextBudgetSummary;
  continuationSummary?: HarborCellContinuationSummary;
  taskToolSummary?: HarborCellTaskToolSummary;
  steps?: number;
  durationMs?: number;
  harbor?: HarborTrialGrade;
}

export interface FixedPromptTaskPlumbingFailedEvent {
  schemaVersion: typeof FIXED_PROMPT_WAL_SCHEMA_VERSION;
  type: 'task_plumbing_failed';
  id: string;
  ts: number;
  runId: string;
  roundId: string;
  resumeFingerprint?: string;
  taskId: string;
  status: 'plumbing_failed';
  passed: false;
  scored: false;
  eligible: false;
  errorClass:
    | 'missing_token_usage'
    | 'zero_cost_with_tokens'
    | 'prompt_hash_mismatch'
    | 'missing_prompt_hash'
    | 'missing_execution_identity'
    | 'execution_identity_mismatch'
    | 'missing_provider_request_trace'
    | 'invalid_provider_request_trace'
    | 'orphaned_sampled_attempt';
  error: string;
  promptHash?: string;
  expectedPromptHash?: string;
  runtimeRefs?: HarborCellRuntimeRefs;
  tokenSummary?: HarborCellTokenSummary;
  contextBudgetPolicy?: HarborCellContextBudgetPolicySnapshot;
  contextBudgetSummary?: HarborCellContextBudgetSummary;
  continuationSummary?: HarborCellContinuationSummary;
  taskToolSummary?: HarborCellTaskToolSummary;
  steps?: number;
  durationMs?: number;
  runtimeEventsPath?: string;
  traceEventsPath?: string;
  providerTelemetryPath?: string;
  harbor?: {
    reward: number;
  };
}

export interface PromptCandidateCommittedEvent {
  schemaVersion: typeof FIXED_PROMPT_WAL_SCHEMA_VERSION;
  type: 'prompt_candidate_committed';
  id: string;
  ts: number;
  runId: string;
  roundId: string;
  commitSha: string;
  summary: string;
  promptHash: string;
  heldInTaskSetHash: string;
  heldInTaskIds: readonly string[];
  candidateRationaleHash: string;
  candidateRationale: PromptCandidateRationale;
}

export const PROMPT_CANDIDATE_FAILURE_PATTERNS = [
  'coverage_regression',
  'tool_failed',
  'max_tokens',
  'runtime_error',
  'verification_failed',
  'other',
] as const;

export type PromptCandidateFailurePattern = (typeof PROMPT_CANDIDATE_FAILURE_PATTERNS)[number];

export interface PromptCandidateRationale
  extends MakaChangeAuditRecord<
    'system_prompt',
    string,
    string,
    string,
    PromptCandidateFailurePattern
  > {}

export type PromptCandidateRewardHackScan =
  | { decision: 'clean' }
  | { decision: 'quarantine'; reason: string; matchedPatterns?: readonly string[] };

export interface PromptCandidateDecisionEvent {
  schemaVersion: typeof FIXED_PROMPT_WAL_SCHEMA_VERSION;
  type: 'prompt_candidate_decided';
  id: string;
  ts: number;
  runId: string;
  roundId: string;
  decision: 'keep' | 'discard';
  reason: string;
  candidateCommitSha: string;
  previousLastKeptCommitSha: string;
  lastKeptCommitSha: string;
  previousHeldInReferencePassEligibleRate: number | null;
  heldInReferencePassEligibleRate: number | null;
  originalCommitSha: string;
  originalHeldOutPassEligibleRate: number | null;
  heldInPassRateNoiseBand: number;
  heldOutPassRateNoiseBand: number;
  rewardHackScan?: PromptCandidateRewardHackScan;
  samplingPromptHash?: string;
  metrics: unknown;
}

export type RsiPredictedFixOutcome =
  | 'improved'
  | 'unchanged'
  | 'regressed'
  | 'unscored'
  | 'missing';
export type RsiRiskTaskOutcome = 'safe' | 'regressed' | 'unscored' | 'missing';
export type RsiRootCauseSignalMatch = 'matched' | 'contradicted' | 'unknown';

export interface RsiControllerAttributionEvent {
  schemaVersion: typeof FIXED_PROMPT_WAL_SCHEMA_VERSION;
  type: 'rsi_controller_attribution';
  id: string;
  ts: number;
  runId: string;
  roundId: string;
  candidateCommitSha: string;
  heldInTaskSetHash: string;
  candidateRationaleHash: string;
  evidenceRefs: readonly string[];
  predictedFixes: Array<{ taskId: string; outcome: RsiPredictedFixOutcome }>;
  riskTasks: Array<{ taskId: string; outcome: RsiRiskTaskOutcome }>;
  unexpectedHeldInFlips: Array<{ taskId: string; from: string; to: string }>;
  decision: {
    decision: 'keep' | 'discard';
    reason: string;
  };
  rootCauseSignalMatch: RsiRootCauseSignalMatch;
}

export type FixedPromptWalEvent =
  | FixedPromptTaskAttemptStartedEvent
  | FixedPromptTaskCompletedEvent
  | FixedPromptTaskInfraFailedEvent
  | FixedPromptTaskBudgetExhaustedEvent
  | FixedPromptTaskPlumbingFailedEvent
  | PromptCandidateCommittedEvent
  | PromptCandidateDecisionEvent
  | RsiControllerAttributionEvent;

export type FixedPromptTaskWalEvent =
  | FixedPromptTaskCompletedEvent
  | FixedPromptTaskInfraFailedEvent
  | FixedPromptTaskBudgetExhaustedEvent
  | FixedPromptTaskPlumbingFailedEvent;
