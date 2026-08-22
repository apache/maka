#!/usr/bin/env node
/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

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

const RELEASE_CONTRACT_FILES = new Set([
  'apps/desktop/build/entitlements.mac.inherit.plist',
  'apps/desktop/build/entitlements.mac.plist',
  'apps/desktop/bundled-tools.json',
  'apps/desktop/resources/licenses/npm/THIRD_PARTY_NOTICES.txt',
  'apps/desktop/electron-builder.config.mjs',
  'apps/desktop/package.json',
  '.github/workflows/cli-package-validation.yml',
  '.github/workflows/release-cli-finalize.yml',
  '.github/workflows/release-cli-stage.yml',
  '.github/workflows/release.yml',
  'scripts/package-macos-arm64.mjs',
  'scripts/package-macos-arm64-cli.mjs',
  'scripts/package-windows-autoupdate-next.mjs',
  'scripts/package-windows-x64.mjs',
  'scripts/prepare-windows-upgrade-baseline.mjs',
  'scripts/generate-third-party-notices.test.mjs',
  'scripts/prepare-windows-upgrade-baseline.test.mjs',
  'scripts/product-release.test.mjs',
  'scripts/release-eval-smoke-sitecustomize.py',
  'scripts/release-version.mjs',
  'scripts/verify-macos-arm64-cli.mjs',
  'scripts/verify-macos-arm64-dmg.mjs',
  'scripts/verify-packaged-app.mjs',
  'scripts/verify-windows-autoupdate.mjs',
  'scripts/verify-windows-installer-lifecycle.mjs',
  'scripts/verify-windows-x64.mjs',
  'scripts/windows-upgrade-baseline.json',
]);

const TYPECHECK_ONLY_FILES = new Set([
  'biome.jsonc',
  'components.json',
  'knip.json',
  'tsconfig.base.json',
  'tsconfig.lib.json',
]);

const CLI_PACKAGE_FILES = new Set([
  '.github/workflows/cli-package-validation.yml',
  'LICENSE',
  'NOTICE',
  'scripts/apply-dependency-patches.mjs',
  'scripts/clean-paths.mjs',
  'scripts/generate-third-party-notices.mjs',
  'scripts/install-electron-with-retry.mjs',
  'scripts/npm-spawn.mjs',
  'scripts/smoke-release-cli-package.mjs',
]);

const ASF_SOURCE_FILES = new Set([
  '.github/workflows/asf-source-candidate.yml',
  'scripts/asf-license-headers.mjs',
  'scripts/asf-license-headers.test.mjs',
  'scripts/asf-source-release.mjs',
  'scripts/asf-source-release.test.mjs',
  'scripts/asf-source-workflow-policy.test.mjs',
]);

const CLI_PACKAGE_WORKSPACES = [
  'packages/cli',
  'packages/core',
  'packages/eval',
  'packages/mcp',
  'packages/runtime',
  'packages/runtime-host',
  'packages/storage',
];

function isCliPackagePath(path) {
  if (CLI_PACKAGE_FILES.has(path) || path.startsWith('patches/')) return true;
  if (path.startsWith('scripts/release-cli-')) return true;
  if (path.startsWith('tsconfig') && path.endsWith('.json')) return true;
  return CLI_PACKAGE_WORKSPACES.some(
    (workspace) => path === workspace || path.startsWith(`${workspace}/`),
  );
}

function isReleaseContractPath(path) {
  return (
    RELEASE_CONTRACT_FILES.has(path) ||
    path.startsWith('scripts/product-release-') ||
    path.startsWith('scripts/release-cli-')
  );
}

const DEDICATED_WORKSPACE_LANES = new Set(['packages/runtime-host']);

// Scripts the Electron e2e job runs. Editing one of these changes what that
// job verifies, so it has to re-run — a unit test on the runner is not
// evidence that the run it drives still works.
const E2E_DRIVING_SCRIPTS = new Set([
  'apps/desktop/scripts/browser-observe-act-smoke.mjs',
  'scripts/audit-alignment.mjs',
  'scripts/ax-tree-audit.mjs',
]);

// Scripts / paths that can break the built Storybook catalog. Product stories
// mount the UI package and desktop renderer, so runtime export/render changes
// there belong to this surface even when no story file changes. Main-process
// and e2e-only desktop changes stay outside it.
const STORYBOOK_DRIVING_SCRIPTS = new Set([
  'scripts/ax-tree-audit.mjs',
  'scripts/storybook-visual-smoke.mjs',
]);

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
function isAstryxSurfaceInventoryPath(path) {
  if (
    path === 'docs/astryx-surface-file-inventory.md' ||
    path === 'docs/astryx-surface-file-inventory.paths' ||
    path === 'scripts/generate-astryx-surface-inventory.mjs' ||
    path === 'scripts/check-astryx-surface-inventory.mjs'
  ) {
    return true;
  }
  if (path === 'apps/desktop/src/renderer' || path.startsWith('apps/desktop/src/renderer/')) {
    return !isPackageTestPath(path);
  }
  return isUiProductSourcePath(path);
}

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
      asfSource: true,
      astryxSurface: true,
      cliPackage: true,
      code: true,
      e2e: true,
      full: true,
      releaseContract: true,
      runtimeSandbox: graph.dirs.includes('packages/cli'),
      // A complete functional suite is still the default release/main gate.
      // Stress multipliers and native child-process lock probes run only when
      // their owning storage seam changes; making --full imply stress turned
      // every unrelated merge into a 10K-chunk pressure run.
      storageStress: false,
      storybook: true,
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

  const cliPackage = files.some((path) => isCliPackagePath(path));
  return {
    asfSource: files.some((path) => ASF_SOURCE_FILES.has(path)),
    astryxSurface: files.some((path) => isAstryxSurfaceInventoryPath(path)),
    cliPackage,
    code,
    // Electron E2E + alignment audit (same job). Product desktop/ui sources and
    // e2e drivers only — a storage/runtime change must not drag cold Electron
    // boots, and packages/ui unit-test-only PRs must not either.
    e2e: files.some((path) => isE2eProductPath(path)),
    full: false,
    releaseContract: cliPackage || files.some((path) => isReleaseContractPath(path)),
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
    workspaces,
    ...workspaceLanes(workspaces, graph),
  };
}

export function formatGitHubOutputs(plan) {
  return [
    `asf_source=${plan.asfSource}`,
    `astryx_surface=${plan.astryxSurface}`,
    `cli_package=${plan.cliPackage}`,
    `code=${plan.code}`,
    `e2e=${plan.e2e}`,
    `runtime_host=${plan.runtimeHost}`,
    `runtime_sandbox=${plan.runtimeSandbox}`,
    `release_contract=${plan.releaseContract}`,
    `storage_stress=${plan.storageStress}`,
    `storybook=${plan.storybook}`,
    `standard_workspaces=${plan.standardWorkspaces.join(',')}`,
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
