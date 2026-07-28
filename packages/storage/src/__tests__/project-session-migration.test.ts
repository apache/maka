import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CreateSessionInput } from '@maka/core';
import { createProjectCatalog } from '../project-catalog.js';
import { migrateSessionProjects } from '../project-session-migration.js';
import { createLegacyFileSessionStore, createSessionStore } from '../session-store.js';
import { createGitRepositoryWithWorktree } from './fixtures/git-repository.js';

test('migrates legacy sessions into stable projects once without losing missing paths', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-session-migration-'));
  const repository = join(base, 'repository');
  const linkedWorktree = join(base, 'linked');
  const missingPath = join(base, 'moved-project');
  const storage = join(base, 'storage');
  await createGitRepositoryWithWorktree(repository, linkedWorktree, 'migration-linked');

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

    assert.deepEqual(first, { migrated: 3, unchanged: 0, failed: 0 });
    const mainHeader = await sessions.readHeaderSnapshot(main.id);
    const linkedHeader = await sessions.readHeaderSnapshot(linked.id);
    const missingHeader = await sessions.readHeaderSnapshot(missing.id);
    assert.equal(mainHeader.projectId, linkedHeader.projectId);
    assert.notEqual(missingHeader.projectId, mainHeader.projectId);
    const projectsById = new Map(
      (await catalog.list()).map((project) => [
        project.id,
        { available: project.available, locations: project.locations.length },
      ]),
    );
    assert.deepEqual(projectsById.get(mainHeader.projectId!), {
      available: true,
      locations: 2,
    });
    assert.deepEqual(projectsById.get(missingHeader.projectId!), {
      available: false,
      locations: 1,
    });

    assert.deepEqual(await migrateSessionProjects({ sessions, catalog }), {
      migrated: 0,
      unchanged: 3,
      failed: 0,
    });
    assert.equal((await catalog.list()).length, 2);
  } finally {
    await sessions.close?.();
    await rm(base, { recursive: true, force: true });
  }
});

test('migrates SQLite session headers without reading corrupt transcript bodies', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-session-sqlite-migration-'));
  const project = join(base, 'project');
  const storage = join(base, 'storage');
  await mkdir(project);
  const sessions = createSessionStore(storage);
  const catalog = createProjectCatalog(storage, {
    createId: () => 'project-1',
  });

  try {
    const session = await sessions.create(makeInput(project, 'Corrupt transcript'));
    await appendFile(
      join(storage, 'sessions', session.id, 'session.jsonl'),
      '{"type":"user","broken"\n',
      'utf8',
    );

    assert.deepEqual(await migrateSessionProjects({ sessions, catalog }), {
      migrated: 1,
      unchanged: 0,
      failed: 0,
    });
    assert.equal((await sessions.readHeaderSnapshot(session.id)).projectId, 'project-1');
  } finally {
    await sessions.close?.();
    await rm(base, { recursive: true, force: true });
  }
});

test('preserves session recency when building the project catalog', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-session-recency-'));
  const alpha = join(base, 'alpha');
  const beta = join(base, 'beta');
  const storage = join(base, 'storage');
  await Promise.all([mkdir(alpha), mkdir(beta)]);
  const sessions = createSessionStore(storage);
  let id = 0;
  const catalog = createProjectCatalog(storage, {
    now: () => 999,
    createId: () => `project-${++id}`,
  });

  try {
    const alphaOlder = await sessions.create(makeInput(alpha, 'Alpha older'));
    const betaOnly = await sessions.create(makeInput(beta, 'Beta'));
    const alphaNewest = await sessions.create(makeInput(alpha, 'Alpha newest'));
    await sessions.updateHeader(alphaOlder.id, { lastUsedAt: 100, lastMessageAt: 100 });
    await sessions.updateHeader(betaOnly.id, { lastUsedAt: 200, lastMessageAt: 200 });
    await sessions.updateHeader(alphaNewest.id, { lastUsedAt: 300, lastMessageAt: 300 });

    await migrateSessionProjects({ sessions, catalog });

    assert.deepEqual(
      (await catalog.list()).map((project) => project.name),
      ['alpha', 'beta'],
    );
  } finally {
    await sessions.close?.();
    await rm(base, { recursive: true, force: true });
  }
});

test('does not migrate an explicit no-project session after SQLite reopen', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-session-no-project-'));
  const project = join(base, 'project');
  const storage = join(base, 'storage');
  await mkdir(project);
  const sessions = createSessionStore(storage);
  const created = await sessions.create({
    ...makeInput(project, 'No project'),
    projectId: null,
  });
  await sessions.close?.();

  const reopened = createSessionStore(storage);
  const catalog = createProjectCatalog(storage, {
    createId: () => 'project-1',
  });
  try {
    assert.deepEqual(await migrateSessionProjects({ sessions: reopened, catalog }), {
      migrated: 0,
      unchanged: 1,
      failed: 0,
    });
    assert.equal((await reopened.readHeaderSnapshot(created.id)).projectId, null);
    assert.deepEqual(await catalog.list(), []);
  } finally {
    await reopened.close?.();
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
