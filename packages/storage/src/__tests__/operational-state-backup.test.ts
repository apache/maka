import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSqliteArtifactStore } from '../artifact-store.js';
import { createProjectCatalog } from '../project-catalog.js';
import { createSessionStore } from '../session-store.js';
import {
  createOperationalStateBackup,
  OperationalBackupError,
  restoreOperationalStateBackup,
  validateOperationalStateBackup,
} from '../operational-state-backup.js';

test('backs up and restores runtime.sqlite plus artifact bytes', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-operational-backup-'));
  const stateRoot = join(base, 'state');
  const backupRoot = join(base, 'backup');
  const restoreRoot = join(base, 'restore');
  const projectPath = join(base, 'project');
  await mkdir(projectPath);
  const sessions = createSessionStore(stateRoot);
  try {
    // The project catalog decides how every session is grouped, and its name,
    // relink aliases and archive state exist nowhere else. Restoring sessions
    // without it would silently reorganize the user's whole sidebar.
    const catalog = createProjectCatalog(stateRoot, { now: () => 5 });
    const project = await catalog.register(projectPath);
    await catalog.rename(project.id, 'Renamed Project');
    await catalog.archive(project.id);
    catalog.close();

    const session = await sessions.create({
      projectId: project.id,
      cwd: '/tmp/cwd',
      backend: 'fake',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
      name: 'Backup',
      labels: [],
    });
    const message = {
      type: 'user',
      id: 'message-1',
      turnId: 'turn-1',
      ts: 1,
      text: 'durable'.repeat(12_000),
    } as const;
    await sessions.appendMessage(session.id, message);
    await sessions.close?.();
    const artifacts = createSqliteArtifactStore(stateRoot);
    const artifact = await artifacts.create({
      id: 'artifact-1',
      sessionId: session.id,
      turnId: 'turn-1',
      name: 'note.txt',
      kind: 'file',
      content: 'artifact',
      source: 'fixture',
      now: 2,
    });
    artifacts.close?.();

    await createOperationalStateBackup({ stateRoot, destinationRoot: backupRoot, now: () => 10 });
    assert.equal((await validateOperationalStateBackup(backupRoot)).createdAt, 10);
    await restoreOperationalStateBackup({ backupRoot, destinationRoot: restoreRoot });

    const restored = createSessionStore(restoreRoot);
    const restoredCatalog = createProjectCatalog(restoreRoot);
    try {
      assert.deepEqual(await restored.readMessages(session.id), [message]);
      assert.equal(
        await readFile(join(restoreRoot, 'artifacts', artifact.relativePath), 'utf8'),
        'artifact',
      );
      assert.equal(
        (await restored.readHeaderSnapshot(session.id)).projectId,
        project.id,
        'a restored session still belongs to the project it was grouped under',
      );
      assert.deepEqual(await restoredCatalog.list(), [
        {
          id: project.id,
          name: 'Renamed Project',
          locations: [{ path: await realpath(projectPath), isWorktree: false }],
          archivedAt: 5,
          available: true,
          preferredPath: await realpath(projectPath),
        },
      ]);
    } finally {
      await restored.close?.();
      restoredCatalog.close();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('rejects a backup whose SQLite Artifact metadata has no matching payload', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-operational-backup-artifact-'));
  const stateRoot = join(base, 'state');
  try {
    const artifacts = createSqliteArtifactStore(stateRoot);
    const artifact = await artifacts.create({
      id: 'artifact-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      name: 'note.txt',
      kind: 'file',
      content: 'artifact',
      source: 'fixture',
      now: 2,
    });
    artifacts.close?.();
    await rm(join(stateRoot, 'artifacts', artifact.relativePath));

    await assert.rejects(
      createOperationalStateBackup({
        stateRoot,
        destinationRoot: join(base, 'backup'),
        now: () => 10,
      }),
      (error: unknown) =>
        error instanceof OperationalBackupError &&
        error.code === 'corrupt_backup' &&
        /artifact payload/i.test(error.message),
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
