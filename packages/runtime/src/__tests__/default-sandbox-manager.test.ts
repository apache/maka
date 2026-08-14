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
} from '../sandbox/default-sandbox-manager.js';

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
});
