import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import {
  authenticateInteractiveExternalConversationAuthorityWriter,
  EXTERNAL_CONVERSATION_RELEASE_RECEIPT_LIMIT,
  EXTERNAL_CONVERSATION_RELEASE_RECEIPT_TOTAL_LIMIT,
  openInteractiveExternalConversationAuthorityForWrite,
} from '../external-conversation-authority.js';
import {
  resolveStorageRoot,
  StorageRootAuthorityError,
  tryAcquireInteractiveRootOwner,
} from '../root-authority.js';

describe('interactive external-conversation authority', () => {
  test('persists one opaque binding across authentic successor writers', async () => {
    await withInteractiveRoot(async ({ root, capability }) => {
      const firstOwner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(firstOwner);
      if (!firstOwner) return;
      const first = await openInteractiveExternalConversationAuthorityForWrite(firstOwner.lease);
      assert.equal(authenticateInteractiveExternalConversationAuthorityWriter(first), first);
      const claimed = await first.resolve('slack:C1:thread:10.1', 'session-1');
      assert.equal(claimed.kind, 'claimed');
      assert.equal((await first.lookup('slack:C1:thread:10.1'))?.sessionId, 'session-1');
      assert.equal(await first.lookup('slack:C1:thread:missing'), undefined);
      const repeated = await first.resolve('slack:C1:thread:10.1', 'session-2');
      assert.notEqual(repeated.kind, 'limit_reached');
      if (repeated.kind === 'limit_reached') return;
      assert.equal(repeated.binding.sessionId, 'session-1');
      first.close();
      await firstOwner.close();

      const successor = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(successor);
      if (!successor) return;
      const second = await openInteractiveExternalConversationAuthorityForWrite(successor.lease);
      try {
        const resolved = await second.resolve('slack:C1:thread:10.1', 'session-3');
        assert.equal(resolved.kind, 'existing');
        assert.equal(resolved.binding.sessionId, 'session-1');
        const database = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true });
        try {
          const encoded = JSON.stringify(
            database.prepare('SELECT * FROM external_conversation_bindings').all(),
          );
          assert.equal(encoded.includes('slack:C1:thread:10.1'), false);
        } finally {
          database.close();
        }
      } finally {
        second.close();
        await successor.close();
      }
    });
  });

  test('replays a release receipt without deleting a newer binding', async () => {
    await withWriter(async (writer) => {
      await writer.resolve('telegram:chat-1', 'session-1');
      assert.deepEqual(await writer.release('telegram:chat-1', 'message-1'), {
        hadBinding: true,
      });
      await writer.resolve('telegram:chat-1', 'session-2');
      assert.deepEqual(await writer.release('telegram:chat-1', 'message-1'), {
        hadBinding: true,
      });
      const current = await writer.resolve('telegram:chat-1', 'session-3');
      assert.equal(current.kind, 'existing');
      assert.equal(current.binding.sessionId, 'session-2');
    });
  });

  test('bounds release receipts and purges bindings by Session', async () => {
    await withInteractiveRoot(async ({ root, capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      const writer = await openInteractiveExternalConversationAuthorityForWrite(owner.lease);
      try {
        for (let index = 0; index <= EXTERNAL_CONVERSATION_RELEASE_RECEIPT_LIMIT; index += 1) {
          await writer.resolve('feishu:chat-1', `session-${index}`);
          await writer.release('feishu:chat-1', `release-${index}`);
        }
        await writer.resolve('feishu:chat-1', 'session-final');
        assert.equal(await writer.purgeSession('session-final'), 1);
        const database = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true });
        try {
          const row = database
            .prepare(`
              SELECT COUNT(*) AS count
              FROM external_conversation_release_receipts
            `)
            .get() as { count: number };
          assert.equal(row.count, EXTERNAL_CONVERSATION_RELEASE_RECEIPT_LIMIT);
        } finally {
          database.close();
        }
      } finally {
        writer.close();
        await owner.close();
      }
    });
  });

  test('rejects access after the root lease closes', async () => {
    await withInteractiveRoot(async ({ capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      const writer = await openInteractiveExternalConversationAuthorityForWrite(owner.lease);
      await owner.close();
      await assert.rejects(
        () => writer.resolve('telegram:chat', 'session-1'),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'invalid_lease',
      );
      writer.close();
    });
  });

  test('bounds release receipts across unrelated conversations', async () => {
    await withInteractiveRoot(async ({ root, capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      const writer = await openInteractiveExternalConversationAuthorityForWrite(owner.lease);
      try {
        const database = new DatabaseSync(join(root, 'runtime.sqlite'));
        try {
          database
            .prepare(`
              WITH RECURSIVE sequence(value) AS (
                SELECT 0
                UNION ALL
                SELECT value + 1 FROM sequence WHERE value < ?
              )
              INSERT INTO external_conversation_release_receipts(
                conversation_digest, operation_id, had_binding, committed_at
              )
              SELECT
                'sha256:' || printf('%064x', value),
                'seed',
                0,
                value
              FROM sequence
            `)
            .run(EXTERNAL_CONVERSATION_RELEASE_RECEIPT_TOTAL_LIMIT - 1);
        } finally {
          database.close();
        }

        await writer.release('telegram:new-conversation', 'new-release');
        const inspection = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true });
        try {
          const count = inspection
            .prepare('SELECT COUNT(*) AS count FROM external_conversation_release_receipts')
            .get() as { count: number };
          assert.equal(count.count, EXTERNAL_CONVERSATION_RELEASE_RECEIPT_TOTAL_LIMIT);
          const newest = inspection
            .prepare(`
              SELECT operation_id AS operationId
              FROM external_conversation_release_receipts
              ORDER BY committed_at DESC, conversation_digest DESC, operation_id DESC
              LIMIT 1
            `)
            .get() as { operationId: string };
          assert.equal(newest.operationId, 'new-release');
        } finally {
          inspection.close();
        }
      } finally {
        writer.close();
        await owner.close();
      }
    });
  });
});

async function withWriter(
  run: (
    writer: Awaited<ReturnType<typeof openInteractiveExternalConversationAuthorityForWrite>>,
  ) => Promise<void>,
): Promise<void> {
  await withInteractiveRoot(async ({ capability }) => {
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    if (!owner) return;
    const writer = await openInteractiveExternalConversationAuthorityForWrite(owner.lease);
    try {
      await run(writer);
    } finally {
      writer.close();
      await owner.close();
    }
  });
}

async function withInteractiveRoot(
  run: (input: {
    root: string;
    capability: Awaited<ReturnType<typeof resolveStorageRoot<'interactive'>>>;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-external-conversation-authority-'));
  try {
    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    await run({ root, capability });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
