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
 * What the workflows themselves must say: which triggers a lane carries, which
 * steps a selection gates, and where a lane's path filter has to come from.
 * Behaviour of the planner these assertions refer to lives in
 * `ci-test-plan.test.mjs`.
 *
 * This suite runs before `npm ci` installs anything, so it may import only
 * `node:` builtins and repository modules that do the same. The last test in
 * this file asserts exactly that, for every suite the install-free steps run.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { formatGitHubOutputs, loadWorkspaceGraph, planTests } from './ci-test-plan.mjs';

test('GitHub output matches the selections consumed by CI', () => {
  const output = formatGitHubOutputs(planTests([], { forceFull: true }));
  const outputKeys = new Set(output.split('\n').map((line) => line.split('=', 1)[0]));
  const workflow = readWorkflow('ci.yml');

  // The planner writes one step's outputs and every later step gates on them,
  // so what it emits and what CI reads are the same set. A key nothing reads,
  // or a gate on a key the planner never writes, is a dead lane either way.
  const consumedKeys = new Set(
    [...workflow.matchAll(/steps\.plan\.outputs\.([a-z0-9_]+)/gu)].map((match) => match[1]),
  );

  assert.deepEqual(outputKeys, consumedKeys);
});

test('one unconditional job carries the required context on every pull request', () => {
  const workflow = readWorkflow('ci.yml');

  // `.asf.yaml` requires `test`. A paths filter would stop the workflow and
  // leave that check pending forever, and a second job would make the same
  // pull request queue for a scarce runner twice to reach one verdict.
  assert.doesNotMatch(triggerBlock('ci.yml'), /\bpaths(-ignore)?:/u);

  const jobsBlock = workflow.slice(workflow.indexOf('\njobs:'));
  const jobs = [...jobsBlock.matchAll(/^ {2}([a-z0-9_-]+):$/gmu)].map((match) => match[1]);
  assert.deepEqual(jobs, ['test']);
  assert.doesNotMatch(jobsBlock, /^ {4}needs:/mu);
  assert.doesNotMatch(jobsBlock, /^ {4}if:/mu);
});

test('planning runs first and every later step gates on its outputs', () => {
  const workflow = readWorkflow('ci.yml');

  // With the job split gone there is no `needs` context to read. GitHub
  // resolves a leftover `needs.plan.outputs.x` to the empty string rather
  // than failing, so the step it guards would silently never run again.
  assert.doesNotMatch(workflow, /needs\.plan\.outputs/u);

  const planStep = workflow.indexOf('      - id: plan\n');
  assert.ok(planStep >= 0, 'no planning step');
  assert.ok(planStep < workflow.indexOf('steps.plan.outputs'));
  assert.match(
    workflow,
    /- name: Check renderer architecture\n\s+if: steps\.plan\.outputs\.code == 'true'/u,
  );
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

test('every selection that gates an installed step is one heavy validation covers', () => {
  const workflow = readWorkflow('ci.yml');

  // `heavy` decides whether the toolchain is installed at all, so any later
  // step gated on a selection outside that disjunction would run against a
  // runner with no dependencies — or, if the step is a `run:` that tolerates
  // it, report green having done nothing. Derived from the workflow rather
  // than restated, so a new plan output cannot gate a step without joining
  // the disjunction first.
  const [, installed] = workflow.split(/\n\s+- uses: actions\/setup-node[^\n]*\n/u);
  assert.ok(installed, 'ci.yml no longer installs a toolchain');

  const gating = [
    ...new Set([...installed.matchAll(/steps\.plan\.outputs\.(\w+) ==/gu)].map(([, name]) => name)),
  ].sort();
  assert.ok(gating.length > 0, 'no installed step is gated on a selection');

  // The planner names selections in camelCase and publishes them in snake_case.
  const source = readFileSync(new URL('./ci-test-plan.mjs', import.meta.url), 'utf8');
  const disjunction = source.match(/export function requiresHeavyValidation[\s\S]*?\n\}/u)?.[0];
  assert.ok(disjunction, 'requiresHeavyValidation is no longer a single expression');

  for (const output of gating) {
    if (output === 'heavy') continue;
    const camel = output.replace(/_(\w)/gu, (_, letter) => letter.toUpperCase());
    assert.match(
      disjunction,
      new RegExp(`plan\\.${camel}\\b`, 'u'),
      `${output} gates an installed step but does not select the install`,
    );
  }
});

test('the app icon gate selects every file its own tests open', () => {
  // Derived from the step, not from a memory of it: whatever `App icon artwork
  // drift` runs is the authority on what has to select it. The list this
  // replaces was assembled by reading those tests, which is how the packaging
  // config — opened by path rather than imported — stayed off it while the
  // drift assertion it feeds could be skipped silently.
  const step = readWorkflow('ci.yml').match(
    /if: steps\.plan\.outputs\.app_icons == 'true'\n\s+run: node --test ([^\n]+)/u,
  );
  assert.ok(step, 'no step is gated on the app icon selection');
  const suites = step[1].trim().split(/\s+/u);
  assert.ok(suites.length > 0);

  for (const suite of suites) {
    assert.equal(planTests([suite]).appIcons, true, suite);
    const source = readFileSync(new URL(`../${suite}`, import.meta.url), 'utf8');

    // Every repository path those suites name, however they reach it: a
    // `new URL` read, a relative import, or a directory of artwork.
    const named = [
      ...[...source.matchAll(/new URL\('([^']+)'/gu)].map((match) => match[1]),
      ...[...source.matchAll(/from '(\.[^']+)'/gu)].map((match) => match[1]),
    ].map((path) => new URL(path, new URL(`../${suite}`, import.meta.url)).pathname);

    const root = new URL('..', import.meta.url).pathname;
    for (const absolute of named) {
      // A trailing slash names a directory, so probe inside it as well: the
      // artwork is selected by prefix rather than file by file.
      const path = absolute.slice(root.length).replace(/\/$/u, '');
      const selecting = [path, `${path}/probe`].find(
        (candidate) => planTests([candidate]).appIcons,
      );
      assert.ok(selecting, `${suite} reads ${path}`);

      // The step runs after Build and `generate-app-icons.test.mjs` imports
      // `APP_ICONS` from built `@maka/core`, so an input that selected the
      // drift check without selecting the build would run against no build.
      assert.equal(planTests([selecting]).code, true, `${selecting} skips the build`);
    }
  }
});

test('core CI gates app icon drift on the artwork surface', () => {
  assert.match(
    readWorkflow('ci.yml'),
    /- name: App icon artwork drift\n\s+if: steps\.plan\.outputs\.app_icons == 'true'/u,
  );
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

test('CI installs dependencies whenever the Astryx surface inventory runs', () => {
  const workflow = readWorkflow('ci.yml');
  // The inventory step imports the generator, which resolves @astryxdesign/core
  // and parses the @maka/ui barrel. An inventory-doc-only PR is `astryx_surface`
  // without `code`, so the `npm ci` step must gate on astryx_surface too — else
  // the generator runs with no dependencies installed and fails closed.
  const npmCi = workflow.indexOf('run: npm ci');
  assert.ok(npmCi >= 0, 'expected an `npm ci` install step');
  const stepStart = workflow.lastIndexOf('\n      - name:', npmCi) + 1;
  const stepEnd = workflow.indexOf('\n      - ', npmCi);
  const installStep = workflow.slice(stepStart, stepEnd);
  assert.match(installStep, /steps\.plan\.outputs\.astryx_surface == 'true'/u);
});

test('core CI validates affected installed CLI packages on the heavy runner', () => {
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

test('Rust build caches publish immutable source generations only from the default branch', () => {
  const workflows = readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith('.yml'))
    .map((name) => [name, readWorkflow(name)])
    .filter(([, workflow]) => workflow.includes('tool: kache@0.16.0'));

  assert.equal(workflows.length, 5);
  for (const [name, workflow] of workflows) {
    assert.match(workflow, /echo "revision=\$\(git rev-parse HEAD\)"/u, name);
    const primaryKeys = [...workflow.matchAll(/^\s+key: (kache-[^\n]+)$/gmu)].map(([, key]) => key);
    assert.ok(primaryKeys.length > 0, name);
    const restoreKeys = [...workflow.matchAll(/^\s+(kache-[^\n]+-)$/gmu)].map(([, key]) => key);
    assert.equal(restoreKeys.length, primaryKeys.length, name);
    primaryKeys.forEach((key) => {
      assert.match(key, /\$\{\{ steps\.[^.]+\.outputs\.revision \}\}$/u, name);
      assert.ok(
        restoreKeys.includes(key.replace(/\$\{\{ steps\.[^.]+\.outputs\.revision \}\}$/u, '')),
        name,
      );
    });
    assert.match(
      workflow,
      /name: Save [^\n]*Rust build cache\n\s+if: [^\n]*github\.event\.repository\.default_branch/u,
      name,
    );
    assert.doesNotMatch(workflow, /kache report [^\n]*--since/u, name);
  }
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
  const gates = readdirSync(WORKFLOW_DIR).filter(hasPullRequestGate);
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
  assert.match(triggers, /\n {2}workflow_dispatch:/u);
  assert.match(readWorkflow('windows-recovery.yml'), /\n {4}name: windows_recovery/u);
});

test('no lane asks for the one runner label that queues', () => {
  // `ubuntu-latest` is the only label here whose wait for a runner is not
  // predictable: its median is as good as any pinned label's, but its tail
  // reaches tens of minutes, and the required context is paid at the tail
  // rather than the median. Naming the image instead costs no coverage,
  // because the two resolve to the same image; it costs the automatic image
  // upgrade, which becomes a deliberate commit rather than a silent one.
  // That is the trade this rule makes. To take it back for one lane, change
  // this test — an exemption is worth as much as the review it passes, and
  // no lane needs one today.
  //
  // The literal is banned outright rather than only where a runner is named.
  // `runs-on` reaches a runner through matrix values, inline sequences and
  // `include` objects, so any shape-aware matcher is a second authority that
  // can disagree with GitHub's; under this rule the literal has no legitimate
  // use anywhere, which makes its mere presence the honest contract.
  const workflows = readdirSync(WORKFLOW_DIR).filter(
    (file) => file.endsWith('.yml') || file.endsWith('.yaml'),
  );

  assert.ok(workflows.length > 0, 'no workflows found to check');

  for (const name of workflows) {
    // Comments stripped, so explaining the rule in a workflow cannot break it.
    assert.doesNotMatch(
      readWorkflow(name).replaceAll(/^[ \t]*#.*$/gmu, ''),
      /\bubuntu-latest\b/u,
      `${name}: ubuntu-latest queues for a runner; name the image instead`,
    );
  }
});

test('a lane that filters both triggers filters them on the same paths', () => {
  // These lists decide what a lane looks at, and a lane that looks at one set
  // on a pull request and another on main reports a verdict about a tree
  // nobody validated: green before the merge, or silence after it. Editing
  // one list and not its twin is the way that happens, and it is invisible in
  // a diff that shows only the list being edited.
  //
  // Only when both triggers filter. Dropping the filter from one side is a
  // different and legitimate decision — `windows-recovery.yml` leaves `push`
  // unfiltered on purpose, because `strict: false` lets a pull request go
  // green against a stale base and only the merged tree proves two
  // independently green halves still agree. That choice is deliberate and
  // visible in a diff; a list edited on one side only is neither.
  let checked = 0;

  for (const name of readdirSync(WORKFLOW_DIR).filter((file) => file.endsWith('.yml'))) {
    const pullRequest = pathFilter(name, 'pull_request');
    const push = pathFilter(name, 'push');
    if (!pullRequest?.length || !push?.length) continue;

    assert.deepEqual(push, pullRequest, `${name}: pull_request and push filter different paths`);
    checked += 1;
  }

  assert.ok(checked > 0, 'no lane filters both triggers; this rule now checks nothing');
});

test('installed-package validation discards superseded pull request runs', () => {
  const workflow = readWorkflow('cli-package-validation.yml');

  // This lane fans out to about fourteen jobs per run and holds more runner
  // slots than any other workflow here. A group without this setting does not
  // cancel a superseded run, it queues the replacement behind it, so obsolete
  // work finishes at full price. Release callers reach this through
  // `workflow_call`, where `github.event_name` belongs to the caller, which is
  // what keeps a publication run from ever being cancelled.
  assert.match(
    workflow,
    /group: cli-package-validation-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}/u,
  );
  assert.match(
    workflow,
    /\n {2}cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/u,
  );
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

test('the recovery lane leaves the suites it executes to the required test lane', () => {
  const workflow = readWorkflow('windows-recovery.yml');
  const filtered = new Set(pullRequestPathFilter('windows-recovery.yml'));

  // Derived from the dist paths the steps run, then widened along the workspace
  // dependency graph the planner selects with. The separator class matches the
  // backslash form too, because these steps run under pwsh where both are
  // legal.
  const executed = [
    ...new Set(
      [...workflow.matchAll(/packages[/\\]([^/\\]+)[/\\]dist[/\\]/gu)].map((match) => match[1]),
    ),
  ].sort();
  assert.deepEqual(executed, ['runtime', 'runtime-host', 'storage']);

  // None of that closure belongs in the filter. These suites are ordinary
  // TypeScript, so `test` runs them on Linux on every pull request and fails
  // first; naming their sources here only bought a second, slower red. Listing
  // one again would put this lane back on most merges, so it fails here.
  const closure = dependencyClosure(executed.map((workspace) => `packages/${workspace}`));
  assert.ok(closure.includes('packages/core'), 'dependency closure must reach core');
  for (const dir of closure) {
    for (const entry of [`${dir}/src/**`, `${dir}/tsconfig.json`, `${dir}/package.json`]) {
      assert.ok(!filtered.has(entry), `${entry} belongs to the required test lane`);
    }
  }

  // What the Windows runner proves instead is that the suites still build and
  // run here at all, which is why the unconditional install and build steps stay
  // unconditional even though nothing in the filter names a workspace.
  assert.match(workflow, /\n {6}- name: Install dependencies\n {8}run: npm\.cmd ci\n/u);
  assert.match(workflow, /\n {8}run: npm\.cmd run build:test\n/u);
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

test('the recovery lane filters pull requests by what only Windows can prove', () => {
  const filtered = new Set(pullRequestPathFilter('windows-recovery.yml'));

  // What is left after the workspace sources came out: how `npm.cmd ci` resolves
  // and what it produces on Windows, what `npm.cmd run build:test` cleans up
  // there, and a PowerShell script this lane is the only caller of. Each of
  // these can be green on Linux and red here, which is the whole test for
  // membership in this list.
  for (const path of [
    'package-lock.json',
    'patches/**',
    'scripts/apply-dependency-patches.mjs',
    'scripts/install-electron-with-retry.mjs',
    'scripts/run-electron-installer.cjs',
    'scripts/clean-build.mjs',
    'scripts/clean-paths.mjs',
    'scripts/windows-runtime-host-local-ipc-trust.ps1',
    '.github/workflows/windows-recovery.yml',
  ]) {
    assert.ok(filtered.has(path), path);
  }
});

/**
 * Filtered lanes with no automatic path that runs them when the filter misses.
 * Each one first observes a transitive edit it cannot match wherever that edit
 * eventually lands, which for a release lane is release day. They predate the
 * gates narrowed here and are listed rather than fixed so the gap is countable.
 */
const LANES_WITHOUT_A_FILTER_ESCAPE = new Set([
  // Both pair the pull request with a `push: main` carrying the same filter,
  // which observes the same set and so is not an escape at all.
  'gitoxide-helper-admission.yml',
  'runtime-host-peer-admission.yml',
  // Pairs it with `workflow_dispatch`, which nothing fires on its own.
  'runtime-host-owner-platform.yml',
]);

test('a filtered pull-request lane can still run when its filter misses', () => {
  // A path filter is a pre-filter, not the lane's import closure, so an edit it
  // cannot match is invisible to it. Something must therefore run the lane
  // without consulting the filter: a schedule, an unfiltered push, or a caller
  // that reaches it through `workflow_call`. Enumerated over the directory
  // rather than asserted lane by lane, because the three hand-written pairings
  // this replaces covered three lanes and missed every other one — including
  // `release-windows-check.yml`, whose filter was narrowed in this branch.
  const uncovered = [];
  for (const name of readdirSync(WORKFLOW_DIR).filter((file) => file.endsWith('.yml'))) {
    const triggers = triggerBlock(name);
    if (!/\n {2}pull_request:\n(?:(?: {4}[^\n]*)?\n)* {4}paths:/u.test(triggers)) continue;

    const push = triggers.match(/\n {2}push:\n(?:(?: {4,}[^\n]*)?\n)*/u)?.[0] ?? '';
    const escapes =
      /\n {2}schedule:/u.test(triggers) ||
      /\n {2}workflow_call:/u.test(triggers) ||
      (push !== '' && !/\bpaths(-ignore)?:/u.test(push));
    if (!escapes) uncovered.push(name);
  }

  assert.deepEqual(uncovered.sort(), [...LANES_WITHOUT_A_FILTER_ESCAPE].sort());
});

test('the packaged Windows gate triggers on release orchestration changes', () => {
  const workflow = readWorkflow('release-windows-check.yml');

  assert.match(workflow, /'\.github\/workflows\/release\.yml'/u);
});

test('the packaged Windows gate workflow is itself a release-contract input', () => {
  assert.equal(planTests(['.github/workflows/release-windows-check.yml']).releaseContract, true);
  assert.match(
    readWorkflow('release-windows-check.yml'),
    /'\.github\/workflows\/release-windows-check\.yml'/u,
  );
});

test('the packaged Windows gate triggers on the worker copy step it cannot import', () => {
  // The seven `packages/` entries this used to restate are held by
  // `windows-package-source-closure.test.mjs`, which computes the filter's
  // `packages/` half from the import closure and fails in both directions.
  // This one is outside that half: the desktop app copies the built worker in,
  // so no import reaches it and only naming it keeps it on the lane.
  assert.ok(
    readWorkflow('release-windows-check.yml').includes(
      "      - 'apps/desktop/scripts/copy-runtime-filesystem-worker.mjs'",
    ),
  );
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
  assert.match(recovery, /# tests 91/u);
  assert.match(recovery, /# pass 91/u);
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

test('every suite that runs before dependency setup imports only node builtins', () => {
  // The steps above `setup-node` run against a bare checkout, so a suite there
  // that imports a devDependency throws `ERR_MODULE_NOT_FOUND` and turns the
  // one required context red on every pull request — no merge, anywhere, until
  // someone notices. Nothing about the file says so, which is how a closure
  // assertion needing esbuild was very nearly added to one of them.
  //
  // Derived from the workflow: whichever suites those steps name are the ones
  // that carry the constraint, so moving a step below the install lifts it and
  // adding a step above imposes it, without anyone editing this test.
  const workflow = readWorkflow('ci.yml');
  const [installFree] = workflow.split(/\n\s+- uses: actions\/setup-node[^\n]*\n/u);
  const suites = [
    ...new Set(
      [...installFree.matchAll(/(scripts\/[\w.-]+\.test\.mjs)/gu)].map(([, path]) => path),
    ),
  ].sort();
  assert.ok(suites.length > 0, 'no suite runs before dependency setup');

  // The constraint is transitive: a local module may be imported only if it too
  // stays inside `node:`.
  const pending = [...suites];
  const seen = new Set(pending);
  while (pending.length > 0) {
    const path = pending.shift();
    const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    for (const [, specifier] of source.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gmu)) {
      if (specifier.startsWith('node:')) continue;
      assert.ok(
        specifier.startsWith('.'),
        `${path} imports ${specifier}, which is not installed when it runs`,
      );
      const resolved = new URL(specifier, new URL(`../${path}`, import.meta.url)).pathname.slice(
        new URL('..', import.meta.url).pathname.length,
      );
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      pending.push(resolved);
    }
  }
});

const WORKFLOW_DIR = new URL('../.github/workflows/', import.meta.url);

/**
 * Reads the `paths` list belonging to a workflow's `pull_request` trigger.
 * Anchoring to the trigger, instead of matching entry text anywhere in the
 * file, is what makes the filter assertions fail when entries move under
 * `paths-ignore`, under another trigger, or out of `on:` altogether.
 */
function pullRequestPathFilter(name) {
  const paths = pathFilter(name, 'pull_request');
  assert.ok(paths !== null, `${name}: no pull_request trigger`);

  return paths;
}
// Returns the trigger's `paths:` entries in order, or null when the workflow
// does not carry that trigger at all — which is what lets a caller tell "no
// such trigger" apart from "this trigger runs on everything".
//
// Reads the `on:` block with comments already stripped, so a comment between
// the trigger and its list cannot end the scan, and accepts the quoting and
// spacing YAML allows, so a legal rewrite reports the entries it really has
// instead of an empty list that reads as a missing filter.
function pathFilter(name, trigger) {
  const lines = triggerBlock(name).split('\n');
  const start = lines.findIndex((line) => new RegExp(`^ {2}${trigger}:\\s*$`, 'u').test(line));
  if (start < 0) return null;

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
  const block = triggerBlock(name);
  if (!/\bpull_request(_target)?\b/u.test(block)) return false;

  // Event-only maintenance workflows may listen for a lifecycle action without
  // becoming a normal pull-request validation lane. They do not belong in the
  // scarce-runner allowlist or its timeout tier.
  return !/pull_request(?:_target)?:\s*\n\s+types:\s*\[\s*reopened\s*\]/u.test(block);
}

function hasPullRequestGate(name) {
  const block = triggerBlock(name);
  return /^\s*pull_request:\s*$/mu.test(block) && hasPullRequestTrigger(name);
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
