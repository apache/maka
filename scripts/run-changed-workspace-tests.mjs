#!/usr/bin/env node
/**
 * Run unit tests only for workspaces selected by the CI impact planner for the
 * current git base…head delta (or explicit --base/--head / --full).
 *
 * Does not clean the monorepo. Builds selected workspaces incrementally when
 * --no-build is not set, then invokes the real parallel workspace test runner
 * with --workspaces.
 *
 * Usage:
 *   node scripts/run-changed-workspace-tests.mjs
 *   node scripts/run-changed-workspace-tests.mjs --base <sha> --head <sha>
 *   node scripts/run-changed-workspace-tests.mjs --full
 *   node scripts/run-changed-workspace-tests.mjs --no-build --workspaces packages/core
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkspaceGraph, planTests } from './ci-test-plan.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(scriptPath));
const parallelRunner = resolve(repoRoot, 'scripts/run-workspace-tests-parallel.mjs');

function parseArgs(args) {
  const parsed = {
    base: undefined,
    head: undefined,
    forceFull: false,
    noBuild: false,
    concurrency: 3,
    workspacesOverride: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--full') parsed.forceFull = true;
    else if (arg === '--no-build') parsed.noBuild = true;
    else if (arg === '--base') parsed.base = args[++index];
    else if (arg === '--head') parsed.head = args[++index];
    else if (arg === '--concurrency') parsed.concurrency = Number(args[++index]);
    else if (arg.startsWith('--concurrency=')) parsed.concurrency = Number(arg.slice(14));
    else if (arg === '--workspaces') {
      parsed.workspacesOverride = (args[++index] ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    } else if (arg.startsWith('--workspaces=')) {
      parsed.workspacesOverride = arg
        .slice(13)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (
    parsed.concurrency !== undefined &&
    (!Number.isInteger(parsed.concurrency) || parsed.concurrency <= 0)
  ) {
    throw new Error('--concurrency must be a positive integer');
  }
  return parsed;
}

function gitChangedFiles(base, head) {
  return execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMRD', base, head], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
}

function defaultBaseHead() {
  let base;
  try {
    base = execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    base = execFileSync('git', ['rev-parse', 'HEAD~1'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
  }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  return { base, head };
}

function npmBuildWorkspace(dir) {
  const name = JSON.parse(readFileSync(join(repoRoot, dir, 'package.json'), 'utf8')).name;
  // desktop unit path is build:test (main/preload/overlay), not full renderer.
  const script = dir === 'apps/desktop' ? 'build:test' : 'build';
  const result = spawnSync('npm', ['--workspace', name, 'run', script], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`Build failed for ${dir} (npm --workspace ${name} run ${script})`);
  }
}

function main(args) {
  const parsed = parseArgs(args);
  const graph = loadWorkspaceGraph(repoRoot);
  let workspaces;
  let planLabel;

  if (parsed.workspacesOverride) {
    const unknown = parsed.workspacesOverride.filter((dir) => !graph.dirs.includes(dir));
    if (unknown.length > 0) throw new Error(`Unknown workspace: ${unknown.join(', ')}`);
    workspaces = graph.dirs.filter((dir) => parsed.workspacesOverride.includes(dir));
    planLabel = `explicit workspaces: ${workspaces.join(', ') || '(none)'}`;
  } else {
    let changedFiles = [];
    if (parsed.forceFull) {
      workspaces = [...graph.dirs];
      planLabel = 'full';
    } else {
      const { base, head } =
        parsed.base && parsed.head ? { base: parsed.base, head: parsed.head } : defaultBaseHead();
      changedFiles = gitChangedFiles(base, head);
      const plan = planTests(changedFiles, { graph, forceFull: false });
      workspaces = plan.workspaces;
      planLabel = plan.full
        ? 'full'
        : changedFiles.length > 0
          ? changedFiles.join(', ')
          : 'no code changes';
      process.stderr.write(
        `test:changed plan: e2e=${plan.e2e} storybook=${plan.storybook} script_mode=${plan.scriptMode} workspaces=${workspaces.join(',') || '(none)'}\n`,
      );
    }
  }

  process.stderr.write(
    `test:changed selection (${planLabel}): ${workspaces.join(', ') || '(none)'}\n`,
  );

  if (workspaces.length === 0) {
    process.stderr.write('No workspaces selected; nothing to run.\n');
    return;
  }

  if (!parsed.noBuild) {
    // Build dependency order follows package.json workspaces order.
    for (const dir of graph.dirs) {
      if (!workspaces.includes(dir)) continue;
      npmBuildWorkspace(dir);
    }
  }

  const runnerArgs = [
    parallelRunner,
    `--concurrency=${parsed.concurrency}`,
    `--workspaces=${workspaces.join(',')}`,
  ];
  const result = spawnSync(process.execPath, runnerArgs, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
