import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runWorkspaceTests } from './run-workspace-tests-parallel.mjs';

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

test('cancellation terminates active workspace process trees and starts no queued work', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'maka-workspace-runner-'));
  const workspace = join(repoRoot, 'packages', 'fixture');
  const pidFile = join(workspace, 'pids.json');
  let pids;
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(workspace, 'package.json'),
      JSON.stringify({
        private: true,
        scripts: { 'test:dist': 'node fixture.mjs' },
      }),
    );
    await writeFile(
      join(workspace, 'fixture.mjs'),
      [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "writeFileSync(new URL('./pids.json', import.meta.url), JSON.stringify({ parent: process.pid, child: child.pid }));",
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    );

    const controller = new AbortController();
    const running = runWorkspaceTests({
      repoRoot,
      workspaceDirs: ['packages/fixture', 'packages/never-started'],
      concurrency: 1,
      signal: controller.signal,
    });
    void running.catch(() => undefined);
    pids = await waitForPidFile(pidFile);
    controller.abort();

    await assert.rejects(running, /Workspace test run cancelled/);
    await Promise.all([waitForProcessExit(pids.parent), waitForProcessExit(pids.child)]);
  } finally {
    terminateProcess(pids?.parent);
    terminateProcess(pids?.child);
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('workspace timeout waits for process cleanup before reporting failure', async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 42;
  let terminationStarted = false;
  let terminationFinished = false;
  const spawn = () => child;
  const terminateWorkspace = async (target) => {
    assert.equal(target, child);
    terminationStarted = true;
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    terminationFinished = true;
  };

  await assert.rejects(
    () =>
      runWorkspaceTests({
        repoRoot: '/repo',
        workspaceDirs: ['packages/core'],
        workspaceTimeoutMs: 10,
        spawn,
        terminateWorkspace,
      }),
    /\[core\] timed out after 10ms/,
  );
  assert.equal(terminationStarted, true);
  assert.equal(terminationFinished, true);
});

async function waitForPidFile(path) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8'));
      if (Number.isSafeInteger(parsed.parent) && Number.isSafeInteger(parsed.child)) return parsed;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    await sleep(20);
  }
  throw new Error('workspace fixture did not publish its process ids');
}

async function waitForProcessExit(pid) {
  const deadline = Date.now() + 2_000;
  while (isProcessAlive(pid) && Date.now() < deadline) await sleep(20);
  assert.equal(isProcessAlive(pid), false, `process ${pid} remained alive`);
}

function terminateProcess(pid) {
  if (!pid || !isProcessAlive(pid)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
