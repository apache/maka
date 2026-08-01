import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  assertDeepSweFullTaskSet,
  assertDeepSweFullTaskTreeFingerprint,
  assertTerminalBench21TaskSet,
  assertTerminalBench21TaskTreeFingerprint,
  buildHarnessAbResumeFingerprint,
  buildHarnessAbRunManifest,
  DEEP_SWE_FULL_TASK_IDS,
  DEEP_SWE_FULL_TASK_TREE_FINGERPRINT,
  DEEP_SWE_SUBSET_30_TASK_IDS,
  deterministicHarnessTaskOrder,
  HARNESS_MAKA_CONTEXT_BUDGET,
  TERMINAL_BENCH_2_1_TASK_IDS,
  TERMINAL_BENCH_2_1_TASK_TREE_FINGERPRINT,
} from '../harness-ab-manifest.js';

describe('harness A/B manifest', () => {
  test('freezes tool-result pruning on and semantic compact off for Maka', () => {
    assert.deepEqual(HARNESS_MAKA_CONTEXT_BUDGET, {
      activeToolResultPrune: {
        enabled: true,
        maxCurrentResultEstimatedTokens: 2048,
        minStepNumber: 1,
      },
      staleToolResultPrune: {
        enabled: true,
        maxResultEstimatedTokens: 2048,
        minRecentTurnsFull: 0,
      },
      semanticCompact: {
        enabled: false,
      },
    });
  });

  test('freezes one deterministic 30-task prefix inside the full task order', () => {
    const taskIds = Array.from(
      { length: 89 },
      (_, index) => `task-${String(index + 1).padStart(2, '0')}`,
    );
    const input = manifestInput(taskIds);

    const manifest = buildHarnessAbRunManifest(input);

    assert.equal(manifest.experimentKind, 'harness');
    assert.equal(manifest.reps, 1);
    assert.equal(manifest.maxConcurrency, 2);
    assert.equal(manifest.maxConcurrentAttempts, 4);
    assert.equal(manifest.evaluationTaskIds.length, 89);
    assert.deepEqual(manifest.pilotTaskIds, manifest.evaluationTaskIds.slice(0, 30));
    assert.deepEqual(
      manifest.evaluationTaskIds,
      deterministicHarnessTaskOrder([...taskIds].reverse(), input.orderSeed),
    );
    assert.equal(new Set(manifest.evaluationTaskIds).size, 89);
    assert.deepEqual(manifest.metadata, {
      benchmark: {
        dataset: 'terminal-bench',
        version: '2.1',
        revision: 'tb-revision',
        timeoutPolicy: 'task-native',
        timeoutMultiplier: 1,
        outerTimeoutGraceSec: 900,
      },
      metric: 'pass@1',
      execution: { armExecution: 'parallel' },
      order: { algorithm: 'sha256-rank-v1', seed: 'maka-glm-5.2-v1', pilotTaskCount: 30 },
      model: { provider: 'zai-coding-plan', id: 'glm-5.2', reasoningEffort: 'max' },
      pricing: {
        currency: 'USD',
        unit: 'per_1m_tokens',
        input: 1.4,
        cachedInput: 0.26,
        output: 4.4,
        source: 'z.ai-public-2026-07-13',
      },
    });
    assert.equal(manifest.harborTimeoutMs, null);
  });

  test('records sequential arms as one concurrent attempt per pair', () => {
    const manifest = buildHarnessAbRunManifest({
      ...manifestInput(['a', 'b', 'c']),
      armExecution: 'sequential',
    });

    assert.deepEqual(manifest.metadata.execution, { armExecution: 'sequential' });
    assert.equal(manifest.maxConcurrency, 2);
    assert.equal(manifest.maxConcurrentAttempts, 2);
  });

  test('changes identity when a frozen harness config changes', () => {
    const original = buildHarnessAbRunManifest(manifestInput(['a', 'b', 'c']));
    const changed = buildHarnessAbRunManifest({
      ...manifestInput(['a', 'b', 'c']),
      arms: [
        { id: 'maka', version: '98e3846e', config: { continuation: true } },
        { id: 'opencode', version: '1.17.19', config: { variant: 'max' } },
      ],
    });

    assert.notEqual(changed.fingerprint, original.fingerprint);
    assert.notEqual(changed.arms[1].fingerprint, original.arms[1].fingerprint);
  });

  test('changes identity when the Pier settlement allowance changes', () => {
    const originalInput = manifestInput(['a', 'b', 'c']);
    const original = buildHarnessAbRunManifest({
      ...originalInput,
      benchmark: {
        ...originalInput.benchmark,
        dataset: 'deep-swe',
        version: '1.1',
        executor: { id: 'pier', version: '0.3.0' },
        agentSettlementGraceSec: 30,
      },
    });
    const changed = buildHarnessAbRunManifest({
      ...originalInput,
      benchmark: {
        ...original.metadata.benchmark,
        agentSettlementGraceSec: 31,
      },
    });

    assert.notEqual(changed.fingerprint, original.fingerprint);
  });

  test('records advisory Oracle annotations without changing frozen A/B selection', () => {
    const oracleEvidence = {
      registryUrl:
        'https://github.com/maka-agent/maka-agent/releases/download/oracle-evidence/snapshot.json',
      expectedSnapshotFingerprint: `sha256:${'a'.repeat(64)}`,
      resolvedSnapshotFingerprint: `sha256:${'a'.repeat(64)}`,
      annotations: [
        {
          taskId: 'a',
          state: 'passed' as const,
          qualificationKey: `sha256:${'b'.repeat(64)}`,
          evidenceFingerprint: `sha256:${'c'.repeat(64)}`,
        },
      ],
      warnings: [] as string[],
    };
    const passed = buildHarnessAbRunManifest({
      ...manifestInput(['a', 'b', 'c']),
      oracleEvidence,
    });
    const failed = buildHarnessAbRunManifest({
      ...manifestInput(['a', 'b', 'c']),
      oracleEvidence: {
        ...oracleEvidence,
        annotations: [{ ...oracleEvidence.annotations[0]!, state: 'failed' as const }],
        warnings: ['Oracle evidence failed for task a'],
      },
    });

    assert.deepEqual(failed.evaluationTaskIds, passed.evaluationTaskIds);
    assert.deepEqual(passed.metadata.oracleEvidence?.annotations, oracleEvidence.annotations);
    assert.notEqual(failed.fingerprint, passed.fingerprint);
    assert.equal(buildHarnessAbResumeFingerprint(failed), buildHarnessAbResumeFingerprint(passed));
  });

  test('rejects duplicate tasks and a pilot longer than the full run', () => {
    assert.throws(
      () => deterministicHarnessTaskOrder(['a', 'a'], 'seed'),
      /duplicate harness task id: a/,
    );
    assert.throws(
      () => buildHarnessAbRunManifest({ ...manifestInput(['a']), pilotTaskCount: 2 }),
      /pilotTaskCount must be between 1 and 1/,
    );
  });

  test('rejects an arbitrary 89-task source that is not Terminal-Bench 2.1', () => {
    assert.doesNotThrow(() =>
      assertTerminalBench21TaskSet([...TERMINAL_BENCH_2_1_TASK_IDS].reverse()),
    );
    assert.throws(
      () =>
        assertTerminalBench21TaskSet(
          Array.from({ length: 89 }, (_, index) => `task-${String(index + 1).padStart(2, '0')}`),
        ),
      /Terminal-Bench 2\.1 task set mismatch.*missing: adaptive-rejection-sampler.*unexpected: task-01/,
    );
  });

  test('rejects task contents outside the frozen official revision', () => {
    assert.doesNotThrow(() =>
      assertTerminalBench21TaskTreeFingerprint(TERMINAL_BENCH_2_1_TASK_TREE_FINGERPRINT),
    );
    assert.throws(
      () => assertTerminalBench21TaskTreeFingerprint(`sha256:${'0'.repeat(64)}`),
      /Terminal-Bench 2\.1 task tree fingerprint mismatch/,
    );
  });

  test('freezes the full DeepSWE leaderboard set as the superset of the discriminative subset', () => {
    assert.equal(DEEP_SWE_FULL_TASK_IDS.length, 113);
    assert.equal(new Set(DEEP_SWE_FULL_TASK_IDS).size, 113);
    for (const taskId of DEEP_SWE_SUBSET_30_TASK_IDS) {
      assert.ok(
        DEEP_SWE_FULL_TASK_IDS.includes(taskId),
        `subset task missing from full: ${taskId}`,
      );
    }

    assert.doesNotThrow(() => assertDeepSweFullTaskSet([...DEEP_SWE_FULL_TASK_IDS]));
    assert.throws(
      () => assertDeepSweFullTaskSet(DEEP_SWE_FULL_TASK_IDS.slice(1)),
      /DeepSWE full-113 task set mismatch.*missing: /,
    );
    assert.throws(
      () => assertDeepSweFullTaskSet([...DEEP_SWE_FULL_TASK_IDS, 'task-01']),
      /DeepSWE full-113 task set mismatch.*unexpected: task-01/,
    );

    assert.doesNotThrow(() =>
      assertDeepSweFullTaskTreeFingerprint(DEEP_SWE_FULL_TASK_TREE_FINGERPRINT),
    );
    assert.throws(
      () => assertDeepSweFullTaskTreeFingerprint(`sha256:${'0'.repeat(64)}`),
      /DeepSWE full-113 task tree fingerprint mismatch/,
    );
  });
});

function manifestInput(taskIds: readonly string[]) {
  return {
    benchmark: {
      dataset: 'terminal-bench' as const,
      version: '2.1' as const,
      revision: 'tb-revision',
      timeoutPolicy: 'task-native' as const,
      timeoutMultiplier: 1 as const,
      outerTimeoutGraceSec: 900,
    },
    taskIds,
    orderSeed: 'maka-glm-5.2-v1',
    pilotTaskCount: Math.min(30, taskIds.length),
    model: { provider: 'zai-coding-plan', id: 'glm-5.2', reasoningEffort: 'max' as const },
    pricing: {
      currency: 'USD' as const,
      unit: 'per_1m_tokens' as const,
      input: 1.4,
      cachedInput: 0.26,
      output: 4.4,
      source: 'z.ai-public-2026-07-13',
    },
    arms: [
      { id: 'maka' as const, version: '98e3846e', config: { continuation: true } },
      { id: 'opencode' as const, version: '1.17.18', config: { variant: 'max' } },
    ] as const,
    taskBudgetSec: null,
    harborTimeoutMs: null,
    subjectFingerprint: 'subject',
    taskSourceFingerprint: 'tasks',
    toolchainFingerprint: 'tools',
  };
}
