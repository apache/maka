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
import { describe, it } from 'node:test';

import {
  createDangerFullAccessPermissionProfile,
  createExternalPermissionProfile,
  createReadOnlyPermissionProfile,
  createWorkspaceWritePermissionProfile,
  type PermissionProfile,
} from '@maka/core/permission-profile';

import { SandboxManager } from '../sandbox/sandbox-manager.js';
import { LinuxBubblewrapBackend } from '../sandbox/linux-sandbox.js';
import type {
  SandboxBackend,
  SandboxTransformRequest,
  SandboxTransformResult,
} from '../sandbox/types.js';

class FakeMacosBackend implements SandboxBackend {
  readonly type = 'macos-seatbelt' as const;
  calls: SandboxTransformRequest[] = [];

  transform(request: SandboxTransformRequest): SandboxTransformResult {
    this.calls.push(request);
    const { command } = request;
    return {
      ok: true,
      exec: {
        argv: ['/usr/bin/sandbox-exec', '--', command.program, ...command.args],
        cwd: command.cwd,
        env: command.env,
        sandboxType: 'macos-seatbelt',
        effectiveProfile: command.profile,
      },
      sandboxType: 'macos-seatbelt',
      requiresSandbox: true,
      preference: request.preference ?? 'auto',
    };
  }
}

function command(profile: PermissionProfile) {
  return {
    program: '/bin/zsh',
    args: ['-lc', 'echo ok'],
    cwd: '/repo',
    profile,
    pathContext: {
      workspaceRoots: ['/repo'],
      slashTmp: '/tmp',
    },
  };
}

describe('SandboxManager.shouldSandbox', () => {
  it('uses PermissionProfile under auto preference', () => {
    const manager = new SandboxManager();

    assert.equal(manager.shouldSandbox(createReadOnlyPermissionProfile(), 'auto'), true);
    assert.equal(manager.shouldSandbox(createWorkspaceWritePermissionProfile(), 'auto'), true);
    assert.equal(manager.shouldSandbox(createDangerFullAccessPermissionProfile(), 'auto'), false);
    assert.equal(manager.shouldSandbox(createExternalPermissionProfile(), 'auto'), false);
    assert.equal(manager.shouldSandbox({ type: 'disabled', name: 'disabled' }, 'auto'), false);
  });

  it('requires a sandbox when only process network remains restricted', () => {
    const manager = new SandboxManager();
    const profile: PermissionProfile = {
      type: 'managed',
      name: 'network-only',
      fileSystem: { kind: 'unrestricted', entries: [] },
      network: { kind: 'restricted' },
    };

    assert.equal(manager.shouldSandbox(profile, 'auto'), true);
  });

  it('honors require and forbid preference overrides', () => {
    const manager = new SandboxManager();

    assert.equal(manager.shouldSandbox(createDangerFullAccessPermissionProfile(), 'require'), true);
    assert.equal(manager.shouldSandbox(createWorkspaceWritePermissionProfile(), 'forbid'), false);
  });
});

describe('SandboxManager.selectInitial', () => {
  it('selects macos-seatbelt on darwin when restricted profile needs sandbox and backend exists', () => {
    const manager = new SandboxManager([new FakeMacosBackend()]);

    const result = manager.selectInitial({
      profile: createWorkspaceWritePermissionProfile(),
      platform: 'darwin',
    });

    assert.deepEqual(result, {
      ok: true,
      sandboxType: 'macos-seatbelt',
      requiresSandbox: true,
      reason: 'platform_sandbox_selected',
      platform: 'darwin',
      preference: 'auto',
    });
  });

  it('fails closed on darwin when sandbox is required but macOS backend is unavailable', () => {
    const manager = new SandboxManager();

    const result = manager.selectInitial({
      profile: createWorkspaceWritePermissionProfile(),
      platform: 'darwin',
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'backend_not_available');
      assert.equal(result.sandboxType, 'macos-seatbelt');
      assert.equal(result.platform, 'darwin');
    }
  });

  it('selects linux when a Linux backend is registered', () => {
    const manager = new SandboxManager([
      new LinuxBubblewrapBackend({
        capability: { available: true, bwrapPath: '/usr/bin/bwrap' },
      }),
    ]);

    const result = manager.selectInitial({
      profile: createWorkspaceWritePermissionProfile(),
      platform: 'linux',
    });

    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.sandboxType, 'linux');
  });

  it('reports whether the selected backend can enforce the profile', () => {
    const available = new SandboxManager([
      new LinuxBubblewrapBackend({
        capability: { available: true, bwrapPath: '/usr/bin/bwrap' },
      }),
    ]);
    const unavailable = new SandboxManager([
      new LinuxBubblewrapBackend({
        capability: { available: false, reason: 'missing-bwrap', bwrapPath: '/usr/bin/bwrap' },
      }),
    ]);
    const profile = createWorkspaceWritePermissionProfile();

    assert.equal(available.canEnforce({ profile, platform: 'linux' }), true);
    assert.equal(unavailable.canEnforce({ profile, platform: 'linux' }), false);
  });

  it('does not report enforcement for Linux profiles the backend will reject', () => {
    const unsupportedArch = new SandboxManager([
      new LinuxBubblewrapBackend({
        capability: { available: true, bwrapPath: '/usr/bin/bwrap' },
        arch: 'ia32',
      }),
    ]);
    const denied = createWorkspaceWritePermissionProfile();
    denied.fileSystem.entries = [
      ...denied.fileSystem.entries,
      { kind: 'path', access: 'deny', path: '/repo/secret' },
    ];
    const available = new SandboxManager([
      new LinuxBubblewrapBackend({
        capability: { available: true, bwrapPath: '/usr/bin/bwrap' },
      }),
    ]);

    assert.equal(
      unsupportedArch.canEnforce({
        profile: createWorkspaceWritePermissionProfile(),
        platform: 'linux',
      }),
      false,
    );
    assert.equal(available.canEnforce({ profile: denied, platform: 'linux' }), false);
  });

  it('returns backend_not_available for win32 restricted profiles without a broker', () => {
    const manager = new SandboxManager();

    const result = manager.selectInitial({
      profile: createWorkspaceWritePermissionProfile(),
      platform: 'win32',
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'backend_not_available');
  });

  it('selects none for danger-full-access, external, disabled, and forbid', () => {
    const manager = new SandboxManager();

    const danger = manager.selectInitial({
      profile: createDangerFullAccessPermissionProfile(),
      platform: 'darwin',
    });
    const external = manager.selectInitial({
      profile: createExternalPermissionProfile(),
      platform: 'darwin',
    });
    const disabled = manager.selectInitial({
      profile: { type: 'disabled', name: 'disabled' },
      platform: 'darwin',
    });
    const forbid = manager.selectInitial({
      profile: createWorkspaceWritePermissionProfile(),
      preference: 'forbid',
      platform: 'darwin',
    });

    assert.equal(danger.ok && danger.sandboxType, 'none');
    assert.equal(external.ok && external.sandboxType, 'none');
    assert.equal(disabled.ok && disabled.sandboxType, 'none');
    assert.equal(forbid.ok && forbid.sandboxType, 'none');
  });
});

describe('SandboxManager.transform', () => {
  it('returns raw argv when selected sandbox is none', () => {
    const manager = new SandboxManager();
    const profile = createDangerFullAccessPermissionProfile();

    const result = manager.transform({
      command: command(profile),
      platform: 'darwin',
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.exec.argv, ['/bin/zsh', '-lc', 'echo ok']);
      assert.equal(result.exec.cwd, '/repo');
      assert.equal(result.exec.sandboxType, 'none');
      assert.equal(result.exec.effectiveProfile, profile);
      assert.equal(result.requiresSandbox, false);
    }
  });

  it('delegates macos-seatbelt transform to the registered backend', () => {
    const backend = new FakeMacosBackend();
    const manager = new SandboxManager([backend]);
    const profile = createWorkspaceWritePermissionProfile();

    const result = manager.transform({
      command: command(profile),
      platform: 'darwin',
    });

    assert.equal(result.ok, true);
    assert.equal(backend.calls.length, 1);
    if (result.ok) {
      assert.deepEqual(result.exec.argv, [
        '/usr/bin/sandbox-exec',
        '--',
        '/bin/zsh',
        '-lc',
        'echo ok',
      ]);
      assert.equal(result.exec.sandboxType, 'macos-seatbelt');
    }
  });

  it('returns selection failure from transform without throwing', () => {
    const manager = new SandboxManager();

    const result = manager.transform({
      command: command(createWorkspaceWritePermissionProfile()),
      platform: 'darwin',
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'backend_not_available');
  });
});
