import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  captureMakaRuntimeArtifacts,
  MAKA_RUNTIME_ARTIFACT_PATH,
  MAKA_SUBJECT_STDERR_PATH,
  MAKA_SUBJECT_STDOUT_PATH,
} from '../maka-artifacts.js';
import { createMakaSubjectAdapter } from '../maka-subject.js';
import type { ExperimentCell } from '../experiment.js';
import type { SubjectExecutionContext } from '../runner.js';

test('runtime artifact capture includes committed WAL rows in a standalone database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-artifacts-'));
  const stateRoot = join(root, 'state');
  const destinationRoot = join(root, 'artifacts');
  await mkdir(stateRoot);
  const database = new DatabaseSync(join(stateRoot, 'runtime.sqlite'));
  try {
    database.exec('PRAGMA journal_mode=WAL');
    database.exec('PRAGMA wal_autocheckpoint=0');
    database.exec('CREATE TABLE evidence (value TEXT NOT NULL)');
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    database.prepare('INSERT INTO evidence (value) VALUES (?)').run('from-wal');
    await writeFile(join(stateRoot, 'runtime-host-candidate.log'), 'candidate-ready\n', {
      mode: 0o600,
    });

    const manifest = await captureMakaRuntimeArtifacts({
      stateRoot,
      destinationRoot,
      reason: 'signal',
      now: () => 42,
    });

    assert.equal(manifest.capturedAt, 42);
    assert.equal(manifest.reason, 'signal');
    const snapshot = new DatabaseSync(join(destinationRoot, 'runtime.sqlite'), { readOnly: true });
    try {
      assert.equal(snapshot.prepare('SELECT value FROM evidence').get()?.value, 'from-wal');
    } finally {
      snapshot.close();
    }
    await assert.rejects(stat(join(destinationRoot, 'runtime.sqlite-wal')), { code: 'ENOENT' });
    await assert.rejects(stat(join(destinationRoot, 'runtime.sqlite-shm')), { code: 'ENOENT' });
    assert.equal(
      await readFile(join(destinationRoot, 'runtime-host-candidate.log'), 'utf8'),
      'candidate-ready\n',
    );
    const databaseFile = manifest.files.find(({ path }) => path === 'runtime.sqlite');
    assert.ok(databaseFile);
    assert.equal(
      databaseFile.sha256,
      `sha256:${createHash('sha256')
        .update(await readFile(join(destinationRoot, 'runtime.sqlite')))
        .digest('hex')}`,
    );
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Maka reports the runtime and process artifacts for settled and timed-out executions', async () => {
  for (const termination of ['exited', 'framework_timeout'] as const) {
    const result = await createMakaSubjectAdapter().execute({
      cell: makaCell(),
      context: {
        cwd: '/app',
        taskInput: 'solve',
        metadata: {},
        execute: async (input: Parameters<SubjectExecutionContext['execute']>[0]) => {
          const payload = JSON.parse(Buffer.from(input.args[1] ?? '', 'base64url').toString()) as {
            artifactRoot: string;
            execution: { executionId: string };
          };
          assert.equal(payload.artifactRoot, MAKA_RUNTIME_ARTIFACT_PATH);
          return {
            termination,
            exitCode: termination === 'exited' ? 0 : 124,
            stdout: JSON.stringify({
              executionId: payload.execution.executionId,
              kind: 'settled',
              status: termination === 'exited' ? 'completed' : 'cancelled',
              usage: {
                inputTokens: 1,
                outputTokens: 2,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                reasoningTokens: 0,
                totalTokens: 3,
              },
              costUsd: null,
            }),
            diagnostic: { category: 'none' },
          };
        },
      },
    });
    assert.equal(result.status, termination === 'exited' ? 'completed' : 'failed');
    assert.deepEqual(
      result.artifacts.map(({ kind, path }) => ({ kind, path })),
      [
        { kind: 'maka-runtime-state', path: MAKA_RUNTIME_ARTIFACT_PATH },
        { kind: 'subject-stdout', path: MAKA_SUBJECT_STDOUT_PATH },
        { kind: 'subject-stderr', path: MAKA_SUBJECT_STDERR_PATH },
      ],
    );
  }
});

function makaCell(): ExperimentCell {
  return {
    id: 'task::1::maka',
    experimentId: 'experiment',
    benchmark: { id: 'benchmark', version: 'revision', config: {} },
    executor: { kind: 'harbor', config: {} },
    subject: {
      id: 'maka',
      kind: 'maka',
      credentials: ['DEEPSEEK_API_KEY'],
      config: {
        nodePath: '/opt/node',
        shimPath: '/opt/maka-subject.js',
        runtimeHostsPath: '/tmp/maka-runtime-hosts',
        baseUrl: 'https://api.deepseek.com',
        connectionSlug: 'env-deepseek',
        model: 'deepseek-v4-flash',
        thinkingLevel: 'max',
        permissionMode: 'bypass',
        collaborationMode: 'agent',
        orchestrationMode: 'default',
        hostSettlementTimeoutMs: 120_000,
        toolProfile: 'headless-coding-v1',
      },
    },
    task: { id: 'task', input: 'solve', config: {} },
    repetition: 1,
    budget: { timeoutMultiplier: 1, maxSteps: 100 },
    verifier: { reward: 'reward' },
  };
}
