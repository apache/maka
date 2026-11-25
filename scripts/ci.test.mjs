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
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { resolvePullRequestBaseline } from './ci.mjs';
import { executor, runSuites } from './ci/run.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { checkResults, createPlan, documentation } from './ci/plan.mjs';
import { suites } from './ci/suites.mjs';

test('manual worker validation runs its suites without claiming full CI coverage', () => {
  const plan = createPlan({ root, revision: 'head', worker: 'native-windows' });
  assert.equal(plan.full, false);
  assert.deepEqual(
    plan.workers.map(({ id }) => id),
    ['native-windows'],
  );
  assert.equal(plan.workers[0].runner, 'windows-latest');
  assert.equal(plan.suites['windows-shell'].filter, suites['windows-shell'].filter);
  assert.equal(plan.suites.desktop.filter, suites.desktop.filter);
  assert.equal(plan.suites['windows-nsh'], undefined);
  assert.equal(plan.suites.root, undefined);
  assert.equal(plan.suites['macos-nsh'], undefined);
  assert.throws(
    () => createPlan({ root, revision: 'head', worker: 'missing' }),
    /Unknown CI worker/,
  );
});

test('worker suites all execute and preserve every failure', async () => {
  const attempted = [];
  const errors = [new Error('native compile failed'), new Error('pixel assertion failed')];
  await assert.rejects(
    runSuites(['native', 'desktop', 'pixels'], async (id) => {
      attempted.push(id);
      if (id === 'native') throw errors[0];
      if (id === 'pixels') throw errors[1];
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(
        error.errors.map((failure) => failure.cause),
        errors,
      );
      return true;
    },
  );
  assert.deepEqual(attempted, ['native', 'desktop', 'pixels']);
  await runSuites(['desktop'], async () => {});
});

const root = fileURLToPath(new URL('../', import.meta.url));
const full = () =>
  createPlan({ root, changes: null, metadata: {}, revision: 'test-revision', baseline: null });
const successful = () =>
  Object.fromEntries(
    ['plan', 'tooling', 'suites', 'root-build', 'root-tests'].map((id) => [
      id,
      { result: 'success' },
    ]),
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
    const failedProducer = successful();
    failedProducer['root-build'].result = 'failure';
    assert.throws(
      () => checkResults(plan, failedProducer, undefined),
      /Required CI jobs did not succeed: root-build/,
    );
  }
});

test('an embedded product Markdown change selects its actual runtime consumers', () => {
  for (const path of [
    'skills/maka-generative-ui/SKILL.md',
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
    assert.match(plan.suites.root.filter, /package\(=maka-cli\)/);
    assert.match(plan.suites.root.filter, /package\(=maka-skills\)/);
    assert.match(plan.suites.root.filter, /package\(=maka-skills-native\)/);
    assert.doesNotMatch(plan.suites.root.filter, /package\(=maka-agent-native\)/);
    assert.match(plan.suites.root.reason, /runtime inputs/);
  }
});

test('helper process changes reach integration consumers outside the Cargo dependency edges', () => {
  const packages = [
    ['maka-python-runtime', 'platform/python-runtime'],
    ['maka-cli', 'products/maka/cli'],
    ['maka-agent-native', 'plugins/agent/native'],
    ['maka-computer-native', 'plugins/computer/native'],
    ['maka-eval', 'products/eval'],
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
  assert.equal(plan.suites.root.filter, 'package(=maka-cli)');
  assert.ok(plan.suites.desktop);
  assert.ok(plan.suites['macos-agent-execution']);
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
  for (const id of [
    'linux-checks',
    'nsh',
    'macos-nsh',
    'windows-nsh',
    'native-macos',
    'native-windows',
  ]) {
    assert.ok(
      plan.workers.some((worker) => worker.id === id),
      id,
    );
  }
});

test('external_jobs run on macOS and the Linux ACP subset runs on linux-checks', () => {
  const plan = full();
  assert.equal(
    plan.workers.find((worker) => worker.id === 'native-macos-agent'),
    undefined,
  );
  const worker = plan.workers.find((worker) => worker.id === 'native-macos');
  assert.ok(worker.suites.includes('macos-agent-execution'));
  assert.ok(!worker.suites.includes('macos-nsh'));
  assert.ok(!suites['macos-agent-execution'].cargoArgs.includes('--workspace'));
  assert.equal(plan.suites['macos-agent-execution'].filter, 'binary_id(=maka-cli::external_jobs)');
  const linux = plan.workers.find(({ id }) => id === 'linux-checks');
  assert.ok(linux.suites.includes('linux-agent-execution'));
  assert.match(
    plan.suites['linux-agent-execution'].filter,
    /test\(=antigravity_can_continue_after_host_restarts_during_a_prompt\)/,
  );
  assert.match(
    plan.suites['linux-agent-execution'].filter,
    /test\(=antigravity_keeps_the_peer_alive_while_a_worker_fails_to_close\)/,
  );
});

test('Node tooling tests under scripts/ map to tooling instead of triggering full CI', () => {
  const plan = createPlan({
    root,
    changes: ['scripts/rust/build-v8.test.mjs'],
    metadata: {},
    revision: 'test',
    baseline: 'base',
  });
  assert.equal(plan.full, false);
  assert.ok(plan.suites.tooling);
  assert.equal(plan.suites.root, undefined);
  assert.deepEqual(plan.workers, []);
});

test('locales.manifest.json triggers a full CI plan including contracts, product, and native builds', () => {
  const plan = createPlan({
    root,
    changes: ['locales.manifest.json'],
    metadata: {},
    revision: 'test',
    baseline: 'base',
  });
  assert.equal(plan.full, true);
  for (const id of ['tooling', 'contracts', 'product', 'root', 'native-build']) {
    assert.ok(plan.suites[id], `expected suite ${id}`);
  }
});

test('skill and product inputs still select the native Windows skills consumer', () => {
  for (const path of [
    'skills/maka-generative-ui/SKILL.md',
    'skills/maka-plugin-authoring/SKILL.md',
  ]) {
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
  }
});

test('Windows process, sandbox and account-guard regressions are selected from their actual consumers', () => {
  const packages = [
    ['maka-host-runtime', 'platform/host-runtime'],
    ['maka-process', 'platform/process'],
    ['maka-sandbox', 'platform/sandbox'],
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
  for (const path of [
    'platform/host-runtime/src/sandbox/windows/guards.rs',
    'platform/process/tests/integration/conpty.rs',
    'platform/sandbox/src/lib.rs',
  ]) {
    const plan = createPlan({
      root,
      changes: [path],
      metadata,
      revision: 'test',
      baseline: 'base',
    });
    assert.equal(plan.full, false);
    const worker = plan.workers.find((entry) => entry.id === 'native-windows');
    assert.ok(worker.suites.includes('windows-shell'));
    assert.match(plan.suites['windows-shell'].filter, /binary_id\(=maka-process::integration\)/);
    assert.match(plan.suites['windows-shell'].filter, /sandbox::windows::guards::tests::/);
    assert.match(
      plan.suites['windows-shell'].filter,
      /native_task_namespace_can_be_denied_by_policy/,
    );
    assert.ok(!suites['windows-shell'].cargoArgs.includes('--workspace'));
    for (const pkg of [
      'maka-process',
      'maka-settings-native',
      'maka-host-runtime',
      'maka-sandbox',
    ]) {
      assert.ok(suites['windows-shell'].cargoArgs.includes(pkg));
      assert.ok(worker.cargoScope.includes(pkg));
    }
  }
});

test('Windows Host policy path regressions run for their actual consumers', () => {
  const packages = [
    [
      'maka-processes-native',
      'plugins/workspace/workspace-processes/native/src/execute.rs',
      'managed_worktree_shell_keeps_writes_inside_its_workspace',
    ],
    ['maka-sandbox', 'platform/sandbox/src/path.rs', 'resolved_path_projection'],
  ].map(([name, path, filter]) => ({
    name,
    id: name,
    source: null,
    manifest_path: join(root, dirname(dirname(path)), 'Cargo.toml'),
    path,
    filter,
  }));
  const metadata = {
    root: {
      packages,
      workspace_members: packages.map(({ id }) => id),
      resolve: { nodes: packages.map(({ id }) => ({ id, deps: [] })) },
    },
  };
  for (const pkg of packages) {
    const plan = createPlan({
      root,
      changes: [pkg.path],
      metadata,
      revision: 'test',
      baseline: 'base',
    });
    const worker = plan.workers.find(({ id }) => id === 'native-windows');
    assert.ok(worker.suites.includes('windows-shell'));
    assert.ok(worker.cargoScope.includes(pkg.name));
    assert.ok(suites['windows-shell'].cargoArgs.includes(pkg.name));
    assert.ok(plan.suites['windows-shell'].filter.includes(pkg.filter));
  }
});

test('Desktop regressions compile only the native-desktop CLI test target with default features', () => {
  const plan = full();
  assert.equal(
    plan.suites.desktop.filter,
    'binary_id(=maka-cli::native-desktop) & test(terminal::desktop_new_session)',
  );
  assert.ok(!suites.desktop.cargoArgs.includes('--workspace'));
  assert.ok(!suites.desktop.cargoArgs.includes('--no-default-features'));
  assert.ok(suites.desktop.cargoArgs.includes('maka-cli'));
  assert.ok(suites.desktop.cargoArgs.includes('native-desktop'));
  assert.equal(
    suites.desktop.cargoArgs[suites.desktop.cargoArgs.indexOf('--features') + 1],
    'desktop-tests',
  );
});

test('native pixel and desktop regressions run only on their native OS workers', () => {
  const plan = createPlan({ root, revision: 'head' });
  for (const id of ['desktop', 'pixels']) {
    assert.deepEqual(
      [
        ...new Set(
          plan.workers
            .filter((worker) => worker.suites.includes(id))
            .map((worker) => worker.runner),
        ),
      ],
      ['macos-latest', 'windows-latest'],
    );
  }
  const winDesktopWorkers = plan.workers.filter(
    (worker) => worker.runner === 'windows-latest' && worker.suites.includes('desktop'),
  );
  assert.deepEqual(
    winDesktopWorkers.map((worker) => worker.id),
    ['native-windows'],
  );
  assert.deepEqual(
    plan.workers
      .filter((worker) => worker.suites.includes('linux-nsh'))
      .map((worker) => worker.runner),
    ['ubuntu-latest'],
  );
  assert.equal(plan.suites.gpui, undefined);
});

test('non-archived native regressions fail empty selections and GTK runs under Xvfb', async () => {
  const calls = [];
  const nativeTarget = join(root, 'native-nsh-target');
  const exec = executor(
    root,
    {},
    {
      run: async (exe, args) => {
        calls.push({ exe, args });
        return args[0] === 'metadata' ? JSON.stringify({ target_directory: nativeTarget }) : '';
      },
    },
  );
  for (const id of [
    'pixels',
    'linux-nsh',
    'linux-desktop',
    'macos-nsh',
    'macos-surface',
    'windows-nsh',
  ])
    await exec.verify(id);
  for (const call of calls.filter(({ args }) => args.includes('nextest'))) {
    assert(call.args.includes('--no-tests=fail'));
    assert(call.args.includes('--no-fail-fast'));
  }
  assert(calls.some(({ args }) => args.includes('native-pixels')));
  assert(calls.some(({ args }) => args.includes('terminal_native') && !args.includes('--lib')));
  assert(calls.some(({ args }) => args.includes('native') && args.includes('--ignored')));
  assert(
    calls.some(({ args }) => args.includes('crates/nsh-platform-macos/tests/host/Undo.test.tsx')),
  );
  assert.equal(
    calls.find(({ args }) => args.includes('crates/nsh-platform-macos/tests/host/Undo.test.tsx'))
      .exe,
    join(nativeTarget, 'debug/nsh'),
  );
  assert(calls.some(({ exe, args }) => exe === 'xvfb-run' && args[0] === '-a'));
  const gtk = calls.find(({ args }) => args.includes('maka-desktop-shell'));
  assert.deepEqual(gtk, {
    exe: 'xvfb-run',
    args: [
      '-a',
      'dbus-run-session',
      '--',
      'cargo',
      'nextest',
      'run',
      '--locked',
      '--workspace',
      '--bin',
      'maka-desktop-shell',
      '--test',
      'open_directly',
      '-E',
      'package(=maka-desktop-shell)',
      '--no-tests=fail',
      '--no-fail-fast',
      '--run-ignored=all',
      '-j',
      '1',
    ],
  });
  await exec.prepare('linux-desktop');
  assert.deepEqual(calls.at(-1), {
    exe: 'cargo',
    args: [
      'nextest',
      'run',
      '--locked',
      '--workspace',
      '--bin',
      'maka-desktop-shell',
      '--test',
      'open_directly',
      '-E',
      'package(=maka-desktop-shell)',
      '--no-run',
    ],
  });
  const beforeMac = calls.length;
  await exec.prepare('macos-nsh');
  const macCalls = calls.slice(beforeMac);
  const nativeCheck = macCalls.find(({ args }) => args[0] === 'check');
  assert.equal(nativeCheck.exe, 'cargo');
  assert(nativeCheck.args.includes('--all-targets'));
  assert(nativeCheck.args.includes('nsh-platform-macos/terminal'));
  assert(!nativeCheck.args.includes('--lib'));
  const hostBuild = macCalls.find(({ args }) => args[0] === 'build');
  assert.equal(hostBuild.exe, 'cargo');
  assert(hostBuild.args.includes('nsh-cli'));
  assert(hostBuild.args.includes('nsh-macos-host'));
  assert(hostBuild.args.includes('--bins'));
});

test('NSH native failures do not mask browser compilation or independent checks', async () => {
  const calls = [];
  const exec = executor(
    root,
    {},
    {
      run: async (exe, args, options) => {
        calls.push({ exe, args, cwd: options.cwd });
        if (calls.length === 1) throw new Error('native tests failed');
        return '';
      },
    },
  );
  await assert.rejects(exec.prepare('nsh'), /CI suites failed/);
  assert(
    calls.some(
      ({ exe, args }) => exe === 'rustup' && args.join(' ') === 'target add wasm32-unknown-unknown',
    ),
  );
  assert.deepEqual(calls.at(-1), {
    exe: 'cargo',
    args: [
      'check',
      '--locked',
      '-p',
      'nsh-platform-web',
      '--target',
      'wasm32-unknown-unknown',
      '--no-default-features',
      '--features',
      'browser,linkable,dev,compiler,browser-tests',
    ],
    cwd: join(root, 'third-party/nsh'),
  });
  calls.length = 0;
  await assert.rejects(exec.verify('nsh'), /CI suites failed/);
  assert.equal(calls.length, 5);
  assert(calls.some(({ args }) => args.includes('--doc') && args.includes('--no-fail-fast')));
  assert(calls.some(({ args }) => args.includes('text') && args.includes('--no-fail-fast')));
  assert(calls.some(({ args }) => args.includes('browser_bootstrap')));
  assert(
    calls.at(-1).args.includes('third-party/nsh/crates/nsh-platform-web/web/browser/dom.test.mjs'),
  );
});

test('CI setup installs release tools and stages V8 archives via GitHub API with digest checks and 504 retries', async () => {
  const execAsync = promisify(execFile);
  const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const cpu = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
  const exeSuffix = process.platform === 'win32' ? '.exe' : '';
  const nextestTarget =
    process.platform === 'darwin'
      ? 'universal-apple-darwin'
      : process.platform === 'linux'
        ? `${cpu}-unknown-linux-gnu`
        : `${cpu}-pc-windows-msvc`;
  const denyTarget =
    process.platform === 'darwin'
      ? `${cpu}-apple-darwin`
      : process.platform === 'linux'
        ? `${cpu}-unknown-linux-musl`
        : `${cpu}-pc-windows-msvc`;
  const v8Target = `${cpu}-${
    { darwin: 'apple-darwin', linux: 'unknown-linux-gnu', win32: 'pc-windows-msvc' }[
      process.platform
    ]
  }`;
  const v8AssetName =
    process.platform === 'win32'
      ? `rusty_v8_simdutf_release_${v8Target}.lib.gz`
      : `librusty_v8_simdutf_release_${v8Target}.a.gz`;

  const workspaceDir = mkdtempSync(join(tmpdir(), 'maka-ci-api-setup-'));
  const makeTarGz = (entries) => {
    const buildDir = mkdtempSync(join(workspaceDir, 'tar-'));
    for (const [relativePath, content] of Object.entries(entries)) {
      const full = join(buildDir, relativePath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    execFileSync('tar', ['-czf', '../archive.tar.gz', '.'], { cwd: buildDir });
    const bytes = readFileSync(join(buildDir, '../archive.tar.gz'));
    rmSync(join(buildDir, '../archive.tar.gz'), { force: true });
    rmSync(buildDir, { recursive: true, force: true });
    return bytes;
  };

  const nextestTar = makeTarGz({ [`cargo-nextest${exeSuffix}`]: 'nextest-binary-payload' });
  const denyTar = makeTarGz({
    [`cargo-deny-0.20.2-${denyTarget}/cargo-deny${exeSuffix}`]: 'deny-binary-payload',
  });
  const v8Archive = Buffer.from('prebuilt-v8-static-library-payload');
  const v8Bytes = gzipSync(v8Archive);

  let corruptNextest = false;
  let transient504Remaining = 1;
  let apiHits = 0;
  let baseUrl = '';
  const server = createServer((req, res) => {
    apiHits++;
    if (req.url.startsWith('/repos/')) {
      assert.equal(req.headers.authorization, 'Bearer test-gh-token');
    }
    if (
      transient504Remaining > 0 &&
      req.url === '/repos/EmbarkStudios/cargo-deny/releases/latest'
    ) {
      transient504Remaining--;
      res.writeHead(504).end('Gateway Time-out');
      return;
    }
    if (req.url === '/repos/EmbarkStudios/cargo-deny/releases/latest') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          assets: [
            {
              name: `cargo-deny-0.20.2-${denyTarget}.tar.gz`,
              url: `${baseUrl}/repos/EmbarkStudios/cargo-deny/releases/assets/1`,
              digest: sha256(denyTar),
            },
          ],
        }),
      );
      return;
    }
    if (req.url === '/repos/nextest-rs/nextest/releases/tags/cargo-nextest-0.9.100') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          assets: [
            {
              name: `cargo-nextest-0.9.100-${nextestTarget}.tar.gz`,
              url: `${baseUrl}/repos/nextest-rs/nextest/releases/assets/2`,
              digest: sha256(nextestTar),
            },
          ],
        }),
      );
      return;
    }
    if (req.url === '/repos/denoland/rusty_v8/releases/tags/v150.4.0') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          assets: [
            {
              name: v8AssetName,
              url: `${baseUrl}/repos/denoland/rusty_v8/releases/assets/3`,
              digest: sha256(v8Bytes),
            },
          ],
        }),
      );
      return;
    }
    if (req.url === '/repos/EmbarkStudios/cargo-deny/releases/assets/1') {
      assert.equal(req.headers.accept, 'application/octet-stream');
      res.writeHead(302, { Location: `${baseUrl}/blob/deny` }).end();
      return;
    }
    if (req.url === '/repos/nextest-rs/nextest/releases/assets/2') {
      assert.equal(req.headers.accept, 'application/octet-stream');
      res.writeHead(302, { Location: `${baseUrl}/blob/nextest` }).end();
      return;
    }
    if (req.url === '/repos/denoland/rusty_v8/releases/assets/3') {
      assert.equal(req.headers.accept, 'application/octet-stream');
      res.writeHead(302, { Location: `${baseUrl}/blob/v8` }).end();
      return;
    }
    if (req.url === '/blob/deny') {
      res.writeHead(200).end(denyTar);
      return;
    }
    if (req.url === '/blob/nextest') {
      res.writeHead(200).end(corruptNextest ? Buffer.from('corrupted') : nextestTar);
      return;
    }
    if (req.url === '/blob/v8') {
      res.writeHead(200).end(v8Bytes);
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const cargoHome = join(workspaceDir, 'cargo-home');
  const targetDir = join(workspaceDir, 'target');
  writeFileSync(
    join(workspaceDir, 'Cargo.lock'),
    'version = 4\n\n[[package]]\nname = "v8"\nversion = "150.4.0"\n',
  );
  const setupScript = fileURLToPath(new URL('./ci/setup.mjs', import.meta.url));
  const runSetup = (action, extraEnv = {}) =>
    execAsync(process.execPath, [setupScript, action], {
      cwd: workspaceDir,
      env: {
        ...process.env,
        CARGO_HOME: cargoHome,
        CARGO_TARGET_DIR: join(workspaceDir, 'ignored-outer-target'),
        GH_TOKEN: 'test-gh-token',
        MAKA_CI_GITHUB_API: baseUrl,
        MAKA_CI_RETRY_DELAY_MS: '5',
        ...extraEnv,
      },
    });

  try {
    await runSetup('tools', { MAKA_CI_ROLE: 'tooling', MAKA_CI_WORKSPACE: 'root' });
    assert.equal(
      readFileSync(join(cargoHome, 'bin', `cargo-deny${exeSuffix}`), 'utf8'),
      'deny-binary-payload',
    );
    assert.equal(transient504Remaining, 0, 'transient 504 must be retried');

    corruptNextest = true;
    await assert.rejects(
      runSetup('tools', {
        MAKA_CI_ROLE: 'replay',
        MAKA_CI_WORKSPACE: 'root',
        MAKA_CI_NEXTEST: '0.9.100',
      }),
      /Digest mismatch/,
    );
    assert.equal(existsSync(join(cargoHome, 'bin', `cargo-nextest${exeSuffix}`)), false);

    corruptNextest = false;
    await runSetup('tools', {
      MAKA_CI_ROLE: 'replay',
      MAKA_CI_WORKSPACE: 'root',
      MAKA_CI_NEXTEST: '0.9.100',
    });
    assert.equal(
      readFileSync(join(cargoHome, 'bin', `cargo-nextest${exeSuffix}`), 'utf8'),
      'nextest-binary-payload',
    );

    await runSetup('v8', { MAKA_CI_ROLE: 'packaging', MAKA_CI_WORKSPACE: 'root' });
    const expectedV8Url = `https://github.com/denoland/rusty_v8/releases/download/v150.4.0/${v8AssetName}`;
    const expectedV8Path = join(
      cargoHome,
      '.rusty_v8',
      expectedV8Url.replace(/[^0-9A-Za-z]/gu, '_'),
    );
    const objDir = join(targetDir, 'debug', 'gn_out', 'obj');
    const expectedLibPath = join(
      objDir,
      process.platform === 'win32' ? 'rusty_v8.lib' : 'librusty_v8.a',
    );
    const expectedSumPath = join(
      objDir,
      process.platform === 'win32' ? 'rusty_v8.sum' : 'librusty_v8.sum',
    );
    assert.deepEqual(readFileSync(expectedV8Path), v8Bytes);
    const buildObjDir = join(targetDir, 'debug', 'build', 'gn_out', 'obj');
    const buildLibPath = join(
      buildObjDir,
      process.platform === 'win32' ? 'rusty_v8.lib' : 'librusty_v8.a',
    );
    const buildSumPath = join(
      buildObjDir,
      process.platform === 'win32' ? 'rusty_v8.sum' : 'librusty_v8.sum',
    );
    assert.deepEqual(readFileSync(expectedLibPath), v8Archive);
    assert.equal(readFileSync(expectedSumPath, 'utf8'), expectedV8Url);
    assert.deepEqual(readFileSync(buildLibPath), v8Archive);
    assert.equal(readFileSync(buildSumPath, 'utf8'), expectedV8Url);
    assert.match(
      readFileSync(join(targetDir, 'CACHEDIR.TAG'), 'utf8'),
      /^Signature: 8a477f597d28d172789f06886806bc55\n/u,
    );

    const hitsBeforeRepeat = apiHits;
    await runSetup('v8', { MAKA_CI_ROLE: 'packaging', MAKA_CI_WORKSPACE: 'root' });
    assert.equal(apiHits, hitsBeforeRepeat, 'already-staged V8 archive must not hit network');

    rmSync(objDir, { recursive: true, force: true });
    await runSetup('v8', { MAKA_CI_ROLE: 'packaging', MAKA_CI_WORKSPACE: 'root' });
    assert.equal(
      apiHits,
      hitsBeforeRepeat,
      'missing target gn_out must hydrate from cached .rusty_v8 without network',
    );
    assert.deepEqual(readFileSync(expectedLibPath), v8Archive);
    assert.equal(readFileSync(expectedSumPath, 'utf8'), expectedV8Url);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('Linux consolidates root verification workers and reuses the root compiler cache read-only', () => {
  const plan = full();
  const worker = plan.workers.find((worker) => worker.id === 'linux-checks');
  assert.deepEqual(suites['linux-desktop'].packages, ['maka-desktop-shell']);
  assert.deepEqual(worker.suites, [
    'contracts',
    'product',
    'native-build',
    'native',
    'linux-desktop',
    'linux-agent-execution',
    'bridge',
  ]);
  assert.equal(worker.dependencies, 'headless');
  assert.equal(worker.javascript, true);
  assert.equal(worker.cacheRole, 'root');
  assert.equal(worker.saveCache, false);
  for (const entry of plan.workers) {
    assert.equal(typeof entry.saveCache, 'boolean', entry.id);
  }
  const nshWorker = plan.workers.find((worker) => worker.id === 'nsh');
  assert.deepEqual(nshWorker.suites, ['nsh', 'linux-nsh']);
});

test('Linux platform and embedded icon inputs reach the display-backed desktop consumer', () => {
  const packages = [
    ['maka-desktop-shell', 'products/maka/desktop-shell'],
    ['nsh-platform-linux', 'third-party/nsh/crates/nsh-platform-linux'],
  ].map(([name, path]) => ({
    name,
    id: name,
    source: null,
    manifest_path: join(root, path, 'Cargo.toml'),
  }));
  const metadata = {
    root: {
      packages,
      workspace_members: packages.map(({ id }) => id),
      resolve: {
        nodes: [
          { id: 'maka-desktop-shell', deps: [{ pkg: 'nsh-platform-linux' }] },
          { id: 'nsh-platform-linux', deps: [] },
        ],
      },
    },
  };
  for (const path of [
    'products/maka/desktop-shell/src/linux.rs',
    'third-party/nsh/crates/nsh-platform-linux/src/app.rs',
    'third-party/nsh/crates/nsh-platform-linux/src/tray.rs',
    'products/maka/workbench/app/assets/maka.png',
  ]) {
    const plan = createPlan({
      root,
      changes: [path],
      metadata,
      revision: 'test',
      baseline: 'base',
    });
    assert.equal(plan.full, false, path);
    assert.ok(plan.suites['linux-desktop'], path);
    const worker = plan.workers.find(({ id }) => id === 'linux-checks');
    assert.ok(worker.suites.includes('linux-desktop'), path);
    assert.equal(worker.dependencies, 'headless');
    assert.equal(worker.javascript, true);
  }
});

test('frontend workbench edits stay scoped to UI/product consumers and skip unrelated backend/vendored suites', () => {
  const packages = [
    ['maka-workbench', 'products/maka/workbench'],
    ['maka-cli', 'products/maka/cli'],
    ['maka-agent-native', 'plugins/agent/native'],
    ['maka-terminal-shell', 'products/maka/terminal-shell'],
    ['maka-desktop-shell', 'products/maka/desktop-shell'],
  ].map(([name, directory]) => ({
    name,
    id: name,
    source: null,
    manifest_path: join(root, directory, 'Cargo.toml'),
  }));
  const plan = createPlan({
    root,
    revision: 'head',
    baseline: 'base',
    changes: ['products/maka/workbench/app/Conversation.tsx'],
    metadata: {
      root: {
        packages,
        workspace_members: packages.map((pkg) => pkg.id),
        resolve: {
          nodes: [
            { id: 'maka-workbench', deps: [] },
            { id: 'maka-cli', deps: [{ pkg: 'maka-workbench' }] },
            { id: 'maka-terminal-shell', deps: [{ pkg: 'maka-workbench' }] },
            { id: 'maka-desktop-shell', deps: [{ pkg: 'maka-workbench' }] },
            { id: 'maka-agent-native', deps: [] },
          ],
        },
      },
    },
  });
  assert.equal(plan.full, false);
  assert.ok(plan.suites.contracts);
  assert.ok(plan.suites.product);
  assert.ok(plan.suites.desktop);
  assert.match(plan.suites.root.filter, /package\(=maka-cli\)/);
  assert.doesNotMatch(plan.suites.root.filter, /package\(=maka-agent-native\)/);
  assert.equal(plan.suites.bridge, undefined);
  assert.equal(plan.suites['macos-agent-execution'], undefined);
  assert.equal(plan.suites['windows-skills'], undefined);
  assert.equal(plan.suites.nsh, undefined);
  assert.equal(plan.suites.termina, undefined);
});

test('branch push with fullRoot keeps full root coverage while skipping untouched vendored workspaces', () => {
  const packages = [
    ['maka-agent-native', 'plugins/agent/native'],
    ['maka-cli', 'products/maka/cli'],
  ].map(([name, directory]) => ({
    name,
    id: name,
    source: null,
    manifest_path: join(root, directory, 'Cargo.toml'),
  }));
  const plan = createPlan({
    root,
    revision: 'head',
    baseline: 'base',
    fullRoot: true,
    changes: ['plugins/agent/native/src/owner.rs'],
    metadata: {
      root: {
        packages,
        workspace_members: packages.map((pkg) => pkg.id),
        resolve: {
          nodes: [
            { id: 'maka-agent-native', deps: [] },
            { id: 'maka-cli', deps: [{ pkg: 'maka-agent-native' }] },
          ],
        },
      },
    },
  });
  assert.equal(plan.full, false);
  assert.equal(plan.suites.root.filter, 'all()');
  assert.ok(plan.workers.some((w) => w.id === 'linux-checks'));
  assert.ok(plan.workers.some((w) => w.id === 'native-macos'));
  assert.ok(plan.workers.some((w) => w.id === 'native-windows'));
  assert.ok(!plan.workers.some((w) => w.id === 'nsh'));
  assert.ok(!plan.workers.some((w) => w.id === 'macos-nsh'));
  assert.ok(!plan.workers.some((w) => w.id === 'windows-nsh'));
  assert.ok(!plan.workers.some((w) => w.id === 'termina'));
});

test('scoped native workers compile once with one unified Cargo feature scope', async () => {
  const plan = full();
  const worker = plan.workers.find((entry) => entry.id === 'native-macos');
  const helperDir = mkdtempSync(join(tmpdir(), 'maka-ci-scope-helpers-'));
  try {
    const makaBin = join(helperDir, 'maka');
    const pyBin = join(helperDir, 'maka-python-worker');
    writeFileSync(makaBin, '');
    writeFileSync(pyBin, '');
    const calls = [];
    const exec = executor(root, worker, {
      run: async (exe, args) => {
        calls.push({ exe, args });
        if (args[0] === 'build' && args.includes('--message-format=json-render-diagnostics')) {
          return [
            JSON.stringify({
              reason: 'compiler-artifact',
              target: { name: 'maka', kind: ['bin'] },
              profile: { test: false },
              executable: makaBin,
            }),
            JSON.stringify({
              reason: 'compiler-artifact',
              target: { name: 'maka-python-worker', kind: ['bin'] },
              profile: { test: false },
              executable: pyBin,
            }),
          ].join('\n');
        }
        return '';
      },
    });
    await exec.prepareWorker(worker.suites, plan.suites);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], {
      exe: 'cargo',
      args: [
        'nextest',
        'run',
        ...worker.cargoScope,
        '--lib',
        '--bin',
        'maka',
        '--test',
        'integration',
        '--bin',
        'maka-desktop-shell',
        '--test',
        'open_directly',
        '--test',
        'external_jobs',
        '--test',
        'native-desktop',
        '--test',
        'native-pixels',
        '--no-run',
      ],
    });
    assert.deepEqual(calls[1], {
      exe: 'cargo',
      args: [
        'build',
        ...worker.cargoScope,
        '--bin',
        'maka',
        '--bin',
        'maka-python-worker',
        '--message-format=json-render-diagnostics',
      ],
    });
  } finally {
    rmSync(helperDir, { recursive: true, force: true });
  }
});

test('memory resolver prompt changes reach native and product consumers', () => {
  const path = 'plugins/agent/native/src/owner/memory/resolution-prompt.md';
  assert.equal(documentation(path), false);
  const packages = [
    ['maka-agent-native', 'plugins/agent/native'],
    ['maka-cli', 'products/maka/cli'],
  ].map(([name, directory]) => ({
    name,
    id: name,
    source: null,
    manifest_path: join(root, directory, 'Cargo.toml'),
  }));
  const plan = createPlan({
    root,
    revision: 'head',
    baseline: 'base',
    changes: [path],
    metadata: {
      root: {
        packages,
        workspace_members: packages.map((pkg) => pkg.id),
        resolve: {
          nodes: [
            { id: 'maka-agent-native', deps: [] },
            { id: 'maka-cli', deps: [{ pkg: 'maka-agent-native' }] },
          ],
        },
      },
    },
  });
  assert.equal(plan.full, false);
  assert.match(plan.suites.root.filter, /package\(=maka-agent-native\)/);
  assert.match(plan.suites.root.filter, /package\(=maka-cli\)/);
});

test('every root suite package reference matches a real workspace crate', () => {
  const metadata = JSON.parse(
    execFileSync('cargo', ['metadata', '--no-deps', '--format-version', '1'], {
      cwd: root,
      maxBuffer: 50 * 1024 * 1024,
    }),
  );
  const actual = new Set(metadata.packages.map((pkg) => pkg.name));
  const missing = [];
  for (const [id, suite] of Object.entries(suites)) {
    if (suite.workspace !== 'root') continue;
    const refs = [
      ...(Array.isArray(suite.packages) ? suite.packages : []),
      ...(suite.extraInputPackages ?? []).flatMap((entry) => entry.packages),
    ];
    for (const pkg of refs) {
      if (!actual.has(pkg)) missing.push(`${id}:${pkg}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('stacked PR baseline uses synthetic merge first parent to exclude unrelated trunk commits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'maka-ci-stack-'));
  const orig = join(dir, 'orig');
  const depth2 = join(dir, 'depth2');
  const depth1 = join(dir, 'depth1');
  const git = (cwd, args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    }).trim();
  try {
    mkdirSync(orig);
    git(orig, ['init', '-b', 'main']);
    writeFileSync(join(orig, 'base.txt'), 'base\n');
    git(orig, ['add', 'base.txt']);
    git(orig, ['commit', '-m', 'init']);
    git(orig, ['checkout', '-b', 'pr1']);
    writeFileSync(join(orig, 'lower.txt'), 'lower\n');
    git(orig, ['add', 'lower.txt']);
    git(orig, ['commit', '-m', 'lower PR']);
    const pr1Head = git(orig, ['rev-parse', 'HEAD']);
    git(orig, ['checkout', '-b', 'pr2']);
    writeFileSync(join(orig, 'upper.txt'), 'upper\n');
    git(orig, ['add', 'upper.txt']);
    git(orig, ['commit', '-m', 'upper PR']);
    const pr2Head = git(orig, ['rev-parse', 'HEAD']);
    git(orig, ['checkout', 'main']);
    writeFileSync(join(orig, 'trunk-only.txt'), 'trunk\n');
    git(orig, ['add', 'trunk-only.txt']);
    git(orig, ['commit', '-m', 'unrelated trunk commit']);
    git(orig, ['merge', '--no-ff', 'pr1', '-m', 'merge pr1 into main']);
    const pr1Merge = git(orig, ['rev-parse', 'HEAD']);
    git(orig, ['merge', '--no-ff', 'pr2', '-m', 'merge pr2 into pr1 merge']);

    const remoteUrl = pathToFileURL(orig).href;
    execFileSync('git', ['clone', '--depth=2', remoteUrl, depth2], { stdio: 'pipe' });
    const resolved = await resolvePullRequestBaseline(depth2, {
      base: { sha: pr1Head },
      head: { sha: pr2Head },
    });
    assert.deepEqual(resolved, { baseline: pr1Merge, fetch: false });
    assert.deepEqual(
      git(depth2, ['diff', '--name-only', resolved.baseline, 'HEAD']).split('\n').filter(Boolean),
      ['upper.txt'],
    );

    execFileSync('git', ['clone', '--depth=1', remoteUrl, depth1], { stdio: 'pipe' });
    const fallback = await resolvePullRequestBaseline(depth1, {
      base: { sha: pr1Head },
      head: { sha: pr2Head },
    });
    assert.deepEqual(fallback, { baseline: pr1Head, fetch: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
