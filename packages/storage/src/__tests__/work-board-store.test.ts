import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import {
  createOperationalStateBackup,
  restoreOperationalStateBackup,
} from '../operational-state-backup.js';
import { createWorkBoardStore, WorkBoardStoreError } from '../work-board-store.js';

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

  test('serializes concurrent mutations without losing updates', async () => {
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

  test('migrates the workflow schema to version 9 with the board table', async () => {
    await withTempRoot(async (root) => {
      createWorkBoardStore(root).close();
      const database = new DatabaseSync(join(root, 'runtime.sqlite'));
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
      } finally {
        database.close();
      }
    });
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
