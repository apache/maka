import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
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
