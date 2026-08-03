import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { SessionHeader } from '@maka/core';
import { acquireOperationalStateDatabase } from '../operational-state-store.js';
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
