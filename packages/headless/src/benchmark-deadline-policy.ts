import { assertPositiveInt } from './numeric-guards.js';
import { positiveIntEnv, type RunHarborCellEnv } from './headless-run-env.js';

export const TASK_NATIVE_FULL_BUDGET_DEADLINE_POLICY_ID = 'task-native-full-budget-v1';

export interface BenchmarkDeadlinePolicy {
  id: typeof TASK_NATIVE_FULL_BUDGET_DEADLINE_POLICY_ID;
  /** Task-native agent timeout: the interval during which model work may start. */
  modelBudgetSec: number;
  /** Tail reserved only for stopping the runtime and persisting artifacts. */
  settlementGraceSec: number;
  /** Outer Maka agent watchdog. Always modelBudgetSec + settlementGraceSec. */
  hardTimeoutSec: number;
}

export interface BenchmarkDeadlinePolicyManifest {
  id: typeof TASK_NATIVE_FULL_BUDGET_DEADLINE_POLICY_ID;
  settlementGraceSec: number;
}

export function resolveTaskNativeDeadlinePolicy(
  modelBudgetSec: number,
  settlementGraceSec: number,
): BenchmarkDeadlinePolicy {
  assertPositiveInt('modelBudgetSec', modelBudgetSec);
  assertPositiveInt('settlementGraceSec', settlementGraceSec);
  if (!Number.isSafeInteger(modelBudgetSec) || !Number.isSafeInteger(settlementGraceSec)) {
    throw new Error('modelBudgetSec and settlementGraceSec must be safe integers');
  }
  const hardTimeoutSec = modelBudgetSec + settlementGraceSec;
  if (!Number.isSafeInteger(hardTimeoutSec)) {
    throw new Error('modelBudgetSec + settlementGraceSec must be a safe integer');
  }
  return {
    id: TASK_NATIVE_FULL_BUDGET_DEADLINE_POLICY_ID,
    modelBudgetSec,
    settlementGraceSec,
    hardTimeoutSec,
  };
}

export function benchmarkDeadlinePoliciesEqual(
  actual: BenchmarkDeadlinePolicy | undefined,
  expected: BenchmarkDeadlinePolicy | undefined,
): boolean {
  if (actual === undefined || expected === undefined) return actual === expected;
  return (
    actual.id === expected.id &&
    actual.modelBudgetSec === expected.modelBudgetSec &&
    actual.settlementGraceSec === expected.settlementGraceSec &&
    actual.hardTimeoutSec === expected.hardTimeoutSec
  );
}

export function benchmarkDeadlinePolicyFromEnv(
  env: RunHarborCellEnv,
): BenchmarkDeadlinePolicy | undefined {
  const id = env.MAKA_BENCHMARK_DEADLINE_POLICY;
  if (id === undefined) return undefined;
  if (id !== TASK_NATIVE_FULL_BUDGET_DEADLINE_POLICY_ID) {
    throw new Error(
      `MAKA_BENCHMARK_DEADLINE_POLICY must be ${TASK_NATIVE_FULL_BUDGET_DEADLINE_POLICY_ID}`,
    );
  }
  const policy = resolveTaskNativeDeadlinePolicy(
    positiveIntEnv(env.MAKA_CELL_TIMEOUT_SEC, 'MAKA_CELL_TIMEOUT_SEC')!,
    positiveIntEnv(env.MAKA_CELL_SETTLEMENT_GRACE_SEC, 'MAKA_CELL_SETTLEMENT_GRACE_SEC')!,
  );
  const attestedHardTimeout = positiveIntEnv(
    env.MAKA_CELL_HARD_TIMEOUT_SEC,
    'MAKA_CELL_HARD_TIMEOUT_SEC',
  );
  if (attestedHardTimeout !== policy.hardTimeoutSec) {
    throw new Error('MAKA_CELL_HARD_TIMEOUT_SEC must equal T + G');
  }
  return policy;
}
