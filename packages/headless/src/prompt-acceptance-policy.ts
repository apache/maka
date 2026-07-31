import { appendFixedPromptWalEvent } from './fixed-prompt-controller.js';
import {
  FIXED_PROMPT_WAL_SCHEMA_VERSION,
  type FixedPromptTaskCompletedEvent,
  type FixedPromptWalEvent,
  type FixedPromptTaskWalEvent,
  type PromptCandidateDecisionEvent,
  type PromptCandidateRewardHackScan,
} from './fixed-prompt-wal-types.js';

export type PromptAcceptanceDecision = 'keep' | 'discard';

export const PROMPT_REWARD_HACK_QUARANTINE_REASON = 'reward_hack_quarantined';

export type PromptAcceptanceReason =
  | 'held_in_improved'
  | 'held_in_within_noise'
  | 'held_in_regressed'
  | 'coverage_regressed'
  | 'held_out_regressed'
  | 'sampling_baseline_not_beaten'
  | 'sampling_baseline_incomplete'
  | typeof PROMPT_REWARD_HACK_QUARANTINE_REASON;

export interface PromptAcceptancePartitionSummary {
  taskCount: number;
  observed: number;
  eligible: number;
  scored: number;
  passed: number;
  passEligibleRate: number | null;
  coverageRate: number | null;
  unscoredTaskIds: string[];
  infraFailedTaskIds: string[];
  plumbingFailedTaskIds: string[];
  missingTaskIds: string[];
}

export interface PromptAcceptanceMetrics {
  original: {
    heldOut: PromptAcceptancePartitionSummary;
  };
  lastKept: {
    heldIn: PromptAcceptancePartitionSummary;
  };
  candidate: {
    heldIn: PromptAcceptancePartitionSummary;
    heldOut: PromptAcceptancePartitionSummary;
  };
  samplingBaseline?: {
    heldIn: PromptAcceptancePartitionSummary;
  };
}

export interface PromptAcceptanceBaselineRun {
  heldInEvents: readonly FixedPromptTaskWalEvent[];
  heldOutEvents: readonly FixedPromptTaskWalEvent[];
}

export interface PromptAcceptanceBaselinePartition {
  taskCount: number;
  baselineRunCount: number;
  meanPassEligibleRate: number | null;
  observedSpread: number;
  noiseBand: number;
}

export interface PromptAcceptanceBaseline {
  heldIn: PromptAcceptanceBaselinePartition & {
    referencePassEligibleRate: number | null;
  };
  heldOut: PromptAcceptanceBaselinePartition & {
    originalPassEligibleRate: number | null;
  };
}

export interface CalibratePromptAcceptanceBaselineInput {
  heldInTaskIds: readonly string[];
  heldOutTaskIds: readonly string[];
  baselineRuns: readonly PromptAcceptanceBaselineRun[];
  zScore?: number;
}

export interface PromptAcceptanceNoiseBandInput {
  sampleSize: number;
  passRate: number | null;
  baselineRunCount: number;
  observedSpread?: number;
  zScore?: number;
}

export interface DecidePromptAcceptanceInput {
  runId: string;
  roundId: string;
  candidateCommitSha: string;
  previousLastKeptCommitSha: string;
  originalCommitSha: string;
  heldInTaskIds: readonly string[];
  heldOutTaskIds: readonly string[];
  previousHeldInReferencePassEligibleRate: number | null;
  originalHeldOutPassEligibleRate: number | null;
  heldInPassRateNoiseBand: number;
  heldOutPassRateNoiseBand: number;
  originalEvents: readonly FixedPromptTaskWalEvent[];
  lastKeptEvents: readonly FixedPromptTaskWalEvent[];
  candidateEvents: readonly FixedPromptTaskWalEvent[];
  samplingBaselineEvents?: readonly FixedPromptTaskWalEvent[];
  samplingPromptHash?: string;
  rewardHackScan?: PromptCandidateRewardHackScan;
}

export interface PromptAcceptanceResult {
  runId: string;
  roundId: string;
  decision: PromptAcceptanceDecision;
  reason: PromptAcceptanceReason;
  candidateCommitSha: string;
  previousLastKeptCommitSha: string;
  lastKeptCommitSha: string;
  previousHeldInReferencePassEligibleRate: number | null;
  heldInReferencePassEligibleRate: number | null;
  originalCommitSha: string;
  originalHeldOutPassEligibleRate: number | null;
  heldInPassRateNoiseBand: number;
  heldOutPassRateNoiseBand: number;
  rewardHackScan: PromptCandidateRewardHackScan;
  samplingPromptHash?: string;
  metrics: PromptAcceptanceMetrics;
}

export interface AppendPromptAcceptanceDecisionInput {
  resultsJsonlPath: string;
  id: string;
  ts: number;
  result: PromptAcceptanceResult;
}

export interface PromptAcceptanceState {
  lastKeptCommitSha: string;
  heldInReferencePassEligibleRate: number | null;
  decisions: Array<{
    roundId: string;
    decision: PromptAcceptanceDecision;
    candidateCommitSha: string;
  }>;
}

export type StablePromptTaskRejectionReason = 'incomplete' | 'unstable_outcome' | 'too_slow';

export interface SelectStablePromptTasksInput {
  taskIds: readonly string[];
  baselineRuns: readonly (readonly FixedPromptTaskWalEvent[])[];
  maxPassRateSpread?: number;
  maxDurationMs?: number;
}

export interface StablePromptTaskSelectionResult {
  selectedTaskIds: string[];
  rejectedTaskIds: Array<{
    taskId: string;
    reason: StablePromptTaskRejectionReason;
  }>;
}

export type PromptTaskAddressabilityRejectionReason = 'capability_limit' | 'flaky';

export interface PromptTaskAddressabilityStat {
  taskId: string;
  observations: number;
  keptPrompts: number;
  passes: number;
  flips: number;
  flipRate: number;
  addressable: boolean;
  rejectionReason?: PromptTaskAddressabilityRejectionReason;
}

export interface SelectAddressablePromptTasksInput {
  taskIds: readonly string[];
  /** Completed evaluations produced by prompts that were retained. The loop
   * grows this replay-stable prefix only after each KEEP decision; excluded
   * tasks continue to execute in candidate rounds. */
  keptPromptEvents: readonly FixedPromptTaskWalEvent[];
}

export interface PromptTaskAddressabilitySelectionResult {
  selectedTaskIds: string[];
  taskStats: PromptTaskAddressabilityStat[];
}

const MIN_FLAKY_TASK_OBSERVATIONS = 3;
const MAX_ADDRESSABLE_TASK_FLIP_RATE = 0.5;

export function calibratePromptAcceptanceBaseline(
  input: CalibratePromptAcceptanceBaselineInput,
): PromptAcceptanceBaseline {
  const heldInSummaries = input.baselineRuns.map((run) =>
    summarizePromptAcceptancePartition(run.heldInEvents, input.heldInTaskIds),
  );
  const heldOutSummaries = input.baselineRuns.map((run) =>
    summarizePromptAcceptancePartition(run.heldOutEvents, input.heldOutTaskIds),
  );
  assertCompleteBaselineSummaries(heldInSummaries, 'held-in');
  assertCompleteBaselineSummaries(heldOutSummaries, 'held-out');
  const heldIn = calibratePartitionBaseline(heldInSummaries, input.zScore);
  const heldOut = calibratePartitionBaseline(heldOutSummaries, input.zScore);
  return {
    heldIn: {
      ...heldIn,
      referencePassEligibleRate: heldIn.meanPassEligibleRate,
    },
    heldOut: {
      ...heldOut,
      originalPassEligibleRate: heldOut.meanPassEligibleRate,
    },
  };
}

function assertCompleteBaselineSummaries(
  summaries: readonly PromptAcceptancePartitionSummary[],
  partitionName: string,
): void {
  summaries.forEach((summary, index) => {
    if (
      summary.observed !== summary.taskCount ||
      summary.missingTaskIds.length > 0 ||
      summary.unscoredTaskIds.length > 0 ||
      summary.infraFailedTaskIds.length > 0 ||
      summary.plumbingFailedTaskIds.length > 0
    ) {
      throw new Error(`baseline ${partitionName} run ${index + 1} is incomplete`);
    }
  });
}

export function promptAcceptanceNoiseBand(input: PromptAcceptanceNoiseBandInput): number {
  if (input.zScore === undefined) return 0;
  const observedSpread = input.observedSpread ?? 0;
  if (input.sampleSize <= 0 || input.passRate === null || input.baselineRunCount <= 0) {
    return observedSpread;
  }
  const wilson = wilsonHalfWidth(input.sampleSize, input.passRate, input.zScore);
  const differenceWidth = wilson * Math.sqrt(1 + 1 / input.baselineRunCount);
  return Math.max(differenceWidth, observedSpread);
}

export function selectStablePromptTasks(
  input: SelectStablePromptTasksInput,
): StablePromptTaskSelectionResult {
  const maxPassRateSpread = input.maxPassRateSpread ?? 0;
  const selectedTaskIds: string[] = [];
  const rejectedTaskIds: StablePromptTaskSelectionResult['rejectedTaskIds'] = [];
  if (input.baselineRuns.length === 0) {
    return {
      selectedTaskIds,
      rejectedTaskIds: input.taskIds.map((taskId) => ({ taskId, reason: 'incomplete' })),
    };
  }
  const baselineRunsByTask = input.baselineRuns.map(
    (run) => new Map(run.map((event) => [event.taskId, event])),
  );
  for (const taskId of input.taskIds) {
    const events = baselineRunsByTask.map((run) => run.get(taskId));
    const completedEvents = events.filter(isStableBaselineEvent);
    if (completedEvents.length !== events.length) {
      rejectedTaskIds.push({ taskId, reason: 'incomplete' });
      continue;
    }
    const maxDurationMs = input.maxDurationMs;
    if (
      maxDurationMs !== undefined &&
      completedEvents.some((event) => event.durationMs > maxDurationMs)
    ) {
      rejectedTaskIds.push({ taskId, reason: 'too_slow' });
      continue;
    }
    const passIndicators = completedEvents.map((event) => (event.passed ? 1 : 0));
    if (Math.max(...passIndicators) - Math.min(...passIndicators) > maxPassRateSpread) {
      rejectedTaskIds.push({ taskId, reason: 'unstable_outcome' });
      continue;
    }
    selectedTaskIds.push(taskId);
  }
  return { selectedTaskIds, rejectedTaskIds };
}

/**
 * Separate prompt-addressability from execution stability. A task can be
 * perfectly runnable yet provide no useful prompt-optimization signal because
 * the retained prompt history never solved it (capability ceiling) or because
 * its result oscillates too often. Those tasks remain in the execution/WAL set;
 * this selector only defines proposal evidence and acceptance/noise-band input.
 */
export function selectAddressablePromptTasks(
  input: SelectAddressablePromptTasksInput,
): PromptTaskAddressabilitySelectionResult {
  const taskIdSet = new Set(input.taskIds);
  const historyByTask = new Map<string, Array<{ passed: boolean; promptHash: string }>>();
  const orderedEvents = input.keptPromptEvents
    .filter(
      (event): event is FixedPromptTaskCompletedEvent =>
        event.type === 'task_completed' &&
        event.eligible &&
        event.scored &&
        taskIdSet.has(event.taskId),
    )
    .map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.ts - b.event.ts || a.index - b.index);
  for (const { event } of orderedEvents) {
    const history = historyByTask.get(event.taskId) ?? [];
    history.push({
      passed: event.passed,
      // A legacy event without prompt identity cannot prove that two distinct
      // retained prompts hit the same ceiling, so group all such evidence into
      // one conservative unknown prompt instead of guessing from round ids.
      promptHash: event.promptHash ?? 'legacy-unknown',
    });
    historyByTask.set(event.taskId, history);
  }

  const taskStats = input.taskIds.map((taskId): PromptTaskAddressabilityStat => {
    const history = historyByTask.get(taskId) ?? [];
    const outcomes = history.map((item) => item.passed);
    const observations = outcomes.length;
    const keptPrompts = new Set(history.map((item) => item.promptHash)).size;
    const passes = outcomes.filter(Boolean).length;
    let flips = 0;
    for (let index = 1; index < outcomes.length; index += 1) {
      if (outcomes[index] !== outcomes[index - 1]) flips += 1;
    }
    const flipRate = observations > 1 ? flips / (observations - 1) : 0;
    const rejectionReason: PromptTaskAddressabilityRejectionReason | undefined =
      keptPrompts >= 2 && passes === 0
        ? 'capability_limit'
        : observations >= MIN_FLAKY_TASK_OBSERVATIONS && flipRate > MAX_ADDRESSABLE_TASK_FLIP_RATE
          ? 'flaky'
          : undefined;
    return {
      taskId,
      observations,
      keptPrompts,
      passes,
      flips,
      flipRate,
      addressable: rejectionReason === undefined,
      ...(rejectionReason ? { rejectionReason } : {}),
    };
  });

  return {
    selectedTaskIds: taskStats.filter((stat) => stat.addressable).map((stat) => stat.taskId),
    taskStats,
  };
}

function isStableBaselineEvent(
  event: FixedPromptTaskWalEvent | undefined,
): event is FixedPromptTaskCompletedEvent {
  return event?.type === 'task_completed' && event.eligible && event.scored;
}

export function decidePromptAcceptance(input: DecidePromptAcceptanceInput): PromptAcceptanceResult {
  const rewardHackScan = normalizeRewardHackScan(input.rewardHackScan);
  const metrics: PromptAcceptanceMetrics = {
    original: {
      heldOut: summarizePromptAcceptancePartition(input.originalEvents, input.heldOutTaskIds),
    },
    lastKept: {
      heldIn: summarizePromptAcceptancePartition(input.lastKeptEvents, input.heldInTaskIds),
    },
    candidate: {
      heldIn: summarizePromptAcceptancePartition(input.candidateEvents, input.heldInTaskIds),
      heldOut: summarizePromptAcceptancePartition(input.candidateEvents, input.heldOutTaskIds),
    },
    ...(input.samplingBaselineEvents
      ? {
          samplingBaseline: {
            heldIn: summarizePromptAcceptancePartition(
              input.samplingBaselineEvents,
              input.heldInTaskIds,
            ),
          },
        }
      : {}),
  };
  const reason =
    rewardHackGateReason(rewardHackScan) ??
    acceptanceReason(metrics, {
      previousHeldInReferencePassEligibleRate: input.previousHeldInReferencePassEligibleRate,
      originalHeldOutPassEligibleRate: input.originalHeldOutPassEligibleRate,
      heldInPassRateNoiseBand: input.heldInPassRateNoiseBand,
      heldOutPassRateNoiseBand: input.heldOutPassRateNoiseBand,
      samplingBaseline: metrics.samplingBaseline?.heldIn,
    });
  const decision: PromptAcceptanceDecision = reason === 'held_in_improved' ? 'keep' : 'discard';
  const heldInReferencePassEligibleRate = nextHeldInReferencePassEligibleRate({
    decision,
    previousReference: input.previousHeldInReferencePassEligibleRate,
    candidatePassEligibleRate: metrics.candidate.heldIn.passEligibleRate,
    noiseBand: input.heldInPassRateNoiseBand,
  });
  return {
    runId: input.runId,
    roundId: input.roundId,
    decision,
    reason,
    candidateCommitSha: input.candidateCommitSha,
    previousLastKeptCommitSha: input.previousLastKeptCommitSha,
    lastKeptCommitSha:
      decision === 'keep' ? input.candidateCommitSha : input.previousLastKeptCommitSha,
    previousHeldInReferencePassEligibleRate: input.previousHeldInReferencePassEligibleRate,
    heldInReferencePassEligibleRate,
    originalCommitSha: input.originalCommitSha,
    originalHeldOutPassEligibleRate: input.originalHeldOutPassEligibleRate,
    heldInPassRateNoiseBand: input.heldInPassRateNoiseBand,
    heldOutPassRateNoiseBand: input.heldOutPassRateNoiseBand,
    rewardHackScan,
    ...(input.samplingPromptHash ? { samplingPromptHash: input.samplingPromptHash } : {}),
    metrics,
  };
}

function calibratePartitionBaseline(
  summaries: readonly PromptAcceptancePartitionSummary[],
  zScore: number | undefined,
): PromptAcceptanceBaselinePartition {
  const passRates = summaries
    .map((summary) => summary.passEligibleRate)
    .filter((rate): rate is number => rate !== null);
  const meanPassEligibleRate = mean(passRates);
  const observedSpread =
    meanPassEligibleRate === null
      ? 0
      : Math.max(0, ...passRates.map((rate) => Math.abs(rate - meanPassEligibleRate)));
  const sampleSize = Math.max(0, ...summaries.map((summary) => summary.eligible));
  return {
    taskCount: Math.max(0, ...summaries.map((summary) => summary.taskCount)),
    baselineRunCount: summaries.length,
    meanPassEligibleRate,
    observedSpread,
    noiseBand: promptAcceptanceNoiseBand({
      sampleSize,
      passRate: meanPassEligibleRate,
      baselineRunCount: summaries.length,
      observedSpread,
      zScore,
    }),
  };
}

function wilsonHalfWidth(sampleSize: number, passRate: number, zScore: number): number {
  const z2 = zScore * zScore;
  const denominator = 1 + z2 / sampleSize;
  const inner = (passRate * (1 - passRate)) / sampleSize + z2 / (4 * sampleSize * sampleSize);
  return (zScore * Math.sqrt(inner)) / denominator;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export async function appendPromptAcceptanceDecision(
  input: AppendPromptAcceptanceDecisionInput,
): Promise<PromptCandidateDecisionEvent> {
  const event = promptCandidateDecisionEvent(input);
  await appendFixedPromptWalEvent(input.resultsJsonlPath, event);
  return event;
}

export function promptAcceptanceStateFromWal(
  events: readonly FixedPromptWalEvent[],
  initialLastKeptCommitSha: string,
  initialHeldInReferencePassEligibleRate: number | null = null,
): PromptAcceptanceState {
  const decisions: PromptAcceptanceState['decisions'] = [];
  let lastKeptCommitSha = initialLastKeptCommitSha;
  let heldInReferencePassEligibleRate = initialHeldInReferencePassEligibleRate;
  for (const event of events) {
    if (event.type !== 'prompt_candidate_decided') continue;
    lastKeptCommitSha = event.lastKeptCommitSha;
    heldInReferencePassEligibleRate = event.heldInReferencePassEligibleRate;
    decisions.push({
      roundId: event.roundId,
      decision: event.decision,
      candidateCommitSha: event.candidateCommitSha,
    });
  }
  return { lastKeptCommitSha, heldInReferencePassEligibleRate, decisions };
}

export function summarizePromptAcceptancePartition(
  events: readonly FixedPromptTaskWalEvent[],
  taskIds: readonly string[],
): PromptAcceptancePartitionSummary {
  const byTask = new Map(events.map((event) => [event.taskId, event]));
  const selected = taskIds.map((taskId) => byTask.get(taskId));
  const observed = selected.filter(
    (event): event is FixedPromptTaskWalEvent => event !== undefined,
  );
  const eligible = observed.filter((event) => event.eligible);
  const scored = observed.filter((event) => event.scored);
  const passed = observed.filter((event) => event.passed);
  return {
    taskCount: taskIds.length,
    observed: observed.length,
    eligible: eligible.length,
    scored: scored.length,
    passed: passed.length,
    passEligibleRate: eligible.length > 0 ? passed.length / eligible.length : null,
    coverageRate: eligible.length > 0 ? scored.length / eligible.length : null,
    unscoredTaskIds: taskIds.filter((taskId) => {
      const event = byTask.get(taskId);
      return event !== undefined && event.eligible && !event.scored;
    }),
    infraFailedTaskIds: taskIds.filter(
      (taskId) => byTask.get(taskId)?.type === 'task_infra_failed',
    ),
    plumbingFailedTaskIds: taskIds.filter((taskId) => {
      const event = byTask.get(taskId);
      return event !== undefined && event.type === 'task_plumbing_failed';
    }),
    missingTaskIds: taskIds.filter((taskId) => !byTask.has(taskId)),
  };
}

function promptCandidateDecisionEvent(
  input: AppendPromptAcceptanceDecisionInput,
): PromptCandidateDecisionEvent {
  return {
    schemaVersion: FIXED_PROMPT_WAL_SCHEMA_VERSION,
    type: 'prompt_candidate_decided',
    id: input.id,
    ts: input.ts,
    runId: input.result.runId,
    roundId: input.result.roundId,
    decision: input.result.decision,
    reason: input.result.reason,
    candidateCommitSha: input.result.candidateCommitSha,
    previousLastKeptCommitSha: input.result.previousLastKeptCommitSha,
    lastKeptCommitSha: input.result.lastKeptCommitSha,
    previousHeldInReferencePassEligibleRate: input.result.previousHeldInReferencePassEligibleRate,
    heldInReferencePassEligibleRate: input.result.heldInReferencePassEligibleRate,
    originalCommitSha: input.result.originalCommitSha,
    originalHeldOutPassEligibleRate: input.result.originalHeldOutPassEligibleRate,
    heldInPassRateNoiseBand: input.result.heldInPassRateNoiseBand,
    heldOutPassRateNoiseBand: input.result.heldOutPassRateNoiseBand,
    rewardHackScan: input.result.rewardHackScan,
    ...(input.result.samplingPromptHash
      ? { samplingPromptHash: input.result.samplingPromptHash }
      : {}),
    metrics: input.result.metrics,
  };
}

/**
 * Held-in gate (#64 LOOP steps 8-9, plus blocking task failures).
 * Returns a discard reason if the candidate cannot KEEP on held-in evidence
 * alone, or `null` if held-in clears and held-out is worth running. This is the
 * single source of truth for "should we spend the held-out sweep?": the loop
 * calls {@link heldInGateReason} with the held-in events, and {@link acceptanceReason}
 * calls this first so the final decision can never diverge from the gate.
 */
function heldInGateReasonFromSummaries(
  heldInCandidate: PromptAcceptancePartitionSummary,
  heldInReference: PromptAcceptancePartitionSummary,
  input: {
    previousHeldInReferencePassEligibleRate: number | null;
    heldInPassRateNoiseBand: number;
    samplingBaseline?: PromptAcceptancePartitionSummary;
  },
): PromptAcceptanceReason | null {
  if (hasBlockingTaskFailure(heldInReference) || hasBlockingTaskFailure(heldInCandidate)) {
    return 'coverage_regressed';
  }
  if (
    improved(
      heldInCandidate.passEligibleRate,
      input.previousHeldInReferencePassEligibleRate,
      input.heldInPassRateNoiseBand,
    )
  ) {
    const samplingReason = samplingBaselineGateReason(heldInCandidate, input.samplingBaseline);
    if (samplingReason) return samplingReason;
    return null; // held-in cleared → run held-out
  }
  if (
    regressed(
      heldInCandidate.passEligibleRate,
      input.previousHeldInReferencePassEligibleRate,
      input.heldInPassRateNoiseBand,
    )
  ) {
    return 'held_in_regressed';
  }
  return 'held_in_within_noise';
}

function samplingBaselineGateReason(
  candidate: PromptAcceptancePartitionSummary,
  samplingBaseline: PromptAcceptancePartitionSummary | undefined,
): PromptAcceptanceReason | null {
  if (!samplingBaseline) return null;
  if (
    hasBlockingTaskFailure(samplingBaseline) ||
    samplingBaseline.observed !== samplingBaseline.taskCount ||
    samplingBaseline.eligible !== samplingBaseline.taskCount ||
    samplingBaseline.scored !== samplingBaseline.taskCount ||
    samplingBaseline.passEligibleRate === null ||
    candidate.passEligibleRate === null
  ) {
    return 'sampling_baseline_incomplete';
  }
  return candidate.passEligibleRate > samplingBaseline.passEligibleRate
    ? null
    : 'sampling_baseline_not_beaten';
}

/** Held-out gate (#64 LOOP step 10). Only meaningful once held-in has cleared.
 * Returns a discard reason, or `null` if held-out clears and the candidate KEEPs. */
function heldOutGateReasonFromSummaries(
  heldOutCandidate: PromptAcceptancePartitionSummary,
  heldOutReference: PromptAcceptancePartitionSummary,
  input: {
    originalHeldOutPassEligibleRate: number | null;
    heldOutPassRateNoiseBand: number;
  },
): PromptAcceptanceReason | null {
  if (hasBlockingTaskFailure(heldOutReference) || hasBlockingTaskFailure(heldOutCandidate)) {
    return 'coverage_regressed';
  }
  if (heldOutCandidate.taskCount > 0 && input.originalHeldOutPassEligibleRate === null) {
    return 'coverage_regressed';
  }
  if (
    regressed(
      heldOutCandidate.passEligibleRate,
      input.originalHeldOutPassEligibleRate,
      input.heldOutPassRateNoiseBand,
    )
  ) {
    return 'held_out_regressed';
  }
  return null; // held-out cleared → keep
}

/**
 * Evaluate only the held-in gate from the candidate + last-kept held-in events.
 * The loop uses this after the held-in sweep to decide whether to spend the
 * held-out sweep at all — `null` means "held-in cleared, run held-out".
 */
export function heldInGateReason(input: {
  heldInTaskIds: readonly string[];
  lastKeptHeldInEvents: readonly FixedPromptTaskWalEvent[];
  candidateHeldInEvents: readonly FixedPromptTaskWalEvent[];
  previousHeldInReferencePassEligibleRate: number | null;
  heldInPassRateNoiseBand: number;
  rewardHackScan?: PromptCandidateRewardHackScan;
  samplingBaselineEvents?: readonly FixedPromptTaskWalEvent[];
}): PromptAcceptanceReason | null {
  const rewardHack = rewardHackGateReason(normalizeRewardHackScan(input.rewardHackScan));
  if (rewardHack) return rewardHack;
  return heldInGateReasonFromSummaries(
    summarizePromptAcceptancePartition(input.candidateHeldInEvents, input.heldInTaskIds),
    summarizePromptAcceptancePartition(input.lastKeptHeldInEvents, input.heldInTaskIds),
    {
      previousHeldInReferencePassEligibleRate: input.previousHeldInReferencePassEligibleRate,
      heldInPassRateNoiseBand: input.heldInPassRateNoiseBand,
      samplingBaseline: input.samplingBaselineEvents
        ? summarizePromptAcceptancePartition(input.samplingBaselineEvents, input.heldInTaskIds)
        : undefined,
    },
  );
}

function acceptanceReason(
  metrics: PromptAcceptanceMetrics,
  input: {
    previousHeldInReferencePassEligibleRate: number | null;
    originalHeldOutPassEligibleRate: number | null;
    heldInPassRateNoiseBand: number;
    heldOutPassRateNoiseBand: number;
    samplingBaseline?: PromptAcceptancePartitionSummary;
  },
): PromptAcceptanceReason {
  const heldIn = heldInGateReasonFromSummaries(metrics.candidate.heldIn, metrics.lastKept.heldIn, {
    previousHeldInReferencePassEligibleRate: input.previousHeldInReferencePassEligibleRate,
    heldInPassRateNoiseBand: input.heldInPassRateNoiseBand,
    samplingBaseline: metrics.samplingBaseline?.heldIn,
  });
  if (heldIn !== null) return heldIn;
  const heldOut = heldOutGateReasonFromSummaries(
    metrics.candidate.heldOut,
    metrics.original.heldOut,
    {
      originalHeldOutPassEligibleRate: input.originalHeldOutPassEligibleRate,
      heldOutPassRateNoiseBand: input.heldOutPassRateNoiseBand,
    },
  );
  return heldOut ?? 'held_in_improved';
}

function normalizeRewardHackScan(
  scan: PromptCandidateRewardHackScan | undefined,
): PromptCandidateRewardHackScan {
  return scan ?? { decision: 'clean' };
}

function rewardHackGateReason(scan: PromptCandidateRewardHackScan): PromptAcceptanceReason | null {
  return scan.decision === 'clean' ? null : PROMPT_REWARD_HACK_QUARANTINE_REASON;
}

export function bankPromptAcceptanceReference(passEligibleRate: number, noiseBand: number): number {
  return passEligibleRate - noiseBand;
}

function nextHeldInReferencePassEligibleRate(input: {
  decision: PromptAcceptanceDecision;
  previousReference: number | null;
  candidatePassEligibleRate: number | null;
  noiseBand: number;
}): number | null {
  if (input.decision !== 'keep' || input.candidatePassEligibleRate === null) {
    return input.previousReference;
  }
  const bankedReference = bankPromptAcceptanceReference(
    input.candidatePassEligibleRate,
    input.noiseBand,
  );
  return input.previousReference === null
    ? bankedReference
    : Math.max(input.previousReference, bankedReference);
}

function hasBlockingTaskFailure(summary: PromptAcceptancePartitionSummary): boolean {
  return (
    summary.missingTaskIds.length > 0 ||
    summary.infraFailedTaskIds.length > 0 ||
    summary.plumbingFailedTaskIds.length > 0
  );
}

function improved(candidate: number | null, reference: number | null, noiseBand: number): boolean {
  return candidate !== null && reference !== null && candidate > reference + noiseBand;
}

function regressed(candidate: number | null, reference: number | null, noiseBand: number): boolean {
  return reference !== null && (candidate === null || candidate < reference - noiseBand);
}
