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
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  migrateLegacyDailyReview,
  openLegacyDailyReviewMigrationForWrite,
} from '../legacy-daily-review-migration.js';
import { openInteractiveScheduledTaskStoreForWrite } from '../scheduled-task-store.js';
import { openInteractiveRuntimePolicyStoresForWrite } from '../runtime-policy-stores.js';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '../root-authority.js';
import {
  removeTrackedControlDirectories,
  trackControlDirectory,
} from './fixtures/control-directory-hygiene.js';

after(removeTrackedControlDirectories);

test('reads the released file Daily Review config and archives', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-daily-review-file-migration-'));
  const root = join(base, 'root');
  const capability = trackControlDirectory(
    await resolveStorageRoot({ path: root, kind: 'interactive' }),
  );
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  const scheduledTasks = await openInteractiveScheduledTaskStoreForWrite(owner.lease);
  const archiveRoot = join(root, 'daily-reviews', 'archive');
  const archive = {
    id: '2026-08-28-deep',
    day: { fromMs: 1_772_140_800_000, toMs: 1_772_227_200_000 },
    mode: 'deep',
    status: 'ok',
    generatedAt: 1_772_227_200_001,
    trigger: 'cron',
    modelKey: '',
    sections: { summary: 'A released file report.' },
    totals: {
      sessionCount: 2,
      requestCount: 3,
      totalTokens: 4,
      costUsd: 0.01,
      errorCount: 0,
    },
  };
  try {
    await mkdir(archiveRoot, { recursive: true });
    await writeFile(
      join(root, 'daily-reviews', 'config.json'),
      JSON.stringify({
        enabled: true,
        executeTime: '09:30',
        modelKey: 'openrouter::openrouter/free',
        deepEnabled: true,
      }),
    );
    await writeFile(join(archiveRoot, `${archive.id}.json`), JSON.stringify(archive));
    await writeFile(join(archiveRoot, '2026-08-27-1d.json'), '{');

    const migration = await openLegacyDailyReviewMigrationForWrite(owner.lease);
    const snapshot = await migration.read();

    assert.deepEqual(snapshot?.config, {
      enabled: true,
      executeTime: '09:30',
      modelKey: 'openrouter::openrouter/free',
    });
    assert.deepEqual(snapshot?.archives, [
      {
        id: archive.id,
        day: archive.day,
        range: 7,
        status: archive.status,
        generatedAt: archive.generatedAt,
        trigger: archive.trigger,
        modelKey: archive.modelKey,
        sections: archive.sections,
        totals: archive.totals,
      },
    ]);
    migration.close();
  } finally {
    scheduledTasks.close();
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('uses an existing runnable user Daily Review task as the legacy replacement', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-daily-review-user-task-'));
  const root = join(base, 'root');
  const capability = trackControlDirectory(
    await resolveStorageRoot({ path: root, kind: 'interactive' }),
  );
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  const scheduledTasks = await openInteractiveScheduledTaskStoreForWrite(owner.lease);
  const runtimePolicy = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
  const database = new DatabaseSync(join(root, 'runtime.sqlite'));
  try {
    installLegacyDailyReviewTables(database);
    database
      .prepare('INSERT INTO workflow_daily_review_state(singleton, config_json) VALUES (1, ?)')
      .run(
        JSON.stringify({
          enabled: true,
          executeTime: '23:59',
          modelKey: 'fake::fake-model',
        }),
      );
    const catalog = await runtimePolicy.connectionCatalog.getSnapshot();
    const createdConnection = await runtimePolicy.connectionCatalog.create({
      expectedCatalogRevision: catalog.revision,
      connection: {
        slug: 'fake',
        name: 'Daily Review migration fixture',
        providerType: 'moonshot',
        enabled: true,
        enabledModelIds: ['fake-model'],
      },
    });
    assert.equal(createdConnection.kind, 'committed');
    if (createdConnection.kind !== 'committed') return;
    const connection = createdConnection.snapshot.connections.find(({ slug }) => slug === 'fake');
    assert.ok(connection);
    if (!connection) return;
    assert.equal(
      (
        await runtimePolicy.credentialVault.set({
          locator: {
            scope: 'connection',
            connectionId: connection.connectionId,
            kind: 'api_key',
          },
          expected: null,
          secret: 'daily-review-migration-key',
        })
      ).kind,
      'committed',
    );
    const existing = await scheduledTasks.create({
      presetId: 'daily-review',
      title: 'My Daily Review',
      intentBody: 'Review my work.',
      schedule: { kind: 'calendar', recurrence: 'daily', anchorAt: Date.now(), catchUp: 'once' },
      effect: {
        kind: 'agent_run',
        execution: {
          cwd: root,
          projectId: null,
          llmConnectionId: connection.connectionId,
          llmConnectionSlug: connection.slug,
          model: 'fake-model',
          permissionMode: 'ask',
          collaborationMode: 'agent',
          orchestrationMode: 'default',
        },
      },
      createdBy: { kind: 'user' },
    });
    const legacy = await openLegacyDailyReviewMigrationForWrite(owner.lease);

    assert.equal(
      await migrateLegacyDailyReview({
        legacy,
        scheduledTasks,
        sessions: null as never,
        artifacts: null as never,
        runtimePolicy,
        workspaceRoot: root,
        now: () => new Date(2026, 7, 30, 12, 0).getTime(),
      }),
      true,
    );
    assert.equal(await legacy.read(), null);
    assert.deepEqual(
      (await scheduledTasks.list()).map((task) => task.id),
      [existing.id],
    );
    legacy.close();
  } finally {
    database.close();
    scheduledTasks.close();
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('keeps legacy config when a user Daily Review task is not an Agent run', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-daily-review-user-conflict-'));
  const root = join(base, 'root');
  const capability = trackControlDirectory(
    await resolveStorageRoot({ path: root, kind: 'interactive' }),
  );
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  const scheduledTasks = await openInteractiveScheduledTaskStoreForWrite(owner.lease);
  const runtimePolicy = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
  const database = new DatabaseSync(join(root, 'runtime.sqlite'));
  try {
    installLegacyDailyReviewTables(database);
    database
      .prepare('INSERT INTO workflow_daily_review_state(singleton, config_json) VALUES (1, ?)')
      .run(JSON.stringify({ enabled: true, executeTime: '08:00', modelKey: '' }));
    const existing = await scheduledTasks.create({
      presetId: 'daily-review',
      title: 'Daily reminder',
      intentBody: '',
      schedule: { kind: 'interval', everySeconds: 86_400, startAt: Date.now() + 60_000 },
      effect: { kind: 'notify', channel: 'local' },
      createdBy: { kind: 'user' },
    });
    const legacy = await openLegacyDailyReviewMigrationForWrite(owner.lease);

    assert.equal(
      await migrateLegacyDailyReview({
        legacy,
        scheduledTasks,
        sessions: null as never,
        artifacts: null as never,
        runtimePolicy,
        workspaceRoot: root,
      }),
      false,
    );
    assert.ok(await legacy.read());
    assert.deepEqual(
      (await scheduledTasks.list()).map((task) => task.id),
      [existing.id],
    );
    legacy.close();
  } finally {
    database.close();
    scheduledTasks.close();
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('reads released Daily Review config and archives without changing legacy rows', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-daily-review-migration-'));
  const root = join(base, 'root');
  const capability = trackControlDirectory(
    await resolveStorageRoot({ path: root, kind: 'interactive' }),
  );
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  const scheduledTasks = await openInteractiveScheduledTaskStoreForWrite(owner.lease);
  const database = new DatabaseSync(join(root, 'runtime.sqlite'));
  try {
    installLegacyDailyReviewTables(database);
    const config = {
      enabled: true,
      executeTime: '09:30',
      modelKey: 'openrouter::openrouter/free',
    };
    const archive = {
      id: '2026-08-28-1d',
      day: { fromMs: 1_772_140_800_000, toMs: 1_772_227_200_000 },
      range: 1,
      status: 'ok',
      generatedAt: 1_772_227_200_001,
      trigger: 'cron',
      modelKey: config.modelKey,
      sections: { summary: 'A durable report.' },
      totals: {
        sessionCount: 2,
        requestCount: 3,
        totalTokens: 4,
        costUsd: 0.01,
        errorCount: 0,
      },
    };
    database
      .prepare('INSERT INTO workflow_daily_review_state(singleton, config_json) VALUES (1, ?)')
      .run(JSON.stringify(config));
    database
      .prepare(
        'INSERT INTO workflow_daily_review_authority_state(singleton, revision) VALUES (1, 7)',
      )
      .run();
    database
      .prepare(
        `INSERT INTO workflow_daily_review_archives(
          archive_id, generated_at, day_from_ms, record_json
        ) VALUES (?, ?, ?, ?)`,
      )
      .run(archive.id, archive.generatedAt, archive.day.fromMs, JSON.stringify(archive));

    const migration = await openLegacyDailyReviewMigrationForWrite(owner.lease);
    const snapshot = await migration.read();

    assert.deepEqual(snapshot?.config, config);
    assert.deepEqual(snapshot?.archives, [archive]);
    assert.match(snapshot?.token ?? '', /^sha256:[a-f0-9]{64}$/u);
    assert.equal(rowCount(database, 'workflow_daily_review_state'), 1);
    assert.equal(rowCount(database, 'workflow_daily_review_archives'), 1);
    migration.close();
  } finally {
    database.close();
    scheduledTasks.close();
    if (owner) await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('retires the released two-table Daily Review layout', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-daily-review-two-table-'));
  const root = join(base, 'root');
  const capability = trackControlDirectory(
    await resolveStorageRoot({ path: root, kind: 'interactive' }),
  );
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  const scheduledTasks = await openInteractiveScheduledTaskStoreForWrite(owner.lease);
  const database = new DatabaseSync(join(root, 'runtime.sqlite'));
  try {
    installLegacyDailyReviewTables(database, { authority: false });
    const config = { enabled: false, executeTime: '08:00', modelKey: '' };
    database
      .prepare('INSERT INTO workflow_daily_review_state(singleton, config_json) VALUES (1, ?)')
      .run(JSON.stringify(config));

    const migration = await openLegacyDailyReviewMigrationForWrite(owner.lease);
    const snapshot = await migration.read();

    assert.deepEqual(snapshot?.config, config);
    assert.equal(snapshot?.archives.length, 0);
    assert.ok(snapshot);
    if (!snapshot) return;
    assert.equal(await migration.retire(snapshot.token), true);
    assert.equal(await migration.read(), null);
    assert.equal(tableExists(database, 'workflow_daily_review_state'), false);
    assert.equal(tableExists(database, 'workflow_daily_review_archives'), false);
    migration.close();
  } finally {
    database.close();
    scheduledTasks.close();
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('retires legacy tables only for the exact migrated snapshot', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-daily-review-retirement-'));
  const root = join(base, 'root');
  const capability = trackControlDirectory(
    await resolveStorageRoot({ path: root, kind: 'interactive' }),
  );
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  const scheduledTasks = await openInteractiveScheduledTaskStoreForWrite(owner.lease);
  const database = new DatabaseSync(join(root, 'runtime.sqlite'));
  try {
    installLegacyDailyReviewTables(database);
    database
      .prepare('INSERT INTO workflow_daily_review_state(singleton, config_json) VALUES (1, ?)')
      .run(JSON.stringify({ enabled: false, executeTime: '08:00', modelKey: '' }));
    const migration = await openLegacyDailyReviewMigrationForWrite(owner.lease);
    const snapshot = await migration.read();
    assert.ok(snapshot);
    if (!snapshot) return;

    await assert.rejects(migration.retire(`sha256:${'0'.repeat(64)}`), /changed during migration/);
    assert.equal(tableExists(database, 'workflow_daily_review_state'), true);

    assert.equal(await migration.retire(snapshot.token), true);
    assert.equal(await migration.read(), null);
    assert.equal(tableExists(database, 'workflow_daily_review_state'), false);
    assert.equal(tableExists(database, 'workflow_daily_review_authority_state'), false);
    assert.equal(tableExists(database, 'workflow_daily_review_archives'), false);
    migration.close();
  } finally {
    database.close();
    scheduledTasks.close();
    if (owner) await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('does not recreate retired Daily Review tables when the workspace reopens', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-daily-review-reopen-'));
  const root = join(base, 'root');
  const capability = trackControlDirectory(
    await resolveStorageRoot({ path: root, kind: 'interactive' }),
  );
  let owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  let scheduledTasks = await openInteractiveScheduledTaskStoreForWrite(owner.lease);
  let database = new DatabaseSync(join(root, 'runtime.sqlite'));
  try {
    installLegacyDailyReviewTables(database);
    const migration = await openLegacyDailyReviewMigrationForWrite(owner.lease);
    const snapshot = await migration.read();
    assert.ok(snapshot);
    if (!snapshot) return;
    await migration.retire(snapshot.token);
    migration.close();
    database.close();
    scheduledTasks.close();
    await owner.close();

    owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    if (!owner) return;
    scheduledTasks = await openInteractiveScheduledTaskStoreForWrite(owner.lease);
    database = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true });
    assert.equal(tableExists(database, 'workflow_daily_review_state'), false);
  } finally {
    database.close();
    scheduledTasks.close();
    if (owner) await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});

function rowCount(database: DatabaseSync, table: string): number {
  const row = database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return Boolean(
    database
      .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .get(table),
  );
}

function installLegacyDailyReviewTables(
  database: DatabaseSync,
  options: { readonly authority?: boolean } = {},
): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS workflow_daily_review_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      config_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_daily_review_archives (
      archive_id TEXT PRIMARY KEY,
      generated_at INTEGER NOT NULL,
      day_from_ms INTEGER NOT NULL,
      record_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS workflow_daily_review_archives_order
      ON workflow_daily_review_archives(generated_at DESC, day_from_ms DESC, archive_id);
  `);
  if (options.authority !== false) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS workflow_daily_review_authority_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision INTEGER NOT NULL CHECK (revision >= 0)
      );
    `);
  }
}
