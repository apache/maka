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
  // Branch protection. `product-release.test.mjs` parses it and asserts the
  // required contexts and the release-environment admission rules, and that
  // suite runs behind `check:release` — so this selection is what proves a
  // change to the merge gate still satisfies its own policy test.
  '.asf.yaml',
  'apps/desktop/src/main/app-update-test-context.ts',
  'apps/desktop/build/entitlements.mac.inherit.plist',
  'apps/desktop/build/entitlements.mac.plist',
  'apps/desktop/bundled-tools.json',
  'apps/desktop/resources/licenses/npm/THIRD_PARTY_NOTICES.txt',
  'apps/desktop/electron-builder.config.mjs',
  'apps/desktop/package.json',
  '.github/workflows/cli-package-validation.yml',
  '.github/workflows/desktop-nightly.yml',
  '.github/workflows/npm-publication.yml',
  '.github/workflows/release-cli-finalize.yml',
  '.github/workflows/release-cli-stage.yml',
  '.github/workflows/release.yml',
  '.github/workflows/release-windows-check.yml',
  '.github/workflows/windows-recovery.yml',
  'scripts/package-macos-arm64.mjs',
  'scripts/package-macos-autoupdate-next.mjs',
  'scripts/package-macos-arm64-cli.mjs',
  'scripts/package-windows-autoupdate-next.mjs',
  'scripts/package-windows-x64.mjs',
  'scripts/prepare-windows-upgrade-baseline.mjs',
  'scripts/prepare-windows-upgrade-baseline.test.mjs',
  'scripts/generate-third-party-notices.test.mjs',
  'scripts/product-release.test.mjs',
  'scripts/qualify-released-cli-state-root.test.mjs',
  'scripts/release-eval-smoke-sitecustomize.py',
  'scripts/release-version.mjs',
  'scripts/third-party-closure.test.mjs',
  'scripts/verify-macos-arm64-cli.mjs',
  'scripts/verify-macos-arm64-dmg.mjs',
  'scripts/verify-macos-autoupdate.mjs',
  'scripts/desktop-update-contract.mjs',
  'scripts/product-nightly.mjs',
  'scripts/product-nightly.test.mjs',
  'scripts/verify-packaged-app.mjs',
  'scripts/verify-packaged-app.test.mjs',
  'scripts/verify-windows-autoupdate.mjs',
  'scripts/verify-windows-installer-lifecycle.mjs',
  'scripts/verify-windows-x64.mjs',
  'scripts/windows-upgrade-baseline.json',
  'scripts/windows-package-source-closure.mjs',
  'scripts/windows-package-source-closure.test.mjs',
]);

// What decides whether a build can read durable state an earlier release wrote.
// `operations.ts` is here because it owns the operation vocabulary: the rename
// that stranded workspaces holding an older credential (#4420) changed that file
// and none of the decoders, so a trigger listing only decoders would not have
// run on the very change it exists to catch.
const DURABLE_STATE_DECODER_FILES = new Set([
  'packages/runtime-host/src/protocol/operations.ts',
  'packages/runtime-host/src/server/access-authority.ts',
  'packages/runtime-host/src/server/access-credential-store.ts',
  'packages/storage/src/operational-state-store.ts',
  'packages/storage/src/root-authority.ts',
  'packages/storage/src/state-root-composition.ts',
  'scripts/qualify-released-cli-state-root.mjs',
  'scripts/released-cli-state-root-fixture.mjs',
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
  'scripts/generate-runtime-host-peer-notices.mjs',
  'scripts/install-electron-with-retry.mjs',
  'scripts/npm-spawn.mjs',
  'scripts/smoke-release-cli-package.mjs',
]);

const ASF_SOURCE_FILES = new Set([
  '.github/workflows/asf-source-candidate.yml',
  '.github/workflows/model-metadata-upkeep.yml',
  'DISCLAIMER-WIP',
  'LICENSE',
  'NOTICE',
  'apps/desktop/src/renderer/public/THIRD_PARTY_LICENSES.txt',
  'biome.jsonc',
  'docs/code-origin-audit.md',
  'package.json',
  'packages/eval/harbor/deepseek-harness-profile/cordis.patch.yml',
  'scripts/asf-license-headers.mjs',
  'scripts/asf-license-headers.test.mjs',
  'scripts/asf-source-release.mjs',
  'scripts/asf-source-release.test.mjs',
  'scripts/asf-source-workflow-policy.test.mjs',
  'scripts/model-metadata-upkeep-workflow-policy.test.mjs',
  'scripts/model-metadata/models-dev-api.snapshot.json',
  'scripts/source-legal-inventory.test.mjs',
  'scripts/sync-model-metadata.mjs',
  'scripts/sync-model-metadata.test.mjs',
]);

function isAsfSourcePath(path) {
  return (
    ASF_SOURCE_FILES.has(path) ||
    path.startsWith('patches/') ||
    path.startsWith('apps/desktop/resources/licenses/renderer/') ||
    path.startsWith('apps/desktop/src/renderer/assets/provider-brands/')
  );
}

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
  // `release:cli:pack` builds the direct-peer addon into the tarball and runs
  // `cargo deny` against that policy, so this crate ships and CLI packaging is
  // the JavaScript gate that proves it still does.
  if (path === 'deny.toml' || path.startsWith('native/runtime-host-peer/')) return true;
  if (isDocumentation(path)) return false;
  if (path.startsWith('scripts/release-cli-')) return true;
  if (path.startsWith('tsconfig') && path.endsWith('.json')) return true;
  return CLI_PACKAGE_WORKSPACES.some(
    (workspace) => path === workspace || path.startsWith(`${workspace}/`),
  );
}

function isReleaseContractPath(path) {
  return (
    RELEASE_CONTRACT_FILES.has(path) ||
    path.startsWith('scripts/desktop-nightly') ||
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
  if (isDocumentation(path)) return false;
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
  if (isDocumentation(path)) return false;
  if (path === 'apps/desktop/src/renderer' || path.startsWith('apps/desktop/src/renderer/')) {
    return !isPackageTestPath(path);
  }
  return isUiProductSourcePath(path);
}

/**
 * The two app-icon drift tests read exactly this surface: the committed
 * artwork, the generator that must still reproduce it, the `APP_ICONS` catalog
 * they check it against, the packaged-resource list that has to keep naming
 * every file, and the packaging config, which the drift test opens by path to
 * prove the bundle icon is still `DEFAULT_APP_ICON`. Regenerating the artwork
 * costs about a minute, which every unrelated code change used to pay.
 */
const APP_ICON_FILES = new Set([
  'apps/desktop/electron-builder.config.mjs',
  'packages/core/src/settings.ts',
  'scripts/generate-app-icons.py',
  'scripts/generate-app-icons.test.mjs',
  'scripts/verify-packaged-app.mjs',
  'scripts/verify-packaged-app-icons.test.mjs',
]);

function isAppIconPath(path) {
  return APP_ICON_FILES.has(path) || path.startsWith('apps/desktop/assets/app-icons/');
}

function isE2eProductPath(path) {
  if (E2E_DRIVING_SCRIPTS.has(path)) return true;
  if (isDocumentation(path)) return false;
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
  'packages/storage/src/runtime-event-invariants.ts',
  'packages/storage/src/root-authority.ts',
  'packages/storage/src/operational-state-store.ts',
  'packages/storage/src/sqlite-artifact-schema.ts',
  'packages/storage/src/sqlite-core-execution-schema.ts',
  'packages/storage/src/sqlite-runtime-schema.ts',
  'packages/storage/src/sqlite-session-metadata-schema.ts',
  'packages/storage/src/sqlite-usage-schema.ts',
  'packages/storage/src/sqlite-workflow-schema.ts',
  'packages/storage/src/__tests__/root-authority.test.ts',
  'packages/storage/src/__tests__/sqlite-recovery-concurrency.test.ts',
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
      appIcons: true,
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
      stateRootCompat: true,
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
    // Documentation can live inside a workspace. Classify it before generic
    // workspace and product-surface membership; dedicated legal, release, and
    // generated-authority gates still inspect the complete file list below.
    if (isDocumentation(path)) continue;
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
    // Rust. Each of these crates has an admission lane that owns `cargo fmt`
    // and `cargo test` for it, and `native/runtime-host-peer` additionally
    // reaches CLI packaging through `isCliPackagePath` above. Nothing under
    // either is read by lint, typecheck, Storybook, or a real window, so
    // falling through to the guard below made this directory the largest
    // single source of full-suite runs.
    //
    // Named one crate at a time rather than by the `native/` prefix: what
    // earns the exemption is having a lane, not being written in Rust. A new
    // native root has neither until someone adds one, and until then the
    // guard below is the only thing that would test it at all.
    //
    // `deny.toml` is the lint policy both crates share and travels with them.
    if (
      path.startsWith('native/gitoxide-helper/') ||
      path.startsWith('native/runtime-host-peer/') ||
      path === 'deny.toml'
    ) {
      continue;
    }
    // Branch protection selects no workspace, but it is not unknown either:
    // `RELEASE_CONTRACT_FILES` above routes it to `product-release.test.mjs`,
    // the suite that parses it and asserts the required contexts.
    if (path === '.asf.yaml') continue;
    if (path.startsWith('.github/')) continue;
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
    appIcons: files.some((path) => isAppIconPath(path)),
    asfSource: files.some((path) => isAsfSourcePath(path)),
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
    // The released forward roll: a build under test reads durable state a
    // published predecessor wrote. Selected by the decoders and the operation
    // vocabulary they decode against, plus the SQLite schemas.
    stateRootCompat: files.some(
      (path) =>
        DURABLE_STATE_DECODER_FILES.has(path) ||
        /^packages\/storage\/src\/sqlite-[^/]*schema[^/]*\.ts$/u.test(path),
    ),
    storageStress,
    // Storybook build + smoke: catalog/harness only. Not every desktop/ui/core
    // PR — product ship gates are typecheck, unit, and Electron e2e. See
    // isStorybookPath.
    storybook: files.some((path) => isStorybookPath(path)),
    workspaces,
    ...workspaceLanes(workspaces, graph),
  };
}

export function requiresHeavyValidation(plan) {
  return Boolean(
    plan.appIcons ||
      plan.asfSource ||
      plan.astryxSurface ||
      plan.cliPackage ||
      plan.code ||
      plan.e2e ||
      plan.releaseContract ||
      plan.runtimeHost ||
      plan.runtimeSandbox ||
      plan.stateRootCompat ||
      plan.storybook ||
      plan.standardWorkspaces.length > 0,
  );
}

export function formatGitHubOutputs(plan) {
  return [
    `app_icons=${plan.appIcons}`,
    `asf_source=${plan.asfSource}`,
    `astryx_surface=${plan.astryxSurface}`,
    `cli_package=${plan.cliPackage}`,
    `code=${plan.code}`,
    `e2e=${plan.e2e}`,
    `heavy=${requiresHeavyValidation(plan)}`,
    `runtime_host=${plan.runtimeHost}`,
    `runtime_sandbox=${plan.runtimeSandbox}`,
    `release_contract=${plan.releaseContract}`,
    `state_root_compat=${plan.stateRootCompat}`,
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
  const options = {
    cwd: defaultRepoRoot,
    encoding: 'utf8',
  };
  const mergeBase = exec('git', ['merge-base', base, head], options).trim();
  return exec(
    'git',
    ['diff', '--no-renames', '--name-only', '--diff-filter=ACMRDT', mergeBase, head],
    options,
  )
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
