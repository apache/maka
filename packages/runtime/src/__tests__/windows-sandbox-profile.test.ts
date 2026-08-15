import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createReadOnlyPermissionProfile,
  createWorkspaceWritePermissionProfile,
  type PermissionProfileManaged,
} from '@maka/core/permission-profile';

import { compileWindowsSandboxPolicy } from '../sandbox/windows-profile.js';
import type { SandboxCommand } from '../sandbox/types.js';

function command(profile: PermissionProfileManaged): SandboxCommand {
  return {
    program: String.raw`C:\Program Files\nodejs\node.exe`,
    args: ['script.js'],
    cwd: String.raw`C:\work\repo`,
    env: { PATH: String.raw`C:\Windows\System32`, TEMP: undefined },
    profile,
    pathContext: {
      workspaceRoots: [String.raw`C:\work\repo`],
      tmpdir: String.raw`C:\Users\user\AppData\Local\Temp`,
      runtimeReadableRoots: [String.raw`C:\runtime`],
      executableRoots: [String.raw`C:\Program Files\nodejs`],
      runtimeWritableRoots: [String.raw`C:\runtime\state`],
    },
  };
}

test('compiles workspace-write roots, runtime roots, network, and environment', () => {
  const policy = compileWindowsSandboxPolicy(command(createWorkspaceWritePermissionProfile()));
  assert.deepEqual(policy, {
    readRoots: [
      String.raw`C:\work\repo`,
      String.raw`C:\Users\user\AppData\Local\Temp`,
      String.raw`C:\runtime`,
      String.raw`C:\Program Files\nodejs`,
      String.raw`C:\runtime\state`,
    ],
    writeRoots: [
      String.raw`C:\work\repo`,
      String.raw`C:\Users\user\AppData\Local\Temp`,
      String.raw`C:\runtime\state`,
    ],
    exactReadRoots: [],
    exactWriteRoots: [],
    network: 'restricted',
    environment: { PATH: String.raw`C:\Windows\System32` },
  });
});

test('fails closed for unsupported deny rules', () => {
  const deny: PermissionProfileManaged = {
    ...createReadOnlyPermissionProfile(),
    fileSystem: {
      kind: 'restricted',
      entries: [{ kind: 'path', access: 'deny', path: String.raw`C:\secret` }],
    },
  };
  assert.throws(() => compileWindowsSandboxPolicy(command(deny)), /deny entries/);
});

test('compiles an exact file grant as a non-recursive broker root', () => {
  const exact: PermissionProfileManaged = {
    ...createReadOnlyPermissionProfile(),
    fileSystem: {
      kind: 'restricted',
      entries: [{ kind: 'path', access: 'read', path: String.raw`C:\file.txt`, match: 'exact' }],
    },
  };
  const policy = compileWindowsSandboxPolicy(command(exact));
  assert.deepEqual(policy.readRoots, [
    String.raw`C:\file.txt`,
    String.raw`C:\runtime`,
    String.raw`C:\Program Files\nodejs`,
    String.raw`C:\runtime\state`,
  ]);
  assert.deepEqual(policy.writeRoots, [String.raw`C:\runtime\state`]);
  assert.deepEqual(policy.exactReadRoots, [String.raw`C:\file.txt`]);
  assert.deepEqual(policy.exactWriteRoots, []);
});

test('rejects noncanonical paths and case-insensitive duplicate environment names', () => {
  const invalidPath = command(createWorkspaceWritePermissionProfile());
  invalidPath.pathContext = { workspaceRoots: ['C:/work/repo'] };
  assert.throws(() => compileWindowsSandboxPolicy(invalidPath), /use backslashes/);

  const volumeRoot = command(createWorkspaceWritePermissionProfile());
  volumeRoot.pathContext = { workspaceRoots: ['C:\\'] };
  assert.throws(() => compileWindowsSandboxPolicy(volumeRoot), /volume roots are not supported/);

  const duplicateEnvironment = command(createWorkspaceWritePermissionProfile());
  duplicateEnvironment.env = { Path: 'one', PATH: 'two' };
  assert.throws(() => compileWindowsSandboxPolicy(duplicateEnvironment), /Duplicate/);
});
