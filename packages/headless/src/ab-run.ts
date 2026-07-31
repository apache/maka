import type { AbArmSpec, AbComparisonSummary, RunAbComparisonInput } from './ab-types.js';
import type { FixedPromptTask } from './fixed-prompt-controller.js';
import type { FixedPromptTaskWalEvent } from './fixed-prompt-wal-types.js';
import { assertFinitePositive, assertPositiveInt } from './numeric-guards.js';
import { summarizeAbComparison } from './ab-summary.js';

interface ActivePairResult {
  pairIndex: number;
  rep: number;
  baseline: FixedPromptTaskWalEvent;
  candidate: FixedPromptTaskWalEvent;
}

export async function runAbComparison(input: RunAbComparisonInput): Promise<AbComparisonSummary> {
  assertUniqueArmRoundIdSuffixes(input.arms);
  const reps = input.reps ?? 3;
  assertPositiveInt('reps', reps);
  const maxConcurrency =
    input.maxConcurrency !== undefined
      ? assertPositiveInt('maxConcurrency', input.maxConcurrency)
      : 1;
  if (input.observedCostStopUsd !== undefined)
    assertFinitePositive('observedCostStopUsd', input.observedCostStopUsd);
  const baselineRuns: FixedPromptTaskWalEvent[][] = Array.from({ length: reps }, () => []);
  const candidateRuns: FixedPromptTaskWalEvent[][] = Array.from({ length: reps }, () => []);
  const pairs: { rep: number; taskIndex: number; task: FixedPromptTask }[] = [];
  for (let rep = 0; rep < reps; rep += 1) {
    input.evaluationTasks.forEach((task, taskIndex) => pairs.push({ rep, taskIndex, task }));
  }

  let nextPairIndex = 0;
  let observedCostUsd = 0;
  let stopReason: AbComparisonSummary['stopReason'];
  const active = new Map<number, Promise<ActivePairResult>>();
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
  const launchReadyPairs = () => {
    while (!stopReason && active.size < maxConcurrency && nextPairIndex < pairs.length) {
      const pairIndex = nextPairIndex;
      const pair = pairs[nextPairIndex++]!;
      active.set(
        pairIndex,
        runComparisonPair(input, pair, observeArmEvent).then((result) => ({
          pairIndex,
          ...result,
        })),
      );
    }
  };

  launchReadyPairs();
  while (active.size > 0) {
    let result: ActivePairResult;
    try {
      result = await Promise.race(active.values());
    } catch (error) {
      await Promise.allSettled(active.values());
      throw error;
    }
    active.delete(result.pairIndex);
    baselineRuns[result.rep]!.push(result.baseline);
    candidateRuns[result.rep]!.push(result.candidate);
    launchReadyPairs();
  }
  const taskOrder = new Map(input.evaluationTasks.map((task, index) => [task.id, index]));
  for (const run of [...baselineRuns, ...candidateRuns]) {
    run.sort((a, b) => (taskOrder.get(a.taskId) ?? 0) - (taskOrder.get(b.taskId) ?? 0));
  }

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
  return stopReason ? { ...summary, stopReason } : summary;
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

async function runComparisonPair(
  input: RunAbComparisonInput,
  pair: { rep: number; taskIndex: number; task: FixedPromptTask },
  onArmEvent: (event: FixedPromptTaskWalEvent) => void,
): Promise<{ rep: number; baseline: FixedPromptTaskWalEvent; candidate: FixedPromptTaskWalEvent }> {
  if (input.armExecution === 'sequential') {
    if ((pair.rep + pair.taskIndex) % 2 === 0) {
      const baseline = await runComparisonTaskArm(input, input.arms[0], pair, onArmEvent);
      const candidate = await runComparisonTaskArm(input, input.arms[1], pair, onArmEvent);
      return { rep: pair.rep, baseline, candidate };
    }
    const candidate = await runComparisonTaskArm(input, input.arms[1], pair, onArmEvent);
    const baseline = await runComparisonTaskArm(input, input.arms[0], pair, onArmEvent);
    return { rep: pair.rep, baseline, candidate };
  }
  if ((pair.rep + pair.taskIndex) % 2 === 0) {
    const [baseline, candidate] = await drainParallelArmRuns([
      runComparisonTaskArm(input, input.arms[0], pair, onArmEvent),
      runComparisonTaskArm(input, input.arms[1], pair, onArmEvent),
    ]);
    return { rep: pair.rep, baseline, candidate };
  }
  const [candidate, baseline] = await drainParallelArmRuns([
    runComparisonTaskArm(input, input.arms[1], pair, onArmEvent),
    runComparisonTaskArm(input, input.arms[0], pair, onArmEvent),
  ]);
  return { rep: pair.rep, baseline, candidate };
}

async function drainParallelArmRuns(
  runs: readonly [Promise<FixedPromptTaskWalEvent>, Promise<FixedPromptTaskWalEvent>],
): Promise<[FixedPromptTaskWalEvent, FixedPromptTaskWalEvent]> {
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
  return values as [FixedPromptTaskWalEvent, FixedPromptTaskWalEvent];
}

async function runComparisonTaskArm(
  input: RunAbComparisonInput,
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
