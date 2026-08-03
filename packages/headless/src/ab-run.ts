import type {
  AbArmSpec,
  AbComparisonSummary,
  ArmCohortResult,
  RunAbComparisonInput,
  RunArmCohortInput,
} from './ab-types.js';
import type { FixedPromptTask } from './fixed-prompt-controller.js';
import type { FixedPromptTaskWalEvent } from './fixed-prompt-wal-types.js';
import { assertFinitePositive, assertPositiveInt } from './numeric-guards.js';
import { summarizeAbComparison } from './ab-summary.js';

interface ActiveCohortResult {
  cohortIndex: number;
  rep: number;
  events: FixedPromptTaskWalEvent[];
}

export async function runAbComparison(input: RunAbComparisonInput): Promise<AbComparisonSummary> {
  const cohort = await runArmCohort(input);
  const baselineRuns = cohort.runsByArmId[input.arms[0].id]!;
  const candidateRuns = cohort.runsByArmId[input.arms[1].id]!;
  const summary = summarizeAbComparison({
    runId: input.runId,
    roundId: 'ab-summary',
    baselineArmId: input.arms[0].id,
    candidateArmId: input.arms[1].id,
    evaluationTaskIds: input.evaluationTasks.map((task) => task.id),
    baselineRuns,
    candidateRuns,
    ...(input.budgetMs !== undefined ? { budgetMs: input.budgetMs } : {}),
    ...(input.nonInferiorityMargin !== undefined
      ? { nonInferiorityMargin: input.nonInferiorityMargin }
      : {}),
  });
  return cohort.stopReason ? { ...summary, stopReason: cohort.stopReason } : summary;
}

export async function runArmCohort(input: RunArmCohortInput): Promise<ArmCohortResult> {
  if (input.arms.length < 2) throw new Error('arm cohort requires at least two arms');
  assertUniqueArmRoundIdSuffixes(input.arms);
  const reps = input.reps ?? 3;
  assertPositiveInt('reps', reps);
  const maxConcurrency =
    input.maxConcurrency !== undefined
      ? assertPositiveInt('maxConcurrency', input.maxConcurrency)
      : 1;
  if (input.observedCostStopUsd !== undefined)
    assertFinitePositive('observedCostStopUsd', input.observedCostStopUsd);
  const runsByArmId: Record<string, FixedPromptTaskWalEvent[][]> = Object.fromEntries(
    input.arms.map((arm) => [arm.id, Array.from({ length: reps }, () => [])]),
  );
  const cohorts: { rep: number; taskIndex: number; task: FixedPromptTask }[] = [];
  for (let rep = 0; rep < reps; rep += 1) {
    input.evaluationTasks.forEach((task, taskIndex) => cohorts.push({ rep, taskIndex, task }));
  }

  let nextCohortIndex = 0;
  let observedCostUsd = 0;
  let stopReason: AbComparisonSummary['stopReason'];
  const active = new Map<number, Promise<ActiveCohortResult>>();
  const observeArmEvent = (event: FixedPromptTaskWalEvent) => {
    observedCostUsd += eventCostUsd(event);
    if (isSystemicProviderFailure(event)) {
      stopReason = 'systemic_provider_failure';
    } else if (
      !stopReason &&
      input.observedCostStopUsd !== undefined &&
      observedCostUsd >= input.observedCostStopUsd
    ) {
      stopReason = 'observed_cost_stop_reached';
    }
  };
  const launchReadyCohorts = () => {
    while (!stopReason && active.size < maxConcurrency && nextCohortIndex < cohorts.length) {
      const cohortIndex = nextCohortIndex;
      const cohort = cohorts[nextCohortIndex++]!;
      active.set(
        cohortIndex,
        runCohort(input, cohort, observeArmEvent).then((result) => ({
          cohortIndex,
          ...result,
        })),
      );
    }
  };

  launchReadyCohorts();
  while (active.size > 0) {
    let result: ActiveCohortResult;
    try {
      result = await Promise.race(active.values());
    } catch (error) {
      await Promise.allSettled(active.values());
      throw error;
    }
    active.delete(result.cohortIndex);
    result.events.forEach((event, armIndex) => {
      runsByArmId[input.arms[armIndex]!.id]![result.rep]!.push(event);
    });
    launchReadyCohorts();
  }
  const taskOrder = new Map(input.evaluationTasks.map((task, index) => [task.id, index]));
  for (const armRuns of Object.values(runsByArmId)) {
    for (const run of armRuns) {
      run.sort((a, b) => (taskOrder.get(a.taskId) ?? 0) - (taskOrder.get(b.taskId) ?? 0));
    }
  }
  return {
    runId: input.runId,
    armIds: input.arms.map((arm) => arm.id),
    evaluationTaskIds: input.evaluationTasks.map((task) => task.id),
    reps,
    runsByArmId,
    ...(stopReason ? { stopReason } : {}),
  };
}

function eventCostUsd(event: FixedPromptTaskWalEvent): number {
  return 'tokenSummary' in event ? (event.tokenSummary?.costUsd ?? 0) : 0;
}

function isSystemicProviderFailure(event: FixedPromptTaskWalEvent): boolean {
  const errorClass =
    event.type === 'task_infra_failed'
      ? event.errorClass
      : event.type === 'task_budget_exhausted'
        ? event.evidenceErrorClass
        : undefined;
  return errorClass === 'provider_billing' || errorClass === 'auth';
}

async function runCohort(
  input: RunArmCohortInput,
  cohort: { rep: number; taskIndex: number; task: FixedPromptTask },
  onArmEvent: (event: FixedPromptTaskWalEvent) => void,
): Promise<{ rep: number; events: FixedPromptTaskWalEvent[] }> {
  const offset = (cohort.rep + cohort.taskIndex) % input.arms.length;
  const rotatedArms = [...input.arms.slice(offset), ...input.arms.slice(0, offset)];
  if (input.armExecution === 'sequential') {
    const byArmId = new Map<string, FixedPromptTaskWalEvent>();
    for (const arm of rotatedArms) {
      byArmId.set(arm.id, await runCohortTaskArm(input, arm, cohort, onArmEvent));
    }
    return { rep: cohort.rep, events: input.arms.map((arm) => byArmId.get(arm.id)!) };
  }
  const rotatedEvents = await drainParallelArmRuns(
    rotatedArms.map((arm) => runCohortTaskArm(input, arm, cohort, onArmEvent)),
  );
  const byArmId = new Map(rotatedArms.map((arm, index) => [arm.id, rotatedEvents[index]!]));
  return { rep: cohort.rep, events: input.arms.map((arm) => byArmId.get(arm.id)!) };
}

async function drainParallelArmRuns(
  runs: readonly Promise<FixedPromptTaskWalEvent>[],
): Promise<FixedPromptTaskWalEvent[]> {
  let firstError: unknown;
  let rejected = false;
  const values = await Promise.all(
    runs.map(async (run) => {
      try {
        return await run;
      } catch (error) {
        if (!rejected) {
          rejected = true;
          firstError = error;
        }
        return undefined;
      }
    }),
  );
  if (rejected) throw firstError;
  return values as FixedPromptTaskWalEvent[];
}

async function runCohortTaskArm(
  input: RunArmCohortInput,
  arm: AbArmSpec,
  pair: { rep: number; task: FixedPromptTask },
  onArmEvent: (event: FixedPromptTaskWalEvent) => void,
): Promise<FixedPromptTaskWalEvent> {
  const roundId = buildAbRoundId(input.roundIdPrefix, arm.id, pair.rep, pair.task.id);
  const event = await input.runArm({
    runId: input.runId,
    roundId,
    arm,
    task: pair.task,
    rep: pair.rep,
  });
  if (event.taskId !== pair.task.id)
    throw new Error(
      `A/B arm ${roundId} produced event for ${event.taskId}, expected ${pair.task.id}`,
    );
  if (!input.preexistingEventIds?.has(event.id)) onArmEvent(event);
  return event;
}

export function buildAbRoundId(
  prefix: string | undefined,
  armId: string,
  rep: number,
  taskId: string,
): string {
  const normalizedPrefix = prefix ? `${roundIdArmSuffix(prefix)}-` : '';
  return `${normalizedPrefix}ab-${roundIdArmSuffix(armId)}-r${rep}-${roundIdTaskSuffix(taskId)}`;
}

function roundIdArmSuffix(armId: string): string {
  return armId.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'arm';
}

function assertUniqueArmRoundIdSuffixes(arms: readonly AbArmSpec[]): void {
  const suffixes = new Map<string, string>();
  for (const arm of arms) {
    const suffix = roundIdArmSuffix(arm.id);
    const existingArmId = suffixes.get(suffix);
    if (existingArmId !== undefined) {
      throw new Error(
        `A/B arm ids must produce unique round id suffixes: ${JSON.stringify(existingArmId)} and ${JSON.stringify(arm.id)} both map to ${JSON.stringify(suffix)}`,
      );
    }
    suffixes.set(suffix, arm.id);
  }
}

function roundIdTaskSuffix(taskId: string): string {
  return taskId.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'task';
}
