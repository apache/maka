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
    assert.equal(plan.asfSource, false, path);
  }
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

  // Both contracts need nothing but the checkout, so they run on every change
  // rather than behind a surface flag — and a gate that cannot fail the job is
  // not a gate.
  for (const name of ['Test CI planner', 'Check Windows test inventory']) {
    const start = workflow.indexOf(`      - name: ${name}\n`);
    assert.ok(start >= 0, name);
    assert.ok(start < setupNodeStart, name);

    const step = workflow.slice(start, workflow.indexOf('\n      - ', start + 1));
    assert.doesNotMatch(step, /\n\s+if:/u, name);
    assert.doesNotMatch(step, /continue-on-error/u, name);
  }
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
