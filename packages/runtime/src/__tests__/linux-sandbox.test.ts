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
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createDangerFullAccessPermissionProfile,
  createReadOnlyPermissionProfile,
  createWorkspaceWritePermissionProfile,
  type PermissionProfile,
} from '@maka/core/permission-profile';

import {
  LinuxBubblewrapBackend,
  buildBubblewrapArgv,
  buildNetworkSeccompFilter,
  discoverNestedProtectedMetadataPaths,
  linuxExecutableRoots,
} from '../sandbox/linux-sandbox.js';
import { detectLinuxSandboxCapability } from '../sandbox/linux-capability.js';
import { LINUX_BWRAP_PROBE_ARGS } from '../sandbox/linux-capability.js';
import type { SandboxPathContext, SandboxTransformRequest } from '../sandbox/types.js';

function workspaceRequest(profile: PermissionProfile): SandboxTransformRequest {
  return {
    platform: 'linux',
    command: {
      program: '/bin/sh',
      args: ['-lc', 'echo hi'],
      cwd: '/repo/project',
      profile,
      pathContext: {
        workspaceRoots: ['/repo/project'],
        tmpdir: '/var/tmp/maka',
        slashTmp: '/tmp',
      },
    },
  };
}

function enabledNetworkProfile(): PermissionProfile {
  const profile = createWorkspaceWritePermissionProfile();
  return { ...profile, network: { kind: 'enabled' } };
}

function deniedChildProfile(): PermissionProfile {
  const profile = createWorkspaceWritePermissionProfile();
  return {
    ...profile,
    fileSystem: {
      ...profile.fileSystem,
      entries: [
        ...profile.fileSystem.entries,
        { kind: 'path', access: 'deny', path: '/repo/project/secret' },
      ],
    },
  };
}

function protectedMetadataProfile(): PermissionProfile {
  const profile = createWorkspaceWritePermissionProfile();
  return {
    ...profile,
    fileSystem: {
      ...profile.fileSystem,
      protectedMetadata: {
        access: 'deny_write',
        names: ['.git'],
      },
    },
  };
}

describe('detectLinuxSandboxCapability', () => {
  it('probes every namespace required by production commands', () => {
    const request = workspaceRequest(createWorkspaceWritePermissionProfile());
    const productionArgv = buildBubblewrapArgv({
      bwrapPath: '/usr/bin/bwrap',
      command: request.command,
    });
    const requiredNamespaces = productionArgv.filter((arg) => arg.startsWith('--unshare-'));

    for (const namespace of requiredNamespaces) {
      assert.ok((LINUX_BWRAP_PROBE_ARGS as readonly string[]).includes(namespace));
    }
  });

  it('reports non-Linux platforms without probing bwrap', () => {
    assert.deepEqual(detectLinuxSandboxCapability({ platform: 'win32' }), {
      available: false,
      reason: 'non-linux',
    });
  });

  it('reports a missing configured bwrap executable', () => {
    assert.deepEqual(
      detectLinuxSandboxCapability({
        platform: 'linux',
        bwrapPath: '/definitely/missing/maka-bwrap',
      }),
      {
        available: false,
        reason: 'missing-bwrap',
        bwrapPath: '/definitely/missing/maka-bwrap',
      },
    );
  });

  it('reports an executable that cannot create the bubblewrap sandbox', () => {
    const capability = detectLinuxSandboxCapability({
      platform: 'linux',
      bwrapPath: process.execPath,
    });

    assert.equal(capability.available, false);
    if (!capability.available) {
      assert.equal(capability.reason, 'probe-failed');
      assert.equal(capability.bwrapPath, process.execPath);
    }
  });
});

describe('buildBubblewrapArgv', () => {
  it('mounts read-only profiles without a writable workspace bind', () => {
    const request = workspaceRequest(createReadOnlyPermissionProfile());
    const argv = buildBubblewrapArgv({ bwrapPath: '/usr/bin/bwrap', command: request.command });

    assert.ok(hasTriple(argv, '--ro-bind', '/repo/project', '/repo/project'));
    assert.equal(hasTriple(argv, '--bind', '/repo/project', '/repo/project'), false);
  });

  it('materializes writable workspace metadata, temp, cwd, and network restrictions', () => {
    const request = workspaceRequest(createWorkspaceWritePermissionProfile());
    const argv = buildBubblewrapArgv({
      bwrapPath: '/usr/bin/bwrap',
      command: request.command,
    });

    assert.equal(argv[0], '/usr/bin/bwrap');
    assert.ok(argv.includes('--die-with-parent'));
    assert.ok(argv.includes('--new-session'));
    assert.ok(argv.includes('--unshare-net'));
    assert.ok(argv.includes('--unshare-user'));
    assert.ok(hasPair(argv, '--seccomp', '3'));
    assert.ok(hasTriple(argv, '--bind', '/repo/project', '/repo/project'));
    assert.equal(
      hasTriple(argv, '--ro-bind-try', '/repo/project/.git', '/repo/project/.git'),
      false,
    );
    assert.ok(hasPair(argv, '--tmpfs', '/tmp'));
    assert.ok(hasPair(argv, '--tmpfs', '/var/tmp/maka'));
    assert.ok(hasPair(argv, '--chdir', '/repo/project'));
    assert.deepEqual(argv.slice(-4), ['--', '/bin/sh', '-lc', 'echo hi']);
  });

  it('keeps the host network namespace when network is enabled', () => {
    const request = workspaceRequest(enabledNetworkProfile());
    const argv = buildBubblewrapArgv({ bwrapPath: '/usr/bin/bwrap', command: request.command });

    assert.equal(argv.includes('--unshare-net'), false);
    assert.equal(argv.includes('--seccomp'), false);
  });

  it('isolates host process namespaces when network is enabled', () => {
    const request = workspaceRequest(enabledNetworkProfile());
    const argv = buildBubblewrapArgv({ bwrapPath: '/usr/bin/bwrap', command: request.command });

    assert.deepEqual(
      argv.filter((arg) => arg.startsWith('--unshare-')),
      ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup'],
    );
  });

  it('mounts an absolute program directory outside the default host paths', () => {
    const request = workspaceRequest(createWorkspaceWritePermissionProfile());
    const programDirectory = '/opt/hostedtoolcache/node/22.23.1/x64/bin';
    const argv = buildBubblewrapArgv({
      bwrapPath: '/usr/bin/bwrap',
      command: {
        ...request.command,
        program: `${programDirectory}/node`,
      },
    });

    assert.ok(hasPair(argv, '--dir', '/opt'));
    assert.ok(hasPair(argv, '--dir', '/opt/hostedtoolcache/node/22.23.1/x64'));
    assert.ok(hasTriple(argv, '--ro-bind', programDirectory, programDirectory));
  });

  it('mounts runtime roots needed by a shell-launched executable', () => {
    const request = workspaceRequest(createWorkspaceWritePermissionProfile());
    const runtimeRoot = '/opt/hostedtoolcache/node/22.23.1/x64';
    const argv = buildBubblewrapArgv({
      bwrapPath: '/usr/bin/bwrap',
      command: {
        ...request.command,
        pathContext: {
          ...request.command.pathContext,
          minimalRoots: [runtimeRoot],
        },
      },
    });

    assert.ok(hasPair(argv, '--dir', '/opt'));
    assert.ok(hasTriple(argv, '--ro-bind-try', runtimeRoot, runtimeRoot));
  });

  it('mounts required worker resources and uses a trusted parent for a missing exact write', () => {
    const profile: PermissionProfile = {
      type: 'managed',
      name: 'custom',
      fileSystem: {
        kind: 'restricted',
        entries: [{ kind: 'path', access: 'write', path: '/outside/new.txt', match: 'exact' }],
      },
      network: { kind: 'restricted' },
    };
    const request = workspaceRequest(profile);
    const pathContext: SandboxPathContext = {
      ...request.command.pathContext,
      runtimeReadableRoots: ['/runtime/filesystem-worker.js'],
      executableRoots: ['/opt/node/bin/node', '/opt/rg/bin/rg'],
      runtimeWritableRoots: ['/outside'],
    };
    const argv = buildBubblewrapArgv({
      bwrapPath: '/usr/bin/bwrap',
      command: {
        ...request.command,
        pathContext,
      },
    });

    assert.ok(
      hasTriple(
        argv,
        '--ro-bind',
        '/runtime/filesystem-worker.js',
        '/runtime/filesystem-worker.js',
      ),
    );
    assert.ok(hasTriple(argv, '--ro-bind', '/opt/node/bin/node', '/opt/node/bin/node'));
    assert.ok(hasTriple(argv, '--ro-bind', '/opt/rg/bin/rg', '/opt/rg/bin/rg'));
    assert.ok(hasTriple(argv, '--bind', '/outside', '/outside'));
    assert.equal(hasTriple(argv, '--bind', '/outside/new.txt', '/outside/new.txt'), false);
  });

  it('binds pinned exact-write files through inherited descriptors', () => {
    const request = workspaceRequest({
      type: 'managed',
      name: 'custom',
      fileSystem: {
        kind: 'restricted',
        entries: [{ kind: 'path', access: 'write', path: '/outside/new.txt', match: 'exact' }],
      },
      network: { kind: 'restricted' },
    });
    const command = {
      ...request.command,
      pathContext: {
        ...request.command.pathContext,
        pinnedProfilePaths: [{ path: '/outside/new.txt', access: 'write', fd: 4, sourceFd: 27 }],
      },
    } as SandboxTransformRequest['command'];
    const backend = new LinuxBubblewrapBackend({
      capability: { available: true, bwrapPath: '/usr/bin/bwrap' },
    });

    const argv = buildBubblewrapArgv({ bwrapPath: '/usr/bin/bwrap', command });
    assert.ok(hasTriple(argv, '--bind', '/proc/self/fd/4', '/outside/new.txt'));
    assert.equal(hasTriple(argv, '--bind', '/outside/new.txt', '/outside/new.txt'), false);

    const transformed = backend.transform({ platform: 'linux', command });
    assert.equal(transformed.ok, true);
    if (!transformed.ok) throw new Error('Linux transform failed');
    assert.deepEqual(
      transformed.exec.fdInputs?.find(
        (input) => (input as { sourceFd?: number }).sourceFd !== undefined,
      ),
      { fd: 4, sourceFd: 27 },
    );
  });

  it('omits inactive exact file roots from an unrelated command', () => {
    const request = workspaceRequest({
      type: 'managed',
      name: 'custom',
      fileSystem: {
        kind: 'restricted',
        entries: [
          { kind: 'path', access: 'read', path: '/outside/missing-read.txt', match: 'exact' },
          { kind: 'path', access: 'write', path: '/outside/missing-write.txt', match: 'exact' },
        ],
      },
      network: { kind: 'restricted' },
    });

    const argv = buildBubblewrapArgv({
      bwrapPath: '/usr/bin/bwrap',
      command: request.command,
    });

    assert.equal(
      hasTriple(argv, '--ro-bind', '/outside/missing-read.txt', '/outside/missing-read.txt'),
      false,
    );
    assert.equal(argv.includes('/outside/missing-read.txt'), false);
    assert.equal(
      hasTriple(argv, '--bind', '/outside/missing-write.txt', '/outside/missing-write.txt'),
      false,
    );
    assert.equal(argv.includes('/outside/missing-write.txt'), false);
  });

  it('materializes an otherwise-unmounted worker cwd without exposing its contents', () => {
    const profile: PermissionProfile = {
      type: 'managed',
      name: 'custom',
      fileSystem: {
        kind: 'restricted',
        entries: [{ kind: 'path', access: 'read', path: '/outside/allowed.txt', match: 'exact' }],
      },
      network: { kind: 'restricted' },
    };
    const request = workspaceRequest(profile);
    const argv = buildBubblewrapArgv({
      bwrapPath: '/usr/bin/bwrap',
      command: {
        ...request.command,
        cwd: '/workspace/session',
      },
    });

    assert.ok(hasPair(argv, '--dir', '/workspace/session'));
    assert.equal(hasTriple(argv, '--ro-bind', '/workspace/session', '/workspace/session'), false);
    assert.equal(hasTriple(argv, '--bind', '/workspace/session', '/workspace/session'), false);
  });
});

describe('linuxExecutableRoots', () => {
  it('keeps the Node installation root and absolute PATH entries without nested duplicates', () => {
    assert.deepEqual(
      linuxExecutableRoots({
        execPath: '/opt/hostedtoolcache/node/22.23.1/x64/bin/node',
        path: '/opt/hostedtoolcache/node/22.23.1/x64/bin:/home/runner/.local/bin:relative-bin',
      }),
      ['/opt/hostedtoolcache/node/22.23.1/x64', '/home/runner/.local/bin'],
    );
  });
});

describe('buildNetworkSeccompFilter', () => {
  it('builds a cBPF program for supported Linux architectures', () => {
    const x64 = buildNetworkSeccompFilter('x64');
    const arm64 = buildNetworkSeccompFilter('arm64');

    assert.ok(x64.length > 0);
    assert.equal(x64.length % 8, 0);
    assert.ok(arm64.length > 0);
    assert.equal(arm64.length % 8, 0);
    assert.notDeepEqual(x64, arm64);
  });

  it('fails closed for architectures without audited syscall numbers', () => {
    assert.throws(() => buildNetworkSeccompFilter('ia32'), /unsupported.*architecture/i);
  });
});

describe('discoverNestedProtectedMetadataPaths', () => {
  it('finds protected metadata at any existing nested path segment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-protected-scan-'));
    await mkdir(join(root, 'packages', 'pkg', '.git'), { recursive: true });
    await mkdir(join(root, '.git'), { recursive: true });

    const paths = discoverNestedProtectedMetadataPaths({
      writableRoots: [root],
      names: ['.git', '.agents', '.codex'],
    });

    assert.equal(paths.length, 1);
    assert.match(paths[0] ?? '', /packages[/\\]pkg[/\\]\.git$/);
  });
});

describe('LinuxBubblewrapBackend', () => {
  it('wraps a managed restricted command when bwrap is available', () => {
    const backend = new LinuxBubblewrapBackend({
      capability: { available: true, bwrapPath: '/usr/bin/bwrap' },
    });
    const result = backend.transform(workspaceRequest(createWorkspaceWritePermissionProfile()));

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.exec.sandboxType, 'linux');
      assert.equal(result.exec.argv[0], '/usr/bin/bwrap');
      assert.deepEqual(result.exec.argv.slice(-3), ['/bin/sh', '-lc', 'echo hi']);
      assert.equal(result.exec.fdInputs?.[0]?.fd, 3);
      const seccompInput = result.exec.fdInputs?.[0];
      assert.ok(seccompInput && 'data' in seccompInput && seccompInput.data.byteLength > 0);
    }
  });

  it('re-applies discovered nested protected metadata as read-only', () => {
    const nested = '/repo/project/packages/pkg/.git';
    const backend = new LinuxBubblewrapBackend({
      capability: { available: true, bwrapPath: '/usr/bin/bwrap' },
      discoverProtectedMetadataPaths: () => [nested],
    });
    const result = backend.transform(workspaceRequest(protectedMetadataProfile()));

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.ok(hasTriple(result.exec.argv, '--ro-bind', nested, nested));
    }
  });

  it('fails closed with a clear result when bwrap is unavailable', () => {
    const backend = new LinuxBubblewrapBackend({
      capability: { available: false, reason: 'missing-bwrap', bwrapPath: '/usr/bin/bwrap' },
    });
    const result = backend.transform(workspaceRequest(createWorkspaceWritePermissionProfile()));

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'backend_not_available');
      assert.equal(result.sandboxType, 'linux');
      assert.match(result.message ?? '', /bubblewrap.*not available/i);
    }
  });

  it('rejects deny entries that cannot be represented without weakening policy', () => {
    const backend = new LinuxBubblewrapBackend({
      capability: { available: true, bwrapPath: '/usr/bin/bwrap' },
    });
    const result = backend.transform(workspaceRequest(deniedChildProfile()));

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'invalid_request');
      assert.match(result.message ?? '', /deny entries/i);
    }
  });

  it('omits inactive exact directory entries instead of exposing their subtrees', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maka-linux-exact-directory-'));
    const backend = new LinuxBubblewrapBackend({
      capability: { available: true, bwrapPath: '/usr/bin/bwrap' },
    });
    const profile: PermissionProfile = {
      type: 'managed',
      name: 'custom',
      fileSystem: {
        kind: 'restricted',
        entries: [{ kind: 'path', access: 'read', path: directory, match: 'exact' }],
      },
      network: { kind: 'restricted' },
    };

    try {
      assert.equal(backend.canEnforceProfile(profile), true);
      const result = backend.transform(workspaceRequest(profile));
      assert.equal(result.ok, true);
      if (!result.ok) throw new Error('Linux transform failed');
      assert.equal(result.exec.argv.includes(directory), false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects profiles that should have selected no sandbox', () => {
    const backend = new LinuxBubblewrapBackend({
      capability: { available: true, bwrapPath: '/usr/bin/bwrap' },
    });
    const result = backend.transform(workspaceRequest(createDangerFullAccessPermissionProfile()));

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'invalid_request');
  });
});

function hasPair(argv: readonly string[], flag: string, value: string): boolean {
  return argv.some((item, index) => item === flag && argv[index + 1] === value);
}

function hasTriple(argv: readonly string[], flag: string, left: string, right: string): boolean {
  return argv.some(
    (item, index) => item === flag && argv[index + 1] === left && argv[index + 2] === right,
  );
}
