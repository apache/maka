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
  'scripts/run-workspace-tests-parallel.mjs',
]);

const TYPECHECK_ONLY_FILES = new Set([
  'biome.jsonc',
  'components.json',
  'knip.json',
  'tsconfig.base.json',
  'tsconfig.lib.json',
]);

const DEDICATED_WORKSPACE_LANES = new Set(['packages/runtime-host', 'packages/headless']);

// Scripts the Electron e2e job runs. Editing one of these changes what that
// job verifies, so it has to re-run — a unit test on the runner is not
// evidence that the run it drives still works.
const E2E_DRIVING_SCRIPTS = new Set(['scripts/audit-alignment.mjs']);

// Scripts / paths that can break Storybook without touching product ship
// gates. Storybook is a catalog harness, not the product: typecheck already
// typechecks stories and checks annotations, unit/e2e cover product behavior.
// Running build+smoke on every desktop/ui PR taxes CI for almost no unique
// signal — only the catalog and its wiring need this job.
const STORYBOOK_DRIVING_SCRIPTS = new Set(['scripts/storybook-visual-smoke.mjs']);

// .storybook/preview.tsx imports THEME_PALETTES from this module. Narrower
// than "any packages/core change".
const STORYBOOK_CORE_SETTINGS = 'packages/core/src/settings.ts';

function isStorybookPath(path) {
  if (STORYBOOK_DRIVING_SCRIPTS.has(path) || path === STORYBOOK_CORE_SETTINGS) return true;
  if (path === 'apps/desktop/.storybook' || path.startsWith('apps/desktop/.storybook/'))
    return true;
  if (path === 'apps/desktop/stories' || path.startsWith('apps/desktop/stories/')) return true;
  // packages/ui also ships its own story tree (see .storybook/main.ts).
  if (path === 'packages/ui/stories' || path.startsWith('packages/ui/stories/')) return true;
  return false;
}

const EXTENDED_SCRIPT_FILES = new Set([
  'scripts/cu-process-restart-e2e.mjs',
  'scripts/cu-process-restart-harness.test.mjs',
  'scripts/cu-provider-matrix.mjs',
  'scripts/cu-provider-matrix.test.mjs',
  'scripts/cu-real-model-fixture.mjs',
  'scripts/cu-real-model-launcher.mjs',
  'scripts/cu-real-model-launcher.test.mjs',
  'scripts/macos-arm64-release.test.mjs',
  'scripts/measure-session-bundle.mjs',
  'scripts/measure-session-bundle.test.mjs',
  'scripts/package-macos-arm64.mjs',
  'scripts/npm-spawn.mjs',
  'scripts/package-windows-x64.mjs',
  // Shared by both platform verifiers, so a change here reaches the macOS
  // release path even when nothing macOS-specific was touched.
  'scripts/verify-packaged-app.mjs',
  'scripts/verify-macos-arm64-dmg.mjs',
  'scripts/verify-windows-x64.mjs',
  'scripts/windows-x64-release.test.mjs',
]);

// The release config is loaded only by the release workflow, so nothing else in
// CI would notice an option electron-builder rejects.
const RELEASE_CONFIG_FILES = new Set(['apps/desktop/electron-builder.config.mjs']);

const STORAGE_STRESS_FILES = new Set([
  'packages/storage/src/agent-run-store.ts',
  'packages/storage/src/git-workspace-service.ts',
  'packages/storage/src/runtime-event-invariants.ts',
  'packages/storage/src/root-authority.ts',
  'packages/storage/src/__tests__/agent-run-store.test.ts',
  'packages/storage/src/__tests__/git-workspace-service.test.ts',
  'packages/storage/src/__tests__/root-authority.test.ts',
  'packages/storage/src/__tests__/fixtures/git-workspace-service-crash-child.ts',
  'packages/storage/src/__tests__/fixtures/root-lock-holder.ts',
  'packages/storage/src/__tests__/fixtures/root-resolver.ts',
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

function workspaceLanes(workspaces) {
  return {
    headless: workspaces.includes('packages/headless'),
    runtimeHost: workspaces.includes('packages/runtime-host'),
    standardWorkspaces: workspaces.filter((dir) => !DEDICATED_WORKSPACE_LANES.has(dir)),
  };
}

export function planTests(changedFiles, options = {}) {
  const graph = options.graph ?? loadWorkspaceGraph(options.repoRoot);
  const files = [...new Set(changedFiles.map(normalizePath).filter(Boolean))];
  const forceFull = options.forceFull ?? false;
  const full = forceFull || files.some((path) => FULL_SUITE_FILES.has(path));
  if (full) {
    const workspaces = [...graph.dirs];
    return {
      code: true,
      e2e: true,
      full: true,
      runtimeSandbox: graph.dirs.includes('packages/cli'),
      scriptMode: 'full',
      // A complete functional suite is still the default release/main gate.
      // Stress multipliers and native child-process lock probes run only when
      // their owning storage seam changes; making --full imply stress turned
      // every unrelated merge into a 10K-chunk pressure run.
      storageStress: false,
      storybook: true,
      workspaces,
      ...workspaceLanes(workspaces),
    };
  }

  const directWorkspaces = new Set();
  let code = false;
  let scriptMode = 'none';
  let unknownCode = false;
  for (const path of files) {
    if (RELEASE_CONFIG_FILES.has(path)) {
      code = true;
      directWorkspaces.add('apps/desktop');
      if (scriptMode === 'none') scriptMode = 'fast';
      continue;
    }
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
  const storageStress = files.some((path) => STORAGE_STRESS_FILES.has(path));

  return {
    code,
    // Electron E2E + alignment audit. Direct desktop/ui only — a storage or
    // runtime change must not drag cold Electron boots.
    //
    // Scripts that DRIVE the suite belong here too. `scripts/**` only sets
    // scriptMode, so without this a change to the auditor itself was verified
    // by its unit tests and never by the run it orchestrates.
    e2e:
      directWorkspaces.has('apps/desktop') ||
      directWorkspaces.has('packages/ui') ||
      files.some((path) => E2E_DRIVING_SCRIPTS.has(path)),
    full: false,
    // packages/cli/src/__tests__/runtime-bootstrap.test.ts executes real sandboxed
    // shell tools, so the bubblewrap + user-namespace setup is required whenever
    // the cli workspace runs in the dependency closure, not only for direct
    // cli/runtime edits (e.g. a storage-only change still selects cli via runtime).
    runtimeSandbox: workspaces.includes('packages/cli'),
    scriptMode,
    storageStress,
    // Storybook build + smoke: catalog/harness only. Not every desktop/ui/core
    // PR — product ship gates are typecheck, unit, and Electron e2e. See
    // isStorybookPath.
    storybook: files.some((path) => isStorybookPath(path)),
    workspaces,
    ...workspaceLanes(workspaces),
  };
}

export function formatGitHubOutputs(plan) {
  return [
    `code=${plan.code}`,
    `e2e=${plan.e2e}`,
    `full=${plan.full}`,
    `headless=${plan.headless}`,
    `runtime_host=${plan.runtimeHost}`,
    `runtime_sandbox=${plan.runtimeSandbox}`,
    `script_mode=${plan.scriptMode}`,
    `storage_stress=${plan.storageStress}`,
    `storybook=${plan.storybook}`,
    `unit=${plan.workspaces.length > 0}`,
    `standard_workspaces=${plan.standardWorkspaces.join(',')}`,
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
