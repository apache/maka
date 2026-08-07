import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { BackendRegistry, FakeBackend } from '@maka/runtime';
import type { Config, Task } from '../contracts.js';
import { runMatrix, type ExperimentSpec } from '../matrix.js';

const registerFakeBackend = (registry: BackendRegistry): void => {
  registry.register(
    'fake',
    (ctx) => new FakeBackend({ sessionId: ctx.sessionId, header: ctx.header, store: ctx.store }),
  );
};

const config = (id: string): Config => ({
  id,
  backend: 'fake',
  llmConnectionSlug: 'fake',
  model: 'fake-model',
});

describe('runMatrix', () => {
  test('runs the full Config × Task cross product and scores each cell', async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), 'maka-headless-mx-fx-'));
    const storageRoot = await mkdtemp(join(tmpdir(), 'maka-headless-mx-store-'));
    try {
      await writeFile(join(fixtureDir, 'marker.txt'), 'x', 'utf8');
      const passTask: Task = {
        id: 'pass',
        instruction: 'go',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f marker.txt', protectedPaths: [] },
      };
      const failTask: Task = {
        id: 'fail',
        instruction: 'go',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f nope.txt', protectedPaths: [] },
      };
      const spec: ExperimentSpec = {
        configs: [config('a'), config('b')],
        tasks: [passTask, failTask],
      };

      const seen: string[] = [];
      const records = await runMatrix(
        spec,
        { storageRoot, registerBackends: registerFakeBackend },
        (r) => seen.push(`${r.taskId}:${r.configId}`),
      );

      assert.equal(records.length, 4); // 2 tasks × 2 configs
      assert.equal(seen.length, 4); // onResult fired per cell
      for (const r of records) {
        assert.equal(r.passed, r.taskId === 'pass');
        assert.equal(r.status, 'completed');
      }
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
      await rm(storageRoot, { recursive: true, force: true });
    }
  });

  test('records a thrown run as a failed cell instead of aborting the matrix', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'maka-headless-mx-err-'));
    try {
      // workspaceDir does not exist → prepareWorkspace throws → failed cell.
      const badTask: Task = {
        id: 'bad',
        instruction: 'go',
        workspaceDir: join(storageRoot, 'does-not-exist'),
        verification: { command: 'true', protectedPaths: [] },
      };
      const records = await runMatrix(
        { configs: [config('a')], tasks: [badTask] },
        { storageRoot, registerBackends: registerFakeBackend },
      );
      assert.equal(records.length, 1);
      assert.equal(records[0]?.status, 'failed');
      assert.equal(records[0]?.passed, false);
      assert.ok(records[0]?.error, 'expected an error message on the failed cell');
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });
});
