import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, truncate, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  validateHarborCellOutput,
  type HarborCellContextBudgetPolicySnapshot,
  type HarborCellContextBudgetSummary,
  type HarborCellContinuationSummary,
  type HarborCellDeadlineSettlement,
  type HarborCellExecutionIdentity,
  type HarborCellOutput,
  type HarborCellTaskToolSummary,
  type HarborCellTokenSummary,
} from './cell-output.js';
import type { Config } from './contracts.js';
import { syncParentDirectory } from './immutable-file.js';
import type { MakaChangeAuditRecord } from './change-audit.js';
import type { HarborBillingMode } from './harbor-task-runner.js';
import { assertFinitePositive, assertPositiveInt, assertRatio } from './numeric-guards.js';
import { hashHeadlessSystemPrompt } from './system-prompts.js';

export const FIXED_PROMPT_WAL_SCHEMA_VERSION = 1;
export const BUDGET_EXHAUSTED_RUNTIME_UNAVAILABLE_REASON = 'budget_exhausted_before_cell_output';
const LEGACY_TIMEOUT_MISSING_EXECUTION_IDENTITY_ERROR =
  'Timed-out Harbor attempt did not produce execution identity attestation';
type UnscoredCellFailureClass = 'infra_failed' | 'setup_failed' | 'verification_error';
const walWriteTails = new Map<string, Promise<void>>();

export interface FixedPromptTask {
  id: string;
  path: string;
  metadata?: {
    difficulty?: string;
    estimatedDurationSec?: number;
    expertTimeEstimateMin?: number;
    juniorTimeEstimateMin?: number;
    agentTimeoutSec?: number;
    verifierTimeoutSec?: number;
    /** Task-native environment build budget (task.toml [environment]
     * build_timeout_sec); feeds runner wall-clock watchdog derivation. */
    buildTimeoutSec?: number;
  };
}

export type HarborTaskRunCellOutput = HarborCellOutput & {
  traceEventsPath?: string;
  providerTelemetryPath?: string;
};

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

/**
 * The provider-neutral seam the fixed-prompt controller and A/B schedulers
 * consume: run one task attempt and return its reward plus cell artifacts. Two
 * implementations exist: `createHarborTaskRunner` (Harbor) and
 * `createPierTaskRunner` (Pier, for DeepSWE). The output still carries a
 * Harbor-shaped `harbor` field; both harnesses map into it, and generalizing
 * that payload is deferred until an implementation cannot.
 */
export interface TaskRunOutput {
  harbor: {
    reward: number;
    verifierFailureSummary?: string;
    verifier?: HarborVerifierOutcome;
  };
  cell: HarborTaskRunCellOutput;
}

export interface TaskRunInput {
  runId: string;
  roundId: string;
  task: FixedPromptTask;
  config: Config;
  systemPrompt: string;
  agentEnv?: Record<string, string>;
}

export interface TaskRunner {
  (input: TaskRunInput): Promise<TaskRunOutput>;
}

export interface FixedPromptBudgetExhaustedArtifactRefs {
  runtimeEventsPath?: string;
  traceEventsPath?: string;
  providerTelemetryPath?: string;
  runtimeEventsUnavailableReason?: string;
  tokenSummary?: HarborCellTokenSummary;
  cellOutput?: HarborTaskRunCellOutput;
  executionIdentity?: HarborCellExecutionIdentity;
}

export class FixedPromptBudgetExhaustedError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
    readonly artifactRefs?: FixedPromptBudgetExhaustedArtifactRefs,
  ) {
    super(message);
    this.name = 'FixedPromptBudgetExhaustedError';
  }
}

export interface ReadHarborTaskRunOutputInput {
  harborResultPath: string;
  cellOutputPath: string;
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
  passed: false;
  scored: false;
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
  contextBudgetPolicy?: HarborCellContextBudgetPolicySnapshot;
  contextBudgetSummary?: HarborCellContextBudgetSummary;
  continuationSummary?: HarborCellContinuationSummary;
  taskToolSummary?: HarborCellTaskToolSummary;
  steps?: number;
  durationMs?: number;
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
    | 'orphaned_sampled_attempt';
  error: string;
  promptHash?: string;
  expectedPromptHash?: string;
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

export interface RunFixedPromptControllerInput {
  runId: string;
  roundId: string;
  config: Config;
  systemPromptPath: string;
  resultsJsonlPath: string;
  resultsTsvPath?: string;
  tasks: readonly FixedPromptTask[];
  maxInfraFailureRate?: number;
  costCeilingUsd?: number;
  maxConcurrency?: number;
  infraFailurePolicy?: 'retry-once' | 'terminal';
  resumeFingerprint?: string;
  requireExecutionIdentity?: boolean;
  requireFinalUsage?: boolean;
  expectedPricingProfile?: string;
  billingMode?: HarborBillingMode;
  /** Refuse resume when a model attempt was durably admitted but no terminal
   * event exists, preserving single-sample benchmark semantics. */
  protectPassAtOne?: boolean;
  taskRunner: TaskRunner;
  now?: () => number;
  newId?: () => string;
}

export type FixedPromptControllerStopReason =
  | 'infra_failure_rate_exceeded'
  | 'systemic_provider_failure'
  | 'cost_ceiling_exceeded';

export interface FixedPromptControllerResult {
  taskIds: string[];
  events: FixedPromptTaskWalEvent[];
  totalTokens: number;
  totalCostUsd: number;
  resultsTsvPath?: string;
  stopReason?: FixedPromptControllerStopReason;
}

export async function runFixedPromptController(
  input: RunFixedPromptControllerInput,
): Promise<FixedPromptControllerResult> {
  const now = input.now ?? Date.now;
  const newId = input.newId ?? randomId;
  // Fail loud on out-of-contract guard knobs before any work: a NaN ceiling or
  // ratio would make `cost >= ceiling` / `rate > ratio` always false and
  // silently disable the guard (maxConcurrency is checked in normalizeMaxConcurrency).
  if (input.costCeilingUsd !== undefined)
    assertFinitePositive('costCeilingUsd', input.costCeilingUsd);
  if (input.maxInfraFailureRate !== undefined)
    assertRatio('maxInfraFailureRate', input.maxInfraFailureRate);
  if (input.protectPassAtOne && input.infraFailurePolicy === 'retry-once') {
    throw new Error('protectPassAtOne is incompatible with infraFailurePolicy retry-once');
  }
  const terminalInfraFailures = input.protectPassAtOne || input.infraFailurePolicy === 'terminal';
  assertUniqueTaskIds(input.tasks.map((task) => task.id));
  const systemPrompt = await readFile(input.systemPromptPath, 'utf8');
  const expectedPromptHash = hashSystemPrompt(systemPrompt);
  const config = { ...input.config, systemPrompt };
  const events = await readFixedPromptWal(input.resultsJsonlPath);
  const attemptEvents = input.protectPassAtOne
    ? await readFixedPromptWal(attemptWalPath(input.resultsJsonlPath))
    : [];
  const completed = terminalTaskEvents(
    events,
    input.runId,
    input.roundId,
    expectedPromptHash,
    input.resumeFingerprint,
    terminalInfraFailures,
  );
  const orphanedAttempts = orphanedTaskAttempts(
    [...attemptEvents, ...events],
    input.runId,
    input.roundId,
    expectedPromptHash,
    input.resumeFingerprint,
  );
  for (const task of input.protectPassAtOne ? input.tasks : []) {
    if (completed.has(task.id) || !orphanedAttempts.has(task.id)) continue;
    const event = orphanedAttemptEvent({
      taskId: task.id,
      runId: input.runId,
      roundId: input.roundId,
      expectedPromptHash,
      resumeFingerprint: input.resumeFingerprint,
      id: newId(),
      ts: now(),
    });
    await appendFixedPromptWalEvent(input.resultsJsonlPath, event);
    events.push(event);
    completed.set(task.id, event);
  }
  const stopEvidence = roundTaskEvents(
    events,
    input.runId,
    input.roundId,
    expectedPromptHash,
    input.resumeFingerprint,
  );
  let stopReason = controllerStopReason({
    events: [...stopEvidence.values()],
    taskCount: input.tasks.length,
    maxInfraFailureRate: input.maxInfraFailureRate,
    costCeilingUsd: input.costCeilingUsd,
  });
  // Stop guards are checked after completed tasks; in-flight tasks are allowed
  // to finish so configured concurrency remains useful for benchmark waves.
  const maxConcurrency = normalizeMaxConcurrency(input.maxConcurrency);
  let nextTaskIndex = 0;
  let nextAppendIndex = 0;
  const pendingEvents = new Map<number, FixedPromptTaskWalEvent>();
  const active = new Map<number, Promise<{ index: number; event: FixedPromptTaskWalEvent }>>();

  const appendReadyEvents = async () => {
    while (nextAppendIndex < input.tasks.length) {
      const task = input.tasks[nextAppendIndex]!;
      if (completed.has(task.id) && !pendingEvents.has(nextAppendIndex)) {
        nextAppendIndex += 1;
        continue;
      }
      const event = pendingEvents.get(nextAppendIndex);
      if (!event) break;
      await appendFixedPromptWalEvent(input.resultsJsonlPath, event);
      events.push(event);
      completed.set(event.taskId, event);
      stopEvidence.set(event.taskId, event);
      pendingEvents.delete(nextAppendIndex);
      nextAppendIndex += 1;
    }
  };

  const launchReadyTasks = () => {
    while (!stopReason && active.size < maxConcurrency && nextTaskIndex < input.tasks.length) {
      const index = nextTaskIndex;
      const task = input.tasks[nextTaskIndex++]!;
      if (completed.has(task.id)) continue;
      active.set(
        index,
        runTaskAndBuildEvent({
          input,
          task,
          config,
          systemPrompt,
          expectedPromptHash,
          requireExecutionIdentity: input.requireExecutionIdentity,
          requireFinalUsage: input.requireFinalUsage,
          expectedPricingProfile: input.expectedPricingProfile,
          billingMode: input.billingMode,
          resumeFingerprint: input.resumeFingerprint,
          id: newId(),
          ts: now(),
          newId,
          now,
        }).then((event) => ({ index, event })),
      );
    }
  };

  launchReadyTasks();
  while (active.size > 0) {
    const { index, event } = await Promise.race(active.values());
    active.delete(index);
    pendingEvents.set(index, event);
    stopEvidence.set(event.taskId, event);
    stopReason = controllerStopReason({
      events: [...stopEvidence.values()],
      taskCount: input.tasks.length,
      maxInfraFailureRate: input.maxInfraFailureRate,
      costCeilingUsd: input.costCeilingUsd,
    });
    await appendReadyEvents();
    launchReadyTasks();
  }
  await appendReadyEvents();

  const resultByTask = stopReason ? stopEvidence : completed;
  const resultEvents = input.tasks
    .map((task) => resultByTask.get(task.id))
    .filter((event): event is FixedPromptTaskWalEvent => event !== undefined);
  if (input.resultsTsvPath !== undefined) {
    await writeFixedPromptResultsTsv(input.resultsTsvPath, resultEvents);
  }

  return {
    taskIds: resultEvents.map((event) => event.taskId),
    events: resultEvents,
    totalTokens: sum(resultEvents.map((event) => eventTokenSummary(event)?.total ?? 0)),
    totalCostUsd: sum(resultEvents.map((event) => eventTokenSummary(event)?.costUsd ?? 0)),
    ...(input.resultsTsvPath !== undefined ? { resultsTsvPath: input.resultsTsvPath } : {}),
    ...(stopReason ? { stopReason } : {}),
  };
}

function assertUniqueTaskIds(taskIds: readonly string[]): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const taskId of taskIds) {
    if (seen.has(taskId)) duplicates.add(taskId);
    seen.add(taskId);
  }
  if (duplicates.size > 0) {
    throw new Error(`tasks contain duplicate id(s): ${[...duplicates].sort().join(', ')}`);
  }
}

export async function readFixedPromptWal(path: string): Promise<FixedPromptWalEvent[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const lines = raw.split('\n');
  const events: FixedPromptWalEvent[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim().length === 0) continue;
    try {
      events.push(JSON.parse(line) as FixedPromptWalEvent);
    } catch (error) {
      if (index === lines.length - 1 && !raw.endsWith('\n')) break;
      throw error;
    }
  }
  return events.map(projectLegacyTimeoutOutcome).map(projectStructuredVerifierPassOutcome);
}

export async function readHarborTaskRunOutput(
  input: ReadHarborTaskRunOutputInput,
): Promise<TaskRunOutput> {
  return {
    harbor: {
      reward: harborReward(await readJsonObject(input.harborResultPath)),
    },
    cell: validateHarborCellOutput(await readJsonObject(input.cellOutputPath)),
  };
}

export function appendFixedPromptWalEvent(
  path: string,
  event: FixedPromptWalEvent,
  options: { flush?: boolean } = {},
): Promise<void> {
  const key = resolve(path);
  const previous = walWriteTails.get(key) ?? Promise.resolve();
  const operation = async () => {
    await mkdir(dirname(path), { recursive: true });
    await truncateTornWalTail(path);
    const flush = options.flush ?? false;
    await appendFile(path, `${JSON.stringify(event)}\n`, { encoding: 'utf8', flush });
    if (flush) await syncParentDirectory(path);
  };
  const write = previous.then(operation, operation);
  const tail = write.then(
    () => {},
    () => {},
  );
  walWriteTails.set(key, tail);
  void tail.then(() => {
    if (walWriteTails.get(key) === tail) walWriteTails.delete(key);
  });
  return write;
}

export async function writeFixedPromptResultsTsv(
  path: string,
  events: readonly FixedPromptTaskWalEvent[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const header = [
    'task_id',
    'status',
    'passed',
    'scored',
    'eligible',
    'error_class',
    'prompt_hash',
    'tokens',
    'cost_usd',
    'runtime_events_path',
  ];
  const rows = events.map((event) => {
    const tokenSummary = eventTokenSummary(event);
    return [
      event.taskId,
      event.status,
      String(event.passed),
      String(event.scored),
      String(event.eligible),
      event.errorClass ?? '',
      'promptHash' in event ? (event.promptHash ?? '') : '',
      tokenSummary ? String(tokenSummary.total) : '',
      tokenSummary ? String(tokenSummary.costUsd) : '',
      'runtimeEventsPath' in event ? (event.runtimeEventsPath ?? '') : '',
    ];
  });
  const body = [header, ...rows].map((row) => row.map(tsvCell).join('\t')).join('\n');
  await writeFile(path, `${body}\n`, 'utf8');
}

async function runTaskAndBuildEvent(input: {
  input: RunFixedPromptControllerInput;
  task: FixedPromptTask;
  config: Config;
  systemPrompt: string;
  expectedPromptHash: string;
  requireExecutionIdentity?: boolean;
  requireFinalUsage?: boolean;
  expectedPricingProfile?: string;
  billingMode?: HarborBillingMode;
  resumeFingerprint?: string;
  id: string;
  ts: number;
  newId: () => string;
  now: () => number;
}): Promise<FixedPromptTaskWalEvent> {
  if (input.input.protectPassAtOne) {
    const attemptStarted: FixedPromptTaskAttemptStartedEvent = {
      schemaVersion: FIXED_PROMPT_WAL_SCHEMA_VERSION,
      type: 'task_attempt_started',
      id: input.newId(),
      ts: input.now(),
      runId: input.input.runId,
      roundId: input.input.roundId,
      ...(input.resumeFingerprint ? { resumeFingerprint: input.resumeFingerprint } : {}),
      taskId: input.task.id,
      promptHash: input.expectedPromptHash,
    };
    await appendFixedPromptWalEvent(attemptWalPath(input.input.resultsJsonlPath), attemptStarted, {
      flush: true,
    });
  }
  const runHarbor = () =>
    input.input.taskRunner({
      runId: input.input.runId,
      roundId: input.input.roundId,
      task: input.task,
      config: input.config,
      systemPrompt: input.systemPrompt,
    });
  let output;
  try {
    output = await runHarbor();
  } catch (error) {
    if (isBudgetExhaustedError(error)) {
      return taskBudgetExhaustedEvent({
        error,
        taskId: input.task.id,
        runId: input.input.runId,
        roundId: input.input.roundId,
        expectedPromptHash: input.expectedPromptHash,
        expectedConfig: input.config,
        requireExecutionIdentity: input.requireExecutionIdentity,
        requireFinalUsage: input.requireFinalUsage,
        expectedPricingProfile: input.expectedPricingProfile,
        billingMode: input.billingMode,
        resumeFingerprint: input.resumeFingerprint,
        id: input.id,
        ts: input.ts,
      });
    }
    if (input.input.protectPassAtOne || input.input.infraFailurePolicy === 'terminal') {
      return taskInfraFailedEvent({
        error,
        taskId: input.task.id,
        runId: input.input.runId,
        roundId: input.input.roundId,
        resumeFingerprint: input.resumeFingerprint,
        id: input.id,
        ts: input.ts,
      });
    }
    // #64: a thrown Harbor/Docker error is an infra failure, often a transient
    // flake (container build hiccup). Retry the same task + prompt once
    // before recording task_infra_failed, so a single blip does not pollute the
    // candidate's decision. A second failure is treated as a real infra failure.
    // A budget exhaustion is a benchmark outcome, not an infra flake, so it is
    // recorded immediately and counted separately by A/B reports.
    // A plumbing failure (a successful run with bad output) does not throw and is
    // not retried — it is deterministic.
    try {
      output = await runHarbor();
    } catch (error) {
      if (isBudgetExhaustedError(error)) {
        return taskBudgetExhaustedEvent({
          error,
          taskId: input.task.id,
          runId: input.input.runId,
          roundId: input.input.roundId,
          expectedPromptHash: input.expectedPromptHash,
          expectedConfig: input.config,
          requireExecutionIdentity: input.requireExecutionIdentity,
          requireFinalUsage: input.requireFinalUsage,
          expectedPricingProfile: input.expectedPricingProfile,
          billingMode: input.billingMode,
          resumeFingerprint: input.resumeFingerprint,
          id: input.id,
          ts: input.ts,
        });
      }
      return taskInfraFailedEvent({
        error,
        taskId: input.task.id,
        runId: input.input.runId,
        roundId: input.input.roundId,
        resumeFingerprint: input.resumeFingerprint,
        id: input.id,
        ts: input.ts,
      });
    }
  }
  return taskEventFromOutput({
    output,
    expectedConfig: input.config,
    expectedPromptHash: input.expectedPromptHash,
    requireExecutionIdentity: input.requireExecutionIdentity,
    requireFinalUsage: input.requireFinalUsage,
    expectedPricingProfile: input.expectedPricingProfile,
    billingMode: input.billingMode,
    resumeFingerprint: input.resumeFingerprint,
    taskId: input.task.id,
    runId: input.input.runId,
    roundId: input.input.roundId,
    id: input.id,
    ts: input.ts,
  });
}

function taskEventFromOutput(input: {
  output: TaskRunOutput;
  expectedConfig: Config;
  expectedPromptHash: string;
  requireExecutionIdentity?: boolean;
  requireFinalUsage?: boolean;
  expectedPricingProfile?: string;
  billingMode?: HarborBillingMode;
  resumeFingerprint?: string;
  taskId: string;
  runId: string;
  roundId: string;
  id: string;
  ts: number;
}):
  | FixedPromptTaskCompletedEvent
  | FixedPromptTaskPlumbingFailedEvent
  | FixedPromptTaskInfraFailedEvent {
  const structuredVerifierPassed =
    input.output.harbor.reward > 0 && input.output.harbor.verifier?.outcome === 'passed';
  const identityMismatch = classifyExplicitIdentityMismatch(
    input.output.cell.executionIdentity,
    input.expectedPromptHash,
    input.expectedConfig,
    input.expectedPricingProfile,
  );
  if (identityMismatch) {
    return taskPlumbingFailedEvent({
      ...input,
      errorClass: identityMismatch.errorClass,
      error: identityMismatch.error,
    });
  }
  if (isProviderInfraFailure(input.output.cell.errorClass) && !structuredVerifierPassed) {
    return taskInfraFailedEvent({
      ...input,
      errorClass: input.output.cell.errorClass,
      error: `Harbor cell failed with ${input.output.cell.errorClass}`,
    });
  }
  const plumbingFailure = classifyPlumbingFailure(
    input.output,
    input.expectedPromptHash,
    input.expectedConfig,
    input.requireExecutionIdentity ?? false,
    input.requireFinalUsage ?? false,
    input.expectedPricingProfile,
    input.billingMode,
  );
  if (plumbingFailure) {
    return taskPlumbingFailedEvent({
      ...input,
      errorClass: plumbingFailure.errorClass,
      error: plumbingFailure.error,
    });
  }
  return taskCompletedEvent(input);
}

function taskCompletedEvent(input: {
  output: TaskRunOutput;
  taskId: string;
  runId: string;
  roundId: string;
  resumeFingerprint?: string;
  id: string;
  ts: number;
}): FixedPromptTaskCompletedEvent {
  const { output } = input;
  const promptHash = output.cell.promptHash ?? output.cell.executionIdentity?.systemPromptHash;
  const deadlineSettled = output.cell.deadlineSettlement?.source === 'benchmark.deadline';
  const structuredVerifierPassed =
    output.harbor.reward > 0 && output.harbor.verifier?.outcome === 'passed';
  const verifierGraded =
    output.cell.status === 'completed' ||
    deadlineSettled ||
    structuredVerifierPassed ||
    ((output.cell.errorClass === 'max_tokens' ||
      output.cell.errorClass === 'tool_step_cap_reached' ||
      output.cell.errorClass === 'policy_denied') &&
      output.harbor.verifier !== undefined);
  const passed = verifierGraded && output.harbor.reward > 0;
  const errorClass = passed
    ? undefined
    : deadlineSettled
      ? 'budget_exhausted'
      : (output.cell.errorClass ?? 'verification_failed');
  const scored = verifierGraded && !isUnscoredCellFailure(errorClass);
  const agentFailure = output.cell.status === 'failed' && errorClass === 'tool_step_cap_reached';
  return {
    schemaVersion: FIXED_PROMPT_WAL_SCHEMA_VERSION,
    type: 'task_completed',
    id: input.id,
    ts: input.ts,
    runId: input.runId,
    roundId: input.roundId,
    ...(input.resumeFingerprint ? { resumeFingerprint: input.resumeFingerprint } : {}),
    taskId: input.taskId,
    status: output.cell.status,
    passed,
    scored,
    eligible: scored || agentFailure,
    ...(errorClass ? { errorClass } : {}),
    ...(promptHash ? { promptHash } : {}),
    ...(output.cell.executionIdentity ? { executionIdentity: output.cell.executionIdentity } : {}),
    ...(output.cell.deadlineSettlement
      ? { deadlineSettlement: output.cell.deadlineSettlement }
      : {}),
    ...(output.cell.tokenSummary ? { tokenSummary: output.cell.tokenSummary } : {}),
    ...(output.cell.contextBudgetPolicy
      ? { contextBudgetPolicy: output.cell.contextBudgetPolicy }
      : {}),
    ...(output.cell.contextBudgetSummary
      ? { contextBudgetSummary: output.cell.contextBudgetSummary }
      : {}),
    ...(output.cell.continuationSummary
      ? { continuationSummary: output.cell.continuationSummary }
      : {}),
    ...(output.cell.taskToolSummary ? { taskToolSummary: output.cell.taskToolSummary } : {}),
    steps: output.cell.steps,
    durationMs: output.cell.durationMs,
    runtimeEventsPath: output.cell.runtimeEventsPath,
    ...(output.cell.traceEventsPath ? { traceEventsPath: output.cell.traceEventsPath } : {}),
    ...(output.cell.providerTelemetryPath
      ? { providerTelemetryPath: output.cell.providerTelemetryPath }
      : {}),
    harbor: {
      reward: output.harbor.reward,
      ...(output.harbor.verifierFailureSummary
        ? { verifierFailureSummary: output.harbor.verifierFailureSummary }
        : {}),
      ...(output.harbor.verifier ? { verifier: output.harbor.verifier } : {}),
    },
  };
}

function isUnscoredCellFailure(
  errorClass: string | undefined,
): errorClass is UnscoredCellFailureClass {
  return (
    errorClass === 'infra_failed' ||
    errorClass === 'setup_failed' ||
    errorClass === 'verification_error'
  );
}

function taskPlumbingFailedEvent(input: {
  output: TaskRunOutput;
  expectedPromptHash: string;
  resumeFingerprint?: string;
  taskId: string;
  runId: string;
  roundId: string;
  id: string;
  ts: number;
  errorClass: FixedPromptTaskPlumbingFailedEvent['errorClass'];
  error: string;
}): FixedPromptTaskPlumbingFailedEvent {
  return {
    schemaVersion: FIXED_PROMPT_WAL_SCHEMA_VERSION,
    type: 'task_plumbing_failed',
    id: input.id,
    ts: input.ts,
    runId: input.runId,
    roundId: input.roundId,
    ...(input.resumeFingerprint ? { resumeFingerprint: input.resumeFingerprint } : {}),
    taskId: input.taskId,
    status: 'plumbing_failed',
    passed: false,
    scored: false,
    eligible: false,
    errorClass: input.errorClass,
    error: input.error,
    ...(input.output.cell.promptHash ? { promptHash: input.output.cell.promptHash } : {}),
    expectedPromptHash: input.expectedPromptHash,
    ...(input.output.cell.tokenSummary ? { tokenSummary: input.output.cell.tokenSummary } : {}),
    ...(input.output.cell.contextBudgetPolicy
      ? { contextBudgetPolicy: input.output.cell.contextBudgetPolicy }
      : {}),
    ...(input.output.cell.contextBudgetSummary
      ? { contextBudgetSummary: input.output.cell.contextBudgetSummary }
      : {}),
    ...(input.output.cell.continuationSummary
      ? { continuationSummary: input.output.cell.continuationSummary }
      : {}),
    ...(input.output.cell.taskToolSummary
      ? { taskToolSummary: input.output.cell.taskToolSummary }
      : {}),
    steps: input.output.cell.steps,
    durationMs: input.output.cell.durationMs,
    runtimeEventsPath: input.output.cell.runtimeEventsPath,
    ...(input.output.cell.traceEventsPath
      ? { traceEventsPath: input.output.cell.traceEventsPath }
      : {}),
    ...(input.output.cell.providerTelemetryPath
      ? { providerTelemetryPath: input.output.cell.providerTelemetryPath }
      : {}),
    harbor: {
      reward: input.output.harbor.reward,
    },
  };
}

function classifyPlumbingFailure(
  output: TaskRunOutput,
  expectedPromptHash: string,
  expectedConfig: Config,
  requireExecutionIdentity: boolean,
  requireFinalUsage: boolean,
  expectedPricingProfile: string | undefined,
  billingMode: HarborBillingMode | undefined,
):
  | {
      errorClass: FixedPromptTaskPlumbingFailedEvent['errorClass'];
      error: string;
    }
  | undefined {
  const identityFailure = classifyExecutionIdentityFailure(
    output.cell.executionIdentity,
    expectedPromptHash,
    expectedConfig,
    requireExecutionIdentity,
    expectedPricingProfile,
  );
  if (identityFailure) return identityFailure;
  if (output.cell.status === 'completed' && output.cell.promptHash === undefined) {
    return {
      errorClass: 'missing_prompt_hash',
      error: `Harbor cell did not report prompt hash ${expectedPromptHash}`,
    };
  }
  if (output.cell.promptHash !== undefined && output.cell.promptHash !== expectedPromptHash) {
    return {
      errorClass: 'prompt_hash_mismatch',
      error: `Harbor cell prompt hash ${output.cell.promptHash} did not match ${expectedPromptHash}`,
    };
  }
  if (
    requireFinalUsage &&
    (output.cell.status === 'completed' ||
      output.cell.deadlineSettlement?.source === 'benchmark.deadline') &&
    output.cell.tokenSummary === undefined
  ) {
    return {
      errorClass: 'missing_token_usage',
      error: 'Harbor cell did not report final token usage',
    };
  }
  if (
    billingMode !== 'account-plan' &&
    output.cell.tokenSummary &&
    output.cell.tokenSummary.total > 0 &&
    output.cell.tokenSummary.costUsd === 0
  ) {
    return {
      errorClass: 'zero_cost_with_tokens',
      error: 'Harbor cell reported token usage but zero costUsd',
    };
  }
  return undefined;
}

function classifyExecutionIdentityFailure(
  identity: HarborCellExecutionIdentity | undefined,
  expectedPromptHash: string,
  expectedConfig: Config,
  requireExecutionIdentity: boolean,
  expectedPricingProfile: string | undefined,
):
  | {
      errorClass: Extract<
        FixedPromptTaskPlumbingFailedEvent['errorClass'],
        'missing_execution_identity' | 'execution_identity_mismatch'
      >;
      error: string;
    }
  | undefined {
  if (requireExecutionIdentity && !identity) {
    return {
      errorClass: 'missing_execution_identity',
      error:
        'Harbor cell did not attest the connection, model, prompt, and pricing profile that executed',
    };
  }
  if (identity) {
    const modelPrefix = `${expectedConfig.llmConnectionSlug}/`;
    const expectedModel = expectedConfig.model?.startsWith(modelPrefix)
      ? expectedConfig.model.slice(modelPrefix.length)
      : expectedConfig.model;
    if (
      identity.llmConnectionSlug !== expectedConfig.llmConnectionSlug ||
      identity.model !== expectedModel ||
      identity.reasoningEffort !== expectedConfig.thinkingLevel ||
      identity.agentTools !== (expectedConfig.agentTools === true) ||
      identity.systemPromptHash !== expectedPromptHash ||
      (expectedPricingProfile !== undefined && identity.pricingProfile !== expectedPricingProfile)
    ) {
      return {
        errorClass: 'execution_identity_mismatch',
        error:
          'Harbor cell execution identity did not match the configured connection, model, and prompt',
      };
    }
  }
  return undefined;
}

function classifyExplicitIdentityMismatch(
  identity: HarborCellExecutionIdentity | undefined,
  expectedPromptHash: string,
  expectedConfig: Config,
  expectedPricingProfile: string | undefined,
): { errorClass: 'execution_identity_mismatch'; error: string } | undefined {
  if (!identity) return undefined;
  const failure = classifyExecutionIdentityFailure(
    identity,
    expectedPromptHash,
    expectedConfig,
    false,
    expectedPricingProfile,
  );
  return failure?.errorClass === 'execution_identity_mismatch'
    ? { errorClass: failure.errorClass, error: failure.error }
    : undefined;
}

function taskInfraFailedEvent(input: {
  error: unknown;
  output?: TaskRunOutput;
  errorClass?: FixedPromptTaskInfraFailedEvent['errorClass'];
  taskId: string;
  runId: string;
  roundId: string;
  resumeFingerprint?: string;
  id: string;
  ts: number;
}): FixedPromptTaskInfraFailedEvent {
  const providerTelemetryPath =
    input.output?.cell.providerTelemetryPath ?? providerTelemetryPathFromError(input.error);
  return {
    schemaVersion: FIXED_PROMPT_WAL_SCHEMA_VERSION,
    type: 'task_infra_failed',
    id: input.id,
    ts: input.ts,
    runId: input.runId,
    roundId: input.roundId,
    ...(input.resumeFingerprint ? { resumeFingerprint: input.resumeFingerprint } : {}),
    taskId: input.taskId,
    status: 'infra_failed',
    passed: false,
    scored: false,
    eligible: false,
    errorClass: input.errorClass ?? 'infra_error',
    error: errorMessage(input.error),
    ...(providerTelemetryPath ? { providerTelemetryPath } : {}),
  };
}

function providerTelemetryPathFromError(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const path = (
    error as Error & {
      artifactRefs?: { providerTelemetryPath?: unknown };
    }
  ).artifactRefs?.providerTelemetryPath;
  return typeof path === 'string' && path.length > 0 ? path : undefined;
}

function taskBudgetExhaustedEvent(input: {
  error: unknown;
  taskId: string;
  runId: string;
  roundId: string;
  expectedPromptHash: string;
  expectedConfig: Config;
  requireExecutionIdentity?: boolean;
  requireFinalUsage?: boolean;
  expectedPricingProfile?: string;
  billingMode?: HarborBillingMode;
  resumeFingerprint?: string;
  id: string;
  ts: number;
}): FixedPromptTaskBudgetExhaustedEvent {
  const artifactRefs = budgetExhaustedArtifactRefs(input.error);
  let evidenceFailure:
    | {
        errorClass: NonNullable<FixedPromptTaskBudgetExhaustedEvent['evidenceErrorClass']>;
        error: string;
      }
    | undefined;
  if (artifactRefs.cellOutput) {
    const output = { harbor: { reward: 0 }, cell: artifactRefs.cellOutput };
    const identityMismatch = classifyExplicitIdentityMismatch(
      output.cell.executionIdentity,
      input.expectedPromptHash,
      input.expectedConfig,
      input.expectedPricingProfile,
    );
    evidenceFailure =
      identityMismatch ??
      (isProviderInfraFailure(output.cell.errorClass)
        ? {
            errorClass: output.cell.errorClass,
            error: `Harbor cell failed with ${output.cell.errorClass}`,
          }
        : isUnscoredCellFailure(output.cell.errorClass)
          ? {
              errorClass: output.cell.errorClass,
              error: `Harbor cell failed with ${output.cell.errorClass}`,
            }
          : classifyPlumbingFailure(
              output,
              input.expectedPromptHash,
              input.expectedConfig,
              input.requireExecutionIdentity ?? false,
              input.requireFinalUsage ?? false,
              input.expectedPricingProfile,
              input.billingMode,
            ));
  } else {
    evidenceFailure = classifyExecutionIdentityFailure(
      artifactRefs.executionIdentity,
      input.expectedPromptHash,
      input.expectedConfig,
      input.requireExecutionIdentity ?? false,
      input.expectedPricingProfile,
    );
    if (evidenceFailure?.errorClass === 'missing_execution_identity') {
      evidenceFailure = {
        ...evidenceFailure,
        error: LEGACY_TIMEOUT_MISSING_EXECUTION_IDENTITY_ERROR,
      };
    }
  }
  const tokenSummary = artifactRefs.cellOutput?.tokenSummary ?? artifactRefs.tokenSummary;
  const tokenSummarySource = tokenSummary
    ? artifactRefs.cellOutput
      ? 'final'
      : 'checkpoint'
    : undefined;
  const executionIdentity =
    artifactRefs.cellOutput?.executionIdentity ?? artifactRefs.executionIdentity;
  const cellOutput = artifactRefs.cellOutput;
  const runtimeEventsPath = artifactRefs.runtimeEventsPath ?? cellOutput?.runtimeEventsPath;
  const traceEventsPath = artifactRefs.traceEventsPath ?? cellOutput?.traceEventsPath;
  const providerTelemetryPath =
    artifactRefs.providerTelemetryPath ?? cellOutput?.providerTelemetryPath;
  return {
    schemaVersion: FIXED_PROMPT_WAL_SCHEMA_VERSION,
    type: 'task_budget_exhausted',
    id: input.id,
    ts: input.ts,
    runId: input.runId,
    roundId: input.roundId,
    ...(input.resumeFingerprint ? { resumeFingerprint: input.resumeFingerprint } : {}),
    taskId: input.taskId,
    status: 'budget_exhausted',
    passed: false,
    scored: false,
    eligible: evidenceFailure === undefined,
    errorClass: 'budget_exhausted',
    error: errorMessage(input.error),
    ...(evidenceFailure
      ? {
          evidenceErrorClass: evidenceFailure.errorClass,
          evidenceError: evidenceFailure.error,
        }
      : {}),
    expectedPromptHash: input.expectedPromptHash,
    ...(executionIdentity ? { executionIdentity } : {}),
    ...(runtimeEventsPath ? { runtimeEventsPath } : {}),
    ...(traceEventsPath ? { traceEventsPath } : {}),
    ...(providerTelemetryPath ? { providerTelemetryPath } : {}),
    ...(artifactRefs.runtimeEventsUnavailableReason
      ? { runtimeEventsUnavailableReason: artifactRefs.runtimeEventsUnavailableReason }
      : {}),
    ...(tokenSummary ? { tokenSummary } : {}),
    ...(tokenSummarySource ? { tokenSummarySource } : {}),
    ...(cellOutput?.contextBudgetPolicy
      ? { contextBudgetPolicy: cellOutput.contextBudgetPolicy }
      : {}),
    ...(cellOutput?.contextBudgetSummary
      ? { contextBudgetSummary: cellOutput.contextBudgetSummary }
      : {}),
    ...(cellOutput?.continuationSummary
      ? { continuationSummary: cellOutput.continuationSummary }
      : {}),
    ...(cellOutput?.taskToolSummary ? { taskToolSummary: cellOutput.taskToolSummary } : {}),
    ...(cellOutput ? { steps: cellOutput.steps, durationMs: cellOutput.durationMs } : {}),
  };
}

function projectLegacyTimeoutOutcome(event: FixedPromptWalEvent): FixedPromptWalEvent {
  if (
    event.type !== 'task_plumbing_failed' ||
    event.errorClass !== 'missing_execution_identity' ||
    event.error !== LEGACY_TIMEOUT_MISSING_EXECUTION_IDENTITY_ERROR ||
    event.expectedPromptHash === undefined
  ) {
    return event;
  }
  return {
    schemaVersion: event.schemaVersion,
    type: 'task_budget_exhausted',
    id: event.id,
    ts: event.ts,
    runId: event.runId,
    roundId: event.roundId,
    ...(event.resumeFingerprint ? { resumeFingerprint: event.resumeFingerprint } : {}),
    taskId: event.taskId,
    status: 'budget_exhausted',
    passed: false,
    scored: false,
    eligible: false,
    errorClass: 'budget_exhausted',
    error: 'Harbor attempt exhausted its configured time budget',
    evidenceErrorClass: event.errorClass,
    evidenceError: event.error,
    expectedPromptHash: event.expectedPromptHash,
    ...(event.tokenSummary ? { tokenSummary: event.tokenSummary } : {}),
    ...(event.runtimeEventsPath ? { runtimeEventsPath: event.runtimeEventsPath } : {}),
    ...(event.traceEventsPath ? { traceEventsPath: event.traceEventsPath } : {}),
    ...(event.providerTelemetryPath ? { providerTelemetryPath: event.providerTelemetryPath } : {}),
    ...(event.contextBudgetPolicy ? { contextBudgetPolicy: event.contextBudgetPolicy } : {}),
    ...(event.contextBudgetSummary ? { contextBudgetSummary: event.contextBudgetSummary } : {}),
    ...(event.continuationSummary ? { continuationSummary: event.continuationSummary } : {}),
    ...(event.taskToolSummary ? { taskToolSummary: event.taskToolSummary } : {}),
    ...(event.steps !== undefined ? { steps: event.steps } : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
  };
}

function projectStructuredVerifierPassOutcome(event: FixedPromptWalEvent): FixedPromptWalEvent {
  if (
    event.type !== 'task_completed' ||
    event.harbor.reward <= 0 ||
    event.harbor.verifier?.outcome !== 'passed'
  )
    return event;
  const { errorClass: _legacyFailureClass, ...rest } = event;
  return {
    ...rest,
    passed: true,
    scored: true,
    eligible: true,
  };
}

function budgetExhaustedArtifactRefs(error: unknown): FixedPromptBudgetExhaustedArtifactRefs {
  if (isBudgetExhaustedError(error)) {
    const refs = (error as { artifactRefs?: FixedPromptBudgetExhaustedArtifactRefs }).artifactRefs;
    if (
      refs &&
      (refs.runtimeEventsPath ||
        refs.traceEventsPath ||
        refs.providerTelemetryPath ||
        refs.runtimeEventsUnavailableReason ||
        refs.tokenSummary ||
        refs.cellOutput ||
        refs.executionIdentity)
    )
      return refs;
  }
  return { runtimeEventsUnavailableReason: BUDGET_EXHAUSTED_RUNTIME_UNAVAILABLE_REASON };
}

function terminalTaskEvents(
  events: readonly FixedPromptWalEvent[],
  runId: string,
  roundId: string,
  expectedPromptHash: string,
  resumeFingerprint: string | undefined,
  includeInfraFailure: boolean,
): Map<string, FixedPromptTaskWalEvent> {
  const byTask = new Map<string, FixedPromptTaskWalEvent>();
  for (const event of events) {
    if (!isTaskEvent(event)) continue;
    if (event.runId !== runId || event.roundId !== roundId) continue;
    if (!eventMatchesResumeIdentity(event, expectedPromptHash, resumeFingerprint)) continue;
    if (
      event.type === 'task_completed' ||
      event.type === 'task_budget_exhausted' ||
      event.type === 'task_plumbing_failed' ||
      (includeInfraFailure && event.type === 'task_infra_failed')
    ) {
      setAuthoritativeTaskEvent(byTask, event);
    }
  }
  return byTask;
}

function orphanedTaskAttempts(
  events: readonly FixedPromptWalEvent[],
  runId: string,
  roundId: string,
  expectedPromptHash: string,
  resumeFingerprint: string | undefined,
): Map<string, FixedPromptTaskAttemptStartedEvent> {
  const pending = new Map<string, FixedPromptTaskAttemptStartedEvent>();
  for (const event of events) {
    if (event.runId !== runId || event.roundId !== roundId) continue;
    if (event.type === 'task_attempt_started') {
      if (event.promptHash !== expectedPromptHash) continue;
      if (resumeFingerprint !== undefined && event.resumeFingerprint !== resumeFingerprint)
        continue;
      pending.set(event.taskId, event);
      continue;
    }
    if (!isTaskEvent(event)) continue;
    const started = pending.get(event.taskId);
    if (!started || event.resumeFingerprint !== started.resumeFingerprint) continue;
    if (
      event.type !== 'task_infra_failed' &&
      (!('promptHash' in event) || event.promptHash !== started.promptHash) &&
      (!('expectedPromptHash' in event) || event.expectedPromptHash !== started.promptHash)
    )
      continue;
    pending.delete(event.taskId);
  }
  return pending;
}

function attemptWalPath(resultsJsonlPath: string): string {
  return `${resultsJsonlPath}.attempts.jsonl`;
}

function orphanedAttemptEvent(input: {
  taskId: string;
  runId: string;
  roundId: string;
  expectedPromptHash: string;
  resumeFingerprint?: string;
  id: string;
  ts: number;
}): FixedPromptTaskPlumbingFailedEvent {
  return {
    schemaVersion: FIXED_PROMPT_WAL_SCHEMA_VERSION,
    type: 'task_plumbing_failed',
    id: input.id,
    ts: input.ts,
    runId: input.runId,
    roundId: input.roundId,
    ...(input.resumeFingerprint ? { resumeFingerprint: input.resumeFingerprint } : {}),
    taskId: input.taskId,
    status: 'plumbing_failed',
    passed: false,
    scored: false,
    eligible: false,
    errorClass: 'orphaned_sampled_attempt',
    error: 'An admitted Harbor attempt ended without a terminal event; refusing to resample Pass@1',
    expectedPromptHash: input.expectedPromptHash,
  };
}

function roundTaskEvents(
  events: readonly FixedPromptWalEvent[],
  runId: string,
  roundId: string,
  expectedPromptHash: string,
  resumeFingerprint: string | undefined,
): Map<string, FixedPromptTaskWalEvent> {
  const byTask = new Map<string, FixedPromptTaskWalEvent>();
  for (const event of events) {
    if (!isTaskEvent(event)) continue;
    if (event.runId !== runId || event.roundId !== roundId) continue;
    if (!eventMatchesResumeIdentity(event, expectedPromptHash, resumeFingerprint)) continue;
    setAuthoritativeTaskEvent(byTask, event);
  }
  return byTask;
}

function setAuthoritativeTaskEvent(
  byTask: Map<string, FixedPromptTaskWalEvent>,
  event: FixedPromptTaskWalEvent,
): void {
  const existing = byTask.get(event.taskId);
  if (
    existing?.scored &&
    event.type === 'task_plumbing_failed' &&
    event.errorClass === 'orphaned_sampled_attempt'
  )
    return;
  byTask.set(event.taskId, event);
}

export function selectFixedPromptRoundTaskEvents(
  events: readonly FixedPromptWalEvent[],
  runId: string,
  roundId: string,
  expectedPromptHash: string,
  resumeFingerprint: string,
): Map<string, FixedPromptTaskWalEvent> {
  return roundTaskEvents(events, runId, roundId, expectedPromptHash, resumeFingerprint);
}

function eventMatchesResumeIdentity(
  event: FixedPromptTaskWalEvent,
  expectedPromptHash: string,
  resumeFingerprint: string | undefined,
): boolean {
  if (resumeFingerprint !== undefined && event.resumeFingerprint !== resumeFingerprint)
    return false;
  if (event.type === 'task_infra_failed') return true;
  if (event.type === 'task_budget_exhausted') {
    return resumeFingerprint !== undefined && event.expectedPromptHash === expectedPromptHash;
  }
  if (event.promptHash === expectedPromptHash) return true;
  if (
    'executionIdentity' in event &&
    event.executionIdentity?.systemPromptHash === expectedPromptHash
  )
    return true;
  return event.type === 'task_plumbing_failed' && event.expectedPromptHash === expectedPromptHash;
}

function isTaskEvent(event: FixedPromptWalEvent): event is FixedPromptTaskWalEvent {
  return (
    event.type === 'task_completed' ||
    event.type === 'task_infra_failed' ||
    event.type === 'task_budget_exhausted' ||
    event.type === 'task_plumbing_failed'
  );
}

function tsvCell(value: string): string {
  return value.replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function controllerStopReason(input: {
  events: readonly FixedPromptTaskWalEvent[];
  taskCount: number;
  maxInfraFailureRate?: number;
  costCeilingUsd?: number;
}): FixedPromptControllerStopReason | undefined {
  if (
    input.events.some(
      (event) =>
        (event.type === 'task_infra_failed' && isSystemicProviderFailure(event.errorClass)) ||
        (event.type === 'task_budget_exhausted' &&
          isSystemicProviderFailure(event.evidenceErrorClass)),
    )
  ) {
    return 'systemic_provider_failure';
  }
  if (
    input.maxInfraFailureRate !== undefined &&
    infraFailureRate(input.events, input.taskCount) > input.maxInfraFailureRate
  ) {
    return 'infra_failure_rate_exceeded';
  }
  if (
    input.costCeilingUsd !== undefined &&
    taskEventsCostUsd(input.events) >= input.costCeilingUsd
  ) {
    return 'cost_ceiling_exceeded';
  }
  return undefined;
}

function isSystemicProviderFailure(
  errorClass: string | undefined,
): errorClass is 'provider_billing' | 'auth' {
  return errorClass === 'provider_billing' || errorClass === 'auth';
}

function isProviderInfraFailure(
  errorClass: string | undefined,
): errorClass is 'provider_billing' | 'auth' | 'rate_limit' | 'provider_unavailable' | 'network' {
  return (
    isSystemicProviderFailure(errorClass) ||
    errorClass === 'rate_limit' ||
    errorClass === 'provider_unavailable' ||
    errorClass === 'network'
  );
}

function infraFailureRate(events: readonly FixedPromptTaskWalEvent[], taskCount: number): number {
  if (taskCount <= 0) return 0;
  return events.filter((event) => event.type === 'task_infra_failed').length / taskCount;
}

function taskEventsCostUsd(events: readonly FixedPromptTaskWalEvent[]): number {
  return sum(events.map((event) => eventTokenSummary(event)?.costUsd ?? 0));
}

function eventTokenSummary(event: FixedPromptTaskWalEvent): HarborCellTokenSummary | undefined {
  return 'tokenSummary' in event ? event.tokenSummary : undefined;
}

function isBudgetExhaustedError(error: unknown): boolean {
  return (
    error instanceof FixedPromptBudgetExhaustedError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'FixedPromptBudgetExhaustedError')
  );
}

function normalizeMaxConcurrency(value: number | undefined): number {
  if (value === undefined) return 1;
  // A fractional concurrency must fail loud, not be silently floored.
  return assertPositiveInt('maxConcurrency', value);
}

async function truncateTornWalTail(path: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  if (raw.length === 0 || raw.endsWith('\n')) return;
  const lastNewline = raw.lastIndexOf('\n');
  await truncate(path, lastNewline < 0 ? 0 : lastNewline + 1);
}

export function hashSystemPrompt(systemPrompt: string): string {
  return hashHeadlessSystemPrompt(systemPrompt);
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (!isRecord(value)) throw new Error(`${path} must contain a JSON object`);
  return value;
}

function harborReward(value: Record<string, unknown>): number {
  const direct = numericField(value, 'reward') ?? numericField(value, 'score');
  if (direct !== undefined) return direct;
  const metrics = isRecord(value.metrics) ? value.metrics : undefined;
  const nested = metrics
    ? (numericField(metrics, 'reward') ?? numericField(metrics, 'score'))
    : undefined;
  if (nested !== undefined) return nested;
  const verifierResult = isRecord(value.verifier_result) ? value.verifier_result : undefined;
  const verifierRewards =
    verifierResult && isRecord(verifierResult.rewards) ? verifierResult.rewards : undefined;
  const verifierReward = verifierRewards
    ? (numericField(verifierRewards, 'reward') ?? numericField(verifierRewards, 'score'))
    : undefined;
  if (verifierReward !== undefined) return verifierReward;
  throw new Error('Harbor result must include a numeric reward or score');
}

function numericField(value: Record<string, unknown>, field: string): number | undefined {
  const raw = value[field];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new Error(`Harbor result field ${field} must be a finite number`);
  }
  return raw;
}

function randomId(): string {
  return randomUUID();
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
