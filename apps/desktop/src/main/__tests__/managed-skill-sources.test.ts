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

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  importManagedSkillSource,
  listManagedSkillSources,
  readManagedSkillSource,
  resolveManagedSkillSourcesRoot,
} from '../managed-skill-sources.js';

describe('managed skill sources', () => {
  it('resolves the global source cache under .maka without making it a runtime path', () => {
    assert.equal(resolveManagedSkillSourcesRoot('C:\\Users\\Ada'), join('C:\\Users\\Ada', '.maka', 'skill-sources'));
  });

  it('imports a local SKILL.md into a managed source cache', async () => {
    await withTempRoot(async (root) => {
      const sourceDir = join(root, 'incoming', 'research-brief');
      await mkdir(sourceDir, { recursive: true });
      const sourceFile = join(sourceDir, 'SKILL.md');
      const sourceText = `---
name: Research Brief
description: Summarize research notes.
allowed-tools: [Read]
---
# Research Brief
Use concise bullets.`;
      await writeFile(sourceFile, sourceText, 'utf8');

      const cacheRoot = join(root, 'cache');
      const result = await importManagedSkillSource({ root: cacheRoot, sourceFile });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.source.id, 'research-brief');
      assert.equal(result.source.name, 'Research Brief');
      assert.equal(result.source.description, 'Summarize research notes.');
      assert.equal(result.source.sourceType, 'local');
      assert.match(result.source.contentSha256, /^sha256:[a-f0-9]{64}$/);
      assert.equal(result.source.sourcePath, join(cacheRoot, 'research-brief', 'SKILL.md'));

      assert.equal(await readFile(join(cacheRoot, 'research-brief', 'SKILL.md'), 'utf8'), sourceText);

      const listed = await listManagedSkillSources(cacheRoot);
      assert.deepEqual(listed.map((source) => source.id), ['research-brief']);
      assert.equal(listed[0].contentSha256, result.source.contentSha256);

      const read = await readManagedSkillSource(cacheRoot, 'research-brief');
      assert.equal(read.ok, true);
      if (!read.ok) return;
      assert.equal(read.source.id, 'research-brief');
      assert.equal(read.content, sourceText);
    });
  });

  it('lists managed sources from the real SKILL.md instead of stale registry metadata', async () => {
    await withTempRoot(async (root) => {
      const sourceDir = join(root, 'incoming', 'research-brief');
      await mkdir(sourceDir, { recursive: true });
      const sourceFile = join(sourceDir, 'SKILL.md');
      await writeFile(sourceFile, `---
name: Research Brief
description: Summarize research notes.
---
# Research Brief`, 'utf8');

      const cacheRoot = join(root, 'cache');
      const imported = await importManagedSkillSource({ root: cacheRoot, sourceFile });
      assert.equal(imported.ok, true);

      await writeFile(join(cacheRoot, 'registry.json'), JSON.stringify({
        schemaVersion: 1,
        sources: [{
          id: 'research-brief',
          name: 'Stale Registry Name',
          description: 'Stale registry description.',
          sourceType: 'local',
          sourcePath: join(cacheRoot, 'research-brief', 'SKILL.md'),
          contentSha256: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        }],
      }), 'utf8');
      await writeFile(join(cacheRoot, 'research-brief', 'source.json'), JSON.stringify({
        id: 'research-brief',
        name: 'Stale Source Json Name',
      }), 'utf8');
      await writeFile(join(cacheRoot, 'research-brief', 'SKILL.md'), `---
name: Updated Source Name
description: Updated source description.
---
# Updated Source`, 'utf8');

      const listed = await listManagedSkillSources(cacheRoot);
      assert.equal(listed.length, 1);
      assert.equal(listed[0].name, 'Updated Source Name');
      assert.equal(listed[0].description, 'Updated source description.');

      await rm(join(cacheRoot, 'registry.json'), { force: true });
      const listedWithoutRegistry = await listManagedSkillSources(cacheRoot);
      assert.deepEqual(listedWithoutRegistry.map((source) => source.id), ['research-brief']);
    });
  });

  it('keeps readable managed sources when one source fails to read', async () => {
    if (process.platform === 'win32') return;
    await withTempRoot(async (root) => {
      const cacheRoot = join(root, 'cache');
      const readableDir = join(cacheRoot, 'readable');
      const unreadableDir = join(cacheRoot, 'unreadable');
      await mkdir(readableDir, { recursive: true });
      await mkdir(unreadableDir);
      await writeFile(
        join(readableDir, 'SKILL.md'),
        '---\nname: Readable\ndescription: Remains visible.\n---\n# Readable',
        'utf8',
      );
      await writeFile(
        join(unreadableDir, 'SKILL.md'),
        '---\nname: Unreadable\ndescription: Cannot be read.\n---\n# Unreadable',
        'utf8',
      );

      await chmod(unreadableDir, 0o000);
      try {
        const listed = await listManagedSkillSources(cacheRoot);
        assert.deepEqual(listed.map((source) => source.id), ['readable']);
      } finally {
        await chmod(unreadableDir, 0o700);
      }
    });
  });

  it('rejects symlinked managed source cache roots before writing', async () => {
    await withTempRoot(async (root) => {
      const sourceDir = join(root, 'incoming', 'deck-helper');
      await mkdir(sourceDir, { recursive: true });
      const sourceFile = join(sourceDir, 'SKILL.md');
      await writeFile(sourceFile, `---
name: Deck Helper
description: Build decks.
---
# Deck Helper`, 'utf8');

      const outside = join(root, 'outside-cache-target');
      const cacheRoot = join(root, 'cache-link');
      await mkdir(outside);
      await symlink(outside, cacheRoot);

      assert.deepEqual(await importManagedSkillSource({ root: cacheRoot, sourceFile }), {
        ok: false,
        reason: 'blocked_path',
      });
      assert.deepEqual(await listManagedSkillSources(cacheRoot), []);
      await assert.rejects(readFile(join(outside, 'deck-helper', 'SKILL.md'), 'utf8'));
    });
  });

  it('rejects invalid or duplicate managed sources', async () => {
    await withTempRoot(async (root) => {
      const cacheRoot = join(root, 'cache');
      const invalid = join(root, 'not-a-skill.md');
      await writeFile(invalid, '# Missing front matter name', 'utf8');

      assert.deepEqual(await importManagedSkillSource({ root: cacheRoot, sourceFile: invalid }), {
        ok: false,
        reason: 'invalid_skill',
        diagnostics: [{
          code: 'missing_frontmatter',
          severity: 'error',
          field: 'frontmatter',
          message: 'SKILL.md must start with a YAML frontmatter block.',
        }],
      });

      const missingDescriptionDir = join(root, 'incoming', 'missing-description');
      await mkdir(missingDescriptionDir, { recursive: true });
      const missingDescription = join(missingDescriptionDir, 'SKILL.md');
      await writeFile(missingDescription, `---
name: Missing Description
---
# Missing Description`, 'utf8');
      const rejected = await importManagedSkillSource({ root: cacheRoot, sourceFile: missingDescription });
      assert.equal(rejected.ok, false);
      if (rejected.ok) return;
      assert.equal(rejected.reason, 'invalid_skill');
      assert.deepEqual(rejected.diagnostics?.map((issue) => issue.code), ['missing_description']);

      const sourceDir = join(root, 'incoming', 'deck-helper');
      await mkdir(sourceDir, { recursive: true });
      const sourceFile = join(sourceDir, 'SKILL.md');
      await writeFile(sourceFile, `---
name: Deck Helper
description: Build decks.
---
# Deck Helper`, 'utf8');

      const first = await importManagedSkillSource({ root: cacheRoot, sourceFile });
      assert.equal(first.ok, true);
      assert.deepEqual(await importManagedSkillSource({ root: cacheRoot, sourceFile }), {
        ok: false,
        reason: 'already_exists',
      });
    });
  });
});

async function withTempRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-managed-sources-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
