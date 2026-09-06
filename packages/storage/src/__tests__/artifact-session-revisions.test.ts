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
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import type { ArtifactRecord } from '@maka/core/artifacts';
import { createSqliteArtifactStoreWriteAuthority } from '../artifact-store.js';
import {
  acquireOperationalStateDatabase,
  OPERATIONAL_STATE_DATABASE_NAME,
} from '../operational-state-store.js';
import { createSqliteArtifactMetadataRepository } from '../sqlite-artifact-metadata.js';
import { migrateSqliteArtifactDatabase } from '../sqlite-artifact-schema.js';

for (const scope of ['target', 'other'] as const) {
  const count = 12_000;
  test(`get plus revision stays bounded with ${count} ${scope}-Session records`, async (t) => {
    await withStores(async ({ store, repository, database }) => {
      const target = record('target');
      repository.applyChanges({ upserts: [target] });
      const initialRevision = repository.getSessionRevision('session');
      repository.applyChanges({
        upserts: Array.from({ length: count }, (_, i) =>
          record(`growth-${i}`, scope === 'target' ? 'session' : 'other'),
        ),
      });
      const revision = repository.getSessionRevision('session');
      if (scope === 'other') assert.equal(revision, initialRevision);
      else assert.notEqual(revision, initialRevision);

      const counts = countReads(t, database);
      const entry = await store.getInSession('session', 'target');
      assert.deepEqual(counts.read(), { artifactRows: 1, revisionRows: 1, decodes: 1 });
      assert.deepEqual(entry, { record: target, revision });
      counts.reset();
      assert.deepEqual(await store.getInSession('session', 'missing'), {
        record: null,
        revision,
      });
      assert.deepEqual(counts.read(), { artifactRows: 0, revisionRows: 1, decodes: 0 });
      counts.reset();
      assert.deepEqual(await store.getInSession('other', 'target'), {
        record: null,
        revision: repository.getSessionRevision('other'),
      });
      assert.equal(counts.read().decodes, 1);
    });
  });
}

for (const count of [10, 12_000]) {
  test(`revision maintenance does not read or rewrite ${count} unchanged Session records`, async (t) => {
    await withStores(async ({ repository, database }) => {
      const target = record('target');
      repository.applyChanges({
        upserts: [target, ...Array.from({ length: count }, (_, i) => record(`background-${i}`))],
      });
      database.exec(`
        CREATE TABLE revision_write_audit(kind TEXT);
        CREATE TRIGGER audit_record_update AFTER UPDATE ON artifact_records
        BEGIN INSERT INTO revision_write_audit VALUES ('record'); END;
        CREATE TRIGGER audit_revision_update AFTER UPDATE ON artifact_session_revisions
        BEGIN INSERT INTO revision_write_audit VALUES ('revision'); END;
      `);
      const counts = countReads(t, database);
      const changed = { ...target, summary: 'changed' };
      repository.applyChanges({ upserts: [changed] });
      assert.deepEqual(counts.read(), { artifactRows: 0, revisionRows: 0, decodes: 0 });
      assert.deepEqual(
        database
          .prepare('SELECT kind FROM revision_write_audit ORDER BY kind')
          .all()
          .map(({ kind }) => kind),
        ['record', 'revision'],
      );
      database.exec('DELETE FROM revision_write_audit');
      repository.applyChanges({ upserts: [changed], deleteIds: ['missing'] });
      assert.deepEqual(database.prepare('SELECT kind FROM revision_write_audit').all(), []);
      assert.deepEqual(counts.read(), { artifactRows: 0, revisionRows: 0, decodes: 0 });
    });
  });
}

test('revision index lookups and empty-Session checks use indexed searches', async () => {
  await withStores(async ({ database }) => {
    for (const query of [
      'SELECT record_json FROM artifact_records WHERE artifact_id = ?',
      'SELECT revision_token FROM artifact_session_revisions WHERE session_id = ?',
      'SELECT 1 FROM artifact_records WHERE session_id = ? LIMIT 1',
    ]) {
      const plan = database.prepare(`EXPLAIN QUERY PLAN ${query}`).all('session');
      assert.ok(
        plan.every(({ detail }) => /SEARCH .*USING .*INDEX/.test(String(detail))),
        JSON.stringify(plan),
      );
    }
  });
});

test('revision changes atomically, preserves no-ops, and does not reuse a nonempty content revision', async () => {
  await withStores(async ({ repository, database }) => {
    const empty = repository.getSessionRevision('session');
    const original = record('target');
    const sibling = record('sibling');
    repository.applyChanges({ upserts: [original, sibling] });
    const initial = repository.getSessionRevision('session');
    repository.applyChanges({ upserts: [original], deleteIds: ['missing'] });
    database.exec('UPDATE artifact_records SET record_json = record_json');
    assert.equal(repository.getSessionRevision('session'), initial);

    assert.throws(
      () =>
        repository.applyChanges({
          upserts: [
            { ...original, summary: 'must roll back' },
            { ...record('conflict'), relativePath: sibling.relativePath },
          ],
        }),
      /UNIQUE/,
    );
    assert.equal(repository.getSessionRevision('session'), initial);
    assert.deepEqual(repository.getById(original.id), original);
    database.exec('BEGIN IMMEDIATE');
    database.prepare('DELETE FROM artifact_records WHERE artifact_id = ?').run(original.id);
    database.exec('ROLLBACK');
    assert.equal(repository.getSessionRevision('session'), initial);

    repository.applyChanges({ upserts: [{ ...original, summary: 'changed' }] });
    const changed = repository.getSessionRevision('session');
    assert.notEqual(changed, initial);
    repository.applyChanges({ upserts: [original] });
    const restored = repository.getSessionRevision('session');
    assert.notEqual(restored, changed);
    assert.notEqual(restored, initial);
    repository.applyChanges({ deleteIds: [original.id, sibling.id] });
    assert.equal(repository.getSessionRevision('session'), empty);
    assert.equal(
      database.prepare('SELECT count(*) AS n FROM artifact_session_revisions').get()?.n,
      0,
    );
    repository.applyChanges({ upserts: [original, sibling] });
    assert.notEqual(repository.getSessionRevision('session'), initial);
  });
});

test('moving a record invalidates both Sessions and drops an emptied Session revision', async () => {
  await withStores(async ({ repository }) => {
    const empty = repository.getSessionRevision('empty');
    const first = record('first');
    const sibling = record('sibling');
    repository.applyChanges({ upserts: [first, sibling, record('destination', 'other')] });
    const beforeSource = repository.getSessionRevision('session');
    const beforeDestination = repository.getSessionRevision('other');
    repository.applyChanges({ upserts: [record('first', 'other')] });
    assert.notEqual(repository.getSessionRevision('session'), beforeSource);
    assert.notEqual(repository.getSessionRevision('other'), beforeDestination);
    repository.applyChanges({ upserts: [record('sibling', 'other')] });
    assert.equal(repository.getSessionRevision('session'), empty);
    assert.equal(repository.listBySession('other').length, 3);
  });
});

for (const kind of ['get', 'page'] as const) {
  test(`${kind} returns metadata and revision from one snapshot across a concurrent commit`, async (t) => {
    await withStores(async ({ root, store, repository, database }) => {
      const original = record('target');
      const changed = { ...original, summary: 'new commit' };
      repository.applyChanges({ upserts: [original] });
      const beforeRevision = repository.getSessionRevision('session');
      const writer = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
      try {
        let committed = false;
        const prepare = database.prepare.bind(database);
        t.mock.method(database, 'prepare', (sql: string) => {
          const statement = prepare(sql);
          if (/SELECT/.test(sql) && /FROM artifact_records\b/.test(sql)) {
            const method = kind === 'get' ? 'get' : 'all';
            const read = statement[method].bind(statement);
            t.mock.method(statement, method, (...params: SQLInputValue[]) => {
              const result = read(...params);
              if (!committed) {
                committed = true;
                writer
                  .prepare('UPDATE artifact_records SET record_json = ? WHERE artifact_id = ?')
                  .run(JSON.stringify(changed), original.id);
              }
              return result;
            });
          }
          return statement;
        });
        if (kind === 'get') {
          assert.deepEqual(await store.getInSession('session', original.id), {
            record: original,
            revision: beforeRevision,
          });
        } else {
          assert.deepEqual(await store.listPage('session', { offset: 0, limit: 1 }), {
            records: [original],
            total: 1,
            revision: beforeRevision,
          });
        }
        assert.equal(committed, true);
        const after = await store.getInSession('session', original.id);
        assert.deepEqual(after.record, changed);
        assert.notEqual(after.revision, beforeRevision);
      } finally {
        writer.close();
      }
    });
  });
}

test('an already-open reader observes a child process commit and the same revision after reopen', async () => {
  await withStores(async ({ root, store, repository }) => {
    const original = record('target');
    repository.applyChanges({ upserts: [original] });
    const before = await store.getInSession('session', original.id);
    const changed = { ...original, summary: 'child commit' };
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      const { createSqliteArtifactMetadataRepository } = await import(process.argv[1]);
      const repository = createSqliteArtifactMetadataRepository(process.argv[2]);
      try {
        repository.applyChanges({ upserts: [JSON.parse(process.argv[3])] });
        process.stdout.write(repository.getSessionRevision('session'));
      } finally { repository.close(); }
    `,
        new URL('../sqlite-artifact-metadata.js', import.meta.url).href,
        root,
        JSON.stringify(changed),
      ],
      {
        encoding: 'utf8',
        timeout: 10_000,
        env: { ...process.env, NODE_NO_WARNINGS: '1' },
      },
    );
    assert.equal(child.status, 0, child.stderr || String(child.error));
    const after = await store.getInSession('session', original.id);
    assert.deepEqual(after.record, changed);
    assert.notEqual(after.revision, before.revision);
    assert.equal(after.revision, child.stdout);
    const reopened = createSqliteArtifactMetadataRepository(root);
    try {
      assert.equal(reopened.getSessionRevision('session'), after.revision);
    } finally {
      reopened.close();
    }
  });
});

test('invalid metadata stays hidden but conservatively invalidates the Session revision', async () => {
  await withStores(async ({ store, repository, database }) => {
    repository.applyChanges({ upserts: [record('target')] });
    const before = repository.getSessionRevision('session');
    database
      .prepare('UPDATE artifact_records SET record_json = ? WHERE artifact_id = ?')
      .run('{', 'target');
    const entry = await store.getInSession('session', 'target');
    assert.equal(entry.record, null);
    assert.notEqual(entry.revision, before);
    const page = await store.listPage('session', { offset: 0, limit: 10 });
    assert.equal(page.total, 0);
    assert.equal(page.revision, entry.revision);
    database.prepare('DELETE FROM artifact_session_revisions WHERE session_id = ?').run('session');
    await assert.rejects(store.getInSession('session', 'target'), /revision is missing/);
  });
});

test('v3 migration backfills Session tokens without decoding records and retains them on later migrations', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-artifact-revision-migrate-'));
  const path = join(root, OPERATIONAL_STATE_DATABASE_NAME);
  try {
    const repository = createSqliteArtifactMetadataRepository(root);
    const records = [record('one'), record('two'), record('three', 'other')];
    repository.applyChanges({ upserts: records });
    repository.close();
    const legacy = new DatabaseSync(path);
    const originalRows = legacy
      .prepare('SELECT * FROM artifact_records ORDER BY artifact_id')
      .all();
    rewindArtifactSchema(legacy);
    legacy.close();
    const jsons = new Set(records.map((item) => JSON.stringify(item)));
    const parse = JSON.parse;
    t.mock.method(JSON, 'parse', (...args: Parameters<typeof JSON.parse>) => {
      assert.equal(jsons.has(args[0]), false, 'migration must not decode existing Artifact JSON');
      return parse(...args);
    });
    const migrated = acquireOperationalStateDatabase(root);
    try {
      assert.deepEqual(
        migrated.database.prepare('SELECT * FROM artifact_records ORDER BY artifact_id').all(),
        originalRows,
      );
      assert.equal(
        migrated.database
          .prepare("SELECT version FROM operational_schema_migrations WHERE scope = 'artifact'")
          .get()?.version,
        4,
      );
      const tokens = migrated.database
        .prepare('SELECT * FROM artifact_session_revisions ORDER BY session_id')
        .all();
      assert.equal(tokens.length, 2);
      migrateSqliteArtifactDatabase(migrated.database);
      assert.deepEqual(
        migrated.database
          .prepare('SELECT * FROM artifact_session_revisions ORDER BY session_id')
          .all(),
        tokens,
      );
    } finally {
      migrated.close();
    }
    t.mock.restoreAll();
    const reopened = createSqliteArtifactMetadataRepository(root);
    try {
      assert.deepEqual(reopened.getById('one'), records[0]);
      const revision = reopened.getSessionRevision('session');
      reopened.applyChanges({ upserts: [{ ...records[0]!, summary: 'post-migration write' }] });
      assert.notEqual(reopened.getSessionRevision('session'), revision);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed v3 migration rolls back revision state, triggers and schema version together', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-artifact-revision-rollback-'));
  try {
    const repository = createSqliteArtifactMetadataRepository(root);
    repository.applyChanges({ upserts: [record('target')] });
    repository.close();
    const legacy = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
    try {
      rewindArtifactSchema(legacy);
      legacy.exec('CREATE TABLE unexpected_migration_blocker(value TEXT)');
      assert.throws(() => acquireOperationalStateDatabase(root), /unexpected schema object/);
      assert.equal(
        legacy
          .prepare("SELECT version FROM operational_schema_migrations WHERE scope = 'artifact'")
          .get()?.version,
        3,
      );
      assert.deepEqual(
        legacy
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name = 'artifact_session_revisions' OR name LIKE 'artifact_revision_after_%'",
          )
          .all(),
        [],
      );
      assert.equal(legacy.prepare('SELECT count(*) AS n FROM artifact_records').get()?.n, 1);
    } finally {
      legacy.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function rewindArtifactSchema(database: DatabaseSync): void {
  database.exec(`
    DROP TRIGGER artifact_revision_after_insert;
    DROP TRIGGER artifact_revision_after_update;
    DROP TRIGGER artifact_revision_after_delete;
    DROP TABLE artifact_session_revisions;
    UPDATE operational_schema_migrations SET version = 3 WHERE scope = 'artifact';
  `);
}

function record(id: string, sessionId = 'session'): ArtifactRecord {
  return {
    id,
    sessionId,
    turnId: 'turn',
    name: 'record.txt',
    kind: 'file',
    source: 'tool_result',
    createdAt: 1,
    sizeBytes: 1,
    relativePath: `${sessionId}/${id}-record.txt`,
  };
}

async function withStores(
  operation: (fixture: {
    root: string;
    store: ReturnType<typeof createSqliteArtifactStoreWriteAuthority>['store'];
    repository: ReturnType<typeof createSqliteArtifactMetadataRepository>;
    database: DatabaseSync;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-artifact-revisions-'));
  const authority = createSqliteArtifactStoreWriteAuthority(root);
  const repository = createSqliteArtifactMetadataRepository(root);
  const lease = acquireOperationalStateDatabase(root);
  try {
    await operation({ root, store: authority.store, repository, database: lease.database });
  } finally {
    lease.close();
    repository.close();
    authority.close();
    await rm(root, { recursive: true, force: true });
  }
}

function countReads(t: TestContext, database: DatabaseSync) {
  let artifactRows = 0;
  let revisionRows = 0;
  let decodes = 0;
  const prepare = database.prepare.bind(database);
  t.mock.method(database, 'prepare', (sql: string) => {
    const statement = prepare(sql);
    if (/SELECT/.test(sql) && /FROM artifact_(records|session_revisions)\b/.test(sql)) {
      for (const method of ['get', 'all'] as const) {
        const read = statement[method].bind(statement);
        t.mock.method(statement, method, (...params: SQLInputValue[]) => {
          const result = read(...params);
          const count = Array.isArray(result) ? result.length : result ? 1 : 0;
          if (/FROM artifact_records\b/.test(sql)) artifactRows += count;
          else revisionRows += count;
          return result;
        });
      }
    }
    return statement;
  });
  const parse = JSON.parse;
  t.mock.method(JSON, 'parse', (...args: Parameters<typeof JSON.parse>) => {
    const parsed = parse(...args);
    if (parsed && typeof parsed.relativePath === 'string') decodes++;
    return parsed;
  });
  return {
    read: () => ({ artifactRows, revisionRows, decodes }),
    reset: () => {
      artifactRows = revisionRows = decodes = 0;
    },
  };
}
