import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  createOperationalStateBackup,
  OPERATIONAL_BACKUP_MANIFEST_FILE,
  type OperationalBackupError,
  restoreOperationalStateBackup,
  validateOperationalStateBackup,
} from '../operational-state-backup.js';
import { createSqliteArtifactStore } from '../artifact-store.js';
import { createSessionStore } from '../session-store.js';

test('backs up live WAL state and restores a writable relational closure', async () => {
  await withBackupRoots(async ({ stateRoot, backupRoot, restoreRoot }) => {
    const sessions = createSessionStore(stateRoot);
    const artifacts = createSqliteArtifactStore(stateRoot);
    try {
      const first = await sessions.create(sessionInput('First'));
      const second = await sessions.create(sessionInput('Second'));
      await sessions.appendMessage(first.id, {
        type: 'user',
        id: 'message-1',
        turnId: 'turn-1',
        ts: 10,
        text: 'first transcript',
      });
      await sessions.appendMessage(second.id, {
        type: 'user',
        id: 'message-2',
        turnId: 'turn-1',
        ts: 11,
        text: 'second transcript',
      });
      const firstArtifact = await artifacts.create({
        id: 'first-artifact',
        sessionId: first.id,
        turnId: 'turn-1',
        name: 'first.txt',
        kind: 'file',
        content: 'first payload\n',
        now: 10,
      });
      const secondArtifact = await artifacts.create({
        id: 'second-artifact',
        sessionId: second.id,
        turnId: 'turn-1',
        name: 'second.txt',
        kind: 'file',
        content: 'second payload\n',
        now: 11,
      });
      await writeFile(join(stateRoot, 'credentials.json'), 'secret-canary\n');
      await writeFile(join(stateRoot, 'settings.json'), 'settings-canary\n');

      const liveEntries = await readdir(stateRoot);
      assert.ok(liveEntries.includes('runtime.sqlite-wal'), liveEntries.join(', '));
      assert.ok(liveEntries.includes('runtime.sqlite-shm'), liveEntries.join(', '));

      const created = await createOperationalStateBackup({
        stateRoot,
        destinationRoot: backupRoot,
        now: () => 100,
      });
      assert.equal(created.createdAt, 100);
      assert.deepEqual(
        created.transcripts.map((entry) => entry.sessionId).sort(),
        [first.id, second.id].sort(),
      );
      assert.deepEqual(
        created.artifacts.map((entry) => entry.record.id).sort(),
        [firstArtifact.id, secondArtifact.id].sort(),
      );
      assert.equal((await validateOperationalStateBackup(backupRoot)).createdAt, 100);
      if (process.platform !== 'win32') {
        assert.equal((await stat(backupRoot)).mode & 0o777, 0o700);
        assert.equal((await stat(join(backupRoot, 'runtime.sqlite'))).mode & 0o777, 0o600);
        assert.equal(
          (await stat(join(backupRoot, created.artifacts[0]!.path))).mode & 0o777,
          0o600,
        );
      }
      await assert.rejects(lstat(join(backupRoot, 'credentials.json')), { code: 'ENOENT' });
      await assert.rejects(lstat(join(backupRoot, 'settings.json')), { code: 'ENOENT' });
      await assert.rejects(lstat(join(backupRoot, 'runtime.sqlite-wal')), { code: 'ENOENT' });
      await assert.rejects(lstat(join(backupRoot, 'runtime.sqlite-shm')), { code: 'ENOENT' });
      await assert.rejects(lstat(join(backupRoot, 'artifacts', 'metadata.jsonl')), {
        code: 'ENOENT',
      });

      await restoreOperationalStateBackup({ backupRoot, destinationRoot: restoreRoot });
      if (process.platform !== 'win32') {
        assert.equal((await stat(restoreRoot)).mode & 0o777, 0o700);
        assert.equal((await stat(join(restoreRoot, 'runtime.sqlite'))).mode & 0o777, 0o600);
      }
      await assert.rejects(lstat(join(restoreRoot, OPERATIONAL_BACKUP_MANIFEST_FILE)), {
        code: 'ENOENT',
      });
      const restoredSessions = createSessionStore(restoreRoot);
      const restoredArtifacts = createSqliteArtifactStore(restoreRoot);
      try {
        assert.deepEqual(
          (await restoredSessions.list()).map((session) => session.id).sort(),
          [first.id, second.id].sort(),
        );
        assert.match(
          await readFile(join(restoreRoot, 'sessions', first.id, 'session.jsonl'), 'utf8'),
          /first transcript/,
        );
        assert.deepEqual(await restoredArtifacts.list(first.id), [firstArtifact]);
        assert.deepEqual(await restoredArtifacts.list(second.id), [secondArtifact]);
        assert.deepEqual(await restoredArtifacts.readText(secondArtifact.id), {
          ok: true,
          text: 'second payload\n',
        });
        const continued = await restoredArtifacts.create({
          id: 'continued-write',
          sessionId: first.id,
          turnId: 'turn-2',
          name: 'continued.txt',
          kind: 'file',
          content: 'continued\n',
          now: 12,
        });
        assert.equal((await restoredArtifacts.get(continued.id))?.id, continued.id);
        await restoredSessions.appendMessage(first.id, {
          type: 'user',
          id: 'message-3',
          turnId: 'turn-2',
          ts: 12,
          text: 'continued transcript',
        });
      } finally {
        restoredArtifacts.close?.();
        await restoredSessions.close?.();
      }
    } finally {
      artifacts.close?.();
      await sessions.close?.();
    }
  });
});

test('linearizes an Artifact mutation after the backup snapshot', async () => {
  await withBackupRoots(async ({ stateRoot, backupRoot, restoreRoot }) => {
    const sessions = createSessionStore(stateRoot);
    const artifacts = createSqliteArtifactStore(stateRoot);
    let queuedMutation: Promise<unknown> | undefined;
    try {
      const session = await sessions.create(sessionInput('Selected'));
      await artifacts.create({
        id: 'seed',
        sessionId: session.id,
        turnId: 'turn-1',
        name: 'seed.txt',
        kind: 'file',
        content: 'seed\n',
        now: 1,
      });
      let mutationSettled = false;
      await createOperationalStateBackup({
        stateRoot,
        destinationRoot: backupRoot,
        failpoint: async (point) => {
          if (point !== 'after_database_snapshot') return;
          queuedMutation = artifacts
            .create({
              id: 'after-snapshot',
              sessionId: session.id,
              turnId: 'turn-2',
              name: 'after.txt',
              kind: 'file',
              content: 'after\n',
              now: 2,
            })
            .finally(() => {
              mutationSettled = true;
            });
          await delay(50);
          assert.equal(mutationSettled, false);
        },
      });
      await queuedMutation;

      await restoreOperationalStateBackup({ backupRoot, destinationRoot: restoreRoot });
      const restored = createSqliteArtifactStore(restoreRoot);
      try {
        assert.deepEqual(
          (await restored.list(session.id)).map((record) => record.id),
          ['seed'],
        );
      } finally {
        restored.close?.();
      }
      assert.deepEqual(
        (await artifacts.list(session.id)).map((record) => record.id),
        ['after-snapshot', 'seed'],
      );
    } finally {
      await queuedMutation?.catch(() => {});
      artifacts.close?.();
      await sessions.close?.();
    }
  });
});

test('fails the whole backup when a transcript changes across the SQLite snapshot', async () => {
  await withBackupRoots(async ({ stateRoot, backupRoot }) => {
    const sessions = createSessionStore(stateRoot);
    try {
      const session = await sessions.create(sessionInput('Selected'));
      await sessions.appendMessage(session.id, {
        type: 'user',
        id: 'message-1',
        turnId: 'turn-1',
        ts: 1,
        text: 'before snapshot',
      });

      await assertBackupError(
        createOperationalStateBackup({
          stateRoot,
          destinationRoot: backupRoot,
          failpoint: async (point) => {
            if (point !== 'after_database_snapshot') return;
            await sessions.appendMessage(session.id, {
              type: 'user',
              id: 'message-2',
              turnId: 'turn-2',
              ts: 2,
              text: 'after snapshot',
            });
          },
        }),
        'source_changed',
      );
      await assert.rejects(lstat(backupRoot), { code: 'ENOENT' });
    } finally {
      await sessions.close?.();
    }
  });
});

test('rejects a corrupt source transcript instead of preserving unreadable state', async () => {
  await withBackupRoots(async ({ stateRoot, backupRoot }) => {
    const sessionId = await createSession(stateRoot);
    await writeFile(
      join(stateRoot, 'sessions', sessionId, 'session.jsonl'),
      '{"type":"session_transcript","sessionId":"wrong","schemaVersion":1}\n',
    );

    await assertBackupError(
      createOperationalStateBackup({ stateRoot, destinationRoot: backupRoot }),
      'corrupt_backup',
    );
    await assert.rejects(lstat(backupRoot), { code: 'ENOENT' });
  });
});

test('cleans interrupted backup and restore staging so both operations can retry', async () => {
  await withBackupRoots(async ({ root, stateRoot, backupRoot, restoreRoot }) => {
    const sessionId = await createSession(stateRoot);
    const artifacts = createSqliteArtifactStore(stateRoot);
    try {
      await artifacts.create({
        id: 'artifact-1',
        sessionId,
        turnId: 'turn-1',
        name: 'output.txt',
        kind: 'file',
        content: 'output\n',
        now: 1,
      });
    } finally {
      artifacts.close?.();
    }

    await assert.rejects(
      createOperationalStateBackup({
        stateRoot,
        destinationRoot: backupRoot,
        failpoint: (point) => {
          if (point === 'after_database_snapshot') throw new Error('backup crash');
        },
      }),
      /backup crash/,
    );
    await assert.rejects(lstat(backupRoot), { code: 'ENOENT' });
    assert.equal(
      (await readdir(root)).some((entry) => entry.startsWith('backup.staging-')),
      false,
    );

    await createOperationalStateBackup({ stateRoot, destinationRoot: backupRoot });
    await assert.rejects(
      restoreOperationalStateBackup({
        backupRoot,
        destinationRoot: restoreRoot,
        failpoint: (point) => {
          if (point === 'after_restore_copy') throw new Error('restore crash');
        },
      }),
      /restore crash/,
    );
    await assert.rejects(lstat(restoreRoot), { code: 'ENOENT' });
    assert.equal(
      (await readdir(root)).some((entry) => entry.startsWith('restore.staging-')),
      false,
    );
    await restoreOperationalStateBackup({ backupRoot, destinationRoot: restoreRoot });
  });
});

test('rejects missing, changed, extra, and symlinked backup payloads before restore', async (t) => {
  const corruptions: ReadonlyArray<{
    name: string;
    apply: (input: { backupRoot: string; artifactPath: string }) => Promise<void>;
  }> = [
    {
      name: 'missing payload',
      apply: async ({ artifactPath }) => rm(artifactPath),
    },
    {
      name: 'changed payload',
      apply: async ({ artifactPath }) => writeFile(artifactPath, 'tampered\n'),
    },
    {
      name: 'extra payload',
      apply: async ({ backupRoot }) =>
        writeFile(join(backupRoot, 'artifacts', 'extra.txt'), 'extra\n'),
    },
    {
      name: 'extra empty directory',
      apply: async ({ backupRoot }) => mkdir(join(backupRoot, 'unmanifested')),
    },
    {
      name: 'symlinked payload',
      apply: async ({ backupRoot, artifactPath }) => {
        const target = join(backupRoot, 'outside.txt');
        await writeFile(target, 'outside\n');
        await rm(artifactPath);
        await symlink(target, artifactPath);
      },
    },
  ];

  for (const corruption of corruptions) {
    await t.test(corruption.name, async () => {
      await withBackupRoots(async ({ stateRoot, backupRoot, restoreRoot }) => {
        const sessionId = await createSession(stateRoot);
        const artifacts = createSqliteArtifactStore(stateRoot);
        let relativePath: string;
        try {
          relativePath = (
            await artifacts.create({
              id: 'artifact-1',
              sessionId,
              turnId: 'turn-1',
              name: 'output.txt',
              kind: 'file',
              content: 'output\n',
              now: 1,
            })
          ).relativePath;
        } finally {
          artifacts.close?.();
        }
        await createOperationalStateBackup({ stateRoot, destinationRoot: backupRoot });
        await corruption.apply({
          backupRoot,
          artifactPath: join(backupRoot, 'artifacts', relativePath!),
        });

        await assertBackupError(validateOperationalStateBackup(backupRoot), 'corrupt_backup');
        await assertBackupError(
          restoreOperationalStateBackup({ backupRoot, destinationRoot: restoreRoot }),
          'corrupt_backup',
        );
        await assert.rejects(lstat(restoreRoot), { code: 'ENOENT' });
      });
    });
  }
});

test('fails closed when retained legacy Artifact evidence changes after cutover', async () => {
  await withBackupRoots(async ({ stateRoot, backupRoot }) => {
    const sessionId = await createSession(stateRoot);
    const artifacts = createSqliteArtifactStore(stateRoot);
    try {
      await artifacts.create({
        id: 'sqlite-artifact',
        sessionId,
        turnId: 'turn-1',
        name: 'sqlite.txt',
        kind: 'file',
        content: 'sqlite\n',
        now: 1,
      });
    } finally {
      artifacts.close?.();
    }
    await writeFile(
      join(stateRoot, 'artifacts', 'metadata.jsonl'),
      `${JSON.stringify({
        id: 'stale-writer-artifact',
        sessionId,
        turnId: 'turn-2',
        createdAt: 2,
        name: 'stale.txt',
        kind: 'file',
        relativePath: `${sessionId}/stale-writer-artifact-stale.txt`,
        sizeBytes: 6,
        status: 'live',
      })}\n`,
    );

    await assert.rejects(
      createOperationalStateBackup({ stateRoot, destinationRoot: backupRoot }),
      /Legacy artifact_metadata source changed after cutover completed/,
    );
    await assert.rejects(lstat(backupRoot), { code: 'ENOENT' });
  });
});

test('rejects a newer SQLite schema even when the rewritten manifest digest matches', async () => {
  await withBackupRoots(async ({ stateRoot, backupRoot, restoreRoot }) => {
    await createSession(stateRoot);
    await createOperationalStateBackup({ stateRoot, destinationRoot: backupRoot });
    const databasePath = join(backupRoot, 'runtime.sqlite');
    const database = new DatabaseSync(databasePath);
    try {
      database
        .prepare(`
          UPDATE operational_schema_migrations
          SET version = version + 1
          WHERE scope = 'artifact'
        `)
        .run();
    } finally {
      database.close();
    }
    const manifestPath = join(backupRoot, OPERATIONAL_BACKUP_MANIFEST_FILE);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      database: { sizeBytes: number; sha256: string };
    };
    manifest.database.sizeBytes = (await stat(databasePath)).size;
    manifest.database.sha256 = await hashFile(databasePath);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await assertBackupError(validateOperationalStateBackup(backupRoot), 'unsupported_schema');
    await assertBackupError(
      restoreOperationalStateBackup({ backupRoot, destinationRoot: restoreRoot }),
      'unsupported_schema',
    );
    await assert.rejects(lstat(restoreRoot), { code: 'ENOENT' });
  });
});

test('rejects overlapping roots and an existing restore destination', async () => {
  await withBackupRoots(async ({ root, stateRoot, backupRoot, restoreRoot }) => {
    await createSession(stateRoot);
    await assertBackupError(
      createOperationalStateBackup({
        stateRoot,
        destinationRoot: join(stateRoot, 'backup'),
      }),
      'overlapping_roots',
    );
    await createOperationalStateBackup({ stateRoot, destinationRoot: backupRoot });
    await mkdir(restoreRoot);
    await assertBackupError(
      restoreOperationalStateBackup({ backupRoot, destinationRoot: restoreRoot }),
      'destination_exists',
    );
    assert.ok((await readdir(root)).includes('restore'));
  });
});

async function assertBackupError(
  operation: Promise<unknown>,
  code: OperationalBackupError['code'],
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.equal((error as OperationalBackupError).code, code);
    return true;
  });
}

async function createSession(stateRoot: string): Promise<string> {
  const sessions = createSessionStore(stateRoot);
  try {
    return (await sessions.create(sessionInput('Selected'))).id;
  } finally {
    await sessions.close?.();
  }
}

function sessionInput(name: string) {
  return {
    cwd: '/repo',
    backend: 'fake' as const,
    llmConnectionSlug: 'fixture',
    model: 'fixture-model',
    permissionMode: 'execute' as const,
    name,
  };
}

async function withBackupRoots(
  operation: (roots: {
    root: string;
    stateRoot: string;
    backupRoot: string;
    restoreRoot: string;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-backup-'));
  const stateRoot = join(root, 'state');
  const backupRoot = join(root, 'backup');
  const restoreRoot = join(root, 'restore');
  await mkdir(stateRoot);
  try {
    await operation({ root, stateRoot, backupRoot, restoreRoot });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function hashFile(path: string): Promise<string> {
  return `sha256:${createHash('sha256')
    .update(await readFile(path))
    .digest('hex')}`;
}
