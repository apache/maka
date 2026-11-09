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
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { checkResults, createPlan, documentation } from './ci/plan.mjs';
import { suites } from './ci/suites.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const full = () =>
  createPlan({ root, changes: null, metadata: {}, revision: 'test-revision', baseline: null });
const successful = () =>
  Object.fromEntries(
    ['plan', 'tooling', 'suites', 'root-build', 'root-tests', 'desktop-build', 'desktop-tests'].map(
      (id) => [id, { result: 'success' }],
    ),
  );

test('every job selected by a full plan must report success, not merely admission or build', () => {
  const plan = full();
  assert.ok(plan.suites.root);
  assert.ok(plan.suites.desktop);
  assert.ok(plan.workers.some((worker) => worker.id === 'native-windows'));
  assert.ok(plan.workers.some((worker) => worker.id === 'native-macos'));
  assert.doesNotThrow(() => checkResults(plan, successful(), true));
  for (const id of Object.keys(successful())) {
    for (const result of ['skipped', 'cancelled', 'failure', undefined]) {
      const results = successful();
      if (result === undefined) delete results[id];
      else results[id] = { result };
      assert.throws(
        () => checkResults(plan, results, true),
        /Required CI jobs did not succeed/,
        id + ': ' + result,
      );
    }
  }
});

test('a planned Root cannot go green on missing or zero test-selection evidence', () => {
  for (const filter of ['all()', 'package(=maka-cli)']) {
    const plan = full();
    plan.suites.root.filter = filter;
    for (const reported of [undefined, false]) {
      assert.throws(
        () => checkResults(plan, successful(), reported),
        /Root producer did not report|unexpectedly empty/,
      );
    }
    const missingRunner = successful();
    delete missingRunner['root-tests'];
    assert.throws(() => checkResults(plan, missingRunner, true), /root-tests/);
  }
});

test('an embedded product Markdown change selects its actual runtime consumers', () => {
  for (const path of [
    'skills/maka-plugin-authoring/SKILL.md',
    'platform/computer-use/skills/computer.md',
  ]) {
    assert.equal(documentation(path), false);
    const plan = createPlan({
      root,
      changes: [path],
      metadata: {},
      revision: 'test',
      baseline: 'base',
    });
    assert.equal(plan.full, false);
    assert.ok(plan.suites.root);
    assert.ok(plan.suites.desktop);
    assert.equal(plan.suites.root.filter, 'all()');
    assert.match(plan.suites.root.reason, /runtime inputs/);
  }
});

test('helper process changes reach integration consumers outside the Cargo dependency edges', () => {
  const packages = [
    ['maka-python-runtime', 'platform/python-runtime'],
    ['maka-cli', 'products/maka/cli'],
    ['maka-agent-native', 'plugins/agent/native'],
    ['maka-computer-native', 'plugins/computer/native'],
  ].map(([name, path]) => ({
    name,
    id: name,
    source: null,
    manifest_path: join(root, path, 'Cargo.toml'),
  }));
  const metadata = {
    root: {
      packages,
      workspace_members: packages.map((pkg) => pkg.id),
      resolve: { nodes: packages.map((pkg) => ({ id: pkg.id, deps: [] })) },
    },
  };
  const plan = createPlan({
    root,
    changes: ['platform/python-runtime/src/worker.rs'],
    metadata,
    revision: 'test',
    baseline: 'base',
  });
  assert.equal(plan.full, false);
  for (const name of packages.map((pkg) => pkg.name)) {
    assert.ok(plan.suites.root.filter.includes('package(=' + name + ')'), plan.suites.root.filter);
  }
});

test('the embedded external protocol fixture cannot be classified as documentation', () => {
  const path = 'products/maka/cli/tests/support/external_codex_cli.mjs';
  assert.equal(documentation(path), false);
  const plan = createPlan({
    root,
    changes: [path],
    metadata: {},
    revision: 'test',
    baseline: 'base',
  });
  assert.equal(plan.full, false);
  assert.equal(plan.suites.root.filter, 'all()');
  assert.ok(plan.suites.desktop);
  assert.match(plan.suites.root.reason, /external_codex_cli/);
});

test('a shared input plans the maintained platform jobs rather than silently narrowing the matrix', () => {
  const plan = createPlan({
    root,
    changes: ['scripts/ci/suites.mjs'],
    metadata: {},
    revision: 'test',
    baseline: 'base',
  });
  assert.equal(plan.full, true);
  for (const id of ['native-ubuntu', 'native-macos', 'native-windows']) {
    assert.ok(plan.workers.some((worker) => worker.id === id));
  }
});

test('macOS recovery cases stay in a required worker with the complete workspace feature union', () => {
  const plan = full();
  const worker = plan.workers.find((worker) => worker.id === 'native-macos');
  assert.ok(worker.suites.includes('macos-agent-execution'));
  assert.ok(!worker.suites.includes('macos-terminal'));
  assert.deepEqual(suites['macos-agent-execution'].cargoArgs, suites.root.cargoArgs);
  for (const name of [
    'mainline_reopen',
    'journal_recovery',
    'codemode_reopen',
    'external_jobs',
    'producer_reopen',
  ]) {
    assert.ok(
      plan.suites['macos-agent-execution'].filter.includes('binary_id(=maka-cli::' + name + ')'),
    );
  }
});

test('skill and product inputs still select the native Windows skills consumer', () => {
  const path = 'skills/maka-plugin-authoring/SKILL.md';
  const plan = createPlan({
    root,
    changes: [path],
    metadata: {},
    revision: 'test',
    baseline: 'base',
  });
  assert.ok(plan.suites['windows-skills']);
  const worker = plan.workers.find((worker) => worker.id === 'native-windows');
  assert.ok(worker.suites.includes('windows-skills'));
});

test('Desktop archives build the Host and worker metadata with the workspace feature union', () => {
  const plan = full();
  assert.equal(plan.suites.desktop.filter, 'binary_id(=maka-cli::desktop_new_session)');
  assert.ok(suites.desktop.cargoArgs.includes('--workspace'));
  assert.ok(!suites.desktop.cargoArgs.includes('--no-default-features'));
  assert.equal(
    suites.desktop.cargoArgs[suites.desktop.cargoArgs.indexOf('--features') + 1],
    'maka-cli/desktop-tests',
  );
});
