import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chmod, link, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { Worker } from 'node:worker_threads';
import {
  MemoryItemStoreConflictError,
  type MemoryItemSource,
  type MemoryItemWrite,
} from '@maka/core/long-term-memory';
import {
  LONG_TERM_MEMORY_DATABASE_NAME,
  authenticateInteractiveLongTermMemoryWriter,
  openInteractiveLongTermMemoryStoreForWrite,
} from '../long-term-memory-store.js';
import {
  createHeadlessRootLease,
  resolveStorageRoot,
  STORAGE_ROOT_MARKER_FILE,
  tryAcquireInteractiveRootOwner,
} from '../root-authority.js';
import { SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION } from '../sqlite-long-term-memory-schema.js';
import {
  SqliteMemoryItemStore,
  type SqliteMemoryItemStoreFailpoint,
} from '../sqlite-long-term-memory-store.js';

const require = createRequire(import.meta.url);

describe('SqliteMemoryItemStore', () => {
  test('creates a private, versioned WAL database and reopens it idempotently', async () => {
    await withStore(async ({ store, databasePath }) => {
      assert.equal(store.schemaVersion(), SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION);
      assert.equal(store.journalMode(), 'wal');
      assert.equal(store.foreignKeysEnabled(), true);
      if (process.platform !== 'win32') {
        assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
        for (const sidecar of [`${databasePath}-wal`, `${databasePath}-shm`]) {
          assert.equal((await stat(sidecar)).mode & 0o777, 0o600);
        }
      }
      store.close();

      const reopened = new SqliteMemoryItemStore(databasePath);
      try {
        assert.equal(reopened.schemaVersion(), SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION);
        assert.equal(await reopened.readItem('missing-item'), undefined);
      } finally {
        reopened.close();
      }
    });
  });

  test('rolls back a failed migration and rejects a newer unknown schema without changing it', async () => {
    await withTempRoot(async (root) => {
      const failedPath = join(root, 'failed.sqlite');
      assert.throws(
        () =>
          new SqliteMemoryItemStore(failedPath, {
            migrationFailpoint: () => {
              throw new Error('migration failure');
            },
          }),
        /migration failure/,
      );
      const recovered = new SqliteMemoryItemStore(failedPath);
      assert.equal(recovered.schemaVersion(), SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION);
      recovered.close();

      const newerPath = join(root, 'newer.sqlite');
      const Database = loadDatabaseSync();
      const newer = new Database(newerPath);
      newer.exec('PRAGMA user_version = 99');
      const originalJournalMode = String(
        (newer.prepare('PRAGMA journal_mode').get() as { journal_mode?: unknown }).journal_mode,
      );
      newer.close();
      assert.throws(() => new SqliteMemoryItemStore(newerPath), /newer than supported/);
      const unchanged = new Database(newerPath);
      try {
        assert.equal(
          (unchanged.prepare('PRAGMA user_version').get() as { user_version?: unknown })
            .user_version,
          99,
        );
        assert.equal(
          String(
            (unchanged.prepare('PRAGMA journal_mode').get() as { journal_mode?: unknown })
              .journal_mode,
          ),
          originalJournalMode,
        );
      } finally {
        unchanged.close();
      }
    });
  });

  test('rejects current-version databases with missing required tables or columns', async () => {
    await withTempRoot(async (root) => {
      const Database = loadDatabaseSync();
      const missingTablePath = join(root, 'missing-table.sqlite');
      const missingTable = new Database(missingTablePath);
      missingTable.exec(`PRAGMA user_version = ${SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION}`);
      missingTable.close();
      assert.throws(
        () => new SqliteMemoryItemStore(missingTablePath),
        /missing required table memory_items/,
      );

      const missingColumnPath = join(root, 'missing-column.sqlite');
      const missingColumn = new Database(missingColumnPath);
      missingColumn.exec(`
        CREATE TABLE memory_items (item_id TEXT PRIMARY KEY);
        PRAGMA user_version = ${SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION};
      `);
      missingColumn.close();
      assert.throws(
        () => new SqliteMemoryItemStore(missingColumnPath),
        /memory_items is missing required column version/,
      );
    });
  });

  test('rejects a current-version database with a missing query-required index', async () => {
    await withTempRoot(async (root) => {
      const databasePath = join(root, 'missing-index.sqlite');
      const store = new SqliteMemoryItemStore(databasePath);
      store.close();

      const Database = loadDatabaseSync();
      const database = new Database(databasePath);
      database.exec('DROP INDEX memory_item_keys_by_normalized_key');
      database.close();

      assert.throws(
        () => new SqliteMemoryItemStore(databasePath),
        /missing required index memory_item_keys_by_normalized_key/,
      );
    });
  });

  test('serializes truly concurrent first-open migrations', async () => {
    await withTempRoot(async (root) => {
      const databasePath = join(root, 'concurrent.sqlite');
      const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      const moduleUrl = new URL('../sqlite-long-term-memory-store.js', import.meta.url).href;
      const workers = [
        startConcurrentMigrationWorker(databasePath, moduleUrl, gate),
        startConcurrentMigrationWorker(databasePath, moduleUrl, gate),
      ];
      await Promise.all(workers.map((worker) => worker.ready));
      const gateView = new Int32Array(gate);
      Atomics.store(gateView, 0, 1);
      Atomics.notify(gateView, 0, workers.length);
      assert.deepEqual((await Promise.all(workers.map((worker) => worker.result))).sort(), [
        SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION,
        SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION,
      ]);

      const reopened = new SqliteMemoryItemStore(databasePath);
      assert.equal(reopened.schemaVersion(), SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION);
      reopened.close();
    });
  });

  test('rejects database links and sidecar symlinks without changing their targets', async (t) => {
    await withTempRoot(async (root) => {
      const target = join(root, 'outside.txt');
      await writeFile(target, 'do-not-touch', { mode: 0o644 });
      const databasePath = join(root, LONG_TERM_MEMORY_DATABASE_NAME);
      await link(target, databasePath);
      assert.throws(() => new SqliteMemoryItemStore(databasePath), /hard-linked/);
      assert.equal(await readFile(target, 'utf8'), 'do-not-touch');
      if (process.platform !== 'win32') {
        assert.equal((await stat(target)).mode & 0o777, 0o644);
      }

      await rm(databasePath);
      if (!(await createSymlinkIfSupported(target, databasePath))) {
        t.diagnostic('symbolic links are unavailable in this environment');
        return;
      }
      assert.throws(() => new SqliteMemoryItemStore(databasePath), /symbolic link/);
      assert.equal(await readFile(target, 'utf8'), 'do-not-touch');

      await rm(databasePath);
      const initial = new SqliteMemoryItemStore(databasePath);
      initial.close();
      await symlink(target, `${databasePath}-wal`);
      assert.throws(() => new SqliteMemoryItemStore(databasePath), /symbolic link/);
      assert.equal(await readFile(target, 'utf8'), 'do-not-touch');
    });
  });

  test('normalizes keys and searches global plus the selected workspace', async () => {
    await withStore(async ({ store }) => {
      const global = await createItem(
        store,
        'create-global',
        write({
          content: '用户偏好简洁的中文回答。',
          keys: [
            { key: ' 偏好 ', keyType: 'concept', keyOrigin: 'llm' },
            { key: '偏好', keyType: 'exact', keyOrigin: 'user' },
            { key: 'Chinese answer', keyType: 'alias', keyOrigin: 'deterministic' },
          ],
        }),
      );
      const workspace = await createItem(
        store,
        'create-workspace',
        write({
          content: 'Maka uses RuntimeEvent as evidence.',
          kind: 'knowledge',
          scopeType: 'workspace',
          scopeKey: 'workspace-maka',
          keys: [
            { key: 'RuntimeEvent', keyType: 'code', keyOrigin: 'deterministic' },
            { key: 'memory_item', keyType: 'code', keyOrigin: 'deterministic' },
          ],
        }),
      );

      assert.deepEqual((await store.readItem(global))?.keys[0], {
        key: 'Chinese answer',
        normalizedKey: 'chinese answer',
        keyType: 'alias',
        keyOrigin: 'deterministic',
      });
      assert.equal((await store.readItem(global))?.keys[1]?.keyOrigin, 'user');
      assert.deepEqual(await itemIds(store, ['偏好']), [global]);
      assert.deepEqual(await itemIds(store, ['runtime'], 'prefix'), []);
      assert.deepEqual(await itemIds(store, ['runtime'], 'prefix', 'workspace-maka'), [workspace]);
      assert.deepEqual(await itemIds(store, ['memory_'], 'prefix', 'workspace-maka'), [workspace]);
      assert.deepEqual(await itemIds(store, ['偏'], 'prefix'), [global]);
      await assert.rejects(
        store.searchByKeys({
          terms: ['偏好'],
          match: 'exact',
          includeArchived: 'false' as unknown as boolean,
        }),
        /includeArchived/,
      );
    });
  });

  test('ranks multi-term matches, deduplicates terms, and enforces result limits', async () => {
    await withStore(async ({ store }) => {
      const ranked = await store.applyMutations({
        operationId: 'ranked-create',
        mutations: [
          {
            type: 'create',
            item: write({
              content: 'Alpha and beta are both relevant.',
              keys: [
                { key: 'alpha', keyType: 'exact', keyOrigin: 'deterministic' },
                { key: 'beta', keyType: 'exact', keyOrigin: 'deterministic' },
              ],
              sources: [source({ eventId: 'event-alpha-beta' })],
            }),
          },
          {
            type: 'create',
            item: write({
              content: 'Only alpha is relevant.',
              keys: [{ key: 'alpha', keyType: 'exact', keyOrigin: 'deterministic' }],
              sources: [source({ eventId: 'event-alpha' })],
            }),
          },
          {
            type: 'create',
            item: write({
              content: 'Only beta is relevant.',
              keys: [{ key: 'beta', keyType: 'exact', keyOrigin: 'deterministic' }],
              sources: [source({ eventId: 'event-beta' })],
            }),
          },
        ],
      });
      const rankedIds = ranked.results.map((result) => result.itemId);
      assert.deepEqual(await itemIds(store, ['beta', 'alpha', 'ALPHA']), rankedIds);
      assert.deepEqual(
        (await store.searchByKeys({ terms: ['alpha', 'beta'], match: 'exact', limit: 2 })).map(
          (record) => record.item.itemId,
        ),
        rankedIds.slice(0, 2),
      );

      await store.applyMutations({
        operationId: 'default-limit-create',
        mutations: Array.from({ length: 21 }, (_, index) => ({
          type: 'create' as const,
          item: write({
            content: `Bulk fact ${index}.`,
            keys: [{ key: 'bulk', keyType: 'exact', keyOrigin: 'deterministic' }],
            sources: [source({ eventId: `event-bulk-${index}` })],
          }),
        })),
      });
      assert.equal((await store.searchByKeys({ terms: ['bulk'], match: 'exact' })).length, 20);
      await assert.rejects(
        store.searchByKeys({ terms: ['bulk'], match: 'exact', limit: 0 }),
        /between 1 and 100/,
      );
      await assert.rejects(
        store.searchByKeys({ terms: ['bulk'], match: 'exact', limit: 101 }),
        /between 1 and 100/,
      );
    });
  });

  test('replays operation receipts and reports the existing Item before evidence can be lost', async () => {
    await withStore(async ({ store }) => {
      const request = {
        operationId: 'idempotent-create',
        mutations: [{ type: 'create' as const, item: write() }],
      };
      const created = await store.applyMutations(request);
      const replayed = await store.applyMutations(request);
      assert.deepEqual(replayed, { ...created, replayed: true });

      await assert.rejects(
        store.applyMutations({
          operationId: request.operationId,
          mutations: [{ type: 'create', item: write({ content: 'Different fact.' }) }],
        }),
        conflict('operation_reused'),
      );

      await assert.rejects(
        store.applyMutations({
          operationId: 'fact-duplicate',
          mutations: [
            {
              type: 'create',
              item: write({
                origin: 'user_requested',
                keys: [{ key: 'other', keyType: 'exact', keyOrigin: 'user' }],
                sources: [source({ eventId: 'event-other' })],
              }),
            },
          ],
        }),
        (error: unknown) =>
          error instanceof MemoryItemStoreConflictError &&
          error.reason === 'duplicate_active' &&
          error.itemId === undefined &&
          error.conflictingItemId === created.results[0]?.itemId,
      );
      assert.deepEqual((await store.readItem(created.results[0]!.itemId))?.sources, [source()]);
      assert.equal(await store.readOperation('fact-duplicate'), undefined);
    });
  });

  test('uses CAS, replaces current keys and sources, and records no-op writes', async () => {
    await withStore(async ({ store }) => {
      const itemId = await createItem(store, 'cas-create', write());
      const replacement = write({
        content: 'User prefers no more than three concise points.',
        keys: [{ key: 'three-points', keyType: 'exact', keyOrigin: 'user' }],
        sources: [source({ eventId: 'event-2', turnId: 'turn-2' })],
      });
      const updated = await store.applyMutations({
        operationId: 'cas-update',
        mutations: [{ type: 'update', itemId, expectedVersion: 1, item: replacement }],
      });
      assert.equal(updated.results[0]?.version, 2);
      assert.deepEqual((await store.readItem(itemId))?.sources, [
        source({ eventId: 'event-2', turnId: 'turn-2' }),
      ]);

      const noop = await store.applyMutations({
        operationId: 'cas-noop',
        mutations: [{ type: 'update', itemId, expectedVersion: 2, item: replacement }],
      });
      assert.equal(noop.results[0]?.outcome, 'noop');
      assert.equal(noop.results[0]?.version, 2);
      assert.ok(await store.readOperation('cas-noop'));
      await assert.rejects(
        store.applyMutations({
          operationId: 'cas-stale',
          mutations: [{ type: 'update', itemId, expectedVersion: 1, item: replacement }],
        }),
        conflict('version_conflict'),
      );
    });
  });

  test('reports the conflicting active Item when an update would duplicate it', async () => {
    await withStore(async ({ store }) => {
      const firstId = await createItem(store, 'active-first', write());
      const secondId = await createItem(
        store,
        'active-second',
        write({
          content: 'A different current fact.',
          keys: [{ key: 'different', keyType: 'exact', keyOrigin: 'deterministic' }],
          sources: [source({ eventId: 'event-different' })],
        }),
      );

      await assert.rejects(
        store.applyMutations({
          operationId: 'active-update-duplicate',
          mutations: [{ type: 'update', itemId: secondId, expectedVersion: 1, item: write() }],
        }),
        (error: unknown) =>
          error instanceof MemoryItemStoreConflictError &&
          error.reason === 'duplicate_active' &&
          error.itemId === secondId &&
          error.conflictingItemId === firstId,
      );
      assert.equal((await store.readItem(secondId))?.item.content, 'A different current fact.');
      assert.equal(await store.readOperation('active-update-duplicate'), undefined);
    });
  });

  test('rejects a stale CAS from a second SQLite connection', async () => {
    await withTempRoot(async (root) => {
      const databasePath = join(root, LONG_TERM_MEMORY_DATABASE_NAME);
      const first = new SqliteMemoryItemStore(databasePath, {
        now: () => 1_000,
        idFactory: () => 'shared-item',
      });
      const second = new SqliteMemoryItemStore(databasePath, { now: () => 1_000 });
      try {
        const itemId = await createItem(first, 'cross-connection-create', write());
        assert.equal((await second.readItem(itemId))?.item.version, 1);

        await first.applyMutations({
          operationId: 'cross-connection-first-update',
          mutations: [
            {
              type: 'update',
              itemId,
              expectedVersion: 1,
              item: write({ content: 'First writer wins.' }),
            },
          ],
        });
        await assert.rejects(
          second.applyMutations({
            operationId: 'cross-connection-stale-update',
            mutations: [
              {
                type: 'update',
                itemId,
                expectedVersion: 1,
                item: write({ content: 'Stale second writer.' }),
              },
            ],
          }),
          conflict('version_conflict'),
        );
        assert.equal((await second.readItem(itemId))?.item.content, 'First writer wins.');
      } finally {
        first.close();
        second.close();
      }
    });
  });

  test('allows only one truly concurrent CAS update across SQLite connections', async () => {
    await withTempRoot(async (root) => {
      const databasePath = join(root, LONG_TERM_MEMORY_DATABASE_NAME);
      const setup = new SqliteMemoryItemStore(databasePath, {
        now: () => 1_000,
        idFactory: () => 'concurrent-item',
      });
      await createItem(setup, 'concurrent-create', write());
      setup.close();

      const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      const moduleUrl = new URL('../sqlite-long-term-memory-store.js', import.meta.url).href;
      const workers = [
        startConcurrentUpdateWorker(
          databasePath,
          moduleUrl,
          gate,
          'concurrent-update-a',
          write({ content: 'Concurrent writer A.' }),
        ),
        startConcurrentUpdateWorker(
          databasePath,
          moduleUrl,
          gate,
          'concurrent-update-b',
          write({ content: 'Concurrent writer B.' }),
        ),
      ];
      await Promise.all(workers.map((worker) => worker.ready));
      const gateView = new Int32Array(gate);
      Atomics.store(gateView, 0, 1);
      Atomics.notify(gateView, 0, workers.length);
      assert.deepEqual((await Promise.all(workers.map((worker) => worker.result))).sort(), [
        'updated',
        'version_conflict',
      ]);

      const reopened = new SqliteMemoryItemStore(databasePath, { now: () => 1_000 });
      try {
        const record = await reopened.readItem('concurrent-item');
        assert.equal(record?.item.version, 2);
        assert.ok(
          record?.item.content === 'Concurrent writer A.' ||
            record?.item.content === 'Concurrent writer B.',
        );
      } finally {
        reopened.close();
      }
    });
  });

  test('allows an archived no-op but rejects archived changes or restore that collide', async () => {
    await withStore(async ({ store }) => {
      const archivedId = await createItem(store, 'archived-create', write());
      await store.applyMutations({
        operationId: 'archive',
        mutations: [{ type: 'archive', itemId: archivedId, expectedVersion: 1 }],
      });
      const activeId = await createItem(store, 'active-replacement', write());
      assert.notEqual(activeId, archivedId);

      const noop = await store.applyMutations({
        operationId: 'archived-noop',
        mutations: [{ type: 'update', itemId: archivedId, expectedVersion: 2, item: write() }],
      });
      assert.equal(noop.results[0]?.outcome, 'noop');
      assert.equal(noop.results[0]?.version, 2);
      assert.equal(noop.results[0]?.lifecycleState, 'archived');
      assert.ok(await store.readOperation('archived-noop'));

      await assert.rejects(
        store.applyMutations({
          operationId: 'archived-update-collision',
          mutations: [
            {
              type: 'update',
              itemId: archivedId,
              expectedVersion: 2,
              item: write({ sources: [source({ eventId: 'event-new-evidence' })] }),
            },
          ],
        }),
        conflict('duplicate_active'),
      );
      await assert.rejects(
        store.applyMutations({
          operationId: 'restore-collision',
          mutations: [{ type: 'restore', itemId: archivedId, expectedVersion: 2 }],
        }),
        conflict('duplicate_active'),
      );
      assert.deepEqual(await itemIds(store, ['concise']), [activeId]);
    });
  });

  test('excludes archived Items by default and returns them after restore', async () => {
    await withStore(async ({ store }) => {
      const itemId = await createItem(store, 'lifecycle-create', write());
      const archived = await store.applyMutations({
        operationId: 'lifecycle-archive',
        mutations: [{ type: 'archive', itemId, expectedVersion: 1 }],
      });
      assert.equal(archived.results[0]?.lifecycleState, 'archived');
      assert.deepEqual(await itemIds(store, ['concise']), []);
      assert.deepEqual(
        (
          await store.searchByKeys({
            terms: ['concise'],
            match: 'exact',
            includeArchived: true,
          })
        ).map((record) => record.item.itemId),
        [itemId],
      );

      const restored = await store.applyMutations({
        operationId: 'lifecycle-restore',
        mutations: [{ type: 'restore', itemId, expectedVersion: 2 }],
      });
      assert.equal(restored.results[0]?.lifecycleState, 'active');
      assert.deepEqual(await itemIds(store, ['concise']), [itemId]);
    });
  });

  test('reports invalid lifecycle transitions and missing Items', async () => {
    await withStore(async ({ store }) => {
      const itemId = await createItem(store, 'lifecycle-errors-create', write());
      await assert.rejects(
        store.applyMutations({
          operationId: 'restore-active',
          mutations: [{ type: 'restore', itemId, expectedVersion: 1 }],
        }),
        conflict('invalid_lifecycle_transition'),
      );
      const stillActive = await store.readItem(itemId);
      assert.equal(stillActive?.item.version, 1);
      assert.equal(stillActive?.item.lifecycleState, 'active');
      assert.equal(await store.readOperation('restore-active'), undefined);
      await store.applyMutations({
        operationId: 'archive-once',
        mutations: [{ type: 'archive', itemId, expectedVersion: 1 }],
      });
      await assert.rejects(
        store.applyMutations({
          operationId: 'archive-twice',
          mutations: [{ type: 'archive', itemId, expectedVersion: 2 }],
        }),
        conflict('invalid_lifecycle_transition'),
      );
      const archived = await store.readItem(itemId);
      assert.equal(archived?.item.version, 2);
      assert.equal(archived?.item.lifecycleState, 'archived');
      assert.equal(await store.readOperation('archive-twice'), undefined);

      for (const [operationId, mutation] of [
        [
          'missing-update',
          { type: 'update', itemId: 'missing-item', expectedVersion: 1, item: write() },
        ],
        ['missing-archive', { type: 'archive', itemId: 'missing-item', expectedVersion: 1 }],
        ['missing-restore', { type: 'restore', itemId: 'missing-item', expectedVersion: 1 }],
      ] as const) {
        await assert.rejects(
          store.applyMutations({ operationId, mutations: [mutation] }),
          conflict('item_not_found'),
        );
        assert.equal(await store.readOperation(operationId), undefined);
      }
    });
  });

  test('validates temporal writes and commit-time observations', async () => {
    await withStore(async ({ store }) => {
      const created = await store.applyMutations({
        operationId: 'temporal-create',
        mutations: [
          {
            type: 'create',
            item: write({
              content: 'A point event.',
              temporalType: 'point',
              eventStartedAt: 900,
              keys: [{ key: 'point', keyType: 'exact', keyOrigin: 'deterministic' }],
              sources: [source({ eventId: 'event-point' })],
            }),
          },
          {
            type: 'create',
            item: write({
              content: 'An interval event.',
              temporalType: 'interval',
              eventStartedAt: 800,
              eventEndedAt: 1_200,
              keys: [{ key: 'interval', keyType: 'exact', keyOrigin: 'deterministic' }],
              sources: [source({ eventId: 'event-interval' })],
            }),
          },
          {
            type: 'create',
            item: write({
              content: 'An open-ended event.',
              temporalType: 'open_ended',
              eventStartedAt: 700,
              keys: [{ key: 'open', keyType: 'exact', keyOrigin: 'deterministic' }],
              sources: [source({ eventId: 'event-open' })],
            }),
          },
        ],
      });
      assert.deepEqual(
        await Promise.all(
          created.results.map(
            async (result) => (await store.readItem(result.itemId))?.item.temporalType,
          ),
        ),
        ['point', 'interval', 'open_ended'],
      );

      await assert.rejects(
        store.applyMutations({
          operationId: 'invalid-open-ended',
          mutations: [
            {
              type: 'create',
              item: write({
                temporalType: 'open_ended',
                eventStartedAt: 800,
                eventEndedAt: 900,
              }),
            },
          ],
        }),
        /cannot carry eventEndedAt/,
      );
      await assert.rejects(
        store.applyMutations({
          operationId: 'future-observation',
          mutations: [{ type: 'create', item: write({ observedAt: 1_001 }) }],
        }),
        /observedAt cannot be later than commit time/,
      );
    });
  });

  test('rejects malformed mutation input before persistence', async () => {
    await withStore(async ({ store }) => {
      await assert.rejects(
        store.applyMutations({ operationId: 'empty-mutations', mutations: [] }),
        /at least one mutation/,
      );
      await assert.rejects(
        store.applyMutations({
          operationId: 'too-many-mutations',
          mutations: Array.from({ length: 33 }, () => ({
            type: 'create' as const,
            item: write(),
          })),
        }),
        /at most 32 mutations/,
      );
      await assert.rejects(
        store.applyMutations({
          operationId: 'conflicting-provenance',
          mutations: [
            {
              type: 'create',
              item: write({
                sources: [source(), source({ runId: 'run-2' })],
              }),
            },
          ],
        }),
        /conflicting provenance/,
      );
      await assert.rejects(
        store.applyMutations({
          operationId: 'control-key',
          mutations: [
            {
              type: 'create',
              item: write({
                keys: [{ key: 'bad\u0000key', keyType: 'exact', keyOrigin: 'deterministic' }],
              }),
            },
          ],
        }),
        /control or zero-width/,
      );
      await assert.rejects(
        store.applyMutations({
          operationId: 'lone-surrogate',
          mutations: [{ type: 'create', item: write({ content: `lone\uD800surrogate` }) }],
        }),
        /unpaired surrogate/,
      );
      await assert.rejects(
        store.applyMutations({
          operationId: 'e\u0301',
          mutations: [{ type: 'create', item: write() }],
        }),
        /NFC-normalized/,
      );
      assert.equal(await store.readItem('item-1'), undefined);
    });
  });

  test('rolls back the full batch at every write boundary', async () => {
    for (const point of [
      'after_item_write',
      'after_keys_write',
      'after_sources_write',
      'before_operation_write',
    ] as const) {
      await withStore(async ({ store, setFailpoint }) => {
        setFailpoint(point);
        await assert.rejects(
          store.applyMutations({
            operationId: `batch-${point}`,
            mutations: [
              { type: 'create', item: write({ content: 'First fact.' }) },
              { type: 'create', item: write({ content: 'Second fact.' }) },
            ],
          }),
          new RegExp(point),
        );
        assert.equal(await store.readItem('item-1'), undefined);
        assert.equal(await store.readOperation(`batch-${point}`), undefined);
      });
    }
  });

  test('rolls back an earlier completed mutation when a later mutation conflicts', async () => {
    await withStore(async ({ store }) => {
      const existingId = await createItem(store, 'batch-conflict-existing', write());
      await assert.rejects(
        store.applyMutations({
          operationId: 'batch-later-conflict',
          mutations: [
            {
              type: 'create',
              item: write({
                content: 'This Item must be rolled back.',
                keys: [{ key: 'rolled-back', keyType: 'exact', keyOrigin: 'deterministic' }],
                sources: [source({ eventId: 'event-rollback' })],
              }),
            },
            {
              type: 'update',
              itemId: existingId,
              expectedVersion: 99,
              item: write({ content: 'Stale update.' }),
            },
          ],
        }),
        conflict('version_conflict'),
      );
      assert.equal(await store.readItem('item-2'), undefined);
      assert.deepEqual(await itemIds(store, ['rolled-back']), []);
      assert.equal(await store.readOperation('batch-later-conflict'), undefined);
      assert.equal((await store.readItem(existingId))?.item.version, 1);
    });
  });

  test('does not expose a rolled-back Item id for duplicate facts within one batch', async () => {
    await withStore(async ({ store }) => {
      await assert.rejects(
        store.applyMutations({
          operationId: 'batch-duplicate-facts',
          mutations: [
            { type: 'create', item: write({ content: 'Same batch fact.' }) },
            { type: 'create', item: write({ content: 'Same batch fact.' }) },
          ],
        }),
        (error: unknown) =>
          error instanceof MemoryItemStoreConflictError &&
          error.reason === 'duplicate_within_batch' &&
          error.itemId === undefined &&
          error.conflictingItemId === undefined,
      );
      assert.equal(await store.readItem('item-1'), undefined);
      assert.equal(await store.readOperation('batch-duplicate-facts'), undefined);
    });
  });

  test('keeps updated_at monotonic and replays after the injected clock moves backwards', async () => {
    await withTempRoot(async (root) => {
      const databasePath = join(root, LONG_TERM_MEMORY_DATABASE_NAME);
      let now = 1_000;
      const store = new SqliteMemoryItemStore(databasePath, {
        now: () => now,
        idFactory: () => 'clock-item',
      });
      try {
        const request = {
          operationId: 'clock-create',
          mutations: [{ type: 'create' as const, item: write({ observedAt: 900 }) }],
        };
        await store.applyMutations(request);
        now = 800;
        assert.equal((await store.applyMutations(request)).replayed, true);
        now = 1_100;
        await store.applyMutations({
          operationId: 'clock-update-newer',
          mutations: [
            {
              type: 'update',
              itemId: 'clock-item',
              expectedVersion: 1,
              item: write({ content: 'New current fact.', observedAt: 1_000 }),
            },
          ],
        });
        now = 1_050;
        await store.applyMutations({
          operationId: 'clock-archive',
          mutations: [{ type: 'archive', itemId: 'clock-item', expectedVersion: 2 }],
        });
        assert.equal((await store.readItem('clock-item'))?.item.updatedAt, 1_100);
      } finally {
        store.close();
      }
    });
  });

  test('keeps committed Items and operation receipts after checkpoint and reopen', async () => {
    await withTempRoot(async (root) => {
      const databasePath = join(root, LONG_TERM_MEMORY_DATABASE_NAME);
      const store = new SqliteMemoryItemStore(databasePath, {
        now: () => 1_000,
        idFactory: () => 'durable-item',
      });
      const receipt = await store.applyMutations({
        operationId: 'durable-create',
        mutations: [{ type: 'create', item: write() }],
      });
      store.close();

      const Database = loadDatabaseSync();
      const checkpoint = new Database(databasePath);
      checkpoint.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      checkpoint.close();

      const reopened = new SqliteMemoryItemStore(databasePath, { now: () => 1_000 });
      try {
        assert.equal((await reopened.readItem('durable-item'))?.item.content, write().content);
        assert.deepEqual(await reopened.readOperation('durable-create'), receipt);
      } finally {
        reopened.close();
      }
    });
  });

  test('fails closed over a structurally corrupt idempotency receipt', async () => {
    await withStore(async ({ store, databasePath }) => {
      const created = await store.applyMutations({
        operationId: 'corrupt-receipt',
        mutations: [{ type: 'create', item: write() }],
      });
      store.close();
      const Database = loadDatabaseSync();
      const database = new Database(databasePath);
      database
        .prepare('UPDATE memory_write_operations SET result_json = ? WHERE operation_id = ?')
        .run(
          JSON.stringify([
            {
              mutationIndex: 0,
              mutationType: 'update',
              itemId: created.results[0]!.itemId,
              version: 1,
              lifecycleState: 'active',
              outcome: 'updated',
            },
          ]),
          'corrupt-receipt',
        );
      database
        .prepare('UPDATE memory_items SET content_hash = ? WHERE item_id = ?')
        .run('0'.repeat(64), created.results[0]!.itemId);
      database.close();

      const reopened = new SqliteMemoryItemStore(databasePath);
      try {
        await assert.rejects(reopened.readOperation('corrupt-receipt'), /Invalid/);
        await assert.rejects(reopened.readItem(created.results[0]!.itemId), /content_hash/);
      } finally {
        reopened.close();
      }
    });
  });

  test('fails closed over corrupt Item child cardinality', async () => {
    for (const childTable of ['memory_item_keys', 'memory_item_sources'] as const) {
      await withTempRoot(async (root) => {
        const databasePath = join(root, `${childTable}.sqlite`);
        const store = new SqliteMemoryItemStore(databasePath, {
          now: () => 1_000,
          idFactory: () => 'corrupt-child-item',
        });
        await createItem(store, `create-${childTable}`, write());
        store.close();

        const Database = loadDatabaseSync();
        const database = new Database(databasePath);
        database.prepare(`DELETE FROM ${childTable} WHERE item_id = ?`).run('corrupt-child-item');
        database.close();

        const reopened = new SqliteMemoryItemStore(databasePath, { now: () => 1_000 });
        try {
          await assert.rejects(reopened.readItem('corrupt-child-item'), /cardinality/);
          await assert.rejects(
            reopened.applyMutations({
              operationId: `duplicate-${childTable}`,
              mutations: [{ type: 'create', item: write() }],
            }),
            /cardinality/,
          );
        } finally {
          reopened.close();
        }
      });
    }
  });

  test('rejects a corrupt idempotency receipt beyond the batch limit', async () => {
    await withStore(async ({ store, databasePath }) => {
      await store.applyMutations({
        operationId: 'oversize-receipt',
        mutations: [{ type: 'create', item: write() }],
      });
      store.close();
      const result = {
        mutationIndex: 0,
        mutationType: 'create',
        itemId: 'item-1',
        version: 1,
        lifecycleState: 'active',
        outcome: 'created',
      } as const;
      const results = Array.from({ length: 33 }, (_, mutationIndex) => ({
        ...result,
        mutationIndex,
      }));
      const Database = loadDatabaseSync();
      const database = new Database(databasePath);
      database
        .prepare(
          `UPDATE memory_write_operations
           SET operation_type = 'batch', result_json = ?
           WHERE operation_id = 'oversize-receipt'`,
        )
        .run(JSON.stringify(results));
      database.close();

      const reopened = new SqliteMemoryItemStore(databasePath);
      try {
        await assert.rejects(reopened.readOperation('oversize-receipt'), /at most 32/);
      } finally {
        reopened.close();
      }
    });
  });

  test('rejects an oversized idempotency receipt before JSON parsing', async () => {
    await withStore(async ({ store, databasePath }) => {
      await store.applyMutations({
        operationId: 'huge-receipt',
        mutations: [{ type: 'create', item: write() }],
      });
      store.close();
      const Database = loadDatabaseSync();
      const database = new Database(databasePath);
      database
        .prepare(
          `UPDATE memory_write_operations SET result_json = ?
           WHERE operation_id = 'huge-receipt'`,
        )
        .run(`"${'x'.repeat(129 * 1_024)}"`);
      database.close();

      const reopened = new SqliteMemoryItemStore(databasePath);
      try {
        await assert.rejects(reopened.readOperation('huge-receipt'), /too large/);
      } finally {
        reopened.close();
      }
    });
  });
});

describe('long-term memory Storage Root authority', () => {
  test('rejects a structurally forged writer facade', () => {
    assert.throws(
      () =>
        authenticateInteractiveLongTermMemoryWriter({
          kind: 'interactive',
          access: 'write',
        } as unknown as Parameters<typeof authenticateInteractiveLongTermMemoryWriter>[0]),
      /authentic interactive long-term memory writer/,
    );
  });

  test('rejects a Headless lease at the Interactive opener without creating a database', async () => {
    await withTempRoot(async (root) => {
      const capability = await resolveStorageRoot({ path: root, kind: 'headless' });
      const lease = createHeadlessRootLease(capability, 'write');
      await assert.rejects(
        openInteractiveLongTermMemoryStoreForWrite(
          lease as unknown as Parameters<typeof openInteractiveLongTermMemoryStoreForWrite>[0],
        ),
        /interactive/,
      );
      await assert.rejects(stat(join(root, LONG_TERM_MEMORY_DATABASE_NAME)), { code: 'ENOENT' });
    });
  });

  test('snapshots mutation input before crossing the authority boundary', async () => {
    await withTempRoot(async (root) => {
      const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      const writer = await openInteractiveLongTermMemoryStoreForWrite(owner.lease);
      try {
        const item = write({
          keys: [{ key: 'original-key', keyType: 'exact', keyOrigin: 'deterministic' }],
          sources: [source({ eventId: 'original-event' })],
        });
        const request = {
          operationId: 'snapshot-input',
          mutations: [{ type: 'create' as const, item }],
        };
        const writing = writer.applyMutations(request);
        (item as { content: string }).content = 'Mutated after admission.';
        (item.keys[0] as { key: string }).key = 'mutated-key';
        (item.sources[0] as { eventId: string }).eventId = 'mutated-event';

        const result = await writing;
        const record = await writer.readItem(result.results[0]!.itemId);
        assert.equal(record?.item.content, 'User prefers concise answers.');
        assert.deepEqual(
          record?.keys.map((key) => key.key),
          ['original-key'],
        );
        assert.deepEqual(
          record?.sources.map((entry) => entry.eventId),
          ['original-event'],
        );
      } finally {
        writer.close();
        await owner.close();
      }
    });
  });

  test('rejects operations after the durable root identity changes', async () => {
    await withTempRoot(async (root) => {
      const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      const writer = await openInteractiveLongTermMemoryStoreForWrite(owner.lease);
      try {
        const markerPath = join(root, STORAGE_ROOT_MARKER_FILE);
        const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { rootId: string };
        marker.rootId = `${marker.rootId.startsWith('0') ? '1' : '0'}${marker.rootId.slice(1)}`;
        await writeFile(markerPath, `${JSON.stringify(marker)}\n`);
        await assert.rejects(writer.readItem('after-root-replacement'), {
          code: 'root_identity_changed',
        });
      } finally {
        writer.close();
        await owner.close();
      }
    });
  });

  test('single-flights an Interactive writer and closes it explicitly', async () => {
    await withTempRoot(async (root) => {
      const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      try {
        const [first, second] = await Promise.all([
          openInteractiveLongTermMemoryStoreForWrite(owner.lease),
          openInteractiveLongTermMemoryStoreForWrite(owner.lease),
        ]);
        assert.equal(first, second);
        assert.equal(authenticateInteractiveLongTermMemoryWriter(first), first);
        assert.equal((await stat(join(root, LONG_TERM_MEMORY_DATABASE_NAME))).isFile(), true);
        first.close();
        await assert.rejects(first.readItem('closed-item'), /closed/);

        const reopened = await openInteractiveLongTermMemoryStoreForWrite(owner.lease);
        assert.notEqual(reopened, first);
        reopened.close();
      } finally {
        await owner.close();
      }
    });
  });
});

type Store = SqliteMemoryItemStore;

async function withStore(
  run: (context: {
    store: Store;
    databasePath: string;
    setFailpoint: (point: SqliteMemoryItemStoreFailpoint | undefined) => void;
  }) => Promise<void>,
): Promise<void> {
  await withTempRoot(async (root) => {
    const databasePath = join(root, LONG_TERM_MEMORY_DATABASE_NAME);
    let failpoint: SqliteMemoryItemStoreFailpoint | undefined;
    let nextId = 1;
    const store = new SqliteMemoryItemStore(databasePath, {
      now: () => 1_000,
      idFactory: () => `item-${nextId++}`,
      failpoint: (point) => {
        if (point === failpoint) throw new Error(`SQLite Memory failpoint: ${point}`);
      },
    });
    try {
      await run({
        store,
        databasePath,
        setFailpoint: (point) => {
          failpoint = point;
        },
      });
    } finally {
      store.close();
    }
  });
}

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-long-term-memory-'));
  try {
    await chmod(root, 0o700);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function createItem(
  store: Store,
  operationId: string,
  item: MemoryItemWrite,
): Promise<string> {
  const result = await store.applyMutations({
    operationId,
    mutations: [{ type: 'create', item }],
  });
  return result.results[0]!.itemId;
}

async function itemIds(
  store: Store,
  terms: readonly string[],
  match: 'exact' | 'prefix' = 'exact',
  workspaceKey?: string,
): Promise<string[]> {
  return (
    await store.searchByKeys({
      terms,
      match,
      ...(workspaceKey ? { workspaceKey } : {}),
    })
  ).map((record) => record.item.itemId);
}

function write(overrides: Partial<MemoryItemWrite> = {}): MemoryItemWrite {
  return {
    content: 'User prefers concise answers.',
    kind: 'preference',
    statementType: 'fact',
    temporalType: 'undated',
    scopeType: 'global',
    observedAt: 900,
    origin: 'agent_extracted',
    keys: [{ key: 'concise', keyType: 'exact', keyOrigin: 'deterministic' }],
    sources: [source()],
    ...overrides,
  };
}

function source(overrides: Partial<MemoryItemSource> = {}): MemoryItemSource {
  return {
    sessionId: 'session-1',
    runId: 'run-1',
    turnId: 'turn-1',
    eventId: 'event-1',
    ...overrides,
  };
}

function conflict(reason: MemoryItemStoreConflictError['reason']) {
  return (error: unknown): boolean =>
    error instanceof MemoryItemStoreConflictError && error.reason === reason;
}

function loadDatabaseSync(): typeof import('node:sqlite').DatabaseSync {
  return (require('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
}

function startConcurrentMigrationWorker(
  databasePath: string,
  moduleUrl: string,
  gate: SharedArrayBuffer,
): { readonly ready: Promise<void>; readonly result: Promise<number> } {
  const worker = new Worker(
    `
      const { parentPort, workerData } = require('node:worker_threads');
      const gate = new Int32Array(workerData.gate);
      parentPort.postMessage({ type: 'ready' });
      Atomics.wait(gate, 0, 0);
      import(workerData.moduleUrl)
        .then(({ SqliteMemoryItemStore }) => {
          const store = new SqliteMemoryItemStore(workerData.databasePath);
          const version = store.schemaVersion();
          store.close();
          parentPort.postMessage({ type: 'result', version });
          parentPort.close();
        })
        .catch((error) => {
          parentPort.postMessage({
            type: 'error',
            message: error && error.stack ? error.stack : String(error),
          });
          parentPort.close();
        });
    `,
    {
      eval: true,
      workerData: { databasePath, moduleUrl, gate },
    },
  );

  let readyResolved = false;
  let resultSettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveResult!: (version: number) => void;
  let rejectResult!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<number>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const fail = (error: Error): void => {
    if (!readyResolved) rejectReady(error);
    if (!resultSettled) {
      resultSettled = true;
      rejectResult(error);
    }
  };

  worker.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object') {
      fail(new Error('Concurrent migration worker returned an invalid message'));
      return;
    }
    const payload = message as { type?: unknown; version?: unknown; message?: unknown };
    if (payload.type === 'ready') {
      readyResolved = true;
      resolveReady();
      return;
    }
    if (payload.type === 'result' && typeof payload.version === 'number') {
      resultSettled = true;
      resolveResult(payload.version);
      return;
    }
    if (payload.type === 'error') {
      fail(new Error(String(payload.message)));
      return;
    }
    fail(new Error('Concurrent migration worker returned an invalid message'));
  });
  worker.on('error', (error) => fail(error instanceof Error ? error : new Error(String(error))));
  worker.on('exit', (code) => {
    if (code !== 0) {
      fail(new Error(`Concurrent migration worker exited with code ${code}`));
    } else if (!resultSettled) {
      fail(new Error('Concurrent migration worker exited before returning a result'));
    }
  });

  return { ready, result };
}

function startConcurrentUpdateWorker(
  databasePath: string,
  moduleUrl: string,
  gate: SharedArrayBuffer,
  operationId: string,
  item: MemoryItemWrite,
): {
  readonly ready: Promise<void>;
  readonly result: Promise<'updated' | 'version_conflict'>;
} {
  const worker = new Worker(
    `
      const { parentPort, workerData } = require('node:worker_threads');
      import(workerData.moduleUrl)
        .then(async ({ SqliteMemoryItemStore }) => {
          const store = new SqliteMemoryItemStore(workerData.databasePath, { now: () => 1000 });
          try {
            const gate = new Int32Array(workerData.gate);
            parentPort.postMessage({ type: 'ready' });
            Atomics.wait(gate, 0, 0);
            try {
              await store.applyMutations({
                operationId: workerData.operationId,
                mutations: [{
                  type: 'update',
                  itemId: 'concurrent-item',
                  expectedVersion: 1,
                  item: workerData.item,
                }],
              });
              parentPort.postMessage({ type: 'result', outcome: 'updated' });
            } catch (error) {
              if (error && error.reason === 'version_conflict') {
                parentPort.postMessage({ type: 'result', outcome: 'version_conflict' });
              } else {
                throw error;
              }
            }
          } finally {
            store.close();
          }
          parentPort.close();
        })
        .catch((error) => {
          parentPort.postMessage({
            type: 'error',
            message: error && error.stack ? error.stack : String(error),
          });
          parentPort.close();
        });
    `,
    {
      eval: true,
      workerData: { databasePath, moduleUrl, gate, operationId, item },
    },
  );

  let readyResolved = false;
  let resultSettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveResult!: (outcome: 'updated' | 'version_conflict') => void;
  let rejectResult!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<'updated' | 'version_conflict'>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const fail = (error: Error): void => {
    if (!readyResolved) rejectReady(error);
    if (!resultSettled) {
      resultSettled = true;
      rejectResult(error);
    }
  };

  worker.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object') {
      fail(new Error('Concurrent update worker returned an invalid message'));
      return;
    }
    const payload = message as { type?: unknown; outcome?: unknown; message?: unknown };
    if (payload.type === 'ready') {
      readyResolved = true;
      resolveReady();
      return;
    }
    if (
      payload.type === 'result' &&
      (payload.outcome === 'updated' || payload.outcome === 'version_conflict')
    ) {
      resultSettled = true;
      resolveResult(payload.outcome);
      return;
    }
    if (payload.type === 'error') {
      fail(new Error(String(payload.message)));
      return;
    }
    fail(new Error('Concurrent update worker returned an invalid message'));
  });
  worker.on('error', (error) => fail(error instanceof Error ? error : new Error(String(error))));
  worker.on('exit', (code) => {
    if (code !== 0) {
      fail(new Error(`Concurrent update worker exited with code ${code}`));
    } else if (!resultSettled) {
      fail(new Error('Concurrent update worker exited before returning a result'));
    }
  });

  return { ready, result };
}

async function createSymlinkIfSupported(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path);
    return true;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      ['EPERM', 'EACCES', 'ENOTSUP'].includes(String(error.code))
    ) {
      return false;
    }
    throw error;
  }
}
