import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  clearResolvedSkillPreferenceReviews,
  createManagedSkillLock,
  encodeSkillRuntimePreferences,
  listManagedSkillSources,
  patchSkillRuntimePreference,
  readManagedSkillSource,
  readManagedSkillSources,
  resolveManagedSkillSourcesRoot,
  resolveSkillPreferenceTarget,
  validateSkillLock,
} from '../skills.js';

describe('shared bundled skill catalog', () => {
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

  it('resolves stable refs and rejects ambiguous ids', () => {
    assert.deepEqual(resolveSkillPreferenceTarget(inventory, 'shared'), {
      ok: false,
      reason: 'needs_review',
    });
    assert.deepEqual(resolveSkillPreferenceTarget(inventory, 'workspace:legacy:writer'), {
      ok: true,
      target: inventory[2],
    });
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
