import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { SessionHeader } from '@maka/core/session';
import { acquireOperationalStateDatabase } from '../operational-state-store.js';
import { SQLITE_RUNTIME_SCHEMA_VERSION } from '../sqlite-runtime-schema.js';
import { SQLITE_SESSION_METADATA_SCHEMA_VERSION } from '../sqlite-session-metadata-schema.js';
import { SQLITE_USAGE_SCHEMA_VERSION } from '../sqlite-usage-schema.js';
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

test('rejects a newer scope before migrating an older scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-mixed-version-'));
  const databasePath = join(root, 'runtime.sqlite');
  try {
    const lease = acquireOperationalStateDatabase(root);
    lease.close();

    const database = new DatabaseSync(databasePath);
    rewindRuntimeSchema(database);
    database
      .prepare(`UPDATE operational_schema_migrations SET version = ? WHERE scope = 'usage'`)
      .run(SQLITE_USAGE_SCHEMA_VERSION + 1);
    database.close();

    assert.throws(
      () => acquireOperationalStateDatabase(root),
      /Operational schema usage is newer than supported/,
    );

    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(
        (preserved.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
        SQLITE_RUNTIME_SCHEMA_VERSION - 1,
      );
    } finally {
      preserved.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a newer runtime schema without changing the database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-newer-runtime-'));
  const databasePath = join(root, 'runtime.sqlite');
  try {
    const lease = acquireOperationalStateDatabase(root);
    lease.close();

    const database = new DatabaseSync(databasePath);
    database.exec(`PRAGMA user_version = ${SQLITE_RUNTIME_SCHEMA_VERSION + 1}`);
    database.exec('CREATE TABLE runtime_future_sentinel (value TEXT NOT NULL)');
    database.exec("INSERT INTO runtime_future_sentinel(value) VALUES ('preserved')");
    database.close();

    assert.throws(
      () => acquireOperationalStateDatabase(root),
      /Operational schema runtime is newer than supported/,
    );

    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(
        (preserved.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
        SQLITE_RUNTIME_SCHEMA_VERSION + 1,
      );
      assert.equal(
        (
          preserved.prepare('SELECT value FROM runtime_future_sentinel').get() as {
            value: string;
          }
        ).value,
        'preserved',
      );
    } finally {
      preserved.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects newer session metadata before migrating older runtime state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-newer-metadata-'));
  const databasePath = join(root, 'runtime.sqlite');
  try {
    const lease = acquireOperationalStateDatabase(root);
    lease.close();

    const database = new DatabaseSync(databasePath);
    rewindRuntimeSchema(database);
    database
      .prepare(`UPDATE session_metadata_schema SET version = ? WHERE scope = 'session_metadata'`)
      .run(SQLITE_SESSION_METADATA_SCHEMA_VERSION + 1);
    database.close();

    assert.throws(
      () => acquireOperationalStateDatabase(root),
      /Operational schema session_metadata is newer than supported/,
    );

    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(
        (preserved.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
        SQLITE_RUNTIME_SCHEMA_VERSION - 1,
      );
    } finally {
      preserved.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects an unknown operational schema without changing the database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-unknown-scope-'));
  const databasePath = join(root, 'runtime.sqlite');
  try {
    const lease = acquireOperationalStateDatabase(root);
    lease.close();

    const database = new DatabaseSync(databasePath);
    database
      .prepare(
        `INSERT INTO operational_schema_migrations(scope, version, applied_at) VALUES (?, ?, ?)`,
      )
      .run('future_scope', 1, 1);
    database.close();

    assert.throws(
      () => acquireOperationalStateDatabase(root),
      /Operational schema future_scope is unknown to this Maka build/,
    );

    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = preserved
        .prepare(
          `SELECT scope, version, applied_at FROM operational_schema_migrations WHERE scope = ?`,
        )
        .get('future_scope') as { scope: string; version: number; applied_at: number };
      assert.equal(row.scope, 'future_scope');
      assert.equal(row.version, 1);
      assert.equal(row.applied_at, 1);
    } finally {
      preserved.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects an invalid registered schema version before migrating', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-invalid-version-'));
  const databasePath = join(root, 'runtime.sqlite');
  try {
    const lease = acquireOperationalStateDatabase(root);
    lease.close();

    const database = new DatabaseSync(databasePath);
    rewindRuntimeSchema(database);
    database
      .prepare(`UPDATE operational_schema_migrations SET version = ? WHERE scope = 'usage'`)
      .run(1.5);
    database.close();

    assert.throws(
      () => acquireOperationalStateDatabase(root),
      /Operational schema usage has invalid version 1.5/,
    );

    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(
        (preserved.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
        SQLITE_RUNTIME_SCHEMA_VERSION - 1,
      );
    } finally {
      preserved.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function rewindRuntimeSchema(database: DatabaseSync): void {
  database.exec('DROP TABLE runtime_session_event_ordinals');
  database.exec(`PRAGMA user_version = ${SQLITE_RUNTIME_SCHEMA_VERSION - 1}`);
}

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
