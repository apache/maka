import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  authenticateInteractiveTaskLedgerWriter,
  openInteractiveTaskLedgerStoreForWrite,
  type InteractiveTaskLedgerWriter,
} from '../task-ledger-authority.js';
import {
  createHeadlessRootLease,
  resolveStorageRoot,
  StorageRootAuthorityError,
  tryAcquireInteractiveRootOwner,
  type StorageRootLease,
} from '../root-authority.js';

const SESSION_ID = 'authority-session';

describe('interactive task ledger authority', () => {
  test('single-flights concurrent opens and uses one local observer surface', async () => {
    await withInteractiveRoot(async ({ capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      try {
        const [first, second] = await Promise.all([
          openInteractiveTaskLedgerStoreForWrite(owner.lease),
          openInteractiveTaskLedgerStoreForWrite(owner.lease),
        ]);
        assert.equal(first, second);
        assert.equal(authenticateInteractiveTaskLedgerWriter(first), first);

        const changes: string[][] = [];
        const unsubscribe = first.subscribe((event) => changes.push(event.taskIds));
        const result = await second.create(SESSION_ID, [{ subject: 'single writer' }]);
        unsubscribe();

        assert.equal(changes.length, 1);
        assert.deepEqual(changes[0], [result.created[0]?.id]);

        first.close();
        assert.throws(() => authenticateInteractiveTaskLedgerWriter(first), isInvalidLease);
        const reopened = await openInteractiveTaskLedgerStoreForWrite(owner.lease);
        assert.notEqual(reopened, first);
        assert.equal((await reopened.list(SESSION_ID)).length, 1);
        reopened.close();
      } finally {
        if (!owner.closed) await owner.close();
      }
    });
  });

  test('reads a current legacy tasks.json as canonical when no event ledger exists', async () => {
    await withInteractiveOwner(
      async ({ writer }) => {
        const listed = await writer.list(SESSION_ID);
        assert.equal(listed.length, 1);
        assert.equal(listed[0]?.id, 'legacy-task');
        assert.equal(listed[0]?.key, 'T1');
        assert.equal((await writer.get(SESSION_ID, 'T1'))?.subject, 'legacy canonical task');
      },
      async (root) => {
        await mkdir(join(root, 'sessions', SESSION_ID), { recursive: true });
        await writeFile(
          tasksPath(root),
          JSON.stringify([
            {
              id: 'legacy-task',
              subject: 'legacy canonical task',
              status: 'pending',
              createdAt: 1,
              updatedAt: 1,
            },
          ]),
          'utf8',
        );
      },
    );
  });

  test('fails closed on a corrupt event ledger even when a legacy cache exists', async () => {
    await withInteractiveRoot(async ({ root, capability }) => {
      await mkdir(join(root, 'sessions', SESSION_ID), { recursive: true });
      await writeFile(
        tasksPath(root),
        JSON.stringify([
          {
            id: 'cached-task',
            subject: 'must not become canonical',
            status: 'pending',
            createdAt: 1,
            updatedAt: 1,
          },
        ]),
        'utf8',
      );
      await writeFile(eventsPath(root), '{"not":"a task event"}\n', 'utf8');
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      try {
        await assert.rejects(
          () => openInteractiveTaskLedgerStoreForWrite(owner.lease),
          /Invalid task event JSONL line/,
        );
      } finally {
        if (!owner.closed) await owner.close();
      }
    });
  });

  test('rejects canonical reads and mutations after the owner releases its lease', async () => {
    await withInteractiveRoot(async ({ capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      const writer = await openInteractiveTaskLedgerStoreForWrite(owner.lease);
      await writer.create(SESSION_ID, [{ subject: 'before close' }]);
      await owner.close();

      await assert.rejects(() => writer.list(SESSION_ID), isInvalidLease);
      await assert.rejects(
        () => writer.create(SESSION_ID, [{ subject: 'after close' }]),
        isInvalidLease,
      );
      writer.close();
    });
  });

  test('rejects headless leases and forged writer facades', async () => {
    await withTempDir(async (base) => {
      const headless = await resolveStorageRoot({
        path: join(base, 'headless'),
        kind: 'headless',
      });
      await assert.rejects(
        () =>
          openInteractiveTaskLedgerStoreForWrite(
            createHeadlessRootLease(headless, 'write') as unknown as StorageRootLease<
              'interactive',
              'write'
            >,
          ),
        isInvalidLease,
      );
    });

    await withInteractiveOwner(async ({ writer }) => {
      assert.throws(
        () =>
          authenticateInteractiveTaskLedgerWriter({
            ...writer,
          } as InteractiveTaskLedgerWriter),
        isInvalidLease,
      );
    });
  });
});

async function withInteractiveOwner(
  run: (input: { root: string; writer: InteractiveTaskLedgerWriter }) => Promise<void>,
  prepare?: (root: string) => Promise<void>,
): Promise<void> {
  await withInteractiveRoot(async ({ root, capability }) => {
    await prepare?.(root);
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    if (!owner) return;
    let writer: InteractiveTaskLedgerWriter | undefined;
    try {
      writer = await openInteractiveTaskLedgerStoreForWrite(owner.lease);
      await run({
        root,
        writer,
      });
    } finally {
      writer?.close();
      if (!owner.closed) await owner.close();
    }
  });
}

async function withInteractiveRoot(
  run: (input: {
    root: string;
    capability: Awaited<ReturnType<typeof resolveStorageRoot<'interactive'>>>;
  }) => Promise<void>,
): Promise<void> {
  await withTempDir(async (base) => {
    const root = join(base, 'interactive');
    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    await run({ root, capability });
  });
}

async function withTempDir(run: (base: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-task-ledger-authority-'));
  try {
    await run(base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function tasksPath(root: string): string {
  return join(root, 'sessions', SESSION_ID, 'tasks.json');
}

function eventsPath(root: string): string {
  return join(root, 'sessions', SESSION_ID, 'task-events.jsonl');
}

function isInvalidLease(error: unknown): boolean {
  return error instanceof StorageRootAuthorityError && error.code === 'invalid_lease';
}
