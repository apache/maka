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
 * This script only owns scheduling (parallel vs serial) and failure reporting.
 */

import { spawn as defaultSpawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

export function runWorkspace(dir, { repoRoot, spawn = defaultSpawn } = {}) {
  const name = nameForDir(dir);
  // Package-owned contract: each workspace declares how dist tests run.
  const command = 'npm run test:dist';
  const cwd = join(repoRoot, dir);
  console.log(`\n[${name}] start: ${command}`);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, { cwd, stdio: 'inherit', shell: true });
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
}

async function runSerial(dirs, options) {
  for (const dir of dirs) {
    await runWorkspace(dir, options);
  }
}

async function runParallel(dirs, options, concurrency) {
  const failures = [];
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < dirs.length) {
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
  const spawn = options.spawn ?? defaultSpawn;
  const workspaceDirs = options.workspaceDirs ?? loadWorkspaceDirs(repoRoot);
  const serialDirs = options.serialWorkspaceDirs ?? SERIAL_WORKSPACE_DIRS;
  const runOptions = { repoRoot, spawn };

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
  await runWorkspaceTests(options);
  console.log('\nAll workspace tests passed.');
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
