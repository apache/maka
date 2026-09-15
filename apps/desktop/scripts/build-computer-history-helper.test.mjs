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
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { resolveDesktopBuilderConfig } from '../electron-builder.config.mjs';
import { buildComputerHistoryHelper } from './build-computer-history-helper.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'maka-history-build with spaces-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function put(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

test('Windows builds the locked x64 MSVC binary and stages only the exe', async (t) => {
  const root = await fixture(t);
  const packageRoot = join(root, 'native', 'computer-history-windows');
  const targetDirectory = join(packageRoot, 'target');
  const source = join(targetDirectory, 'x86_64-pc-windows-msvc', 'release', 'open-history.exe');
  const output = join(root, 'resources', 'bin', 'open-history.exe');
  const calls = [];
  await put(output, 'old Windows helper');
  const macOutput = join(root, 'resources', 'bin', 'open-history');
  await put(macOutput, 'macOS helper');

  assert.equal(await buildComputerHistoryHelper({
    platform: 'win32',
    arch: 'x64',
    root,
    run: async (command, args) => {
      calls.push({ command, args });
      assert.equal(await readFile(output, 'utf8'), 'old Windows helper');
      await put(source, 'new Windows helper');
    },
  }), output);

  assert.deepEqual(calls, [{
    command: 'cargo',
    args: [
      'build',
      '--manifest-path', join(packageRoot, 'Cargo.toml'),
      '--package', 'maka-computer-history-windows',
      '--bin', 'open-history',
      '--release',
      '--locked',
      '--target', 'x86_64-pc-windows-msvc',
      '--target-dir', targetDirectory,
    ],
  }]);
  assert.equal(await readFile(output, 'utf8'), 'new Windows helper');
  assert.equal(await readFile(macOutput, 'utf8'), 'macOS helper');
});

test('macOS retains its existing Swift command and extensionless artifact', async (t) => {
  const root = await fixture(t);
  const packageRoot = join(root, 'native', 'computer-history');
  const calls = [];
  const output = await buildComputerHistoryHelper({
    platform: 'darwin',
    arch: 'arm64',
    root,
    run: async (command, args) => {
      calls.push({ command, args });
      await put(join(packageRoot, '.build', 'release', 'open-history'), 'Swift helper');
    },
  });
  assert.deepEqual(calls, [{
    command: 'swift',
    args: ['build', '--package-path', packageRoot, '-c', 'release', '--product', 'open-history'],
  }]);
  assert.equal(output, join(root, 'resources', 'bin', 'open-history'));
  assert.equal(await readFile(output, 'utf8'), 'Swift helper');
  await assert.rejects(access(`${output}.exe`), { code: 'ENOENT' });
});

test('Linux skips without invoking a compiler or creating resources', async (t) => {
  const root = await fixture(t);
  assert.equal(await buildComputerHistoryHelper({
    platform: 'linux',
    arch: 'x64',
    root,
    run: async () => assert.fail('Linux must not build a native helper'),
  }), null);
  await assert.rejects(access(join(root, 'resources')), { code: 'ENOENT' });
});

test('unsupported Windows architectures fail before building or staging', async (t) => {
  const root = await fixture(t);
  for (const arch of ['arm64', 'ia32']) {
    await assert.rejects(buildComputerHistoryHelper({
      platform: 'win32',
      arch,
      root,
      run: async () => assert.fail('unsupported architecture must not invoke Cargo'),
    }), /must be built on Windows x64/u);
  }
  await assert.rejects(access(join(root, 'resources')), { code: 'ENOENT' });
});

test('Cargo failure preserves the staged helper and rejects a stale build output', async (t) => {
  const root = await fixture(t);
  const output = join(root, 'resources', 'bin', 'open-history.exe');
  await put(output, 'previous staged helper');
  await put(join(root, 'native', 'computer-history-windows', 'target',
    'x86_64-pc-windows-msvc', 'release', 'open-history.exe'), 'stale build output');
  const failure = new Error('Cargo failed');
  await assert.rejects(buildComputerHistoryHelper({
    platform: 'win32',
    arch: 'x64',
    root,
    run: async () => { throw failure; },
  }), (error) => error === failure);
  assert.equal(await readFile(output, 'utf8'), 'previous staged helper');
});

test('a missing Windows artifact fails instead of accepting a successful command', async (t) => {
  const root = await fixture(t);
  await assert.rejects(buildComputerHistoryHelper({
    platform: 'win32',
    arch: 'x64',
    root,
    run: async () => {},
  }), { code: 'ENOENT' });
  await assert.rejects(access(join(root, 'resources', 'bin', 'open-history.exe')), { code: 'ENOENT' });
});

test('builder includes the matching history helper only on its target platform', () => {
  const config = resolveDesktopBuilderConfig({});
  const historyResources = (platform) =>
    [...config.extraResources, ...(config[platform].extraResources ?? [])]
      .filter(({ to }) => to.startsWith('bin/open-history'));
  assert.deepEqual(historyResources('win'), [{
    from: 'resources/bin/open-history.exe',
    to: 'bin/open-history.exe',
  }]);
  assert.deepEqual(historyResources('mac'), [{
    from: 'resources/bin/open-history',
    to: 'bin/open-history',
  }]);
  assert.deepEqual(historyResources('linux'), []);
  const historyLicenses = (platform) =>
    [...config.extraResources, ...(config[platform].extraResources ?? [])]
      .filter(({ to }) => to.startsWith('licenses/computer-history-windows/'));
  assert.deepEqual(historyLicenses('win'), [{
    from: 'resources/licenses/computer-history-windows/THIRD_PARTY_NOTICES.txt',
    to: 'licenses/computer-history-windows/THIRD_PARTY_NOTICES.txt',
  }]);
  assert.deepEqual(historyLicenses('mac'), []);
  assert.deepEqual(historyLicenses('linux'), []);
});
