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
      preserved.prepare('SELECT record_json FROM workflow_plan_reminders').get()?.record_json,
      reminder,
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

test('rolls back a released upgrade when the final target schema is incompatible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-target-rollback-'));
  const databasePath = join(root, 'runtime.sqlite');
  try {
    await copyV016Database(databasePath);
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      DELETE FROM automation_pending_fires;
      DELETE FROM automation_definitions;
      DROP TABLE usage_pricing_overrides;
      CREATE TABLE usage_pricing_overrides (model_key TEXT PRIMARY KEY);
    `);
    const versions = legacy
      .prepare(
        'SELECT scope, version, applied_at FROM operational_schema_migrations ORDER BY scope',
      )
      .all();
    legacy.close();

    assert.throws(
      () => acquireOperationalStateDatabase(root),
      /usage_pricing_overrides is missing required column record_json/,
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
    assert.ok(
      preserved.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'workflow_plan_reminders'").get(),
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

test('reapplies current Workflow authority tables without republishing its registry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-missing-scheduled-tasks-'));
  try {
    const lease = acquireOperationalStateDatabase(root);
    const registry = lease.database
      .prepare(
        "SELECT version, applied_at FROM operational_schema_migrations WHERE scope = 'workflow'",
      )
      .get();
    lease.database.exec(`
      DROP TABLE workflow_scheduled_task_fires;
      DROP TABLE workflow_scheduled_tasks;
    `);
    lease.close();

    const reopened = acquireOperationalStateDatabase(root);
    for (const table of ['workflow_scheduled_task_fires', 'workflow_scheduled_tasks']) {
      assert.ok(
        reopened.database
          .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get(table),
      );
    }
    assert.deepEqual(
      reopened.database
        .prepare(
          "SELECT version, applied_at FROM operational_schema_migrations WHERE scope = 'workflow'",
        )
        .get(),
      registry,
    );
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a current Runtime schema whose versioned authority table is missing', async () => {
  await assertCurrentDatabaseRejected(
    'missing-runtime-authority',
    (database) => database.exec('DROP TABLE runtime_session_event_ordinals'),
    /missing required table runtime_session_event_ordinals/,
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

for (const { name, mutation, message } of [
  {
    name: 'a current authority table with a missing required column',
    mutation: (database: DatabaseSync) =>
      database.exec(`
        DROP TABLE usage_llm_calls;
        CREATE TABLE usage_llm_calls (
          storage_key TEXT PRIMARY KEY,
          id TEXT NOT NULL,
          ts INTEGER NOT NULL CHECK (ts >= 0)
        );
      `),
    message: /usage_llm_calls is missing required column record_json/,
  },
  {
    name: 'a current authority index with incompatible key columns',
    mutation: (database: DatabaseSync) =>
      database.exec(`
        DROP INDEX usage_llm_calls_ts;
        CREATE INDEX usage_llm_calls_ts ON usage_llm_calls(id);
      `),
    message: /required index usage_llm_calls_ts has an incompatible definition/,
  },
  {
    name: 'a current authority index with an incompatible predicate',
    mutation: (database: DatabaseSync) =>
      database.exec(`
        DROP INDEX artifact_records_relative_path;
        CREATE UNIQUE INDEX artifact_records_relative_path
          ON artifact_records(relative_path)
          WHERE status = 'live';
      `),
    message: /required index artifact_records_relative_path has an incompatible definition/,
  },
  {
    name: 'a current authority table with missing key and check constraints',
    mutation: (database: DatabaseSync) =>
      database.exec(`
        DROP TABLE usage_pricing_authority;
        CREATE TABLE usage_pricing_authority (singleton INTEGER, revision INTEGER);
      `),
    message: /usage_pricing_authority column singleton has an incompatible definition/,
  },
  {
    name: 'a current authority table with a missing foreign key',
    mutation: (database: DatabaseSync) =>
      database.exec(`
        DROP TABLE core_agent_run_events;
        CREATE TABLE core_agent_run_events (
          session_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          sequence INTEGER NOT NULL CHECK (sequence >= 0),
          event_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          event_ts INTEGER NOT NULL,
          record_json TEXT NOT NULL,
          PRIMARY KEY (session_id, run_id, sequence)
        );
      `),
    message: /core_agent_run_events is missing required foreign key/,
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
    message: /artifact_records is missing required check/,
  },
  {
    name: 'a current authority table with a quoted decoy check',
    mutation: (database: DatabaseSync) =>
      database.exec(`
        DROP TABLE usage_llm_calls;
        CREATE TABLE usage_llm_calls (
          storage_key TEXT PRIMARY KEY,
          id TEXT NOT NULL,
          ts INTEGER NOT NULL,
          record_json TEXT NOT NULL,
          decoy TEXT DEFAULT 'CHECK (ts >= 0)'
        );
      `),
    message: /usage_llm_calls is missing required check/,
  },
  {
    name: 'a current authority trigger with an incompatible definition',
    mutation: (database: DatabaseSync) =>
      database.exec(`
        DROP TRIGGER session_catalog_after_insert;
        CREATE TRIGGER session_catalog_after_insert
        AFTER INSERT ON session_metadata
        BEGIN
          SELECT 1;
        END;
      `),
    message: /required trigger session_catalog_after_insert has an incompatible definition/,
  },
] as const) {
  test(`rejects ${name}`, async () => {
    await assertCurrentDatabaseRejected(name.replaceAll(' ', '-'), mutation, message);
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
