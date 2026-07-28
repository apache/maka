import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BUNDLED_SKILL_CATALOG,
  MANAGED_SKILL_CATEGORIES,
  validateSkillLock,
} from '@maka/runtime';
import {
  installBundledSkill,
  listBundledSkillCatalog,
  listInstalledSkills,
} from '../skills.js';

const OFFICE_IDS = ['officecli-docx', 'officecli-xlsx', 'officecli-pptx'];
const PRE_CATEGORY_OFFICE_HASHES = {
  'officecli-docx':
    'sha256:ffb84262fc75e3cfc2dd952bb736af335b304627ee79501cd7254cfff223bc83',
  'officecli-pptx':
    'sha256:0e4f5a20bffd0d7598fbdfb8c9dd069110e6baa827554c4fdf26820afff25182',
  'officecli-xlsx':
    'sha256:d0f511370c1e98b9c974fd8e5d9d3319c896cc2ac7315653ed7f76c7ebf1bfa0',
} as const;
const EXPECTED_COUNT = BUNDLED_SKILL_CATALOG.length;

async function withWorkspace(fn: (workspaceRoot: string) => Promise<void>): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-bundled-catalog-'));
  try {
    await fn(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('bundled skill catalog', () => {
  it('ships the Office and reverse-engineered skills as an install-on-demand catalog', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const catalog = await listBundledSkillCatalog(workspaceRoot);
      assert.equal(catalog.length, EXPECTED_COUNT);

      const ids = new Set(catalog.map((entry) => entry.id));
      for (const officeId of OFFICE_IDS) assert.ok(ids.has(officeId), `missing ${officeId}`);
      assert.ok(ids.has('deep-research'));
      assert.ok(ids.has('frontend-design'));

      // Every catalog body must be a valid, importable maka skill: a non-empty
      // name and a category within the fixed taxonomy. Nothing is installed yet.
      for (const entry of catalog) {
        assert.ok(entry.name.length > 0, `${entry.id} has an empty name`);
        assert.ok(
          (MANAGED_SKILL_CATEGORIES as readonly string[]).includes(entry.category),
          `${entry.id} has out-of-taxonomy category ${entry.category}`,
        );
        assert.equal(entry.installed, false);
      }
    });
  });

  it('installs a bundled skill on demand into the workspace', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const result = await installBundledSkill(workspaceRoot, 'deep-research');
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.skill.id, 'deep-research');
      assert.equal(result.skill.sourceType, 'bundled');
      assert.equal(result.skill.userModified, false);
      assert.equal(result.skill.validationStatus, 'ok');

      const skillFile = join(workspaceRoot, 'skills', 'deep-research', 'SKILL.md');
      const lockFile = join(workspaceRoot, 'skills', 'deep-research', 'skill.lock.json');
      assert.ok(await exists(skillFile));
      assert.ok(await exists(lockFile));

      const lock = JSON.parse(await readFile(lockFile, 'utf8')) as Record<string, unknown>;
      assert.equal(lock.sourceType, 'bundled');
      assert.equal(lock.sourceName, 'maka-bundled');

      const catalog = await listBundledSkillCatalog(workspaceRoot);
      assert.equal(catalog.find((entry) => entry.id === 'deep-research')?.installed, true);
      assert.equal(catalog.find((entry) => entry.id === 'frontend-design')?.installed, false);

      const installed = await listInstalledSkills(workspaceRoot);
      assert.deepEqual(installed.map((skill) => skill.id), ['deep-research']);
    });
  });

  it('keeps every shipped bundled skill valid through the installed-skill scanner', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const catalog = await listBundledSkillCatalog(workspaceRoot);
      for (const entry of catalog) {
        const result = await installBundledSkill(workspaceRoot, entry.id);
        assert.equal(result.ok, true, `${entry.id} failed runtime skill validation`);
      }

      const installed = await listInstalledSkills(workspaceRoot);
      assert.equal(installed.length, EXPECTED_COUNT);
      assert.deepEqual(
        new Set(installed.map((skill) => skill.id)),
        new Set(catalog.map((entry) => entry.id)),
      );
    });
  });

  it('keeps pre-category Office installations trusted and unmodified', () => {
    for (const [id, legacyHash] of Object.entries(PRE_CATEGORY_OFFICE_HASHES)) {
      const source = BUNDLED_SKILL_CATALOG.find((skill) => skill.id === id);
      assert.ok(source, `missing ${id}`);
      assert.ok(source.legacyContentSha256.includes(legacyHash), `${id} lost legacy trust`);

      const status = validateSkillLock({
        lock: {
          schemaVersion: 1,
          id,
          sourceType: 'bundled',
          sourceName: source.sourceName,
          sourceVersion: source.sourceVersion,
          contentSha256: legacyHash,
          installedAt: '2026-07-28T00:00:00.000Z',
        },
        skillId: id,
        currentContentSha256: legacyHash,
      });
      assert.equal(status.validationStatus, 'ok', `${id} became ${status.validationStatus}`);
      assert.equal(status.userModified, false, `${id} became user-modified`);
    }
  });

  it('is idempotent: a second install reports already_exists and preserves the copy', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const first = await installBundledSkill(workspaceRoot, 'summarization');
      assert.equal(first.ok, true);
      const skillFile = join(workspaceRoot, 'skills', 'summarization', 'SKILL.md');
      const before = await readFile(skillFile, 'utf8');

      const second = await installBundledSkill(workspaceRoot, 'summarization');
      assert.deepEqual(second, { ok: false, reason: 'already_exists' });
      assert.equal(await readFile(skillFile, 'utf8'), before);
    });
  });

  it('rejects unknown and unsafe skill ids', async () => {
    await withWorkspace(async (workspaceRoot) => {
      assert.deepEqual(await installBundledSkill(workspaceRoot, 'no-such-skill'), { ok: false, reason: 'not_found' });
      assert.deepEqual(await installBundledSkill(workspaceRoot, '../evil'), { ok: false, reason: 'not_found' });
      assert.deepEqual(await listInstalledSkills(workspaceRoot), []);
    });
  });

  it('keeps the generated catalog module in sync with the reviewable sources', async () => {
    const genUrl = new URL('../../../scripts/gen-bundled-skill-catalog.mjs', import.meta.url);
    const gen = await import(genUrl.href);
    const fromDisk = gen.readBundledSkillSources();
    assert.deepEqual(
      fromDisk,
      BUNDLED_SKILL_CATALOG,
      'resources/bundled-skills is out of sync with Runtime bundled-skill-catalog.generated.ts — run: node scripts/gen-bundled-skill-catalog.mjs',
    );
  });
});
