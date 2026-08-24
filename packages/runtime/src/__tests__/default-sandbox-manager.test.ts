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
  readCachedWindowsReadiness,
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

  it('re-probes a transient negative after its TTL but caches a positive permanently', async () => {
    await withFakeLauncher((clientPath) => {
      let now = 1_000;
      const clock = () => now;
      let calls = 0;
      let status: number = 1;
      const spawn: WindowsReadinessSpawn = () => {
        calls += 1;
        return { status };
      };

      // A transient failure is cached false, but only for the negative TTL.
      assert.equal(probeWindowsReadiness(clientPath, spawn, clock), false);
      assert.equal(calls, 1);
      // Within the TTL the cached negative is reused, not re-probed.
      now += 59_000;
      assert.equal(probeWindowsReadiness(clientPath, spawn, clock), false);
      assert.equal(calls, 1);

      // Past the TTL it re-probes; the host has recovered, so it flips to true.
      now += 2_000;
      status = 0;
      assert.equal(probeWindowsReadiness(clientPath, spawn, clock), true);
      assert.equal(calls, 2);

      // A positive result is cached permanently — no re-probe however far the
      // clock advances.
      now += 10 * 60_000;
      assert.equal(probeWindowsReadiness(clientPath, spawn, clock), true);
      assert.equal(calls, 2);
    });
  });

  it('never re-poisons after a positive: only negatives expire', async () => {
    await withFakeLauncher((clientPath) => {
      let now = 5_000;
      const clock = () => now;
      let calls = 0;
      const spawn: WindowsReadinessSpawn = () => {
        calls += 1;
        return { status: 0 };
      };
      assert.equal(probeWindowsReadiness(clientPath, spawn, clock), true);
      // Even a subsequent spawn that *would* fail is never consulted, because the
      // positive entry never expires.
      const failing: WindowsReadinessSpawn = () => {
        calls += 1;
        return { status: 1 };
      };
      now += 24 * 60 * 60_000;
      assert.equal(probeWindowsReadiness(clientPath, failing, clock), true);
      assert.equal(calls, 1);
    });
  });
});

describe('readCachedWindowsReadiness', () => {
  it('is strictly cache-only: never spawns, fails closed until the cache is warmed', async () => {
    await withFakeLauncher((clientPath) => {
      let now = 2_000;
      const clock = () => now;

      // Cold cache: the hot path must fail closed without any spawn (there is no
      // spawn to inject — the read is structurally incapable of one).
      assert.equal(readCachedWindowsReadiness(clientPath, clock), false);

      // The warmer populates a positive entry; the hot path then reflects it.
      let calls = 0;
      const spawn: WindowsReadinessSpawn = () => {
        calls += 1;
        return { status: 0 };
      };
      assert.equal(probeWindowsReadiness(clientPath, spawn, clock), true);
      assert.equal(readCachedWindowsReadiness(clientPath, clock), true);
      assert.equal(calls, 1);
    });
  });

  it('fails closed on an expired negative entry without re-probing on the hot path', async () => {
    await withFakeLauncher((clientPath) => {
      let now = 3_000;
      const clock = () => now;
      const spawn: WindowsReadinessSpawn = () => ({ status: 1 });

      // Warm a negative entry via the spawning warmer.
      assert.equal(probeWindowsReadiness(clientPath, spawn, clock), false);
      // Before expiry the hot path returns the cached negative.
      assert.equal(readCachedWindowsReadiness(clientPath, clock), false);
      // After expiry the hot path still fails closed — it must NOT spawn to
      // refresh; only the warmer may. The stale entry simply reads as false.
      now += 61_000;
      assert.equal(readCachedWindowsReadiness(clientPath, clock), false);
    });
  });

  it('recovers a negative only on a new composition build (spawning warmer), never on the running hot path', async () => {
    await withFakeLauncher((clientPath) => {
      let now = 4_000;
      const clock = () => now;
      let calls = 0;
      // Available now, but the first probe caught a transient failure.
      const spawn: WindowsReadinessSpawn = () => {
        calls += 1;
        return calls === 1 ? { status: 1 } : { status: 0 };
      };

      // A composition build warms a negative entry.
      assert.equal(probeWindowsReadiness(clientPath, spawn, clock), false);

      // Model a running Runtime Host: the worker was published once at build
      // time and the hot path is all that runs afterwards. Advancing well past
      // the TTL never flips it — a running composition does not self-recover,
      // and the read never spawns (calls stays at 1).
      for (let i = 0; i < 5; i += 1) {
        now += 60_000;
        assert.equal(readCachedWindowsReadiness(clientPath, clock), false);
      }
      assert.equal(calls, 1);

      // Recovery is scoped to the next composition build: a fresh spawning probe
      // (a new composition, or a Runtime Host restart) re-evaluates and, now that
      // the host is healthy, publishes the worker.
      assert.equal(probeWindowsReadiness(clientPath, spawn, clock), true);
      assert.equal(readCachedWindowsReadiness(clientPath, clock), true);
      assert.equal(calls, 2);
    });
  });
});
