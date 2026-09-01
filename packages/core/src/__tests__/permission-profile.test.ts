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
import { describe, test } from 'node:test';
import { pathWithinRoot } from '../absolute-path.js';
import {
  canReadPath,
  canWritePath,
  createDangerFullAccessPermissionProfile,
  createReadOnlyPermissionProfile,
  createWorkspaceWritePermissionProfile,
  isDeniedPath,
  isProtectedMetadataPath,
  isReadOnlyPermissionProfile,
  type PermissionProfile,
  type PermissionProfileManaged,
} from '../permission-profile.js';

const WORKSPACE_CONTEXT = {
  workspaceRoots: ['/workspace/project'],
  tmpdir: '/private/tmp/maka',
  slashTmp: '/tmp',
};

describe('PermissionProfile factories', () => {
  test('read-only profile allows workspace reads and blocks writes', () => {
    const profile = createReadOnlyPermissionProfile();

    assert.strictEqual(
      canReadPath(profile, '/workspace/project/src/index.ts', WORKSPACE_CONTEXT),
      true,
    );
    assert.strictEqual(
      canWritePath(profile, '/workspace/project/src/index.ts', WORKSPACE_CONTEXT),
      false,
    );
    assert.strictEqual(
      canReadPath(profile, '/workspace/project2/src/index.ts', WORKSPACE_CONTEXT),
      false,
    );
    assert.strictEqual(
      canWritePath(profile, '/workspace/project2/src/index.ts', WORKSPACE_CONTEXT),
      false,
    );
  });

  test('workspace-write profile allows ordinary workspace writes and blocks outside writes', () => {
    const profile = createWorkspaceWritePermissionProfile();

    assert.strictEqual(
      canReadPath(profile, '/workspace/project/src/index.ts', WORKSPACE_CONTEXT),
      true,
    );
    assert.strictEqual(
      canWritePath(profile, '/workspace/project/src/index.ts', WORKSPACE_CONTEXT),
      true,
    );
    assert.strictEqual(
      canWritePath(profile, '/workspace/project2/src/index.ts', WORKSPACE_CONTEXT),
      false,
    );
  });

  test('workspace-write profile allows tmp writes when tmp context is provided', () => {
    const profile = createWorkspaceWritePermissionProfile();

    assert.strictEqual(canWritePath(profile, '/private/tmp/maka/out.txt', WORKSPACE_CONTEXT), true);
    assert.strictEqual(canWritePath(profile, '/tmp/maka-out.txt', WORKSPACE_CONTEXT), true);
    assert.strictEqual(canWritePath(profile, '/tmp2/maka-out.txt', WORKSPACE_CONTEXT), false);
  });

  test('workspace-write profile allows protected metadata writes inside the workspace', () => {
    const profile = createWorkspaceWritePermissionProfile();

    for (const path of [
      '/workspace/project/.git/config',
      '/workspace/project/.agents/state.json',
      '/workspace/project/packages/demo/.codex/settings.json',
    ]) {
      assert.strictEqual(isProtectedMetadataPath(path, WORKSPACE_CONTEXT.workspaceRoots), true);
      assert.strictEqual(canReadPath(profile, path, WORKSPACE_CONTEXT), true);
      assert.strictEqual(canWritePath(profile, path, WORKSPACE_CONTEXT), true);
    }

    assert.strictEqual(
      isProtectedMetadataPath('/workspace/project/.gitignore', WORKSPACE_CONTEXT.workspaceRoots),
      false,
    );
    assert.strictEqual(
      canWritePath(profile, '/workspace/project/.gitignore', WORKSPACE_CONTEXT),
      true,
    );
  });

  test('matches Windows drive roots and protected metadata by backslash-separated segment', () => {
    assert.strictEqual(pathWithinRoot('C:\\Windows', 'C:\\'), true);
    assert.strictEqual(pathWithinRoot('C:\\workspace2', 'C:\\workspace'), false);
    assert.strictEqual(
      isProtectedMetadataPath('C:\\workspace\\.git\\config', ['C:\\workspace']),
      true,
    );
    assert.strictEqual(
      isProtectedMetadataPath('C:\\workspace\\packages\\demo\\.agents\\state.json', [
        'C:\\workspace',
      ]),
      true,
    );
    assert.strictEqual(
      isProtectedMetadataPath('C:\\workspace\\.gitignore', ['C:\\workspace']),
      false,
    );
    // Windows containment is case-insensitive, so metadata names must be too:
    // `.GIT\config` reaches the real `.git\config` on a Windows filesystem.
    assert.strictEqual(
      isProtectedMetadataPath('C:\\workspace\\.GIT\\config', ['C:\\workspace']),
      true,
    );
    assert.strictEqual(
      isProtectedMetadataPath('C:\\WORKSPACE\\.Git\\HEAD', ['C:\\workspace']),
      true,
    );
    // POSIX filesystems are case-sensitive; `.GIT` is a distinct directory.
    assert.strictEqual(isProtectedMetadataPath('/workspace/.GIT/config', ['/workspace']), false);
    assert.strictEqual(pathWithinRoot('C:\\workspace\\..\\secret', 'C:\\workspace'), false);
    assert.strictEqual(pathWithinRoot('/workspace/../secret', '/workspace'), false);
    assert.strictEqual(pathWithinRoot('C:\\workspace\\file:stream', 'C:\\workspace'), false);
    assert.strictEqual(pathWithinRoot('\\\\server\\share\\file', '\\\\server\\share'), false);
  });

  test('danger-full-access profile is managed unrestricted access with network enabled', () => {
    const profile = createDangerFullAccessPermissionProfile();

    assert.strictEqual(profile.type, 'managed');
    if (profile.type !== 'managed') throw new Error('expected managed profile');
    assert.strictEqual(profile.fileSystem.kind, 'unrestricted');
    assert.strictEqual(profile.network.kind, 'enabled');
    assert.strictEqual(canReadPath(profile, '/etc/passwd'), true);
    assert.strictEqual(canWritePath(profile, '/var/log/maka.log'), true);
  });
});

describe('isReadOnlyPermissionProfile', () => {
  test('separates the read-only profile from every profile that grants more', () => {
    assert.strictEqual(isReadOnlyPermissionProfile(createReadOnlyPermissionProfile()), true);
    assert.strictEqual(isReadOnlyPermissionProfile(createWorkspaceWritePermissionProfile()), false);
    assert.strictEqual(
      isReadOnlyPermissionProfile(createDangerFullAccessPermissionProfile()),
      false,
    );
  });

  test('follows the policy rather than the profile name', () => {
    const widenedByExpansion: PermissionProfileManaged = {
      ...createReadOnlyPermissionProfile(),
      fileSystem: {
        kind: 'restricted',
        entries: [
          { kind: 'special', access: 'read', special: ':workspace_roots' },
          { kind: 'path', access: 'write', path: '/workspace/out', match: 'subtree' },
        ],
      },
    };
    assert.strictEqual(isReadOnlyPermissionProfile(widenedByExpansion), false);

    const networkEnabled: PermissionProfileManaged = {
      ...createReadOnlyPermissionProfile(),
      network: { kind: 'enabled' },
    };
    assert.strictEqual(isReadOnlyPermissionProfile(networkEnabled), false);

    const renamedButStillReadOnly: PermissionProfileManaged = {
      ...createReadOnlyPermissionProfile(),
      name: 'custom',
    };
    assert.strictEqual(isReadOnlyPermissionProfile(renamedButStillReadOnly), true);
  });
});

describe('PermissionProfile matcher rules', () => {
  test('deny entries take precedence over read and write entries', () => {
    const profile: PermissionProfile = {
      type: 'managed',
      fileSystem: {
        kind: 'restricted',
        entries: [
          { kind: 'path', access: 'write', path: '/repo' },
          { kind: 'path', access: 'deny', path: '/repo/secret' },
        ],
      },
      network: { kind: 'restricted' },
    };

    assert.strictEqual(isDeniedPath(profile, '/repo/secret/token.txt'), true);
    assert.strictEqual(canReadPath(profile, '/repo/secret/token.txt'), false);
    assert.strictEqual(canWritePath(profile, '/repo/secret/token.txt'), false);
  });

  test('write access implies read access', () => {
    const profile: PermissionProfile = {
      type: 'managed',
      fileSystem: {
        kind: 'restricted',
        entries: [{ kind: 'path', access: 'write', path: '/repo' }],
      },
      network: { kind: 'restricted' },
    };

    assert.strictEqual(canReadPath(profile, '/repo/src/index.ts'), true);
    assert.strictEqual(canWritePath(profile, '/repo/src/index.ts'), true);
  });

  test('path matching respects segment boundaries', () => {
    const profile: PermissionProfile = {
      type: 'managed',
      fileSystem: {
        kind: 'restricted',
        entries: [{ kind: 'path', access: 'read', path: '/repo' }],
      },
      network: { kind: 'restricted' },
    };

    assert.strictEqual(canReadPath(profile, '/repo/src/index.ts'), true);
    assert.strictEqual(canReadPath(profile, '/repo2/src/index.ts'), false);
  });

  test('special entries resolve through matcher context', () => {
    const profile: PermissionProfile = {
      type: 'managed',
      fileSystem: {
        kind: 'restricted',
        entries: [{ kind: 'special', access: 'write', special: ':tmpdir' }],
      },
      network: { kind: 'restricted' },
    };

    assert.strictEqual(
      canWritePath(profile, '/private/tmp/maka/result.txt', WORKSPACE_CONTEXT),
      true,
    );
    assert.strictEqual(
      canWritePath(profile, '/private/tmp2/maka/result.txt', WORKSPACE_CONTEXT),
      false,
    );
  });
});
