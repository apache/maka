import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withAbRunLock } from './ab-run-lock.js';
import { buildAbRoundId } from './ab-run.js';
import { summarizeAbComparison } from './ab-summary.js';
import {
  hashSystemPrompt,
  readFixedPromptWal,
  selectFixedPromptRoundTaskEvents,
} from './fixed-prompt-controller.js';
import type { FixedPromptTaskWalEvent } from './fixed-prompt-wal-types.js';
import {
  runtimePolicyArmResumeFingerprint,
  runRuntimePolicyAbComparisonUnlocked,
  type RunRuntimePolicyAbComparisonInput,
  type RuntimePolicyAbComparisonSummary,
} from './runtime-policy-ab-run.js';

export interface RunRuntimePolicyAbLifecycleInput
  extends Omit<RunRuntimePolicyAbComparisonInput, 'evaluationTasks' | 'reps' | 'roundIdPrefix'> {
  manifestFingerprint: string;
  pilotTasks: RunRuntimePolicyAbComparisonInput['evaluationTasks'];
  evaluationTasks: RunRuntimePolicyAbComparisonInput['evaluationTasks'];
  fullReps: number;
}

export interface RuntimePolicyAbLifecycleState {
  schemaVersion: 'maka.runtime_policy_ab.lifecycle.v2';
  manifestFingerprint: string;
  status: 'pilot_pending' | 'pilot_not_cleared' | 'pilot_cleared' | 'full_completed' | 'invalid';
  reason?: string;
  pilot?: RuntimePolicyAbComparisonSummary;
  full?: RuntimePolicyAbComparisonSummary;
}

interface LegacyRuntimePolicyAbLifecycleState {
  schemaVersion: 'maka.runtime_policy_ab.lifecycle.v1';
  manifestFingerprint: string;
  status: RuntimePolicyAbLifecycleState['status'];
  reason?: string;
  pilot?: Pick<RuntimePolicyAbComparisonSummary, 'stopReason'>;
  full?: Pick<RuntimePolicyAbComparisonSummary, 'stopReason'>;
}

export async function runRuntimePolicyAbLifecycle(
  input: RunRuntimePolicyAbLifecycleInput,
): Promise<RuntimePolicyAbLifecycleState> {
  return withAbRunLock(input.runRoot, async () => {
    const statePath = join(input.runRoot, 'runtime-policy-ab-state.json');
    let state = await readState(statePath, input.manifestFingerprint);
    if (state.schemaVersion === 'maka.runtime_policy_ab.lifecycle.v1') {
      state = await rebuildLegacyState(input, state);
      await writeState(statePath, state);
    }
    if (
      state.status === 'full_completed' ||
      state.status === 'invalid' ||
      state.status === 'pilot_not_cleared'
    )
      return state;

    if (state.status === 'pilot_pending') {
      const pilotResult = await runRuntimePolicyAbComparisonUnlocked({
        ...input,
        evaluationTasks: input.pilotTasks,
        reps: 1,
        roundIdPrefix: 'pilot',
      });
      const pilot: RuntimePolicyAbComparisonSummary = pilotResult;
      const clearanceFailure = pilotClearanceFailure(pilot);
      state = {
        schemaVersion: 'maka.runtime_policy_ab.lifecycle.v2',
        manifestFingerprint: input.manifestFingerprint,
        status: clearanceFailure ? 'pilot_not_cleared' : 'pilot_cleared',
        ...(clearanceFailure ? { reason: clearanceFailure } : {}),
        pilot,
      };
      await writeState(statePath, state);
      if (clearanceFailure) return state;
    }

    if (input.fullReps < 2 || !Number.isSafeInteger(input.fullReps)) {
      state = { ...state, status: 'invalid', reason: 'full_reps_must_be_at_least_2' };
      await writeState(statePath, state);
      return state;
    }
    const pilotCost =
      (state.pilot?.baseline.totalCostUsd ?? 0) + (state.pilot?.candidate.totalCostUsd ?? 0);
    const remainingCostUsd = input.executionProfile.observedCostStopUsd - pilotCost;
    if (remainingCostUsd <= 0) {
      state = { ...state, status: 'invalid', reason: 'observed_cost_stop_reached_during_pilot' };
      await writeState(statePath, state);
      return state;
    }
    const full = await runRuntimePolicyAbComparisonUnlocked({
      ...input,
      evaluationTasks: input.evaluationTasks,
      reps: input.fullReps,
      roundIdPrefix: 'full',
      executionProfile: { ...input.executionProfile, observedCostStopUsd: remainingCostUsd },
    });
    const invalidReason =
      full.stopReason ?? (full.decision === 'invalid' ? full.reason : undefined);
    state = {
      ...state,
      status: invalidReason ? 'invalid' : 'full_completed',
      ...(invalidReason ? { reason: invalidReason } : {}),
      full,
    };
    await writeState(statePath, state);
    return state;
  });
}

function pilotClearanceFailure(summary: RuntimePolicyAbComparisonSummary): string | undefined {
  if (summary.stopReason) return summary.stopReason;
  if (summary.baseline.infraFailed + summary.candidate.infraFailed > 0)
    return 'pilot_infra_failure';
  if (summary.baseline.plumbingFailed + summary.candidate.plumbingFailed > 0)
    return 'pilot_plumbing_failure';
  if (summary.baseline.coverageRate !== 1 || summary.candidate.coverageRate !== 1)
    return 'pilot_incomplete';
  if ((summary.candidate.contextBudget?.activatedAttempts ?? 0) === 0)
    return 'pilot_candidate_not_activated';
  return undefined;
}

async function readState(
  path: string,
  manifestFingerprint: string,
): Promise<RuntimePolicyAbLifecycleState | LegacyRuntimePolicyAbLifecycleState> {
  try {
    const state = JSON.parse(await readFile(path, 'utf8')) as
      | RuntimePolicyAbLifecycleState
      | LegacyRuntimePolicyAbLifecycleState;
    if (
      state.schemaVersion !== 'maka.runtime_policy_ab.lifecycle.v1' &&
      state.schemaVersion !== 'maka.runtime_policy_ab.lifecycle.v2'
    )
      throw new Error('unsupported runtime policy A/B lifecycle state');
    if (state.manifestFingerprint !== manifestFingerprint)
      throw new Error('runtime policy A/B lifecycle state does not match manifest');
    return state;
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return {
      schemaVersion: 'maka.runtime_policy_ab.lifecycle.v2',
      manifestFingerprint,
      status: 'pilot_pending',
    };
  }
}

async function rebuildLegacyState(
  input: RunRuntimePolicyAbLifecycleInput,
  legacy: LegacyRuntimePolicyAbLifecycleState,
): Promise<RuntimePolicyAbLifecycleState> {
  const events = (await readFixedPromptWal(input.resultsJsonlPath)).filter(
    (event): event is FixedPromptTaskWalEvent =>
      event.type === 'task_completed' ||
      event.type === 'task_budget_exhausted' ||
      event.type === 'task_infra_failed' ||
      event.type === 'task_plumbing_failed',
  );
  const expectedPromptHash = hashSystemPrompt(await readFile(input.systemPromptPath, 'utf8'));
  const pilot = legacy.pilot
    ? summarizeRecordedRound(
        input,
        events,
        expectedPromptHash,
        'pilot',
        input.pilotTasks,
        1,
        legacy.pilot.stopReason,
      )
    : undefined;
  const full = legacy.full
    ? summarizeRecordedRound(
        input,
        events,
        expectedPromptHash,
        'full',
        input.evaluationTasks,
        input.fullReps,
        legacy.full.stopReason,
      )
    : undefined;
  if (full) {
    const invalidReason =
      full.stopReason ?? (full.decision === 'invalid' ? full.reason : undefined);
    return {
      schemaVersion: 'maka.runtime_policy_ab.lifecycle.v2',
      manifestFingerprint: input.manifestFingerprint,
      status: invalidReason ? 'invalid' : 'full_completed',
      ...(invalidReason ? { reason: invalidReason } : {}),
      ...(pilot ? { pilot } : {}),
      full,
    };
  }
  if (pilot) {
    const reason = pilotClearanceFailure(pilot);
    return {
      schemaVersion: 'maka.runtime_policy_ab.lifecycle.v2',
      manifestFingerprint: input.manifestFingerprint,
      status: reason ? 'pilot_not_cleared' : 'pilot_cleared',
      ...(reason ? { reason } : {}),
      pilot,
    };
  }
  return {
    schemaVersion: 'maka.runtime_policy_ab.lifecycle.v2',
    manifestFingerprint: input.manifestFingerprint,
    status: 'pilot_pending',
  };
}

function summarizeRecordedRound(
  input: RunRuntimePolicyAbLifecycleInput,
  events: readonly FixedPromptTaskWalEvent[],
  expectedPromptHash: string,
  prefix: 'pilot' | 'full',
  tasks: RunRuntimePolicyAbComparisonInput['evaluationTasks'],
  reps: number,
  stopReason: RuntimePolicyAbComparisonSummary['stopReason'],
): RuntimePolicyAbComparisonSummary {
  const runsFor = (
    arm: RunRuntimePolicyAbComparisonInput['arms'][number],
  ): FixedPromptTaskWalEvent[][] => {
    const resumeFingerprint = runtimePolicyArmResumeFingerprint(input, arm);
    const runs = Array.from({ length: reps }, (_, rep) =>
      tasks.flatMap((task) => {
        const roundId = buildAbRoundId(prefix, arm.id, rep, task.id);
        const event = selectFixedPromptRoundTaskEvents(
          events,
          input.runId,
          roundId,
          expectedPromptHash,
          resumeFingerprint,
        ).get(task.id);
        if (!event && !stopReason)
          throw new Error(
            `cannot rebuild runtime policy A/B state: missing WAL event for ${roundId}`,
          );
        if (
          event?.type === 'task_plumbing_failed' &&
          event.errorClass === 'missing_execution_identity'
        ) {
          throw new Error(
            `cannot rebuild runtime policy A/B state: legacy missing-identity event ${event.id} has no authoritative outcome`,
          );
        }
        return event ? [event] : [];
      }),
    );
    if (runs.every((run) => run.length === 0))
      throw new Error(
        `cannot rebuild runtime policy A/B state: no WAL evidence for ${prefix} round`,
      );
    return runs;
  };
  const summary = summarizeAbComparison({
    runId: input.runId,
    roundId: 'ab-summary',
    baselineArmId: input.arms[0].id,
    candidateArmId: input.arms[1].id,
    evaluationTaskIds: tasks.map((task) => task.id),
    baselineRuns: runsFor(input.arms[0]),
    candidateRuns: runsFor(input.arms[1]),
    ...(input.budgetMs !== undefined ? { budgetMs: input.budgetMs } : {}),
    ...(input.nonInferiorityMargin !== undefined
      ? { nonInferiorityMargin: input.nonInferiorityMargin }
      : {}),
  });
  return stopReason ? { ...summary, stopReason } : summary;
}

async function writeState(path: string, state: RuntimePolicyAbLifecycleState): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, path);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
