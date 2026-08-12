import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { expect } from '../test-helpers.js';
import {
  applySandboxBoundaryExpansion,
  assessSandboxBoundaryExpansion,
  createGenesisExecutionBoundary,
  decodeExecutionBoundary,
  executionBoundaryContains,
  executionBoundaryDisplayMode,
  validateSandboxBoundaryExpansion,
} from '../sandbox-boundary.js';
import {
  canReadPath,
  canWritePath,
  createDangerFullAccessPermissionProfile,
  createReadOnlyPermissionProfile,
  createWorkspaceWritePermissionProfile,
  type PermissionProfileManaged,
} from '../permission-profile.js';

describe('executionBoundaryDisplayMode', () => {
  test('keeps the read-only/writable distinction the boundary carries (#1611)', () => {
    expect(
      executionBoundaryDisplayMode({
        kind: 'managed',
        profile: createReadOnlyPermissionProfile(),
        revision: 0,
      }),
    ).toBe('explore');
    expect(
      executionBoundaryDisplayMode({
        kind: 'managed',
        profile: createWorkspaceWritePermissionProfile(),
        revision: 0,
      }),
    ).toBe('ask');
    expect(executionBoundaryDisplayMode({ kind: 'bypass', revision: 1 })).toBe('bypass');
    expect(
      executionBoundaryDisplayMode({ kind: 'managed', access: 'read_only', revision: 2 }),
    ).toBe('explore');
    expect(executionBoundaryDisplayMode({ kind: 'managed', access: 'writable', revision: 2 })).toBe(
      'ask',
    );
  });

  test('an approved expansion that grants a write stops reading as read-only', () => {
    const widened = applySandboxBoundaryExpansion(createReadOnlyPermissionProfile(), {
      filesystem: { entries: [{ path: '/outside/dist', access: 'write', scope: 'subtree' }] },
    });

    expect(executionBoundaryDisplayMode({ kind: 'managed', profile: widened, revision: 1 })).toBe(
      'ask',
    );
  });

  test('under-states danger-full-access as Auto rather than naming a mode for it', () => {
    // A deliberate collapse, NOT a description of this profile: the picker
    // offers two modes and no third one is being invented for a profile the
    // product does not hand out. Auto's copy is written to stay true here —
    // it never claims a specific boundary — so this under-states rather than
    // misstates. If Auto's hint ever names a boundary again, this mapping
    // becomes a lie and has to change with it.
    expect(
      executionBoundaryDisplayMode({
        kind: 'managed',
        profile: createDangerFullAccessPermissionProfile(),
        revision: 0,
      }),
    ).toBe('ask');
  });

  test('an externally isolated boundary has no locally controllable mode', () => {
    expect(executionBoundaryDisplayMode({ kind: 'external', revision: 0 })).toBe(undefined);
  });
});

describe('SandboxBoundaryExpansion', () => {
  test('accepts and canonicalizes only additive filesystem and network authority', () => {
    const result = validateSandboxBoundaryExpansion({
      filesystem: {
        entries: [
          { path: '/outside/tree/file.txt', access: 'read', scope: 'exact' },
          { path: '/outside/tree', access: 'read', scope: 'subtree' },
        ],
      },
      network: { enabled: true },
    });

    expect(result).toEqual({
      ok: true,
      expansion: {
        filesystem: {
          entries: [{ path: '/outside/tree', access: 'read', scope: 'subtree' }],
        },
        network: { enabled: true },
      },
    });
  });

  test('rejects empty, relative, deny, policy-shaped, and legacy expansions', () => {
    for (const expansion of [
      {},
      { filesystem: { entries: [] } },
      { filesystem: { entries: [{ path: '../outside', access: 'read', scope: 'exact' }] } },
      { filesystem: { entries: [{ path: '/outside', access: 'deny', scope: 'exact' }] } },
      { filesystem: { entries: [{ path: '/outside', access: 'read', scope: 'special' }] } },
      {
        filesystem: {
          entries: [{ path: '/outside', access: 'read', scope: 'exact', kind: 'path' }],
        },
      },
      { network: { enabled: false } },
      { profile: { type: 'managed' } },
      { fileSystem: { entries: [{ path: '/legacy', access: 'read', scope: 'exact' }] } },
    ]) {
      expect(validateSandboxBoundaryExpansion(expansion).ok).toBe(false);
    }
  });

  test('applies additive authority without weakening an explicit deny', () => {
    const base: PermissionProfileManaged = {
      type: 'managed',
      name: 'custom',
      fileSystem: {
        kind: 'restricted',
        entries: [{ kind: 'path', access: 'deny', path: '/outside/locked', match: 'subtree' }],
      },
      network: { kind: 'restricted' },
    };

    const result = applySandboxBoundaryExpansion(base, {
      filesystem: {
        entries: [
          { path: '/outside/open.txt', access: 'write', scope: 'exact' },
          { path: '/outside/locked/file.txt', access: 'write', scope: 'exact' },
        ],
      },
      network: { enabled: true },
    });

    expect(canWritePath(result, '/outside/open.txt')).toBe(true);
    expect(canReadPath(result, '/outside/locked/file.txt')).toBe(false);
    expect(canWritePath(result, '/outside/locked/file.txt')).toBe(false);
    expect(result.network.kind).toBe('enabled');
  });

  test('enables network when filesystem access is already unrestricted', () => {
    const base: PermissionProfileManaged = {
      type: 'managed',
      name: 'custom',
      fileSystem: { kind: 'unrestricted', entries: [] },
      network: { kind: 'restricted' },
    };

    const result = applySandboxBoundaryExpansion(base, {
      network: { enabled: true },
    });

    expect(result.network.kind).toBe('enabled');
  });

  test('compacts cumulative explicit grants without changing special paths or denies', () => {
    const base: PermissionProfileManaged = {
      type: 'managed',
      fileSystem: {
        kind: 'restricted',
        entries: [
          { kind: 'special', access: 'write', special: ':workspace_roots' },
          { kind: 'path', access: 'deny', path: '/outside/locked', match: 'subtree' },
          { kind: 'path', access: 'read', path: '/outside/tree/file.txt', match: 'exact' },
        ],
      },
      network: { kind: 'restricted' },
    };

    const result = applySandboxBoundaryExpansion(base, {
      filesystem: {
        entries: [{ path: '/outside/tree', access: 'read', scope: 'subtree' }],
      },
    });

    expect(result.fileSystem.entries).toEqual([
      { kind: 'special', access: 'write', special: ':workspace_roots' },
      { kind: 'path', access: 'deny', path: '/outside/locked', match: 'subtree' },
      { kind: 'path', access: 'read', path: '/outside/tree', match: 'subtree' },
    ]);
  });

  test('distinguishes a new expansion, an approved no-op, and an explicit-deny conflict', () => {
    const base: PermissionProfileManaged = {
      type: 'managed',
      name: 'custom',
      fileSystem: {
        kind: 'restricted',
        entries: [
          { kind: 'path', access: 'read', path: '/outside/already.txt', match: 'exact' },
          { kind: 'path', access: 'deny', path: '/outside/locked', match: 'subtree' },
        ],
      },
      network: { kind: 'restricted' },
    };

    expect(
      assessSandboxBoundaryExpansion(base, {
        filesystem: {
          entries: [{ path: '/outside/already.txt', access: 'read', scope: 'exact' }],
        },
      }).outcome,
    ).toBe('noop');
    expect(
      assessSandboxBoundaryExpansion(base, {
        filesystem: { entries: [{ path: '/outside/new.txt', access: 'read', scope: 'exact' }] },
      }).outcome,
    ).toBe('apply');
    expect(
      assessSandboxBoundaryExpansion(base, {
        filesystem: {
          entries: [{ path: '/outside', access: 'write', scope: 'subtree' }],
        },
      }),
    ).toEqual({ outcome: 'conflict', reason: 'explicit_deny' });
  });

  test('does not treat a child of an exact path grant as already approved', () => {
    const base: PermissionProfileManaged = {
      type: 'managed',
      name: 'custom',
      fileSystem: {
        kind: 'restricted',
        entries: [{ kind: 'path', access: 'read', path: '/outside', match: 'exact' }],
      },
      network: { kind: 'restricted' },
    };

    const assessment = assessSandboxBoundaryExpansion(base, {
      filesystem: {
        entries: [{ path: '/outside/child', access: 'read', scope: 'exact' }],
      },
    });

    expect(assessment.outcome).toBe('apply');
  });

  test('keeps explicit denies authoritative inside an otherwise unrestricted profile', () => {
    const base: PermissionProfileManaged = {
      type: 'managed',
      name: 'custom',
      fileSystem: {
        kind: 'unrestricted',
        entries: [{ kind: 'path', access: 'deny', path: '/locked', match: 'subtree' }],
      },
      network: { kind: 'enabled' },
    };

    expect(
      assessSandboxBoundaryExpansion(base, {
        filesystem: {
          entries: [{ path: '/locked/file.txt', access: 'read', scope: 'exact' }],
        },
      }),
    ).toEqual({ outcome: 'conflict', reason: 'explicit_deny' });
  });

  test('keeps protected metadata deny-write authoritative over exact write expansions', () => {
    const base: PermissionProfileManaged = {
      type: 'managed',
      name: 'custom',
      fileSystem: {
        kind: 'restricted',
        entries: [{ kind: 'path', access: 'write', path: '/workspace', match: 'subtree' }],
        protectedMetadata: {
          access: 'deny_write',
          names: ['.git'],
        },
      },
      network: { kind: 'restricted' },
    };

    expect(
      assessSandboxBoundaryExpansion(
        base,
        {
          filesystem: {
            entries: [
              {
                path: '/workspace/.git/config',
                access: 'write',
                scope: 'exact',
              },
            ],
          },
        },
        { workspaceRoots: ['/workspace'] },
      ),
    ).toEqual({ outcome: 'conflict', reason: 'explicit_deny' });
  });

  test('uses the same default slash-tmp root as permission enforcement', () => {
    const assessment = assessSandboxBoundaryExpansion(createWorkspaceWritePermissionProfile(), {
      filesystem: {
        entries: [{ path: '/tmp/output.txt', access: 'write', scope: 'exact' }],
      },
    });

    expect(assessment.outcome).toBe('noop');
  });
});

describe('ExecutionBoundary', () => {
  test('decodes only a complete full boundary snapshot', () => {
    const managed = createGenesisExecutionBoundary('ask');
    expect(decodeExecutionBoundary(JSON.parse(JSON.stringify(managed)))).toEqual(managed);
    expect(decodeExecutionBoundary({ kind: 'bypass', revision: 3 })).toEqual({
      kind: 'bypass',
      revision: 3,
    });

    for (const invalid of [
      { kind: 'managed', revision: 0 },
      { kind: 'bypass', revision: -1 },
      { kind: 'external', revision: 1, profile: {} },
      { kind: 'unknown', revision: 0 },
    ]) {
      assert.throws(() => decodeExecutionBoundary(invalid));
    }
  });

  test('round-trips managed protected-metadata policy', () => {
    const managed = createGenesisExecutionBoundary('ask');
    if (managed.kind !== 'managed') throw new Error('expected managed boundary');
    const boundary = {
      ...managed,
      profile: {
        ...managed.profile,
        fileSystem: {
          ...managed.profile.fileSystem,
          protectedMetadata: {
            access: 'deny_write' as const,
            names: ['.git', '.agents', '.codex'],
          },
        },
      },
    };

    expect(decodeExecutionBoundary(JSON.parse(JSON.stringify(boundary)))).toEqual(boundary);
  });

  test('rejects a complete boundary snapshot above the shared capacity', () => {
    const managed = createGenesisExecutionBoundary('ask');
    if (managed.kind !== 'managed') throw new Error('expected managed boundary');
    const oversized = {
      ...managed,
      profile: {
        ...managed.profile,
        fileSystem: {
          ...managed.profile.fileSystem,
          entries: Array.from({ length: 300 }, (_, index) => ({
            kind: 'path' as const,
            access: 'read' as const,
            path: `/outside/${index}-${'x'.repeat(3_900)}`,
            match: 'exact' as const,
          })),
        },
      },
    };

    assert.throws(
      () => decodeExecutionBoundary(oversized),
      /Execution boundary exceeds the serialized size limit/,
    );
  });

  test('compares complete boundary authority with one canonical containment contract', () => {
    const auto = createGenesisExecutionBoundary('ask');
    const readOnly = createGenesisExecutionBoundary('explore');
    const bypass = createGenesisExecutionBoundary('bypass');
    const external = { kind: 'external', revision: 0 } as const;

    expect(executionBoundaryContains(auto, readOnly)).toBe(true);
    expect(executionBoundaryContains(readOnly, auto)).toBe(false);
    expect(executionBoundaryContains(bypass, external)).toBe(true);
    expect(executionBoundaryContains(external, external)).toBe(true);
    expect(executionBoundaryContains(external, auto)).toBe(false);
    expect(executionBoundaryContains(auto, external)).toBe(false);
  });
});
