import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BUNDLED_SKILL_CATALOG,
  clearResolvedSkillPreferenceReviews,
  createBundledSkillLock,
  createManagedSkillLock,
  encodeSkillRuntimePreferences,
  getSkillRuntimePreference,
  getBundledSkillSource,
  listManagedSkillSources,
  isSkillPreferenceReviewPending,
  migrateSkillRuntimePreferences,
  patchSkillRuntimePreference,
  readManagedSkillSource,
  readManagedSkillSources,
  resolveManagedSkillSourcesRoot,
  resolveSkillPreferenceTarget,
  validateSkillLock,
  type SkillRuntimeStateReadResult,
} from '../skills.js';

describe('shared bundled skill catalog', () => {
  it('is the complete byte-pinned catalog with bundled provenance and legacy trust', () => {
    assert.equal(BUNDLED_SKILL_CATALOG.length, 30);
    assert.equal(new Set(BUNDLED_SKILL_CATALOG.map((skill) => skill.id)).size, 30);
    for (const skill of BUNDLED_SKILL_CATALOG) {
      assert.equal(skill.contentSha256, sha256(skill.body));
      assert.ok(skill.body.startsWith('---\n'));
      assert.equal(skill.sourceName, 'maka-bundled');
      assert.equal(skill.sourceVersion, '1');
      assert.equal(
        new Set(skill.legacyContentSha256).size,
        skill.legacyContentSha256.length,
        `${skill.id} legacy trust must not contain duplicate hashes`,
      );
      assert.equal(
        skill.legacyContentSha256.every((hash) => /^sha256:[a-f0-9]{64}$/.test(hash)),
        true,
        `${skill.id} legacy trust must contain canonical SHA-256 hashes`,
      );
      const currentLock = createBundledSkillLock(skill, '2026-01-02T03:04:05.000Z');
      assert.equal(
        validateSkillLock({
          lock: currentLock,
          skillId: skill.id,
          currentContentSha256: skill.contentSha256,
        }).validationStatus,
        'ok',
      );

      for (const legacyContentSha256 of skill.legacyContentSha256) {
        const legacy = validateSkillLock({
          lock: { ...currentLock, contentSha256: legacyContentSha256 },
          skillId: skill.id,
          currentContentSha256: skill.contentSha256,
        });
        assert.equal(legacy.sourceType, 'bundled');
        assert.equal(legacy.validationStatus, 'modified');
      }
    }
  });

  it('constructs and validates managed provenance and update status', () => {
    const installedHash = `sha256:${'1'.repeat(64)}`;
    const updatedHash = `sha256:${'2'.repeat(64)}`;
    const lock = createManagedSkillLock(
      'research',
      installedHash,
      installedHash,
      'research-source',
      '2026-01-02T03:04:05.000Z',
    );

    assert.equal(
      validateSkillLock({
        lock,
        skillId: 'research',
        currentContentSha256: installedHash,
        managedSource: { status: 'available', contentSha256: installedHash },
      }).managedUpdateStatus,
      'up_to_date',
    );
    assert.equal(
      validateSkillLock({
        lock,
        skillId: 'research',
        currentContentSha256: installedHash,
        managedSource: { status: 'available', contentSha256: updatedHash },
      }).managedUpdateStatus,
      'update_available',
    );
    assert.equal(
      validateSkillLock({
        lock,
        skillId: 'research',
        currentContentSha256: installedHash,
        managedSource: { status: 'missing' },
      }).managedUpdateStatus,
      'source_missing',
    );
    assert.equal(
      validateSkillLock({
        lock,
        skillId: 'research',
        currentContentSha256: updatedHash,
        managedSource: { status: 'available', contentSha256: updatedHash },
      }).managedUpdateStatus,
      'local_modified',
    );
  });

  it('trusts the published drafter-diagram lock without changing its bundled identity', () => {
    const source = getBundledSkillSource('drafter-diagram');
    assert.ok(source);
    assert.equal(source.sourceName, 'maka-bundled');
    assert.deepEqual(source.legacyContentSha256, [
      'sha256:4b93ebada2f061f1dfc3d99a21bc93a9d3d640f326af6230d15813bac6a5efcf',
    ]);

    const publishedHash = 'sha256:4b93ebada2f061f1dfc3d99a21bc93a9d3d640f326af6230d15813bac6a5efcf';
    const publishedLock = {
      schemaVersion: 1,
      id: 'drafter-diagram',
      sourceType: 'bundled',
      sourceName: 'maka-bundled',
      sourceVersion: '1',
      contentSha256: publishedHash,
      installedAt: '2026-07-01T00:00:00.000Z',
    };
    assert.deepEqual(
      validateSkillLock({
        lock: publishedLock,
        skillId: 'drafter-diagram',
        currentContentSha256: publishedHash,
      }),
      {
        sourceType: 'bundled',
        sourceName: 'maka-bundled',
        sourceVersion: '1',
        installedAt: '2026-07-01T00:00:00.000Z',
        contentSha256: publishedHash,
        userModified: false,
        validationStatus: 'ok',
        validationCodes: [],
        managedUpdateStatus: 'not_managed',
      },
    );
  });
});

describe('shared managed skill source reader', () => {
  it('lists and reads real sources without requiring registry metadata', async () => {
    await withTempRoot(async (root) => {
      const sourceRoot = join(root, 'skill-sources');
      const sourceDir = join(sourceRoot, 'research');
      await mkdir(sourceDir, { recursive: true });
      const body = `---
name: Research
description: Build a research brief.
category: 研究与分析
---
# Research
`;
      await writeFile(join(sourceDir, 'SKILL.md'), body, 'utf8');
      await writeFile(join(sourceRoot, 'registry.json'), '{"stale":true}', 'utf8');

      const listed = await listManagedSkillSources(sourceRoot);
      assert.deepEqual(
        listed.map((source) => source.id),
        ['research'],
      );
      assert.equal(listed[0].category, '研究与分析');

      const read = await readManagedSkillSource(sourceRoot, 'research');
      assert.equal(read.ok, true);
      if (!read.ok) return;
      assert.equal(read.content, body);
      assert.equal(read.contentSha256, sha256(body));
    });
  });

  it('rejects symlinked roots and contained source escapes', async () => {
    await withTempRoot(async (root) => {
      const outside = join(root, 'outside');
      const sourceRoot = join(root, 'skill-sources');
      await mkdir(outside);
      await mkdir(sourceRoot);
      await writeFile(
        join(outside, 'SKILL.md'),
        '---\nname: Outside\ndescription: Outside.\n---\n',
      );
      await symlink(outside, join(sourceRoot, 'escaped'));
      assert.deepEqual(await readManagedSkillSource(sourceRoot, 'escaped'), {
        ok: false,
        reason: 'blocked_path',
      });

      await symlink(sourceRoot, join(root, 'root-link'));
      assert.deepEqual(await listManagedSkillSources(join(root, 'root-link')), []);
    });
  });

  it('distinguishes missing roots and children from read failures', async () => {
    if (process.platform === 'win32') return;
    await withTempRoot(async (root) => {
      const sourceRoot = join(root, 'skill-sources');
      const sourceDir = join(sourceRoot, 'restricted');
      await mkdir(sourceDir, { recursive: true });
      await writeFile(
        join(sourceDir, 'SKILL.md'),
        '---\nname: Restricted\ndescription: Restricted.\n---\n',
      );

      assert.deepEqual(await readManagedSkillSources(join(root, 'missing')), {
        ok: false,
        reason: 'not_found',
      });
      assert.deepEqual(await readManagedSkillSource(sourceRoot, 'missing'), {
        ok: false,
        reason: 'not_found',
      });

      await chmod(sourceDir, 0o000);
      try {
        assert.deepEqual(await readManagedSkillSource(sourceRoot, 'restricted'), {
          ok: false,
          reason: 'read_failed',
        });
        assert.deepEqual(await readManagedSkillSources(sourceRoot), {
          ok: false,
          reason: 'read_failed',
        });
      } finally {
        await chmod(sourceDir, 0o700);
      }
    });
  });

  it('resolves only the read-only machine source location contract', () => {
    assert.equal(
      resolveManagedSkillSourcesRoot('/Users/ada'),
      join('/Users/ada', '.maka', 'skill-sources'),
    );
  });
});

describe('shared skill preference semantics', () => {
  const inventory = [
    { ref: 'project:maka:shared', id: 'shared' },
    { ref: 'user:maka:shared', id: 'shared' },
    { ref: 'workspace:legacy:writer', id: 'writer' },
  ];

  it('resolves refs, rejects ambiguous ids, and migrates only unambiguous v1 keys', () => {
    assert.deepEqual(resolveSkillPreferenceTarget(inventory, 'shared'), {
      ok: false,
      reason: 'needs_review',
    });
    assert.deepEqual(resolveSkillPreferenceTarget(inventory, 'workspace:legacy:writer'), {
      ok: true,
      target: inventory[2],
    });

    const state: Extract<SkillRuntimeStateReadResult, { ok: true }> = {
      ok: true,
      states: new Map([
        ['shared', false],
        ['writer', false],
      ]),
      preferences: new Map([
        ['shared', { enabled: false, pinned: false }],
        ['writer', { enabled: false, pinned: true }],
      ]),
      needsReview: new Set(),
      schemaVersion: 1,
    };
    const migrated = migrateSkillRuntimePreferences(state, inventory);
    assert.equal(migrated.preferences.has('writer'), false);
    assert.deepEqual(migrated.preferences.get('workspace:legacy:writer'), {
      enabled: false,
      pinned: true,
    });
    assert.equal(migrated.preferences.has('shared'), true);
    assert.deepEqual([...migrated.needsReview], ['shared']);
  });

  it('patches one stable ref and clears review only after every collision is explicit', () => {
    const migration = {
      preferences: new Map([['shared', { enabled: false, pinned: false }]]),
      needsReview: new Set(['shared']),
    };
    const first = clearResolvedSkillPreferenceReviews(
      patchSkillRuntimePreference(
        migration,
        inventory[0],
        { pinned: true },
        '2026-01-02T03:04:05.000Z',
      ),
      inventory,
    );
    assert.deepEqual([...first.needsReview], ['shared']);

    const second = clearResolvedSkillPreferenceReviews(
      patchSkillRuntimePreference(
        first,
        inventory[1],
        { enabled: true },
        '2026-01-02T03:05:05.000Z',
      ),
      inventory,
    );
    assert.deepEqual([...second.needsReview], []);
    assert.equal(second.preferences.has('shared'), false);
    assert.equal(second.preferences.get(inventory[0].ref)?.pinned, true);
    assert.equal(second.preferences.get(inventory[1].ref)?.enabled, true);
  });

  it('normalizes case-only legacy ids across migration, prior lookup, and review clearing', () => {
    const caseInventory = [
      { ref: 'project:maka:Shared', id: 'Shared' },
      { ref: 'workspace:legacy:shared', id: 'shared' },
    ];
    const state: Extract<SkillRuntimeStateReadResult, { ok: true }> = {
      ok: true,
      states: new Map([['Shared', false]]),
      preferences: new Map([['Shared', { enabled: false, pinned: true }]]),
      needsReview: new Set(),
      schemaVersion: 1,
    };
    const migrated = migrateSkillRuntimePreferences(state, caseInventory);
    assert.equal(isSkillPreferenceReviewPending(migrated, 'Shared'), true);
    assert.equal(isSkillPreferenceReviewPending(migrated, 'shared'), true);
    assert.deepEqual(getSkillRuntimePreference(migrated, caseInventory[0]), {
      enabled: false,
      pinned: true,
    });
    assert.deepEqual(getSkillRuntimePreference(migrated, caseInventory[1]), {
      enabled: false,
      pinned: true,
    });

    const first = clearResolvedSkillPreferenceReviews(
      patchSkillRuntimePreference(migrated, caseInventory[0], { enabled: false }),
      caseInventory,
    );
    assert.equal(isSkillPreferenceReviewPending(first, 'shared'), true);
    const second = clearResolvedSkillPreferenceReviews(
      patchSkillRuntimePreference(first, caseInventory[1], { enabled: false }),
      caseInventory,
    );
    assert.equal(isSkillPreferenceReviewPending(second, 'Shared'), false);
    assert.equal(second.preferences.has('Shared'), false);
    assert.equal(second.preferences.has('shared'), false);
    assert.equal(second.preferences.has(caseInventory[0].ref), true);
    assert.equal(second.preferences.has(caseInventory[1].ref), true);
  });

  it('re-evaluates unresolved schema v2 bare ids without migrating stable refs', () => {
    const stablePreference = { enabled: true, pinned: true };
    const unresolvedPreference = { enabled: false, pinned: false };
    const state: Extract<SkillRuntimeStateReadResult, { ok: true }> = {
      ok: true,
      states: new Map([
        ['Future', false],
        ['project:maka:Shared', true],
      ]),
      preferences: new Map([
        ['Future', unresolvedPreference],
        ['project:maka:Shared', stablePreference],
      ]),
      needsReview: new Set(),
      schemaVersion: 2,
    };

    const beforeDiscovery = migrateSkillRuntimePreferences(state, []);
    assert.equal(beforeDiscovery.preferences.get('Future'), unresolvedPreference);
    assert.equal(beforeDiscovery.needsReview.size, 0);

    const afterDiscovery = migrateSkillRuntimePreferences(state, [
      { ref: 'project:maka:future', id: 'future' },
      { ref: 'user:agents:Future', id: 'Future' },
      { ref: 'project:maka:shared', id: 'shared' },
    ]);
    assert.deepEqual([...afterDiscovery.needsReview], ['Future']);
    assert.equal(afterDiscovery.preferences.get('Future'), unresolvedPreference);
    assert.equal(afterDiscovery.preferences.get('project:maka:Shared'), stablePreference);
    assert.equal(afterDiscovery.preferences.has('project:maka:shared'), false);
  });

  it('resolves case-only stable refs exactly while keeping bare ids normalized', () => {
    const caseInventory = [
      { ref: 'project:maka:Shared', id: 'Shared' },
      { ref: 'project:maka:shared', id: 'shared' },
    ];
    assert.deepEqual(resolveSkillPreferenceTarget(caseInventory, 'project:maka:Shared'), {
      ok: true,
      target: caseInventory[0],
    });
    assert.deepEqual(resolveSkillPreferenceTarget(caseInventory, 'project:maka:shared'), {
      ok: true,
      target: caseInventory[1],
    });
    assert.deepEqual(resolveSkillPreferenceTarget(caseInventory, 'SHARED'), {
      ok: false,
      reason: 'needs_review',
    });
  });

  it('encodes canonical schema v2 state for all persistence owners', () => {
    const encoded = encodeSkillRuntimePreferences(
      new Map([
        ['workspace:legacy:zeta', { enabled: true, pinned: false }],
        [
          'project:maka:alpha',
          { enabled: false, pinned: true, updatedAt: '2026-01-02T03:04:05.000Z' },
        ],
      ]),
      {
        defaultUpdatedAt: '2026-01-02T00:00:00.000Z',
        needsReview: new Set(['shared']),
      },
    );
    const parsed = JSON.parse(encoded) as {
      schemaVersion: number;
      skills: Record<string, { enabled: boolean; pinned: boolean; updatedAt: string }>;
      migration: { needsReview: string[] };
    };
    assert.deepEqual(parsed, {
      schemaVersion: 2,
      skills: {
        'project:maka:alpha': {
          enabled: false,
          pinned: true,
          updatedAt: '2026-01-02T03:04:05.000Z',
        },
        'workspace:legacy:zeta': {
          enabled: true,
          pinned: false,
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      },
      migration: { needsReview: ['shared'] },
    });
  });
});

function sha256(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

async function withTempRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-runtime-skill-governance-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
