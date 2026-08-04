import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { SessionHeader } from '@maka/core';
import {
  acquireOperationalStateDatabase,
  resetIncompatibleOperationalStateDatabase,
} from '../operational-state-store.js';
import { SQLITE_RUNTIME_SCHEMA_VERSION } from '../sqlite-runtime-schema.js';
import { createSqliteSessionMetadataStore } from '../sqlite-session-metadata-store.js';

test('shares one operational database and produces an online backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-state-'));
  const backupPath = join(root, 'backup.sqlite');
  try {
    const lease = acquireOperationalStateDatabase(root);
    const secondLease = acquireOperationalStateDatabase(root);
    assert.equal(secondLease.database, lease.database);
    secondLease.close();

    const metadata = createSqliteSessionMetadataStore(join(root, 'runtime.sqlite'), {
      databaseLease: lease,
    });
    await metadata.create(sessionHeader());
    const backup = lease.backup(backupPath);
    metadata.close();
    assert.ok((await backup) > 0);

    const reopened = new DatabaseSync(backupPath, { readOnly: true });
    try {
      assert.equal(
        (
          reopened.prepare('SELECT COUNT(*) AS count FROM session_metadata').get() as {
            count: number;
          }
        ).count,
        1,
      );
    } finally {
      reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preserves operational state when every schema is current', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-compatible-'));
  try {
    const lease = acquireOperationalStateDatabase(root);
    lease.database.exec('CREATE TABLE compatibility_sentinel (value TEXT NOT NULL)');
    lease.database.exec("INSERT INTO compatibility_sentinel(value) VALUES ('preserved')");
    lease.close();

    assert.equal(resetIncompatibleOperationalStateDatabase(root), false);
    const reopened = acquireOperationalStateDatabase(root);
    assert.equal(
      (
        reopened.database.prepare('SELECT value FROM compatibility_sentinel').get() as {
          value: string;
        }
      ).value,
      'preserved',
    );
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('clears operational state instead of migrating an incompatible schema', async (context) => {
  for (const version of [SQLITE_RUNTIME_SCHEMA_VERSION - 1, SQLITE_RUNTIME_SCHEMA_VERSION + 1]) {
    await context.test(`schema ${version}`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'maka-operational-incompatible-'));
      const databasePath = join(root, 'runtime.sqlite');
      try {
        const lease = acquireOperationalStateDatabase(root);
        lease.close();
        const database = new DatabaseSync(databasePath);
        database.exec(`PRAGMA user_version = ${version}`);
        database.close();

        assert.equal(resetIncompatibleOperationalStateDatabase(root), true);
        const rebuilt = acquireOperationalStateDatabase(root);
        assert.equal(
          (rebuilt.database.prepare('PRAGMA user_version').get() as { user_version: number })
            .user_version,
          SQLITE_RUNTIME_SCHEMA_VERSION,
        );
        rebuilt.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

function sessionHeader(): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/workspace',
    cwd: '/workspace',
    createdAt: 1,
    lastUsedAt: 2,
    name: 'Session',
    titleIsManual: true,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    hasUnread: false,
    backend: 'fake',
    llmConnectionSlug: 'test',
    connectionLocked: true,
    model: 'test-model',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
    schemaVersion: 1,
  };
}
