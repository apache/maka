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
import { executor } from './ci/run.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { checkResults, createPlan, documentation } from './ci/plan.mjs';
import { suites } from './ci/suites.mjs';

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
  assert.equal(plan.suites.desktop.filter, 'test(terminal::desktop_new_session)');
  assert.ok(suites.desktop.cargoArgs.includes('--workspace'));
  assert.ok(!suites.desktop.cargoArgs.includes('--no-default-features'));
  assert.equal(
    suites.desktop.cargoArgs[suites.desktop.cargoArgs.indexOf('--features') + 1],
    'maka-cli/desktop-tests',
  );
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

test('non-archived native regressions fail empty selections and GTK runs under Xvfb', async () => {
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
  for (const id of ['pixels', 'linux-nsh', 'macos-nsh', 'macos-surface', 'windows-nsh'])
    await exec.verify(id);
  for (const call of calls) assert(call.args.includes('--no-tests=fail'));
  assert(calls.some(({ args }) => args.includes('native-pixels')));
  assert(calls.some(({ args }) => args.includes('terminal_native') && !args.includes('--lib')));
  assert(calls.some(({ exe, args }) => exe === 'xvfb-run' && args[0] === '-a'));
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
    assert.deepEqual(readFileSync(expectedLibPath), v8Archive);
    assert.equal(readFileSync(expectedSumPath, 'utf8'), expectedV8Url);
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

test('Linux keeps native Computer Use without the retired desktop engine', () => {
  const worker = full().workers.find((worker) => worker.id === 'native-ubuntu');
  assert.equal(suites['linux-desktop'], undefined);
  assert.deepEqual(worker.suites, ['native']);
  assert.equal(worker.dependencies, 'computer-use');
  assert.equal(worker.javascript, false);
});
