import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';

import {
  createBuiltinSandboxManager,
  createDefaultSandboxManager,
  isBuiltinFilesystemWorkerSandboxAvailable,
  probeWindowsReadiness,
  type WindowsReadinessSpawn,
} from '../sandbox/default-sandbox-manager.js';

async function withFakeLauncher<T>(run: (clientPath: string) => Promise<T> | T): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'maka-windows-readiness-'));
  const clientPath = join(dir, 'maka-windows-sandbox.exe');
  await writeFile(clientPath, 'test');
  try {
    return await run(clientPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('createDefaultSandboxManager', () => {
  it('registers platform backends without requiring the host platform at import time', () => {
    const manager = createDefaultSandboxManager();

    const result = manager.selectInitial({
      profile: createWorkspaceWritePermissionProfile(),
      platform: 'darwin',
    });

    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.sandboxType, 'macos-seatbelt');

    const linux = manager.selectInitial({
      profile: createWorkspaceWritePermissionProfile(),
      platform: 'linux',
    });
    assert.equal(linux.ok, true);
    if (linux.ok) assert.equal(linux.sandboxType, 'linux');
  });
});

describe('createBuiltinSandboxManager', () => {
  it('always returns a manager so managed execution fails closed on unsupported platforms', () => {
    assert.ok(createBuiltinSandboxManager('linux'));
    assert.ok(createBuiltinSandboxManager('darwin'));
    const unsupported = createBuiltinSandboxManager('win32');
    assert.ok(unsupported);
    const selection = unsupported.selectInitial({
      profile: createWorkspaceWritePermissionProfile(),
      platform: 'win32',
    });
    assert.equal(selection.ok, false);
    if (!selection.ok) assert.equal(selection.reason, 'backend_not_available');
  });

  it('registers Windows only when the packaged native client exists', async () => {
    const resourcesPath = await mkdtemp(join(tmpdir(), 'maka-windows-resources-'));
    try {
      await mkdir(join(resourcesPath, 'windows-sandbox'));
      await writeFile(join(resourcesPath, 'windows-sandbox', 'maka-windows-sandbox.exe'), 'test');
      const manager = createBuiltinSandboxManager('win32', resourcesPath);
      const selection = manager.selectInitial({
        profile: createWorkspaceWritePermissionProfile(),
        platform: 'win32',
      });
      assert.equal(selection.ok, true);
      if (selection.ok) assert.equal(selection.sandboxType, 'windows');
    } finally {
      await rm(resourcesPath, { recursive: true, force: true });
    }
  });
});

describe('isBuiltinFilesystemWorkerSandboxAvailable', () => {
  it('requires a usable Linux backend but keeps the built-in macOS worker available', () => {
    assert.equal(isBuiltinFilesystemWorkerSandboxAvailable('darwin'), true);
    assert.equal(isBuiltinFilesystemWorkerSandboxAvailable('win32'), false);
    assert.equal(
      isBuiltinFilesystemWorkerSandboxAvailable('linux', {
        available: true,
        bwrapPath: '/usr/bin/bwrap',
      }),
      true,
    );
    assert.equal(
      isBuiltinFilesystemWorkerSandboxAvailable('linux', {
        available: false,
        reason: 'missing-bwrap',
        bwrapPath: '/usr/bin/bwrap',
      }),
      false,
    );
    assert.equal(
      isBuiltinFilesystemWorkerSandboxAvailable(
        'linux',
        {
          available: true,
          bwrapPath: '/usr/bin/bwrap',
        },
        's390x',
      ),
      false,
    );
  });

  it('reports Windows unavailable when the launcher is absent, so no worker is published', () => {
    // execution-composition gates filesystem-worker wiring on this helper; with
    // no packaged launcher there is nothing to probe and it must fail closed.
    assert.equal(
      isBuiltinFilesystemWorkerSandboxAvailable('win32', undefined, 'x64', undefined),
      false,
    );
  });
});

describe('probeWindowsReadiness', () => {
  it('is available only on a clean exit 0 from the launcher probe', async () => {
    await withFakeLauncher((clientPath) => {
      const spawn: WindowsReadinessSpawn = () => ({ status: 0 });
      assert.equal(probeWindowsReadiness(clientPath, spawn), true);
    });
  });

  it('fails closed when the probe exits non-zero', async () => {
    await withFakeLauncher((clientPath) => {
      const spawn: WindowsReadinessSpawn = () => ({ status: 1 });
      assert.equal(probeWindowsReadiness(clientPath, spawn), false);
    });
  });

  it('fails closed on a spawn error', async () => {
    await withFakeLauncher((clientPath) => {
      const spawn: WindowsReadinessSpawn = () => ({ status: null, error: new Error('ENOENT') });
      assert.equal(probeWindowsReadiness(clientPath, spawn), false);
    });
  });

  it('fails closed on an external timeout that leaves no exit status', async () => {
    await withFakeLauncher((clientPath) => {
      // spawnSync surfaces a `timeout` kill as status === null.
      const spawn: WindowsReadinessSpawn = () => ({ status: null });
      assert.equal(probeWindowsReadiness(clientPath, spawn), false);
    });
  });

  it('reuses the memoized result so repeated checks never re-probe', async () => {
    await withFakeLauncher((clientPath) => {
      let calls = 0;
      const spawn: WindowsReadinessSpawn = () => {
        calls += 1;
        return { status: 0 };
      };
      assert.equal(probeWindowsReadiness(clientPath, spawn), true);
      assert.equal(probeWindowsReadiness(clientPath, spawn), true);
      assert.equal(calls, 1);
    });
  });

  it('fails closed when the launcher file does not exist without spawning', () => {
    let calls = 0;
    const spawn: WindowsReadinessSpawn = () => {
      calls += 1;
      return { status: 0 };
    };
    const missing = join(tmpdir(), 'maka-windows-readiness-missing', 'maka-windows-sandbox.exe');
    assert.equal(probeWindowsReadiness(missing, spawn), false);
    assert.equal(calls, 0);
  });
});
