import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  buildAbRunManifest,
  buildRunManifestFingerprint,
  canonicalJson,
  ensureAbRunManifest,
  readAbRunManifest,
} from '../ab-manifest.js';
import { sha256 } from './helpers/hash-fixture.js';

describe('buildAbRunManifest', () => {
  test('records generic A/B arm identities for non-prompt experiments', () => {
    const manifest = buildAbRunManifest({
      experimentKind: 'tools',
      arms: [
        {
          id: 'tools-off',
          kind: 'tools',
          fingerprint: sha256('tools-off'),
          metadata: { toolProfile: 'standard' },
        },
        {
          id: 'tools-on',
          kind: 'tools',
          fingerprint: sha256('tools-on'),
          metadata: { toolProfile: 'standard-plus-new-tool' },
        },
      ],
      taskBudgetSec: 30 * 60,
      harborTimeoutMs: 35 * 60 * 1000,
      subjectFingerprint: 'subject:path=/repo;maka-head=abc123;dirty=false',
      taskSourceFingerprint: 'tasks:path=/cache/tasks;selected=task-a:/cache/tasks/a',
      toolchainFingerprint: sha256('c'),
      evaluationTaskIds: ['task-a'],
      reps: 3,
      candidateLimit: null,
      maxConcurrency: 16,
    });

    assert.equal(manifest.experimentKind, 'tools');
    assert.deepEqual(
      manifest.arms.map((arm) => `${arm.kind}:${arm.id}`),
      ['tools:tools-off', 'tools:tools-on'],
    );
    assert.match(manifest.fingerprint, /^sha256:[a-f0-9]{64}$/);
  });

  test('rejects a stored manifest whose body no longer matches its fingerprint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-ab-manifest-'));
    try {
      const manifest = buildAbRunManifest({
        experimentKind: 'runtime',
        arms: [
          { id: 'off', kind: 'runtime', fingerprint: sha256('off') },
          { id: 'on', kind: 'runtime', fingerprint: sha256('on') },
        ],
        taskBudgetSec: 1800,
        harborTimeoutMs: 2_100_000,
        subjectFingerprint: sha256('subject'),
        taskSourceFingerprint: sha256('tasks'),
        toolchainFingerprint: sha256('toolchain'),
        evaluationTaskIds: ['task-a'],
        reps: 1,
        candidateLimit: null,
        maxConcurrency: 1,
      });
      const path = join(dir, 'manifest.json');
      await writeFile(path, `${JSON.stringify({ ...manifest, taskBudgetSec: 60 })}\n`, 'utf8');

      await assert.rejects(
        ensureAbRunManifest(path, manifest),
        /stored A\/B run manifest fingerprint is invalid/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('reads and validates an existing immutable manifest without constructing a replacement', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-ab-manifest-read-'));
    try {
      const manifest = buildAbRunManifest({
        experimentKind: 'runtime',
        metadata: {
          qualification: {
            agent: 'oracle',
            selectedTaskIds: ['task-a'],
          },
        },
        arms: [
          { id: 'off', kind: 'runtime', fingerprint: sha256('off') },
          { id: 'on', kind: 'runtime', fingerprint: sha256('on') },
        ],
        taskBudgetSec: 1800,
        harborTimeoutMs: 2_100_000,
        subjectFingerprint: sha256('subject'),
        taskSourceFingerprint: sha256('tasks'),
        toolchainFingerprint: sha256('toolchain'),
        evaluationTaskIds: ['task-a'],
        reps: 1,
        candidateLimit: null,
        maxConcurrency: 1,
      });
      const path = join(dir, 'manifest.json');
      await writeFile(path, `${JSON.stringify(manifest)}\n`, 'utf8');

      assert.deepEqual(await readAbRunManifest(path), manifest);
      assert.deepEqual(manifest.metadata, {
        qualification: { agent: 'oracle', selectedTaskIds: ['task-a'] },
      });
      assert.equal(await readAbRunManifest(join(dir, 'missing.json')), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('atomically chooses one canonical manifest when two processes create the same run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-ab-manifest-race-'));
    try {
      const base = {
        experimentKind: 'runtime' as const,
        arms: [
          { id: 'off', kind: 'runtime' as const, fingerprint: sha256('off') },
          { id: 'on', kind: 'runtime' as const, fingerprint: sha256('on') },
        ] as const,
        taskBudgetSec: 1800,
        harborTimeoutMs: 2_100_000,
        subjectFingerprint: sha256('subject'),
        taskSourceFingerprint: sha256('tasks'),
        toolchainFingerprint: sha256('toolchain'),
        evaluationTaskIds: ['task-a'],
        reps: 2,
        candidateLimit: null,
        maxConcurrency: 1,
      };
      const flash = buildAbRunManifest({ ...base, observedCostStopUsd: 20 });
      const pro = buildAbRunManifest({ ...base, observedCostStopUsd: 30 });
      const path = join(dir, 'manifest.json');

      const results = await Promise.allSettled([
        ensureAbRunManifest(path, flash),
        ensureAbRunManifest(path, pro),
      ]);

      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
      const stored = JSON.parse(await readFile(path, 'utf8'));
      assert.equal(
        stored.fingerprint === flash.fingerprint || stored.fingerprint === pro.fingerprint,
        true,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// `canonicalJson` and `buildRunManifestFingerprint` are the load-bearing
// determinism contract for A/B resume identities. These behavior tests pin the
// invariants (per #1403): key-order independence, `undefined`-field dropping,
// array-order preservation, and fingerprint stability — rather than asserting on
// the exact serialized bytes, which would over-constrain the implementation.
describe('canonicalJson', () => {
  test('drops undefined object fields so {a:1,b:undefined} equals {a:1}', () => {
    assert.equal(canonicalJson({ a: 1, b: undefined }), canonicalJson({ a: 1 }));
    assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
  });

  test('is independent of object key insertion order', () => {
    assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
  });

  test('preserves array order (order is semantically meaningful)', () => {
    assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]');
    assert.notEqual(canonicalJson([3, 1, 2]), canonicalJson([1, 2, 3]));
  });

  test('recursively sorts keys in nested objects', () => {
    assert.equal(canonicalJson({ outer: { z: 1, a: 2 } }), '{"outer":{"a":2,"z":1}}');
  });

  test('serializes scalars via JSON.stringify', () => {
    assert.equal(canonicalJson(null), 'null');
    assert.equal(canonicalJson('hi'), '"hi"');
    assert.equal(canonicalJson(42), '42');
    assert.equal(canonicalJson(true), 'true');
  });
});

describe('buildRunManifestFingerprint', () => {
  test('produces the same fingerprint for logically equal payloads regardless of key order', () => {
    assert.equal(
      buildRunManifestFingerprint({ b: 2, a: 1 }),
      buildRunManifestFingerprint({ a: 1, b: 2 }),
    );
  });

  test('is stable across repeated calls (idempotent)', () => {
    const payload = { arms: [{ id: 'on' }, { id: 'off' }], reps: 3 };
    assert.equal(buildRunManifestFingerprint(payload), buildRunManifestFingerprint(payload));
  });

  test('ignores undefined fields when computing the fingerprint', () => {
    assert.equal(
      buildRunManifestFingerprint({ a: 1, b: undefined }),
      buildRunManifestFingerprint({ a: 1 }),
    );
  });

  // Regression guard for the harness-oracle-registry divergence: the registry
  // path recomputes a fingerprint over entry/snapshot bodies and compares it to
  // a stored value. Before unification, harness-oracle-registry.ts carried a
  // local canonicalJson copy that omitted the undefined-field filter, so a body
  // containing an undefined-valued nested field would hash to invalid JSON
  // ({"field":undefined}) and never match the canonical computation. This pins
  // the contract through buildRunManifestFingerprint using a registry-shaped
  // payload with a nested undefined field.
  test('registry-shaped body with a nested undefined field matches the all-defined body', () => {
    const allDefined = {
      schemaVersion: 1,
      taskId: 'task-a',
      identity: { taskFingerprint: 'sha256:aaa', executionPolicyFingerprint: 'sha256:bbb' },
      execution: { status: 'completed' },
      oracle: { outcome: 'passed', reward: 1, attempts: 1 },
    };
    const withUndefined = {
      ...allDefined,
      identity: { ...allDefined.identity, evidenceFingerprint: undefined },
    };
    assert.equal(
      buildRunManifestFingerprint(withUndefined),
      buildRunManifestFingerprint(allDefined),
    );
  });

  test('yields a sha256:<64 lowercase hex> string', () => {
    assert.match(buildRunManifestFingerprint({ a: 1 }), /^sha256:[a-f0-9]{64}$/);
  });
});
