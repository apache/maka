import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import {
  assertFrozenTaskSet,
  assertFrozenTaskTreeFingerprint,
  buildHarnessAbResumeFingerprint,
  buildHarnessAbRunManifest,
  deterministicHarnessTaskOrder,
  HARNESS_MAKA_CONTEXT_BUDGET,
} from '../harness-ab-manifest.js';
import { BENCHMARK_IDENTITY, MOUNTED_DIST_DIR } from './benchmark-identity.js';

const TERMINAL_BENCH_2_1 = BENCHMARK_IDENTITY.terminalBench21;
const DEEP_SWE_FULL = BENCHMARK_IDENTITY.deepSwe.full113;

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
    const expected = TERMINAL_BENCH_2_1.taskIds;
    assert.equal(expected.length, 89);
    assert.doesNotThrow(() =>
      assertFrozenTaskSet('Terminal-Bench 2.1', expected, [...expected].reverse()),
    );
    assert.throws(
      () =>
        assertFrozenTaskSet(
          'Terminal-Bench 2.1',
          expected,
          Array.from({ length: 89 }, (_, index) => `task-${String(index + 1).padStart(2, '0')}`),
        ),
      /Terminal-Bench 2\.1 task set mismatch.*missing: adaptive-rejection-sampler.*unexpected: task-01/,
    );
  });

  test('rejects task contents outside the frozen official revision', () => {
    const expected = TERMINAL_BENCH_2_1.taskTreeFingerprint;
    assert.doesNotThrow(() =>
      assertFrozenTaskTreeFingerprint('Terminal-Bench 2.1', expected, expected),
    );
    assert.throws(
      () =>
        assertFrozenTaskTreeFingerprint('Terminal-Bench 2.1', expected, `sha256:${'0'.repeat(64)}`),
      /Terminal-Bench 2\.1 task tree fingerprint mismatch/,
    );
  });

  test('keeps the benchmark identity out of the build output a graded arm mounts', () => {
    // The whole reason this data does not live in `src`. An arm executes this
    // package's `dist`, so a revision, an upstream URL or a task-tree
    // fingerprint compiled into it is readable from inside the container being
    // scored — which is how the #1970 run turned a task into a lookup at the
    // pinned revision. The path-level mount checks in `agent-repo-mount.test.ts`
    // cannot see this: they inspect declared paths, never what the files
    // contain.
    //
    // Two boundaries, because they are two different things. The retrieval keys
    // — revision, upstream URL, tree fingerprint — must be absent from every
    // mounted file, compiled tests included. A single task id is not a
    // retrieval key (the arm is handed its own task id anyway), so those are
    // held out of the shipped modules, where a complete list could accumulate,
    // rather than out of test fixtures that name one task each.
    const retrievalKeys = [
      TERMINAL_BENCH_2_1.revision,
      TERMINAL_BENCH_2_1.upstreamRepositoryUrl,
      TERMINAL_BENCH_2_1.taskTreeFingerprint,
      BENCHMARK_IDENTITY.deepSwe.revision,
      BENCHMARK_IDENTITY.deepSwe.upstreamRepositoryUrl,
      BENCHMARK_IDENTITY.deepSwe.subset30.taskTreeFingerprint,
      DEEP_SWE_FULL.taskTreeFingerprint,
    ];
    const taskIds = [...TERMINAL_BENCH_2_1.taskIds, ...DEEP_SWE_FULL.taskIds];

    // Every mounted file, not every compiled module: a source map would carry
    // the whole of `src` in `sourcesContent` and walk straight past a filter
    // that only knows about `.js`.
    const compiled = readdirSync(MOUNTED_DIST_DIR, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name));
    assert.ok(compiled.length > 0, 'the build output was not found');

    for (const file of compiled) {
      const text = readFileSync(file, 'utf8');
      for (const needle of retrievalKeys) {
        assert.ok(!text.includes(needle), `${file} names the benchmark (${needle})`);
      }
      if (file.includes(`${sep}__tests__${sep}`)) continue;
      for (const needle of taskIds) {
        assert.ok(!text.includes(needle), `${file} names a benchmark task (${needle})`);
      }
    }
  });

  test('freezes the full DeepSWE leaderboard set as the superset of the discriminative subset', () => {
    const full = DEEP_SWE_FULL.taskIds;
    assert.equal(full.length, 113);
    assert.equal(new Set(full).size, 113);
    for (const taskId of BENCHMARK_IDENTITY.deepSwe.subset30.taskIds) {
      assert.ok(full.includes(taskId), `subset task missing from full: ${taskId}`);
    }

    assert.doesNotThrow(() => assertFrozenTaskSet('DeepSWE full-113', full, [...full]));
    assert.throws(
      () => assertFrozenTaskSet('DeepSWE full-113', full, full.slice(1)),
      /DeepSWE full-113 task set mismatch.*missing: /,
    );
    assert.throws(
      () => assertFrozenTaskSet('DeepSWE full-113', full, [...full, 'task-01']),
      /DeepSWE full-113 task set mismatch.*unexpected: task-01/,
    );

    const fingerprint = DEEP_SWE_FULL.taskTreeFingerprint;
    assert.doesNotThrow(() =>
      assertFrozenTaskTreeFingerprint('DeepSWE full-113', fingerprint, fingerprint),
    );
    assert.throws(
      () =>
        assertFrozenTaskTreeFingerprint(
          'DeepSWE full-113',
          fingerprint,
          `sha256:${'0'.repeat(64)}`,
        ),
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
