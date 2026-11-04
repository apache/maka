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
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkResults, createPlan } from './ci/plan.mjs';
import { executor } from './ci/run.mjs';

const root = '/repo';

function workspace(packages) {
  return {
    packages: packages.map(([name, path, dependencies = []]) => ({
      id: path,
      name,
      manifest_path: `${root}/${path}/Cargo.toml`,
      source: null,
      dependencies,
    })),
    workspace_members: packages.map(([, path]) => path),
    resolve: {
      nodes: packages.map(([, path, dependencies = []]) => ({
        id: path,
        deps: dependencies.map((pkg) => ({ pkg })),
      })),
    },
  };
}

function fixture() {
  const metadata = {
    root: workspace([
      ['maka-code-runtime', 'platform/code-runtime'],
      ['maka-computer-use', 'platform/computer-use', ['platform/code-runtime']],
      ['maka-skills-core', 'plugins/skills/core'],
      ['nsh-core', 'third-party/nsh/crates/nsh-core'],
      [
        'maka-cli',
        'products/maka/cli',
        ['platform/computer-use', 'plugins/skills/core', 'third-party/nsh/crates/nsh-core'],
      ],
      ['maka-schema', 'tools/schema'],
      ['maka-workbench', 'products/maka/workbench'],
      ['maka-process', 'platform/process'],
      ['maka-settings-native', 'plugins/settings/native'],
      ['maka-ui-build', 'tools/ui-build'],
    ]),
    nsh: workspace([['nsh-core', 'third-party/nsh/crates/nsh-core']]),
    gpui: workspace([
      ['nsh-platform-gpui', 'third-party/nsh/crates/gpui/nsh-platform-gpui', ['external-nsh']],
    ]),
    termina: workspace([['termina', 'third-party/termina']]),
  };
  metadata.root.workspace_members = metadata.root.workspace_members.filter(
    (id) => !id.startsWith('third-party/'),
  );
  // The same path dependency has a different Cargo package ID in this graph.
  metadata.gpui.packages.push({
    id: 'external-nsh',
    name: 'nsh-core',
    manifest_path: `${root}/third-party/nsh/crates/nsh-core/Cargo.toml`,
    source: null,
  });
  metadata.gpui.resolve.nodes.push({ id: 'external-nsh', deps: [] });
  return (changes) => createPlan({ root, changes, metadata, revision: 'head', baseline: 'base' });
}

test('a transitive Computer Use dependency selects all native OS checks and CLI consumers', () => {
  const plan = fixture()(['platform/code-runtime/src/lib.rs']);
  assert.deepEqual(
    plan.workers.filter((worker) => worker.id.startsWith('native-')).map((worker) => worker.runner),
    ['ubuntu-latest', 'macos-latest', 'windows-latest'],
  );
  assert.equal(
    plan.suites.root.filter,
    'package(=maka-cli) | package(=maka-code-runtime) | package(=maka-computer-use)',
  );
  assert.ok(plan.suites.bridge);
  assert.ok(plan.suites.desktop);
  assert.equal(plan.suites.termina, undefined);
});

test('a path dependency affects consumers across owning workspaces', () => {
  const plan = fixture()(['third-party/nsh/crates/nsh-core/src/lib.rs']);
  assert.ok(plan.suites.nsh);
  assert.ok(plan.suites.gpui);
  assert.equal(plan.suites.root.filter, 'package(=maka-cli)');
  assert.equal(plan.full, false);
});

test('SDK runtime inputs select product consumers without a Cargo dependency edge', () => {
  const plan = fixture()(['packages/plugin-sdk/src/runtime/client.ts']);
  for (const id of ['root', 'bridge', 'desktop', 'contracts', 'product'])
    assert.ok(plan.suites[id], id);
  assert.equal(plan.suites.root.filter, 'all()');
  assert.equal(plan.suites.native, undefined);
});

test('ordinary Rust source inside a product directory retains package routing', () => {
  const plan = fixture()(['products/maka/workbench/src/lib.rs']);
  assert.equal(plan.suites.root.filter, 'package(=maka-workbench)');
  assert.ok(plan.suites.contracts);
  assert.equal(plan.suites.product, undefined);
});

test('reviewed notices and distributed dependency licenses select the product verifier', () => {
  const select = fixture();
  for (const path of [
    'products/maka/cli/notices.json',
    'products/maka/cli/THIRD_PARTY_NOTICES.txt',
    'third-party/nsh/crates/nsh-core/LICENSE',
  ]) {
    const plan = select([path]);
    assert.ok(plan.suites.product, path);
    assert.equal(plan.full, false, path);
  }
});

test('embedded Markdown remains an input even when it belongs to another Cargo package', () => {
  for (const path of [
    'platform/computer-use/skills/maka-cua/SKILL.md',
    'platform/computer-use/src/api.md',
  ]) {
    const plan = fixture()([path]);
    assert.ok(plan.suites.root);
    assert.ok(plan.suites.bridge);
    assert.ok(plan.suites.native);
    assert.equal(plan.full, false);
  }
});

test('documentation is cheap while shared and unknown source inputs request full validation', () => {
  const select = fixture();
  const docs = select([
    'docs/guide.md',
    'README.md',
    'platform/host/README.md',
    'products/maka/workbench/README.md',
  ]);
  assert.deepEqual(Object.keys(docs.suites), []);
  assert.deepEqual(docs.workers, []);
  for (const path of [
    '.cargo/config.toml',
    'third-party/nsh/Cargo.lock',
    'new-runtime/source.ts',
  ]) {
    const plan = select([path]);
    assert.equal(plan.full, true, path);
    assert.ok(plan.suites.root, path);
    assert.ok(plan.suites.gpui, path);
  }
});

test('the aggregate accepts only successful planned work, including every selected matrix', () => {
  const full = createPlan({ root, revision: 'head' });
  const results = Object.fromEntries(
    ['plan', 'tooling', 'suites', 'root-build', 'root-tests', 'desktop-build', 'desktop-tests'].map(
      (id) => [id, { result: 'success' }],
    ),
  );
  checkResults(full, results, true);
  for (const id of Object.keys(results)) {
    for (const result of ['failure', 'skipped', 'cancelled']) {
      assert.throws(
        () => checkResults(full, { ...results, [id]: { result } }, true),
        /did not succeed/,
      );
    }
  }
  assert.throws(() => checkResults(full, results), /did not report/);
  assert.throws(() => checkResults(full, results, false), /unexpectedly empty/);
  const narrow = fixture()(['tools/schema/src/main.rs']);
  checkResults(narrow, { ...results, 'root-tests': { result: 'skipped' } }, false);
  const docs = fixture()(['docs/guide.md']);
  checkResults(docs, { plan: { result: 'success' }, tooling: { result: 'skipped' } });
  assert.throws(() => checkResults(docs, { plan: { result: 'failure' } }), /did not succeed/);
});

test('Mermaid dependency patches, UI fixtures and outline font inputs reach their consumers', () => {
  const plan = fixture();
  for (const input of [
    'patches/pele+1.13.0.patch',
    'products/maka/workbench/tests/fixtures/mermaid-view.tsx',
  ]) {
    const selected = plan([input]);
    assert(selected.suites.root, input);
    assert(selected.suites.product, input);
    assert(selected.suites.contracts, input);
  }
  assert(
    plan(['third-party/nsh/third-party/gpui-wgpu/test-assets/IBMPlexSans-Regular.ttf']).suites.root,
  );
});

test('Host identity inputs execute real macOS tests, including changes outside Cargo', () => {
  for (const path of [
    'scripts/rust/build-cli.mjs',
    'scripts/rust/build-cli.test.mjs',
    'scripts/rust/pack-cli.mjs',
    'scripts/rust/run-cli.mjs',
    'products/maka/cli/src/deployment/host_identity.rs',
    'platform/code-runtime/src/lib.rs',
    'packages/plugin-sdk/src/runtime/client.ts',
  ]) {
    const plan = fixture()([path]);
    assert.ok(plan.suites['macos-host'], path);
    const runners = plan.workers.filter((worker) => worker.suites.includes('macos-host'));
    assert.equal(runners.length, 1, path);
    assert.equal(runners[0].runner, 'macos-latest', path);
    assert.equal(runners[0].javascript, true, path);
  }
});

test('Windows shell changes run native Git Bash behavior tests on Windows', () => {
  for (const path of [
    'platform/process/src/shell.rs',
    'plugins/settings/native/src/preferences.rs',
  ]) {
    const plan = fixture()([path]);
    assert.ok(plan.suites['windows-shell'], path);
    const runners = plan.workers.filter((worker) => worker.suites.includes('windows-shell'));
    assert.deepEqual(
      runners.map((worker) => worker.runner),
      ['windows-latest'],
      path,
    );
  }
});

test('native behavior verification selects nextest on macOS and Windows', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'maka-native-tools-'));
  try {
    for (const role of ['native-macos', 'native-ubuntu', 'native-windows']) {
      const output = join(temporary, role);
      execFileSync(
        process.execPath,
        [fileURLToPath(new URL('./ci/setup.mjs', import.meta.url)), 'tool-list'],
        {
          env: { ...process.env, MAKA_CI_ROLE: role, MAKA_CI_NEXTEST: '', GITHUB_OUTPUT: output },
        },
      );
      assert.equal(
        readFileSync(output, 'utf8'),
        role !== 'native-ubuntu' ? 'tools=cargo-nextest\n' : 'tools=\n',
      );
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('Windows shell execution resolves Git Bash and LLVM paths from uppercase PROGRAMFILES', async () => {
  const calls = [];
  const exec = executor(
    root,
    { id: 'native-windows' },
    {
      env: { PROGRAMFILES: 'C:\\Program Files' },
      run: async (exe, args, options) => {
        calls.push({ exe, args, options });
        return '';
      },
    },
  );
  await exec.prepare('windows-shell');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.env.LIBCLANG_PATH, join('C:\\Program Files', 'LLVM', 'bin'));
  assert.equal(
    calls[0].options.env.MAKA_TEST_GIT_BASH,
    join('C:\\Program Files', 'Git', 'bin', 'bash.exe'),
  );
});

test('OAR source, worker tests and native fixture reach the Host suite and product build', () => {
  for (const path of [
    'plugins/agent/oar-executor/worker/main.mjs',
    'plugins/agent/native/tests/support/oar-worker.mjs',
    'scripts/oar/build.mjs',
    'scripts/oar/worker.test.mjs',
    'scripts/rust/cargo.mjs',
    'scripts/rust/build-v8.mjs',
    'scripts/rust/v8-source.json',
    'scripts/rust/v8-prebuilts.json',
    'scripts/rust/v8-cache.mjs',
    'scripts/rust/compile-v8.mjs',
    'scripts/rust/v8-notices.mjs',
    'scripts/rust/license-files.mjs',
    'scripts/rust/license-source.mjs',
    'scripts/rust/notices.mjs',
    'scripts/rust/notices-sources.json',
    'scripts/rust/licenses/deno-2.9.6-source-notices.txt',
  ]) {
    const plan = fixture()([path]);
    assert.equal(plan.full, false, path);
    assert.equal(plan.suites.root.filter, 'all()', path);
    assert.ok(plan.suites['native-build'], path);
  }
});

test('PR notices executor runs reviewed coverage rather than release verification', async () => {
  const calls = [];
  const exec = executor(
    root,
    {},
    {
      run: async (exe, args) => {
        calls.push({ exe, args });
        return '';
      },
    },
  );
  await exec.check('notices');
  assert.deepEqual(calls, [
    { exe: process.execPath, args: ['scripts/rust/notices.mjs', 'check-reviewed'] },
  ]);
});
