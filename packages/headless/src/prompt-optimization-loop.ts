import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import type { Config } from './contracts.js';
import {
  appendFixedPromptWalEvent,
  runFixedPromptController,
  hashSystemPrompt,
  readFixedPromptWal,
  writeFixedPromptResultsTsv,
  type FixedPromptControllerResult,
  type FixedPromptTask,
  type TaskRunner,
} from './fixed-prompt-controller.js';
import {
  FIXED_PROMPT_WAL_SCHEMA_VERSION,
  type FixedPromptTaskCompletedEvent,
  type FixedPromptTaskWalEvent,
  type PromptCandidateRewardHackScan,
  type RsiControllerAttributionEvent,
} from './fixed-prompt-wal-types.js';
import {
  extractTrajectoryDigest,
  runPromptCandidateRound,
  scanRuntimeEventsForRewardHack,
  type MetaAgent,
  type PromptCandidateGit,
  type TrajectoryDigest,
} from './prompt-candidate-loop.js';
import {
  appendPromptAcceptanceDecision,
  bankPromptAcceptanceReference,
  calibratePromptAcceptanceBaseline,
  decidePromptAcceptance,
  heldInGateReason,
  selectAddressablePromptTasks,
  selectStablePromptTasks,
  summarizePromptAcceptancePartition,
  type PromptAcceptanceBaseline,
  type PromptAcceptanceBaselineRun,
  type PromptAcceptanceResult,
  type PromptTaskAddressabilitySelectionResult,
} from './prompt-acceptance-policy.js';
import {
  promptStructuralSmokeReport,
  type PromptStructuralSmokeReport,
} from './prompt-structural-smoke.js';
import { assertFinitePositive, assertPositiveInt, assertRatio } from './numeric-guards.js';
import { analyzeRsiRound } from './rsi-round-analysis.js';
import {
  buildRsiControllerAttribution,
  projectRsiPromptAttribution,
  type RsiControllerAttribution,
  type RsiPromptAttribution,
} from './rsi-controller-attribution.js';
import {
  assertCandidateMatchesStableTaskSet,
  reconcilePromptRepoWithReplayState,
  assertReplayedDecisionMatchesResult,
  buildPromptOptimizationReplayPlan,
  replayStateHasRecoverablePendingCandidateEvidence,
  replayPromptBaselinePartition,
  replayControllerSweep,
  replayPromptDecisionRound,
  readPromptHashAtCommit,
} from './prompt-optimization-replay.js';

/**
 * Top-level driver for the RSI prompt-optimization loop (Issue #64).
 *
 * It composes the four existing layers into one unattended run:
 *   1. baseline calibration — sweep the held-in and held-out partitions a few
 *      times on the unchanged prompt to learn each partition's noise band;
 *   2. for each round: ask the meta-agent for a candidate prompt (commits it),
 *      sweep held-in first, scan held-in trajectories for reward-hacking and
 *      coverage/noise gates, then run held-out only for candidates that can
 *      still keep; the acceptance policy then either KEEP (advance the lineage)
 *      or DISCARD (roll the candidate commit back);
 *   3. a structural smoke report over the whole write-ahead log.
 *
 * Every expensive edge is injected: `harborRunner` (Docker/Harbor) and
 * `metaAgent` (the model call) are dependencies, so the full composition is
 * unit-testable with fakes and no network or containers. The controller-only
 * artifacts (`resultsJsonlPath`, the two TSVs) MUST live outside `agentCwdPath`
 * — the candidate round asserts this so the meta-agent can never read held-out
 * results.
 */
export interface PromptOptimizationLoopInput {
  runId: string;
  /** Number of candidate rounds after baseline calibration. */
  rounds: number;
  /** Baseline sweeps per partition before the loop (default 3, minimum 1). */
  baselineRuns?: number;
  /** z-score for the noise-band width (default 1.96). */
  zScore?: number;

  // Prompt repo (agent-visible working tree the meta-agent edits).
  agentCwdPath: string;
  programPath: string;
  systemPromptPath: string;

  // Controller-only artifacts — must resolve OUTSIDE agentCwdPath.
  /** Shared write-ahead log for every sweep, candidate, and decision. */
  resultsJsonlPath: string;
  /** Held-in TSV; the controller rewrites it each sweep and the next round's
   * candidate reads it as feedback. */
  heldInResultsTsvPath: string;
  /** Held-out TSV (kept out of the meta-agent's view). */
  heldOutResultsTsvPath: string;

  heldInTasks: readonly FixedPromptTask[];
  heldOutTasks: readonly FixedPromptTask[];
  /** Extra held-out artifact paths the candidate round must keep hidden. */
  heldOutArtifactPaths?: readonly string[];

  config: Config;
  harborRunner: TaskRunner;
  metaAgent: MetaAgent;
  git: PromptCandidateGit;

  /** Verifier strings, by task id, that must not be visible to the model. A
   * held-in task that completes without configured patterns quarantines the
   * round (fail-loud). */
  rewardHackVerifierPatternsByTaskId?: Readonly<Record<string, readonly string[]>>;

  /** Abort if fewer than this many held-in tasks complete (scored + eligible)
   * across every baseline sweep (default 1). A floor above 1 guards against
   * calibrating on an unrepresentative subset after a harness/cache regression
   * silently drops most tasks. */
  minStableHeldInTasks?: number;
  /** Same floor for the held-out partition (default 1). */
  minStableHeldOutTasks?: number;
  /** Drop a task whose baseline trial ran longer than this (any sweep) from the
   * calibrated set and all candidate rounds. Keeps the loop tractable when a
   * few tasks are pathologically slow for the agent. Unset = no duration cap. */
  maxStableTaskDurationMs?: number;

  /** Stop the loop once cumulative task cost reaches this (checked per round). */
  costCeilingUsd?: number;
  /** Stop the loop once the cumulative infra-failure rate exceeds this. */
  maxInfraFailureRate?: number;
  /** Per-sweep harbor concurrency (default 1). */
  maxConcurrency?: number;
  /** Stable run-identity fingerprint for WAL resume safety. */
  resumeFingerprint?: string;

  now?: () => number;
  newId?: () => string;
}

export type PromptOptimizationLoopStopReason =
  | 'rounds_complete'
  | 'cost_ceiling_exceeded'
  | 'infra_failure_rate_exceeded';

export interface PromptOptimizationLoopResult {
  runId: string;
  baseline: PromptAcceptanceBaseline;
  decisions: PromptAcceptanceResult[];
  keptCount: number;
  lastKeptCommitSha: string;
  heldInReferencePassEligibleRate: number | null;
  totalCostUsd: number;
  stopReason: PromptOptimizationLoopStopReason;
  smoke: PromptStructuralSmokeReport;
  /** Held-in task ids dropped before calibration: they did not complete
   * (scored + eligible) across every baseline sweep, so they carry no signal. */
  droppedHeldInTaskIds: string[];
  /** Held-out task ids dropped before calibration, same criterion. */
  droppedHeldOutTaskIds: string[];
  /** Historical kept-prompt addressability used only for proposal evidence and
   * acceptance. Rejected tasks still execute and remain recorded in the WAL. */
  addressability: {
    heldIn: PromptTaskAddressabilitySelectionResult;
    heldOut: PromptTaskAddressabilitySelectionResult;
  };
}

export async function runPromptOptimizationLoop(
  input: PromptOptimizationLoopInput,
): Promise<PromptOptimizationLoopResult> {
  const now = input.now ?? Date.now;
  const newId = input.newId ?? randomUUID;
  const baselineRunCount = input.baselineRuns ?? 3;
  const zScore = input.zScore ?? 1.96;
  // Fail loud on out-of-contract numbers. The CLI env parser guards env values,
  // but this public API is callable directly, so the invariants live here too: a
  // NaN/fraction/0 would otherwise slip past a `< 1` or `>= ceiling` comparison
  // and silently disable a guard or change semantics — e.g. rounds 1.5 would run
  // two rounds, rounds 0 is a baseline-only run that trivially passes the
  // structural smoke (minimumRounds 0), and a NaN cost ceiling never trips.
  assertPositiveInt('rounds', input.rounds);
  assertPositiveInt('baselineRuns', baselineRunCount);
  assertFinitePositive('zScore', zScore);
  if (input.minStableHeldInTasks !== undefined) {
    assertPositiveInt('minStableHeldInTasks', input.minStableHeldInTasks);
  }
  if (input.minStableHeldOutTasks !== undefined) {
    assertPositiveInt('minStableHeldOutTasks', input.minStableHeldOutTasks);
  }
  if (input.maxStableTaskDurationMs !== undefined) {
    assertFinitePositive('maxStableTaskDurationMs', input.maxStableTaskDurationMs);
  }
  if (input.costCeilingUsd !== undefined)
    assertFinitePositive('costCeilingUsd', input.costCeilingUsd);
  if (input.maxInfraFailureRate !== undefined)
    assertRatio('maxInfraFailureRate', input.maxInfraFailureRate);
  if (input.maxConcurrency !== undefined) assertPositiveInt('maxConcurrency', input.maxConcurrency);

  const resumeEvents = await readFixedPromptWal(input.resultsJsonlPath);
  const replayPlan = await buildPromptOptimizationReplayPlan({
    events: resumeEvents,
    promptRepoDir: input.git.gitRootPath,
    systemPromptGitPath: input.git.systemPromptGitPath,
    runId: input.runId,
    ...(input.resumeFingerprint ? { resumeFingerprint: input.resumeFingerprint } : {}),
    strictRoundState: true,
  });
  const replayState = replayPlan.state;
  await reconcilePromptRepoWithReplayState({
    gitRootPath: input.git.gitRootPath,
    expectedHead: replayState.expectedPromptRepoHead,
    programPath: input.programPath,
    systemPromptGitPath: input.git.systemPromptGitPath,
    ...(replayStateHasRecoverablePendingCandidateEvidence({
      events: resumeEvents,
      state: replayState,
      runId: input.runId,
    })
      ? { recoverExpectedHeadFromParent: true }
      : {}),
  });

  const heldInTaskIds = input.heldInTasks.map((task) => task.id);
  const heldOutTaskIds = input.heldOutTasks.map((task) => task.id);
  assertUniqueTaskIds('held-in', heldInTaskIds);
  assertUniqueTaskIds('held-out', heldOutTaskIds);
  assertDisjointTaskIds(heldInTaskIds, heldOutTaskIds);

  let totalCostUsd = 0;
  let infraFailed = 0;
  let taskAttempts = 0;
  const accumulate = (result: FixedPromptControllerResult): void => {
    totalCostUsd += result.totalCostUsd;
    for (const event of result.events) {
      taskAttempts += 1;
      if (event.type === 'task_infra_failed') infraFailed += 1;
    }
  };

  const sweep = (
    roundId: string,
    tasks: readonly FixedPromptTask[],
    resultsTsvPath?: string,
    options?: { protectPassAtOne?: boolean },
  ): Promise<FixedPromptControllerResult> =>
    runFixedPromptController({
      runId: input.runId,
      roundId,
      config: input.config,
      systemPromptPath: input.systemPromptPath,
      resultsJsonlPath: input.resultsJsonlPath,
      resultsTsvPath,
      tasks,
      taskRunner: input.harborRunner,
      ...(input.resumeFingerprint ? { resumeFingerprint: input.resumeFingerprint } : {}),
      ...(input.maxConcurrency !== undefined ? { maxConcurrency: input.maxConcurrency } : {}),
      ...(options?.protectPassAtOne ? { protectPassAtOne: true } : {}),
      now,
      newId,
    });

  const digestsFor = (events: readonly FixedPromptTaskWalEvent[]): Promise<TrajectoryDigest[]> =>
    Promise.all(
      events
        .filter((event): event is FixedPromptTaskCompletedEvent => event.type === 'task_completed')
        .map((event) =>
          extractTrajectoryDigest({
            taskId: event.taskId,
            ...(event.errorClass ? { errorClass: event.errorClass } : {}),
            runtimeEventsPath: event.runtimeEventsPath,
            ...(event.traceEventsPath ? { traceEventsPath: event.traceEventsPath } : {}),
            verifierSummary:
              event.harbor.verifierFailureSummary ??
              `status=${event.status} passed=${event.passed} reward=${event.harbor.reward}`,
          }),
        ),
    );

  // Reward-hacking is a safety gate over the full executed held-in sweep, not
  // only the addressable decision subset. A flaky or capability-limited task
  // cannot exempt a candidate from quarantine. First non-clean task decides
  // the round (deterministic by execution order).
  const scanHeldIn = async (
    events: readonly FixedPromptTaskWalEvent[],
  ): Promise<PromptCandidateRewardHackScan> => {
    for (const event of events) {
      if (event.type !== 'task_completed') continue;
      const verifierPatterns = (
        input.rewardHackVerifierPatternsByTaskId?.[event.taskId] ?? []
      ).filter((pattern) => pattern.trim().length > 0);
      const result = await scanRuntimeEventsForRewardHack({
        runtimeEventsPath: event.runtimeEventsPath,
        verifierPatterns,
      });
      if (result.decision === 'quarantine') {
        return result.reason === 'verifier_pattern'
          ? {
              decision: 'quarantine',
              reason: result.reason,
              matchedPatterns: result.matchedPatterns,
            }
          : { decision: 'quarantine', reason: result.reason };
      }
    }
    return { decision: 'clean' };
  };

  const stopGuard = (): PromptOptimizationLoopStopReason | undefined => {
    if (input.costCeilingUsd !== undefined && totalCostUsd >= input.costCeilingUsd) {
      return 'cost_ceiling_exceeded';
    }
    if (
      input.maxInfraFailureRate !== undefined &&
      taskAttempts > 0 &&
      infraFailed / taskAttempts > input.maxInfraFailureRate
    ) {
      return 'infra_failure_rate_exceeded';
    }
    return undefined;
  };

  // 1. Baseline calibration — repeated sweeps of the unchanged prompt.
  const baselineRunsData: PromptAcceptanceBaselineRun[] = [];
  for (let index = 0; index < baselineRunCount; index += 1) {
    // Do not start another baseline sweep once a guard trips: a budget exhausted
    // before calibration even finishes cannot produce a valid noise band, so this
    // is a hard configuration failure, not a partial run.
    const baselineGuard = stopGuard();
    if (baselineGuard) {
      throw new Error(
        `${baselineGuard} during baseline calibration (completed ${index} of ${baselineRunCount} sweeps); ` +
          'raise the budget or lower baselineRuns',
      );
    }
    const roundId = `baseline-${index}`;
    const heldInReplayInput = {
      events: resumeEvents,
      runId: input.runId,
      roundId,
      taskIds: heldInTaskIds,
      expectedPromptHash: replayPlan.seedPromptHash,
      ...(input.resumeFingerprint ? { resumeFingerprint: input.resumeFingerprint } : {}),
      resultsTsvPath: input.heldInResultsTsvPath,
    };
    const replayedHeldIn = replayPromptBaselinePartition({
      ...heldInReplayInput,
      partition: 'held-in',
      required: replayPlan.historicalBaselineEvidenceRequired,
    });
    if (replayedHeldIn)
      await writeFixedPromptResultsTsv(input.heldInResultsTsvPath, replayedHeldIn.events);
    const heldIn =
      replayedHeldIn ?? (await sweep(roundId, input.heldInTasks, input.heldInResultsTsvPath));
    accumulate(heldIn);
    const postHeldInGuard = stopGuard();
    if (postHeldInGuard) {
      throw new Error(
        `${postHeldInGuard} during baseline calibration (completed ${index} of ${baselineRunCount} sweeps); ` +
          'raise the budget or lower baselineRuns',
      );
    }
    const heldOutReplayInput = {
      events: resumeEvents,
      runId: input.runId,
      roundId,
      taskIds: heldOutTaskIds,
      expectedPromptHash: replayPlan.seedPromptHash,
      ...(input.resumeFingerprint ? { resumeFingerprint: input.resumeFingerprint } : {}),
      resultsTsvPath: input.heldOutResultsTsvPath,
    };
    const replayedHeldOut = replayPromptBaselinePartition({
      ...heldOutReplayInput,
      partition: 'held-out',
      required: replayPlan.historicalBaselineEvidenceRequired,
    });
    if (replayedHeldOut)
      await writeFixedPromptResultsTsv(input.heldOutResultsTsvPath, replayedHeldOut.events);
    const heldOut =
      replayedHeldOut ?? (await sweep(roundId, input.heldOutTasks, input.heldOutResultsTsvPath));
    accumulate(heldOut);
    baselineRunsData.push({ heldInEvents: heldIn.events, heldOutEvents: heldOut.events });
  }
  // Drop tasks that did not complete cleanly (scored + eligible) across every
  // baseline sweep. Such a task carries no calibration signal and, left in,
  // would abort the whole run via the strict completeness check inside
  // calibratePromptAcceptanceBaseline. Completion-only filter (any pass/fail
  // spread allowed) — a flaky-pass task's variance is honest noise the band
  // already absorbs. Dropped tasks are excluded from every candidate round too,
  // so they neither cost more nor skew a decision. The run aborts only when a
  // whole partition has no stable task left (then there is nothing to calibrate).
  const durationCap =
    input.maxStableTaskDurationMs !== undefined
      ? { maxDurationMs: input.maxStableTaskDurationMs }
      : {};
  const heldInStable = selectStablePromptTasks({
    taskIds: heldInTaskIds,
    baselineRuns: baselineRunsData.map((run) => run.heldInEvents),
    maxPassRateSpread: 1,
    ...durationCap,
  });
  const heldOutStable = selectStablePromptTasks({
    taskIds: heldOutTaskIds,
    baselineRuns: baselineRunsData.map((run) => run.heldOutEvents),
    maxPassRateSpread: 1,
    ...durationCap,
  });
  const minStableHeldIn = input.minStableHeldInTasks ?? 1;
  const minStableHeldOut = input.minStableHeldOutTasks ?? 1;
  if (heldInStable.selectedTaskIds.length < minStableHeldIn) {
    throw new Error(
      `held-in stable task count ${heldInStable.selectedTaskIds.length} is below the minimum ${minStableHeldIn} ` +
        `(${heldInTaskIds.length} configured, ${heldInStable.rejectedTaskIds.length} dropped across baseline sweeps)`,
    );
  }
  if (heldOutStable.selectedTaskIds.length < minStableHeldOut) {
    throw new Error(
      `held-out stable task count ${heldOutStable.selectedTaskIds.length} is below the minimum ${minStableHeldOut} ` +
        `(${heldOutTaskIds.length} configured, ${heldOutStable.rejectedTaskIds.length} dropped across baseline sweeps)`,
    );
  }
  const stableHeldInTaskIds = heldInStable.selectedTaskIds;
  const stableHeldOutTaskIds = heldOutStable.selectedTaskIds;
  const droppedHeldInTaskIds = heldInStable.rejectedTaskIds.map((rejected) => rejected.taskId);
  const droppedHeldOutTaskIds = heldOutStable.rejectedTaskIds.map((rejected) => rejected.taskId);
  const stableHeldInSet = new Set(stableHeldInTaskIds);
  const stableHeldOutSet = new Set(stableHeldOutTaskIds);
  const stableHeldIn = (events: readonly FixedPromptTaskWalEvent[]): FixedPromptTaskWalEvent[] =>
    events.filter((event) => stableHeldInSet.has(event.taskId));
  const stableHeldOut = (events: readonly FixedPromptTaskWalEvent[]): FixedPromptTaskWalEvent[] =>
    events.filter((event) => stableHeldOutSet.has(event.taskId));
  let keptHeldInHistory = baselineRunsData.flatMap((run) => stableHeldIn(run.heldInEvents));
  let keptHeldOutHistory = baselineRunsData.flatMap((run) => stableHeldOut(run.heldOutEvents));
  const selectCurrentAddressability = (): PromptOptimizationLoopResult['addressability'] => ({
    heldIn: selectAddressablePromptTasks({
      taskIds: stableHeldInTaskIds,
      keptPromptEvents: keptHeldInHistory,
    }),
    heldOut: selectAddressablePromptTasks({
      taskIds: stableHeldOutTaskIds,
      keptPromptEvents: keptHeldOutHistory,
    }),
  });
  const assertAddressablePartitions = (
    addressability: PromptOptimizationLoopResult['addressability'],
  ): void => {
    if (addressability.heldIn.selectedTaskIds.length === 0) {
      throw new Error('held-in addressable task count is 0 after kept-prompt history filtering');
    }
    if (addressability.heldOut.selectedTaskIds.length === 0) {
      throw new Error('held-out addressable task count is 0 after kept-prompt history filtering');
    }
  };
  const initialAddressability = selectCurrentAddressability();
  const roundHeldInTasks = input.heldInTasks.filter((task) => stableHeldInSet.has(task.id));
  const roundHeldOutTasks = input.heldOutTasks.filter((task) => stableHeldOutSet.has(task.id));
  const baseline = calibratePromptAcceptanceBaseline({
    heldInTaskIds: initialAddressability.heldIn.selectedTaskIds,
    heldOutTaskIds: initialAddressability.heldOut.selectedTaskIds,
    baselineRuns: baselineRunsData,
    zScore,
  });

  let lastKeptCommitSha = replayState.seedCommitSha;
  let finalHeldInReference = baseline.heldIn.referencePassEligibleRate;
  let lastKeptHeldInExecutionEvents: readonly FixedPromptTaskWalEvent[] = stableHeldIn(
    baselineRunsData[0]!.heldInEvents,
  );
  let previousCandidateHeldInExecutionEvents: readonly FixedPromptTaskWalEvent[] | undefined;
  let latestHeldInFeedbackExecutionEvents: readonly FixedPromptTaskWalEvent[] = stableHeldIn(
    baselineRunsData[baselineRunsData.length - 1]!.heldInEvents,
  );
  let heldInReferenceTaskIds = initialAddressability.heldIn.selectedTaskIds;
  let hasKeptCandidate = false;
  let nextPromptAttribution: RsiPromptAttribution | undefined;

  // 2. Candidate rounds.
  const decisions: PromptAcceptanceResult[] = [];
  let stopReason: PromptOptimizationLoopStopReason = 'rounds_complete';
  for (let round = 0; round < input.rounds; round += 1) {
    // Check the budget before starting a round so an over-budget baseline (or a
    // prior round) cannot kick off another expensive candidate + sweeps.
    const guard = stopGuard();
    if (guard) {
      stopReason = guard;
      break;
    }
    const roundId = `round-${round}`;
    const addressability = selectCurrentAddressability();
    assertAddressablePartitions(addressability);
    const decisionHeldInTaskIds = addressability.heldIn.selectedTaskIds;
    const decisionHeldOutTaskIds = addressability.heldOut.selectedTaskIds;
    const decisionHeldInSet = new Set(decisionHeldInTaskIds);
    const decisionHeldOutSet = new Set(decisionHeldOutTaskIds);
    const decisionHeldIn = (
      events: readonly FixedPromptTaskWalEvent[],
    ): FixedPromptTaskWalEvent[] => events.filter((event) => decisionHeldInSet.has(event.taskId));
    const decisionHeldOut = (
      events: readonly FixedPromptTaskWalEvent[],
    ): FixedPromptTaskWalEvent[] => events.filter((event) => decisionHeldOutSet.has(event.taskId));
    const activeBaseline = calibratePromptAcceptanceBaseline({
      heldInTaskIds: decisionHeldInTaskIds,
      heldOutTaskIds: decisionHeldOutTaskIds,
      baselineRuns: baselineRunsData,
      zScore,
    });
    const originalHeldOutEvents = decisionHeldOut(baselineRunsData[0]!.heldOutEvents);
    const lastKeptHeldInEvents = decisionHeldIn(lastKeptHeldInExecutionEvents);
    const previousCandidateHeldInEvents = previousCandidateHeldInExecutionEvents
      ? decisionHeldIn(previousCandidateHeldInExecutionEvents)
      : undefined;
    const latestHeldInFeedbackEvents = decisionHeldIn(latestHeldInFeedbackExecutionEvents);
    const heldInReferenceTaskSetChanged = !sameTaskIdSet(
      heldInReferenceTaskIds,
      decisionHeldInTaskIds,
    );
    const heldInReference = hasKeptCandidate
      ? heldInReferenceTaskSetChanged
        ? bankedReferenceForTaskSet(
            lastKeptHeldInEvents,
            decisionHeldInTaskIds,
            activeBaseline.heldIn.noiseBand,
          )
        : finalHeldInReference
      : activeBaseline.heldIn.referencePassEligibleRate;
    finalHeldInReference = heldInReference;
    heldInReferenceTaskIds = decisionHeldInTaskIds;
    const nextHeldInDigests = await digestsFor(latestHeldInFeedbackEvents);
    await writeFixedPromptResultsTsv(input.heldInResultsTsvPath, latestHeldInFeedbackEvents);
    const promptAnalysis = await analyzeRsiRound({
      heldInTaskIds: decisionHeldInTaskIds,
      lastKeptEvents: lastKeptHeldInEvents,
      ...(previousCandidateHeldInEvents
        ? { previousCandidateEvents: previousCandidateHeldInEvents }
        : {}),
      candidateEvents: latestHeldInFeedbackEvents,
    });
    const existingDecisionRound = await replayPromptDecisionRound({
      events: resumeEvents,
      state: replayState,
      runId: input.runId,
      roundId,
      heldInTaskIds: decisionHeldInTaskIds,
      heldOutTaskIds: decisionHeldOutTaskIds,
      executedHeldInTaskIds: stableHeldInTaskIds,
      executedHeldOutTaskIds: stableHeldOutTaskIds,
      ...(input.resumeFingerprint ? { resumeFingerprint: input.resumeFingerprint } : {}),
      promptRepoDir: input.git.gitRootPath,
      systemPromptGitPath: input.git.systemPromptGitPath,
      heldInResultsTsvPath: input.heldInResultsTsvPath,
      heldOutResultsTsvPath: input.heldOutResultsTsvPath,
    });
    if (existingDecisionRound) {
      await writeFixedPromptResultsTsv(
        input.heldInResultsTsvPath,
        existingDecisionRound.heldIn.events,
      );
      if (existingDecisionRound.heldOut) {
        await writeFixedPromptResultsTsv(
          input.heldOutResultsTsvPath,
          existingDecisionRound.heldOut.events,
        );
      }
      const existingHeldInEvents = existingDecisionRound.heldIn.events;
      if (existingDecisionRound.sampling) accumulate(existingDecisionRound.sampling);
      accumulate(existingDecisionRound.executedHeldIn);
      if (existingDecisionRound.executedHeldOut) accumulate(existingDecisionRound.executedHeldOut);
      const replayedRewardHackScan = await scanHeldIn(existingDecisionRound.executedHeldIn.events);
      if (
        !existingDecisionRound.heldOut &&
        heldInGateReason({
          heldInTaskIds: decisionHeldInTaskIds,
          lastKeptHeldInEvents,
          candidateHeldInEvents: existingHeldInEvents,
          previousHeldInReferencePassEligibleRate: heldInReference,
          heldInPassRateNoiseBand: activeBaseline.heldIn.noiseBand,
          ...(existingDecisionRound.sampling
            ? { samplingBaselineEvents: existingDecisionRound.sampling.events }
            : {}),
          rewardHackScan: replayedRewardHackScan,
        }) === null
      ) {
        throw new Error(`RSI WAL replay missing required held-out task evidence for ${roundId}`);
      }
      const replayedResult = decidePromptAcceptance({
        runId: input.runId,
        roundId,
        candidateCommitSha: existingDecisionRound.decision.candidateCommitSha,
        previousLastKeptCommitSha: lastKeptCommitSha,
        originalCommitSha: replayState.seedCommitSha,
        heldInTaskIds: decisionHeldInTaskIds,
        heldOutTaskIds: decisionHeldOutTaskIds,
        previousHeldInReferencePassEligibleRate: heldInReference,
        originalHeldOutPassEligibleRate: activeBaseline.heldOut.originalPassEligibleRate,
        heldInPassRateNoiseBand: activeBaseline.heldIn.noiseBand,
        heldOutPassRateNoiseBand: activeBaseline.heldOut.noiseBand,
        originalEvents: originalHeldOutEvents,
        lastKeptEvents: lastKeptHeldInEvents,
        candidateEvents: [
          ...existingHeldInEvents,
          ...(existingDecisionRound.heldOut?.events ?? []),
        ],
        ...(existingDecisionRound.sampling
          ? {
              samplingBaselineEvents: existingDecisionRound.sampling.events,
              samplingPromptHash: existingDecisionRound.decision.samplingPromptHash,
            }
          : {}),
        rewardHackScan: replayedRewardHackScan,
      });
      assertReplayedDecisionMatchesResult(existingDecisionRound.decision, replayedResult);
      const replayedCandidate = replayState.candidateByRoundId.get(roundId);
      if (!replayedCandidate) {
        throw new Error(`RSI WAL replay missing candidate commit for decided ${roundId}`);
      }
      const replayedAttribution = buildRsiControllerAttribution({
        runId: input.runId,
        roundId,
        candidateCommitSha: existingDecisionRound.decision.candidateCommitSha,
        candidateRationaleHash: replayedCandidate.candidateRationaleHash,
        candidateRationale: replayedCandidate.candidateRationale,
        promptTimeAnalysis: promptAnalysis,
        analysis: await analyzeRsiRound({
          heldInTaskIds: decisionHeldInTaskIds,
          lastKeptEvents: lastKeptHeldInEvents,
          ...(previousCandidateHeldInEvents
            ? { previousCandidateEvents: previousCandidateHeldInEvents }
            : {}),
          candidateEvents: existingHeldInEvents,
        }),
        heldInTaskIds: decisionHeldInTaskIds,
        lastKeptEvents: lastKeptHeldInEvents,
        candidateEvents: existingHeldInEvents,
        decision: replayedResult,
      });
      assertReplayedAttributionMatchesResult(
        existingDecisionRound.attribution,
        replayedAttribution,
      );
      decisions.push(replayedResult);
      finalHeldInReference = replayedResult.heldInReferencePassEligibleRate;
      if (replayedResult.decision === 'keep') {
        hasKeptCandidate = true;
        lastKeptCommitSha = replayedResult.lastKeptCommitSha;
        lastKeptHeldInExecutionEvents = existingDecisionRound.executedHeldIn.events;
        keptHeldInHistory = [...keptHeldInHistory, ...existingDecisionRound.executedHeldIn.events];
        if (existingDecisionRound.executedHeldOut) {
          keptHeldOutHistory = [
            ...keptHeldOutHistory,
            ...existingDecisionRound.executedHeldOut.events,
          ];
        }
      }
      previousCandidateHeldInExecutionEvents = existingDecisionRound.executedHeldIn.events;
      latestHeldInFeedbackExecutionEvents = existingDecisionRound.executedHeldIn.events;
      nextPromptAttribution = projectRsiPromptAttribution(existingDecisionRound.attribution);
      continue;
    }

    const existingCandidate = replayState.candidateByRoundId.get(roundId);
    if (existingCandidate) {
      assertCandidateMatchesStableTaskSet(existingCandidate, decisionHeldInTaskIds);
    }
    let samplingBaseline: FixedPromptControllerResult | undefined;
    let samplingPromptHash: string | undefined;
    if (!existingDecisionRound) {
      const currentPromptHash = existingCandidate
        ? await readPromptHashAtCommit({
            promptRepoDir: input.git.gitRootPath,
            commitSha: `${existingCandidate.commitSha}^`,
            systemPromptGitPath: input.git.systemPromptGitPath,
          })
        : hashSystemPrompt(await readFile(input.systemPromptPath, 'utf8'));
      const samplingRoundId = `sampling-${round}`;
      const replayedSampling = replayControllerSweep({
        events: resumeEvents,
        runId: input.runId,
        roundId: samplingRoundId,
        taskIds: stableHeldInTaskIds,
        expectedPromptHash: currentPromptHash,
        ...(input.resumeFingerprint ? { resumeFingerprint: input.resumeFingerprint } : {}),
        resultsTsvPath: input.heldInResultsTsvPath,
      });
      if (replayedSampling) {
        samplingBaseline = replayedSampling;
        samplingPromptHash = currentPromptHash;
        accumulate(replayedSampling);
        const postSamplingGuard = stopGuard();
        if (postSamplingGuard) {
          stopReason = postSamplingGuard;
          break;
        }
      } else if (!existingCandidate) {
        const samplingGuard = stopGuard();
        if (samplingGuard) {
          stopReason = samplingGuard;
          break;
        }
        samplingBaseline = await sweep(samplingRoundId, roundHeldInTasks, undefined, {
          protectPassAtOne: true,
        });
        accumulate(samplingBaseline);
        samplingPromptHash = currentPromptHash;
        const postSamplingGuard = stopGuard();
        if (postSamplingGuard) {
          stopReason = postSamplingGuard;
          break;
        }
      }
    }
    const candidate =
      existingCandidate ??
      (await runPromptCandidateRound({
        runId: input.runId,
        roundId,
        agentCwdPath: input.agentCwdPath,
        programPath: input.programPath,
        systemPromptPath: input.systemPromptPath,
        resultsTsvPath: input.heldInResultsTsvPath,
        resultsJsonlPath: input.resultsJsonlPath,
        heldInTaskIds: decisionHeldInTaskIds,
        heldInDigests: nextHeldInDigests,
        rsiAnalysis: promptAnalysis,
        ...(nextPromptAttribution ? { promptAttribution: nextPromptAttribution } : {}),
        // The held-out TSV is controller-only; always hide it so a careless caller
        // cannot leak held-out results into the meta-agent's view.
        heldOutArtifactPaths: [input.heldOutResultsTsvPath, ...(input.heldOutArtifactPaths ?? [])],
        metaAgent: input.metaAgent,
        git: input.git,
        now,
        newId,
      }));

    const heldIn = await sweep(roundId, roundHeldInTasks, input.heldInResultsTsvPath);
    accumulate(heldIn);
    const rewardHackScan = await scanHeldIn(heldIn.events);
    const heldInDecisionEvents = decisionHeldIn(heldIn.events);
    await writeFixedPromptResultsTsv(input.heldInResultsTsvPath, heldInDecisionEvents);

    // #64 LOOP steps 8-10: only spend the held-out sweep when held-in clears the
    // gate (improved beyond noise, coverage intact, no reward-hack quarantine). A
    // candidate that cannot KEEP on held-in evidence is discarded without ever
    // running held-out — saving cost, time, and infra exposure.
    const heldInGate = heldInGateReason({
      heldInTaskIds: decisionHeldInTaskIds,
      lastKeptHeldInEvents,
      candidateHeldInEvents: heldInDecisionEvents,
      previousHeldInReferencePassEligibleRate: heldInReference,
      heldInPassRateNoiseBand: activeBaseline.heldIn.noiseBand,
      ...(samplingBaseline ? { samplingBaselineEvents: samplingBaseline.events } : {}),
      rewardHackScan,
    });
    let heldOutExecutionEvents: readonly FixedPromptTaskWalEvent[] = [];
    let heldOutDecisionEvents: readonly FixedPromptTaskWalEvent[] = [];
    if (heldInGate === null) {
      // Held-in cleared, but the held-in sweep itself can have exhausted the
      // budget. Do not start the held-out sweep if a guard already trips: the
      // candidate would be unverifiable on held-out, so revert it and stop
      // without a decision — a half-run round is not a decision, exactly like the
      // round-start guard above.
      const preHeldOutGuard = stopGuard();
      if (preHeldOutGuard) {
        await input.git.rollbackCommit(candidate.commitSha);
        stopReason = preHeldOutGuard;
        break;
      }
      const heldOut = await sweep(roundId, roundHeldOutTasks, input.heldOutResultsTsvPath);
      accumulate(heldOut);
      heldOutExecutionEvents = heldOut.events;
      heldOutDecisionEvents = decisionHeldOut(heldOut.events);
    }

    const result = decidePromptAcceptance({
      runId: input.runId,
      roundId,
      candidateCommitSha: candidate.commitSha,
      previousLastKeptCommitSha: lastKeptCommitSha,
      originalCommitSha: replayState.seedCommitSha,
      heldInTaskIds: decisionHeldInTaskIds,
      heldOutTaskIds: decisionHeldOutTaskIds,
      previousHeldInReferencePassEligibleRate: heldInReference,
      originalHeldOutPassEligibleRate: activeBaseline.heldOut.originalPassEligibleRate,
      heldInPassRateNoiseBand: activeBaseline.heldIn.noiseBand,
      heldOutPassRateNoiseBand: activeBaseline.heldOut.noiseBand,
      originalEvents: originalHeldOutEvents,
      lastKeptEvents: lastKeptHeldInEvents,
      candidateEvents: [...heldInDecisionEvents, ...heldOutDecisionEvents],
      ...(samplingBaseline
        ? {
            samplingBaselineEvents: samplingBaseline.events,
            samplingPromptHash,
          }
        : {}),
      rewardHackScan,
    });
    if (result.decision === 'discard') {
      // Revert the candidate commit BEFORE persisting the decision; HEAD has not
      // moved since the commit, so this is safe, and a crash can never leave the
      // WAL saying "discard" while HEAD still holds the discarded prompt.
      await input.git.rollbackCommit(candidate.commitSha);
    }
    await appendPromptAcceptanceDecision({
      resultsJsonlPath: input.resultsJsonlPath,
      id: newId(),
      ts: now(),
      result,
    });
    const controllerAttribution = buildRsiControllerAttribution({
      runId: input.runId,
      roundId,
      candidateCommitSha: candidate.commitSha,
      candidateRationaleHash: candidate.candidateRationaleHash,
      candidateRationale: candidate.candidateRationale,
      promptTimeAnalysis: promptAnalysis,
      analysis: await analyzeRsiRound({
        heldInTaskIds: decisionHeldInTaskIds,
        lastKeptEvents: lastKeptHeldInEvents,
        ...(previousCandidateHeldInEvents
          ? { previousCandidateEvents: previousCandidateHeldInEvents }
          : {}),
        candidateEvents: heldInDecisionEvents,
      }),
      heldInTaskIds: decisionHeldInTaskIds,
      lastKeptEvents: lastKeptHeldInEvents,
      candidateEvents: heldInDecisionEvents,
      decision: result,
    });
    const attributionEvent: RsiControllerAttributionEvent = {
      schemaVersion: FIXED_PROMPT_WAL_SCHEMA_VERSION,
      type: 'rsi_controller_attribution',
      id: newId(),
      ts: now(),
      ...controllerAttribution,
    };
    await appendFixedPromptWalEvent(input.resultsJsonlPath, attributionEvent);
    nextPromptAttribution = projectRsiPromptAttribution(controllerAttribution);
    decisions.push(result);
    finalHeldInReference = result.heldInReferencePassEligibleRate;

    if (result.decision === 'keep') {
      hasKeptCandidate = true;
      lastKeptCommitSha = result.lastKeptCommitSha;
      lastKeptHeldInExecutionEvents = heldIn.events;
      keptHeldInHistory = [...keptHeldInHistory, ...heldIn.events];
      keptHeldOutHistory = [...keptHeldOutHistory, ...heldOutExecutionEvents];
    }

    // The most recent attempt seeds the next round's meta-agent feedback, even
    // when discarded — "this change did not help" is useful signal.
    previousCandidateHeldInExecutionEvents = heldIn.events;
    latestHeldInFeedbackExecutionEvents = heldIn.events;
  }

  // A terminal KEEP changes retained-prompt history after the final round's
  // decision set was selected. Refresh once more so the returned profile and
  // fail-loud empty-partition invariant describe the committed final state,
  // including replay of a terminal keep.
  const finalAddressability = selectCurrentAddressability();
  assertAddressablePartitions(finalAddressability);
  const finalHeldInTaskIds = finalAddressability.heldIn.selectedTaskIds;
  if (hasKeptCandidate && !sameTaskIdSet(heldInReferenceTaskIds, finalHeldInTaskIds)) {
    const finalHeldInSet = new Set(finalHeldInTaskIds);
    const finalBaseline = calibratePromptAcceptanceBaseline({
      heldInTaskIds: finalHeldInTaskIds,
      heldOutTaskIds: finalAddressability.heldOut.selectedTaskIds,
      baselineRuns: baselineRunsData,
      zScore,
    });
    finalHeldInReference = bankedReferenceForTaskSet(
      lastKeptHeldInExecutionEvents.filter((event) => finalHeldInSet.has(event.taskId)),
      finalHeldInTaskIds,
      finalBaseline.heldIn.noiseBand,
    );
  }

  // 3. Structural smoke report over the full WAL.
  const events = await readFixedPromptWal(input.resultsJsonlPath);
  const smoke = promptStructuralSmokeReport({
    events,
    minimumRounds: input.rounds,
    requireRsiR2Evidence: true,
    ...(input.costCeilingUsd !== undefined ? { costCeilingUsd: input.costCeilingUsd } : {}),
  });

  return {
    runId: input.runId,
    baseline,
    decisions,
    keptCount: decisions.filter((decision) => decision.decision === 'keep').length,
    lastKeptCommitSha,
    heldInReferencePassEligibleRate: finalHeldInReference,
    totalCostUsd,
    stopReason,
    smoke,
    droppedHeldInTaskIds,
    droppedHeldOutTaskIds,
    addressability: finalAddressability,
  };
}

function sameTaskIdSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((taskId) => rightSet.has(taskId));
}

function bankedReferenceForTaskSet(
  lastKeptEvents: readonly FixedPromptTaskWalEvent[],
  taskIds: readonly string[],
  noiseBand: number,
): number | null {
  const passEligibleRate = summarizePromptAcceptancePartition(
    lastKeptEvents,
    taskIds,
  ).passEligibleRate;
  return passEligibleRate === null
    ? null
    : bankPromptAcceptanceReference(passEligibleRate, noiseBand);
}

function assertUniqueTaskIds(label: string, taskIds: readonly string[]): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const taskId of taskIds) {
    if (seen.has(taskId)) duplicates.add(taskId);
    seen.add(taskId);
  }
  if (duplicates.size > 0) {
    throw new Error(`${label} tasks contain duplicate id(s): ${[...duplicates].sort().join(', ')}`);
  }
}

function assertDisjointTaskIds(
  heldInTaskIds: readonly string[],
  heldOutTaskIds: readonly string[],
): void {
  const heldIn = new Set(heldInTaskIds);
  const overlap = [...new Set(heldOutTaskIds.filter((taskId) => heldIn.has(taskId)))].sort();
  if (overlap.length > 0) {
    throw new Error(`held-in and held-out tasks overlap: ${overlap.join(', ')}`);
  }
}

function assertReplayedAttributionMatchesResult(
  event: RsiControllerAttributionEvent,
  expected: RsiControllerAttribution,
): void {
  const actual = {
    runId: event.runId,
    roundId: event.roundId,
    candidateCommitSha: event.candidateCommitSha,
    heldInTaskSetHash: event.heldInTaskSetHash,
    candidateRationaleHash: event.candidateRationaleHash,
    evidenceRefs: event.evidenceRefs,
    predictedFixes: event.predictedFixes,
    riskTasks: event.riskTasks,
    unexpectedHeldInFlips: event.unexpectedHeldInFlips,
    decision: event.decision,
    rootCauseSignalMatch: event.rootCauseSignalMatch,
  };
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`RSI WAL replay attribution mismatch for ${event.roundId}`);
  }
}
