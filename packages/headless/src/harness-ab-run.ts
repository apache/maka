import { buildRunManifestFingerprint } from './ab-manifest.js';
import { runArmCohort } from './ab-run.js';
import { withAbRunLock } from './ab-run-lock.js';
import type { AbComparisonSummary, ArmCohortResult } from './ab-types.js';
import { isEvaluatedOutcome, summarizeAbComparison } from './ab-summary.js';
import type { Config } from './contracts.js';
import type { HarborBillingMode } from './harbor-task-runner.js';
import {
  readFixedPromptWal,
  runFixedPromptController,
  type FixedPromptTask,
  type TaskRunner,
} from './fixed-prompt-controller.js';
import { HARNESS_AB_PAIR_CONCURRENCY, type HarnessAbArmId } from './harness-ab-manifest.js';

export interface HarnessAbRuntimeArm {
  id: HarnessAbArmId;
  config: Config;
  expectedPricingProfile: string;
  billingMode?: HarborBillingMode;
  harborRunner: TaskRunner;
}

export interface RunHarnessAbComparisonInput {
  runId: string;
  runRoot: string;
  resultsJsonlPath: string;
  systemPromptPath: string;
  resumeFingerprint: string;
  evaluationTasks: readonly FixedPromptTask[];
  arms: readonly [HarnessAbRuntimeArm, HarnessAbRuntimeArm];
  pairConcurrency?: number;
  armExecution?: 'parallel' | 'sequential';
  retryAdjudicatedInfraRoundIdsOnce?: readonly string[];
  now?: () => number;
  newId?: () => string;
}

export interface RunHarnessArmCohortInput extends Omit<RunHarnessAbComparisonInput, 'arms'> {
  arms: readonly HarnessAbRuntimeArm[];
}

export interface HarnessArmCohortSummary {
  runId: string;
  armIds: readonly HarnessAbArmId[];
  taskCount: number;
  commonCohort: {
    groups: number;
    comparableGroups: number;
    excludedGroupIds: string[];
  };
  pairwise: AbComparisonSummary[];
  stopReason?: AbComparisonSummary['stopReason'];
}

export async function runHarnessAbComparison(
  input: RunHarnessAbComparisonInput,
): Promise<AbComparisonSummary> {
  return withAbRunLock(input.runRoot, () => runHarnessAbComparisonUnlocked(input));
}

export function withHarnessAbRunLock<T>(runRoot: string, action: () => Promise<T>): Promise<T> {
  return withAbRunLock(runRoot, action);
}

export async function runHarnessAbComparisonUnlocked(
  input: RunHarnessAbComparisonInput,
): Promise<AbComparisonSummary> {
  const cohort = await executeHarnessArmCohort(input);
  const summary = summarizeAbComparison({
    runId: input.runId,
    roundId: 'ab-summary',
    baselineArmId: input.arms[0].id,
    candidateArmId: input.arms[1].id,
    evaluationTaskIds: cohort.evaluationTaskIds,
    baselineRuns: cohort.runsByArmId[input.arms[0].id]!,
    candidateRuns: cohort.runsByArmId[input.arms[1].id]!,
  });
  return cohort.stopReason ? { ...summary, stopReason: cohort.stopReason } : summary;
}

export async function runHarnessArmCohort(
  input: RunHarnessArmCohortInput,
): Promise<HarnessArmCohortSummary> {
  return withAbRunLock(input.runRoot, () => runHarnessArmCohortUnlocked(input));
}

export async function runHarnessArmCohortUnlocked(
  input: RunHarnessArmCohortInput,
): Promise<HarnessArmCohortSummary> {
  if (input.arms.length < 3) throw new Error('harness cohort requires at least three arms');
  const cohort = await executeHarnessArmCohort(input);
  const arms = input.arms.map((arm) => ({ id: arm.id }));
  const pairwise: AbComparisonSummary[] = [];
  for (let baseline = 0; baseline < arms.length; baseline += 1) {
    for (let candidate = baseline + 1; candidate < arms.length; candidate += 1) {
      pairwise.push(
        summarizeAbComparison({
          runId: input.runId,
          roundId: `cohort-summary-${arms[baseline]!.id}-vs-${arms[candidate]!.id}`,
          baselineArmId: arms[baseline]!.id,
          candidateArmId: arms[candidate]!.id,
          evaluationTaskIds: cohort.evaluationTaskIds,
          baselineRuns: cohort.runsByArmId[arms[baseline]!.id]!,
          candidateRuns: cohort.runsByArmId[arms[candidate]!.id]!,
        }),
      );
    }
  }
  const excludedGroupIds: string[] = [];
  for (const taskId of cohort.evaluationTaskIds) {
    const comparable = arms.every((arm) => {
      const event = cohort.runsByArmId[arm.id]![0]!.find(
        (candidate) => candidate.taskId === taskId,
      );
      return event !== undefined && isEvaluatedOutcome(event);
    });
    if (!comparable) excludedGroupIds.push(`r0-${taskId}`);
  }
  return {
    runId: input.runId,
    armIds: input.arms.map((arm) => arm.id),
    taskCount: cohort.evaluationTaskIds.length,
    commonCohort: {
      groups: cohort.evaluationTaskIds.length,
      comparableGroups: cohort.evaluationTaskIds.length - excludedGroupIds.length,
      excludedGroupIds,
    },
    pairwise: cohort.stopReason
      ? pairwise.map((summary) => ({ ...summary, stopReason: cohort.stopReason }))
      : pairwise,
    ...(cohort.stopReason ? { stopReason: cohort.stopReason } : {}),
  };
}

async function executeHarnessArmCohort(input: RunHarnessArmCohortInput): Promise<ArmCohortResult> {
  const pairConcurrency = input.pairConcurrency ?? HARNESS_AB_PAIR_CONCURRENCY;
  if (!Number.isSafeInteger(pairConcurrency) || pairConcurrency < 1) {
    throw new Error('pairConcurrency must be a positive integer');
  }
  const retryRoundIds = new Set(input.retryAdjudicatedInfraRoundIdsOnce ?? []);
  if (retryRoundIds.size !== (input.retryAdjudicatedInfraRoundIdsOnce?.length ?? 0)) {
    throw new Error('adjudicated infra retry round ids must be unique');
  }
  const validRoundIds = new Set(
    input.evaluationTasks.flatMap((task) => input.arms.map((arm) => `ab-${arm.id}-r0-${task.id}`)),
  );
  for (const roundId of retryRoundIds) {
    if (!validRoundIds.has(roundId)) {
      throw new Error(`adjudicated infra retry names unknown round ${roundId}`);
    }
  }
  const preexistingEventIds = new Set(
    (await readFixedPromptWal(input.resultsJsonlPath))
      .filter(
        (event) =>
          event.runId === input.runId &&
          'resumeFingerprint' in event &&
          event.resumeFingerprint === input.resumeFingerprint,
      )
      .map((event) => event.id),
  );
  const arms = input.arms.map((arm) => ({
    id: arm.id,
    kind: 'harness' as const,
    fingerprint: buildRunManifestFingerprint({
      config: arm.config,
      expectedPricingProfile: arm.expectedPricingProfile,
      billingMode: arm.billingMode,
    }),
  }));
  const cohort = await runArmCohort({
    runId: input.runId,
    arms,
    evaluationTasks: input.evaluationTasks,
    reps: 1,
    maxConcurrency: pairConcurrency,
    armExecution: input.armExecution ?? 'parallel',
    preexistingEventIds,
    runArm: async ({ roundId, arm, task }) => {
      const runtimeArm = input.arms.find((candidate) => candidate.id === arm.id);
      if (!runtimeArm) throw new Error(`harness cohort arm ${arm.id} is not configured`);
      const result = await runFixedPromptController({
        runId: input.runId,
        roundId,
        config: runtimeArm.config,
        systemPromptPath: input.systemPromptPath,
        resultsJsonlPath: input.resultsJsonlPath,
        tasks: [task],
        infraFailurePolicy: 'terminal',
        protectPassAtOne: true,
        ...(retryRoundIds.has(roundId) ? { retryAdjudicatedInfraTaskIdsOnce: [task.id] } : {}),
        requireExecutionIdentity: true,
        requireFinalUsage: true,
        expectedPricingProfile: runtimeArm.expectedPricingProfile,
        ...(runtimeArm.billingMode ? { billingMode: runtimeArm.billingMode } : {}),
        resumeFingerprint: input.resumeFingerprint,
        taskRunner: runtimeArm.harborRunner,
        ...(input.now ? { now: input.now } : {}),
        ...(input.newId ? { newId: input.newId } : {}),
      });
      const event = result.events.find((candidate) => candidate.taskId === task.id);
      if (!event) throw new Error(`harness cohort arm ${roundId} produced no event for ${task.id}`);
      return event;
    },
  });
  return cohort;
}
