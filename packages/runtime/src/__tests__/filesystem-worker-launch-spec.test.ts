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
import { chmod, copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
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

test('a ripgrep installed after the first launch is found by the next one (#5169)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-launch-spec-rg-installed-'));
  try {
    const candidate = join(root, 'bin', 'rg');
    const getLaunchSpec = createFilesystemWorkerLaunchSpecProvider({
      runtime: 'node',
      platform: 'linux',
      executable: process.execPath,
      resourceLocation: { kind: 'runtime' },
      rgCandidates: [candidate],
    });
    const before = await getLaunchSpec();
    assert.equal(before.ok, true);
    if (!before.ok) return;
    assert.equal(before.spec.args.includes('--grep-executable'), false);

    await installExecutable(candidate);
    const after = await getLaunchSpec();

    assert.equal(after.ok, true);
    if (!after.ok) return;
    const installed = await realpath(candidate);
    assert.deepEqual(after.spec.args.slice(-2), ['--grep-executable', installed]);
    assert.ok(after.spec.executableRoots.includes(installed));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a ripgrep that disappears is replaced by the next launch, and only the replacement is granted (#5169)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-launch-spec-rg-replaced-'));
  try {
    const first = join(root, 'keg-14.1.0', 'rg');
    const second = join(root, 'keg-14.1.1', 'rg');
    await installExecutable(first);
    const firstReal = await realpath(first);
    const getLaunchSpec = createFilesystemWorkerLaunchSpecProvider({
      runtime: 'node',
      platform: 'linux',
      executable: process.execPath,
      resourceLocation: { kind: 'runtime' },
      rgCandidates: [first, second],
    });
    const before = await getLaunchSpec();
    assert.equal(before.ok, true);
    if (!before.ok) return;
    assert.deepEqual(before.spec.args.slice(-2), ['--grep-executable', firstReal]);

    // A package upgrade removes the old keg and installs the new one.
    await rm(dirname(first), { recursive: true, force: true });
    await installExecutable(second);
    const after = await getLaunchSpec();

    assert.equal(after.ok, true);
    if (!after.ok) return;
    const secondReal = await realpath(second);
    assert.deepEqual(after.spec.args.slice(-2), ['--grep-executable', secondReal]);
    assert.ok(after.spec.executableRoots.includes(secondReal));
    assert.ok(!after.spec.executableRoots.includes(firstReal));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a resolved ripgrep is inspected once while it is still there (#5169)', async () => {
  const executable = await realpath(process.execPath);
  let inspections = 0;
  const getLaunchSpec = createFilesystemWorkerLaunchSpecProvider({
    runtime: 'node',
    platform: 'darwin',
    executable,
    resourceLocation: { kind: 'runtime' },
    rgCandidates: [executable],
    inspectMacosExecutableDependencies: async () => {
      inspections += 1;
      return { ok: true, dependencyCount: 0, runtimeReadableRoots: [], executableRoots: [] };
    },
  });

  await getLaunchSpec();
  await getLaunchSpec();

  assert.equal(inspections, 1);
});

test('the worker is told where it runs so Grep can say where to install ripgrep (#5169)', async () => {
  const getLaunchSpec = createFilesystemWorkerLaunchSpecProvider({
    runtime: 'node',
    platform: 'linux',
    executable: process.execPath,
    resourceLocation: { kind: 'runtime' },
    rgCandidates: [],
    hostEnv: { WSL_DISTRO_NAME: 'Ubuntu-24.04' },
  });

  const result = await getLaunchSpec();

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const index = result.spec.args.indexOf('--ripgrep-environment');
  assert.notEqual(index, -1);
  assert.equal(result.spec.args[index + 1], 'wsl:Ubuntu-24.04');
});

test('outside WSL the worker is not told a machine name (#5169)', async () => {
  const getLaunchSpec = createFilesystemWorkerLaunchSpecProvider({
    runtime: 'node',
    platform: 'linux',
    executable: process.execPath,
    resourceLocation: { kind: 'runtime' },
    rgCandidates: [],
    hostEnv: {},
  });

  const result = await getLaunchSpec();

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.spec.args.includes('--ripgrep-environment'), false);
});

test('a ripgrep whose libraries cannot be granted is not inspected again on every launch (#5169)', async () => {
  const executable = await realpath(process.execPath);
  let inspections = 0;
  const getLaunchSpec = createFilesystemWorkerLaunchSpecProvider({
    runtime: 'node',
    platform: 'darwin',
    executable,
    resourceLocation: { kind: 'runtime' },
    rgCandidates: [executable],
    inspectMacosExecutableDependencies: async () => {
      inspections += 1;
      return { ok: false, reason: 'dependency_unresolved', message: 'fixture failure' };
    },
  });

  for (let launch = 0; launch < 3; launch += 1) {
    const result = await getLaunchSpec();
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.spec.args.includes('--grep-executable'), false);
  }

  assert.equal(inspections, 1);
});

test('a ripgrep reinstalled in place is inspected again and granted its new libraries (#5169)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-launch-spec-rg-in-place-'));
  try {
    const candidate = join(root, 'bin', 'rg');
    await installExecutable(candidate);
    const libraries = ['/opt/ripgrep-14.1.0/lib', '/opt/ripgrep-14.1.1/lib'];
    let inspections = 0;
    const getLaunchSpec = createFilesystemWorkerLaunchSpecProvider({
      runtime: 'node',
      platform: 'darwin',
      executable: process.execPath,
      resourceLocation: { kind: 'runtime' },
      rgCandidates: [candidate],
      inspectMacosExecutableDependencies: async () => {
        const library = libraries[Math.min(inspections, 1)]!;
        inspections += 1;
        return {
          ok: true,
          dependencyCount: 1,
          runtimeReadableRoots: [library],
          executableRoots: [library],
        };
      },
    });
    const before = await getLaunchSpec();
    assert.equal(before.ok, true);
    if (!before.ok) return;
    assert.ok(before.spec.executableRoots.includes(libraries[0]!));

    // Same path, new binary: a reinstall rewrites the file in place.
    await writeFile(candidate, '#!/bin/sh\n# 14.1.1\n', 'utf8');
    const after = await getLaunchSpec();

    assert.equal(after.ok, true);
    if (!after.ok) return;
    assert.equal(inspections, 2);
    assert.ok(after.spec.executableRoots.includes(libraries[1]!));
    assert.ok(!after.spec.executableRoots.includes(libraries[0]!));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('on Windows the winget links directory is searched even when PATH predates the install (#5169)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-launch-spec-winget-'));
  try {
    const linked = join(root, 'Microsoft', 'WinGet', 'Links', 'rg.exe');
    await installExecutable(linked);
    const getLaunchSpec = createFilesystemWorkerLaunchSpecProvider({
      runtime: 'node',
      platform: 'win32',
      executable: process.execPath,
      resourceLocation: { kind: 'runtime' },
      hostEnv: { PATH: '', LOCALAPPDATA: root },
    });

    const result = await getLaunchSpec();

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.spec.args.slice(-2), ['--grep-executable', await realpath(linked)]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function installExecutable(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '#!/bin/sh\n', 'utf8');
  await chmod(path, 0o755);
}
