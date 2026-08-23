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

import { describe, test } from 'node:test';
import { expect } from './test-helpers.js';
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

    expect(canReadPath(profile, '/workspace/project/src/index.ts', WORKSPACE_CONTEXT)).toBe(true);
    expect(canWritePath(profile, '/workspace/project/src/index.ts', WORKSPACE_CONTEXT)).toBe(false);
    expect(canReadPath(profile, '/workspace/project2/src/index.ts', WORKSPACE_CONTEXT)).toBe(false);
    expect(canWritePath(profile, '/workspace/project2/src/index.ts', WORKSPACE_CONTEXT)).toBe(
      false,
    );
  });

  test('workspace-write profile allows ordinary workspace writes and blocks outside writes', () => {
    const profile = createWorkspaceWritePermissionProfile();

    expect(canReadPath(profile, '/workspace/project/src/index.ts', WORKSPACE_CONTEXT)).toBe(true);
    expect(canWritePath(profile, '/workspace/project/src/index.ts', WORKSPACE_CONTEXT)).toBe(true);
    expect(canWritePath(profile, '/workspace/project2/src/index.ts', WORKSPACE_CONTEXT)).toBe(
      false,
    );
  });

  test('workspace-write profile allows tmp writes when tmp context is provided', () => {
    const profile = createWorkspaceWritePermissionProfile();

    expect(canWritePath(profile, '/private/tmp/maka/out.txt', WORKSPACE_CONTEXT)).toBe(true);
    expect(canWritePath(profile, '/tmp/maka-out.txt', WORKSPACE_CONTEXT)).toBe(true);
    expect(canWritePath(profile, '/tmp2/maka-out.txt', WORKSPACE_CONTEXT)).toBe(false);
  });

  test('workspace-write profile allows protected metadata writes inside the workspace', () => {
    const profile = createWorkspaceWritePermissionProfile();

    for (const path of [
      '/workspace/project/.git/config',
      '/workspace/project/.agents/state.json',
      '/workspace/project/packages/demo/.codex/settings.json',
    ]) {
      expect(isProtectedMetadataPath(path, WORKSPACE_CONTEXT.workspaceRoots)).toBe(true);
      expect(canReadPath(profile, path, WORKSPACE_CONTEXT)).toBe(true);
      expect(canWritePath(profile, path, WORKSPACE_CONTEXT)).toBe(true);
    }

    expect(
      isProtectedMetadataPath('/workspace/project/.gitignore', WORKSPACE_CONTEXT.workspaceRoots),
    ).toBe(false);
    expect(canWritePath(profile, '/workspace/project/.gitignore', WORKSPACE_CONTEXT)).toBe(true);
  });

  test('matches Windows drive roots and protected metadata by backslash-separated segment', () => {
    expect(pathWithinRoot('C:\\Windows', 'C:\\')).toBe(true);
    expect(pathWithinRoot('C:\\workspace2', 'C:\\workspace')).toBe(false);
    expect(isProtectedMetadataPath('C:\\workspace\\.git\\config', ['C:\\workspace'])).toBe(true);
    expect(
      isProtectedMetadataPath('C:\\workspace\\packages\\demo\\.agents\\state.json', [
        'C:\\workspace',
      ]),
    ).toBe(true);
    expect(isProtectedMetadataPath('C:\\workspace\\.gitignore', ['C:\\workspace'])).toBe(false);
    // Windows containment is case-insensitive, so metadata names must be too:
    // `.GIT\config` reaches the real `.git\config` on a Windows filesystem.
    expect(isProtectedMetadataPath('C:\\workspace\\.GIT\\config', ['C:\\workspace'])).toBe(true);
    expect(isProtectedMetadataPath('C:\\WORKSPACE\\.Git\\HEAD', ['C:\\workspace'])).toBe(true);
    // POSIX filesystems are case-sensitive; `.GIT` is a distinct directory.
    expect(isProtectedMetadataPath('/workspace/.GIT/config', ['/workspace'])).toBe(false);
    expect(pathWithinRoot('C:\\workspace\\..\\secret', 'C:\\workspace')).toBe(false);
    expect(pathWithinRoot('/workspace/../secret', '/workspace')).toBe(false);
    expect(pathWithinRoot('C:\\workspace\\file:stream', 'C:\\workspace')).toBe(false);
    expect(pathWithinRoot('\\\\server\\share\\file', '\\\\server\\share')).toBe(false);
  });

  test('danger-full-access profile is managed unrestricted access with network enabled', () => {
    const profile = createDangerFullAccessPermissionProfile();

    expect(profile.type).toBe('managed');
    if (profile.type !== 'managed') throw new Error('expected managed profile');
    expect(profile.fileSystem.kind).toBe('unrestricted');
    expect(profile.network.kind).toBe('enabled');
    expect(canReadPath(profile, '/etc/passwd')).toBe(true);
    expect(canWritePath(profile, '/var/log/maka.log')).toBe(true);
  });
});

describe('isReadOnlyPermissionProfile', () => {
  test('separates the read-only profile from every profile that grants more', () => {
    expect(isReadOnlyPermissionProfile(createReadOnlyPermissionProfile())).toBe(true);
    expect(isReadOnlyPermissionProfile(createWorkspaceWritePermissionProfile())).toBe(false);
    expect(isReadOnlyPermissionProfile(createDangerFullAccessPermissionProfile())).toBe(false);
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
    expect(isReadOnlyPermissionProfile(widenedByExpansion)).toBe(false);

    const networkEnabled: PermissionProfileManaged = {
      ...createReadOnlyPermissionProfile(),
      network: { kind: 'enabled' },
    };
    expect(isReadOnlyPermissionProfile(networkEnabled)).toBe(false);

    const renamedButStillReadOnly: PermissionProfileManaged = {
      ...createReadOnlyPermissionProfile(),
      name: 'custom',
    };
    expect(isReadOnlyPermissionProfile(renamedButStillReadOnly)).toBe(true);
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

    expect(isDeniedPath(profile, '/repo/secret/token.txt')).toBe(true);
    expect(canReadPath(profile, '/repo/secret/token.txt')).toBe(false);
    expect(canWritePath(profile, '/repo/secret/token.txt')).toBe(false);
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

    expect(canReadPath(profile, '/repo/src/index.ts')).toBe(true);
    expect(canWritePath(profile, '/repo/src/index.ts')).toBe(true);
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

    expect(canReadPath(profile, '/repo/src/index.ts')).toBe(true);
    expect(canReadPath(profile, '/repo2/src/index.ts')).toBe(false);
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

    expect(canWritePath(profile, '/private/tmp/maka/result.txt', WORKSPACE_CONTEXT)).toBe(true);
    expect(canWritePath(profile, '/private/tmp2/maka/result.txt', WORKSPACE_CONTEXT)).toBe(false);
  });
});
