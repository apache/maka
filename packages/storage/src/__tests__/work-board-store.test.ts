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
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { Worker } from 'node:worker_threads';
import {
  createOperationalStateBackup,
  restoreOperationalStateBackup,
} from '../operational-state-backup.js';
import { buildWorkBoardListStatement } from '../work-board-list-query.js';
import {
  createWorkBoardStore,
  WorkBoardStoreError,
  type WorkBoardMutationOptions,
} from '../work-board-store.js';
import {
  WORK_BOARD_DEFAULT_PAGE_SIZE,
  WORK_BOARD_PROJECT_ID_MAX_CHARS,
} from '@maka/core/work-board';

describe('Work Board store', () => {
  test('persists items across reopen', async () => {
    await withTempRoot(async (root) => {
      const store = createWorkBoardStore(root);
      const item = await store.create(itemInput(), 100);
      store.close();

      const reopened = createWorkBoardStore(root);
      try {
        const page = await reopened.list();
        assert.equal(page.items.length, 1);
        assert.deepEqual(page.items[0], item);
        assert.deepEqual(await reopened.get(item.id), item);
      } finally {
        reopened.close();
      }
    });
  });

  test('applies semantic patches and enforces optimistic concurrency', async () => {
    await withTempRoot(async (root) => {
      const store = createWorkBoardStore(root);
      try {
        const item = await store.create(itemInput(), 100);
        const renamed = await store.update(item.id, { title: 'Review auth v2' }, {}, 101);
        assert.equal(renamed.revision, 2);
        assert.equal(renamed.title, 'Review auth v2');

        await assert.rejects(
          store.update(item.id, { state: 'in_progress' }, { expectedRevision: 1 }, 102),
          (error: unknown) =>
            error instanceof WorkBoardStoreError && error.code === 'operation_conflict',
        );

        const moved = await store.update(
          item.id,
          { scope: { kind: 'project', projectId: 'p1' }, state: 'done' },
          { expectedRevision: 2 },
          103,
        );
        assert.equal(moved.revision, 3);
        assert.deepEqual(moved.scope, { kind: 'project', projectId: 'p1' });
        assert.equal(moved.state, 'done');
      } finally {
        store.close();
      }
    });
  });

  test('archive, reopen, and permanent delete follow the intended lifecycle', async () => {
    await withTempRoot(async (root) => {
      const store = createWorkBoardStore(root);
      try {
        const item = await store.create(itemInput(), 100);
        const archived = await store.archive(item.id, {}, 101);
        assert.equal(archived.archived, true);
        assert.equal(archived.archivedAt, 101);
        assert.equal(archived.revision, 2);

        const reopened = await store.unarchive(item.id, {}, 102);
        assert.equal(reopened.archived, false);
        assert.equal('archivedAt' in reopened, false);
        assert.equal(reopened.revision, 3);

        await assert.rejects(
          store.remove(item.id),
          (error: unknown) =>
            error instanceof WorkBoardStoreError && error.code === 'must_archive_first',
        );

        await store.archive(item.id, {}, 103);
        await store.remove(item.id, { expectedRevision: 4 });
        assert.equal(await store.get(item.id), undefined);
      } finally {
        store.close();
      }
    });
  });

  test('paginates with an opaque cursor and filters by scope and archive state', async () => {
    await withTempRoot(async (root) => {
      const store = createWorkBoardStore(root);
      try {
        const ids: string[] = [];
        for (let index = 1; index <= 5; index += 1) {
          const item = await store.create(itemInput({ title: `item-${index}` }), index);
          ids.push(item.id);
        }
        const projectItem = await store.create(
          itemInput({
            title: 'project item',
            scope: { kind: 'project', projectId: 'p1' },
          }),
          6,
        );

        const first = await store.list({ limit: 2, scope: { kind: 'inbox' } });
        assert.deepEqual(
          first.items.map((item) => item.id),
          [ids[4], ids[3]],
        );
        assert.ok(first.nextCursor);

        const second = await store.list({
          limit: 2,
          scope: { kind: 'inbox' },
          cursor: first.nextCursor,
        });
        assert.deepEqual(
          second.items.map((item) => item.id),
          [ids[2], ids[1]],
        );
        assert.ok(second.nextCursor);

        const third = await store.list({
          limit: 2,
          scope: { kind: 'inbox' },
          cursor: second.nextCursor,
        });
        assert.deepEqual(
          third.items.map((item) => item.id),
          [ids[0]],
        );
        assert.equal(third.nextCursor, undefined);

        const inbox = await store.list({ scope: { kind: 'inbox' } });
        assert.equal(inbox.items.length, 5);
        const project = await store.list({
          scope: { kind: 'project', projectId: 'p1' },
        });
        assert.deepEqual(
          project.items.map((item) => item.id),
          [projectItem.id],
        );
        assert.equal(
          (await store.list({ scope: { kind: 'project', projectId: 'missing' } })).items.length,
          0,
        );

        await store.archive(ids[0]!, {}, 7);
        assert.equal((await store.list()).items.length, 5);
        assert.equal((await store.list({ includeArchived: true })).items.length, 6);
      } finally {
        store.close();
      }
    });
  });

  test('bounds default and scoped list work under archive-heavy data with active-row indexes', async () => {
    await withTempRoot(async (root) => {
      const store = createWorkBoardStore(root);
      try {
        const activeIds: string[] = [];
        for (let index = 0; index < 5; index += 1) {
          const item = await store.create(itemInput({ title: `active-${index}` }), 1_000 + index);
          activeIds.push(item.id);
        }
        for (let index = 0; index < 120; index += 1) {
          const item = await store.create(itemInput({ title: `archived-${index}` }), 2_000 + index);
          await store.archive(item.id, {}, 3_000 + index);
        }
        const projectActive = await store.create(
          itemInput({ title: 'project-active', scope: { kind: 'project', projectId: 'p1' } }),
          1_000 + 5,
        );

        const page = await store.list();
        assert.deepEqual(
          page.items.map((item) => item.id),
          [projectActive.id, ...activeIds.slice().reverse()],
        );
        assert.equal(
          page.items.some((item) => item.archived),
          false,
        );

        const projectPage = await store.list({ scope: { kind: 'project', projectId: 'p1' } });
        assert.deepEqual(
          projectPage.items.map((item) => item.id),
          [projectActive.id],
        );
      } finally {
        store.close();
      }

      const database = new DatabaseSync(join(root, 'runtime.sqlite'));
      try {
        const unscopedDetail = explainListPlan(
          database,
          buildWorkBoardListStatement({}, WORK_BOARD_DEFAULT_PAGE_SIZE),
        );
        const scopedDetail = explainListPlan(
          database,
          buildWorkBoardListStatement(
            { scope: { kind: 'project', projectId: 'p1' } },
            WORK_BOARD_DEFAULT_PAGE_SIZE,
          ),
        );
        assert.match(unscopedDetail, /workflow_work_board_items_active_order/);
        assert.match(scopedDetail, /workflow_work_board_items_active_scope_order/);
        assert.doesNotMatch(unscopedDetail, /USE TEMP B-TREE/);
        assert.doesNotMatch(scopedDetail, /USE TEMP B-TREE/);
      } finally {
        database.close();
      }
    });
  });

  test('rejects a cursor reused with a different filter result set', async () => {
    await withTempRoot(async (root) => {
      const store = createWorkBoardStore(root);
      try {
        for (let index = 0; index < 3; index += 1) {
          await store.create(itemInput({ title: `inbox-${index}` }), 100 + index);
        }
        const inboxPage = await store.list({ limit: 1, scope: { kind: 'inbox' } });
        assert.ok(inboxPage.nextCursor);
        const firstItem = inboxPage.items[0];
        assert.ok(firstItem);

        await assert.rejects(
          store.list({
            scope: { kind: 'project', projectId: 'p1' },
            cursor: inboxPage.nextCursor,
          }),
          (error: unknown) =>
            error instanceof WorkBoardStoreError && error.code === 'invalid_input',
        );
        await assert.rejects(
          store.list({ includeArchived: true, cursor: inboxPage.nextCursor }),
          (error: unknown) =>
            error instanceof WorkBoardStoreError && error.code === 'invalid_input',
        );

        const secondPage = await store.list({
          limit: 1,
          scope: { kind: 'inbox' },
          cursor: inboxPage.nextCursor,
        });
        assert.equal(secondPage.items.length, 1);
        const secondItem = secondPage.items[0];
        assert.ok(secondItem);
        assert.notEqual(secondItem.id, firstItem.id);
      } finally {
        store.close();
      }
    });
  });

  test('round-trips pagination cursors with a maximum-length project id', async () => {
    await withTempRoot(async (root) => {
      const store = createWorkBoardStore(root);
      try {
        const projectId = 'p'.repeat(WORK_BOARD_PROJECT_ID_MAX_CHARS);
        for (let index = 0; index < 2; index += 1) {
          await store.create(
            itemInput({
              title: `long-project-${index}`,
              scope: { kind: 'project', projectId },
            }),
            100 + index,
          );
        }

        const first = await store.list({ limit: 1, scope: { kind: 'project', projectId } });
        assert.ok(first.nextCursor);
        const second = await store.list({
          limit: 1,
          scope: { kind: 'project', projectId },
          cursor: first.nextCursor,
        });
        assert.equal(second.items.length, 1);
        assert.notEqual(second.items[0]?.id, first.items[0]?.id);
      } finally {
        store.close();
      }
    });
  });

  test('keeps mutation timestamps monotonic when now moves backwards', async () => {
    await withTempRoot(async (root) => {
      const store = createWorkBoardStore(root);
      try {
        const item = await store.create(itemInput(), 100);

        const renamed = await store.update(item.id, { title: 'earlier clock' }, {}, 50);
        assert.equal(renamed.updatedAt, 100);
        assert.equal(renamed.revision, 2);

        const archived = await store.archive(item.id, {}, 30);
        assert.equal(archived.updatedAt, 100);
        assert.equal(archived.archivedAt, 100);
        assert.equal(archived.revision, 3);

        const reopened = await store.unarchive(item.id, {}, 40);
        assert.equal(reopened.updatedAt, 100);
        assert.equal(reopened.revision, 4);
      } finally {
        store.close();
      }
    });
  });

  test('rejects unknown mutation option keys instead of disabling CAS', async () => {
    await withTempRoot(async (root) => {
      const store = createWorkBoardStore(root);
      try {
        const item = await store.create(itemInput(), 100);
        await store.update(item.id, { title: 'v2' }, {}, 101);

        await assert.rejects(
          store.update(
            item.id,
            { state: 'in_progress' },
            { expectedRevison: 1 } as unknown as WorkBoardMutationOptions,
            102,
          ),
          (error: unknown) =>
            error instanceof WorkBoardStoreError && error.code === 'invalid_input',
        );
        await assert.rejects(
          store.update(
            item.id,
            { state: 'done' },
            { expectedRevision: 1, extra: true } as unknown as WorkBoardMutationOptions,
            103,
          ),
          (error: unknown) =>
            error instanceof WorkBoardStoreError && error.code === 'invalid_input',
        );

        const final = await store.get(item.id);
        assert.ok(final);
        assert.equal(final.revision, 2);
        assert.equal(final.state, 'todo');
      } finally {
        store.close();
      }
    });
  });

  // Process-local serialization only; cross-process CAS is protected by the
  // BEGIN IMMEDIATE transaction shared by update/archive/unarchive/remove.
  test('serializes concurrent mutations through the process-local write queue', async () => {
    await withTempRoot(async (root) => {
      const store = createWorkBoardStore(root);
      try {
        const item = await store.create(itemInput(), 100);
        const results = await Promise.all([
          store.update(item.id, { title: 'renamed' }, {}, 200),
          store.update(item.id, { state: 'in_progress' }, {}, 201),
          store.archive(item.id, {}, 202),
        ]);
        assert.deepEqual(
          results.map((result) => result.revision),
          [2, 3, 4],
        );
        const final = await store.get(item.id);
        assert.ok(final);
        assert.equal(final.title, 'renamed');
        assert.equal(final.state, 'in_progress');
        assert.equal(final.archived, true);
        assert.equal(final.revision, 4);
        assert.equal(final.updatedAt, 202);
      } finally {
        store.close();
      }
    });
  });

  test('CAS across separate worker connections produces exactly one winner and one conflict', async () => {
    await withTempRoot(async (root) => {
      const store = createWorkBoardStore(root);
      const item = await store.create(itemInput(), 100);
      store.close();

      const workerUrl = new URL('./fixtures/work-board-cas-worker.js', import.meta.url);
      const runWorker = (): Promise<{ ok: boolean; revision?: number; code?: unknown }> =>
        new Promise((resolve, reject) => {
          const worker = new Worker(workerUrl, {
            workerData: { workspaceRoot: root, itemId: item.id },
          });
          worker.once('message', resolve);
          worker.once('error', reject);
          worker.once('exit', (code) => {
            if (code !== 0) reject(new Error(`Work Board CAS worker exited with ${code}`));
          });
        });

      const results = await Promise.all([runWorker(), runWorker()]);
      const winners = results.filter((result) => result.ok);
      const conflicts = results.filter(
        (result) => !result.ok && result.code === 'operation_conflict',
      );
      assert.equal(winners.length, 1);
      assert.equal(conflicts.length, 1);

      const reopened = createWorkBoardStore(root);
      try {
        const final = await reopened.get(item.id);
        assert.ok(final);
        assert.equal(final.revision, 2);
        assert.match(final.title, /^worker-/);
      } finally {
        reopened.close();
      }
    });
  });

  test('applies notes patch semantics at the store boundary', async () => {
    await withTempRoot(async (root) => {
      const store = createWorkBoardStore(root);
      try {
        const item = await store.create(itemInput(), 100);
        await store.update(item.id, { notes: 'keep me' }, {}, 101);
        assert.equal((await store.get(item.id))?.notes, 'keep me');

        const untouched = await store.update(item.id, { notes: undefined }, {}, 102);
        assert.equal(untouched.notes, 'keep me');
        assert.equal(untouched.revision, 2);

        const clearedByNull = await store.update(item.id, { notes: null }, {}, 103);
        assert.equal('notes' in clearedByNull, false);
        assert.equal(clearedByNull.revision, 3);

        await store.update(item.id, { notes: 'again' }, {}, 104);
        const clearedByEmpty = await store.update(item.id, { notes: '' }, {}, 105);
        assert.equal('notes' in clearedByEmpty, false);
        assert.equal(clearedByEmpty.revision, 5);

        await store.update(item.id, { notes: 'again2' }, {}, 106);
        const clearedByWhitespace = await store.update(item.id, { notes: '   ' }, {}, 107);
        assert.equal('notes' in clearedByWhitespace, false);
        assert.equal(clearedByWhitespace.revision, 7);

        const replaced = await store.update(item.id, { notes: 'new' }, {}, 108);
        assert.equal(replaced.notes, 'new');
        assert.equal(replaced.revision, 8);
      } finally {
        store.close();
      }
    });
  });

  test('keeps revision monotonic when mutations share the same timestamp', async () => {
    await withTempRoot(async (root) => {
      const store = createWorkBoardStore(root);
      try {
        const created = await store.create(itemInput(), 1000);
        assert.equal(created.revision, 1);
        assert.equal(created.updatedAt, 1000);

        const renamed = await store.update(created.id, { title: 'same ms' }, {}, 1000);
        assert.equal(renamed.revision, 2);
        assert.equal(renamed.updatedAt, 1000);

        const moved = await store.update(renamed.id, { state: 'in_progress' }, {}, 1000);
        assert.equal(moved.revision, 3);
        assert.equal(moved.updatedAt, 1000);
      } finally {
        store.close();
      }
    });
  });

  test('rejects a row whose record_json is malformed JSON', async () => {
    await withTempRoot(async (root) => {
      const store = createWorkBoardStore(root);
      const item = await store.create(itemInput(), 100);
      store.close();

      const database = new DatabaseSync(join(root, 'runtime.sqlite'));
      database
        .prepare('UPDATE workflow_work_board_items SET record_json = ? WHERE item_id = ?')
        .run('{broken', item.id);
      database.close();

      const reopened = createWorkBoardStore(root);
      try {
        await assert.rejects(
          reopened.get(item.id),
          (error: unknown) =>
            error instanceof WorkBoardStoreError && error.code === 'corrupt_record',
        );
        await assert.rejects(
          reopened.list(),
          (error: unknown) =>
            error instanceof WorkBoardStoreError && error.code === 'corrupt_record',
        );
      } finally {
        reopened.close();
      }
    });
  });

  test('SQLite rejects inbox rows with a project id and project rows without one', async () => {
    await withTempRoot(async (root) => {
      createWorkBoardStore(root).close();
      const database = new DatabaseSync(join(root, 'runtime.sqlite'));
      try {
        const insert = database.prepare(`
          INSERT INTO workflow_work_board_items(
            item_id, revision, created_at, updated_at, scope_kind, project_id, archived, record_json
          )
          VALUES (?, 1, 1, 1, ?, ?, 0, ?)
        `);
        assert.throws(() => insert.run('bad-inbox', 'inbox', 'p1', '{}'));
        assert.throws(() => insert.run('bad-project', 'project', null, '{}'));
      } finally {
        database.close();
      }
    });
  });

  test('rejects indexed columns that disagree with record_json', async () => {
    await withTempRoot(async (root) => {
      const store = createWorkBoardStore(root);
      const item = await store.create(
        itemInput({ scope: { kind: 'project', projectId: 'p1' } }),
        100,
      );
      store.close();

      const database = new DatabaseSync(join(root, 'runtime.sqlite'));
      database
        .prepare(
          `UPDATE workflow_work_board_items
           SET scope_kind = 'inbox', project_id = NULL
           WHERE item_id = ?`,
        )
        .run(item.id);
      database.close();

      const reopened = createWorkBoardStore(root);
      try {
        await assert.rejects(
          reopened.get(item.id),
          (error: unknown) =>
            error instanceof WorkBoardStoreError && error.code === 'corrupt_record',
        );
        await assert.rejects(
          reopened.list(),
          (error: unknown) =>
            error instanceof WorkBoardStoreError && error.code === 'corrupt_record',
        );
      } finally {
        reopened.close();
      }
    });
  });

  test('migrates a real workflow schema 8 database to version 9 with the board table', async () => {
    const base = await mkdtemp(join(tmpdir(), 'maka-work-board-schema8-'));
    const stateRoot = join(base, 'state');
    const databasePath = join(stateRoot, 'runtime.sqlite');
    await mkdir(stateRoot, { recursive: true });
    try {
      await copyFile(
        new URL('../../test-fixtures/v0.1.6-operational-state/runtime.sqlite', import.meta.url),
        databasePath,
      );
      const v8 = new DatabaseSync(databasePath);
      try {
        v8.exec(
          readFileSync(
            new URL('../../test-fixtures/workflow-schema-v8.sql', import.meta.url),
            'utf8',
          ),
        );
        // The released v0.1.6 fixture ships an Automation definition; clearing
        // it keeps the fixture focused on the workflow 8 -> 9 upgrade while
        // leaving every released table and row otherwise intact.
        v8.exec('DELETE FROM automation_definitions; DELETE FROM automation_pending_fires;');
        v8.prepare(
          "UPDATE operational_schema_migrations SET version = 8 WHERE scope = 'workflow'",
        ).run();
      } finally {
        v8.close();
      }

      createWorkBoardStore(stateRoot).close();
      const database = new DatabaseSync(databasePath);
      try {
        const version = database
          .prepare("SELECT version FROM operational_schema_migrations WHERE scope = 'workflow'")
          .get() as { version?: unknown } | undefined;
        assert.equal(version?.version, 9);
        assert.ok(
          database
            .prepare("SELECT 1 FROM sqlite_schema WHERE name = 'workflow_work_board_items'")
            .get(),
        );
        assert.ok(
          database
            .prepare("SELECT 1 FROM sqlite_schema WHERE name = 'workflow_goal_authority'")
            .get(),
        );
        assert.ok(
          database
            .prepare(
              "SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = 'workflow_work_board_items_active_order'",
            )
            .get(),
        );
        assert.ok(
          database
            .prepare(
              "SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = 'workflow_work_board_items_active_scope_order'",
            )
            .get(),
        );
      } finally {
        database.close();
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('backs up and restores board items with the operational state', async () => {
    const base = await mkdtemp(join(tmpdir(), 'maka-work-board-backup-'));
    const stateRoot = join(base, 'state');
    const backupRoot = join(base, 'backup');
    const restoreRoot = join(base, 'restore');
    await mkdir(stateRoot, { recursive: true });
    try {
      const store = createWorkBoardStore(stateRoot);
      const item = await store.create(itemInput({ title: 'backup me' }), 100);
      store.close();

      await createOperationalStateBackup({ stateRoot, destinationRoot: backupRoot, now: () => 10 });
      await restoreOperationalStateBackup({ backupRoot, destinationRoot: restoreRoot });

      const restored = createWorkBoardStore(restoreRoot);
      try {
        assert.deepEqual(await restored.get(item.id), item);
      } finally {
        restored.close();
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

function explainListPlan(
  database: DatabaseSync,
  statement: { sql: string; params: Array<string | number> },
): string {
  let index = 0;
  const literalSql = statement.sql.replace(/\?/g, () => {
    const value = statement.params[index++]!;
    return typeof value === 'number' ? String(value) : `'${value.replace(/'/g, "''")}'`;
  });
  const rows = database.prepare(`EXPLAIN QUERY PLAN ${literalSql}`).all() as Array<{
    detail: string;
  }>;
  return rows.map((row) => row.detail).join(' ');
}

function itemInput(
  overrides: Partial<{
    scope: { kind: 'inbox' } | { kind: 'project'; projectId: string };
    title: string;
    creator: { kind: 'user' } | { kind: 'agent_suggestion'; confirmedAt: number };
    provenance: { kind: 'manual' };
  }> = {},
): {
  scope: { kind: 'inbox' } | { kind: 'project'; projectId: string };
  title: string;
  creator: { kind: 'user' } | { kind: 'agent_suggestion'; confirmedAt: number };
  provenance: { kind: 'manual' };
} {
  return {
    scope: { kind: 'inbox' },
    title: 'Review auth',
    creator: { kind: 'user' },
    provenance: { kind: 'manual' },
    ...overrides,
  };
}

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-work-board-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
