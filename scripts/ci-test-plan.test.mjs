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

import { formatGitHubOutputs, planTests } from './ci-test-plan.mjs';

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
    'apps/desktop/build/entitlements.mac.plist',
    'apps/desktop/electron-builder.config.mjs',
    'apps/desktop/package.json',
    '.github/workflows/cli-package-validation.yml',
    '.github/workflows/release-cli-finalize.yml',
    '.github/workflows/release-cli-stage.yml',
    '.github/workflows/release.yml',
    'scripts/package-macos-arm64.mjs',
    'scripts/package-macos-arm64-cli.mjs',
    'scripts/package-windows-x64.mjs',
    'scripts/prepare-windows-upgrade-baseline.mjs',
    'scripts/product-release-artifacts.mjs',
    'scripts/product-release-artifacts.test.mjs',
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
    'scripts/verify-packaged-app.mjs',
    'scripts/verify-windows-x64.mjs',
    'scripts/windows-upgrade-baseline.json',
  ]) {
    assert.equal(planTests([path], { graph }).releaseContract, true, path);
  }
  assert.equal(planTests(['.github/RELEASE_CHECKLIST.md'], { graph }).releaseContract, false);
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
    'copilot-auto-review.yml',
    'dependency-audit.yml',
    'release-windows-check.yml',
    'windows-sandbox-w0.yml',
  ]);
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

test('workflows never persist the job credential into the checkout', () => {
  for (const name of readdirSync(WORKFLOW_DIR)) {
    for (const step of checkoutSteps(name)) {
      assert.match(step, /persist-credentials: false/u, `${name}: ${step.trim()}`);
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

function readWorkflow(name) {
  return readFileSync(new URL(name, WORKFLOW_DIR), 'utf8');
}

/**
 * Reads the `on:` block only, so a workflow cannot escape a trigger contract by
 * writing `on: [pull_request]`, and prose elsewhere in the file cannot fake one.
 */
function hasPullRequestTrigger(name) {
  const withoutComments = readWorkflow(name).replaceAll(/^[ \t]*#.*$/gmu, '');
  const triggers = withoutComments.match(/^on:(.*(?:\n(?![^\s#]).*)*)/mu)?.[1] ?? '';

  return /\bpull_request(_target)?\b/u.test(triggers);
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
