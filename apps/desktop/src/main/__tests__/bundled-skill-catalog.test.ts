import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BUNDLED_SKILL_CATALOG,
  MANAGED_SKILL_CATEGORIES,
} from '@maka/runtime';
import {
  ensureBundledSkillInstalled,
  installBundledSkill,
  listBundledSkillCatalog,
  listInstalledSkills,
  loadSkillInstructions,
  parseSkillFrontMatter,
} from '../skills.js';

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
  it('ships the built-in skills as an install-on-demand catalog', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const catalog = await listBundledSkillCatalog(workspaceRoot);
      assert.equal(catalog.length, EXPECTED_COUNT);

      const ids = new Set(catalog.map((entry) => entry.id));
      assert.ok(ids.has('computer-use'));
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

  it('ships Computer Use guidance only on a host that binds maka_computer', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const installed = await installBundledSkill(workspaceRoot, 'computer-use');
      assert.equal(installed.ok, true);
      if (!installed.ok) return;

      const skillFile = join(workspaceRoot, 'skills', 'computer-use', 'SKILL.md');
      const body = await readFile(skillFile, 'utf8');
      const metadata = parseSkillFrontMatter(body);
      assert.equal(metadata.name, 'Computer Use');
      assert.match(metadata.description ?? '', /local desktop application UI/);
      assert.deepEqual(metadata.allowedTools, ['load_tools', 'maka_computer']);
      assert.deepEqual(metadata.requiredTools, ['maka_computer']);
      assert.equal(
        /[\u3400-\u9fff]/u.test(body.replace(/^category:.*$/m, '')),
        false,
        'model-facing Computer Use guidance must remain English',
      );

      const visualHost = {
        toolNames: new Set(['load_tools', 'maka_computer']),
      };
      const loaded = await loadSkillInstructions(workspaceRoot, 'computer-use', visualHost);
      assert.equal(loaded.ok, true);
      if (!loaded.ok) return;
      assert.match(loaded.skill.instructions, /group.*computer_use/);
      assert.match(loaded.skill.instructions, /outcome_unknown/);
      assert.match(loaded.skill.instructions, /include_screenshot/);
      assert.match(loaded.skill.instructions, /element_sequence/);
      assert.match(loaded.skill.instructions, /standalone step/);
      assert.match(loaded.skill.instructions, /optional `app` filter/);
      assert.match(loaded.skill.instructions, /compatibility input dispatch disabled/);
      assert.match(loaded.skill.instructions, /metadata_read/);
      assert.doesNotMatch(loaded.skill.instructions, /snapshot_spent|window_gone/);

      const hidden = await loadSkillInstructions(workspaceRoot, 'computer-use', {
        toolNames: new Set(['load_tools']),
      });
      assert.equal(hidden.ok, false);
      if (hidden.ok) return;
      assert.equal(hidden.reason, 'host_incompatible');
    });
  });

  it('auto-seeds a trusted Computer Use Skill idempotently', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const first = await ensureBundledSkillInstalled(workspaceRoot, 'computer-use');
      assert.equal(first.ok, true);
      if (!first.ok) return;
      assert.equal(first.action, 'installed');
      assert.equal(first.skill.sourceType, 'bundled');
      assert.equal(first.skill.validationStatus, 'ok');

      const second = await ensureBundledSkillInstalled(workspaceRoot, 'computer-use');
      assert.equal(second.ok, true);
      if (!second.ok) return;
      assert.equal(second.action, 'already_installed');
      assert.equal(second.skill.contentSha256, first.skill.contentSha256);

      const installed = await listInstalledSkills(workspaceRoot);
      assert.deepEqual(installed.map((skill) => skill.id), ['computer-use']);
    });
  });

  it('does not overwrite an untrusted workspace copy during automatic seeding', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const skillDir = join(workspaceRoot, 'skills', 'computer-use');
      await mkdir(skillDir, { recursive: true });
      const custom = `---
name: Computer Use
description: A local override that must not be replaced.
---
Do something else.
`;
      const skillFile = join(skillDir, 'SKILL.md');
      await writeFile(skillFile, custom, 'utf8');

      assert.deepEqual(await ensureBundledSkillInstalled(workspaceRoot, 'computer-use'), {
        ok: false,
        reason: 'existing_untrusted',
      });
      assert.equal(await readFile(skillFile, 'utf8'), custom);
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
