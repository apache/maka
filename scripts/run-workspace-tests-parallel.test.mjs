import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { parseCliArgs, runWorkspaceTests } from './run-workspace-tests-parallel.mjs';

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

test('CLI selection rejects invalid concurrency and unknown workspaces', () => {
  const available = ['packages/core', 'packages/headless', 'apps/desktop'];
  assert.throws(() => parseCliArgs(['--concurrency=0'], available), /positive integer/);
  assert.throws(
    () => parseCliArgs(['--workspace=packages/missing'], available),
    /Unknown workspace/,
  );
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
