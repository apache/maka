import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  SERIAL_WORKSPACE_DIRS,
  loadWorkspaceDirs,
  nameForDir,
  parseCliArgs,
  partitionWorkspaces,
  runWorkspaceTests,
} from './run-workspace-tests-parallel.mjs';

function makeSpawn(plan) {
  const calls = [];
  const spawn = (command, options) => {
    const child = new EventEmitter();
    const index = calls.length;
    calls.push({ command, cwd: options.cwd, shell: options.shell });
    queueMicrotask(() => {
      const step = plan[index] ?? { close: 0 };
      if (step.error) {
        child.emit(
          'error',
          step.error instanceof Error ? step.error : new Error(String(step.error)),
        );
        return;
      }
      child.emit('close', step.close ?? 0);
    });
    return child;
  };
  return { spawn, calls };
}

test('loadWorkspaceDirs reads root package.json workspaces', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maka-ws-load-'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ workspaces: ['packages/core', 'packages/headless', 'apps/desktop'] }),
  );
  assert.deepEqual(loadWorkspaceDirs(dir), ['packages/core', 'packages/headless', 'apps/desktop']);
});

test('partitionWorkspaces keeps serial packages out of the parallel batch', () => {
  const { parallel, serial } = partitionWorkspaces(
    ['packages/core', 'packages/headless', 'apps/desktop', 'packages/ui'],
    SERIAL_WORKSPACE_DIRS,
  );
  assert.deepEqual(parallel, ['packages/core', 'apps/desktop', 'packages/ui']);
  assert.deepEqual(serial, ['packages/headless']);
});

test('nameForDir strips packages/ and apps/ prefixes', () => {
  assert.equal(nameForDir('packages/headless'), 'headless');
  assert.equal(nameForDir('apps/desktop'), 'desktop');
});

test('CLI selection preserves root workspace order and validates bounded concurrency', () => {
  const available = ['packages/core', 'packages/headless', 'apps/desktop'];
  assert.deepEqual(
    parseCliArgs(['--concurrency=2', '--workspaces=apps/desktop,packages/core'], available),
    {
      concurrency: 2,
      serial: false,
      workspaceDirs: ['packages/core', 'apps/desktop'],
    },
  );
  assert.throws(() => parseCliArgs(['--concurrency=0'], available), /positive integer/);
  assert.throws(
    () => parseCliArgs(['--workspace=packages/missing'], available),
    /Unknown workspace/,
  );
});

test('serial mode runs every workspace via package-owned npm run test:dist', async () => {
  const repoRoot = '/repo';
  const workspaceDirs = ['packages/core', 'packages/headless', 'apps/desktop'];
  const { spawn, calls } = makeSpawn(workspaceDirs.map(() => ({ close: 0 })));

  await runWorkspaceTests({
    repoRoot,
    workspaceDirs,
    serial: true,
    spawn,
  });

  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.command, 'npm run test:dist');
    assert.equal(call.shell, true);
  }
  assert.deepEqual(
    calls.map((c) => c.cwd),
    [
      join(repoRoot, 'packages/core'),
      join(repoRoot, 'packages/headless'),
      join(repoRoot, 'apps/desktop'),
    ],
  );
});

test('parallel mode runs non-serial workspaces first, then serial ones', async () => {
  const repoRoot = '/repo';
  const workspaceDirs = ['packages/core', 'packages/headless', 'packages/ui'];
  const order = [];
  const { spawn, calls } = makeSpawn([{ close: 0 }, { close: 0 }, { close: 0 }]);
  const trackingSpawn = (command, options) => {
    order.push(options.cwd);
    return spawn(command, options);
  };

  await runWorkspaceTests({
    repoRoot,
    workspaceDirs,
    serial: false,
    spawn: trackingSpawn,
  });

  assert.equal(calls.length, 3);
  // headless must not be in the first concurrent wave's completion-before-serial
  // guarantee: all parallel finish before serial starts. Order among parallel
  // may interleave; serial headless is last among recorded close-driven starts
  // only if we track start order — start order for parallel is simultaneous.
  // Assert set membership instead of full order for the parallel wave.
  const parallelCwds = new Set([join(repoRoot, 'packages/core'), join(repoRoot, 'packages/ui')]);
  assert.equal(parallelCwds.has(order[0]) && parallelCwds.has(order[1]), true);
  assert.equal(order[2], join(repoRoot, 'packages/headless'));
});

test('parallel mode aggregates every failed workspace name', async () => {
  const repoRoot = '/repo';
  const workspaceDirs = ['packages/core', 'packages/ui', 'packages/headless'];
  const { spawn } = makeSpawn([{ close: 1 }, { close: 2 }, { close: 0 }]);

  await assert.rejects(
    () =>
      runWorkspaceTests({
        repoRoot,
        workspaceDirs,
        serial: false,
        spawn,
      }),
    (err) => {
      assert.match(err.message, /\[core\] failed with code 1/);
      assert.match(err.message, /\[ui\] failed with code 2/);
      return true;
    },
  );
});

test('bounded parallel mode never exceeds its configured concurrency', async () => {
  const repoRoot = '/repo';
  const workspaceDirs = ['packages/core', 'packages/ui', 'apps/desktop'];
  let active = 0;
  let maxActive = 0;
  const spawn = () => {
    const child = new EventEmitter();
    active += 1;
    maxActive = Math.max(maxActive, active);
    setImmediate(() => {
      active -= 1;
      child.emit('close', 0);
    });
    return child;
  };

  await runWorkspaceTests({ repoRoot, workspaceDirs, concurrency: 2, spawn });

  assert.equal(maxActive, 2);
});

test('spawn errors are reported with the workspace name', async () => {
  const repoRoot = '/repo';
  const { spawn } = makeSpawn([{ error: new Error('ENOENT') }]);

  await assert.rejects(
    () =>
      runWorkspaceTests({
        repoRoot,
        workspaceDirs: ['packages/core'],
        serial: true,
        spawn,
      }),
    /\[core\] spawn failed: ENOENT/,
  );
});
