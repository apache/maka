import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('release metadata selects installed-package validation', () => {
  assert.equal(planTests(['LICENSE'], { graph }).cliPackage, true);
});

test('desktop-only changes skip installed-package validation', () => {
  assert.equal(planTests(['apps/desktop/src/main.ts'], { graph }).cliPackage, false);
});

test('full selection covers every live surface', () => {
  const plan = planTests([], { graph, forceFull: true });

  assert.equal(plan.full, true);
  assert.equal(plan.cliPackage, true);
  assert.equal(plan.code, true);
  assert.equal(plan.e2e, true);
  assert.equal(plan.storybook, true);
  assert.equal(plan.runtimeHost, true);
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

test('CI planner contracts run before dependency setup on every change', () => {
  const workflow = readWorkflow('ci.yml');
  const testStepStart = workflow.indexOf('      - name: Test CI planner\n');
  const setupNodeStart = workflow.indexOf('      - uses: actions/setup-node@');
  const testStepEnd = workflow.indexOf('\n      - ', testStepStart + 1);

  assert.ok(testStepStart >= 0);
  assert.ok(testStepStart < setupNodeStart);
  assert.doesNotMatch(workflow.slice(testStepStart, testStepEnd), /\n\s+if:/u);
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

test('specialized platform workflows never create pull request jobs', () => {
  const cli = readWorkflow('cli-package-validation.yml');
  const baseline = readWorkflow('windows-baseline.yml');
  const recovery = readWorkflow('windows-recovery.yml');

  for (const workflow of [cli, baseline, recovery]) {
    assert.doesNotMatch(workflow, /\n  pull_request:/u);
    assert.match(workflow, /\n  workflow_dispatch:/u);
  }
  assert.match(cli, /\n  workflow_call:/u);
  assert.match(baseline, /\n  schedule:/u);
});

function readWorkflow(name) {
  return readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
}
