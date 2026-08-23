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
import { copyFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { createFilesystemWorkerLaunchSpecProvider } from '../filesystem-worker/launch-spec.js';

test('Linux Electron worker launch does not require a macOS Frameworks directory', async () => {
  const getLaunchSpec = createFilesystemWorkerLaunchSpecProvider({
    runtime: 'electron',
    platform: 'linux',
    executable: process.execPath,
    resourceLocation: { kind: 'runtime' },
  });

  const result = await getLaunchSpec();

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.spec.program, await realpath(process.execPath));
    assert.equal(result.spec.env.ELECTRON_RUN_AS_NODE, '1');
  }
});

test('macOS worker launch includes inspected ripgrep runtime directories', async () => {
  const executable = await realpath(process.execPath);
  const getLaunchSpec = createFilesystemWorkerLaunchSpecProvider({
    runtime: 'node',
    platform: 'darwin',
    executable,
    resourceLocation: { kind: 'runtime' },
    rgCandidates: [executable],
    inspectMacosExecutableDependencies: async (candidate) => ({
      ok: true,
      dependencyCount: 1,
      runtimeReadableRoots: ['/opt/toolchain/lib'],
      executableRoots: ['/opt/toolchain/bin', '/opt/toolchain/lib'],
    }),
  });

  const result = await getLaunchSpec();

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.spec.args.slice(-2), ['--grep-executable', executable]);
  assert.ok(result.spec.runtimeReadableRoots.includes('/opt/toolchain/lib'));
  assert.ok(result.spec.executableRoots.includes('/opt/toolchain/bin'));
  assert.ok(result.spec.executableRoots.includes('/opt/toolchain/lib'));
});

test('macOS worker omits ripgrep when dependency inspection fails', async () => {
  const executable = await realpath(process.execPath);
  const getLaunchSpec = createFilesystemWorkerLaunchSpecProvider({
    runtime: 'node',
    platform: 'darwin',
    executable,
    resourceLocation: { kind: 'runtime' },
    rgCandidates: [executable],
    inspectMacosExecutableDependencies: async () => ({
      ok: false,
      reason: 'dependency_unresolved',
      message: 'fixture failure',
    }),
  });

  const result = await getLaunchSpec();

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.spec.args.includes('--grep-executable'), false);
});

test('Windows packaged worker grants only its product-owned application directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-windows-launch-spec-'));
  try {
    const applicationDirectory = join(root, 'Programs', 'Maka');
    await mkdir(applicationDirectory, { recursive: true });
    const executable = join(applicationDirectory, 'Maka.exe');
    await copyFile(process.execPath, executable);
    const getLaunchSpec = createFilesystemWorkerLaunchSpecProvider({
      runtime: 'electron',
      platform: 'win32',
      executable,
      resourceLocation: { kind: 'runtime' },
      rgCandidates: [],
    });

    const result = await getLaunchSpec();

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const canonicalApplicationDirectory = await realpath(applicationDirectory);
    assert.ok(result.spec.runtimeReadableRoots.includes(canonicalApplicationDirectory));
    assert.ok(result.spec.executableRoots.includes(canonicalApplicationDirectory));
    assert.ok(!result.spec.runtimeReadableRoots.includes(dirname(canonicalApplicationDirectory)));
    // Electron's run-as-node entry aborts inside the AppContainer while
    // backfilling standard handles from the NUL device, which the container
    // denies. The broker always relays three valid handles, so the launch
    // skips that initialization.
    assert.equal(result.spec.args[0], '--no-stdio-init');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a node runtime worker never receives the Electron-only stdio switch', async () => {
  const getLaunchSpec = createFilesystemWorkerLaunchSpecProvider({
    runtime: 'node',
    platform: 'win32',
    executable: process.execPath,
    resourceLocation: { kind: 'runtime' },
    rgCandidates: [],
  });

  const result = await getLaunchSpec();

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.spec.args.includes('--no-stdio-init'), false);
});
