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

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { formatGitHubOutputs, loadWorkspaceGraph, planTests } from './ci-test-plan.mjs';

const dirs = [
  'packages/core',
  'packages/storage',
  'packages/runtime',
  'packages/runtime-host',
  'packages/cli',
  'packages/ui',
  'apps/desktop',
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
  ]),
  testDirs: new Set(dirs),
};

test('documentation-only changes do not select code validation', () => {
  const plan = planTests(['docs/ci.md'], { graph });

  assert.equal(plan.code, false);
  assert.equal(plan.asfSource, false);
  assert.equal(plan.astryxSurface, false);
  assert.deepEqual(plan.workspaces, []);
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
    'packages/core/src/model-metadata.generated.ts',
    'packages/runtime/src/telemetry/model-pricing.generated.ts',
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
    'scripts/package-macos-arm64.mjs',
    'scripts/package-macos-autoupdate-next.mjs',
    'scripts/package-macos-arm64-cli.mjs',
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
    'scripts/verify-macos-arm64-dmg.mjs',
    'scripts/verify-macos-autoupdate.mjs',
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

test('full-suite authority files select every surface', () => {
  for (const path of ['package-lock.json', '.github/workflows/ci.yml']) {
    assert.equal(planTests([path], { graph }).full, true, path);
  }
});

test('GitHub output matches the selections consumed by CI', () => {
  const output = formatGitHubOutputs(planTests([], { graph, forceFull: true }));
  const outputKeys = new Set(output.split('\n').map((line) => line.split('=', 1)[0]));
  const workflow = readWorkflow('ci.yml');
  const consumedKeys = new Set(
    [...workflow.matchAll(/steps\.plan\.outputs\.([a-z0-9_]+)/gu)].map((match) => match[1]),
  );

  assert.deepEqual(outputKeys, consumedKeys);
});

test('core CI validates pull requests and the resulting main branch state', () => {
  const workflow = readWorkflow('ci.yml');

  assert.match(workflow, /pull_request:\n\s+branches: \[main\]/u);
  assert.match(workflow, /push:\n\s+branches: \[main\]/u);
  assert.match(
    workflow,
    /BASE_SHA: \$\{\{ github\.event_name == 'push' && github\.event\.before \|\| github\.event\.pull_request\.base\.sha \}\}/u,
  );
  assert.match(
    workflow,
    /HEAD_SHA: \$\{\{ github\.event_name == 'push' && github\.sha \|\| github\.event\.pull_request\.head\.sha \}\}/u,
  );
  assert.match(workflow, /\[\[ "\$BASE_SHA" =~ \^0\+\$ \]\]/u);
});

test('core CI uses the Windows inventory package-script authority', () => {
  const workflow = readWorkflow('ci.yml');

  assert.match(workflow, /run: npm run windows:inventory/u);
  assert.doesNotMatch(workflow, /run: node scripts\/windows-test-inventory\.mjs --check/u);
});

test('contract checks run before dependency setup and can fail the job', () => {
  const workflow = readWorkflow('ci.yml');
  const setupNodeStart = workflow.indexOf('      - uses: actions/setup-node@');

  // These contracts need nothing but the checkout, so they run on every change
  // rather than behind a surface flag — and a gate that cannot fail the job is
  // not a gate.
  for (const name of [
    'Test CI planner',
    'Check Windows test inventory',
    'Verify ASF npm preflight policy',
  ]) {
    const start = workflow.indexOf(`      - name: ${name}\n`);
    assert.ok(start >= 0, name);
    assert.ok(start < setupNodeStart, name);

    const step = workflow.slice(start, workflow.indexOf('\n      - ', start + 1));
    assert.doesNotMatch(step, /\n\s+if:/u, name);
    assert.doesNotMatch(step, /continue-on-error/u, name);
  }
});

test('core CI checks the Astryx inventory for every code change before building', () => {
  const workflow = readWorkflow('ci.yml');
  const inventoryStart = workflow.indexOf('      - name: Astryx surface inventory\n');
  const inventoryEnd = workflow.indexOf('\n      - ', inventoryStart + 1);
  const buildStart = workflow.indexOf('      - name: Build\n');

  assert.ok(inventoryStart >= 0);
  assert.ok(inventoryStart < buildStart);

  const inventoryStep = workflow.slice(inventoryStart, inventoryEnd);
  assert.match(
    inventoryStep,
    /if: steps\.plan\.outputs\.code == 'true' \|\| steps\.plan\.outputs\.astryx_surface == 'true'/u,
  );
  assert.doesNotMatch(inventoryStep, /continue-on-error/u);
});

test('core CI validates affected installed CLI packages on its existing runner', () => {
  const workflow = readWorkflow('ci.yml');
  const toolchain = workflow.indexOf(
    'npm install --global --no-audit --no-fund "$(node -p \'require("./package.json").packageManager\')"',
  );
  const pack = workflow.indexOf('run: npm run release:cli:pack');

  assert.match(workflow, /if: steps\.plan\.outputs\.cli_package == 'true'/u);
  assert.ok(toolchain >= 0);
  assert.ok(toolchain < pack);
  assert.match(workflow, /run: npm run release:cli:smoke/u);
});

test('release contracts run against built CLI outputs', () => {
  const workflow = readWorkflow('ci.yml');
  const buildIndex = workflow.indexOf('      - name: Build\n');
  const buildEnd = workflow.indexOf('\n      - ', buildIndex + 1);
  const releaseIndex = workflow.indexOf('      - name: Release contracts\n');

  assert.ok(buildIndex >= 0);
  assert.match(workflow.slice(buildIndex, buildEnd), /release_contract == 'true'/u);
  assert.ok(buildIndex < releaseIndex);
  assert.match(
    workflow.slice(releaseIndex),
    /if: steps\.plan\.outputs\.release_contract == 'true'/u,
  );
});

test('pull request triggers stay on an explicit allowlist', () => {
  // Naming the lanes that must not run on pull requests only covers the ones
  // someone remembered to name; W0 kept an unbounded trigger that way.
  const onPullRequests = readdirSync(WORKFLOW_DIR).filter(hasPullRequestTrigger).sort();

  assert.deepEqual(onPullRequests, [
    'ci.yml',
    'cli-package-validation.yml',
    'copilot-auto-review.yml',
    'dependency-audit.yml',
    'gitoxide-helper-admission.yml',
    'pr-effort-label.yml',
    'release-windows-check.yml',
    'runtime-host-owner-platform.yml',
    'runtime-host-peer-admission.yml',
    'windows-recovery.yml',
    'windows-sandbox-w0.yml',
  ]);
});

test('every pull request lane holds a scarce runner for the same bounded time', () => {
  // One tier, not per-lane values. The worst observed successful runs are 19
  // minutes (ci.yml) and 20 (release-windows-check), so 45 is about 2.3x the
  // slowest lane: enough headroom for a cold cache and a flake retry, and far
  // short of the 120 and 90 a hung job used to hold. A lane with no limit at
  // all inherits GitHub's 360 and fails here.
  // `pull_request` only: a `pull_request_target` lane reads the pull request
  // rather than gating it, so it is not competing for a runner the author is
  // waiting on and keeps its own tighter limit.
  // Granularity is the file, not the job: a job inside a gating workflow that
  // opts out of pull requests still carries the tier, because reading a job's
  // `if:` would need the YAML parser this file cannot install.
  const gates = readdirSync(WORKFLOW_DIR).filter((name) =>
    /\bpull_request\b/u.test(triggerBlock(name)),
  );
  assert.ok(gates.length > 0, 'no pull request lane found');

  for (const name of gates) {
    // From `jobs:` on, with comment lines stripped, so prose above the triggers
    // cannot be read as a job.
    const workflow = readWorkflow(name).replaceAll(/^[ \t]*#.*$/gmu, '');
    const start = workflow.indexOf('\njobs:');
    assert.ok(start >= 0, `${name}: no jobs block`);
    const jobs = workflow.slice(start);

    const limits = [...jobs.matchAll(/^ {4}timeout-minutes: (\d+)$/gmu)].map((match) => match[1]);
    // Counted by `runs-on`, one per job that consumes a runner, rather than by
    // job id: a quoted id escapes an id pattern, and a two-space line inside a
    // `run: |` block satisfies one.
    const runners = [...jobs.matchAll(/^ {4}runs-on:/gmu)].length;
    assert.ok(runners > 0, `${name}: no job consumes a runner`);
    assert.deepEqual(
      limits,
      Array.from({ length: runners }, () => '45'),
      name,
    );
  }
});

test('the recovery lane pairs its path filter with a nightly run and a main push', () => {
  // Read from the `on:` block with comments stripped, so documenting a trigger
  // cannot break its contract.
  const triggers = triggerBlock('windows-recovery.yml');

  // Same contract as the sandbox lane: the filter is a pre-filter, not the
  // lane's import closure, so dropping the schedule would silently lose every
  // transitive edit it cannot match, and dropping the filter would put every
  // Windows recovery run back on every pull request. The main push carries no
  // filter because `strict: false` lets a stale-base pull request go green,
  // and because a paths filter only sees the first 300 files of a diff.
  // Stripped comment lines survive as blank ones, so the gap between the
  // trigger and its list is any mix of blank and four-space lines.
  assert.match(triggers, /\n {2}pull_request:\n(?:(?: {4}[^\n]*)?\n)* {4}paths:/u);
  assert.match(triggers, /\n {2}push:\n {4}branches: \[main\]\n/u);
  assert.doesNotMatch(
    triggers.match(/\n {2}push:\n(?:(?: {4}[^\n]*)?\n)*/u)?.[0] ?? '',
    /\bpaths(-ignore)?:/u,
  );
  assert.match(triggers, /\n {2}schedule:\n/u);
  assert.match(triggers, /\n {2}workflow_dispatch:/u);
  assert.match(readWorkflow('windows-recovery.yml'), /\n {4}name: windows_recovery/u);
});

test('the recovery lane keeps every run kind out of one shared concurrency group', () => {
  const workflow = readWorkflow('windows-recovery.yml');

  // github.head_ref is a bare branch name, so two forks pushing their own
  // `main` would share a group and cancel each other; github.ref is
  // refs/heads/main for the nightly, a dispatch and a main push alike, so a
  // ref-keyed group made a dispatch queue behind the nightly and let the next
  // dispatch discard it while pending.
  assert.match(
    workflow,
    /group: windows-recovery-\$\{\{ github\.event\.pull_request\.number \|\| github\.run_id \}\}/u,
  );
  assert.match(workflow, /\n {2}cancel-in-progress: true/u);
});

test('the recovery lane filters pull requests by the workspaces its steps execute', () => {
  const workflow = readWorkflow('windows-recovery.yml');
  const filtered = new Set(pullRequestPathFilter('windows-recovery.yml'));

  // Derived from the dist paths the steps run, then widened along the workspace
  // dependency graph the planner selects with. The separator class matches the
  // backslash form too, because these steps run under pwsh where both are
  // legal. A new workspace on this lane, or a new dependency under one of them,
  // fails here until the filter admits its sources and project file.
  const executed = [
    ...new Set(
      [...workflow.matchAll(/packages[/\\]([^/\\]+)[/\\]dist[/\\]/gu)].map((match) => match[1]),
    ),
  ].sort();
  assert.deepEqual(executed, ['runtime', 'runtime-host', 'storage']);

  const closure = dependencyClosure(executed.map((workspace) => `packages/${workspace}`));
  assert.ok(closure.includes('packages/core'), 'dependency closure must reach core');
  for (const dir of closure) {
    assert.ok(filtered.has(`${dir}/src/**`), `${dir}: sources`);
    assert.ok(filtered.has(`${dir}/tsconfig.json`), `${dir}: project file`);
    assert.ok(filtered.has(`${dir}/package.json`), `${dir}: manifest`);
  }
});

test('the recovery lane filter follows the postinstall launcher chain', () => {
  const filtered = new Set(pullRequestPathFilter('windows-recovery.yml'));
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  // Derived from postinstall itself, then one hop into whatever those entry
  // points launch, because a launcher the filter cannot see still decides what
  // `npm ci` produces on Windows. A restated list missed exactly that hop.
  const entrypoints = [...manifest.scripts.postinstall.matchAll(/node (scripts\/[\w.-]+)/gu)].map(
    (match) => match[1],
  );
  assert.ok(entrypoints.length > 0, 'postinstall runs no script');

  for (const entrypoint of entrypoints) {
    assert.ok(filtered.has(entrypoint), entrypoint);
    const source = readFileSync(new URL(`../${entrypoint}`, import.meta.url), 'utf8');
    for (const launched of source.matchAll(/new URL\('\.\/([\w.-]+)'/gu)) {
      assert.ok(filtered.has(`scripts/${launched[1]}`), `${entrypoint} launches ${launched[1]}`);
    }
  }
});

test('the recovery lane filters pull requests by what its install and clean steps consume', () => {
  const filtered = new Set(pullRequestPathFilter('windows-recovery.yml'));

  // `npm.cmd ci` and `npm.cmd run build:test` run unconditionally, so these are
  // first-class inputs of the lane rather than transitive edits the nightly can
  // be left to cover. A grouped dependabot bump touches only the manifests, and
  // the crash gates sit on a native file lock the Linux `test` lane never sees.
  for (const path of [
    'package.json',
    'package-lock.json',
    'patches/**',
    'scripts/apply-dependency-patches.mjs',
    'scripts/install-electron-with-retry.mjs',
    'scripts/clean-build.mjs',
    'scripts/clean-paths.mjs',
    'scripts/windows-runtime-host-local-ipc-trust.ps1',
    'tsconfig.base.json',
    'tsconfig.lib.json',
    'packages/runtime/scripts/**',
    '.github/workflows/windows-recovery.yml',
  ]) {
    assert.ok(filtered.has(path), path);
  }
});

test('the sandbox lane pairs its path filter with a nightly run', () => {
  const workflow = readWorkflow('windows-sandbox-w0.yml');

  // The filter is a pre-filter, not the lane's import closure, so dropping the
  // schedule would silently lose every transitive edit it cannot match, and
  // dropping the filter would put the whole runtime back on pull requests.
  assert.match(workflow, /\n {2}pull_request:\n {4}paths:/u);
  assert.match(workflow, /\n {2}schedule:/u);
});

test('the packaged Windows gate owns Runtime Host candidate election changes', () => {
  const workflow = readWorkflow('release-windows-check.yml');

  assert.match(workflow, /'packages\/runtime-host\/src\/client\/connect-or-spawn\.ts'/u);
  assert.match(workflow, /'packages\/runtime-host\/src\/client\/launcher\.ts'/u);
});

test('the packaged Windows gate triggers on release orchestration changes', () => {
  const workflow = readWorkflow('release-windows-check.yml');

  assert.match(workflow, /'\.github\/workflows\/release\.yml'/u);
});

test('the packaged Windows gate workflow is itself a release-contract input', () => {
  assert.equal(
    planTests(['.github/workflows/release-windows-check.yml'], { graph }).releaseContract,
    true,
  );
  assert.match(
    readWorkflow('release-windows-check.yml'),
    /'\.github\/workflows\/release-windows-check\.yml'/u,
  );
});

test('the packaged Windows gate triggers on packaged sandbox inputs', () => {
  const workflow = readWorkflow('release-windows-check.yml');

  for (const path of [
    'apps/desktop/scripts/copy-runtime-filesystem-worker.mjs',
    'packages/runtime/scripts/build-filesystem-worker.mjs',
    'packages/runtime/src/filesystem-worker/**',
    'packages/runtime/src/sandbox/**',
    'packages/runtime/src/path-containment.ts',
    'packages/runtime/src/sandbox-boundary-path.ts',
    'packages/core/src/permission-profile.ts',
    'packages/core/src/permission-profile-compiler.ts',
  ]) {
    assert.ok(workflow.includes(`      - '${path}'`), path);
  }
});

test('pull-request and release lanes share the packaged sandbox lifecycle verifier', () => {
  for (const name of ['release-windows-check.yml', 'release.yml']) {
    assert.match(readWorkflow(name), /npm run verify:windows-x64/u, name);
  }

  const verifier = readFileSync(new URL('verify-windows-x64.mjs', import.meta.url), 'utf8');
  assert.match(
    verifier,
    /await verifyPackagedWindowsSandboxLifecycle\(sandboxExecutable, \{ run \}\)/u,
  );
});

test('the Gitoxide gate owns repository admission changes', () => {
  const workflow = readWorkflow('gitoxide-helper-admission.yml');

  assert.match(
    workflow,
    /'packages\/runtime-host\/src\/server\/gitoxide-repository-admission-authority-internal\.ts'/u,
  );
  assert.match(
    workflow,
    /'packages\/runtime-host\/src\/__tests__\/gitoxide-repository-admission-authority-internal\.test\.ts'/u,
  );
});

test('specialized platform workflows stay reachable without pull requests', () => {
  const cli = readWorkflow('cli-package-validation.yml');
  const baseline = readWorkflow('windows-baseline.yml');
  const recovery = readWorkflow('windows-recovery.yml');

  for (const workflow of [cli, baseline, recovery]) {
    assert.match(workflow, /\n  workflow_dispatch:/u);
  }
  assert.match(cli, /\n  workflow_call:/u);
  assert.match(baseline, /\n  schedule:/u);
});

test('Windows recovery executes the exact managed dependency ADS regressions', () => {
  const recovery = readWorkflow('windows-recovery.yml');

  assert.match(recovery, /name: Verify managed dependency alternate streams/u);
  assert.match(recovery, /--test-name-pattern="NTFS alternate stream"/u);
  assert.match(
    recovery,
    /packages\/storage\/dist\/__tests__\/managed-dependency-environment\.test\.js/u,
  );
  assert.match(recovery, /# tests 3/u);
  assert.match(recovery, /# pass 3/u);
  assert.match(recovery, /# skipped 0/u);
});

test('Windows recovery executes the root initialization replacement race', () => {
  const recovery = readWorkflow('windows-recovery.yml');

  assert.match(recovery, /name: Verify root initialization replacement race/u);
  assert.match(
    recovery,
    /--test-name-pattern="rejects replacement before opening the temporary marker"/u,
  );
  assert.match(recovery, /packages\/storage\/dist\/__tests__\/root-authority\.test\.js/u);
  assert.match(recovery, /# tests 1/u);
  assert.match(recovery, /# pass 1/u);
  assert.match(recovery, /# skipped 0/u);
});

test('Windows recovery executes the complete Skill catalog suite', () => {
  const recovery = readWorkflow('windows-recovery.yml');

  assert.match(recovery, /skill-catalog-coordinator\.test\.js/u);
  assert.match(recovery, /skill-catalog-protocol\.test\.js/u);
  assert.match(recovery, /skill-catalog-repository\.test\.js/u);
  assert.match(recovery, /skill-catalog-transaction\.test\.js/u);
  assert.match(recovery, /skill-catalog-two-client-uds\.test\.js/u);
  assert.match(recovery, /# tests 90/u);
  assert.match(recovery, /# pass 90/u);
  assert.match(recovery, /# skipped 0/u);
});

test('workflows never persist the job credential into the checkout', () => {
  for (const name of readdirSync(WORKFLOW_DIR)) {
    for (const step of checkoutSteps(name)) {
      assert.match(step, /persist-credentials: false/u, `${name}: ${step.trim()}`);
    }
  }
});

test('a pull_request_target checkout is pinned to the trusted base commit', () => {
  // This event hands the job a writable token while the pull request is fork
  // controlled, so what gets checked out is what decides whether that token can
  // reach author-supplied code. `github.sha` is the base branch commit here;
  // `head.sha` and a bare checkout under a merge-ref event are both the pull
  // request's own tree. Nothing else in CI would notice that edit, which is why
  // the rule lives here rather than in a comment.
  for (const name of readdirSync(WORKFLOW_DIR)) {
    if (!/\bpull_request_target\b/u.test(triggerBlock(name))) continue;

    for (const step of checkoutSteps(name)) {
      assert.match(step, /\n\s+ref: \$\{\{ github\.sha \}\}\n/u, `${name}: ${step.trim()}`);
    }
  }
});

test('core CI runs the live Eval proxy lifecycle when Eval is selected', () => {
  const workflow = readWorkflow('ci.yml');
  const evalPackage = JSON.parse(
    readFileSync(new URL('../packages/eval/package.json', import.meta.url), 'utf8'),
  );

  assert.match(
    workflow,
    /if: contains\(steps\.plan\.outputs\.standard_workspaces, 'packages\/eval'\)/u,
  );
  assert.match(workflow, /MAKA_EVAL_EGRESS_PROXY_TEST: '1'/u);
  assert.match(workflow, /docker build[\s\S]*maka-eval-egress-proxy:12\.2\.3/u);
  assert.match(workflow, /npm --workspace @maka\/eval run test:egress-proxy:live/u);
  assert.equal(
    evalPackage.scripts['test:egress-proxy:live'],
    'python3 harbor/test_egress_filter_live.py',
  );
  assert.doesNotMatch(evalPackage.scripts['test:dist'], /test_egress_filter_live\.py/u);
});

const WORKFLOW_DIR = new URL('../.github/workflows/', import.meta.url);

/**
 * Reads the `paths` list belonging to a workflow's `pull_request` trigger.
 * Anchoring to the trigger, instead of matching entry text anywhere in the
 * file, is what makes the filter assertions fail when entries move under
 * `paths-ignore`, under another trigger, or out of `on:` altogether.
 */
function pullRequestPathFilter(name) {
  // Reads the `on:` block with comments already stripped, so a comment between
  // the trigger and its list cannot end the scan, and accepts the quoting and
  // spacing YAML allows, so a legal rewrite reports the entries it really has
  // instead of an empty list that reads as a missing filter.
  const lines = triggerBlock(name).split('\n');
  const start = lines.findIndex((line) => /^ {2}pull_request:\s*$/u.test(line));
  assert.ok(start >= 0, `${name}: no pull_request trigger`);

  const paths = [];
  let inPaths = false;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue;
    if (/^ {0,2}\S/u.test(line)) break;
    if (/^ {4}\S/u.test(line)) {
      inPaths = /^ {4}paths:\s*$/u.test(line);
      continue;
    }
    const entry = inPaths ? /^\s+-\s+['"]?(.+?)['"]?\s*$/u.exec(line) : null;
    if (entry) paths.push(entry[1]);
  }
  return paths;
}

/**
 * Workspace dirs `seeds` depend on, transitively, read off the same graph the
 * planner selects with rather than a second definition of the same edges. The
 * graph stores dependents, so a dependency is any dir listing one of ours.
 */
function dependencyClosure(seeds) {
  const graph = loadWorkspaceGraph();
  const selected = new Set(seeds);
  const pending = [...seeds];
  while (pending.length > 0) {
    const dir = pending.shift();
    for (const [dependency, dependents] of graph.dependents) {
      if (!dependents.has(dir) || selected.has(dependency)) continue;
      selected.add(dependency);
      pending.push(dependency);
    }
  }
  return [...selected].sort();
}

function readWorkflow(name) {
  return readFileSync(new URL(name, WORKFLOW_DIR), 'utf8');
}

/**
 * Reads the `on:` block only, so a workflow cannot escape a trigger contract by
 * writing `on: [pull_request]`, and prose elsewhere in the file cannot fake one.
 */
function triggerBlock(name) {
  const withoutComments = readWorkflow(name).replaceAll(/^[ \t]*#.*$/gmu, '');

  return withoutComments.match(/^on:(.*(?:\n(?![^\s#]).*)*)/mu)?.[1] ?? '';
}

function hasPullRequestTrigger(name) {
  return /\bpull_request(_target)?\b/u.test(triggerBlock(name));
}

/**
 * Slices each checkout step from its `uses:` line to the next step, so the
 * assertion is per checkout: a bare one cannot be balanced out by a sibling
 * step that opts out, or by the string appearing in a comment.
 */
function checkoutSteps(name) {
  const withoutComments = readWorkflow(name).replaceAll(/^[ \t]*#.*$/gmu, '');

  return (
    withoutComments.match(/^[ \t]*- uses: actions\/checkout@.*\n(?:(?![ \t]*- )[ \t]+.*\n)*/gmu) ??
    []
  );
}
