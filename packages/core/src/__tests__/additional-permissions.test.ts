import { describe, test } from 'node:test';
import { expect } from '../test-helpers.js';
import {
  additionalPermissionAllowsPath,
  applyAdditionalPermissionProfile,
  compactAdditionalFileSystemPermissions,
  serializeAdditionalPermissionProfile,
  validateAdditionalPermissionProfile,
  type AdditionalPermissionProfile,
} from '../additional-permissions.js';
import {
  canReadPath,
  canWritePath,
  createWorkspaceWritePermissionProfile,
  type PermissionProfile,
} from '../permission-profile.js';

const CONTEXT = { workspaceRoots: ['/workspace/project'] };

describe('AdditionalPermissionProfile validation', () => {
  test('accepts and canonicalizes a minimal filesystem permission', () => {
    const result = validateAdditionalPermissionProfile({
      fileSystem: {
        entries: [{ path: '/outside/file.txt', access: 'write', scope: 'exact' }],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile).toEqual({
      fileSystem: {
        entries: [{ path: '/outside/file.txt', access: 'write', scope: 'exact' }],
      },
    });
  });

  test('accepts one-command network enable', () => {
    expect(validateAdditionalPermissionProfile({ network: { enabled: true } })).toEqual({
      ok: true,
      profile: { network: { enabled: true } },
    });
  });

  test('rejects empty, relative, malformed, and policy-shaped profiles', () => {
    for (const profile of [
      {},
      { fileSystem: { entries: [] } },
      { fileSystem: { entries: [{ path: '../outside', access: 'read', scope: 'exact' }] } },
      { fileSystem: { entries: [{ path: '/outside', access: 'deny', scope: 'exact' }] } },
      { fileSystem: { entries: [{ path: '/outside', access: 'read', scope: 'special' }] } },
      {
        fileSystem: {
          entries: [{ path: '/outside', access: 'read', scope: 'exact', kind: 'path' }],
        },
      },
      { network: { enabled: false } },
      { type: 'managed', network: { enabled: true } },
    ]) {
      expect(validateAdditionalPermissionProfile(profile).ok).toBe(false);
    }
  });

  test('compacts covered and duplicate entries deterministically', () => {
    expect(
      compactAdditionalFileSystemPermissions([
        { path: '/outside/tree/file.txt', access: 'read', scope: 'exact' },
        { path: '/outside/tree', access: 'read', scope: 'subtree' },
        { path: '/outside/tree', access: 'read', scope: 'subtree' },
        { path: '/outside/write.txt', access: 'read', scope: 'exact' },
        { path: '/outside/write.txt', access: 'write', scope: 'exact' },
      ]),
    ).toEqual([
      { path: '/outside/tree', access: 'read', scope: 'subtree' },
      { path: '/outside/write.txt', access: 'write', scope: 'exact' },
    ]);
  });

  test('canonical serialization is stable across input order', () => {
    const first: AdditionalPermissionProfile = {
      fileSystem: {
        entries: [
          { path: '/b', access: 'read', scope: 'exact' },
          { path: '/a', access: 'write', scope: 'subtree' },
        ],
      },
      network: { enabled: true },
    };
    const second: AdditionalPermissionProfile = {
      network: { enabled: true },
      fileSystem: { entries: [...first.fileSystem!.entries].reverse() },
    };
    expect(serializeAdditionalPermissionProfile(first)).toBe(
      serializeAdditionalPermissionProfile(second),
    );
  });
});

describe('Additional permission matching and effective profiles', () => {
  test('exact matches only one path while subtree includes descendants', () => {
    const profile: AdditionalPermissionProfile = {
      fileSystem: {
        entries: [
          { path: '/outside/exact.txt', access: 'read', scope: 'exact' },
          { path: '/outside/tree', access: 'write', scope: 'subtree' },
        ],
      },
    };
    expect(additionalPermissionAllowsPath(profile, '/outside/exact.txt', 'read')).toBe(true);
    expect(additionalPermissionAllowsPath(profile, '/outside/exact.txt/sibling', 'read')).toBe(
      false,
    );
    expect(additionalPermissionAllowsPath(profile, '/outside/tree/child.txt', 'write')).toBe(true);
    expect(additionalPermissionAllowsPath(profile, '/outside/tree2/child.txt', 'write')).toBe(
      false,
    );
  });

  test('write permission implies read permission', () => {
    const profile: AdditionalPermissionProfile = {
      fileSystem: { entries: [{ path: '/outside/file.txt', access: 'write', scope: 'exact' }] },
    };
    expect(additionalPermissionAllowsPath(profile, '/outside/file.txt', 'read')).toBe(true);
    expect(additionalPermissionAllowsPath(profile, '/outside/file.txt', 'write')).toBe(true);
  });

  test('effective profile grants one outside path without mutating the base profile', () => {
    const base = createWorkspaceWritePermissionProfile();
    const effective = applyAdditionalPermissionProfile(base, {
      fileSystem: { entries: [{ path: '/outside/file.txt', access: 'write', scope: 'exact' }] },
    });
    expect(canWritePath(base, '/outside/file.txt', CONTEXT)).toBe(false);
    expect(canWritePath(effective, '/outside/file.txt', CONTEXT)).toBe(true);
    expect(canWritePath(effective, '/outside/sibling.txt', CONTEXT)).toBe(false);
  });

  test('explicit deny remains stronger than an additional allow', () => {
    const base: PermissionProfile = {
      type: 'managed',
      name: 'custom',
      fileSystem: {
        kind: 'restricted',
        entries: [{ kind: 'path', access: 'deny', path: '/outside/locked', match: 'subtree' }],
      },
      network: { kind: 'restricted' },
    };
    const effective = applyAdditionalPermissionProfile(base, {
      fileSystem: {
        entries: [{ path: '/outside/locked/file.txt', access: 'write', scope: 'exact' }],
      },
    });
    expect(canReadPath(effective, '/outside/locked/file.txt')).toBe(false);
    expect(canWritePath(effective, '/outside/locked/file.txt')).toBe(false);
  });

  test('network enable changes only the effective managed profile', () => {
    const base = createWorkspaceWritePermissionProfile();
    const effective = applyAdditionalPermissionProfile(base, { network: { enabled: true } });
    expect(base.network.kind).toBe('restricted');
    expect(effective.type).toBe('managed');
    if (effective.type === 'managed') expect(effective.network.kind).toBe('enabled');
  });
});
