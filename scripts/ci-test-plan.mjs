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

const WINDOWS_BASELINE_FILES = new Set([
  '.github/workflows/windows-baseline.yml',
  'scripts/windows-process-identity.ps1',
  'scripts/windows-smoke.mjs',
]);

/**
 * Storage seams that exercise Windows-specific path, lock, crash, or NTFS
 * behavior. Catalog/session SQLite unit changes stay on Linux; only these
 * paths open the Windows storage gate lane.
 */
const WINDOWS_STORAGE_SENSITIVE_PATH =
  /(^|\/)(root-authority|managed-dependency-environment|managed-workspace|git-workspace-service|git-worktree|workspace-root|workspace-identity|marker-file|write-queue|artifact-writer-lock|sqlite-recovery-concurrency|sqlite-runtime-crash|sqlite-long-term-memory-crash)([./_-]|$)/u;

export function isWindowsStorageSensitivePath(path) {
  const normalized = normalizePath(path);
  if (normalized === 'packages/storage/package.json') return true;
  if (!normalized.startsWith('packages/storage/')) return false;
  return WINDOWS_STORAGE_SENSITIVE_PATH.test(normalized);
}

const DEDICATED_WORKSPACE_LANES = new Set(['packages/runtime-host']);

// Scripts the Electron e2e job runs. Editing one of these changes what that
// job verifies, so it has to re-run — a unit test on the runner is not
// evidence that the run it drives still works.
const E2E_DRIVING_SCRIPTS = new Set(['scripts/audit-alignment.mjs']);

// Scripts / paths that can break the built Storybook catalog. Product stories
// mount the UI package and desktop renderer, so runtime export/render changes
// there belong to this surface even when no story file changes. Main-process
// and e2e-only desktop changes stay outside it.
const STORYBOOK_DRIVING_SCRIPTS = new Set(['scripts/storybook-visual-smoke.mjs']);

// .storybook/preview.tsx imports THEME_PALETTES from this module. Narrower
// than "any packages/core change".
const STORYBOOK_CORE_SETTINGS = 'packages/core/src/settings.ts';

function isStorybookCatalogPath(path) {
  if (path === 'apps/desktop/.storybook' || path.startsWith('apps/desktop/.storybook/'))
    return true;
  if (path === 'apps/desktop/stories' || path.startsWith('apps/desktop/stories/')) return true;
  if (path === 'packages/ui/stories' || path.startsWith('packages/ui/stories/')) return true;
  return false;
}

/** Unit / contract tests under src — not the Storybook catalog mount surface. */
function isPackageTestPath(path) {
  if (path.includes('/__tests__/')) return true;
  if (/\.test\.(ts|tsx|js|mjs)$/.test(path)) return true;
  return false;
}

/**
 * Product UI that product stories import. Test files under packages/ui/src
 * only need the unit lane — forcing Storybook (~2m wall with Chromium +
 * build-storybook) on every presentation unit edit was pure wall-clock waste.
 */
function isUiProductSourcePath(path) {
  if (path === 'packages/ui/src' || path.startsWith('packages/ui/src/')) {
    return !isPackageTestPath(path);
  }
  return false;
}

function isStorybookPath(path) {
  if (STORYBOOK_DRIVING_SCRIPTS.has(path) || path === STORYBOOK_CORE_SETTINGS) return true;
  if (path === 'apps/desktop/src/renderer' || path.startsWith('apps/desktop/src/renderer/')) {
    // Renderer unit tests do not change Storybook mount code.
    return !isPackageTestPath(path);
  }
  if (isStorybookCatalogPath(path)) return true;
  // packages/ui product sources (not __tests__) ship into the catalog.
  if (isUiProductSourcePath(path)) return true;
  return false;
}

/**
 * Electron e2e should pay cold install/boot only when the real window surface
 * or e2e driver changed — not when only packages/ui unit tests changed.
 */
function isE2eProductPath(path) {
  if (E2E_DRIVING_SCRIPTS.has(path)) return true;
  if (path === 'apps/desktop' || path.startsWith('apps/desktop/')) {
    // Storybook catalog under desktop never needs a real Electron window.
    if (isStorybookCatalogPath(path)) return false;
    return true;
  }
  if (isUiProductSourcePath(path)) return true;
  return false;
}

const STORAGE_STRESS_FILES = new Set([
  'packages/storage/src/agent-run-store.ts',
  'packages/storage/src/git-workspace-service.ts',
  'packages/storage/src/runtime-event-invariants.ts',
  'packages/storage/src/root-authority.ts',
  'packages/storage/src/operational-state-store.ts',
  'packages/storage/src/sqlite-artifact-schema.ts',
  'packages/storage/src/sqlite-core-execution-schema.ts',
  'packages/storage/src/sqlite-runtime-schema.ts',
  'packages/storage/src/sqlite-session-metadata-schema.ts',
  'packages/storage/src/sqlite-usage-schema.ts',
  'packages/storage/src/sqlite-workflow-schema.ts',
  'packages/storage/src/__tests__/agent-run-store.test.ts',
  'packages/storage/src/__tests__/git-workspace-service.test.ts',
  'packages/storage/src/__tests__/root-authority.test.ts',
  'packages/storage/src/__tests__/sqlite-recovery-concurrency.test.ts',
  'packages/storage/src/__tests__/fixtures/git-workspace-service-crash-child.ts',
  'packages/storage/src/__tests__/fixtures/sqlite-recovery-concurrency-child.ts',
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
    return {
      dir,
      name: manifest.name,
      dependencyNames,
      hasDistTests: typeof manifest.scripts?.['test:dist'] === 'string',
    };
  });
  const dirByName = new Map(entries.map(({ dir, name }) => [name, dir]));
  const dependents = new Map(dirs.map((dir) => [dir, new Set()]));
  for (const entry of entries) {
    for (const name of entry.dependencyNames) {
      const dependencyDir = dirByName.get(name);
      if (dependencyDir) dependents.get(dependencyDir)?.add(entry.dir);
    }
  }
  return {
    dirs,
    dependents,
    testDirs: new Set(entries.filter((entry) => entry.hasDistTests).map((entry) => entry.dir)),
  };
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

function workspaceLanes(workspaces, graph) {
  const testDirs = graph.testDirs ?? new Set(workspaces);
  return {
    runtimeHost:
      workspaces.includes('packages/runtime-host') && testDirs.has('packages/runtime-host'),
    standardWorkspaces: workspaces.filter(
      (dir) => testDirs.has(dir) && !DEDICATED_WORKSPACE_LANES.has(dir),
    ),
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
      // A complete functional suite is still the default release/main gate.
      // Stress multipliers and native child-process lock probes run only when
      // their owning storage seam changes; making --full imply stress turned
      // every unrelated merge into a 10K-chunk pressure run.
      storageStress: false,
      storybook: true,
      windows: true,
      windowsRuntime: true,
      windowsStorage: true,
      workspaces,
      ...workspaceLanes(workspaces, graph),
    };
  }

  const directWorkspaces = new Set();
  let code = false;
  let unknownCode = false;
  for (const path of files) {
    // Catalog/config changes are fully exercised by Storybook's build + render
    // smoke. They do not change the shipped Electron app, so do not route them
    // through workspace tests or real-window E2E merely because they live
    // inside an application workspace.
    if (isStorybookCatalogPath(path)) {
      code = true;
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
  const windowsBaselineChanged = files.includes('.github/workflows/windows-baseline.yml');
  const windows = code || files.some((path) => WINDOWS_BASELINE_FILES.has(path));
  const windowsRuntime = windowsBaselineChanged || workspaces.includes('packages/runtime');
  // Not every packages/storage edit needs Windows: reverse-dep closure would
  // also open this lane for any desktop/runtime consumer of storage. Gate on
  // path/lock/crash-sensitive files only.
  const windowsStorage =
    windowsBaselineChanged || files.some((path) => isWindowsStorageSensitivePath(path));

  return {
    code,
    // Electron E2E + alignment audit (same job). Product desktop/ui sources and
    // e2e drivers only — a storage/runtime change must not drag cold Electron
    // boots, and packages/ui unit-test-only PRs must not either.
    e2e: files.some((path) => isE2eProductPath(path)),
    full: false,
    // packages/cli/src/__tests__/runtime-host-session-driver.test.ts executes real sandboxed
    // shell tools, so the bubblewrap + user-namespace setup is required whenever
    // the cli workspace runs in the dependency closure, not only for direct
    // cli/runtime edits (e.g. a storage-only change still selects cli via runtime).
    runtimeSandbox: workspaces.includes('packages/cli'),
    storageStress,
    // Storybook build + smoke: catalog/harness only. Not every desktop/ui/core
    // PR — product ship gates are typecheck, unit, and Electron e2e. See
    // isStorybookPath.
    storybook: files.some((path) => isStorybookPath(path)),
    windows,
    windowsRuntime,
    windowsStorage,
    workspaces,
    ...workspaceLanes(workspaces, graph),
  };
}

export function formatGitHubOutputs(plan) {
  return [
    `code=${plan.code}`,
    `e2e=${plan.e2e}`,
    `full=${plan.full}`,
    `runtime_host=${plan.runtimeHost}`,
    `runtime_sandbox=${plan.runtimeSandbox}`,
    `storage_stress=${plan.storageStress}`,
    `storybook=${plan.storybook}`,
    `unit=${plan.workspaces.length > 0}`,
    `windows=${plan.windows}`,
    `windows_runtime=${plan.windowsRuntime}`,
    `windows_storage=${plan.windowsStorage}`,
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

export function changedFilesBetween(base, head, exec = execFileSync) {
  return exec('git', ['diff', '--no-renames', '--name-only', '--diff-filter=ACMRD', base, head], {
    cwd: defaultRepoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
}

function main(args) {
  const parsed = parseArgs(args);
  const changedFiles = parsed.forceFull ? [] : changedFilesBetween(parsed.base, parsed.head);
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
