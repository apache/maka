import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { buildRunManifestFingerprint } from '../ab-manifest.js';
import {
  auditHarnessOracleRegistry,
  HarnessOracleAuditExecutionError,
  buildHarnessOracleEnvironmentFingerprint,
  buildHarnessOracleAuditTasks,
  buildHarnessOracleRegistrySnapshot,
  discoverHarnessOracleBaseImages,
  loadHarnessOracleRegistrySnapshot,
  pinHarnessOracleTaskEnvironment,
  planHarnessOracleRegistryAudit,
  resolveHarnessOracleAnnotations,
} from '../harness-oracle-registry.js';
import {
  buildHarnessOracleExecutionPolicyFingerprint,
  HARBOR_ORACLE_MAX_ATTEMPTS,
} from '../harness-oracle-policy.js';

describe('harness Oracle evidence registry', () => {
  test('binds qualification to controlled Oracle policy sources instead of host runtime versions', () => {
    const original = buildHarnessOracleExecutionPolicyFingerprint({
      verifierImplementationSource: 'verifier-v1',
      composeImplementationSource: 'services:\n  main:\n    platform: linux/amd64\n',
    });
    const sameOnAnotherHost = buildHarnessOracleExecutionPolicyFingerprint({
      verifierImplementationSource: 'verifier-v1',
      composeImplementationSource: 'services:\n  main:\n    platform: linux/amd64\n',
    });
    const changedVerifier = buildHarnessOracleExecutionPolicyFingerprint({
      verifierImplementationSource: 'verifier-v2',
      composeImplementationSource: 'services:\n  main:\n    platform: linux/amd64\n',
    });

    assert.equal(sameOnAnotherHost, original);
    assert.notEqual(changedVerifier, original);
  });

  test('audits the complete corpus and builds one matching snapshot entry per task', async () => {
    const calls: string[] = [];
    const tasks = ['a', 'b', 'c'].map((taskId) => ({
      task: { id: taskId, path: `/tasks/${taskId}` },
      identity: {
        taskFingerprint: `sha256:task-${taskId}`,
        executionPolicyFingerprint: 'sha256:verifier',
        environmentFingerprint: 'sha256:environment',
      },
    }));
    const provenance = oracleExecutionProvenance('123');
    const input = {
      tasks,
      provenance,
      runOracle: async (task: { id: string }) => {
        calls.push(task.id);
        return task.id === 'b'
          ? { outcome: 'failed' as const, reward: 0, attempts: 1 }
          : { outcome: 'passed' as const, reward: 1, attempts: 1 };
      },
    };

    const baseline = await auditHarnessOracleRegistry(input);
    assert.deepEqual(calls, ['a', 'b', 'c']);
    assert.deepEqual(baseline.snapshot.entries[0]?.executionProvenance, provenance);
    assert.deepEqual(
      baseline.snapshot.entries.map(({ taskId, oracle }) => ({ taskId, outcome: oracle?.outcome })),
      [
        { taskId: 'a', outcome: 'passed' },
        { taskId: 'b', outcome: 'failed' },
        { taskId: 'c', outcome: 'passed' },
      ],
    );

    const merged = buildHarnessOracleRegistrySnapshot({
      tasks: tasks.map(({ task, identity }) => ({ taskId: task.id, identity })),
      entries: [...baseline.snapshot.entries].reverse(),
      provenance: { ...input.provenance, runId: '124' },
    });
    assert.deepEqual(
      merged.entries.map((entry) => entry.taskId),
      ['a', 'b', 'c'],
    );
    assert.throws(
      () =>
        buildHarnessOracleRegistrySnapshot({
          tasks: tasks.map(({ task, identity }) => ({ taskId: task.id, identity })),
          entries: baseline.snapshot.entries.slice(0, 2),
          provenance: input.provenance,
        }),
      /exactly one matching entry per task/,
    );
    assert.throws(
      () =>
        buildHarnessOracleRegistrySnapshot({
          tasks: tasks.map(({ task, identity }) => ({
            taskId: task.id,
            identity:
              task.id === 'b'
                ? { ...identity, executionPolicyFingerprint: 'sha256:runtime-v2' }
                : identity,
          })),
          entries: baseline.snapshot.entries,
          provenance: input.provenance,
        }),
      /exactly one matching entry per task/,
    );
  });

  test('plans only the task whose qualification identity changed', async () => {
    const calls: string[] = [];
    const tasks = ['a', 'b'].map((taskId) => ({
      task: { id: taskId, path: `/tasks/${taskId}` },
      identity: {
        taskFingerprint: `sha256:task-${taskId}`,
        executionPolicyFingerprint: 'sha256:verifier',
        environmentFingerprint: 'sha256:environment',
      },
    }));
    const runOracle = async (task: { id: string }) => {
      calls.push(task.id);
      return { outcome: 'passed' as const, reward: 1, attempts: 1 };
    };
    const provenance = oracleExecutionProvenance('123');
    const baseline = await auditHarnessOracleRegistry({ tasks, provenance, runOracle });

    const changedTasks = tasks.map((item) =>
      item.task.id === 'b'
        ? {
            ...item,
            identity: { ...item.identity, environmentFingerprint: 'sha256:environment-v2' },
          }
        : item,
    );

    const plan = planHarnessOracleRegistryAudit(changedTasks, baseline.snapshot);
    assert.deepEqual(plan.missingTaskIds, ['b']);
    assert.deepEqual(
      plan.reusedEntries.map((entry) => entry.taskId),
      ['a'],
    );
  });

  test('rejects registry entries outside the planned task set', async () => {
    const auditTask = (taskId: string) => ({
      task: { id: taskId, path: `/tasks/${taskId}` },
      identity: {
        taskFingerprint: `sha256:task-${taskId}`,
        executionPolicyFingerprint: 'sha256:verifier',
        environmentFingerprint: 'sha256:environment',
      },
    });
    const provenance = oracleExecutionProvenance('123');
    const planned = [auditTask('a')];
    const baseline = await auditHarnessOracleRegistry({
      tasks: planned,
      provenance,
      runOracle: async () => ({ outcome: 'passed', reward: 1, attempts: 1 }),
    });
    const extra = await auditHarnessOracleRegistry({
      tasks: [auditTask('b')],
      provenance,
      runOracle: async () => ({ outcome: 'passed', reward: 1, attempts: 1 }),
    });

    assert.throws(
      () =>
        buildHarnessOracleRegistrySnapshot({
          tasks: planned.map(({ task, identity }) => ({ taskId: task.id, identity })),
          entries: [...baseline.snapshot.entries, ...extra.snapshot.entries],
          provenance,
        }),
      /exactly one matching entry per task/,
    );
  });

  test('rejects a tampered snapshot before reusing its entries', async () => {
    const tasks = [
      {
        task: { id: 'a', path: '/tasks/a' },
        identity: {
          taskFingerprint: 'sha256:task-a',
          executionPolicyFingerprint: 'sha256:verifier',
          environmentFingerprint: 'sha256:environment',
        },
      },
    ];
    const provenance = oracleExecutionProvenance('123');
    const baseline = await auditHarnessOracleRegistry({
      tasks,
      provenance,
      runOracle: async () => ({ outcome: 'passed', reward: 1, attempts: 1 }),
    });
    const tampered = structuredClone(baseline.snapshot);
    tampered.entries[0]!.oracle!.reward = 0;

    assert.throws(
      () => planHarnessOracleRegistryAudit(tasks, tampered),
      /registry snapshot fingerprint is invalid/,
    );
  });

  test('records infrastructure failure separately and continues auditing later tasks', async () => {
    const calls: string[] = [];
    const tasks = ['a', 'b', 'c'].map((taskId) => ({
      task: { id: taskId, path: `/tasks/${taskId}` },
      identity: {
        taskFingerprint: `sha256:task-${taskId}`,
        executionPolicyFingerprint: 'sha256:verifier',
        environmentFingerprint: 'sha256:environment',
      },
    }));

    const audit = await auditHarnessOracleRegistry({
      tasks,
      provenance: oracleExecutionProvenance('123'),
      runOracle: async (task) => {
        calls.push(task.id);
        if (task.id === 'b') throw new HarnessOracleAuditExecutionError('infra_failed');
        return { outcome: 'passed', reward: 1, attempts: 1 };
      },
    });

    assert.deepEqual(calls, ['a', 'b', 'c']);
    assert.deepEqual(
      audit.snapshot.entries.map(({ taskId, execution }) => ({ taskId, execution })),
      [
        { taskId: 'a', execution: { status: 'completed' } },
        { taskId: 'b', execution: { status: 'infra_failed' } },
        { taskId: 'c', execution: { status: 'completed' } },
      ],
    );
    assert.equal(audit.snapshot.entries[1]?.oracle, null);
  });

  test('does not publish an infra entry for an unexpected audit implementation error', async () => {
    await assert.rejects(
      auditHarnessOracleRegistry({
        tasks: [
          {
            task: { id: 'a', path: '/tasks/a' },
            identity: {
              taskFingerprint: 'sha256:task-a',
              executionPolicyFingerprint: 'sha256:verifier',
              environmentFingerprint: 'sha256:environment',
            },
          },
        ],
        provenance: oracleExecutionProvenance('123'),
        runOracle: async () => {
          throw new Error('result parser bug');
        },
      }),
      /result parser bug/,
    );
  });

  test('records a typed execution timeout without treating it as an Oracle failure', async () => {
    const audit = await auditHarnessOracleRegistry({
      tasks: [
        {
          task: { id: 'a', path: '/tasks/a' },
          identity: {
            taskFingerprint: 'sha256:task-a',
            executionPolicyFingerprint: 'sha256:verifier',
            environmentFingerprint: 'sha256:environment',
          },
        },
      ],
      provenance: oracleExecutionProvenance('123'),
      runOracle: async () => {
        throw new HarnessOracleAuditExecutionError('timed_out');
      },
    });

    assert.deepEqual(audit.snapshot.entries[0]?.execution, { status: 'timed_out' });
    assert.equal(audit.snapshot.entries[0]?.oracle, null);
  });

  test('rejects self-checksummed entries with impossible Oracle result semantics', async () => {
    const tasks = [
      {
        task: { id: 'a', path: '/tasks/a' },
        identity: {
          taskFingerprint: 'sha256:task-a',
          executionPolicyFingerprint: 'sha256:verifier',
          environmentFingerprint: 'sha256:environment',
        },
      },
    ];
    const provenance = oracleExecutionProvenance('123');
    const baseline = await auditHarnessOracleRegistry({
      tasks,
      provenance,
      runOracle: async () => ({ outcome: 'passed', reward: 1, attempts: 1 }),
    });
    const invalid = structuredClone(baseline.snapshot);
    invalid.entries[0]!.oracle!.reward = 0;
    invalid.entries[0]!.fingerprint = buildRunManifestFingerprint(
      withoutFingerprint(invalid.entries[0]!),
    );
    invalid.fingerprint = buildRunManifestFingerprint(withoutFingerprint(invalid));

    assert.throws(
      () => planHarnessOracleRegistryAudit(tasks, invalid),
      /registry entry is malformed/,
    );

    const excessiveAttempts = structuredClone(baseline.snapshot);
    excessiveAttempts.entries[0]!.oracle!.attempts = HARBOR_ORACLE_MAX_ATTEMPTS + 1;
    excessiveAttempts.entries[0]!.fingerprint = buildRunManifestFingerprint(
      withoutFingerprint(excessiveAttempts.entries[0]!),
    );
    excessiveAttempts.fingerprint = buildRunManifestFingerprint(
      withoutFingerprint(excessiveAttempts),
    );
    assert.throws(
      () => planHarnessOracleRegistryAudit(tasks, excessiveAttempts),
      /registry entry is malformed/,
    );
  });

  test('resolves advisory states without returning a task-selection decision', async () => {
    const tasks = ['passed', 'failed', 'timed', 'infra', 'stale', 'missing'].map((taskId) => ({
      task: { id: taskId, path: `/tasks/${taskId}` },
      identity: {
        taskFingerprint: `sha256:task-${taskId}`,
        executionPolicyFingerprint: 'sha256:verifier',
        environmentFingerprint: 'sha256:environment',
      },
    }));
    const baseline = await auditHarnessOracleRegistry({
      tasks: tasks.slice(0, 5),
      provenance: oracleExecutionProvenance('123'),
      runOracle: async (task) => {
        if (task.id === 'failed') return { outcome: 'failed', reward: 0, attempts: 1 };
        if (task.id === 'timed') return { outcome: 'candidate_timeout', reward: 0, attempts: 1 };
        if (task.id === 'infra') throw new HarnessOracleAuditExecutionError('infra_failed');
        return { outcome: 'passed', reward: 1, attempts: 1 };
      },
    });
    const currentTasks = tasks.map((item) =>
      item.task.id === 'stale'
        ? {
            ...item,
            identity: { ...item.identity, executionPolicyFingerprint: 'sha256:runtime-v2' },
          }
        : item,
    );

    const annotations = resolveHarnessOracleAnnotations(currentTasks, baseline.snapshot);

    assert.deepEqual(
      annotations.map(({ taskId, state }) => ({ taskId, state })),
      [
        { taskId: 'passed', state: 'passed' },
        { taskId: 'failed', state: 'failed' },
        { taskId: 'timed', state: 'timed_out' },
        { taskId: 'infra', state: 'infra_failed' },
        { taskId: 'stale', state: 'stale' },
        { taskId: 'missing', state: 'missing' },
      ],
    );
    assert.equal('selectedTaskIds' in annotations, false);
  });

  test('downloads a pinned registry snapshot and rejects an unexpected fingerprint', async () => {
    const baseline = await auditHarnessOracleRegistry({
      tasks: [
        {
          task: { id: 'a', path: '/tasks/a' },
          identity: {
            taskFingerprint: 'sha256:task-a',
            executionPolicyFingerprint: 'sha256:verifier',
            environmentFingerprint: 'sha256:environment',
          },
        },
      ],
      provenance: oracleExecutionProvenance('123'),
      runOracle: async () => ({ outcome: 'passed', reward: 1, attempts: 1 }),
    });
    const urls: string[] = [];
    const fetchSnapshot = async (url: string | URL) => {
      urls.push(String(url));
      return new Response(JSON.stringify(baseline.snapshot), { status: 200 });
    };

    const loaded = await loadHarnessOracleRegistrySnapshot({
      url: 'https://github.com/maka-agent/maka-agent/releases/download/oracle-evidence/snapshot.json',
      expectedFingerprint: baseline.snapshot.fingerprint,
      fetch: fetchSnapshot,
    });
    assert.equal(loaded.fingerprint, baseline.snapshot.fingerprint);
    assert.deepEqual(urls, [
      'https://github.com/maka-agent/maka-agent/releases/download/oracle-evidence/snapshot.json',
    ]);

    await assert.rejects(
      loadHarnessOracleRegistrySnapshot({
        url: 'https://example.invalid/snapshot.json',
        expectedFingerprint: `sha256:${'0'.repeat(64)}`,
        fetch: fetchSnapshot,
      }),
      /registry snapshot fingerprint does not match the pinned profile/,
    );
  });

  test('binds resolved container image digests and platform into environment identity', () => {
    const input = {
      environment: 'docker',
      platform: 'linux/amd64',
      baseImages: [
        { reference: 'python:3.13-slim-bookworm', digest: `sha256:${'b'.repeat(64)}` },
        { reference: 'ubuntu:24.04', digest: `sha256:${'c'.repeat(64)}` },
      ],
    } as const;

    const original = buildHarnessOracleEnvironmentFingerprint(input);
    const changedDigest = buildHarnessOracleEnvironmentFingerprint({
      ...input,
      baseImages: [
        input.baseImages[0]!,
        { ...input.baseImages[1]!, digest: `sha256:${'d'.repeat(64)}` },
      ],
    });
    const changedPlatform = buildHarnessOracleEnvironmentFingerprint({
      ...input,
      platform: 'linux/arm64',
    });

    assert.match(original, /^sha256:[a-f0-9]{64}$/);
    assert.notEqual(changedDigest, original);
    assert.notEqual(changedPlatform, original);
  });

  test('discovers unique base images from a task environment Dockerfile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-oracle-images-'));
    try {
      const environment = join(root, 'environment');
      await mkdir(environment, { recursive: true });
      await writeFile(
        join(environment, 'Dockerfile'),
        [
          'FROM ubuntu:24.04 AS build',
          'RUN true',
          'FROM python:3.13-slim-bookworm',
          'COPY --from=build /tmp/x /tmp/x',
          'FROM ubuntu:24.04 AS duplicate',
          '',
        ].join('\n'),
        'utf8',
      );

      assert.deepEqual(await discoverHarnessOracleBaseImages({ id: 'a', path: root }), [
        'python:3.13-slim-bookworm',
        'ubuntu:24.04',
      ]);
      const resolvedReferences: string[] = [];
      const [auditTask] = await buildHarnessOracleAuditTasks({
        tasks: [{ id: 'a', path: root }],
        executionPolicyFingerprint: `sha256:${'d'.repeat(64)}`,
        environment: 'docker',
        platform: 'linux/amd64',
        resolveBaseImageDigest: async (reference) => {
          resolvedReferences.push(reference);
          return reference.startsWith('python')
            ? `sha256:${'f'.repeat(64)}`
            : `sha256:${'1'.repeat(64)}`;
        },
      });
      assert.deepEqual(resolvedReferences, ['python:3.13-slim-bookworm', 'ubuntu:24.04']);
      assert.match(auditTask?.identity.taskFingerprint ?? '', /^sha256:[a-f0-9]{64}$/);
      assert.equal(auditTask?.identity.executionPolicyFingerprint, `sha256:${'d'.repeat(64)}`);
      assert.equal('runtimeFingerprint' in (auditTask?.identity ?? {}), false);
      assert.match(auditTask?.identity.environmentFingerprint ?? '', /^sha256:[a-f0-9]{64}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('executes Oracle against a task copy whose base images are pinned by digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-oracle-pinned-task-'));
    try {
      const taskRoot = join(root, 'source');
      await mkdir(join(taskRoot, 'environment'), { recursive: true });
      await writeFile(
        join(taskRoot, 'environment', 'Dockerfile'),
        ['FROM ubuntu:24.04 AS build', 'RUN true', 'FROM python:3.13-slim-bookworm', ''].join('\n'),
        'utf8',
      );

      const pinned = await pinHarnessOracleTaskEnvironment(
        { id: 'task-a', path: taskRoot },
        [
          { reference: 'ubuntu:24.04', digest: `sha256:${'a'.repeat(64)}` },
          { reference: 'python:3.13-slim-bookworm', digest: `sha256:${'b'.repeat(64)}` },
        ],
        join(root, 'pinned'),
      );

      assert.equal(
        await readFile(join(taskRoot, 'environment', 'Dockerfile'), 'utf8'),
        ['FROM ubuntu:24.04 AS build', 'RUN true', 'FROM python:3.13-slim-bookworm', ''].join('\n'),
      );
      assert.equal(
        await readFile(join(pinned.path, 'environment', 'Dockerfile'), 'utf8'),
        [
          `FROM ubuntu:24.04@sha256:${'a'.repeat(64)} AS build`,
          'RUN true',
          `FROM python:3.13-slim-bookworm@sha256:${'b'.repeat(64)}`,
          '',
        ].join('\n'),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function withoutFingerprint<T extends { fingerprint: string }>(value: T): Omit<T, 'fingerprint'> {
  const { fingerprint: _fingerprint, ...body } = value;
  return body;
}

function oracleExecutionProvenance(runId: string) {
  return {
    issuer: 'github-actions' as const,
    repository: 'maka-agent/maka-agent',
    workflow: 'Oracle evidence audit',
    commitSha: 'abc123',
    runId,
    runAttempt: '1',
    runtime: {
      nodeVersion: 'v22.0.0',
      harborVersion: 'harbor 0.13.2',
      dockerVersion: 'Docker version 28.0.0',
      dockerBuildxVersion: 'github.com/docker/buildx v0.22.0',
    },
  };
}
