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
import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';
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
      [
        'maka-agent-native',
        'plugins/agent/native',
        [
          'platform/code-runtime',
          'platform/computer-use',
          'plugins/workspace/workspace-processes/native',
        ],
      ],
      [
        'maka-processes-native',
        'plugins/workspace/workspace-processes/native',
        ['platform/process', 'platform/sandbox'],
      ],
      ['maka-sandbox', 'platform/sandbox'],
      ['maka-computer-use', 'platform/computer-use', ['platform/code-runtime']],
      ['maka-skills-core', 'plugins/skills/core'],
      ['maka-skills-native', 'plugins/skills/native', ['plugins/skills/core']],
      ['nsh-core', 'third-party/nsh/crates/nsh-core'],
      ['maka-terminal-shell', 'products/maka/terminal-shell'],
      [
        'maka-cli',
        'products/maka/cli',
        [
          'platform/computer-use',
          'plugins/skills/core',
          'products/maka/terminal-shell',
          'third-party/nsh/crates/nsh-core',
        ],
      ],
      ['maka-schema', 'tools/schema'],
      ['maka-workbench', 'products/maka/workbench'],
      [
        'maka-desktop-shell',
        'products/maka/desktop-shell',
        ['third-party/nsh/crates/nsh-platform-windows'],
      ],
      [
        'nsh-platform-windows',
        'third-party/nsh/crates/nsh-platform-windows',
        ['third-party/nsh/crates/nsh-core'],
      ],
      ['maka-process', 'platform/process'],
      ['maka-settings-native', 'plugins/settings/native'],
      ['maka-ui-build', 'tools/ui-build'],
    ]),
    nsh: workspace([
      ['nsh-core', 'third-party/nsh/crates/nsh-core'],
      ['nsh-cli', 'third-party/nsh/crates/nsh-cli', ['external-nsh']],
      ['nsh-terminal', 'third-party/nsh/crates/nsh-terminal', ['external-nsh']],
      [
        'nsh-platform-windows',
        'third-party/nsh/crates/nsh-platform-windows',
        ['third-party/nsh/crates/nsh-core'],
      ],
      [
        'nsh-windows-app',
        'third-party/nsh/crates/nsh-windows-app',
        ['third-party/nsh/crates/nsh-platform-windows'],
      ],
      [
        'nsh-windows-host',
        'third-party/nsh/crates/nsh-windows-host',
        ['third-party/nsh/crates/nsh-platform-windows'],
      ],
    ]),
    termina: workspace([['termina', 'third-party/termina']]),
  };
  metadata.root.workspace_members = metadata.root.workspace_members.filter(
    (id) => !id.startsWith('third-party/'),
  );
  // The same path dependency has a different Cargo package ID in this graph.
  metadata.nsh.packages.push({
    id: 'external-nsh',
    name: 'nsh-core',
    manifest_path: `${root}/third-party/nsh/crates/nsh-core/Cargo.toml`,
    source: null,
  });
  metadata.nsh.resolve.nodes.push({ id: 'external-nsh', deps: [] });
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
    'package(=maka-agent-native) | package(=maka-cli) | package(=maka-code-runtime) | package(=maka-computer-use)',
  );
  assert.ok(plan.suites.bridge);
  assert.ok(plan.suites.desktop);
  assert.equal(plan.suites.termina, undefined);
});

test('a path dependency affects consumers across owning workspaces', () => {
  const plan = fixture()(['third-party/nsh/crates/nsh-core/src/lib.rs']);
  assert.ok(plan.suites.nsh);
  assert.ok(plan.suites['windows-nsh']);
  assert.equal(plan.suites.root.filter, 'package(=maka-cli) | package(=maka-desktop-shell)');
  assert.equal(plan.full, false);
});

test('Windows backend changes select the native tests and default desktop consumer', () => {
  const plan = fixture()(['third-party/nsh/crates/nsh-platform-windows/src/input.rs']);
  assert.equal(plan.full, false);
  assert.equal(plan.suites.root.filter, 'package(=maka-desktop-shell)');
  assert.deepEqual(
    plan.workers
      .filter((worker) => worker.id.startsWith('native-'))
      .map(({ id, suites }) => ({ id, suites })),
    [
      { id: 'native-ubuntu', suites: ['linux-desktop'] },
      { id: 'native-macos', suites: ['macos-desktop'] },
      { id: 'native-windows', suites: ['windows-desktop', 'windows-nsh'] },
    ],
  );
  const consumer = fixture()(['third-party/nsh/crates/nsh-windows-app/src/lib.rs']);
  assert.ok(consumer.suites['windows-nsh']);
  assert.equal(consumer.full, false);
  const template = fixture()(['third-party/nsh/crates/nsh-cli/src/templates/rust/main.rs']);
  assert.ok(template.suites['windows-nsh']);
  assert.equal(template.full, false);
});

test('compiler cache pruning and both archive paths retain V8 native outputs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maka-ci-cache-'));
  try {
    writeFileSync(
      join(directory, 'Cargo.toml'),
      '[package]\nname = "ci-cache-fixture"\nversion = "0.1.0"\nedition = "2024"\n',
    );
    mkdirSync(join(directory, 'src'));
    writeFileSync(join(directory, 'src/lib.rs'), '');
    writeFileSync(
      join(directory, 'Cargo.lock'),
      'version = 4\n[[package]]\nname = "ci-cache-fixture"\nversion = "0.1.0"\n',
    );
    const outputs = {
      'target/CACHEDIR.TAG': 'Signature: 8a477f597d28d172789f06886806bc55\n',
      'target/debug/gn_out/obj/librusty_v8.a': 'native archive',
      'target/debug/gn_out/src_binding.rs': 'native bindings',
      'target/x86_64-pc-windows-msvc/debug/gn_out/obj/rusty_v8.lib': 'cross archive',
      'target/debug/.fingerprint/v8-fixture/run-build-script-build': 'fingerprint',
      'target/debug/build/v8-fixture/output': 'cargo:rustc-link-search=native=gn_out/obj',
    };
    for (const [path, contents] of Object.entries(outputs)) {
      mkdirSync(join(directory, path, '..'), { recursive: true });
      writeFileSync(join(directory, path), contents);
    }
    const built = execFileSync('cargo', ['build', '--offline', '--message-format=json'], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, CARGO_TARGET_DIR: join(directory, 'target') },
    });
    const local = built
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((message) => message.reason === 'compiler-artifact')
      .flatMap((message) => message.filenames)
      .filter((path) => path.endsWith('.rlib'));
    assert.ok(local.length > 0, 'Cargo must report a real local library artifact');
    for (const path of local) assert.ok(existsSync(path), path);
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL('./ci/setup.mjs', import.meta.url)), 'prune'],
      {
        cwd: directory,
        env: { ...process.env, MAKA_CI_ROLE: 'root', MAKA_CI_WORKSPACE: 'root' },
      },
    );
    for (const path of local) assert.equal(existsSync(path), false, path);
    for (const action of ['ci-setup', 'ci-cache']) {
      const document = parse(
        readFileSync(new URL(`../.github/actions/${action}/action.yml`, import.meta.url), 'utf8'),
      );
      const paths = document.runs.steps
        .find((step) => step.with?.path?.includes('target/'))
        .with.path.trim()
        .split('\n');
      const files = globSync(
        paths.filter((path) => !path.startsWith('!')),
        {
          cwd: directory,
          exclude: paths.filter((path) => path.startsWith('!')).map((path) => path.slice(1)),
        },
      );
      const archive = `${action}.tar`;
      execFileSync('tar', ['-cf', archive, '-T', '-'], {
        cwd: directory,
        input: files.map((path) => path.replaceAll('\\', '/')).join('\n') + '\n',
      });
      const restored = join(directory, action);
      mkdirSync(restored);
      execFileSync('tar', ['-xf', archive, '-C', action], { cwd: directory });
      for (const [path, contents] of Object.entries(outputs))
        assert.equal(readFileSync(join(restored, path), 'utf8'), contents, `${action}: ${path}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Windows setup installs nextest and keys caches by both Cargo workspaces', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maka-ci-windows-'));
  try {
    mkdirSync(join(directory, 'third-party/nsh'), { recursive: true });
    mkdirSync(join(directory, '.cargo'));
    writeFileSync(join(directory, 'Cargo.toml'), '[workspace]');
    writeFileSync(join(directory, 'third-party/nsh/Cargo.toml'), '[workspace]');
    writeFileSync(join(directory, '.cargo/config.toml'), '');
    const cacheActions = [
      '.github/actions/ci-setup/action.yml',
      '.github/actions/ci-cache/action.yml',
    ];
    for (const path of cacheActions) {
      mkdirSync(join(directory, path, '..'), { recursive: true });
      writeFileSync(join(directory, path), readFileSync(new URL('../' + path, import.meta.url)));
    }
    writeFileSync(join(directory, 'Cargo.lock'), 'root-v1');
    writeFileSync(join(directory, 'third-party/nsh/Cargo.lock'), 'nsh-v1');
    const output = join(directory, 'output');
    const setup = (action) => {
      writeFileSync(output, '');
      execFileSync(
        process.execPath,
        [fileURLToPath(new URL('./ci/setup.mjs', import.meta.url)), action],
        {
          cwd: directory,
          env: {
            ...process.env,
            MAKA_CI_ROLE: 'native-windows',
            MAKA_CI_WORKSPACE: 'root',
            MAKA_CI_NEXTEST: '0.9.100',
            GITHUB_OUTPUT: output,
            RUNNER_OS: 'Windows',
            RUNNER_ARCH: 'X64',
          },
        },
      );
      return Object.fromEntries(
        readFileSync(output, 'utf8')
          .trim()
          .split('\n')
          .map((line) => line.split('=')),
      );
    };
    assert.equal(setup('tool-list').tools, 'cargo-nextest@0.9.100');
    const before = setup('keys');
    assert.ok(before.compiled_prefix.startsWith('rust-deps-'));
    assert.ok(before.compiled.startsWith(before.compiled_prefix));
    writeFileSync(join(directory, 'third-party/nsh/Cargo.lock'), 'nsh-v2');
    const nsh = setup('keys');
    assert.notEqual(before.compiled, nsh.compiled);
    assert.notEqual(before.downloads, nsh.downloads);
    writeFileSync(join(directory, 'Cargo.lock'), 'root-v2');
    const root = setup('keys');
    assert.notEqual(nsh.compiled, root.compiled);
    assert.notEqual(nsh.downloads, root.downloads);
    writeFileSync(join(directory, 'third-party/nsh/Cargo.toml'), '[workspace]\nresolver = "3"');
    const features = setup('keys');
    assert.notEqual(root.compiled, features.compiled);
    assert.equal(root.downloads, features.downloads);
    let previous = features;
    for (const path of cacheActions) {
      writeFileSync(join(directory, path), readFileSync(join(directory, path), 'utf8') + '\n');
      const changed = setup('keys');
      assert.notEqual(
        previous.compiled_prefix,
        changed.compiled_prefix,
        'cache schema changes must also invalidate fallback restore keys',
      );
      assert.ok(changed.compiled.startsWith(changed.compiled_prefix));
      assert.equal(previous.downloads, changed.downloads);
      previous = changed;
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SDK runtime inputs select product consumers without a Cargo dependency edge', () => {
  const plan = fixture()(['packages/plugin-sdk/src/runtime/client.ts']);
  for (const id of ['root', 'bridge', 'desktop', 'windows-desktop', 'contracts', 'product'])
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
    'scripts/ci/archive-lock.rs',
    'third-party/nsh/Cargo.lock',
    'new-runtime/source.ts',
  ]) {
    const plan = select([path]);
    assert.equal(plan.full, true, path);
    assert.ok(plan.suites.root, path);
    assert.ok(plan.suites['linux-nsh'], path);
  }
});

test('the aggregate accepts only successful planned work, including every selected matrix', () => {
  const full = createPlan({ root, revision: 'head' });
  const results = Object.fromEntries(
    ['plan', 'tooling', 'suites', 'root-build', 'root-tests'].map((id) => [
      id,
      { result: 'success' },
    ]),
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
    'products/maka/workbench/tests/fixtures/composer-completion.tsx',
    'products/maka/workbench/tests/fixtures/mermaid-view.tsx',
    'products/maka/workbench/app/ComputerPermissionSetupEntry.tsx',
  ]) {
    const selected = plan([input]);
    assert(selected.suites.root, input);
    assert(selected.suites.product, input);
    assert(selected.suites.contracts, input);
  }
  for (const input of [
    'products/maka/terminal-shell/tests/fixtures/components.tsx',
    'products/maka/terminal-shell/tests/real_host/permission_preview.tsx',
  ]) {
    const selected = plan([input]);
    assert.equal(selected.full, false, input);
    assert(selected.suites.root, input);
    assert(selected.suites.desktop, input);
    assert(selected.suites.contracts, input);
  }
  assert(plan(['products/maka/workbench/tests/fonts/IBMPlexSans-Regular.ttf']).suites.root);
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

test('Windows shell and CI helper changes run their behavior suites on Windows', async () => {
  for (const [path, suite] of [
    ['platform/process/src/shell.rs', 'windows-shell'],
    ['plugins/settings/native/src/preferences.rs', 'windows-shell'],
    ['scripts/ci/archive-lock.rs', 'windows-ci'],
    ['scripts/ci/run.mjs', 'windows-ci'],
    ['scripts/ci.test.mjs', 'windows-ci'],
  ]) {
    const plan = fixture()([path]);
    assert.ok(plan.suites[suite], path);
    const runners = plan.workers.filter((worker) => worker.suites.includes(suite));
    assert.deepEqual(
      runners.map((worker) => worker.runner),
      ['windows-latest'],
      path,
    );
  }
  const calls = [];
  const exec = executor(
    root,
    {},
    {
      run: async (executable, args) => {
        calls.push({ executable, args });
        return '';
      },
    },
  );
  await exec.prepare('windows-ci');
  await exec.verify('windows-ci');
  assert.deepEqual(calls, [
    { executable: process.execPath, args: ['--test', 'scripts/ci.test.mjs'] },
  ]);
});

test('native behavior verification compiles and executes nextest on macOS and Windows', async () => {
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
      assert.equal(readFileSync(output, 'utf8'), 'tools=cargo-nextest\n');
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    for (const host of ['linux', 'darwin', 'win32']) {
      Object.defineProperty(process, 'platform', { value: host });
      const calls = [];
      const exec = executor(
        root,
        {},
        {
          run: async (executable, args) => {
            calls.push({ executable, args });
            return '';
          },
        },
      );
      await exec.prepare('native');
      await exec.verify('native');
      const cargo = [
        '--locked',
        '-p',
        'maka-computer-use',
        '--lib',
        '--features',
        'native-desktop',
      ];
      const filter = [
        'test(macos::controller::tests::)',
        'test(macos::tcc::tests::)',
        'test(system_permission::process::tests::)',
        'test(desktop::worker::macos::tests::)',
        'test(desktop::worker::native_owner::tests::)',
        'test(driver::tests::fresh_binding_replaces_failed_controller_without_restarting_old_owner)',
      ].join(' | ');
      assert.deepEqual(
        calls,
        host === 'linux'
          ? [{ executable: 'cargo', args: ['check', ...cargo] }]
          : [
              { executable: 'cargo', args: ['nextest', 'run', ...cargo, '-E', filter, '--no-run'] },
              { executable: 'cargo', args: ['nextest', 'run', ...cargo, '-E', filter] },
            ],
        host,
      );
    }
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
});

test('native terminal implementation and fixtures run the real PTY acceptance on macOS', async () => {
  for (const input of [
    'plugins/agent/native/src/owner/tests/terminal.rs',
    'plugins/agent/native/src/owner/tests/processes.rs',
    'plugins/agent/native/src/owner/tests/service_tools/setup.rs',
    'plugins/workspace/workspace-processes/native/src/terminal/output.rs',
    'platform/process/src/pty/unix.rs',
    'platform/sandbox/src/seatbelt/base.sbpl',
    'plugins/agent/providers/data/catalog-facts.json',
  ]) {
    const plan = fixture()([input]);
    assert.equal(plan.full, false, input);
    assert.deepEqual(
      plan.workers
        .filter((worker) => worker.suites.includes('macos-terminal'))
        .map((worker) => worker.runner),
      ['macos-latest'],
      input,
    );
  }
  const calls = [];
  const exec = executor(
    root,
    {},
    {
      run: async (executable, args) => {
        calls.push({ executable, args });
        return '';
      },
    },
  );
  await exec.prepare('macos-terminal');
  await exec.verify('macos-terminal');
  const args = [
    'nextest',
    'run',
    '--locked',
    '-p',
    'maka-agent-native',
    '--lib',
    '-E',
    'test(=owner::tests::terminal::terminal_raw_bytes_full_resize_replay_and_observer_cancellation_preserve_native_owner)',
  ];
  assert.deepEqual(calls, [
    { executable: 'cargo', args: [...args, '--no-run'] },
    { executable: 'cargo', args },
  ]);
});

test('skill publication changes run the existing behavior tests on Windows', async () => {
  for (const input of [
    'plugins/skills/native/src/management.rs',
    'plugins/skills/core/src/lib.rs',
  ]) {
    const plan = fixture()([input]);
    assert(plan.suites['windows-skills'], input);
    assert.deepEqual(
      plan.workers
        .filter((worker) => worker.suites.includes('windows-skills'))
        .map((worker) => worker.runner),
      ['windows-latest'],
    );
  }
  const calls = [];
  const exec = executor(
    root,
    {},
    {
      run: async (executable, args) => {
        calls.push({ executable, args });
        return '';
      },
    },
  );
  await exec.prepare('windows-skills');
  await exec.verify('windows-skills');
  assert.deepEqual(calls, [
    {
      executable: 'cargo',
      args: ['nextest', 'run', '--locked', '-p', 'maka-skills-native', '--lib', '--no-run'],
    },
    {
      executable: 'cargo',
      args: [
        'nextest',
        'run',
        '--locked',
        '-p',
        'maka-skills-native',
        '--lib',
        '--no-tests=fail',
        '-j',
        '1',
      ],
    },
  ]);
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

test('local root runs consume owned artifacts after the compiler cache disappears and release them', async (t) => {
  const cases = ['unified', 'split'].flatMap((layout) =>
    [null, 'archive', 'run'].map((failure) => ({ layout, failure })),
  );
  for (const { layout, failure } of cases) {
    await t.test(
      `${layout} ${failure === null ? 'successful replay' : `${failure} failure`}`,
      async () => {
        const directory = mkdtempSync(join(tmpdir(), 'maka-ci-owned-root-'));
        let owned;
        try {
          const target = join(directory, 'target');
          const cache = layout === 'split' ? join(directory, 'compiler-cache') : target;
          const cliOut = 'debug/build/maka-cli-fixture/out';
          const terminalOut = 'debug/build/maka-terminal-shell-fixture/out';
          const binary = 'debug/deps/owned-test.mjs';
          const files = {
            [binary]: `
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const target = process.argv[2];
process.stdout.write(JSON.stringify([
  readFileSync(join(target, ${JSON.stringify(cliOut)}, 'product/nested/asset.txt'), 'utf8'),
  readFileSync(join(target, ${JSON.stringify(terminalOut)}, 'product/nested/asset.txt'), 'utf8'),
  execFileSync(process.execPath, [join(target, 'debug/maka.mjs')], { encoding: 'utf8' }),
]));
`,
            'debug/maka.mjs': 'process.stdout.write("owned CLI");\n',
            [`${cliOut}/product/nested/asset.txt`]: 'CLI product',
            [`${terminalOut}/product/nested/asset.txt`]: 'Terminal product',
          };
          for (const [path, contents] of Object.entries(files)) {
            const source = join(path === 'debug/maka.mjs' ? target : cache, path);
            mkdirSync(dirname(source), { recursive: true });
            writeFileSync(source, contents);
          }
          const configuration = join(directory, 'custom.toml');
          const config = 'nextest-version = "0.9.145"\n[profile.custom]\nretries = 0\n';
          writeFileSync(configuration, config);
          const build = [
            '--features',
            'first second',
            '-Fthird',
            '--no-default-features',
            '--target=fixture-target',
          ];
          const shared = ['--config', 'target.fixture-target.runner="fixture runner"'];
          const runtime = [
            '-E',
            'test(owned)',
            '--partition',
            'slice:1/2',
            '-j1',
            '--config-file',
            configuration,
            '--profile=custom',
            ...shared,
            '--',
            '--features',
            '--no-run',
          ];
          const expectedFailure = new Error(`${failure} failed`);
          const calls = [];
          let observed;
          const exec = executor(
            directory,
            {},
            {
              env: { ...process.env, CARGO_TARGET_DIR: target },
              run: async (executable, args, options) => {
                assert.equal(executable, 'cargo');
                assert.equal(options.cwd, directory);
                calls.push(args);
                const value = (option) => args[args.indexOf(option) + 1];
                if (args[1] === 'list') {
                  assert.deepEqual(args.slice(2, 2 + build.length + shared.length + 2), [
                    '--locked',
                    '--workspace',
                    ...build,
                    ...shared,
                  ]);
                  assert.deepEqual(
                    args.flatMap((arg, index) => (arg === '-E' ? [args[index + 1]] : [])),
                    ['package(=maka-cli) | package(=maka-terminal-shell)', 'test(owned)'],
                  );
                  assert.equal(value('--config-file'), configuration);
                  assert.equal(value('--profile'), 'custom');
                  return JSON.stringify({
                    'rust-build-meta': {
                      'target-directory': target,
                      ...(layout === 'split' ? { 'build-directory': cache } : {}),
                      'build-script-out-dirs': { cli: cliOut, terminal: terminalOut },
                    },
                    'rust-suites': {
                      cli: {
                        'package-name': 'maka-cli',
                        'package-id': 'cli',
                        'binary-id': 'maka-cli::owned',
                        testcases: { owned: { 'filter-match': { status: 'matches' } } },
                      },
                      terminal: {
                        'package-name': 'maka-terminal-shell',
                        'package-id': 'terminal',
                        'binary-id': 'maka-terminal-shell',
                        testcases: { owned: { 'filter-match': { status: 'matches' } } },
                      },
                      unrelated: {
                        'package-name': 'unrelated',
                        'package-id': 'unrelated',
                        'binary-id': 'unrelated',
                        testcases: {
                          other: { 'filter-match': { status: 'mismatch', reason: 'expression' } },
                        },
                      },
                    },
                  });
                }
                if (args[1] === 'archive') {
                  assert.deepEqual(args.slice(2, 2 + build.length + shared.length + 2), [
                    '--locked',
                    '--workspace',
                    ...build,
                    ...shared,
                  ]);
                  assert.equal(
                    value('-E'),
                    'binary_id(=maka-cli::owned) | binary_id(=maka-terminal-shell)',
                  );
                  const archive = value('--archive-file');
                  owned = dirname(archive);
                  const generated = readFileSync(value('--config-file'), 'utf8');
                  assert(
                    generated.includes(config),
                    'archive configuration must retain the caller configuration',
                  );
                  const includes = Array.from(
                    generated.matchAll(/\{\s*path\s*=\s*("(?:\\.|[^"\\])*")/g),
                    (match) => JSON.parse(match[1]),
                  );
                  const archived = Object.fromEntries(
                    Object.keys(files)
                      .filter(
                        (path) =>
                          path.endsWith('.mjs') ||
                          includes.some((include) => path.startsWith(include + '/')),
                      )
                      .map((path) => [
                        path,
                        readFileSync(join(path === binary ? cache : target, path), 'utf8'),
                      ]),
                  );
                  writeFileSync(archive, JSON.stringify(archived));
                  if (failure === 'archive') throw expectedFailure;
                  return '';
                }
                assert.equal(args[1], 'run');
                assert.deepEqual(args.slice(-runtime.length), runtime);
                assert.equal(value('--workspace-remap'), directory);
                assert.equal(options.env.NEXTEST_PROFILE, 'ci');
                assert.equal(args.includes('--workspace'), false);
                const extraction = value('--extract-to');
                assert.equal(dirname(extraction), owned);
                assert(existsSync(join(extraction, 'target/tmp')));
                const archived = JSON.parse(readFileSync(value('--archive-file'), 'utf8'));
                if (layout === 'split') {
                  for (const path of [cliOut, terminalOut])
                    assert.equal(
                      existsSync(join(target, path, 'product')),
                      false,
                      'archive staging must end before replay',
                    );
                }
                for (const [path, contents] of Object.entries(files))
                  assert.equal(
                    readFileSync(join(path === 'debug/maka.mjs' ? target : cache, path), 'utf8'),
                    contents,
                    'archive must leave source artifacts unchanged',
                  );
                rmSync(cache, { recursive: true, force: true });
                if (target !== cache) rmSync(target, { recursive: true, force: true });
                assert.equal(existsSync(join(cache, binary)), false);
                assert.equal(existsSync(join(target, 'debug/maka.mjs')), false);
                for (const [path, contents] of Object.entries(archived)) {
                  const destination = join(extraction, 'target', path);
                  mkdirSync(dirname(destination), { recursive: true });
                  writeFileSync(destination, contents);
                }
                observed = JSON.parse(
                  execFileSync(
                    process.execPath,
                    [join(extraction, 'target', binary), join(extraction, 'target')],
                    { encoding: 'utf8' },
                  ),
                );
                if (failure === 'run') throw expectedFailure;
                return '';
              },
            },
          );
          const replay = exec.verify('root', 'package(=maka-cli) | package(=maka-terminal-shell)', [
            ...build,
            ...runtime,
          ]);
          if (failure === null) await replay;
          else await assert.rejects(replay, (error) => error === expectedFailure);
          assert.equal(
            existsSync(owned),
            false,
            'the caller must release its archive and extraction on every terminal result',
          );
          assert.equal(calls.length, failure === 'archive' ? 2 : 3);
          if (failure !== 'archive')
            assert.deepEqual(observed, ['CLI product', 'Terminal product', 'owned CLI']);
          else {
            for (const path of [cliOut, terminalOut]) {
              assert.equal(
                readFileSync(join(cache, path, 'product/nested/asset.txt'), 'utf8'),
                path === cliOut ? 'CLI product' : 'Terminal product',
              );
              if (layout === 'split')
                assert.equal(existsSync(join(target, path, 'product')), false);
            }
          }
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      },
    );
  }
});

test('overlapping split archives serialize staging across local and CI consumers', async (t) => {
  for (const consumer of ['local', 'CI']) {
    await t.test(consumer, async () => {
      const directory = mkdtempSync(join(tmpdir(), 'maka-ci-overlapping-root-'));
      try {
        const target = join(directory, 'target');
        const build = join(directory, 'build');
        const product = 'debug/build/maka-cli-fixture/out/product';
        mkdirSync(join(build, product), { recursive: true });
        writeFileSync(join(build, product, 'asset.txt'), 'immutable product');
        mkdirSync(target);
        writeFileSync(join(target, 'unrelated.txt'), 'foreign sentinel');
        const lock = `${target}.maka-ci.lock`;
        writeFileSync(lock, 'stable lock inode');
        mkdirSync(join(directory, '.config'));
        writeFileSync(join(directory, '.config/nextest.toml'), '[profile.ci]\n');
        let active = 0,
          maximum = 0,
          archived = 0;
        const observed = [];
        const options = {
          env: { ...process.env, CARGO_TARGET_DIR: join(directory, 'ignored target') },
          run: async (_executable, args) => {
            const value = (option) => args[args.indexOf(option) + 1];
            if (args[1] === 'list')
              return JSON.stringify({
                'rust-build-meta': {
                  'target-directory': target,
                  'build-directory': build,
                  'build-script-out-dirs': { cli: dirname(product) },
                },
                'rust-suites': {
                  cli: {
                    'package-name': 'maka-cli',
                    'package-id': 'cli',
                    'binary-id': 'maka-cli::owned',
                    testcases: { owned: { 'filter-match': { status: 'matches' } } },
                  },
                },
              });
            if (args[1] === 'archive') {
              active++;
              maximum = Math.max(maximum, active);
              try {
                const contents = readFileSync(join(target, product, 'asset.txt'), 'utf8');
                await new Promise((resolve) => setImmediate(resolve));
                writeFileSync(value('--archive-file'), contents);
                archived++;
                return '';
              } finally {
                active--;
              }
            }
            assert.equal(args[1], 'run');
            observed.push(readFileSync(value('--archive-file'), 'utf8'));
            return '';
          },
        };
        const first = executor(directory, {}, options);
        const second = executor(directory, {}, options);
        const extra = [
          '--target-dir',
          join(directory, 'also ignored'),
          '--config',
          'build.build-dir="ignored"',
        ];
        const results = await Promise.allSettled([
          first.verify('root', 'package(=maka-cli)', extra),
          consumer === 'local'
            ? second.verify('root', 'package(=maka-cli)', extra)
            : second.archive(
                { suites: { root: { filter: 'all()' } } },
                join(directory, 'tests.tar.zst'),
              ),
        ]);
        for (const result of results) if (result.status === 'rejected') throw result.reason;
        assert.equal(archived, 2);
        assert.equal(maximum, 1);
        assert.deepEqual(
          observed,
          consumer === 'local' ? ['immutable product', 'immutable product'] : ['immutable product'],
        );
        if (consumer === 'CI')
          assert.deepEqual(results[1].value, [{ group: 'cli', partition: 'slice:1/1' }]);
        assert.equal(existsSync(join(target, product)), false);
        assert.equal(readFileSync(join(build, product, 'asset.txt'), 'utf8'), 'immutable product');
        assert.equal(readFileSync(join(target, 'unrelated.txt'), 'utf8'), 'foreign sentinel');
        assert.equal(readFileSync(lock, 'utf8'), 'stable lock inode');
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});

test('split archive staging releases only owned products on conflict or missing input', async (t) => {
  for (const failure of ['conflict', 'missing']) {
    await t.test(failure, async () => {
      const directory = mkdtempSync(join(tmpdir(), 'maka-ci-product-owner-'));
      try {
        const target = join(directory, 'target');
        const build = join(directory, 'build');
        const paths = { cli: 'debug/build/cli/out', terminal: 'debug/build/terminal/out' };
        mkdirSync(join(directory, '.config'));
        writeFileSync(join(directory, '.config/nextest.toml'), '[profile.ci]\n');
        for (const [name, path] of Object.entries(paths)) {
          if (failure === 'missing' && name === 'terminal') continue;
          mkdirSync(join(build, path, 'product'), { recursive: true });
          writeFileSync(join(build, path, 'product/asset.txt'), name);
        }
        const conflict = join(target, paths.terminal, 'product');
        if (failure === 'conflict') {
          mkdirSync(conflict, { recursive: true });
          writeFileSync(join(conflict, 'asset.txt'), 'another archive owns this');
        }
        const exec = executor(
          directory,
          {},
          {
            env: { ...process.env, CARGO_TARGET_DIR: target },
            run: async (_executable, args) => {
              assert.equal(args[1], 'list', 'an incomplete snapshot must never be archived');
              return JSON.stringify({
                'rust-build-meta': {
                  'target-directory': target,
                  'build-directory': build,
                  'build-script-out-dirs': paths,
                },
                'rust-suites': {
                  cli: {
                    'package-name': 'maka-cli',
                    'package-id': 'cli',
                    'binary-id': 'maka-cli',
                    testcases: { selected: { 'filter-match': { status: 'matches' } } },
                  },
                  terminal: {
                    'package-name': 'maka-terminal-shell',
                    'package-id': 'terminal',
                    'binary-id': 'maka-terminal-shell',
                    testcases: { selected: { 'filter-match': { status: 'matches' } } },
                  },
                },
              });
            },
          },
        );
        await assert.rejects(
          exec.verify('root'),
          (error) => error.code === (failure === 'conflict' ? 'EEXIST' : 'ENOENT'),
        );
        assert.equal(existsSync(join(target, paths.cli, 'product')), false);
        assert.equal(readFileSync(join(build, paths.cli, 'product/asset.txt'), 'utf8'), 'cli');
        if (failure === 'conflict') {
          assert.equal(
            readFileSync(join(conflict, 'asset.txt'), 'utf8'),
            'another archive owns this',
          );
          assert.equal(
            readFileSync(join(build, paths.terminal, 'product/asset.txt'), 'utf8'),
            'terminal',
          );
        } else assert.equal(existsSync(conflict), false);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});

test('local root help and build-only requests retain the direct nextest command', async () => {
  for (const flag of ['--help', '--no-run']) {
    const calls = [];
    const exec = executor(
      root,
      {},
      {
        run: async (executable, args) => {
          calls.push({ executable, args });
          return '';
        },
      },
    );
    await exec.verify('root', 'all()', ['--features=fixture', flag]);
    assert.deepEqual(calls, [
      {
        executable: 'cargo',
        args: ['nextest', 'run', '--locked', '--workspace', '--features=fixture', flag],
      },
    ]);
  }
});

test('the external-agent UI worker fixture reaches real CLI tests', () => {
  const plan = fixture()(['products/maka/terminal-shell/tests/support/external-agent-cli.mjs']);
  assert.equal(plan.full, false);
  assert.ok(plan.suites.root);
  assert.equal(plan.suites.root.filter, 'all()');
});

test('native interpreted fixtures reach the root tests replayed from archives', () => {
  const directory = 'plugins/agent/native/tests/support';
  const inputs = readdirSync(new URL('../' + directory + '/', import.meta.url), {
    recursive: true,
  }).filter((path) => path.endsWith('.mjs'));
  assert.ok(inputs.length, 'native runtime behavior fixtures must be present');
  for (const input of inputs) {
    const path = directory + '/' + input.replaceAll('\\', '/');
    const plan = fixture()([path]);
    assert.equal(plan.full, false, path);
    assert.equal(plan.suites.root.filter, 'all()', path);
    assert.ok(plan.suites.tooling, path);
  }
});

test('distribution build and license inputs reach their consumers', () => {
  for (const path of [
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
    'scripts/rust/licenses/declared-mit.txt',
  ]) {
    const plan = fixture()([path]);
    assert.equal(plan.full, false, path);
    assert.equal(plan.suites.root.filter, 'all()', path);
    assert.ok(plan.suites['native-build'], path);
    assert.ok(plan.suites.product, path);
  }
});

test('product verification reaches the reviewed notice gate and propagates its failure', async () => {
  const plan = fixture()(['scripts/rust/licenses/declared-mit.txt']);
  assert.ok(plan.suites.product);
  const missingCoverage = new Error('Third-party notices do not cover cargo:windows@1.0.0');
  let productChecked = false;
  let noticeChecks = 0;
  let covered = false;
  const exec = executor(
    root,
    {},
    {
      run: async (exe, args, options) => {
        assert.equal(exe, process.execPath);
        assert.equal(options.cwd, root);
        if (args[0] === 'scripts/rust/product.mjs' && args[1] === 'test') {
          productChecked = true;
          return '';
        }
        if (args[0] === 'scripts/rust/notices.mjs' && args[1] === 'check-reviewed') {
          assert.equal(productChecked, true);
          noticeChecks++;
          if (!covered) throw missingCoverage;
          return '';
        }
        throw new Error('Unexpected product command: ' + args.join(' '));
      },
    },
  );
  await assert.rejects(exec.verify('product'), (error) => error === missingCoverage);
  assert.equal(noticeChecks, 1);
  covered = true;
  await exec.verify('product');
  assert.equal(noticeChecks, 2);
});

test('native pixel and desktop regressions run only on their native OS workers', () => {
  const plan = createPlan({ root, revision: 'head' });
  for (const id of ['desktop', 'pixels']) {
    assert.deepEqual(
      plan.workers.filter((worker) => worker.suites.includes(id)).map((worker) => worker.runner),
      ['macos-latest', 'windows-latest'],
    );
  }
  assert.deepEqual(
    plan.workers
      .filter((worker) => worker.suites.includes('linux-nsh'))
      .map((worker) => worker.runner),
    ['ubuntu-latest'],
  );
  assert.equal(plan.suites.gpui, undefined);
});

test('native regression commands fail empty selections and GTK runs under Xvfb', async () => {
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
  for (const id of ['desktop', 'pixels', 'linux-nsh', 'macos-nsh', 'macos-surface', 'windows-nsh'])
    await exec.verify(id);
  for (const call of calls) assert(call.args.includes('--no-tests=fail'));
  assert(calls.some(({ args }) => args.includes('native-desktop')));
  assert(calls.some(({ args }) => args.includes('native-pixels')));
  assert(calls.some(({ args }) => args.includes('terminal_native') && !args.includes('--lib')));
  assert(calls.some(({ exe, args }) => exe === 'xvfb-run' && args[0] === '-a'));
});

test('Linux desktop and its embedded icon select a display-backed native consumer', () => {
  for (const path of [
    'products/maka/desktop-shell/src/linux.rs',
    'products/maka/cli/icons/maka.png',
  ]) {
    const plan = fixture()([path]);
    assert.ok(plan.suites['linux-desktop'], path);
    const worker = plan.workers.find((worker) => worker.id === 'native-ubuntu');
    assert.ok(worker.suites.includes('linux-desktop'), path);
    assert.equal(worker.dependencies, 'headless');
    assert.equal(worker.javascript, true);
  }
});
