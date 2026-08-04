import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import {
  SUBAGENT_WORKSPACE_BINDING_SCHEMA_VERSION,
  type CreateSessionInput,
  type SessionHeader,
  type SessionListFilter,
  type SubagentWorkspaceBinding,
} from '@maka/core';
import {
  createLegacyFileSessionStore,
  createSessionStore,
  isSessionNotFoundError,
  SessionReadMarkerMessageNotFoundError,
  SessionNotFoundError,
  SQLITE_SESSION_METADATA_DATABASE_NAME,
  type StableSessionCreateInput,
} from '../session-store.js';
import { createSessionStoreForTest } from '../session-store-test-support.js';
import {
  createSqliteSessionMetadataStore,
  SessionMetadataVersionConflictError,
} from '../sqlite-session-metadata-store.js';
import {
  buildSqliteSessionCatalogPageQuery,
  type SqliteSessionCatalogCursor,
} from '../sqlite-session-catalog-query.js';
import { createSessionTranscriptMarker } from '../session-transcript.js';

describe('default SQLite session metadata store', () => {
  test('SQLite and legacy File stores expose one typed missing-Session boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-store-not-found-'));
    const stores = [
      createSessionStore(join(root, 'sqlite')),
      createLegacyFileSessionStore(join(root, 'legacy')),
    ];
    try {
      for (const store of stores) {
        await assert.rejects(store.readHeaderSnapshot('deleted-session'), (error) => {
          assert.ok(error instanceof SessionNotFoundError);
          assert.equal(isSessionNotFoundError(error), true);
          assert.equal(error.code, 'session_not_found');
          assert.equal(error.sessionId, 'deleted-session');
          return true;
        });
      }
    } finally {
      await Promise.all(stores.map((store) => store.close?.()));
      await rm(root, { recursive: true, force: true });
    }
  });

  test('waits for in-flight legacy metadata import before closing SQLite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-store-close-ready-'));
    const legacy = createLegacyFileSessionStore(root);
    const created = await legacy.create(makeInput({ name: 'Imported before close' }));
    const store = createSessionStore(root);

    try {
      await store.close?.();
      const metadata = createSqliteSessionMetadataStore(
        join(root, SQLITE_SESSION_METADATA_DATABASE_NAME),
      );
      try {
        assert.equal((await metadata.read(created.id)).header.name, 'Imported before close');
      } finally {
        metadata.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('paginates the catalog with a durable keyset revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-catalog-page-'));
    const store = createSessionStore(root);
    try {
      for (let index = 0; index < 40; index += 1) {
        const header = await store.create(
          makeInput({ name: `Session ${String(index).padStart(2, '0')}` }),
        );
        await store.updateHeader(header.id, { lastMessageAt: 1_000 + index });
      }

      const first = await store.listCatalogPage(undefined, undefined, 10);
      assert.equal(first.kind, 'page');
      if (first.kind !== 'page') assert.fail('Catalog start must return a page');
      assert.equal(first.records.length, 10);
      assert.equal(first.hasMore, true);
      const firstIds = new Set(first.records.map((record) => record.header.id));
      const last = first.records.at(-1);
      assert.ok(last);
      if (!last) assert.fail('Catalog page must have a keyset boundary');

      const second = await store.listCatalogPage(
        undefined,
        {
          activityAt: last.header.lastMessageAt ?? last.header.lastUsedAt ?? last.header.createdAt,
          sessionId: last.header.id,
        },
        10,
        first.revision,
      );
      assert.equal(second.kind, 'page');
      if (second.kind !== 'page') assert.fail('Stable continuation must return a page');
      assert.equal(second.records.length, 10);
      assert.equal(
        second.records.some((record) => firstIds.has(record.header.id)),
        false,
      );

      await store.appendMessage(last.header.id, {
        type: 'user',
        id: 'catalog-revision-message',
        turnId: 'catalog-revision-turn',
        ts: 2_000,
        text: 'invalidate the catalog snapshot',
      });
      const stale = await store.listCatalogPage(
        undefined,
        {
          activityAt: last.header.lastMessageAt ?? last.header.lastUsedAt ?? last.header.createdAt,
          sessionId: last.header.id,
        },
        10,
        first.revision,
      );
      assert.equal(stale.kind, 'revision_changed');
      if (stale.kind === 'revision_changed') {
        assert.equal(stale.expectedRevision, first.revision);
        assert.notEqual(stale.actualRevision, first.revision);
      }
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('publishes transcript previews and catalog revisions through one SQLite commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-catalog-projection-'));
    const store = createSessionStore(root);
    try {
      const session = await store.create(makeInput());
      await store.appendMessage(session.id, {
        type: 'user',
        id: 'message-1',
        turnId: 'turn-1',
        ts: 10,
        text: 'first preview',
      });
      const first = await store.listCatalogPage(undefined, undefined, 10);
      assert.equal(first.kind, 'page');
      if (first.kind !== 'page') assert.fail('Catalog start must return a page');
      assert.equal(first.records[0]?.summary.lastMessagePreview, 'first preview');
      await store.close?.();

      const metadata = createSqliteSessionMetadataStore(
        join(root, SQLITE_SESSION_METADATA_DATABASE_NAME),
      );
      const transcript = createLegacyFileSessionStore(root);
      try {
        const base = await metadata.listCatalogPage({}, undefined, 10);
        await metadata.beginCatalogProjectionWrite();
        await transcript.appendMessage(session.id, {
          type: 'assistant',
          id: 'message-2',
          turnId: 'turn-1',
          ts: 20,
          text: 'second preview',
          modelId: 'fake-model',
        });

        const beforeCommit = await metadata.listCatalogPage({}, undefined, 10);
        assert.equal(beforeCommit.records[0]?.lastMessagePreview, 'first preview');
        assert.deepEqual(beforeCommit.revision, base.revision);

        await metadata.commitCatalogProjectionWrite(session.id, {
          lastMessageAt: 20,
          lastMessagePreview: 'second preview',
        });
        const afterCommit = await metadata.listCatalogPage({}, undefined, 10);
        assert.equal(afterCommit.records[0]?.lastMessagePreview, 'second preview');
        assert.ok(afterCommit.revision.generation > beforeCommit.revision.generation);
      } finally {
        metadata.close();
        await transcript.close?.();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('advances the catalog generation once per metadata transaction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-catalog-generation-'));
    const store = createSessionStore(root);
    let metadata: ReturnType<typeof createSqliteSessionMetadataStore> | undefined;
    try {
      const session = await store.create(makeInput({ labels: ['one', 'two'] }));
      await store.close?.();
      metadata = createSqliteSessionMetadataStore(
        join(root, SQLITE_SESSION_METADATA_DATABASE_NAME),
      );
      const initial = await metadata.listCatalogPage({}, undefined, 10);

      await metadata.update(session.id, { name: 'Renamed' });
      const renamed = await metadata.listCatalogPage({}, undefined, 10);
      assert.equal(renamed.revision.generation, initial.revision.generation + 1);
      assert.deepEqual(renamed.records[0]?.header.labels, ['one', 'two']);

      await metadata.update(session.id, { labels: ['three'] });
      const relabeled = await metadata.listCatalogPage({ labelSlug: 'three' }, undefined, 10);
      assert.equal(relabeled.revision.generation, renamed.revision.generation + 1);
      assert.equal(relabeled.records[0]?.header.id, session.id);
    } finally {
      if (metadata) metadata.close();
      else await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('repairs a transcript append left pending before its catalog projection commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-catalog-recovery-'));
    const store = createSessionStore(root);
    const session = await store.create(makeInput());
    await store.close?.();

    const metadata = createSqliteSessionMetadataStore(
      join(root, SQLITE_SESSION_METADATA_DATABASE_NAME),
    );
    const transcript = createLegacyFileSessionStore(root);
    try {
      await metadata.beginCatalogProjectionWrite();
      await transcript.appendMessage(session.id, {
        type: 'user',
        id: 'recovered-message',
        turnId: 'recovered-turn',
        ts: 30,
        text: 'recovered preview',
      });
    } finally {
      metadata.close();
      await transcript.close?.();
    }

    const reopened = createSessionStore(root);
    try {
      const page = await reopened.listCatalogPage(undefined, undefined, 10);
      assert.equal(page.kind, 'page');
      if (page.kind !== 'page') assert.fail('Recovered catalog must return a page');
      assert.equal(page.records[0]?.summary.lastMessageAt, 30);
      assert.equal(page.records[0]?.summary.lastMessagePreview, 'recovered preview');
    } finally {
      await reopened.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('repairs a pending catalog projection from a message larger than the preview window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-catalog-large-recovery-'));
    const store = createSessionStore(root);
    const session = await store.create(makeInput());
    await store.close?.();

    const metadata = createSqliteSessionMetadataStore(
      join(root, SQLITE_SESSION_METADATA_DATABASE_NAME),
    );
    const transcript = createLegacyFileSessionStore(root);
    try {
      await metadata.beginCatalogProjectionWrite();
      await transcript.appendMessage(session.id, {
        type: 'user',
        id: 'large-recovered-message',
        turnId: 'large-recovered-turn',
        ts: 40,
        text: `large recovered preview ${'x'.repeat(70 * 1024)}`,
      });
    } finally {
      metadata.close();
      await transcript.close?.();
    }

    const reopened = createSessionStore(root);
    try {
      const page = await reopened.listCatalogPage(undefined, undefined, 10);
      assert.equal(page.kind, 'page');
      if (page.kind !== 'page') assert.fail('Recovered catalog must return a page');
      assert.equal(page.records[0]?.summary.lastMessageAt, 40);
      assert.match(page.records[0]?.summary.lastMessagePreview ?? '', /^large recovered preview/);
    } finally {
      await reopened.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('repairs a pending catalog projection before the same store serves another page', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-catalog-live-recovery-'));
    const store = createSessionStore(root);
    const metadata = createSqliteSessionMetadataStore(
      join(root, SQLITE_SESSION_METADATA_DATABASE_NAME),
    );
    const transcript = createLegacyFileSessionStore(root);
    try {
      const session = await store.create(makeInput());
      await metadata.beginCatalogProjectionWrite();
      await transcript.appendMessage(session.id, {
        type: 'assistant',
        id: 'live-recovered-message',
        turnId: 'live-recovered-turn',
        ts: 50,
        text: 'live recovered preview',
        modelId: 'fake-model',
      });

      const page = await store.listCatalogPage(undefined, undefined, 10);
      assert.equal(page.kind, 'page');
      if (page.kind !== 'page') assert.fail('Recovered catalog must return a page');
      assert.equal(page.records[0]?.summary.lastMessageAt, 50);
      assert.equal(page.records[0]?.summary.lastMessagePreview, 'live recovered preview');
      assert.equal(await metadata.hasPendingCatalogProjectionWrites(), false);
    } finally {
      metadata.close();
      await transcript.close?.();
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('uses ordered catalog indexes without temporary sorting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-catalog-index-'));
    const store = createSessionStore(root);
    try {
      const parent = await store.create(makeInput({ name: 'Parent' }));
      await store.create(
        makeInput({
          name: 'Indexed',
          labels: ['indexed'],
          subagentParent: {
            kind: 'subagent',
            parentSessionId: parent.id,
            lifecycle: 'foreground',
            spawnedBy: {
              parentRunId: 'parent-run',
              parentTurnId: 'parent-turn',
              toolCallId: 'tool-call',
            },
          },
        }),
      );
      await store.close?.();

      const database = new DatabaseSync(join(root, SQLITE_SESSION_METADATA_DATABASE_NAME));
      try {
        assertCatalogQueryPlan(database, {}, undefined, 'session_catalog_by_activity');
        assertCatalogQueryPlan(
          database,
          { isArchived: false, isFlagged: false },
          undefined,
          'session_catalog_by_archived_flagged_activity',
        );
        assertCatalogQueryPlan(
          database,
          { labelSlug: 'indexed' },
          undefined,
          'session_catalog_labels_by_label_activity',
        );
        assertCatalogQueryPlan(
          database,
          {},
          { activityAt: Number.MAX_SAFE_INTEGER, sessionId: parent.id },
          'session_catalog_by_activity',
          'SEARCH projection',
        );
        assertCatalogQueryPlan(
          database,
          { labelSlug: 'indexed' },
          { activityAt: Number.MAX_SAFE_INTEGER, sessionId: parent.id },
          'session_catalog_labels_by_label_activity',
          'SEARCH selected_label',
        );
      } finally {
        database.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('uses SQLite as canonical metadata while keeping transcript bodies in JSONL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-default-session-store-'));
    const store = createSessionStore(root);
    try {
      const created = await store.create(makeInput({ name: 'Initial title' }));
      await store.appendMessage(created.id, {
        type: 'user',
        id: 'user-1',
        turnId: 'turn-1',
        ts: 10,
        text: 'hello',
      });
      await store.rename(created.id, 'SQLite title');
      await store.updateHeader(created.id, {
        hasUnread: true,
        lastMessageAt: 10,
      });

      assert.equal((await store.readHeader(created.id)).name, 'SQLite title');
      assert.equal((await store.list())[0]?.name, 'SQLite title');
      assert.equal((await store.readMessages(created.id))[0]?.type, 'user');

      const transcriptPath = join(root, 'sessions', created.id, 'session.jsonl');
      const [marker, message] = (await readFile(transcriptPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.deepEqual(marker, {
        type: 'session_transcript',
        sessionId: created.id,
        schemaVersion: 1,
      });
      assert.equal('name' in (marker ?? {}), false);
      assert.equal(message?.type, 'user');
      await stat(join(root, SQLITE_SESSION_METADATA_DATABASE_NAME));
      await assert.rejects(() => stat(join(root, 'sessions.sqlite')), { code: 'ENOENT' });

      await store.close?.();
      const reopened = createSessionStore(root);
      try {
        assert.equal((await reopened.readHeader(created.id)).name, 'SQLite title');
        assert.equal((await reopened.readMessages(created.id)).length, 1);
      } finally {
        await reopened.close?.();
      }
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('provides stable create retries and message-identity read markers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-default-session-stable-create-'));
    const sessionId = 'stable-session';
    const requestFingerprint = `sha256:${'c'.repeat(64)}`;
    const request = {
      sessionId,
      requestFingerprint,
      input: makeInput({ name: 'Original' }),
    };
    const store = createSessionStore(root);
    try {
      const created = await store.createStableSession(request);
      assert.equal(created.kind, 'created');
      assert.equal(created.record.header.id, sessionId);

      const retried = await store.createStableSession({
        ...request,
        input: makeInput({ name: 'Changed default' }),
      });
      assert.equal(retried.kind, 'existing');
      assert.equal(retried.record.header.name, 'Original');
      assert.deepEqual(
        await store.createStableSession({
          ...request,
          requestFingerprint: `sha256:${'d'.repeat(64)}`,
        }),
        { kind: 'conflict', reason: 'identity_mismatch' },
      );

      await store.appendMessages(sessionId, [
        { type: 'user', id: 'message-1', turnId: 'turn-1', ts: 1, text: 'one' },
        { type: 'user', id: 'message-2', turnId: 'turn-2', ts: 2, text: 'two' },
        { type: 'user', id: 'message-3', turnId: 'turn-3', ts: 3, text: 'three' },
      ]);
      await store.updateHeader(sessionId, { hasUnread: true, lastMessageAt: 3 });

      const readMessagesSnapshot = store.readMessagesSnapshot.bind(store);
      let interleaved = false;
      store.readMessagesSnapshot = async (id) => {
        const messages = await readMessagesSnapshot(id);
        if (!interleaved) {
          interleaved = true;
          await store.updateHeader(id, { name: 'Concurrent metadata update' });
        }
        return messages;
      };
      const partial = await store.markSessionReadThroughMessage(sessionId, 'message-2');
      assert.equal(interleaved, true);
      assert.equal(partial.header.lastReadMessageId, 'message-2');
      assert.equal(partial.header.hasUnread, true);
      const complete = await store.markSessionReadThroughMessage(sessionId, 'message-3');
      assert.equal(complete.header.lastReadMessageId, 'message-3');
      assert.equal(complete.header.hasUnread, false);
      assert.deepEqual(await store.markSessionReadThroughMessage(sessionId, 'message-1'), complete);
      await assert.rejects(
        store.markSessionReadThroughMessage(sessionId, 'missing-message'),
        (error) => {
          assert.ok(error instanceof SessionReadMarkerMessageNotFoundError);
          assert.equal(error.sessionId, sessionId);
          assert.equal(error.messageId, 'missing-message');
          return true;
        },
      );

      await store.appendMessage(sessionId, {
        type: 'user',
        id: 'message-4',
        turnId: 'turn-4',
        ts: 4,
        text: 'four',
      });
      await store.updateHeader(sessionId, { hasUnread: true, lastMessageAt: 4 });
      const updateHeaderVersioned = store.updateHeaderVersioned.bind(store);
      let conflictAttempts = 0;
      store.updateHeaderVersioned = async (id, patch, expectedRevision) => {
        conflictAttempts += 1;
        throw new SessionMetadataVersionConflictError(
          id,
          expectedRevision,
          expectedRevision + conflictAttempts,
        );
      };
      await assert.rejects(
        store.markSessionReadThroughMessage(sessionId, 'message-4'),
        SessionMetadataVersionConflictError,
      );
      assert.equal(conflictAttempts, 3);
      store.updateHeaderVersioned = updateHeaderVersioned;

      await store.remove(sessionId);
    } finally {
      await store.close?.();
    }

    const reopened = createSessionStore(root);
    try {
      assert.deepEqual(await reopened.createStableSession(request), {
        kind: 'conflict',
        reason: 'removed',
      });
    } finally {
      await reopened.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('recovers stable creation after a claimed marker-only transcript is left behind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-default-session-stable-recovery-'));
    const sessionId = 'stable-recovery';
    const requestFingerprint = `sha256:${'e'.repeat(64)}`;
    try {
      const metadata = createSqliteSessionMetadataStore(
        join(root, SQLITE_SESSION_METADATA_DATABASE_NAME),
      );
      try {
        assert.deepEqual(await metadata.claimStableSessionCreate(sessionId, requestFingerprint), {
          kind: 'absent',
        });
      } finally {
        metadata.close();
      }
      const sessionDir = join(root, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, 'session.jsonl'),
        `${JSON.stringify(createSessionTranscriptMarker(sessionId))}\n`,
      );

      const store = createSessionStore(root);
      try {
        const request = {
          sessionId,
          requestFingerprint,
          input: makeInput({ name: 'Recovered' }),
        };
        const created = await store.createStableSession(request);
        assert.equal(created.kind, 'created');
        assert.equal(created.record.header.name, 'Recovered');
        assert.deepEqual(await store.readMessagesSnapshot(sessionId), []);
        assert.equal((await store.createStableSession(request)).kind, 'existing');
      } finally {
        await store.close?.();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('repairs empty and recognizable truncated stable-create transcripts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-default-session-stable-truncated-'));
    const requestFingerprint = `sha256:${'f'.repeat(64)}`;
    const fixtures = ['stable-empty', 'stable-truncated'].map((sessionId, index) => {
      const marker = `${JSON.stringify(createSessionTranscriptMarker(sessionId))}\n`;
      return {
        sessionId,
        marker,
        initial: index === 0 ? '' : marker.slice(0, -5),
      };
    });
    try {
      const metadata = createSqliteSessionMetadataStore(
        join(root, SQLITE_SESSION_METADATA_DATABASE_NAME),
      );
      try {
        for (const fixture of fixtures) {
          assert.deepEqual(
            await metadata.claimStableSessionCreate(fixture.sessionId, requestFingerprint),
            { kind: 'absent' },
          );
          const sessionDir = join(root, 'sessions', fixture.sessionId);
          await mkdir(sessionDir, { recursive: true });
          await writeFile(join(sessionDir, 'session.jsonl'), fixture.initial);
        }
      } finally {
        metadata.close();
      }

      const store = createSessionStore(root);
      try {
        for (const fixture of fixtures) {
          const created = await store.createStableSession({
            sessionId: fixture.sessionId,
            requestFingerprint,
            input: makeInput({ name: `Recovered ${fixture.sessionId}` }),
          });
          assert.equal(created.kind, 'created');
          assert.equal(
            await readFile(join(root, 'sessions', fixture.sessionId, 'session.jsonl'), 'utf8'),
            fixture.marker,
          );
          assert.equal(
            (await stat(join(root, 'sessions', fixture.sessionId, 'session.jsonl'))).mode & 0o777,
            0o600,
          );
        }
      } finally {
        await store.close?.();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('hides preparing conversation copies and discards them without tombstoning stable identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-copy-publication-'));
    const store = createSessionStore(root);
    const sessionId = 'stable-copy';
    const requestFingerprint: `sha256:${string}` = `sha256:${'f'.repeat(64)}`;
    const input: StableSessionCreateInput = {
      ...makeInput({
        parentSessionId: 'source-session',
        branchOfTurnId: 'turn-1',
      }),
      conversationCopy: {
        kind: 'branch',
        sourceSessionId: 'source-session',
        sourceTurnId: 'turn-1',
        requestFingerprint,
        state: 'preparing',
      },
    };
    try {
      await assert.rejects(
        () => store.create(input),
        /Conversation copy metadata requires createStableSession/,
      );
      assert.equal(
        (await store.createStableSession({ sessionId, requestFingerprint, input })).kind,
        'created',
      );
      assert.deepEqual(await store.list(), []);
      const page = await store.listCatalogPage(undefined, undefined, 10);
      assert.equal(page.kind, 'page');
      if (page.kind !== 'page') assert.fail('Expected a Session catalog page');
      assert.deepEqual(page.records, []);
      await assert.rejects(() => store.readCatalogRecord(sessionId), isSessionNotFoundError);

      assert.equal(await store.discardStableConversationCopy(sessionId, requestFingerprint), true);
      assert.equal(
        (await store.createStableSession({ sessionId, requestFingerprint, input })).kind,
        'created',
      );
      await store.updateHeader(sessionId, {
        conversationCopy: { ...input.conversationCopy!, state: 'committed' },
      });
      assert.equal((await store.list())[0]?.id, sessionId);
      assert.equal((await store.readCatalogRecord(sessionId)).header.id, sessionId);
      await assert.rejects(
        () => store.updateHeader(sessionId, { conversationCopy: undefined }),
        /conversation-copy identity is immutable/,
      );
      await assert.rejects(
        () => store.discardStableConversationCopy(sessionId, requestFingerprint),
        /matching incomplete conversation copy/,
      );
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('recovers pending catalog publication after an incomplete copy loses its transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-copy-recovery-'));
    const sessionId = 'interrupted-copy';
    const requestFingerprint: `sha256:${string}` = `sha256:${'a'.repeat(64)}`;
    const input: StableSessionCreateInput = {
      ...makeInput({
        parentSessionId: 'source-session',
        branchOfTurnId: 'turn-1',
      }),
      conversationCopy: {
        kind: 'branch',
        sourceSessionId: 'source-session',
        sourceTurnId: 'turn-1',
        requestFingerprint,
        state: 'preparing',
      },
    };
    const initial = createSessionStore(root);
    try {
      assert.equal(
        (
          await initial.createStableSession({
            sessionId,
            requestFingerprint,
            input,
          })
        ).kind,
        'created',
      );
    } finally {
      await initial.close?.();
    }

    const metadata = createSqliteSessionMetadataStore(
      join(root, SQLITE_SESSION_METADATA_DATABASE_NAME),
    );
    try {
      await metadata.requireCatalogProjectionRecovery();
    } finally {
      metadata.close();
    }
    await rm(join(root, 'sessions', sessionId), { recursive: true, force: true });

    const recovered = createSessionStore(root);
    try {
      assert.equal((await recovered.listHeaders())[0]?.id, sessionId);
      assert.equal(
        await recovered.discardStableConversationCopy(sessionId, requestFingerprint),
        true,
      );
      assert.equal(
        (
          await recovered.createStableSession({
            sessionId,
            requestFingerprint,
            input,
          })
        ).kind,
        'created',
      );
    } finally {
      await recovered.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('persists the stable project association in SQLite metadata and summaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-default-session-project-'));
    const store = createSessionStore(root);
    try {
      const created = await store.create(makeInput({ projectId: 'project-1' }));

      assert.equal(created.projectId, 'project-1');
      assert.equal((await store.readHeaderSnapshot(created.id)).projectId, 'project-1');
      assert.equal((await store.list())[0]?.projectId, 'project-1');

      await store.close?.();
      const reopened = createSessionStore(root);
      try {
        assert.equal((await reopened.readHeaderSnapshot(created.id)).projectId, 'project-1');
        assert.equal((await reopened.list())[0]?.projectId, 'project-1');
      } finally {
        await reopened.close?.();
      }
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('persists an explicit no-project association across SQLite reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-default-session-no-project-'));
    const store = createSessionStore(root);
    try {
      const created = await store.create(makeInput({ projectId: null }));

      assert.equal(created.projectId, null);
      assert.equal((await store.readHeaderSnapshot(created.id)).projectId, null);
      assert.equal((await store.list())[0]?.projectId, null);

      await store.close?.();
      const reopened = createSessionStore(root);
      try {
        assert.equal((await reopened.readHeaderSnapshot(created.id)).projectId, null);
        assert.equal((await reopened.list())[0]?.projectId, null);
      } finally {
        await reopened.close?.();
      }
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('lists linked child sessions through SQLite without conflating ordinary branches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-default-session-relations-'));
    const store = createSessionStore(root);
    try {
      const parent = await store.create(makeInput({ name: 'Parent' }));
      const childInput = makeInput({
        name: 'Child',
        permissionMode: 'execute',
        subagentParent: {
          kind: 'subagent',
          parentSessionId: parent.id,
          spawnedBy: {
            parentRunId: 'parent-run',
            parentTurnId: 'parent-turn',
            toolCallId: 'tool-call',
          },
          lifecycle: 'foreground',
        },
        subagentRuntime: {
          schemaVersion: 1,
          definitionVersion: 1,
          agentId: 'local-read',
          agentName: 'Local Read',
          profile: 'local_read',
          systemPrompt: 'Read the assigned workspace task.',
          toolNames: ['Read', 'Glob', 'Grep'],
          categoryPolicy: { read: 'allow' },
        },
        subagentSpawn: {
          schemaVersion: 1,
          requestFingerprint: 'a'.repeat(64),
          initialTurnId: 'child-turn',
          initialRunId: 'child-run',
        },
      });
      const { header: child, created } = await store.createSubagent(childInput);
      assert.equal(created, true);
      const retry = await store.createSubagent(childInput);
      assert.equal(retry.created, false);
      assert.equal(retry.header.id, child.id);
      await assert.rejects(
        () =>
          store.createSubagent({
            ...childInput,
            subagentSpawn: {
              ...childInput.subagentSpawn!,
              requestFingerprint: 'b'.repeat(64),
            },
          }),
        /reused for different work/,
      );
      await store.create(
        makeInput({
          name: 'Branch',
          parentSessionId: parent.id,
          branchOfTurnId: 'parent-turn',
        }),
      );

      const children = await store.list({ subagentParentSessionId: parent.id });
      assert.deepEqual(
        children.map((session) => session.id),
        [child.id],
      );
      assert.equal(children[0]?.subagentParent?.parentSessionId, parent.id);
      assert.deepEqual(children[0]?.subagentRuntime?.toolNames, ['Read', 'Glob', 'Grep']);
    } finally {
      store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('persists an immutable child worktree binding across summaries and reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-default-session-worktree-'));
    const store = createSessionStore(root);
    const workspace = makeSubagentWorkspace();
    let childId = '';
    try {
      const parent = await store.create(
        makeInput({ name: 'Parent', cwd: '/workspace/repository', projectId: 'project-1' }),
      );
      const { header: child } = await store.createSubagent(
        makeInput({
          name: 'Implementation child',
          cwd: workspace.worktreePath,
          projectId: 'project-1',
          permissionMode: 'execute',
          subagentParent: {
            kind: 'subagent',
            parentSessionId: parent.id,
            spawnedBy: {
              parentRunId: 'parent-run',
              parentTurnId: 'parent-turn',
              toolCallId: 'tool-call',
            },
            lifecycle: 'foreground',
          },
          subagentRuntime: {
            schemaVersion: 1,
            definitionVersion: 1,
            agentId: 'implementation',
            agentName: 'Implementation',
            profile: 'implementation',
            systemPrompt: 'Implement the assigned task.',
            toolNames: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'],
            categoryPolicy: {
              read: 'allow',
              file_write: 'allow',
              shell_safe: 'allow',
              shell_unsafe: 'allow',
            },
            permissionCeiling: 'execute',
          },
          subagentSpawn: {
            schemaVersion: 1,
            requestFingerprint: 'c'.repeat(64),
            initialTurnId: 'child-turn',
            initialRunId: 'child-run',
          },
          subagentWorkspace: workspace,
        }),
      );
      childId = child.id;

      assert.deepEqual(child.subagentWorkspace, workspace);
      assert.deepEqual(
        (await store.list()).find((session) => session.id === child.id)?.subagentWorkspace,
        workspace,
      );
      await assert.rejects(
        () =>
          store.updateHeader(child.id, {
            subagentWorkspace: { ...workspace, branch: 'maka/subagent/rebound' },
          }),
        /workspace binding is immutable/,
      );
    } finally {
      await store.close?.();
    }

    const reopened = createSessionStore(root);
    try {
      assert.deepEqual((await reopened.readHeaderSnapshot(childId)).subagentWorkspace, workspace);
    } finally {
      await reopened.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('imports an existing JSONL catalog once and preserves later SQLite-only updates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-default-session-migration-'));
    const legacy = createLegacyFileSessionStore(root);
    const created = await legacy.create(makeInput({ name: 'Legacy title', labels: ['legacy'] }));
    await legacy.updateHeader(created.id, {
      status: 'blocked',
      blockedReason: 'permission_required',
      hasUnread: true,
    });
    await legacy.appendMessage(created.id, {
      type: 'user',
      id: 'user-1',
      turnId: 'turn-1',
      ts: 10,
      text: 'legacy message',
    });

    const first = createSessionStore(root);
    try {
      assert.equal((await first.readHeader(created.id)).name, 'Legacy title');
      await first.rename(created.id, 'SQLite title');
      await first.appendMessage(created.id, {
        type: 'assistant',
        id: 'assistant-1',
        turnId: 'turn-1',
        ts: 11,
        text: 'new message',
        modelId: 'fake-model',
      });
    } finally {
      await first.close?.();
    }

    const reopened = createSessionStore(root);
    try {
      assert.equal((await reopened.readHeader(created.id)).name, 'SQLite title');
      assert.equal((await reopened.readMessages(created.id)).length, 2);
      assert.deepEqual(
        (await reopened.list({ labelSlug: 'legacy' })).map((item) => item.id),
        [created.id],
      );
    } finally {
      await reopened.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('uses tombstones to prevent a deleted legacy transcript from resurrecting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-default-session-delete-'));
    const store = createSessionStore(root);
    let header!: SessionHeader;
    try {
      header = await store.create(makeInput({ name: 'Delete me' }));
      await store.remove(header.id);
      assert.deepEqual(await store.listPendingSessionRetirementCleanupIds(), [header.id]);
    } finally {
      await store.close?.();
    }

    const sessionDir = join(root, 'sessions', header.id);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'session.jsonl'), `${JSON.stringify(header)}\n`, 'utf8');

    const reopened = createSessionStore(root);
    try {
      assert.deepEqual(await reopened.list(), []);
      await assert.rejects(() => reopened.readHeader(header.id), /not found/);
      assert.deepEqual(await reopened.listPendingSessionRetirementCleanupIds(), [header.id]);
      await reopened.purgeRemovedSessionTranscript(header.id);
      await reopened.completeSessionRetirementCleanup(header.id);
      await waitForMissingPath(sessionDir);
    } finally {
      await reopened.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('commits family removal before aggregate retirement cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-family-cleanup-'));
    const store = createSessionStore(root);
    try {
      const familyRoot = await store.create(makeInput({ name: 'Family root' }));
      const familyRevision = await store.create(
        makeInput({
          name: 'Family revision',
          revisionRootSessionId: familyRoot.id,
          revisionParentSessionId: familyRoot.id,
          revisionOfTurnId: 'turn-1',
          revisionIndex: 2,
          revisionState: 'committed',
        }),
      );
      const familyIds = [familyRoot.id, familyRevision.id];
      const identities = await Promise.all(
        familyIds.map(async (sessionId) => {
          const snapshot = await store.readHeaderRecordSnapshot(sessionId);
          return { sessionId, expectedVersion: snapshot.revision };
        }),
      );

      assert.deepEqual(
        new Set(await store.removeSessionsVersioned(identities)),
        new Set(familyIds),
      );
      assert.deepEqual(
        new Set(await store.listPendingSessionRetirementCleanupIds(familyRevision.id)),
        new Set(familyIds),
      );
      for (const sessionId of familyIds) {
        assert.deepEqual(await store.probeSessionRemoval(sessionId), { kind: 'removed' });
        await store.purgeRemovedSessionTranscript(sessionId);
        await store.completeSessionRetirementCleanup(sessionId);
        await assert.rejects(stat(join(root, 'sessions', sessionId)), { code: 'ENOENT' });
      }
      assert.deepEqual(await store.listPendingSessionRetirementCleanupIds(), []);
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('keeps aggregate retirement cleanup pending across storage restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-startup-cleanup-'));
    const seed = createSessionStore(root);
    let sessionId = '';
    try {
      const session = await seed.create(makeInput({ name: 'Startup cleanup' }));
      sessionId = session.id;
      const snapshot = await seed.readHeaderRecordSnapshot(sessionId);
      await seed.removeSessionsVersioned([{ sessionId, expectedVersion: snapshot.revision }]);
    } finally {
      await seed.close?.();
    }

    const reopened = createSessionStore(root);
    try {
      assert.deepEqual(await reopened.list(), []);
      assert.deepEqual(await reopened.listPendingSessionRetirementCleanupIds(), [sessionId]);
      await reopened.purgeRemovedSessionTranscript(sessionId);
      await reopened.completeSessionRetirementCleanup(sessionId);
      await assert.rejects(stat(join(root, 'sessions', sessionId)), { code: 'ENOENT' });
      assert.deepEqual(await reopened.listPendingSessionRetirementCleanupIds(), []);
    } finally {
      await reopened.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('skips a malformed header during startup migration while importing valid sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-default-session-invalid-'));
    const legacy = createLegacyFileSessionStore(root);
    const valid = await legacy.create(makeInput({ name: 'Valid' }));
    const invalid = await legacy.create(makeInput({ name: 'Invalid' }));
    const invalidPath = join(root, 'sessions', invalid.id, 'session.jsonl');
    const lines = (await readFile(invalidPath, 'utf8')).split('\n');
    lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), labels: 'invalid' });
    await writeFile(invalidPath, lines.join('\n'), 'utf8');

    const store = createSessionStore(root);
    try {
      // Startup import must not fail closed: valid sessions stay available.
      assert.deepEqual(
        (await store.list()).map((item) => item.id),
        [valid.id],
      );
      assert.equal((await store.readHeader(valid.id)).name, 'Valid');
      await assert.rejects(() => store.readHeader(invalid.id), /not found/);
    } finally {
      await store.close?.();
    }

    const metadata = createSqliteSessionMetadataStore(
      join(root, SQLITE_SESSION_METADATA_DATABASE_NAME),
    );
    try {
      assert.equal((await metadata.read(valid.id)).header.name, 'Valid');
      assert.equal(await metadata.has(invalid.id), false);
      // Malformed legacy headers are skipped, not tombstoned, so a repaired
      // header can be imported on the next startup.
      assert.equal(await metadata.isTombstoned(invalid.id), false);
    } finally {
      metadata.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('recovers an exact empty transcript marker left before SQLite admission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-default-session-orphan-marker-'));
    const sessionId = 'orphan-session';
    const sessionDir = join(root, 'sessions', sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, 'session.jsonl'),
      `${JSON.stringify({
        type: 'session_transcript',
        sessionId,
        schemaVersion: 1,
      })}\n`,
      'utf8',
    );

    const store = createSessionStore(root);
    try {
      assert.deepEqual(await store.list(), []);
      await assert.rejects(
        stat(sessionDir),
        (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
      );
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('fails closed when an orphan transcript marker contains any additional state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-default-session-nonempty-orphan-marker-'));
    const sessionId = 'nonempty-orphan-session';
    const sessionDir = join(root, 'sessions', sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, 'session.jsonl'),
      `${JSON.stringify({
        type: 'session_transcript',
        sessionId,
        schemaVersion: 1,
      })}\n${JSON.stringify({ type: 'user', id: 'message-1', text: 'must survive' })}\n`,
      'utf8',
    );

    const store = createSessionStore(root);
    try {
      await assert.rejects(() => store.list(), /has no SQLite metadata/);
      assert.equal((await stat(join(sessionDir, 'session.jsonl'))).isFile(), true);
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function assertCatalogQueryPlan(
  database: DatabaseSync,
  filter: SessionListFilter,
  cursor: SqliteSessionCatalogCursor | undefined,
  expectedIndex: string,
  expectedAccess?: string,
): void {
  const query = buildSqliteSessionCatalogPageQuery(filter, cursor);
  const rows = database
    .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
    .all(...query.parameters, 33) as unknown as Array<{ detail: string }>;
  const details = rows.map((row) => row.detail);
  assert.equal(
    details.some((detail) => detail.includes('USE TEMP B-TREE')),
    false,
    details.join('\n'),
  );
  assert.equal(
    details.some((detail) => detail.includes(expectedIndex)),
    true,
    details.join('\n'),
  );
  if (expectedAccess) {
    assert.equal(
      details.some((detail) => detail.includes(expectedAccess) && detail.includes('activity_at')),
      true,
      details.join('\n'),
    );
  }
}

async function waitForMissingPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for removal: ${path}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

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

function makeSubagentWorkspace(): SubagentWorkspaceBinding {
  return {
    schemaVersion: SUBAGENT_WORKSPACE_BINDING_SCHEMA_VERSION,
    kind: 'git_worktree',
    leaseId: `subagent_worktree_${'c'.repeat(32)}`,
    gitCommonDir: '/workspace/repository/.git',
    worktreePath: `/workspace/state/subagent-worktrees/${'c'.repeat(32)}`,
    branch: `maka/subagent/${'c'.repeat(32)}`,
    baseCommit: 'd'.repeat(40),
  };
}
