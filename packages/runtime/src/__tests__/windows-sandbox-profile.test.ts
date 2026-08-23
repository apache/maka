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
    ],
    writeRoots: [String.raw`C:\work\repo`, String.raw`C:\Users\user\AppData\Local\Temp`],
    exactReadRoots: [],
    exactWriteRoots: [],
    network: 'restricted',
    environment: { PATH: String.raw`C:\Windows\System32` },
  });
});

test('fails closed on write shapes that need parent-entry authority', () => {
  // runtimeWritableRoots only exists for a missing write target or a
  // directory-entry mutation; representing it would widen the kernel grant
  // to recursive Modify on the parent, so the preview refuses instead.
  const withParentRoot: SandboxCommand = {
    ...command(createWorkspaceWritePermissionProfile()),
    pathContext: {
      workspaceRoots: [String.raw`C:\work\repo`],
      tmpdir: String.raw`C:\Users\user\AppData\Local\Temp`,
      runtimeWritableRoots: [String.raw`C:\work\repo\out`],
    },
  };
  assert.throws(() => compileWindowsSandboxPolicy(withParentRoot), /parent-entry/);
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

test('fails closed when a profile requests enabled networking', () => {
  const enabledNetwork: PermissionProfileManaged = {
    ...createReadOnlyPermissionProfile(),
    network: { kind: 'enabled' },
  };
  assert.throws(
    () => compileWindowsSandboxPolicy(command(enabledNetwork)),
    /only implements restricted networking/,
  );
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
    // cwd metadata anchor: added exactly (non-recursively) when no broader
    // grant already covers it, so the worker can lstat its own cwd.
    String.raw`C:\work\repo`,
  ]);
  assert.deepEqual(policy.writeRoots, []);
  assert.deepEqual(policy.exactReadRoots, [String.raw`C:\file.txt`, String.raw`C:\work\repo`]);
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

test('accepts real Windows environment names with parentheses and rejects block-breaking names', () => {
  const parenthesized = command(createWorkspaceWritePermissionProfile());
  parenthesized.env = {
    'CommonProgramFiles(x86)': String.raw`C:\Program Files (x86)\Common Files`,
    'ProgramFiles(x86)': String.raw`C:\Program Files (x86)`,
  };
  const policy = compileWindowsSandboxPolicy(parenthesized);
  assert.deepEqual(policy.environment, {
    'CommonProgramFiles(x86)': String.raw`C:\Program Files (x86)\Common Files`,
    'ProgramFiles(x86)': String.raw`C:\Program Files (x86)`,
  });

  for (const badName of ['A=B', '=C:', 'BAD\0NAME', '']) {
    const invalid = command(createWorkspaceWritePermissionProfile());
    invalid.env = { [badName]: 'value' };
    assert.throws(
      () => compileWindowsSandboxPolicy(invalid),
      /Invalid Windows sandbox environment/,
    );
  }

  const nulValue = command(createWorkspaceWritePermissionProfile());
  nulValue.env = { GOOD_NAME: 'has\0nul' };
  assert.throws(
    () => compileWindowsSandboxPolicy(nulValue),
    /Invalid Windows sandbox environment value/,
  );
});
