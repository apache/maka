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

/**
 * Behaviour of the test planner itself: which lanes a set of changed files
 * selects. Assertions about the workflows that consume those selections live in
 * `ci-workflow-policy.test.mjs`.
 *
 * This suite runs before `npm ci` installs anything, so it may import only
 * `node:` builtins and repository modules that do the same.
 * `ci-workflow-policy.test.mjs` asserts that constraint for every suite the
 * install-free steps run.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { changedFilesBetween, formatGitHubOutputs, planTests } from './ci-test-plan.mjs';

/**
 * Every surface a plan selected, read off the plan itself rather than from a
 * list of the ones worth naming. `assert.deepEqual(selections(plan), [])` is
 * therefore the whole "this change costs nothing" claim, and a selection added
 * later joins it without anyone editing these tests.
 */
function selections(plan) {
  return Object.entries(plan)
    .filter(([key]) => key !== 'workspaces')
    .filter(([, value]) => (Array.isArray(value) ? value.length > 0 : Boolean(value)))
    .map(([key]) => key)
    .sort();
}

const dirs = [
  'packages/core',
  'packages/storage',
  'packages/runtime',
  'packages/runtime-host',
  'packages/cli',
  'packages/ui',
  'apps/desktop',
  'website',
];

const graph = {
  dirs,
  dependents: new Map([
    ['packages/core', new Set(['packages/storage', 'packages/runtime'])],
    ['packages/storage', new Set(['packages/runtime', 'packages/runtime-host'])],
    ['packages/runtime', new Set(['packages/runtime-host', 'packages/cli', 'apps/desktop'])],
    ['packages/runtime-host', new Set(['packages/cli', 'apps/desktop'])],
    ['packages/cli', new Set()],
    ['packages/ui', new Set(['apps/desktop'])],
    ['apps/desktop', new Set()],
    ['website', new Set()],
  ]),
  testDirs: new Set(dirs),
};

test('documentation-only changes select nothing at all', () => {
  const plan = planTests(['docs/ci.md'], { graph });

  assert.deepEqual(selections(plan), []);
  assert.deepEqual(plan.workspaces, []);
});

test('documentation inside workspaces selects nothing at all', () => {
  for (const path of ['packages/runtime/README.md', 'apps/desktop/README.md']) {
    const plan = planTests([path], { graph });

    assert.deepEqual(selections(plan), [], path);
    assert.deepEqual(plan.workspaces, [], path);
  }
});

test('the READMEs run the website tests that check their opening sentence', () => {
  for (const path of ['README.md', 'README.zh-CN.md']) {
    const plan = planTests([path], { graph });

    assert.equal(plan.code, true, path);
    assert.deepEqual(plan.workspaces, ['website'], path);
  }
});

test('mixed documentation and code changes still select code validation', () => {
  const plan = planTests(['README.md', 'packages/core/src/index.ts'], { graph });

  assert.equal(plan.code, true);
});

test('documentation with a dedicated contract still selects that contract', () => {
  for (const path of [
    'LICENSE',
    'docs/astryx-surface-file-inventory.md',
    'apps/desktop/resources/licenses/renderer/SIMPLE_ICONS_LICENSE.md',
  ]) {
    const plan = planTests([path], { graph });

    assert.equal(plan.code, false, path);
    assert.notDeepEqual(selections(plan), [], path);
  }
});

test('changed files are derived from the PR merge base', () => {
  const calls = [];
  const exec = (_command, args) => {
    calls.push(args);
    if (args[0] === 'merge-base') return 'fork-point\n';
    if (args.at(-2) === 'fork-point') return 'packages/runtime/README.md\n';
    if (args.at(-2) === 'main-now') {
      return 'packages/core/src/main-only.ts\npackages/runtime/README.md\n';
    }
    throw new Error(`Unexpected git invocation: ${args.join(' ')}`);
  };

  const changedFiles = changedFilesBetween('main-now', 'pr-head', exec);

  assert.deepEqual(changedFiles, ['packages/runtime/README.md']);
  assert.deepEqual(selections(planTests(changedFiles, { graph })), []);
  assert.deepEqual(calls, [
    ['merge-base', 'main-now', 'pr-head'],
    ['diff', '--no-renames', '--name-only', '--diff-filter=ACMRDT', 'fork-point', 'pr-head'],
  ]);
});

test('type changes remain in the PR-owned delta', () => {
  const exec = (_command, args) => {
    if (args[0] === 'merge-base') return 'fork-point\n';
    assert.ok(args.includes('--diff-filter=ACMRDT'));
    return 'packages/runtime/src/runtime.ts\n';
  };

  const changedFiles = changedFilesBetween('main-now', 'pr-head', exec);

  assert.deepEqual(changedFiles, ['packages/runtime/src/runtime.ts']);
  assert.equal(planTests(changedFiles, { graph }).code, true);
});

test('the Astryx inventory can run without selecting the code suite', () => {
  const plan = planTests(['docs/astryx-surface-file-inventory.md'], { graph });

  assert.equal(plan.code, false);
  assert.equal(plan.astryxSurface, true);
});

test('desktop renderer changes retain Electron and Storybook coverage', () => {
  const plan = planTests(['apps/desktop/src/renderer/app.tsx'], { graph });

  assert.equal(plan.code, true);
  assert.equal(plan.e2e, true);
  assert.equal(plan.storybook, true);
  assert.equal(plan.astryxSurface, true);
  assert.deepEqual(plan.standardWorkspaces, ['apps/desktop']);
});

test('Storybook catalog changes avoid real-window E2E and workspace tests', () => {
  const plan = planTests(['apps/desktop/stories/settings.stories.tsx'], { graph });

  assert.equal(plan.code, true);
  assert.equal(plan.e2e, false);
  assert.equal(plan.storybook, true);
  assert.deepEqual(plan.workspaces, []);
});

test('AX audit contract test edits avoid the Storybook browser pipeline', () => {
  const plan = planTests(['scripts/ax-tree-audit.test.mjs'], { graph });
  assert.equal(plan.storybook, false);
  assert.equal(plan.e2e, false);
});

test('runtime changes retain the dedicated Runtime Host lane', () => {
  const plan = planTests(['packages/runtime/src/runtime.ts'], { graph });

  assert.equal(plan.runtimeHost, true);
  assert.equal(plan.runtimeSandbox, true);
  assert.deepEqual(plan.standardWorkspaces, ['packages/runtime', 'packages/cli', 'apps/desktop']);
});

test('CLI release inputs select installed-package validation', () => {
  const plan = planTests(['packages/runtime/src/runtime.ts'], { graph });

  assert.equal(plan.cliPackage, true);
});

test('release metadata selects only the gate that consumes it', () => {
  for (const path of ['LICENSE', 'NOTICE']) {
    const plan = planTests([path], { graph });
    assert.equal(plan.cliPackage, true, path);
    assert.equal(plan.releaseContract, true, path);
    assert.equal(plan.asfSource, true, path);
  }
});

test('source legal authority and generated provenance select the ASF source gate', () => {
  for (const path of [
    'DISCLAIMER-WIP',
    'biome.jsonc',
    'patches/node-pty+1.2.0-beta.15.patch',
    'apps/desktop/src/renderer/assets/provider-brands/example.svg',
    'apps/desktop/resources/licenses/renderer/SIMPLE_ICONS_LICENSE.md',
    'packages/eval/harbor/deepseek-harness-profile/cordis.patch.yml',
    'scripts/model-metadata/models-dev-api.snapshot.json',
    'scripts/sync-model-metadata.mjs',
  ]) {
    assert.equal(planTests([path], { graph }).asfSource, true, path);
  }
});

test('release authority changes select their dedicated contract gate', () => {
  for (const path of [
    'apps/desktop/src/main/app-update-test-context.ts',
    'apps/desktop/build/entitlements.mac.plist',
    'apps/desktop/electron-builder.config.mjs',
    'apps/desktop/package.json',
    '.github/workflows/cli-package-validation.yml',
    '.github/workflows/desktop-nightly.yml',
    '.github/workflows/npm-publication.yml',
    '.github/workflows/release-cli-finalize.yml',
    '.github/workflows/release-cli-stage.yml',
    '.github/workflows/release.yml',
    'scripts/audit-shipped-dependencies.mjs',
    'scripts/package-macos.mjs',
    'scripts/package-macos-autoupdate-next.mjs',
    'scripts/package-macos-arm64-cli.mjs',
    'scripts/package-linux.mjs',
    'scripts/package-windows-x64.mjs',
    'scripts/prepare-windows-upgrade-baseline.mjs',
    'scripts/product-release-artifacts.mjs',
    'scripts/product-release-authority.mjs',
    'scripts/product-release-authority.test.mjs',
    'scripts/product-release-identity.mjs',
    'scripts/product-release-tag.mjs',
    'scripts/product-release.test.mjs',
    'scripts/release-eval-smoke-sitecustomize.py',
    'scripts/release-version.mjs',
    'scripts/release-cli-publication.test.mjs',
    'scripts/verify-macos-arm64-cli.mjs',
    'scripts/verify-macos-dmg.mjs',
    'scripts/verify-macos-autoupdate.mjs',
    'scripts/verify-linux.mjs',
    'scripts/desktop-release-targets.mjs',
    'scripts/desktop-release-targets.test.mjs',
    'scripts/desktop-update-contract.mjs',
    'scripts/verify-packaged-app.mjs',
    'scripts/verify-windows-x64.mjs',
    'scripts/windows-upgrade-baseline.json',
    'scripts/windows-package-source-closure.mjs',
    'scripts/windows-package-source-closure.test.mjs',
  ]) {
    assert.equal(planTests([path], { graph }).releaseContract, true, path);
  }
  assert.equal(planTests(['.github/RELEASE_CHECKLIST.md'], { graph }).releaseContract, false);
});

// Derived from the gate scripts themselves, because the sets above are hand
// maintained and drift silently in both directions: a test the gate runs but
// no lane selects can be edited green, and a listed path that no longer exists
// is dead weight nothing reports. Both had happened — three of the release
// gate's own tests reached no lane, and the set named a
// `prepare-windows-upgrade-baseline.test.mjs` that never existed.
test('every test a gate script runs reaches a lane that runs that gate', () => {
  const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lanesByTest = new Map();
  for (const [script, lane] of [
    ['check:release', 'releaseContract'],
    ['check:asf-source', 'asfSource'],
  ]) {
    for (const file of scripts[script].match(/scripts\/[\w.-]+\.test\.mjs/gu) ?? []) {
      lanesByTest.set(file, (lanesByTest.get(file) ?? new Set()).add(lane));
    }
  }
  assert.ok(lanesByTest.size > 0, 'no gate script names a test file');

  // A test two gates share needs only one of them: either run executes it.
  for (const [file, lanes] of lanesByTest) {
    const plan = planTests([file], { graph });
    assert.ok(
      [...lanes].some((lane) => plan[lane]),
      `${file} reaches no ${[...lanes].join('/')}`,
    );
  }
});

// The other direction of the same drift. Every literal path in the planner is
// matched against a changed file, so one that no longer exists can never match
// and nothing reports it: the phantom baseline test sat here for a month, and
// `agent-run-store.test.ts` stayed in the storage stress set for a month after
// #1994 deleted it.
test('the planner names no path that no longer exists', () => {
  const source = readFileSync(new URL('ci-test-plan.mjs', import.meta.url), 'utf8');
  const paths = [...source.matchAll(/^ {2}'([\w.-]+(?:\/[\w.-]+)+)',$/gmu)].map(([, path]) => path);
  assert.ok(paths.length > 0, 'the planner names no paths');

  for (const path of paths) {
    assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), path);
  }
});

test('Product Nightly authority changes select the release contract gate', () => {
  for (const path of [
    '.github/workflows/desktop-nightly.yml',
    '.github/workflows/npm-publication.yml',
    'scripts/desktop-nightly.mjs',
    'scripts/desktop-nightly.test.mjs',
    'scripts/desktop-nightly-stage.test.mjs',
    'scripts/desktop-nightly-workflow-policy.test.mjs',
    'scripts/product-nightly.mjs',
    'scripts/product-nightly.test.mjs',
  ]) {
    assert.equal(planTests([path], { graph }).releaseContract, true, path);
  }
});

// Both notices are committed generator output. A hand edit or a merge-conflict
// resolution can corrupt either one, and `check:release` is what regenerates
// and diffs them, so both must reach that gate — the desktop notice lives
// outside `packages/cli/**` and would otherwise reach no gate at all.
test('both committed third-party notices reach the release gate', () => {
  for (const path of [
    'apps/desktop/resources/licenses/npm/THIRD_PARTY_NOTICES.txt',
    'packages/cli/THIRD_PARTY_NOTICES.txt',
  ]) {
    assert.equal(planTests([path], { graph }).releaseContract, true, path);
  }
});

// The test only reads the generator, so it belongs to the release contract and
// not to the CLI package gate, whose tarball build and install smoke prove
// nothing about a test-only edit.
test('the notice regression test selects the release gate alone', () => {
  const plan = planTests(['scripts/generate-third-party-notices.test.mjs'], { graph });
  assert.equal(plan.releaseContract, true);
  assert.equal(plan.cliPackage, false);
});

test('ASF source authority changes select their dedicated gate', () => {
  for (const path of [
    '.gitattributes',
    '.github/workflows/asf-source-candidate.yml',
    'docs/code-origin-audit.md',
    'scripts/asf-source-release.mjs',
    'scripts/asf-source-release.test.mjs',
  ]) {
    assert.equal(planTests([path], { graph }).asfSource, true, path);
  }
  assert.equal(planTests(['.github/ASF_SOURCE_RELEASE.md'], { graph }).asfSource, false);
  assert.equal(planTests(['scripts/audit-alignment.mjs'], { graph }).asfSource, false);
});

test('shared CLI validation changes select installed-package validation', () => {
  const plan = planTests(['.github/workflows/cli-package-validation.yml'], { graph });

  assert.equal(plan.cliPackage, true);
});

test('desktop-only changes skip installed-package validation', () => {
  assert.equal(planTests(['apps/desktop/src/main.ts'], { graph }).cliPackage, false);
});

test('full selection covers every live surface', () => {
  const plan = planTests([], { graph, forceFull: true });

  assert.equal(plan.full, true);
  assert.equal(plan.asfSource, true);
  assert.equal(plan.cliPackage, true);
  assert.equal(plan.code, true);
  assert.equal(plan.e2e, true);
  assert.equal(plan.storybook, true);
  assert.equal(plan.runtimeHost, true);
  assert.equal(plan.releaseContract, true);
  assert.deepEqual(plan.workspaces, dirs);
});

test('unknown top-level code fails safe to full selection', () => {
  assert.equal(planTests(['unknown.config'], { graph }).full, true);
});

// Everything below reached that fail-safe until now. `native/` alone was the
// largest single source of full-suite runs — 14 of the last 300 first-parent
// commits, ahead of `package-lock.json` — because the classifier had no opinion
// about a directory that three dedicated lanes already own.

test('a Rust crate with its own admission lane selects no JavaScript surface', () => {
  // `gitoxide-helper-admission.yml` owns `cargo fmt`, `cargo test`, and the
  // JavaScript invocation contract for this crate on three operating systems.
  // No step in `ci.yml` reads it, so the plan has nothing to select.
  for (const path of ['native/gitoxide-helper/src/main.rs', 'native/gitoxide-helper/Cargo.toml']) {
    const plan = planTests([path], { graph });
    assert.equal(plan.full, false, path);
    assert.equal(plan.code, false, path);
    assert.equal(plan.cliPackage, false, path);
    assert.deepEqual(plan.workspaces, [], path);
  }
});

test('the direct-peer crate and its lint policy select CLI packaging alone', () => {
  // `release:cli:pack` builds this addon into the tarball and runs `cargo deny`
  // against that policy, so CLI packaging is the one JavaScript gate with a
  // stake here. Lint, typecheck, Storybook, and a real window have none.
  for (const path of [
    'native/runtime-host-peer/src/engine.rs',
    'native/runtime-host-peer/Cargo.lock',
    'deny.toml',
  ]) {
    const plan = planTests([path], { graph });
    assert.equal(plan.full, false, path);
    assert.equal(plan.cliPackage, true, path);
    assert.equal(plan.releaseContract, true, path);
    assert.equal(plan.e2e, false, path);
    assert.equal(plan.storybook, false, path);
    assert.equal(plan.appIcons, false, path);
    assert.deepEqual(plan.workspaces, [], path);
  }
});

test('a native root without an admission lane still fails safe to full', () => {
  // The exemption above is owned by a lane, not by the language. A crate added
  // under `native/` has no lane on the commit that introduces it, so nothing
  // but this fallback would compile or test it at all.
  for (const path of ['native/new-helper/src/main.rs', 'native/new-helper/Cargo.toml']) {
    assert.equal(planTests([path], { graph }).full, true, path);
  }
});

test('branch protection reaches the suite that parses it', () => {
  // `.asf.yaml` names the required contexts and the release-environment
  // admission rules. `product-release.test.mjs` is the only suite that reads
  // it, and it runs behind `check:release` — so selecting the release contract
  // is what proves a change to the merge gate still passes its own policy test.
  const plan = planTests(['.asf.yaml'], { graph });
  assert.equal(plan.full, false);
  assert.equal(plan.releaseContract, true);
  assert.equal(plan.code, false);
  assert.deepEqual(plan.workspaces, []);
});

test('a dependency patch keeps the full suite until a consumer map exists', () => {
  // A patch rewrites a dependency's behaviour, and which suite proves that
  // behaviour is a property of the patch rather than of the directory. The
  // node-pty patch is regressed by
  // `packages/runtime/src/__tests__/node-pty-write-lifecycle.test.ts`, while
  // the packaging smoke that a build-shaped selection would run only asserts
  // that a method name still appears in the tarball. Narrowing this bucket
  // needs an explicit patch-to-consumer mapping; until then it stays here,
  // where the cost is runner minutes rather than a silent regression.
  assert.equal(planTests(['patches/node-pty+1.2.0-beta.15.patch'], { graph }).full, true);
});

test('full-suite authority files select every surface', () => {
  for (const path of ['package-lock.json', '.github/workflows/ci.yml']) {
    assert.equal(planTests([path], { graph }).full, true, path);
  }
});

// The SessionTodo cutover (#4351) retired an operation and stranded every
// workspace holding a credential issued before it (#4420). It changed the
// vocabulary, not the decoders — so a trigger listing only decoders stays green
// on the exact change shape this guard exists to catch.
test('retiring an operation selects the released forward roll', () => {
  const plan = planTests(
    [
      'packages/runtime-host/src/protocol/operations.ts',
      'apps/desktop/src/renderer/features/workbar/tools/tasks/use-session-todo.ts',
    ],
    { graph },
  );

  assert.equal(plan.stateRootCompat, true);
  assert.equal(plan.full, false);
});

test('a durable-state decoder selects the released forward roll', () => {
  const plan = planTests(['packages/runtime-host/src/server/access-credential-store.ts'], {
    graph,
  });

  assert.equal(plan.stateRootCompat, true);
});

test('ordinary changes do not pay for the released forward roll', () => {
  const plan = planTests(['apps/desktop/src/renderer/features/workbar/ports.ts'], { graph });

  assert.equal(plan.stateRootCompat, false);
});

// Which files select the app icon gate is derived in `ci-workflow-policy.test.mjs`
// from the suites the step runs. What stays here is the complement: regenerating
// the artwork costs about a minute, and ordinary product code must stop paying it.
test('ordinary product code does not pay for app icon drift', () => {
  for (const path of [
    'apps/desktop/src/renderer/app-shell.tsx',
    'packages/core/src/artifacts.ts',
    'packages/runtime/src/edit-replace.ts',
  ]) {
    assert.equal(planTests([path], { graph }).appIcons, false, path);
  }
});
