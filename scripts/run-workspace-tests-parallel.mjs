#!/usr/bin/env node
/**
 * Run each workspace's `test:dist` script.
 *
 * Default: parallel batch, then serial-only workspaces.
 * `--serial`: every workspace in package.json workspaces order (CI).
 * `--concurrency N`: cap the parallel batch to avoid overloading small runners.
 * `--workspaces a,b`: run only the selected workspace paths.
 *
 * Each workspace owns how its dist tests run via package.json `test:dist`.
 * This script owns scheduling, bounded process residency, failure reporting, and
 * the temp namespace each workspace's tests run in.
 */

import { spawn as defaultSpawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = dirname(dirname(scriptPath));

// Headless is kept out of the concurrent batch after observed flakes when
// co-scheduled with other workspace suites. Isolation of HOME/XDG is already
// handled inside scripts/run-headless-tests.mjs; serial scheduling is extra
// conservatism for root orchestration, not a claim that its suite shares FS
// state with other packages.
export const SERIAL_WORKSPACE_DIRS = ['packages/headless'];
export const DEFAULT_WORKSPACE_TIMEOUT_MS = 15 * 60_000;

const PROCESS_TERMINATION_GRACE_MS = 1_000;
const PROCESS_TERMINATION_POLL_MS = 20;

export function loadWorkspaceDirs(repoRoot, readFile = readFileSync) {
  const rootPkg = JSON.parse(readFile(join(repoRoot, 'package.json'), 'utf8'));
  return Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : [];
}

export function partitionWorkspaces(workspaceDirs, serialDirs = SERIAL_WORKSPACE_DIRS) {
  const serialSet = new Set(serialDirs);
  return {
    parallel: workspaceDirs.filter((dir) => !serialSet.has(dir)),
    serial: workspaceDirs.filter((dir) => serialSet.has(dir)),
  };
}

export function nameForDir(dir) {
  return dir.replace(/^(packages|apps)\//, '');
}

export async function runWorkspace(
  dir,
  {
    repoRoot,
    spawn = defaultSpawn,
    signal,
    timeoutMs = DEFAULT_WORKSPACE_TIMEOUT_MS,
    terminateWorkspace = terminateWorkspaceProcess,
  } = {},
) {
  const name = nameForDir(dir);
  if (signal?.aborted) throw workspaceRunCancelledError();
  // Package-owned contract: each workspace declares how dist tests run.
  const command = 'npm run test:dist';
  const cwd = join(repoRoot, dir);
  // Suites reach the temp directory through hundreds of `mkdtemp(tmpdir(), …)`
  // calls across every package. Owning the namespace here means the whole tree
  // goes away when the workspace process does, instead of each call site having
  // to book-keep its own removal — a rule nothing enforces, and which years of
  // accumulated `maka-*` directories in the user's tmpdir show is not kept.
  const tempRoot = await mkdtemp(join(tmpdir(), `maka-test-${tempRootSlug(name)}-`));
  console.log(`\n[${name}] start: ${command}`);
  const child = spawn(command, {
    cwd,
    stdio: 'inherit',
    shell: true,
    detached: process.platform !== 'win32',
    // TMPDIR is what os.tmpdir() reads on POSIX, TMP/TEMP on Windows.
    env: { ...process.env, TMPDIR: tempRoot, TMP: tempRoot, TEMP: tempRoot },
  });
  const completion = new Promise((resolvePromise, reject) => {
    let settled = false;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      fn();
    };
    child.on('error', (err) => {
      settle(() => reject(new Error(`[${name}] spawn failed: ${err.message}`)));
    });
    child.on('close', (code) => {
      settle(() => {
        if (code === 0) {
          console.log(`[${name}] passed`);
          resolvePromise(name);
        } else {
          reject(new Error(`[${name}] failed with code ${code}`));
        }
      });
    });
  });

  let stopReason;
  let requestStop;
  const stopRequested = new Promise((_resolve, reject) => {
    requestStop = (reason) => {
      if (stopReason) return;
      stopReason = reason;
      reject(reason);
    };
  });
  const onAbort = () => requestStop(workspaceRunCancelledError());
  signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = Number.isFinite(timeoutMs)
    ? setTimeout(
        () => requestStop(new Error(`[${name}] timed out after ${timeoutMs}ms`)),
        timeoutMs,
      )
    : undefined;
  if (signal?.aborted) onAbort();

  try {
    return await Promise.race([completion, stopRequested]);
  } catch (error) {
    if (error === stopReason) {
      try {
        await terminateWorkspace(child);
      } catch (terminationError) {
        throw new AggregateError(
          [error, terminationError],
          `[${name}] failed to terminate its test process tree`,
        );
      }
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
    // Runs after terminateWorkspace, so the process tree is already down and
    // nothing is still writing into the tree being removed.
    await rm(tempRoot, { recursive: true, force: true });
  }
}

/** Workspace name reduced to what is safe in a temp directory prefix. */
function tempRootSlug(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '-');
}

async function runSerial(dirs, options) {
  for (const dir of dirs) {
    if (options.signal?.aborted) throw workspaceRunCancelledError();
    await runWorkspace(dir, options);
  }
}

async function runParallel(dirs, options, concurrency) {
  const failures = [];
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < dirs.length) {
      if (options.signal?.aborted) return;
      const dir = dirs[nextIndex++];
      try {
        await runWorkspace(dir, options);
      } catch (error) {
        failures.push(error);
      }
    }
  }
  const workerCount = Math.min(dirs.length, concurrency);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (options.signal?.aborted) throw workspaceRunCancelledError();
  if (failures.length > 0) {
    const messages = failures.map((error) => error?.message ?? String(error));
    throw new Error(messages.join('\n'));
  }
}

export async function runWorkspaceTests(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const serialFlag = options.serial ?? false;
  const concurrency = options.concurrency ?? Number.POSITIVE_INFINITY;
  if (!(concurrency > 0)) throw new Error('concurrency must be greater than zero');
  const workspaceTimeoutMs = options.workspaceTimeoutMs ?? DEFAULT_WORKSPACE_TIMEOUT_MS;
  if (!(workspaceTimeoutMs > 0)) {
    throw new Error('workspaceTimeoutMs must be greater than zero');
  }
  const spawn = options.spawn ?? defaultSpawn;
  const workspaceDirs = options.workspaceDirs ?? loadWorkspaceDirs(repoRoot);
  const serialDirs = options.serialWorkspaceDirs ?? SERIAL_WORKSPACE_DIRS;
  const runOptions = {
    repoRoot,
    spawn,
    signal: options.signal,
    timeoutMs: workspaceTimeoutMs,
    terminateWorkspace: options.terminateWorkspace,
  };

  if (serialFlag) {
    await runSerial(workspaceDirs, runOptions);
  } else {
    const { parallel, serial } = partitionWorkspaces(workspaceDirs, serialDirs);
    await runParallel(parallel, runOptions, concurrency);
    await runSerial(serial, runOptions);
  }
}

export function parseCliArgs(args, availableDirs) {
  let concurrency = Number.POSITIVE_INFINITY;
  let serial = false;
  const requestedDirs = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--serial') serial = true;
    else if (arg === '--concurrency') concurrency = Number(args[++index]);
    else if (arg.startsWith('--concurrency=')) concurrency = Number(arg.slice(14));
    else if (arg === '--workspaces') requestedDirs.push(...(args[++index] ?? '').split(','));
    else if (arg.startsWith('--workspaces=')) requestedDirs.push(...arg.slice(13).split(','));
    else if (arg === '--workspace') requestedDirs.push(args[++index] ?? '');
    else if (arg.startsWith('--workspace=')) requestedDirs.push(arg.slice(12));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (
    concurrency !== Number.POSITIVE_INFINITY &&
    (!Number.isInteger(concurrency) || concurrency <= 0)
  ) {
    throw new Error('--concurrency must be a positive integer');
  }
  const selected = [...new Set(requestedDirs.filter(Boolean))];
  const unknown = selected.filter((dir) => !availableDirs.includes(dir));
  if (unknown.length > 0) throw new Error(`Unknown workspace: ${unknown.join(', ')}`);
  return {
    concurrency,
    serial,
    workspaceDirs:
      selected.length > 0 ? availableDirs.filter((dir) => selected.includes(dir)) : availableDirs,
  };
}

async function main(args) {
  const availableDirs = loadWorkspaceDirs(defaultRepoRoot);
  const options = parseCliArgs(args, availableDirs);
  const controller = new AbortController();
  let receivedSignal;
  const interrupt = () => {
    receivedSignal = 'SIGINT';
    controller.abort();
  };
  const terminate = () => {
    receivedSignal = 'SIGTERM';
    controller.abort();
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  try {
    await runWorkspaceTests({ ...options, signal: controller.signal });
    console.log('\nAll workspace tests passed.');
  } catch (error) {
    if (!receivedSignal) throw error;
    console.error(`Workspace test run cancelled by ${receivedSignal}.`);
    process.exitCode = receivedSignal === 'SIGINT' ? 130 : 143;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

function workspaceRunCancelledError() {
  return new Error('Workspace test run cancelled');
}

async function terminateWorkspaceProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    child.kill('SIGKILL');
    return;
  }
  if (process.platform === 'win32') {
    await terminateWindowsProcessTree(pid, child);
    return;
  }

  signalProcessGroup(pid, 'SIGTERM');
  if (await waitForProcessGroupExit(pid, PROCESS_TERMINATION_GRACE_MS)) return;
  signalProcessGroup(pid, 'SIGKILL');
  if (await waitForProcessGroupExit(pid, PROCESS_TERMINATION_GRACE_MS)) return;
  throw new Error(`workspace test process group ${pid} did not exit`);
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isMissingProcessError(error)) throw error;
  }
}

async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (isProcessGroupAlive(pid) && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, PROCESS_TERMINATION_POLL_MS));
  }
  return !isProcessGroupAlive(pid);
}

function isProcessGroupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (isMissingProcessError(error)) return false;
    throw error;
  }
}

function isMissingProcessError(error) {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH';
}

async function terminateWindowsProcessTree(pid, child) {
  await new Promise((resolvePromise) => {
    const killer = defaultSpawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    };
    killer.once('error', () => {
      child.kill('SIGKILL');
      settle();
    });
    killer.once('close', settle);
  });
}
