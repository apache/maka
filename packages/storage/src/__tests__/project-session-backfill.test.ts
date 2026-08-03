import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { createProjectCatalog } from '../project-catalog.js';
import { backfillSessionProjects } from '../project-session-backfill.js';
import { createSessionStore } from '../session-store.js';

const execFileAsync = promisify(execFile);

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
    base: string;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-project-backfill-'));
  const projectPath = await mkdtemp(join(tmpdir(), 'maka-project-backfill-cwd-'));
  const workspace = join(root, 'workspace');
  const sessions = createSessionStore(workspace);
  const catalog = createProjectCatalog(workspace);
  try {
    await run({ sessions, catalog, projectPath, base: root });
  } finally {
    await sessions.close?.();
    catalog.close();
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

    assert.deepEqual(result, { resolved: 1, failures: [] });
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

    assert.deepEqual(result, { resolved: 0, failures: [] });
    assert.equal(
      (await sessions.readHeaderSnapshot(session.id)).projectId,
      null,
      'an explicit "no project" is a user decision, not missing data',
    );
    assert.deepEqual(await catalog.list(), []);
  });
});

test('a deleted directory resolves to the same project it had while it existed', async () => {
  await withWorkspace(async ({ sessions, catalog, projectPath }) => {
    const before = await catalog.register(projectPath);
    const session = await sessions.create({
      ...sessionInput(projectPath),
      name: 'session in a deleted folder',
    });
    await rm(projectPath, { recursive: true, force: true });

    const result = await backfillSessionProjects({ sessions, catalog });

    assert.deepEqual(result, { resolved: 1, failures: [] });
    const projects = await catalog.list();
    // On macOS the temp root is a symlink, so a path canonicalized without
    // realpath would mint a second project for the very same directory.
    assert.equal(projects.length, 1, 'the vanished directory must not mint a second project');
    assert.equal(projects[0]!.id, before.id);
    assert.equal(projects[0]!.available, false, 'the project exists but its directory does not');
    assert.equal((await sessions.readHeaderSnapshot(session.id)).projectId, before.id);
  });
});

test('backfill is idempotent and leaves resolved sessions untouched', async () => {
  await withWorkspace(async ({ sessions, catalog, projectPath }) => {
    await sessions.create({ ...sessionInput(projectPath), name: 'session' });

    const first = await backfillSessionProjects({ sessions, catalog });
    const second = await backfillSessionProjects({ sessions, catalog });

    assert.deepEqual(first, { resolved: 1, failures: [] });
    assert.deepEqual(second, { resolved: 0, failures: [] }, 'a second start finds nothing to do');
    assert.equal((await catalog.list()).length, 1, 'no duplicate project is created');
  });
});

test('projects are ordered by when their sessions were last active, not by upgrade order', async () => {
  await withWorkspace(async ({ sessions, catalog, base }) => {
    const older = join(base, 'older-project');
    const newer = join(base, 'newer-project');
    await mkdir(older);
    await mkdir(newer);
    // Names chosen so session-id order cannot accidentally produce the
    // expected result: recency has to come from the sessions' own timestamps.
    const olderSession = await sessions.create({ ...sessionInput(older), name: 'older' });
    const newerSession = await sessions.create({ ...sessionInput(newer), name: 'newer' });
    await sessions.updateHeader(olderSession.id, { lastMessageAt: 1_000 });
    await sessions.updateHeader(newerSession.id, { lastMessageAt: 9_000 });

    await backfillSessionProjects({ sessions, catalog });

    assert.deepEqual(
      (await catalog.list()).map((project) => project.name),
      ['newer-project', 'older-project'],
      'an upgrade must rebuild the real recency order, not flatten it to "now"',
    );
  });
});

test('a subagent worktree never becomes one of the user project locations', async () => {
  await withWorkspace(async ({ sessions, catalog, base }) => {
    const repository = join(base, 'repository');
    const worktree = join(base, 'subagent-worktree');
    await mkdir(repository);
    await execFileAsync('git', ['init', '--quiet', '-b', 'main'], { cwd: repository });
    await execFileAsync('git', ['commit', '--quiet', '--allow-empty', '-m', 'root'], {
      cwd: repository,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'maka',
        GIT_AUTHOR_EMAIL: 'maka@example.com',
        GIT_COMMITTER_NAME: 'maka',
        GIT_COMMITTER_EMAIL: 'maka@example.com',
      },
    });
    await execFileAsync('git', ['worktree', 'add', '--quiet', worktree, '-b', 'child'], {
      cwd: repository,
    });
    const parent = await sessions.create({ ...sessionInput(repository), name: 'parent' });
    await sessions.create({
      ...sessionInput(worktree),
      name: 'subagent',
      subagentParent: {
        kind: 'subagent' as const,
        lifecycle: 'foreground' as const,
        parentSessionId: parent.id,
        spawnedBy: { parentRunId: 'run-1', parentTurnId: 'turn-1', toolCallId: 'call-1' },
      },
    });

    const result = await backfillSessionProjects({ sessions, catalog });

    // The child inherits its parent's project when spawned; its scratch
    // worktree is disposable and must never outrank the real checkout.
    assert.deepEqual(result, { resolved: 1, failures: [] });
    const projects = await catalog.list();
    assert.equal(projects.length, 1);
    assert.deepEqual(
      projects[0]!.locations.map((location) => location.path),
      [await realpath(repository)],
      'a subagent scratch worktree is not a place the user works',
    );
    assert.equal(projects[0]!.preferredPath, await realpath(repository));
  });
});

test('a session detached while resolution is running keeps the user decision', async () => {
  await withWorkspace(async ({ sessions, catalog, projectPath }) => {
    const session = await sessions.create({ ...sessionInput(projectPath), name: 'session' });

    const result = await backfillSessionProjects({
      sessions,
      catalog: {
        // Resolution is where the real work — a git probe — happens, so this is
        // exactly the window in which a user can still act on the session.
        resolveHistoricalPath: async (path, usedAt) => {
          await sessions.updateHeader(session.id, { projectId: null });
          return catalog.resolveHistoricalPath(path, usedAt);
        },
      },
    });

    assert.deepEqual(result, { resolved: 0, failures: [] });
    assert.equal(
      (await sessions.readHeaderSnapshot(session.id)).projectId,
      null,
      'a detach made after the plan was formed must still win',
    );
  });
});

test('a working directory reachable through a replaced ancestor still resolves', async () => {
  await withWorkspace(async ({ sessions, catalog, base }) => {
    const ancestor = join(base, 'ancestor');
    const cwd = join(ancestor, 'project');
    await mkdir(cwd, { recursive: true });
    const before = await catalog.register(cwd);
    const session = await sessions.create({ ...sessionInput(cwd), name: 'session' });
    // The directory is gone and something else now occupies its parent, so
    // walking up reports ENOTDIR rather than ENOENT.
    await rm(ancestor, { recursive: true, force: true });
    await writeFile(ancestor, 'not a directory', 'utf8');

    const result = await backfillSessionProjects({ sessions, catalog });

    assert.deepEqual(result, { resolved: 1, failures: [] });
    assert.equal(
      (await sessions.readHeaderSnapshot(session.id)).projectId,
      before.id,
      'a replaced ancestor must not strand the session outside its project',
    );
  });
});

test('a working directory that cannot be resolved is reported instead of guessed', async () => {
  await withWorkspace(async ({ sessions, projectPath }) => {
    const session = await sessions.create({ ...sessionInput(projectPath), name: 'session' });

    const result = await backfillSessionProjects({
      sessions,
      catalog: {
        resolveHistoricalPath: () => Promise.reject(new Error('git exploded')),
      },
    });

    assert.deepEqual(result, {
      resolved: 0,
      failures: [{ cwd: projectPath, reason: 'git exploded' }],
    });
    assert.equal(
      (await sessions.readHeaderSnapshot(session.id)).projectId,
      undefined,
      'an unresolved session stays unresolved so the next start can retry',
    );
  });
});
