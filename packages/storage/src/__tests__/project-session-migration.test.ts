import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import type { CreateSessionInput } from '@maka/core';
import { createProjectCatalog } from '../project-catalog.js';
import { migrateSessionProjects } from '../project-session-migration.js';
import { createLegacyFileSessionStore } from '../session-store.js';

const execFileAsync = promisify(execFile);

test('migrates legacy sessions into stable projects once without losing missing paths', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-session-migration-'));
  const repository = join(base, 'repository');
  const linkedWorktree = join(base, 'linked');
  const missingPath = join(base, 'moved-project');
  const storage = join(base, 'storage');
  await mkdir(repository);
  await execFileAsync('git', ['init', '--quiet'], { cwd: repository });
  await writeFile(join(repository, 'tracked.txt'), 'tracked\n', 'utf8');
  await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repository });
  await execFileAsync(
    'git',
    [
      '-c',
      'user.name=Maka Test',
      '-c',
      'user.email=test@maka.invalid',
      'commit',
      '--quiet',
      '-m',
      'init',
    ],
    { cwd: repository },
  );
  await execFileAsync(
    'git',
    ['worktree', 'add', '--quiet', '-b', 'migration-linked', linkedWorktree],
    { cwd: repository },
  );

  const sessions = createLegacyFileSessionStore(storage);
  let id = 0;
  const catalog = createProjectCatalog(storage, {
    now: () => 1_000,
    createId: () => `project-${++id}`,
  });

  try {
    const main = await sessions.create(makeInput(repository, 'Main checkout'));
    const linked = await sessions.create(makeInput(linkedWorktree, 'Linked worktree'));
    const missing = await sessions.create(makeInput(missingPath, 'Missing checkout'));

    const first = await migrateSessionProjects({ sessions, catalog });

    assert.deepEqual(first, { migrated: 3, unchanged: 0 });
    const mainHeader = await sessions.readHeaderSnapshot(main.id);
    const linkedHeader = await sessions.readHeaderSnapshot(linked.id);
    const missingHeader = await sessions.readHeaderSnapshot(missing.id);
    assert.equal(mainHeader.projectId, linkedHeader.projectId);
    assert.notEqual(missingHeader.projectId, mainHeader.projectId);
    assert.deepEqual(
      (await catalog.list()).map((project) => ({
        id: project.id,
        available: project.available,
        locations: project.locations.length,
      })),
      [
        { id: mainHeader.projectId, available: true, locations: 2 },
        { id: missingHeader.projectId, available: false, locations: 1 },
      ],
    );

    assert.deepEqual(await migrateSessionProjects({ sessions, catalog }), {
      migrated: 0,
      unchanged: 3,
    });
    assert.equal((await catalog.list()).length, 2);
  } finally {
    await sessions.close?.();
    await rm(base, { recursive: true, force: true });
  }
});

function makeInput(cwd: string, name: string): CreateSessionInput {
  return {
    cwd,
    backend: 'fake',
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask',
    name,
    labels: [],
  };
}
