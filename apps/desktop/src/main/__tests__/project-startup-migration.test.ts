import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createProjectCatalog, createSessionStore } from '@maka/storage';
import { runProjectStartupMigration } from '../project-startup-migration.js';

test('startup project migration notifies the renderer after changing session associations', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-startup-migration-'));
  const cwd = join(base, 'legacy-project');
  const storage = join(base, 'storage');
  await mkdir(cwd);
  const sessions = createSessionStore(storage);
  const catalog = createProjectCatalog(storage, {
    createId: () => 'project-1',
  });
  const changes: string[] = [];

  try {
    const session = await sessions.create({
      cwd,
      backend: 'fake',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
      name: 'Legacy session',
      labels: [],
    });

    await runProjectStartupMigration({
      sessions,
      catalog,
      emitSessionsChanged: (reason) => changes.push(reason),
      logError: () => {},
    });

    assert.deepEqual(changes, ['migrated']);
    assert.equal((await sessions.readHeaderSnapshot(session.id)).projectId, 'project-1');
  } finally {
    await sessions.close?.();
    await rm(base, { recursive: true, force: true });
  }
});
