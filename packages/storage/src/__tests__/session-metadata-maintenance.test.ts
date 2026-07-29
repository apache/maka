import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { createExternalExecutionBoundary, type CreateSessionInput } from '@maka/core';
import {
  backupSessionMetadataDatabase,
  exportLegacySessionTree,
  exportLegacySessionTreeSnapshot,
  SESSION_METADATA_EXPORT_FORMAT,
} from '../session-metadata-maintenance.js';
import {
  createLegacyFileSessionStore,
  createSessionStore,
  SQLITE_SESSION_METADATA_DATABASE_NAME,
} from '../session-store.js';
import { createSqliteSessionMetadataStore } from '../sqlite-session-metadata-store.js';

describe('session metadata migration maintenance', () => {
  test('exports a legacy-compatible tree and creates an online SQLite backup', async () => {
    const container = await mkdtemp(join(tmpdir(), 'maka-session-metadata-maintenance-'));
    const workspaceRoot = join(container, 'workspace');
    const exportRoot = join(container, 'legacy-export');
    const backupPath = join(container, 'backups', 'sessions.sqlite');
    const store = createSessionStore(workspaceRoot);
    try {
      const created = await store.create(makeInput(), createExternalExecutionBoundary());
      await store.appendMessage(created.id, {
        type: 'user',
        id: 'user-1',
        turnId: 'turn-1',
        ts: 10,
        text: 'portable transcript',
      });
      await store.rename(created.id, 'Canonical SQLite title');

      const exported = await exportLegacySessionTree({
        workspaceRoot,
        destinationRoot: exportRoot,
        now: () => 123,
      });
      assert.equal(exported.sessionsExported, 1);

      const legacy = createLegacyFileSessionStore(exportRoot);
      assert.equal((await legacy.readHeader(created.id)).name, 'Canonical SQLite title');
      assert.equal((await legacy.readMessages(created.id))[0]?.type, 'user');
      const restoredExport = createSessionStore(exportRoot);
      try {
        assert.equal((await restoredExport.readExecutionBoundary(created.id)).kind, 'external');
      } finally {
        await restoredExport.close?.();
      }

      const manifest = JSON.parse(await readFile(exported.manifestPath, 'utf8')) as {
        format: string;
        exportedAt: number;
        sessions: Array<{ header: { id: string; name: string } }>;
      };
      assert.equal(manifest.format, SESSION_METADATA_EXPORT_FORMAT);
      assert.equal(manifest.exportedAt, 123);
      assert.deepEqual(
        manifest.sessions.map((record) => record.header.id),
        [created.id],
      );
      assert.equal(manifest.sessions[0]?.header.name, 'Canonical SQLite title');

      const backup = await backupSessionMetadataDatabase({
        workspaceRoot,
        destinationPath: backupPath,
      });
      assert.equal(backup.destinationPath, backupPath);
      assert.ok(backup.pagesCopied > 0);
      const restored = createSqliteSessionMetadataStore(backupPath);
      try {
        assert.equal((await restored.read(created.id)).header.name, 'Canonical SQLite title');
      } finally {
        restored.close();
      }

      const liveTranscript = await readFile(
        join(workspaceRoot, 'sessions', created.id, 'session.jsonl'),
        'utf8',
      );
      assert.equal(JSON.parse(liveTranscript.split('\n')[0]!).type, 'session_transcript');
      await assert.rejects(
        () => exportLegacySessionTree({ workspaceRoot, destinationRoot: exportRoot }),
        /already exists/,
      );
      await assert.rejects(
        () => backupSessionMetadataDatabase({ workspaceRoot, destinationPath: backupPath }),
        /already exists/,
      );
    } finally {
      await store.close?.();
      await rm(container, { recursive: true, force: true });
    }
  });

  test('refuses to export over the live workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-metadata-export-overlap-'));
    const store = createSessionStore(root);
    try {
      await store.create(makeInput());
      await assert.rejects(
        () => exportLegacySessionTree({ workspaceRoot: root, destinationRoot: root }),
        /overlaps/,
      );
      await assert.rejects(
        () =>
          backupSessionMetadataDatabase({
            workspaceRoot: root,
            destinationPath: join(root, SQLITE_SESSION_METADATA_DATABASE_NAME),
          }),
        /differ from the source/,
      );
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('refuses to publish a snapshot without every selected execution boundary', async () => {
    const container = await mkdtemp(join(tmpdir(), 'maka-session-metadata-boundary-export-'));
    const workspaceRoot = join(container, 'workspace');
    const destinationRoot = join(container, 'export');
    const store = createSessionStore(workspaceRoot);
    try {
      const created = await store.create(makeInput());
      const metadata = createSqliteSessionMetadataStore(
        join(workspaceRoot, SQLITE_SESSION_METADATA_DATABASE_NAME),
      );
      try {
        const record = await metadata.read(created.id);
        await assert.rejects(
          () =>
            exportLegacySessionTreeSnapshot({
              workspaceRoot,
              destinationRoot,
              records: [record],
              boundaries: new Map(),
            }),
          /execution boundary.*missing/i,
        );
        await assert.rejects(() => readFile(destinationRoot), /ENOENT/);
      } finally {
        metadata.close();
      }
    } finally {
      await store.close?.();
      await rm(container, { recursive: true, force: true });
    }
  });
});

function makeInput(): CreateSessionInput {
  return {
    cwd: '/tmp/cwd',
    backend: 'fake',
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask',
    name: 'Initial title',
  };
}
