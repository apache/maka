#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = dirname(dirname(scriptPath));

const FULL_SUITE_FILES = new Set([
  '.github/workflows/ci.yml',
  'package-lock.json',
  'package.json',
  'scripts/ci-test-plan.mjs',
  'scripts/ci-test-plan.test.mjs',
  'scripts/run-workspace-tests-parallel.mjs',
  'scripts/run-workspace-tests-parallel.test.mjs',
]);

const TYPECHECK_ONLY_FILES = new Set([
  'biome.jsonc',
  'components.json',
  'knip.json',
  'tsconfig.base.json',
  'tsconfig.lib.json',
]);

const EXTENDED_SCRIPT_FILES = new Set([
  'scripts/check-cua-driver-bundle.mjs',
  'scripts/cu-provider-matrix.mjs',
  'scripts/cu-provider-matrix.test.mjs',
  'scripts/cu-real-model-fixture.mjs',
  'scripts/cu-real-model-launcher.mjs',
  'scripts/cu-real-model-launcher.test.mjs',
  'scripts/cua-driver-provenance.test.mjs',
  'scripts/macos-arm64-release.test.mjs',
  'scripts/measure-session-bundle.mjs',
  'scripts/measure-session-bundle.test.mjs',
  'scripts/package-macos-arm64.mjs',
  'scripts/prepare-cua-driver.mjs',
  'scripts/verify-macos-arm64-dmg.mjs',
]);

function normalizePath(path) {
  return path.split(sep).join('/').replace(/^\.\//, '');
}

function isDocumentation(path) {
  return (
    path === 'LICENSE' || path === 'NOTICE' || path.endsWith('.md') || path.startsWith('docs/')
  );
}

export function loadWorkspaceGraph(repoRoot = defaultRepoRoot, readFile = readFileSync) {
  const rootPackage = JSON.parse(readFile(join(repoRoot, 'package.json'), 'utf8'));
  const dirs = rootPackage.workspaces ?? [];
  const entries = dirs.map((dir) => {
    const manifest = JSON.parse(readFile(join(repoRoot, dir, 'package.json'), 'utf8'));
    const dependencyNames = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);
    return { dir, name: manifest.name, dependencyNames };
  });
  const dirByName = new Map(entries.map(({ dir, name }) => [name, dir]));
  const dependents = new Map(dirs.map((dir) => [dir, new Set()]));
  for (const entry of entries) {
    for (const name of entry.dependencyNames) {
      const dependencyDir = dirByName.get(name);
      if (dependencyDir) dependents.get(dependencyDir)?.add(entry.dir);
    }
  }
  return { dirs, dependents };
}

export function reverseDependencyClosure(seedDirs, graph) {
  const selected = new Set(seedDirs);
  const pending = [...seedDirs];
  while (pending.length > 0) {
    const dependency = pending.shift();
    for (const dependent of graph.dependents.get(dependency) ?? []) {
      if (selected.has(dependent)) continue;
      selected.add(dependent);
      pending.push(dependent);
    }
  }
  return graph.dirs.filter((dir) => selected.has(dir));
}

export function planTests(changedFiles, options = {}) {
  const graph = options.graph ?? loadWorkspaceGraph(options.repoRoot);
  const files = [...new Set(changedFiles.map(normalizePath).filter(Boolean))];
  const forceFull = options.forceFull ?? false;
  const full = forceFull || files.some((path) => FULL_SUITE_FILES.has(path));
  if (full) {
    return {
      code: true,
      e2e: true,
      full: true,
      headless: graph.dirs.includes('packages/headless'),
      runtimeSandbox: graph.dirs.includes('packages/cli'),
      scriptMode: 'full',
      storageStress: graph.dirs.includes('packages/storage'),
      workspaces: [...graph.dirs],
    };
  }

  const directWorkspaces = new Set();
  let code = false;
  let scriptMode = 'none';
  let unknownCode = false;
  for (const path of files) {
    const workspace = graph.dirs.find((dir) => path === dir || path.startsWith(`${dir}/`));
    if (workspace) {
      code = true;
      directWorkspaces.add(workspace);
      continue;
    }
    if (path.startsWith('scripts/')) {
      code = true;
      scriptMode = EXTENDED_SCRIPT_FILES.has(path)
        ? 'extended'
        : scriptMode === 'none'
          ? 'fast'
          : scriptMode;
      continue;
    }
    if (path.startsWith('skills/')) {
      code = true;
      directWorkspaces.add('apps/desktop');
      continue;
    }
    if (TYPECHECK_ONLY_FILES.has(path)) {
      code = true;
      continue;
    }
    if (path.startsWith('.github/') || isDocumentation(path)) continue;
    code = true;
    unknownCode = true;
  }

  if (unknownCode) {
    return planTests([], { graph, forceFull: true });
  }

  const workspaces = reverseDependencyClosure(directWorkspaces, graph);
  const storageStress = files.some(
    (path) =>
      path === 'packages/storage/src/agent-run-store.ts' ||
      path === 'packages/storage/src/runtime-event-invariants.ts' ||
      path === 'packages/storage/src/__tests__/agent-run-store.test.ts',
  );

  return {
    code,
    e2e: directWorkspaces.has('apps/desktop') || directWorkspaces.has('packages/ui'),
    full: false,
    headless: workspaces.includes('packages/headless'),
    // packages/cli/src/__tests__/runtime-bootstrap.test.ts executes real sandboxed
    // shell tools, so the bubblewrap + user-namespace setup is required whenever
    // the cli workspace runs in the dependency closure, not only for direct
    // cli/runtime edits (e.g. a storage-only change still selects cli via runtime).
    runtimeSandbox: workspaces.includes('packages/cli'),
    scriptMode,
    storageStress,
    workspaces,
  };
}

export function formatGitHubOutputs(plan) {
  return [
    `code=${plan.code}`,
    `e2e=${plan.e2e}`,
    `full=${plan.full}`,
    `headless=${plan.headless}`,
    `runtime_sandbox=${plan.runtimeSandbox}`,
    `script_mode=${plan.scriptMode}`,
    `storage_stress=${plan.storageStress}`,
    `unit=${plan.workspaces.length > 0}`,
    `workspaces=${plan.workspaces.join(',')}`,
  ].join('\n');
}

function parseArgs(args) {
  const parsed = { base: undefined, forceFull: false, head: undefined };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--full') parsed.forceFull = true;
    else if (arg === '--base') parsed.base = args[++index];
    else if (arg === '--head') parsed.head = args[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!parsed.forceFull && (!parsed.base || !parsed.head)) {
    throw new Error('Expected --full or both --base <sha> and --head <sha>');
  }
  return parsed;
}

function main(args) {
  const parsed = parseArgs(args);
  const changedFiles = parsed.forceFull
    ? []
    : execFileSync(
        'git',
        ['diff', '--name-only', '--diff-filter=ACMRD', parsed.base, parsed.head],
        {
          cwd: defaultRepoRoot,
          encoding: 'utf8',
        },
      )
        .split('\n')
        .filter(Boolean);
  const plan = planTests(changedFiles, { forceFull: parsed.forceFull });
  process.stdout.write(`${formatGitHubOutputs(plan)}\n`);
  process.stderr.write(
    `CI test plan: ${plan.full ? 'full' : changedFiles.join(', ') || 'no code changes'}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
