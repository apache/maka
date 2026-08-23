/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from 'node:assert/strict';
import { chmod, copyFile, mkdtemp, rm } from 'node:fs/promises';
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

test('atomically reapplies current owner schema without republishing its registry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-current-convergence-'));
  const databasePath = join(root, 'runtime.sqlite');
  try {
    const lease = acquireOperationalStateDatabase(root);
    const registry = lease.database
      .prepare(
        "SELECT version, applied_at FROM operational_schema_migrations WHERE scope = 'usage'",
      )
      .get();
    lease.close();

    const damaged = new DatabaseSync(databasePath);
    damaged.exec('DROP TABLE usage_llm_calls');
    damaged.close();

    const reopened = acquireOperationalStateDatabase(root);
    assert.ok(
      reopened.database
        .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'usage_llm_calls'")
        .get(),
    );
    assert.deepEqual(
      reopened.database
        .prepare(
          "SELECT version, applied_at FROM operational_schema_migrations WHERE scope = 'usage'",
        )
        .get(),
      registry,
    );
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('retires completed released migration metadata during schema convergence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-cutover-retirement-'));
  const databasePath = join(root, 'runtime.sqlite');
  try {
    const metadata = createSqliteSessionMetadataStore(databasePath, {
      databaseLease: acquireOperationalStateDatabase(root),
    });
    await metadata.create(sessionHeader());
    metadata.close();
    const legacy = new DatabaseSync(databasePath);
    createLegacyCutoverJournal(legacy);
    createLegacyImportSourceTables(legacy);
    legacy
      .prepare(`
        INSERT INTO cutover_journal(
          store_name,
          source_path,
          source_fingerprint,
          state,
          started_at,
          completed_at,
          validation_json
        ) VALUES (?, ?, ?, 'completed', ?, ?, ?)
      `)
      .run(
        'session_metadata',
        join(root, 'sessions.sqlite'),
        'sha256:released-source',
        10,
        20,
        JSON.stringify(releasedSessionMetadataValidation()),
      );
    legacy
      .prepare(`
        INSERT INTO runtime_import_sources(source_path, fingerprint, imported_at)
        VALUES (?, ?, ?)
      `)
      .run(join(root, 'runtime-events.jsonl'), 'sha256:released-events', 20);
    legacy
      .prepare(`
        INSERT INTO session_metadata_import_sources(
          source_path,
          fingerprint,
          session_id,
          imported_at
        ) VALUES (?, ?, ?, ?)
      `)
      .run(join(root, 'sessions.json'), 'sha256:released-session', 'session-1', 20);
    legacy.close();

    const migrated = acquireOperationalStateDatabase(root);
    assert.equal(
      migrated.database
        .prepare(`
          SELECT 1
          FROM sqlite_schema
          WHERE type = 'table'
            AND name IN (
              'cutover_journal',
              'runtime_import_sources',
              'session_metadata_import_sources'
            )
          LIMIT 1
        `)
        .get(),
      undefined,
    );
    // Retirement must not touch legitimate data or half-apply schema convergence.
    assert.equal(
      (
        migrated.database
          .prepare("SELECT COUNT(*) AS count FROM session_metadata WHERE session_id = 'session-1'")
          .get() as { count: number }
      ).count,
      1,
    );
    assert.equal(
      (
        migrated.database
          .prepare("SELECT version FROM operational_schema_migrations WHERE scope = 'runtime'")
          .get() as { version?: number } | undefined
      )?.version,
      SQLITE_RUNTIME_SCHEMA_VERSION,
    );
    assert.equal(
      (
        migrated.database
          .prepare(
            "SELECT version FROM operational_schema_migrations WHERE scope = 'session_metadata'",
          )
          .get() as { version?: number } | undefined
      )?.version,
      SQLITE_SESSION_METADATA_SCHEMA_VERSION,
    );
    migrated.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preserves an interrupted released cutover journal and fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-cutover-interrupted-'));
  const databasePath = join(root, 'runtime.sqlite');
  try {
    acquireOperationalStateDatabase(root).close();
    const legacy = new DatabaseSync(databasePath);
    createLegacyCutoverJournal(legacy);
    legacy
      .prepare(`
        INSERT INTO cutover_journal(
          store_name,
          source_path,
          source_fingerprint,
          state,
          started_at
        ) VALUES (?, ?, ?, 'started', ?)
      `)
      .run('session_metadata', join(root, 'sessions.sqlite'), 'sha256:released-source', 10);
    legacy.close();

    assert.throws(
      () => acquireOperationalStateDatabase(root),
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: unknown }).code === 'operational_state_migration_blocked' &&
        /cutover journal is incomplete or invalid/u.test(error.message),
    );
    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    assert.deepEqual(
      {
        ...(preserved.prepare('SELECT store_name, state FROM cutover_journal').get() as Record<
          string,
          unknown
        >),
      },
      { store_name: 'session_metadata', state: 'started' },
    );
    preserved.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preserves a cutover journal with an unfamiliar column shape and fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-cutover-shape-'));
  const databasePath = join(root, 'runtime.sqlite');
  try {
    acquireOperationalStateDatabase(root).close();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE cutover_journal (
        store_name TEXT PRIMARY KEY,
        source_path TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('started', 'completed')),
        started_at INTEGER NOT NULL CHECK (started_at >= 0),
        completed_at INTEGER,
        validation_json TEXT,
        unexpected_column TEXT
      )
    `);
    legacy
      .prepare(`
        INSERT INTO cutover_journal(
          store_name,
          source_path,
          source_fingerprint,
          state,
          started_at,
          completed_at,
          validation_json
        ) VALUES (?, ?, ?, 'completed', ?, ?, ?)
      `)
      .run(
        'session_metadata',
        join(root, 'sessions.sqlite'),
        'sha256:released-source',
        10,
        20,
        JSON.stringify({ session_metadata: 4 }),
      );
    legacy.close();

    assert.throws(
      () => acquireOperationalStateDatabase(root),
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: unknown }).code === 'operational_state_migration_blocked' &&
        /unfamiliar released shape/u.test(error.message),
    );
    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(
      (
        preserved.prepare('SELECT COUNT(*) AS count FROM cutover_journal').get() as {
          count: number;
        }
      ).count,
      1,
    );
    preserved.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preserves a cutover journal with an altered constraint and fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-cutover-constraint-'));
  const databasePath = join(root, 'runtime.sqlite');
  try {
    acquireOperationalStateDatabase(root).close();
    const legacy = new DatabaseSync(databasePath);
    // Released columns/types verbatim, but a loosened CHECK bound. A column-only
    // gate would accept and DROP this; the full-signature gate must not.
    legacy.exec(`
      CREATE TABLE cutover_journal (
        store_name TEXT PRIMARY KEY,
        source_path TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('started', 'completed')),
        started_at INTEGER NOT NULL CHECK (started_at >= -1),
        completed_at INTEGER,
        validation_json TEXT
      )
    `);
    legacy
      .prepare(`
        INSERT INTO cutover_journal(
          store_name,
          source_path,
          source_fingerprint,
          state,
          started_at,
          completed_at,
          validation_json
        ) VALUES (?, ?, ?, 'completed', ?, ?, ?)
      `)
      .run(
        'session_metadata',
        join(root, 'sessions.sqlite'),
        'sha256:released-source',
        10,
        20,
        JSON.stringify({ session_metadata: 4 }),
      );
    legacy.close();

    assert.throws(
      () => acquireOperationalStateDatabase(root),
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: unknown }).code === 'operational_state_migration_blocked' &&
        /unfamiliar released shape/u.test(error.message),
    );
    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(
      (
        preserved.prepare('SELECT COUNT(*) AS count FROM cutover_journal').get() as {
          count: number;
        }
      ).count,
      1,
    );
    preserved.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preserves a cutover journal carrying an extra trigger and fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-cutover-trigger-'));
  const databasePath = join(root, 'runtime.sqlite');
  try {
    acquireOperationalStateDatabase(root).close();
    const legacy = new DatabaseSync(databasePath);
    createLegacyCutoverJournal(legacy);
    // An extra schema object grafted onto the released table: retirement must
    // refuse to DROP a table whose full object set it cannot recognize.
    legacy.exec(`
      CREATE TRIGGER cutover_journal_guard
      AFTER INSERT ON cutover_journal
      BEGIN
        DELETE FROM cutover_journal WHERE store_name = NEW.store_name;
      END;
    `);
    legacy.close();

    assert.throws(
      () => acquireOperationalStateDatabase(root),
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: unknown }).code === 'operational_state_migration_blocked' &&
        /carries an unexpected object/u.test(error.message),
    );
    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    assert.ok(
      preserved
        .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'cutover_journal'")
        .get(),
    );
    preserved.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preserves a cutover journal naming an unknown store and fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-cutover-unknown-store-'));
  const databasePath = join(root, 'runtime.sqlite');
  try {
    acquireOperationalStateDatabase(root).close();
    const legacy = new DatabaseSync(databasePath);
    createLegacyCutoverJournal(legacy);
    // Released shape and internally well-formed, but names a store no released
    // writer ever emitted — unrecognized evidence must fail closed, not drop.
    legacy
      .prepare(`
        INSERT INTO cutover_journal(
          store_name,
          source_path,
          source_fingerprint,
          state,
          started_at,
          completed_at,
          validation_json
        ) VALUES (?, ?, ?, 'completed', ?, ?, ?)
      `)
      .run(
        'future_store',
        join(root, 'future.sqlite'),
        'sha256:released-source',
        10,
        20,
        JSON.stringify({ future_store: 1 }),
      );
    legacy.close();

    assert.throws(
      () => acquireOperationalStateDatabase(root),
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: unknown }).code === 'operational_state_migration_blocked' &&
        /cutover journal is incomplete or invalid/u.test(error.message),
    );
    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(
      (preserved.prepare('SELECT store_name FROM cutover_journal').get() as { store_name: string })
        .store_name,
      'future_store',
    );
    preserved.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preserves a completed row carrying an unfamiliar validation key and fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-cutover-extra-key-'));
  const databasePath = join(root, 'runtime.sqlite');
  try {
    acquireOperationalStateDatabase(root).close();
    const legacy = new DatabaseSync(databasePath);
    createLegacyCutoverJournal(legacy);
    // A known store, released shape, well-formed counts — but one key beyond the
    // set the released writer emitted. No released writer produced this contract,
    // so the journal must be preserved rather than retired.
    legacy
      .prepare(`
        INSERT INTO cutover_journal(
          store_name,
          source_path,
          source_fingerprint,
          state,
          started_at,
          completed_at,
          validation_json
        ) VALUES (?, ?, ?, 'completed', ?, ?, ?)
      `)
      .run(
        'session_metadata',
        join(root, 'sessions.sqlite'),
        'sha256:released-source',
        10,
        20,
        JSON.stringify({ ...releasedSessionMetadataValidation(), unexpected_evidence: 0 }),
      );
    legacy.close();

    assert.throws(
      () => acquireOperationalStateDatabase(root),
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: unknown }).code === 'operational_state_migration_blocked' &&
        /invalid validation evidence/u.test(error.message),
    );
    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(
      (preserved.prepare('SELECT store_name FROM cutover_journal').get() as { store_name: string })
        .store_name,
      'session_metadata',
    );
    preserved.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preserves a completed row missing a released validation key and fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-cutover-missing-key-'));
  const databasePath = join(root, 'runtime.sqlite');
  try {
    acquireOperationalStateDatabase(root).close();
    const legacy = new DatabaseSync(databasePath);
    createLegacyCutoverJournal(legacy);
    const incomplete = releasedSessionMetadataValidation();
    delete incomplete.sandbox_boundary_log;
    legacy
      .prepare(`
        INSERT INTO cutover_journal(
          store_name,
          source_path,
          source_fingerprint,
          state,
          started_at,
          completed_at,
          validation_json
        ) VALUES (?, ?, ?, 'completed', ?, ?, ?)
      `)
      .run(
        'session_metadata',
        join(root, 'sessions.sqlite'),
        'sha256:released-source',
        10,
        20,
        JSON.stringify(incomplete),
      );
    legacy.close();

    assert.throws(
      () => acquireOperationalStateDatabase(root),
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: unknown }).code === 'operational_state_migration_blocked' &&
        /invalid validation evidence/u.test(error.message),
    );
    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(
      (
        preserved.prepare('SELECT COUNT(*) AS count FROM cutover_journal').get() as {
          count: number;
        }
      ).count,
      1,
    );
    preserved.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preserves a malformed released import source and fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-import-malformed-'));
  const databasePath = join(root, 'runtime.sqlite');
  try {
    acquireOperationalStateDatabase(root).close();
    const legacy = new DatabaseSync(databasePath);
    createLegacyImportSourceTables(legacy);
    legacy
      .prepare(`
        INSERT INTO runtime_import_sources(source_path, fingerprint, imported_at)
        VALUES (?, ?, ?)
      `)
      .run(join(root, 'runtime-events.jsonl'), '', 20);
    legacy.close();

    assert.throws(
      () => acquireOperationalStateDatabase(root),
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: unknown }).code === 'operational_state_migration_blocked' &&
        /import source is incomplete or invalid/u.test(error.message),
    );
    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(
      (
        preserved.prepare('SELECT COUNT(*) AS count FROM runtime_import_sources').get() as {
          count: number;
        }
      ).count,
      1,
    );
    preserved.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preserves a session import source with a missing session and fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-import-missing-session-'));
  const databasePath = join(root, 'runtime.sqlite');
  try {
    acquireOperationalStateDatabase(root).close();
    const legacy = new DatabaseSync(databasePath);
    createLegacyImportSourceTables(legacy);
    // node:sqlite enforces foreign keys by default; disable them only to plant
    // the orphaned import row this defensive branch must reject.
    legacy.exec('PRAGMA foreign_keys = OFF');
    legacy
      .prepare(`
        INSERT INTO session_metadata_import_sources(
          source_path,
          fingerprint,
          session_id,
          imported_at
        ) VALUES (?, ?, ?, ?)
      `)
      .run(join(root, 'sessions.json'), 'sha256:released-session', 'missing-session', 20);
    legacy.close();

    assert.throws(
      () => acquireOperationalStateDatabase(root),
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: unknown }).code === 'operational_state_migration_blocked' &&
        /session import source is incomplete or invalid/u.test(error.message),
    );
    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(
      (
        preserved
          .prepare('SELECT COUNT(*) AS count FROM session_metadata_import_sources')
          .get() as { count: number }
      ).count,
      1,
    );
    preserved.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rolls back every scope when migration publication fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-rollback-'));
  const databasePath = join(root, 'runtime.sqlite');
  try {
    await copyV016Database(databasePath);
    const legacy = new DatabaseSync(databasePath);
    legacy.exec('DELETE FROM automation_pending_fires; DELETE FROM automation_definitions');
    const versions = legacy
      .prepare(
        'SELECT scope, version, applied_at FROM operational_schema_migrations ORDER BY scope',
      )
      .all();
    const runtimeVersion = (legacy.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    const sessionMetadataVersion = legacy
      .prepare("SELECT version FROM session_metadata_schema WHERE scope = 'session_metadata'")
      .get()?.version;
    const reminder = legacy
      .prepare('SELECT record_json FROM workflow_plan_reminders')
      .get()?.record_json;
    legacy.close();

    assert.throws(
      () => acquireOperationalStateDatabase(root, { now: () => -1 }),
      /CHECK constraint failed/,
    );

    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    assert.deepEqual(
      preserved
        .prepare(
          'SELECT scope, version, applied_at FROM operational_schema_migrations ORDER BY scope',
        )
        .all(),
      versions,
    );
    assert.equal(
      (preserved.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      runtimeVersion,
    );
    assert.equal(
      preserved
        .prepare("SELECT version FROM session_metadata_schema WHERE scope = 'session_metadata'")
        .get()?.version,
      sessionMetadataVersion,
    );
    assert.equal(
      preserved.prepare('SELECT record_json FROM workflow_plan_reminders').get()?.record_json,
      reminder,
    );
    assert.equal(
      preserved
        .prepare("SELECT 1 FROM sqlite_schema WHERE name = 'workflow_scheduled_tasks'")
        .get(),
      undefined,
    );
    assert.equal(
      preserved
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE name IN ('session_message_payloads', 'session_message_chunks') LIMIT 1",
        )
        .get(),
      undefined,
    );
    preserved.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('migrates released Reminder state after Automation is retired', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-v016-'));
  try {
    const databasePath = join(root, 'runtime.sqlite');
    await copyV016Database(databasePath);
    const legacy = new DatabaseSync(databasePath);
    legacy.exec('DELETE FROM automation_pending_fires; DELETE FROM automation_definitions');
    legacy.close();
    const lease = acquireOperationalStateDatabase(root);
    const rows = lease.database
      .prepare('SELECT task_id, record_json FROM workflow_scheduled_tasks ORDER BY task_id')
      .all() as Array<{ task_id: string; record_json: string }>;
    assert.deepEqual(
      rows.map(({ task_id }) => task_id),
      ['60999192-d3b2-45b6-affb-e76355d4cf85'],
    );
    lease.close();
    const reopened = acquireOperationalStateDatabase(root);
    const reminder = JSON.parse(rows[0]?.record_json ?? '') as Record<string, unknown>;
    assert.deepEqual(reminder, {
      id: '60999192-d3b2-45b6-affb-e76355d4cf85',
      title: 'Reminder v0.1.6',
      intent: { kind: 'text', body: 'preserve reminder' },
      schedule: { kind: 'once', runAt: 10_000 },
      effect: { kind: 'notify', channel: 'local' },
      status: 'active',
      nextFireAt: 10_000,
      lastFireAt: null,
      fireCount: 0,
      maxFires: null,
      expiresAt: null,
      createdBy: { kind: 'user' },
      createdAt: 100,
      updatedAt: 100,
      runs: [],
      lastError: null,
    });
    assert.equal(
      reopened.database.prepare('SELECT COUNT(*) AS count FROM session_metadata').get()?.count,
      1,
    );
    assert.equal(
      reopened.database.prepare('SELECT COUNT(*) AS count FROM session_messages').get()?.count,
      1,
    );
    assert.equal(
      reopened.database
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'automation_definitions'",
        )
        .get(),
      undefined,
    );
    assert.equal(
      reopened.database
        .prepare("SELECT 1 FROM operational_schema_migrations WHERE scope = 'automation'")
        .get(),
      undefined,
    );
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('finishes a released cleanup backfill interrupted after adding its column', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-interrupted-cleanup-'));
  const databasePath = join(root, 'runtime.sqlite');
  try {
    await copyV016Database(databasePath);
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      DELETE FROM automation_pending_fires;
      DELETE FROM automation_definitions;
      INSERT INTO workflow_quote_companion_cleanup(session_id, tracked_at)
      VALUES ('session-interrupted', 42);
      ALTER TABLE workflow_quote_companion_cleanup ADD COLUMN record_json TEXT;
    `);
    legacy.close();

    const migrated = acquireOperationalStateDatabase(root);
    const record = migrated.database
      .prepare(
        "SELECT record_json FROM workflow_quote_companion_cleanup WHERE session_id = 'session-interrupted'",
      )
      .get() as { record_json: string };
    assert.equal(JSON.parse(record.record_json).sessionId, 'session-interrupted');
    migrated.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('leaves released Automation unchanged when its configuration cannot be preserved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-v016-automation-'));
  const databasePath = join(root, 'runtime.sqlite');
  try {
    await copyV016Database(databasePath);
    assert.throws(() => acquireOperationalStateDatabase(root), /cannot be migrated without losing/);
    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(
      preserved.prepare('SELECT COUNT(*) AS count FROM automation_definitions').get()?.count,
      1,
    );
    assert.equal(
      preserved
        .prepare("SELECT 1 FROM sqlite_schema WHERE name = 'workflow_scheduled_tasks'")
        .get(),
      undefined,
    );
    preserved.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects legacy Automation tables without their registry authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-v016-missing-automation-scope-'));
  const databasePath = join(root, 'runtime.sqlite');
  try {
    await copyV016Database(databasePath);
    const legacy = new DatabaseSync(databasePath);
    legacy.exec("DELETE FROM operational_schema_migrations WHERE scope = 'automation'");
    legacy.close();

    assert.throws(() => acquireOperationalStateDatabase(root), /Automation schema registry/);
    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(
      preserved.prepare('SELECT COUNT(*) AS count FROM automation_definitions').get()?.count,
      1,
    );
    preserved.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a released Workflow registry whose reminder table is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-v016-missing-reminders-'));
  const databasePath = join(root, 'runtime.sqlite');
  try {
    await copyV016Database(databasePath);
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      DROP TABLE workflow_plan_reminders;
      UPDATE operational_schema_migrations SET version = 5 WHERE scope = 'workflow';
    `);
    legacy.close();

    assert.throws(() => acquireOperationalStateDatabase(root), /missing workflow_plan_reminders/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a released Reminder table after its Workflow authority removed it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-stale-reminders-'));
  try {
    const lease = acquireOperationalStateDatabase(root);
    lease.database.exec('CREATE TABLE workflow_plan_reminders (reminder_id TEXT PRIMARY KEY)');
    rewindRuntimeSchema(lease.database);
    lease.close();

    assert.throws(
      () => acquireOperationalStateDatabase(root),
      /still contains released Plan Reminder/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a current Runtime schema whose versioned authority table is missing', async () => {
  await assertCurrentDatabaseRejected(
    'missing-runtime-authority',
    (database) => database.exec('DROP TABLE runtime_session_event_ordinals'),
    /missing required schema object table:runtime_session_event_ordinals/,
    (database) => {
      assert.equal(
        database
          .prepare(
            "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'runtime_session_event_ordinals'",
          )
          .get(),
        undefined,
      );
      assert.equal(
        (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
        SQLITE_RUNTIME_SCHEMA_VERSION,
      );
    },
  );
});

for (const { name, mutation } of [
  {
    name: 'a current authority index with an incompatible predicate',
    mutation: (database: DatabaseSync) =>
      database.exec(`
        DROP INDEX artifact_records_relative_path;
        CREATE UNIQUE INDEX artifact_records_relative_path
          ON artifact_records(relative_path)
          WHERE status = 'live';
      `),
  },
  {
    name: 'a current authority check with a changed string literal',
    mutation: (database: DatabaseSync) =>
      database.exec(`
        DROP TABLE artifact_records;
        CREATE TABLE artifact_records (
          storage_key TEXT PRIMARY KEY,
          artifact_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          created_at INTEGER NOT NULL CHECK (created_at >= 0),
          status TEXT NOT NULL CHECK (status IN ('LIVE', 'DELETED')),
          relative_path TEXT NOT NULL,
          record_json TEXT NOT NULL
        );
      `),
  },
  {
    name: 'a current authority table with an extra rejecting constraint',
    mutation: (database: DatabaseSync) =>
      database.exec(`
        DROP TABLE usage_llm_calls;
        CREATE TABLE usage_llm_calls (
          storage_key TEXT PRIMARY KEY,
          id TEXT NOT NULL,
          ts INTEGER NOT NULL CHECK (ts >= 0),
          record_json TEXT NOT NULL,
          CHECK (0)
        );
        CREATE INDEX IF NOT EXISTS usage_llm_calls_ts ON usage_llm_calls(ts DESC, id);
      `),
  },
  {
    name: 'a current authority table with an extra destructive trigger',
    mutation: (database: DatabaseSync) =>
      database.exec(`
        CREATE TRIGGER delete_usage_llm_call_after_insert
        AFTER INSERT ON usage_llm_calls
        BEGIN
          DELETE FROM usage_llm_calls WHERE storage_key = NEW.storage_key;
        END;
      `),
  },
  {
    name: 'a current authority database with an unexpected view',
    mutation: (database: DatabaseSync) =>
      database.exec('CREATE VIEW unexpected_operational_view AS SELECT * FROM usage_llm_calls'),
  },
] as const) {
  test(`rejects ${name}`, async () => {
    await assertCurrentDatabaseRejected(
      name.replaceAll(' ', '-'),
      mutation,
      /Incomplete operational SQLite schema/,
    );
  });
}

test('rejects a null operational scope without migrating', async () => {
  await assertCurrentDatabaseRejected(
    'null-scope',
    (database) => {
      database.exec(`
        INSERT INTO operational_schema_migrations(scope, version, applied_at) VALUES (NULL, 0, 0);
        PRAGMA user_version = ${SQLITE_RUNTIME_SCHEMA_VERSION - 1};
      `);
    },
    /invalid scope/,
    (database) =>
      assert.equal(
        (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
        SQLITE_RUNTIME_SCHEMA_VERSION - 1,
      ),
  );
});

test('rejects a nonempty database with no operational registry', async () => {
  await assertCurrentDatabaseRejected(
    'missing-registry',
    (database) =>
      database.exec(
        'DROP TABLE operational_schema_migrations; DROP TABLE workflow_task_ledger_events',
      ),
    /registry is missing from a nonempty database/,
    (database) =>
      assert.equal(
        database
          .prepare("SELECT 1 FROM sqlite_schema WHERE name = 'workflow_task_ledger_events'")
          .get(),
        undefined,
      ),
  );
});

test('cleans the known removed Automation v2 scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-automation-v2-'));
  const databasePath = join(root, 'runtime.sqlite');
  try {
    await copyV016Database(databasePath);
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      DELETE FROM automation_pending_fires;
      DELETE FROM automation_definitions;
      ALTER TABLE automation_definitions DROP COLUMN durable;
      UPDATE operational_schema_migrations SET version = 2 WHERE scope = 'automation';
    `);
    legacy.close();

    const lease = acquireOperationalStateDatabase(root);
    assert.equal(
      lease.database
        .prepare("SELECT 1 FROM operational_schema_migrations WHERE scope = 'automation'")
        .get(),
      undefined,
    );
    lease.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('leaves an oversized released scheduling catalog unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-oversized-catalog-'));
  const databasePath = join(root, 'runtime.sqlite');
  try {
    await copyV016Database(databasePath);
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      WITH RECURSIVE sequence(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1 FROM sequence WHERE value < 256
      )
      INSERT INTO workflow_plan_reminders(reminder_id, created_at, updated_at, record_json)
      SELECT
        'reminder-' || value,
        created_at + value,
        updated_at + value,
        json_set(
          record_json,
          '$.id', 'reminder-' || value,
          '$.createdAt', created_at + value,
          '$.updatedAt', updated_at + value
        )
      FROM workflow_plan_reminders, sequence
      WHERE reminder_id = '60999192-d3b2-45b6-affb-e76355d4cf85';
      DELETE FROM automation_pending_fires;
      DELETE FROM automation_definitions;
    `);
    legacy.close();

    assert.throws(() => acquireOperationalStateDatabase(root), /exceeding the supported 256/);
    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(
      preserved.prepare('SELECT COUNT(*) AS count FROM workflow_plan_reminders').get()?.count,
      257,
    );
    preserved.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not classify a SQLite write failure as a migration blocker', {
  skip:
    process.platform === 'win32'
      ? 'POSIX permissions are required to make the SQLite database read-only'
      : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-readonly-'));
  const databasePath = join(root, 'runtime.sqlite');
  try {
    await copyV016Database(databasePath);
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      DELETE FROM automation_pending_fires;
      DELETE FROM automation_definitions;
    `);
    legacy.close();
    await chmod(databasePath, 0o444);
    assert.throws(
      () => acquireOperationalStateDatabase(root),
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: unknown }).code !== 'operational_state_migration_blocked' &&
        /readonly/i.test(error.message),
    );
  } finally {
    await chmod(databasePath, 0o644).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a contradictory legacy history fact before migration', async () => {
  await assertReleasedReminderRejected(
    'contradictory-history',
    /lastRun contradicts runs/,
    (row) => {
      row.runs = [{ id: 'run-newest', at: 200, status: 'triggered', message: 'newest' }];
      row.lastRun = { id: 'run-other', at: 100, status: 'blocked', message: 'other' };
      row.runCount = 1;
    },
  );
});

test('keeps a released Reminder with an unrepresentable block reason unchanged', async () => {
  await assertReleasedReminderRejected(
    'block-reason',
    /block reason cannot be preserved/,
    (row) => {
      const blockedRun = {
        id: 'blocked-run',
        at: 200,
        status: 'blocked',
        message: 'Incognito mode is active',
        blockReason: 'incognito_active',
      };
      row.runs = [blockedRun];
      row.lastRun = blockedRun;
      row.runCount = 1;
    },
    (row) =>
      assert.equal(
        (row.runs as Array<Record<string, unknown>>)[0]?.blockReason,
        'incognito_active',
      ),
  );
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

function createLegacyCutoverJournal(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE cutover_journal (
      store_name TEXT PRIMARY KEY,
      source_path TEXT NOT NULL,
      source_fingerprint TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('started', 'completed')),
      started_at INTEGER NOT NULL CHECK (started_at >= 0),
      completed_at INTEGER,
      validation_json TEXT
    )
  `);
}

// The exact validation-evidence key set the released session_metadata cutover
// writer emitted (commit 1caea265c^): one row count per copied session-metadata
// table. Kept as an explicit fixture so a drift from the source contract in
// operational-state-store.ts turns this suite red rather than silently
// accepting a narrower shape.
function releasedSessionMetadataValidation(): Record<string, number> {
  return {
    session_metadata: 4,
    session_metadata_labels: 0,
    session_metadata_import_sources: 1,
    session_metadata_tombstones: 0,
    subagent_spawns: 0,
    agent_graph_intent_claims: 0,
    agent_graph_schedule_updates: 0,
    agent_graph_operator_provisions: 0,
    agent_graph_client_projections: 0,
    agent_graph_client_operator_projections: 0,
    agent_graph_client_terminal_activity: 0,
    agent_graph_client_applied_records: 0,
    agent_graph_supervisor_wakes: 0,
    agent_graph_supervisor_wake_attempts: 0,
    sandbox_boundary_log: 0,
  };
}

function createLegacyImportSourceTables(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE runtime_import_sources (
      source_path TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      imported_at INTEGER NOT NULL
    );

    CREATE TABLE session_metadata_import_sources (
      source_path TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      session_id TEXT NOT NULL,
      imported_at INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES session_metadata(session_id) ON DELETE CASCADE
    )
  `);
}

async function copyV016Database(databasePath: string): Promise<void> {
  await copyFile(
    new URL('../../test-fixtures/v0.1.6-operational-state/runtime.sqlite', import.meta.url),
    databasePath,
  );
}

async function assertReleasedReminderRejected(
  name: string,
  message: RegExp,
  mutate: (row: Record<string, unknown>) => void,
  verify: (row: Record<string, unknown>) => void = () => {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `maka-operational-v016-${name}-`));
  const databasePath = join(root, 'runtime.sqlite');
  try {
    await copyV016Database(databasePath);
    const database = new DatabaseSync(databasePath);
    const stored = database.prepare('SELECT record_json FROM workflow_plan_reminders').get() as {
      record_json: string;
    };
    const reminder = JSON.parse(stored.record_json) as Record<string, unknown>;
    mutate(reminder);
    database
      .prepare('UPDATE workflow_plan_reminders SET record_json = ?')
      .run(JSON.stringify(reminder));
    database.exec('DELETE FROM automation_pending_fires; DELETE FROM automation_definitions');
    database.close();

    assert.throws(
      () => acquireOperationalStateDatabase(root),
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: unknown }).code === 'operational_state_migration_blocked' &&
        message.test(error.message),
    );
    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    const preservedRow = preserved
      .prepare('SELECT record_json FROM workflow_plan_reminders')
      .get() as { record_json: string };
    verify(JSON.parse(preservedRow.record_json) as Record<string, unknown>);
    assert.equal(
      preserved
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'workflow_scheduled_tasks'",
        )
        .get(),
      undefined,
    );
    preserved.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function assertCurrentDatabaseRejected(
  name: string,
  mutate: (database: DatabaseSync) => void,
  message: RegExp,
  verify: (database: DatabaseSync) => void = () => {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `maka-operational-${name}-`));
  const databasePath = join(root, 'runtime.sqlite');
  try {
    acquireOperationalStateDatabase(root).close();
    const database = new DatabaseSync(databasePath);
    mutate(database);
    database.close();

    assert.throws(() => acquireOperationalStateDatabase(root), message);
    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    verify(preserved);
    preserved.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
