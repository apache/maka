import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createProjectCatalog } from '../project-catalog.js';
import { backfillSessionProjects } from '../project-session-backfill.js';
import { createSessionStore } from '../session-store.js';

function sessionInput(cwd: string) {
  return {
    cwd,
    backend: 'fake' as const,
    llmConnectionSlug: 'fixture',
    model: 'fixture-model',
    permissionMode: 'execute' as const,
  };
}

async function withWorkspace(
  run: (context: {
    sessions: ReturnType<typeof createSessionStore>;
    catalog: ReturnType<typeof createProjectCatalog>;
    projectPath: string;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-project-backfill-'));
  const projectPath = await mkdtemp(join(tmpdir(), 'maka-project-backfill-cwd-'));
  const workspace = join(root, 'workspace');
  const sessions = createSessionStore(workspace);
  const catalog = createProjectCatalog(workspace);
  try {
    await run({ sessions, catalog, projectPath });
  } finally {
    await sessions.close?.();
    await rm(root, { recursive: true, force: true });
    await rm(projectPath, { recursive: true, force: true });
  }
}

test('a session that never resolved a project is grouped by its working directory', async () => {
  await withWorkspace(async ({ sessions, catalog, projectPath }) => {
    const session = await sessions.create({
      ...sessionInput(projectPath),
      name: 'session without a project',
    });
    assert.equal(
      (await sessions.readHeaderSnapshot(session.id)).projectId,
      undefined,
      'precondition: the session starts with no resolved project',
    );

    const result = await backfillSessionProjects({ sessions, catalog });

    assert.deepEqual(result, { resolved: 1, failed: 0 });
    const projects = await catalog.list();
    assert.equal(projects.length, 1);
    assert.equal(
      (await sessions.readHeaderSnapshot(session.id)).projectId,
      projects[0]!.id,
      'the session must join the project derived from its cwd',
    );
  });
});

test('a session detached from every project keeps that choice', async () => {
  await withWorkspace(async ({ sessions, catalog, projectPath }) => {
    const session = await sessions.create({
      ...sessionInput(projectPath),
      name: 'session with no project by choice',
      projectId: null,
    });

    const result = await backfillSessionProjects({ sessions, catalog });

    assert.deepEqual(result, { resolved: 0, failed: 0 });
    assert.equal(
      (await sessions.readHeaderSnapshot(session.id)).projectId,
      null,
      'an explicit "no project" is a user decision, not missing data',
    );
    assert.deepEqual(await catalog.list(), []);
  });
});

test('a session whose directory is gone still resolves to a stable project', async () => {
  await withWorkspace(async ({ sessions, catalog, projectPath }) => {
    const session = await sessions.create({
      ...sessionInput(projectPath),
      name: 'session in a deleted folder',
    });
    await rm(projectPath, { recursive: true, force: true });

    const result = await backfillSessionProjects({ sessions, catalog });

    assert.deepEqual(result, { resolved: 1, failed: 0 });
    const projects = await catalog.list();
    assert.equal(projects.length, 1);
    assert.equal(projects[0]!.available, false, 'the project exists but its directory does not');
    assert.equal((await sessions.readHeaderSnapshot(session.id)).projectId, projects[0]!.id);
  });
});

test('backfill is idempotent and leaves resolved sessions untouched', async () => {
  await withWorkspace(async ({ sessions, catalog, projectPath }) => {
    await sessions.create({ ...sessionInput(projectPath), name: 'session' });

    const first = await backfillSessionProjects({ sessions, catalog });
    const second = await backfillSessionProjects({ sessions, catalog });

    assert.deepEqual(first, { resolved: 1, failed: 0 });
    assert.deepEqual(second, { resolved: 0, failed: 0 }, 'a second start finds nothing to do');
    assert.equal((await catalog.list()).length, 1, 'no duplicate project is created');
  });
});
