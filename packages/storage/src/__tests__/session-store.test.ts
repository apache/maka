import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { CreateSessionInput } from '@maka/core/runtime-inputs';
import { createSessionStore, isSessionNotFoundError } from '../session-store.js';
import { OPERATIONAL_STATE_DATABASE_NAME } from '../operational-state-store.js';
import { createSqliteSessionMetadataStore } from '../sqlite-session-metadata-store.js';

describe('SQLite SessionStore', () => {
  test('persists session metadata and messages in one SQLite authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-sqlite-'));
    const store = createSessionStore(root);
    try {
      const session = await store.create(makeInput());
      await store.appendMessage(session.id, {
        type: 'user',
        id: 'message-1',
        turnId: 'turn-1',
        ts: 10,
        text: 'hello from SQLite',
      });

      assert.equal((await store.readMessages(session.id))[0]?.id, 'message-1');
      const page = await store.listCatalogPage(undefined, undefined, 10);
      assert.equal(page.kind, 'page');
      if (page.kind !== 'page') assert.fail('expected a catalog page');
      assert.equal(page.records[0]?.summary.lastMessagePreview, 'hello from SQLite');
    } finally {
      await store.close?.();
    }

    const reopened = createSessionStore(root);
    try {
      const [session] = await reopened.listHeaders();
      assert.ok(session);
      assert.equal((await reopened.readMessages(session.id))[0]?.id, 'message-1');
    } finally {
      await reopened.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('keeps staging imports outside the catalog pagination domain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-staging-catalog-'));
    const store = createSessionStore(root);
    try {
      const visible = await store.create(makeInput({ name: 'Visible Session' }));
      const staging = await Promise.all(
        Array.from({ length: 32 }, (_, index) =>
          store.createImportedSession(makeInput({ name: `Staging Session ${index}` }), []),
        ),
      );

      const page = await store.listCatalogPage(undefined, undefined, 32);

      assert.equal(page.kind, 'page');
      if (page.kind !== 'page') assert.fail('expected a catalog page');
      assert.deepEqual(
        page.records.map((record) => record.header.id),
        [visible.id],
      );
      assert.equal(page.hasMore, false);
      await assert.rejects(store.readCatalogRecord(staging[0]!.id), (error) =>
        isSessionNotFoundError(error),
      );
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('appending the first user message locks the session before any read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-lock-heal-'));
    const store = createSessionStore(root);
    try {
      const session = await store.create(makeInput());
      await store.appendMessage(session.id, {
        type: 'user',
        id: 'message-1',
        turnId: 'turn-1',
        ts: 10,
        text: 'legacy message',
      });
      assert.equal((await store.readHeaderSnapshot(session.id)).connectionLocked, true);
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('commits message and catalog projection atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-atomic-'));
    const store = createSessionStore(root);
    try {
      const session = await store.create(makeInput());
      const metadata = createSqliteSessionMetadataStore(
        join(root, OPERATIONAL_STATE_DATABASE_NAME),
      );
      try {
        await store.appendMessage(session.id, {
          type: 'assistant',
          id: 'message-1',
          turnId: 'turn-1',
          ts: 20,
          text: 'atomic preview',
          modelId: 'fake-model',
        });
        assert.equal((await metadata.readMessages(session.id))[0]?.id, 'message-1');
        assert.equal(
          (await metadata.listCatalogPage({}, undefined, 10)).records[0]?.lastMessagePreview,
          'atomic preview',
        );
      } finally {
        metadata.close();
      }
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('pages the durable transcript by sequence, bytes, and a fixed watermark', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-transcript-pages-'));
    const store = createSessionStore(root);
    try {
      const session = await store.create(makeInput());
      const messages = ['zero', 'one', 'two', '三🙂'].map((text, index) => ({
        type: 'user' as const,
        id: `message-${index}`,
        turnId: `turn-${index}`,
        ts: index + 1,
        text,
      }));
      await store.appendMessages(session.id, messages);

      const tail = await store.readTranscriptPageSnapshot(session.id, {
        direction: 'older',
        maxBytes: 64 * 1024,
        maxMessages: 2,
      });
      assert.equal(tail.throughSequence, 3);
      assert.deepEqual(
        tail.fragments.map(({ sequence }) => sequence),
        [3, 2],
      );
      assert.deepEqual(tail.next, { position: 1, byteOffset: null });

      await store.appendMessage(session.id, {
        type: 'user',
        id: 'message-4',
        turnId: 'turn-4',
        ts: 5,
        text: 'appended after the watermark',
      });
      const older = await store.readTranscriptPageSnapshot(session.id, {
        direction: 'older',
        throughSequence: tail.throughSequence ?? undefined,
        position: 1,
        maxBytes: 64 * 1024,
        maxMessages: 2,
      });
      assert.equal(older.throughSequence, 3);
      assert.deepEqual(
        older.fragments.map(({ sequence }) => sequence),
        [1, 0],
      );
      assert.equal(older.next, null);

      const newer = await store.readTranscriptPageSnapshot(session.id, {
        direction: 'newer',
        throughSequence: 3,
        position: 2,
        maxBytes: 64 * 1024,
        maxMessages: 10,
      });
      assert.deepEqual(
        newer.fragments.map(({ sequence }) => sequence),
        [2, 3],
      );
      assert.equal(newer.next, null);

      const oversized = await store.readTranscriptPageSnapshot(session.id, {
        direction: 'older',
        throughSequence: 3,
        maxBytes: 1,
        maxMessages: 10,
      });
      assert.deepEqual(
        oversized.fragments.map(({ sequence }) => sequence),
        [3],
      );
      assert.equal(oversized.fragments[0]!.data.byteLength, 1);
      assert.ok(oversized.fragments[0]!.totalBytes > 1);
      assert.deepEqual(oversized.next, {
        position: 3,
        byteOffset: oversized.fragments[0]!.byteOffset,
      });
      const fragments = [...oversized.fragments];
      let continuation: { readonly position: number; readonly byteOffset: number | null } | null =
        oversized.next;
      while (continuation?.position === 3 && continuation.byteOffset !== null) {
        const page = await store.readTranscriptPageSnapshot(session.id, {
          direction: 'older',
          throughSequence: 3,
          position: continuation.position,
          byteOffset: continuation.byteOffset,
          maxBytes: 7,
          maxMessages: 10,
        });
        fragments.push(...page.fragments);
        continuation = page.next;
      }
      const reconstructed = Buffer.concat(
        fragments
          .filter((fragment) => fragment.sequence === 3)
          .sort((left, right) => left.byteOffset - right.byteOffset)
          .map((fragment) => fragment.data),
      );
      assert.deepEqual(JSON.parse(reconstructed.toString('utf8')), messages[3]);
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('returns an empty transcript page with no watermark', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-empty-transcript-'));
    const store = createSessionStore(root);
    try {
      const session = await store.create(makeInput());
      assert.deepEqual(
        await store.readTranscriptPageSnapshot(session.id, {
          direction: 'older',
          maxBytes: 1024,
          maxMessages: 10,
        }),
        { throughSequence: null, fragments: [], rawBytes: 0, next: null },
      );
      assert.equal(await store.readTranscriptHighWaterSnapshot(session.id), null);
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('notifies transcript observers only after successful durable appends', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-transcript-observer-'));
    const store = createSessionStore(root);
    try {
      const session = await store.create(makeInput());
      const changed: string[] = [];
      const unsubscribe = store.subscribeTranscriptChanges((sessionId) => changed.push(sessionId));
      await store.appendMessages(session.id, [
        { type: 'user', id: 'message-1', turnId: 'turn-1', ts: 1, text: 'one' },
        { type: 'user', id: 'message-2', turnId: 'turn-2', ts: 2, text: 'two' },
      ]);
      assert.deepEqual(changed, [session.id]);
      await assert.rejects(
        store.appendMessage('missing-session', {
          type: 'user',
          id: 'message-2',
          turnId: 'turn-duplicate',
          ts: 3,
          text: 'duplicate',
        }),
      );
      assert.deepEqual(changed, [session.id]);
      unsubscribe();
      await store.appendMessage(session.id, {
        type: 'user',
        id: 'message-3',
        turnId: 'turn-3',
        ts: 3,
        text: 'three',
      });
      assert.deepEqual(changed, [session.id]);
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('clears unread when the current read marker is already the latest visible message', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-read-marker-'));
    const store = createSessionStore(root);
    try {
      const session = await store.create(makeInput());
      await store.appendMessage(session.id, {
        type: 'assistant',
        id: 'message-1',
        turnId: 'turn-1',
        ts: 20,
        text: 'already read',
        modelId: 'fake-model',
      });
      await store.updateHeader(session.id, {
        lastReadMessageId: 'message-1',
        hasUnread: true,
      });

      const updated = await store.markSessionReadThroughMessage(session.id, 'message-1');

      assert.equal(updated.header.lastReadMessageId, 'message-1');
      assert.equal(updated.header.hasUnread, false);
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('deletes metadata and messages through the same transaction boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-delete-'));
    const store = createSessionStore(root);
    try {
      const session = await store.create(makeInput());
      await store.appendMessage(session.id, {
        type: 'user',
        id: 'message-1',
        turnId: 'turn-1',
        ts: 30,
        text: 'delete me',
      });
      await store.remove(session.id);
      await assert.rejects(store.readHeaderSnapshot(session.id), (error) => {
        assert.equal(isSessionNotFoundError(error), true);
        return true;
      });
      await assert.rejects(store.readMessages(session.id), (error) => {
        assert.equal(isSessionNotFoundError(error), true);
        return true;
      });
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function makeInput(overrides: Partial<CreateSessionInput> = {}): CreateSessionInput {
  return {
    cwd: '/tmp/cwd',
    backend: 'fake',
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask',
    name: 'Session',
    labels: [],
    ...overrides,
  };
}
