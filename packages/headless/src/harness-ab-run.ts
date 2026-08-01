import { buildRunManifestFingerprint } from './ab-manifest.js';
import { runAbComparison } from './ab-run.js';
import { withAbRunLock } from './ab-run-lock.js';
import type { AbComparisonSummary } from './ab-types.js';
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
  return runAbComparison({
    runId: input.runId,
    arms: input.arms.map((arm) => ({
      id: arm.id,
      kind: 'harness' as const,
      fingerprint: buildRunManifestFingerprint({
        config: arm.config,
        expectedPricingProfile: arm.expectedPricingProfile,
        billingMode: arm.billingMode,
      }),
    })) as unknown as [
      { id: HarnessAbArmId; kind: 'harness'; fingerprint: string },
      { id: HarnessAbArmId; kind: 'harness'; fingerprint: string },
    ],
    evaluationTasks: input.evaluationTasks,
    reps: 1,
    maxConcurrency: pairConcurrency,
    armExecution: input.armExecution ?? 'parallel',
    preexistingEventIds,
    runArm: async ({ roundId, arm, task }) => {
      const runtimeArm = input.arms.find((candidate) => candidate.id === arm.id);
      if (!runtimeArm) throw new Error(`harness A/B arm ${arm.id} is not configured`);
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
      if (!event) throw new Error(`harness A/B arm ${roundId} produced no event for ${task.id}`);
      return event;
    },
  });
}
